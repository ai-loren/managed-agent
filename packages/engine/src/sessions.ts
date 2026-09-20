/**
 * Session service.
 *
 * A session is the unit of agent execution, and this service owns its lifecycle.
 * The invariants it exists to protect:
 *
 *  - **Version resolution happens once**, at creation. A running session is
 *    immune to edits of its agent.
 *  - **Every transition is guarded** by compare-and-set against the expected
 *    status, so a reaper and a worker acting on the same session cannot both
 *    "win" and leave the row describing a state it was never in.
 *  - **State changes and their events are written together.** A status change
 *    with no event would be invisible to replay; an event with no status change
 *    would make the fold disagree with the row.
 */

import {
  conflict,
  invalidTransition,
  MaError,
  newId,
  notFound,
  quotaExceeded,
  validationError,
  type Clock,
} from '@ma/core';
import {
  parseOrThrow,
  sessionMachine,
  submitEventsSchema,
  type Session,
  type SessionEvent,
  type SessionOrigin,
  type SessionStatus,
  type UniversalEvent,
} from '@ma/contracts';
import type { Page, PageRequest, Store } from '@ma/store';
import { TURNLESS_BILLED_TURN } from '@ma/store';

import { BaseService, type ServiceDeps } from './agents.ts';
import type { AuthContext } from './authz.ts';
import type { EventBus } from './event-bus.ts';
import { utcDayStart } from './quota.ts';

export interface SessionServiceDeps extends ServiceDeps {
  bus: EventBus;
  /** Provisions sandboxes. Injected so the engine does not depend on a driver. */
  provisioner?: SessionProvisioner;
}

/**
 * What the engine needs from the sandbox layer. Kept this narrow so the engine
 * can be tested without a broker, and so a broker change cannot ripple in here.
 */
export interface SessionProvisioner {
  /** Begin provisioning; resolves when the sandbox is bound or fails. */
  provision(session: Session): Promise<{ sandboxId: string; reused: boolean; provisionMs: number }>;
  /** Release the sandbox held by a session. */
  release(session: Session, reason: string): Promise<void>;
  /** Deliver ingress events to the running agent. */
  submit(session: Session, events: readonly UniversalEvent[]): Promise<void>;
  /**
   * Re-point a session's existing sandbox at its (re-pinned) version, in place.
   *
   * Used by a hot upgrade: the session's `resolvedVersion` already changed, and
   * the sandbox's agent-core re-bootstraps into the new version. The outcome is
   * three-valued, because "could not rebind" has two very different meanings:
   *   - `'ok'`      — the process re-bootstrapped into the new version.
   *   - `'changed'` — the environment cannot be reused (its sandbox spec/pool key
   *                   changed), so the caller must release and cold-provision.
   *   - `'busy'`    — the process is mid-turn right now (a 409 from `/rebind`).
   *                   The caller must back off and leave the sandbox alone; the
   *                   level-triggered upgrade sweep retries once the turn ends.
   * Collapsing `'busy'` into `'changed'` would `release` a sandbox out from under
   * a live turn — the control-plane row lags agent-core's synchronous
   * `running=true`, so a submit can be in flight while the row still reads idle.
   */
  rebind(session: Session): Promise<RebindOutcome>;
}

export type RebindOutcome = 'ok' | 'changed' | 'busy';

export interface CreateSessionInput {
  agentId: string;
  title?: string;
  /** Pins a specific version; otherwise production, else latest. */
  agentVersion?: number;
  credentialIds?: string[];
  origin?: SessionOrigin;
  /**
   * The connector that created this session (for `connector`/`schedule` origins).
   * Persisted so connector-scoped reuse, reply correlation and running-run checks
   * can be scoped to this connector's own sessions.
   */
  connectorId?: string;
  /** Logical session lease. Distinct from the sandbox lease. */
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}

const DEFAULT_SESSION_TTL_SECONDS = 86_400;

export class SessionService extends BaseService {
  readonly #bus: EventBus;
  readonly #provisioner: SessionProvisioner | undefined;

  constructor(deps: SessionServiceDeps) {
    super(deps);
    this.#bus = deps.bus;
    this.#provisioner = deps.provisioner;
  }

  /**
   * Create a session and admit it.
   *
   * Admission is checked before anything is written, and a refusal surfaces as
   * a quota error the caller can act on rather than a failure after a sandbox
   * has already been requested.
   */
  async create(context: AuthContext, input: CreateSessionInput): Promise<Session> {
    const agent = await this.store.agents.get(input.agentId);
    if (!agent) throw notFound('Agent', input.agentId);
    if (agent.status === 'archived') {
      throw conflict('Cannot start a session on an archived agent', { agentId: agent.id });
    }

    const workspace = await this.requireWorkspace(agent.workspaceId);
    this.authorizer.require(context, workspace, 'session.create', { resourceId: agent.id });
    await this.quota.requireSessionAdmission(workspace);

    // Resolve now and freeze. Everything after this point uses the pinned
    // version, whatever happens to the agent.
    const wanted = input.agentVersion ?? agent.productionVersion ?? agent.latestVersion;
    if (wanted < 1) throw validationError('This agent has no versions yet', { agentId: agent.id });
    const version = await this.store.agentVersions.get(agent.id, wanted);
    if (!version) throw notFound('AgentVersion', `${agent.id}@${wanted}`);

    // Authorize every *caller-supplied* credential before it is attached.
    //
    // A session's `credentialIds` are exchangeable for plaintext by the running
    // agent (`CredentialService.exchange`), so attaching a credential to a
    // session is exactly as powerful as reading it — and `exchange` trusts this
    // list. `session.create` is an operator action but `credential.read` is a
    // developer one, so without this check an operator could name any workspace
    // credential id here, drive one turn, and exfiltrate a secret it was never
    // permitted to see. We require `credential.read` per id and confirm each
    // belongs to this workspace.
    //
    // The version's own `credentialIds` are deliberately *not* re-checked: they
    // were pinned by a developer at `agent.version.create` (who holds
    // `credential.read`), and an operator must still be able to run such an
    // agent without holding read itself. Only the ad-hoc, request-time additions
    // are the operator's to justify.
    const versionCredentialIds = new Set(version.credentialIds);
    for (const credentialId of input.credentialIds ?? []) {
      if (versionCredentialIds.has(credentialId)) continue;
      const credential = await this.store.credentials.get(credentialId);
      if (!credential || credential.workspaceId !== workspace.id) {
        throw notFound('Credential', credentialId);
      }
      this.authorizer.require(context, workspace, 'credential.read', {
        resourceId: credentialId,
      });
    }

    const now = this.clock.now();
    const ttl = (input.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS) * 1000;

    const session: Session = {
      id: newId('session', now),
      workspaceId: workspace.id,
      agentId: agent.id,
      resolvedVersion: version.version,
      title: input.title ?? '',
      status: 'queued',
      origin: input.origin ?? 'api',
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      // The version's credentials, plus any granted just for this session.
      credentialIds: [...new Set([...version.credentialIds, ...(input.credentialIds ?? [])])],
      lastSeq: 0,
      turnCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 0,
      },
      expiresAt: now + ttl,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      createdBy: context.principal.id,
    };

    // The admission check above produces the good error message, naming the
    // dimension and a retry hint. This is the enforcement: it re-counts and
    // inserts atomically, so concurrent callers cannot all pass a check none of
    // them has yet invalidated. Without it a cap of 3 admitted 10 parallel
    // creates — the check was real, the window between it and the insert was
    // the problem.
    const created = await this.store.sessions.createWithinLimit(
      session,
      workspace.quota.maxConcurrentSessions,
    );
    if (!created) {
      throw quotaExceeded(
        'concurrentSessions',
        workspace.quota.maxConcurrentSessions,
        workspace.quota.maxConcurrentSessions,
        30,
      );
    }
    await this.#bus.publish([
      {
        sessionId: created.id,
        workspaceId: workspace.id,
        type: 'session.created',
        payload: {
          agentId: agent.id,
          resolvedVersion: version.version,
          origin: created.origin,
        },
      },
    ]);

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'session.create',
      resourceKind: 'session',
      resourceId: created.id,
      outcome: 'allowed',
      details: { agentId: agent.id, resolvedVersion: version.version },
    });

    return created;
  }

  async get(context: AuthContext, sessionId: string): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.read', { resourceId: sessionId });
    return session;
  }

  async list(
    context: AuthContext,
    filter: { workspaceId?: string; agentId?: string; statuses?: SessionStatus[] } & PageRequest,
  ): Promise<Page<Session>> {
    let workspaceId = filter.workspaceId;
    if (!workspaceId && filter.agentId) {
      const agent = await this.store.agents.get(filter.agentId);
      if (!agent) throw notFound('Agent', filter.agentId);
      workspaceId = agent.workspaceId;
    }
    if (!workspaceId) throw validationError('Either workspaceId or agentId is required');

    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'session.read');
    return this.store.sessions.list({ ...filter, workspaceId });
  }

  /**
   * Move a session to a new status, writing the row and its event together.
   *
   * The transition is validated against the state machine, then applied by
   * compare-and-set. Losing the race is reported as a conflict rather than
   * silently retried: the caller's assumption about the session was wrong, and
   * it needs to re-read before deciding what to do.
   */
  async transition(
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
    options: {
      patch?: Partial<Session>;
      event?: { type: Parameters<EventBus['publishOne']>[0]['type']; payload: unknown };
      /**
       * Several events written atomically with the transition. Use when one
       * status change carries more than one event — e.g. a lost sandbox that
       * both records `sandbox.lost` and fails the session. All are appended in a
       * single publish so they share the transition's fate: they land only if
       * the compare-and-set wins, never orphaned ahead of it.
       */
      events?: { type: Parameters<EventBus['publishOne']>[0]['type']; payload: unknown }[];
    } = {},
  ): Promise<Session> {
    sessionMachine.assert(from, to);

    const now = this.clock.now();
    const toPublish = [...(options.event ? [options.event] : []), ...(options.events ?? [])];

    // Commit the status CAS and its transition event(s) in ONE transaction, then
    // fan out after it commits. Previously the CAS ran in its own transaction and
    // `bus.publish` in a separate one, so a store error on the append after the
    // CAS had committed left the row in its new status with no transition event
    // in the log — the fold that reproduces the row would silently disagree with
    // it. Preparing the events (validation, id/ts shaping) happens before the
    // transaction; the append and CAS share its fate; the fan-out to subscribers
    // is a post-commit side effect.
    const prepared =
      toPublish.length > 0
        ? this.#bus.prepare(
            toPublish.map((event) => ({
              sessionId,
              // workspaceId is filled inside the transaction once the row is read;
              // placeholder here is replaced below.
              workspaceId: '',
              type: event.type,
              payload: event.payload,
            })),
          )
        : [];

    const result = await this.store.transaction((tx) => {
      const updated = tx.sessions.compareAndSetStatusSync(sessionId, from, to, {
        ...options.patch,
        updatedAt: now,
      });
      if (!updated) return { updated: undefined, stored: [] };
      const stored =
        prepared.length > 0
          ? tx.events.appendSync(
              sessionId,
              prepared.map((event) => ({ ...event, workspaceId: updated.workspaceId })),
            )
          : [];
      return { updated, stored };
    });

    if (!result.updated) {
      const current = await this.store.sessions.get(sessionId);
      if (!current) throw notFound('Session', sessionId);
      throw conflict('Session status changed concurrently', {
        sessionId,
        expected: from,
        actual: current.status,
      });
    }

    // Post-commit: the events are durably written, so deliver them to live
    // subscribers. A fan-out failure cannot un-commit them (they are in the log).
    if (result.stored.length > 0) this.#bus.fanout(result.stored);

    return result.updated;
  }

  /**
   * Provision a sandbox and bring the session to `ready`.
   *
   * A provisioning failure is recorded as structured data on the session, not
   * only in logs: "why did this session never start" must be answerable from
   * the API.
   */
  async start(sessionId: string): Promise<Session> {
    if (!this.#provisioner) {
      throw validationError('This engine has no provisioner configured');
    }

    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);

    const provisioning = await this.transition(sessionId, session.status, 'provisioning', {
      event: {
        type: 'sandbox.provisioning',
        payload: { provider: 'pending', poolKey: '' },
      },
    });

    return this.#provisionInto(provisioning);
  }

  /**
   * Acquire a sandbox for a session sitting in `provisioning` and bring it to
   * `ready`. Extracted from `start` so the provisioning body has one home; the
   * `provisioning → ready` compare-and-set is what makes a lost race release the
   * orphaned sandbox rather than leak it.
   */
  async #provisionInto(provisioning: Session): Promise<Session> {
    const sessionId = provisioning.id;
    let provisioned: { sandboxId: string; reused: boolean; provisionMs: number } | undefined;
    try {
      provisioned = await this.#provisioner!.provision(provisioning);
      return await this.transition(sessionId, 'provisioning', 'ready', {
        patch: { sandboxId: provisioned.sandboxId, startedAt: this.clock.now() },
        event: {
          type: 'session.ready',
          payload: {
            sandboxId: provisioned.sandboxId,
            provisionMs: provisioned.provisionMs,
            reused: provisioned.reused,
          },
        },
      });
    } catch (error) {
      // Provisioning can succeed and the transition still fail, when a
      // concurrent terminate or the reaper moved the session out of
      // `provisioning` while the driver was working. The sandbox exists, no row
      // references it, and nothing can ever find it by session id — so release
      // it here, before the error propagates.
      if (provisioned) {
        try {
          await this.#provisioner!.release(
            { ...provisioning, sandboxId: provisioned.sandboxId },
            'session left provisioning while its sandbox was starting',
          );
        } catch (releaseError) {
          this.logger?.error('failed to release an orphaned sandbox', {
            sessionId,
            sandboxId: provisioned.sandboxId,
            error: releaseError,
          });
        }
      }

      const info = {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'PROVISION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: {},
        occurredAt: this.clock.now(),
        retryable: error instanceof Error && 'retryable' in error ? Boolean(error.retryable) : false,
      };
      try {
        await this.transition(sessionId, 'provisioning', 'failed', {
          patch: { error: info, endedAt: this.clock.now() },
          event: { type: 'session.failed', payload: { error: info } },
        });
      } catch (transitionError) {
        // Also throws when the session already moved — the same race. The
        // original failure is the one worth reporting, so this is logged and
        // swallowed rather than masking it.
        this.logger?.warn('could not mark a session failed after provisioning', {
          sessionId,
          error: transitionError,
        });
      }
      throw error;
    }
  }

  /**
   * Submit ingress events to a running session.
   *
   * The session must hold a sandbox. Submitting to a queued or terminated
   * session is a precondition failure, not something to paper over by silently
   * starting one — the caller asked to talk to a session that is not listening.
   */
  async submit(
    context: AuthContext,
    sessionId: string,
    input: { events: unknown; idempotencyKey?: string },
  ): Promise<{ accepted: number; session: Session }> {
    const session = await this.get(context, sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.send', { resourceId: sessionId });

    const parsed = parseOrThrow(submitEventsSchema, {
      events: input.events,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });

    if (!['ready', 'running', 'idle'].includes(session.status)) {
      throw invalidTransition('Session', session.status, 'running');
    }
    if (!this.#provisioner) throw validationError('This engine has no provisioner configured');

    await this.#provisioner.submit(session, parsed.events);
    const updated = await this.store.sessions.update(sessionId, {
      lastActivityAt: this.clock.now(),
      updatedAt: this.clock.now(),
    });

    return { accepted: parsed.events.length, session: updated };
  }

  async interrupt(context: AuthContext, sessionId: string, reason: string): Promise<Session> {
    const session = await this.get(context, sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.interrupt', { resourceId: sessionId });

    // A finished session cannot be interrupted. Like terminate() and renew(),
    // this returns rather than throwing so a late click is harmless — but it
    // must publish nothing: a `session.interrupted` event with no backing
    // transition would replay after `session.terminated` and make the fold
    // disagree with the row (the invariant in this file's header).
    if (sessionMachine.isTerminal(session.status)) return session;

    if (this.#provisioner && session.status === 'running') {
      await this.#provisioner.submit(session, [{ type: 'user.interrupt', reason }]);
    }

    await this.#bus.publish([
      {
        sessionId,
        workspaceId: session.workspaceId,
        type: 'session.interrupted',
        payload: { reason, by: context.principal.id },
      },
    ]);
    return session;
  }

  /**
   * Terminate a session and release its sandbox.
   *
   * Release is attempted even when the drain fails: a session stuck in
   * `terminating` while holding a sandbox is a resource leak, and the reaper
   * should not have to clean up after an ordinary stop.
   */
  async terminate(context: AuthContext, sessionId: string, reason: string): Promise<Session> {
    const session = await this.get(context, sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.terminate', { resourceId: sessionId });

    if (sessionMachine.isTerminal(session.status)) return session;

    const terminated = await this.shutdown(session, reason, {
      type: 'session.terminated',
      payload: { reason, usage: session.usage },
    });

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'session.terminate',
      resourceKind: 'session',
      resourceId: sessionId,
      outcome: 'allowed',
      reason,
    });
    return terminated;
  }

  /**
   * Drive a session to `terminated`, releasing its sandbox on the way.
   *
   * The sandbox release is the reason this exists as its own method. Callers
   * that drove the two transitions directly — the TTL sweep did — left the
   * environment running with no session referencing it, which is the exact leak
   * they were written to prevent. Anything ending a session must come through
   * here so that cannot be forgotten again.
   *
   * Takes an already-read session rather than an id, because every caller has
   * one and re-reading invites acting on a status that has since moved.
   */
  async shutdown(
    session: Session,
    reason: string,
    event: { type: Parameters<EventBus['publishOne']>[0]['type']; payload: unknown },
  ): Promise<Session> {
    // A session already `terminating` is resumed rather than re-transitioned:
    // `terminating → terminating` is not a legal move, and this is exactly the
    // case the expiry reaper now picks up — a shutdown that died halfway and
    // left the session stuck. Re-entering it must finish the job, not throw.
    const draining =
      session.status === 'terminating'
        ? session
        : await this.transition(session.id, session.status, 'terminating');

    try {
      if (this.#provisioner && draining.sandboxId) {
        await this.#provisioner.release(draining, reason);
      }
    } catch (error) {
      // A sandbox we could not release is a leak, but refusing to terminate the
      // session would leave the caller unable to make progress and the sandbox
      // running anyway. The lease reaper is the backstop.
      this.logger?.error('sandbox release failed during shutdown', {
        sessionId: session.id,
        error,
      });
    }

    // Snapshot the final usage from the FRESH row, at the moment of the terminal
    // transition, into a `session.terminated` event. The caller built the event
    // (and its `usage`) before the `terminating` dwell above, during which a
    // straggler `turn.completed` can still fold usage: `recordUsage` only skips a
    // session that is already *terminal*, and `terminating` is not terminal, so a
    // late fold lands on the row while the event still carries the pre-dwell
    // usage. Refreshing here keeps the terminal event's usage equal to the row it
    // summarizes, so the event fold reproduces the row. Only `session.terminated`
    // carries usage; other terminal events pass through untouched.
    let terminalEvent = event;
    if (event.type === 'session.terminated') {
      const fresh = await this.store.sessions.get(session.id);
      if (fresh) {
        terminalEvent = {
          ...event,
          payload: { ...(event.payload as Record<string, unknown>), usage: fresh.usage },
        };
      }
    }

    const terminated = await this.transition(session.id, 'terminating', 'terminated', {
      patch: { endedAt: this.clock.now() },
      event: terminalEvent,
    });

    // Reclaim the session's billing-dedup markers, now that it is terminal. This
    // is hygiene, not correctness: markers are keyed by sandbox generation and both
    // billing paths early-return on a terminal session, so a lingering marker is
    // inert (it can never match a live generation's report). Clearing here keeps
    // the common terminate path tidy; the terminal paths that bypass `shutdown`
    // (e.g. the unrecoverable `handleSandboxLost` branch) leave inert markers that
    // the retention sweep (`billedTurns.prune`) reclaims, with the session-row
    // CASCADE as the final backstop. Runs AFTER the terminal transition so a failed
    // transition never strips markers from a still-live session.
    this.store.billedTurns.clearSession(session.id);
    return terminated;
  }

  /**
   * Recover a session whose sandbox vanished.
   *
   * A lost sandbox is not the session's fault, so a session that has not yet
   * exhausted its logical lease returns to `queued` and continues from its last
   * context snapshot rather than failing the user's work. A session lost
   * *mid-turn* (`running`) recovers the same way — the availability the old
   * design sacrificed — but because context snapshots persist only at turn
   * boundaries, the in-flight turn's work is gone: the recovery closes it with a
   * synthetic `turn.failed` (so the log honestly records the interrupted turn)
   * and does NOT re-submit the prompt (that would re-run any at-least-once tool
   * side effects the turn already performed). The caller resubmits.
   */
  async handleSandboxLost(sessionId: string, recoverable: boolean): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);
    if (sessionMachine.isTerminal(session.status)) return session;
    // A session that holds no sandbox has none to lose: it is already back in the
    // queue (a prior recovery cleared `sandboxId` and set `queued`) or otherwise
    // between sandboxes. Return it unchanged rather than falling through — without
    // this guard a `queued` origin skips the recovery branch (no `queued → queued`
    // edge) and lands in the unrecoverable branch, which would fail a healthy
    // recovering session. Makes the reaper's read-then-act idempotent: two passes
    // racing on one lost sandbox (or a re-queue that already happened) is a no-op
    // on the second, not a spurious failure.
    if (session.sandboxId === undefined) return session;

    const now = this.clock.now();
    const canRecover =
      recoverable && session.expiresAt !== undefined && session.expiresAt > now;

    const lost = {
      type: 'sandbox.lost' as const,
      payload: { sandboxId: session.sandboxId, recoverable: canRecover },
    };

    if (canRecover && sessionMachine.canTransition(session.status, 'queued')) {
      // Back to the *queue*, not straight to provisioning. The queue has the one
      // atomic claim in the whole start path — `findQueued` selects `queued`
      // rows and `start()` compare-and-sets `queued → provisioning`, so exactly
      // one worker ever provisions a session. Recovering directly to
      // `provisioning` had no such claim before the expensive provision() call:
      // two replicas could both pick up one recovering session and each acquire
      // a sandbox, and a slow-but-live start() was indistinguishable from an
      // abandoned one. Re-queuing reuses the proven path and sidesteps both.
      //
      // `sandbox.lost` is folded into the transition rather than published
      // ahead of it: a concurrent terminate can win the compare-and-set, and an
      // event published before a CAS that then loses the race is orphaned in the
      // log — an event asserting a recovery the row never underwent. Written
      // together with the transition, it lands only when the recovery commits.
      //
      // A mid-turn (`running`) loss also closes the interrupted turn with a
      // `turn.failed`, appended in the SAME transaction so it shares the CAS's
      // fate. The turn number is the control plane's completed-turn count + 1:
      // `turnCount` advances only when a turn *ends* (`noteTurnActivity`), so the
      // lost in-flight turn was never counted and is `turnCount + 1` — which, in
      // the common case, is exactly the number the dangling `turn.started`
      // already in the log carries, giving a coherent started(N) → failed(N)
      // pairing. The event carries no usage and is appended directly (not via the
      // sandbox-event ingest), so it never touches billing dedup. Only for the
      // `running` origin: a `ready`/`idle` session had no in-flight turn to close.
      //
      // Edge: on a *second* recovery within one snapshot window the harness
      // resumes at `snapshotTurn` and re-runs the turns since (re-ingesting their
      // `turn.completed`), so `turnCount` over-counts and this number can drift
      // above the dangling `turn.started` — an orphan pair in the audit view and a
      // connector reply-waiter that falls to its timeout instead of settling
      // early. Deliberately accepted: it touches neither billing (no usage, direct
      // append) nor row state (`turnCount` is stored, not folded from event
      // numbers) nor the turn budget; the root cause is turn-number reuse across
      // between-snapshot replay, which predates and is broader than this recovery.
      const events: { type: SessionEvent['type']; payload: unknown }[] = [lost];
      if (session.status === 'running') {
        events.push({
          type: 'turn.failed',
          payload: {
            turn: session.turnCount + 1,
            error: {
              code: 'SANDBOX_LOST',
              message:
                'The sandbox was lost mid-turn; the interrupted turn was closed and the session re-queued',
              details: {},
              occurredAt: now,
              retryable: true,
            },
          },
        });
      }
      const requeued = await this.transition(sessionId, session.status, 'queued', {
        patch: { sandboxId: undefined },
        events,
      });
      // No billing-marker clear here, and correctness does not need one: markers
      // are keyed by sandbox id, and the recovery re-queues onto a FRESH sandbox
      // (new id) whose turn counter resets — so the lost generation's markers can
      // never match the new generation's reports. They linger only as rows, bounded
      // by the retention sweep (`billedTurns.prune`). Clearing here would also lose
      // to a straggler `/completions` from the dying sandbox that re-marks after the
      // clear; generation-keying makes that straggler harmless instead.
      return requeued;
    }

    // Unrecoverable: the session fails, and the same atomicity applies — publish
    // `sandbox.lost` only if the failed-transition CAS wins. `session.failed`
    // follows it in the same append so both land together or neither does.
    const info = {
      code: 'SANDBOX_LOST',
      message: 'The sandbox was lost and the session could not be recovered',
      details: {},
      occurredAt: now,
      retryable: false,
    };
    return this.transition(sessionId, session.status, 'failed', {
      patch: { error: info, endedAt: now },
      events: [lost, { type: 'session.failed', payload: { error: info } }],
    });
  }

  /** Extend the logical lease. */
  async renew(context: AuthContext, sessionId: string, ttlSeconds: number): Promise<Session> {
    const session = await this.get(context, sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.send', { resourceId: sessionId });

    if (sessionMachine.isTerminal(session.status)) {
      throw conflict('Cannot renew a finished session', { sessionId, status: session.status });
    }

    const now = this.clock.now();
    return this.store.sessions.update(sessionId, {
      expiresAt: now + ttlSeconds * 1000,
      updatedAt: now,
    });
  }

  /**
   * Roll an idle session onto a newer agent version, without a restart.
   *
   * A hot upgrade: when a new production version is published, an idle session
   * re-pins to it and its sandbox re-bootstraps into the new config at the next
   * turn. Never mid-turn — a `running` session is left alone and picks the
   * upgrade up when it goes idle (the scheduler sweep retries it). Returns the
   * session unchanged when it is already on `toVersion`, terminal, or busy, so
   * the caller can apply upgrades idempotently.
   *
   * The re-pin happens first (so bootstrap resolves the new version), then the
   * provisioner rebinds the existing sandbox in place. If the new version's
   * sandbox spec differs — a different pool key — the environment cannot be
   * reused, so it is released and the session re-queued for a cold provision.
   */
  async upgrade(sessionId: string, toVersion: number): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);

    // Only an idle or ready session is safe to re-pin: it holds a sandbox but is
    // not mid-turn. A queued/provisioning session will pick the new version up
    // when it provisions; a running one when it next goes idle; a terminal one
    // never. None of these is an error — the sweep is level-triggered.
    if (!['ready', 'idle'].includes(session.status)) return session;
    if (session.resolvedVersion >= toVersion) return session;
    if (!this.#provisioner) return session;

    const target = await this.store.agentVersions.get(session.agentId, toVersion);
    if (!target) throw notFound('AgentVersion', `${session.agentId}@${toVersion}`);

    const fromVersion = session.resolvedVersion;
    // Re-pin first: the sandbox re-bootstraps from the row, so the row must name
    // the new version before the rebind fetches its config. The re-pin is a
    // compare-and-set that keeps the status but requires it *unchanged* from the
    // `ready`/`idle` we validated above. The guard at the top ran before the
    // `await agentVersions.get`, and a `turn.started` landing in that window
    // moves the session to `running` — an unconditional write would then re-pin
    // and rebind a session mid-turn, the exact invariant the guard exists to
    // hold. If the CAS finds the status changed (a turn started, or another
    // replica already re-pinned), 0 rows change and we return the session
    // untouched — the level-triggered sweep retries when it next goes idle.
    const repinned = await this.store.sessions.compareAndSetStatus(
      sessionId,
      session.status,
      session.status,
      { resolvedVersion: toVersion, updatedAt: this.clock.now() },
    );
    if (!repinned) return session;

    const rebound = await this.#provisioner.rebind(repinned);
    if (rebound === 'ok') {
      // Clear this session's billing-dedup markers on an in-place rebind. This is
      // the ONE re-queue-like boundary where the sandbox id does NOT change: the
      // pool key excludes `runtime` config, so a version that only swaps the
      // runtime rebinds the SAME sandbox in place — yet agent-core rebuilds its
      // harness and resets the turn counter to 0. Without this, a marker left by
      // the old generation's turn N (a proxy-billed turn that ended in
      // `turn.failed`, so its keyed marker was never consumed) would dedup — and
      // UNDER-bill — the new generation's turn N, since both share (session,
      // sandbox). Every OTHER generation boundary (recovery, spec-changing upgrade)
      // mints a fresh sandbox id, so its markers cannot alias and need no clear.
      // Safe to clear unconditionally here: the rebind only proceeds on an idle
      // session whose previous runtime is cooperatively and synchronously torn down
      // before `rebind` returns `ok`, and the new generation has not submitted a
      // turn yet — so there is no straggler that could re-create a marker.
      this.store.billedTurns.clearSession(sessionId);
      await this.#bus.publish([
        {
          sessionId,
          workspaceId: session.workspaceId,
          type: 'session.upgraded',
          payload: { fromVersion, toVersion, rebound: true },
        },
      ]);
      return repinned;
    }

    if (rebound === 'busy') {
      // The process is mid-turn (a `/rebind` 409): the control-plane row lagged
      // agent-core's synchronous `running=true`, so the CAS above saw an idle row
      // and re-pinned, but the sandbox is in fact busy. Do NOT release it — that
      // would tear the environment out from under the executing turn. Roll the
      // re-pin back to the version we came from and leave the session running;
      // the level-triggered upgrade sweep retries once the turn ends and the row
      // is genuinely idle.
      //
      // Roll back guarded on the *version*, not the status. A status-guarded CAS
      // (expecting the idle/ready we re-pinned from) matches nothing once the
      // `turn.started` that made the rebind `busy` has committed `idle → running`
      // — so the rollback would silently no-op, leaving `resolvedVersion` pinned
      // to a version the sandbox is not running. `findUpgradable` only selects
      // `resolved_version < production_version`, so that split-brain is permanent
      // and per-turn authorization would resolve the new version's grants against
      // the old runtime. The version CAS rolls back regardless of status, while
      // `expectedVersion: toVersion` still refuses to clobber a concurrent re-pin
      // to a newer version.
      await this.store.sessions.rollbackVersion(sessionId, toVersion, fromVersion, this.clock.now());
      return session;
    }

    // `changed`: the environment cannot be reused for the new version (its sandbox
    // spec changed, so the pool key no longer matches). Release it and re-queue
    // for a cold provision on the new version.
    await this.#provisioner.release(repinned, 'upgrade changed the sandbox spec');
    const requeued = await this.transition(sessionId, repinned.status, 'queued', {
      patch: { sandboxId: undefined },
      event: {
        type: 'session.upgraded',
        payload: { fromVersion, toVersion, rebound: false },
      },
    });
    return requeued;
  }

  /**
   * Fold a usage delta into the session row and the workspace daily counter, in
   * one transaction, re-checking terminal status under the write lock.
   *
   * The session-usage update and the daily counter move together, and the session
   * update is an atomic read-modify-write (`addUsage` re-reads at write time) — so
   * two concurrent recordings cannot lose each other's increment, and the counter
   * (what the budget reads) never drifts from the usage it counts. Cache tokens
   * are excluded from the counter (billed = input + output), matching the quota's
   * definition.
   *
   * Re-check terminal status INSIDE the transaction, synchronously, against the
   * same connection the fold writes on: a concurrent `terminate` could have driven
   * the session terminal since the caller's read, and folding a straggler turn's
   * usage in afterwards would push the counters past the `session.terminated`
   * snapshot and move the final bill after the session ended.
   *
   * `mark` runs in the SAME transaction as the fold (a caller passing one), so the
   * usage and its billing-dedup marker commit or roll back together — a
   * control-plane restart can never land between them and double-bill. Returns
   * whether it folded (false when the session was already terminal).
   */
  #foldUsageSync(
    tx: Store,
    session: Session,
    now: number,
    delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros?: number },
    mark?: (tx: Store) => void,
  ): boolean {
    const fresh = tx.sessions.findById(session.id);
    if (!fresh || sessionMachine.isTerminal(fresh.status)) return false;
    const input = delta.inputTokens ?? 0;
    const output = delta.outputTokens ?? 0;
    void tx.sessions.addUsage(
      session.id,
      {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: delta.cacheReadTokens ?? 0,
        cacheWriteTokens: delta.cacheWriteTokens ?? 0,
        costMicros: delta.costMicros ?? 0,
      },
      now,
    );
    const cost = delta.costMicros ?? 0;
    if (input > 0 || output > 0 || cost > 0) {
      void tx.usage.addTokens(session.workspaceId, utcDayStart(now), input, output, cost);
    }
    if (mark) mark(tx);
    return true;
  }

  /** Record token usage from a completed turn (no billing-dedup marker). */
  async recordUsage(
    sessionId: string,
    delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros?: number },
  ): Promise<void> {
    const session = await this.store.sessions.get(sessionId);
    // Cheap early-out: a session already terminal at read time is closed for
    // accounting, so skip without opening a transaction. The load-bearing check
    // is re-done inside the transaction below — this one only avoids the work.
    if (!session || sessionMachine.isTerminal(session.status)) return;
    const now = this.clock.now();
    await this.store.transaction((tx) => {
      this.#foldUsageSync(tx, session, now, delta);
    });
  }

  /**
   * Record usage billed through the `/completions` proxy, and durably mark the
   * turn billed so the matching `turn.completed` report is not billed again.
   *
   * The marker is written in the SAME transaction as the fold — this is the fix
   * for the double-bill across a control-plane restart: the usage is durable, so
   * the dedup marker must be too, and must commit atomically with it. The marker is
   * keyed by `sandboxId`, so it can only ever dedup a report from the SAME sandbox
   * generation — a re-queue onto a fresh sandbox (recovery, upgrade) resets the
   * turn counter but also changes the sandbox id, so the stale marker cannot match
   * and under-bill the new generation. A completion that carries a turn is keyed by
   * turn (the precise dedup); one that omits its turn sets the per-sandbox
   * turn-less flag (the sentinel), which the next turn end clears. Marking is
   * idempotent, so a multi-call tool loop marks once.
   */
  async recordProxyUsage(
    sessionId: string,
    sandboxId: string,
    turn: number | undefined,
    delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros?: number },
  ): Promise<void> {
    const session = await this.store.sessions.get(sessionId);
    if (!session || sessionMachine.isTerminal(session.status)) return;
    const now = this.clock.now();
    const markTurn = turn ?? TURNLESS_BILLED_TURN;
    await this.store.transaction((tx) => {
      this.#foldUsageSync(tx, session, now, delta, (t) => t.billedTurns.mark(sessionId, sandboxId, markTurn, now));
    });
  }

  /**
   * Record usage reported by the sandbox on a `turn.completed`, unless the turn
   * was already billed via `/completions` from the SAME sandbox generation.
   *
   * The dedup check and the fold are ONE transaction: `consume` atomically deletes
   * the marker and reports whether it existed, so two concurrent reports of the
   * same turn cannot both bill, and a fold that rolls back cannot lose a consumed
   * marker. The marker is keyed by `sandboxId`, so a stale marker from an earlier
   * generation of the same session cannot dedup this report. Mirrors the
   * /completions dedup: try the exact turn key first, then the per-sandbox
   * turn-less flag (a completion that omitted its turn left no key), so a foreign
   * runtime that omits the envelope turn is still deduped. When neither marker
   * matches, the report is the only accounting there is and is folded. Returns
   * whether it billed (false when deduped or the session was terminal).
   */
  async recordReportedUsage(
    sessionId: string,
    sandboxId: string,
    turn: number | undefined,
    delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros?: number },
  ): Promise<boolean> {
    const session = await this.store.sessions.get(sessionId);
    if (!session || sessionMachine.isTerminal(session.status)) return false;
    const now = this.clock.now();
    return this.store.transaction((tx) => {
      if (turn !== undefined && tx.billedTurns.consume(sessionId, sandboxId, turn)) return false;
      if (tx.billedTurns.consume(sessionId, sandboxId, TURNLESS_BILLED_TURN)) return false;
      return this.#foldUsageSync(tx, session, now, delta);
    });
  }

  /**
   * Clear the per-sandbox turn-less billing flag, at a turn's end that did not
   * match a turn key. A turn ending (completed or failed) that was not billed via
   * a keyed completion must not leave the turn-less flag set to suppress a later
   * billable turn. Scoped to the sandbox generation, matching how the flag is set.
   */
  async clearTurnlessBillingFlag(sessionId: string, sandboxId: string): Promise<void> {
    await this.store.transaction((tx) => {
      tx.billedTurns.consume(sessionId, sandboxId, TURNLESS_BILLED_TURN);
    });
  }

  /**
   * Drive the session's status from the turn lifecycle.
   *
   * A turn starting takes the session to `running`; a turn ending returns it to
   * `idle`. This is what makes the `ready` vs `idle` distinction real: `ready`
   * is a session that holds a sandbox but has never run, `idle` one that has
   * served at least one turn — the exact signal the reaper uses to decide
   * whether an unused sandbox was ever productive.
   *
   * It is deliberately forgiving. Turn events arrive from the sandbox, which
   * races the control plane: a `started` may arrive when the session is already
   * `running` (a re-notified turn), an `ended` when it is already `idle`, and
   * either can land just after a terminate. Rather than throw, it transitions
   * only when the machine allows and otherwise returns the session unchanged —
   * a stale turn must never resurrect a finished session or fail a caller whose
   * only job was to record an event.
   *
   * On `started`, it also advances `lastActivityAt`, since a turn beginning is
   * the freshest possible sign of life. On `ended`, it increments `turnCount` —
   * the control plane's own count of turns this session has served, distinct
   * from the harness's in-sandbox counter and the one the API and console show.
   */
  async noteTurnActivity(sessionId: string, phase: 'started' | 'ended'): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);

    const to: SessionStatus = phase === 'started' ? 'running' : 'idle';
    // Already there, terminal, or not in a state this phase can move from: leave
    // it be. `running → running` is a legal self-loop (a turn re-reporting its
    // start), but there is nothing to write, so it is skipped too.
    if (session.status === to || !sessionMachine.canTransition(session.status, to)) {
      return session;
    }

    // A turn is counted when it ends. Counting it at the transition — rather
    // than in a separate write — keeps `turnCount` consistent with the status:
    // it advances exactly when the session settles from `running` to `idle`, so
    // a lost CAS leaves neither moved.
    const patch: Partial<Session> =
      phase === 'started'
        ? { lastActivityAt: this.clock.now() }
        : { turnCount: session.turnCount + 1 };

    try {
      return await this.transition(sessionId, session.status, to, { patch });
    } catch (error) {
      // Lost the compare-and-set to a concurrent transition (a terminate, a
      // reaper). The turn is stale; report the session as it now stands rather
      // than surfacing a conflict the caller cannot act on.
      if (MaError.is(error) && error.code === 'CONFLICT') {
        return (await this.store.sessions.get(sessionId)) ?? session;
      }
      throw error;
    }
  }

  /** Read the event log. This is how a client resumes. */
  async readEvents(
    context: AuthContext,
    sessionId: string,
    options: {
      fromSeq?: number;
      toSeq?: number;
      limit?: number;
      types?: string[];
      turn?: number;
      order?: 'asc' | 'desc';
      q?: string;
      fromTs?: number;
      toTs?: number;
    },
  ): Promise<{ events: SessionEvent[]; earliestSeq: number; lastSeq: number }> {
    // Authorization happens here; the result is discarded because only the
    // check matters.
    await this.get(context, sessionId);

    const [events, earliestSeq, lastSeq] = await Promise.all([
      this.store.events.read(sessionId, options),
      this.store.events.earliestSeq(sessionId),
      this.store.events.lastSeq(sessionId),
    ]);
    return { events, earliestSeq, lastSeq };
  }
}
