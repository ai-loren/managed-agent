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
  findCredentialEnvKeyCollision,
  invalidTransition,
  isId,
  MaError,
  newId,
  notFound,
  quotaExceeded,
  randomToken,
  validationError,
  type Clock,
} from '@ma/core';
import {
  MAX_ATTACHMENTS,
  parseOrThrow,
  sessionMachine,
  submitEventsSchema,
  type Artifact,
  type Credential,
  type Session,
  type SessionEvent,
  type SessionOrigin,
  type SessionStatus,
  type UniversalEvent,
  type Workspace,
} from '@ma/contracts';
import type { Page, PageRequest, Store } from '@ma/store';
import { TURNLESS_BILLED_TURN } from '@ma/store';

import { BaseService, type ServiceDeps } from './agents.ts';
import { sessionFiles, type SessionFile } from './attachments.ts';
import type { AuthContext } from './authz.ts';
import type { EventBus } from './event-bus.ts';
import { utcDayStart } from './quota.ts';

/**
 * How long an upgrade or a model change holds a session's rebind slot. Far past
 * a rebind's own dial ceiling; it only matters when a holder dies mid-rebind,
 * and then it is how long that session's next upgrade or model change waits.
 */
const REBIND_CLAIM_MS = 5 * 60_000;

export interface SessionServiceDeps extends ServiceDeps {
  bus: EventBus;
  /** Provisions sandboxes. Injected so the engine does not depend on a driver. */
  provisioner?: SessionProvisioner;
}

/**
 * What the engine needs from the sandbox layer. Kept this narrow so the engine
 * can be tested without a broker, and so a broker change cannot ripple in here.
 */
/** What the log says about the turn a lost sandbox may have been running. */
interface InFlightTurn {
  inFlight: boolean;
  /** The last prompt the sandbox accepted. */
  prompt?: string;
  /** The artifacts that prompt attached. */
  attachments?: string[];
  /** The submission the last `turn.started` after that prompt names, if any. */
  startedBy?: string;
  /** The seq of the last turn's closing event. */
  lastEndedSeq?: number;
}

export interface SessionProvisioner {
  /** Begin provisioning; resolves when the sandbox is bound or fails. */
  provision(session: Session): Promise<{ sandboxId: string; reused: boolean; provisionMs: number }>;
  /** Release the sandbox held by a session. */
  release(session: Session, reason: string): Promise<void>;
  /**
   * Deliver ingress events to the running agent. `submissionId` must reach the
   * sandbox, which echoes it on the turn's `turn.started`. `attachments` are the
   * files the messages' `attachments` name, already attached to the session; a
   * message naming one that is not among them must be refused, not sent
   * without it.
   */
  submit(
    session: Session,
    events: readonly UniversalEvent[],
    options?: { submissionId?: string; attachments?: readonly SessionFile[] },
  ): Promise<void>;
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
    //
    // The FULL merged set (version pins + this session's additions) is loaded so
    // it can be checked as one: that is the set actually materialised into the
    // sandbox, and two of its credentials emitting the same normalised MA_CRED_*
    // key would silently overwrite each other at delivery regardless of which
    // source (or owner) each came from.
    const versionCredentialIds = new Set(version.credentialIds);
    const mergedCredentialIds = [
      ...new Set([...version.credentialIds, ...(input.credentialIds ?? [])]),
    ];
    const mergedCredentials: Credential[] = [];
    for (const credentialId of mergedCredentialIds) {
      const credential = await this.store.credentials.get(credentialId);
      if (!credential || credential.workspaceId !== workspace.id) {
        throw notFound('Credential', credentialId);
      }
      mergedCredentials.push(credential);
      if (versionCredentialIds.has(credentialId)) continue;
      this.authorizer.require(context, workspace, 'credential.read', {
        resourceId: credentialId,
      });
    }
    const collision = findCredentialEnvKeyCollision(mergedCredentials, this.clock.now());
    if (collision) {
      throw validationError(
        `Credentials '${collision.nameA}' and '${collision.nameB}' both deliver the same environment key ${collision.envKey} to the sandbox; rename one so they differ by more than case or punctuation`,
        { envKey: collision.envKey },
      );
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
    input: { events: unknown; idempotencyKey?: string; submissionId?: string },
  ): Promise<{ accepted: number; session: Session; submissionId: string }> {
    const session = await this.get(context, sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.send', { resourceId: sessionId });

    const parsed = parseOrThrow(submitEventsSchema, {
      events: input.events,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.submissionId !== undefined ? { submissionId: input.submissionId } : {}),
    });

    if (!['ready', 'running', 'idle'].includes(session.status)) {
      throw invalidTransition('Session', session.status, 'running');
    }
    if (!this.#provisioner) throw validationError('This engine has no provisioner configured');

    const attachments = await this.#attach(context, session, workspace, parsed.events);
    const submissionId = parsed.submissionId ?? newId('submission', this.clock.now());
    await this.#provisioner.submit(session, parsed.events, {
      submissionId,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // A submission accepted after an interruption replaces the automatic
    // resubmission: the submitter has moved on. Waiting to go out, or on its
    // way — then the sandbox refuses it for the turn this one started, and with
    // the record gone the refusal cannot put it back in the queue. Read again
    // after the submit, which a resubmission may have claimed meanwhile.
    const pendingNow = (await this.store.sessions.get(sessionId))?.pendingResubmit;
    if (pendingNow !== undefined) {
      await this.store.sessions.replacePendingResubmit(
        sessionId,
        { id: pendingNow.id, state: pendingNow.state },
        undefined,
        this.clock.now(),
      );
    }
    const updated = await this.store.sessions.update(sessionId, {
      lastActivityAt: this.clock.now(),
      updatedAt: this.clock.now(),
    });

    return { accepted: parsed.events.length, session: updated, submissionId };
  }

  /**
   * Attach the artifacts a submission's messages name to the session, and
   * return them as its sandbox will be given them.
   *
   * Attaching hands a file's content to the agent, and through its answers to
   * whoever reads the session, so it takes the power to download the file as
   * well as to send the message. Every attachment is checked before any is
   * recorded: one refused attachment refuses the whole submission.
   */
  async #attach(
    context: AuthContext,
    session: Session,
    workspace: Workspace,
    events: readonly UniversalEvent[],
  ): Promise<SessionFile[]> {
    const ids = [...new Set(events.flatMap((event) => (event.type === 'user.message' ? event.attachments : [])))];
    if (ids.length === 0) return [];
    if (ids.length > MAX_ATTACHMENTS) {
      throw validationError(
        `A submission may attach at most ${MAX_ATTACHMENTS} files; this one attaches ${ids.length}. Send the rest with a following message.`,
        { limit: MAX_ATTACHMENTS, attachments: ids.length },
      );
    }

    const upload = `POST /v1/sessions/${session.id}/files`;
    const artifacts: Artifact[] = [];
    for (const id of ids) {
      const artifact = isId(id, 'artifact') ? await this.store.artifacts.get(id) : undefined;
      if (!artifact || artifact.workspaceId !== session.workspaceId) {
        throw validationError(
          `Attachment ${JSON.stringify(id)} is not an artifact in this session's workspace. Upload the file with ${upload} and attach the id it returns.`,
          { attachment: id },
        );
      }
      if (artifact.status !== 'available') {
        throw validationError(
          `Attachment '${id}' (${artifact.path}) is ${artifact.status}: its content ${artifact.status === 'purged' ? 'has been deleted' : 'is past retention and may be deleted at any moment'}. Upload the file again with ${upload} and attach the new id.`,
          { attachment: id, status: artifact.status },
        );
      }
      try {
        this.authorizer.require(context, workspace, 'artifact.download', { resourceId: id });
      } catch (error) {
        if (!(error instanceof MaError) || error.code !== 'PERMISSION_DENIED') throw error;
        throw new MaError({
          code: 'PERMISSION_DENIED',
          category: 'permission',
          message: `Attaching '${id}' hands its content to the agent, which takes permission to download it (artifact.download); this caller, or its API key's scopes, lacks that. Attach only files you may download, or ask a workspace operator to send this one.`,
          details: { action: 'artifact.download', resource: id },
        });
      }
      artifacts.push(artifact);
    }

    const rows = await this.store.sessionAttachments.attach(
      session.id,
      artifacts.map((artifact) => ({ artifactId: artifact.id, path: artifact.path })),
      context.principal.id,
      this.clock.now(),
    );
    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'session.attach',
      resourceKind: 'session',
      resourceId: session.id,
      outcome: 'allowed',
      details: { artifactIds: ids },
    });
    const names = new Map(rows.map((row) => [row.artifactId, row.name]));
    return artifacts.map((artifact) => ({
      artifactId: artifact.id,
      name: names.get(artifact.id)!,
      digest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
    }));
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
      let pendingResubmit: Session['pendingResubmit'] | null = null;
      const turn = await this.#turnInFlight(session);
      if (turn.inFlight) {
        const resubmission = await this.#planResubmit(session, turn);
        pendingResubmit = resubmission.pending;
        events.push({
          type: 'turn.failed',
          payload: {
            turn: session.turnCount + 1,
            error: {
              code: 'SANDBOX_LOST',
              message: `The sandbox was lost mid-turn; the interrupted turn was closed and the session re-queued. ${resubmission.note}`,
              details: { resubmit: resubmission.pending?.state === 'queued' },
              occurredAt: now,
              retryable: true,
            },
          },
        });
      }
      const requeued = await this.transition(sessionId, session.status, 'queued', {
        patch: { sandboxId: undefined, ...(pendingResubmit !== null ? { pendingResubmit } : {}) },
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

  /**
   * Decide what happens to the prompt of a turn a lost sandbox cut off.
   *
   * `pending: null` leaves the row's record alone (the version did not opt in).
   * Otherwise the prompt is the session's last user message: no submission is
   * accepted while a turn runs, so it is the one the interrupted turn started
   * from. A prompt goes out again at most once — if the turn that was cut off
   * is the resubmission itself (its `turn.started` carries the id it was sent
   * under, or the runtime names no submission at all), it is not sent a third
   * time.
   */
  async #planResubmit(
    session: Session,
    turn: InFlightTurn,
  ): Promise<{ pending: Session['pendingResubmit'] | null; note: string }> {
    const version = await this.store.agentVersions.get(session.agentId, session.resolvedVersion);
    if (!version?.resubmitInterruptedTurn) {
      return { pending: null, note: 'Its prompt is not resubmitted; send it again if it is safe to run twice.' };
    }
    const previous = session.pendingResubmit;
    // A turn that ended after the resubmission went out means that resubmission
    // finished; whatever was cut off now is a later prompt. By seq, not time:
    // the interrupted turn's own closing event can share the resubmission's
    // millisecond, but never its place in the log.
    const resubmissionFinished =
      previous?.sentAfterSeq !== undefined && turn.lastEndedSeq !== undefined && turn.lastEndedSeq > previous.sentAfterSeq;
    if (
      previous?.state === 'sent' &&
      !resubmissionFinished &&
      (turn.startedBy === undefined || turn.startedBy === previous.submissionId)
    ) {
      return {
        pending: undefined,
        note: 'It was already a resubmission of an interrupted turn, so it is not resubmitted again; send it yourself if it is safe to run once more.',
      };
    }
    if (!turn.prompt) {
      return { pending: undefined, note: 'No prompt was found in the log to resubmit.' };
    }
    return {
      pending: {
        id: newId('submission', this.clock.now()),
        text: turn.prompt,
        state: 'queued',
        ...(turn.attachments ? { attachments: turn.attachments } : {}),
      },
      note: 'Its prompt will be submitted again once the session has a sandbox (resubmitInterruptedTurn).',
    };
  }

  /**
   * Whether a turn was running when the sandbox went, read from the log as
   * well as the row. A turn's `turn.started` comes from the sandbox and can die
   * with it unsent, leaving the row `ready`; but the control plane logs the
   * prompt once the sandbox has accepted it, so a user message with no turn
   * ending after it is a turn that was in flight.
   */
  async #turnInFlight(session: Session): Promise<InFlightTurn> {
    const tail = await this.store.events.read(session.id, {
      types: ['turn.started', 'turn.completed', 'turn.failed', 'message.completed'],
      order: 'desc',
      limit: 200,
    });
    const ended = tail.find((event) => event.type === 'turn.completed' || event.type === 'turn.failed');
    const userMessages = tail.filter(
      (event) => event.type === 'message.completed' && (event.payload as { role?: string }).role === 'user',
    );
    // A submission logs one message per event and agent-core runs them as one
    // prompt, so the turn in flight started from every one since the last end.
    const prompts = userMessages.filter((event) => ended === undefined || event.seq > ended.seq).reverse();
    const attachments = [
      ...new Set(
        prompts.flatMap((event) =>
          ((event.payload as { attachments?: { artifactId: string }[] }).attachments ?? []).map((file) => file.artifactId),
        ),
      ),
    ];
    const started = tail.find((event) => event.type === 'turn.started' && (prompts.length === 0 || event.seq > prompts[0]!.seq));
    // The bridge writes the row after the events, so a sandbox lost between the
    // two still reads `running` with the turn's end already logged.
    const endedAfterLastPrompt = ended !== undefined && (userMessages.length === 0 || ended.seq > userMessages[0]!.seq);
    return {
      inFlight: prompts.length > 0 || (session.status === 'running' && !endedAfterLastPrompt),
      ...(prompts.length > 0
        ? { prompt: prompts.map((event) => (event.payload as { text?: string }).text ?? '').join('\n') }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...((started?.payload as { submissionId?: string } | undefined)?.submissionId
        ? { startedBy: (started!.payload as { submissionId: string }).submissionId }
        : {}),
      ...(ended ? { lastEndedSeq: ended.seq } : {}),
    };
  }

  /**
   * Send the prompts `handleSandboxLost` queued for resubmission, for sessions
   * that have a sandbox again. Claimed by compare-and-set so one worker sends
   * each; a failed send goes back to the queue for the next pass. Returns how
   * many were sent.
   */
  async resubmitInterrupted(limit: number): Promise<number> {
    if (!this.#provisioner) return 0;
    let sent = 0;
    for (const session of await this.store.sessions.findPendingResubmit(limit)) {
      const pending = session.pendingResubmit;
      if (pending?.state !== 'queued' || pending.text === undefined) continue;
      const submissionId = newId('submission', this.clock.now());
      // Sent, the record no longer carries the prompt: it would otherwise sit on
      // the row, and in every API answer, long after the log's retention.
      const claimed = await this.store.sessions.replacePendingResubmit(
        session.id,
        { id: pending.id, state: 'queued' },
        { id: pending.id, state: 'sent', submissionId, sentAfterSeq: session.lastSeq },
        this.clock.now(),
      );
      if (!claimed) continue;
      try {
        // Attached when the prompt was first accepted, so already granted.
        const files = pending.attachments ? await sessionFiles(this.store, session.id, pending.attachments, this.logger) : [];
        await this.#provisioner.submit(
          session,
          [{ type: 'user.message', text: pending.text, attachments: files.map((file) => file.artifactId) }],
          { submissionId, ...(files.length > 0 ? { attachments: files } : {}) },
        );
        sent++;
      } catch (error) {
        // Refused because the user's own submission got in first, the prompt is
        // superseded, as it is when theirs comes while this one waits.
        const since = await this.store.events.read(session.id, { types: ['message.completed'], fromSeq: session.lastSeq + 1, limit: 50 });
        const movedOn = since.some((event) => (event.payload as { role?: string }).role === 'user');
        await this.store.sessions.replacePendingResubmit(
          session.id,
          { id: pending.id, state: 'sent' },
          movedOn ? undefined : pending,
          this.clock.now(),
        );
        if (movedOn) {
          this.logger?.info('dropped the resubmission of an interrupted turn: a newer submission got in first', { sessionId: session.id });
        } else {
          this.logger?.warn('could not resubmit an interrupted turn; will try again', { sessionId: session.id, error });
        }
      }
    }
    return sent;
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

    // One rebind of this session at a time (see `claimRebind`). A model change
    // holding the slot is rebinding the sandbox now; the sweep is level-triggered
    // and comes back to this session once the slot is free.
    const holder = randomToken(12);
    const claimedAt = this.clock.now();
    if (!(await this.store.sessions.claimRebind(sessionId, holder, claimedAt + REBIND_CLAIM_MS, claimedAt))) {
      return session;
    }
    try {
      return await this.#repinAndRebind(session, toVersion, this.#provisioner);
    } finally {
      await this.store.sessions.releaseRebind(sessionId, holder);
    }
  }

  /** `upgrade`'s re-pin and rebind, run while it holds the session's rebind slot. */
  async #repinAndRebind(session: Session, toVersion: number, provisioner: SessionProvisioner): Promise<Session> {
    const sessionId = session.id;
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

    const rebound = await provisioner.rebind(repinned);
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
    await provisioner.release(repinned, 'upgrade changed the sandbox spec');
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
   * Choose the model this session calls, for this session only.
   *
   * A session's model comes from its pinned version, which is immutable so a run
   * stays reproducible. "Try another model on this conversation" therefore needs
   * its own lever rather than a version edit, which would silently change what
   * every other session on that version runs.
   *
   * `modelId === undefined` clears the override and returns to the version's
   * model. A named model must be **catalogued and visible to this workspace** —
   * the same bar the version pin is held to — so this cannot route a run to an
   * unauthorized or uncatalogued model. The check is repeated at call time in the
   * runtime bridge, so a model later un-catalogued (or de-allow-listed) reverts to
   * the version's model rather than being used anyway.
   *
   * The row and the sandbox must name the same model: a sandbox asks for the
   * model it bootstrapped with, so a row that moved on without it would have the
   * bridge refuse every call. So, like a hot upgrade, a change lands only where
   * it can reach the sandbox at once: a queued session reads it when it
   * provisions, and a ready/idle one is rebound — and if that rebind cannot happen
   * (a turn started under it, or the sandbox did not answer) the change is rolled
   * back and reported as a conflict. A session mid-turn or still starting refuses
   * the change outright; the caller retries between turns.
   */
  async setModel(
    context: AuthContext,
    sessionId: string,
    modelId: string | undefined,
  ): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.model', { resourceId: sessionId });

    // Validate against the catalogue rather than trusting the id: this is the
    // authorization boundary for "which model may this session call", and the
    // runtime bridge trusts the stored value.
    let override: string | undefined;
    if (modelId !== undefined) {
      const model = await this.store.models.get(modelId);
      const visible =
        model !== undefined &&
        (model.allowedWorkspaceIds.length === 0 || model.allowedWorkspaceIds.includes(workspace.id));
      if (!visible) {
        throw validationError(
          `'${modelId}' is not an available model for this workspace; choose one from the catalogue`,
          { modelId },
        );
      }
      // A disabled model is catalogued but switched off platform-wide.
      if (!model.enabled) {
        throw validationError(`Model '${modelId}' is disabled`, { modelId });
      }
      override = modelId;
    }

    if (session.modelOverride === override) return session;

    // A terminal session runs nothing, so there is nothing to change.
    if (session.status === 'terminated' || session.status === 'failed') {
      throw conflict('This session has ended; its model cannot be changed', { sessionId });
    }

    const now = this.clock.now();
    const previous = session.modelOverride;
    const changed = (rebound: boolean) => ({
      type: 'session.model_changed' as const,
      payload: { fromModel: previous ?? null, toModel: override ?? null, rebound },
    });
    const keeps = previous ?? "the version's model";
    // Choosing the model is a cost/capability decision at the version-pin bar, so
    // it is audited like one: who, and what it moved between.
    const audited = (rebound: boolean) =>
      this.audit(context, {
        workspaceId: session.workspaceId,
        action: 'session.model',
        resourceKind: 'session',
        resourceId: sessionId,
        outcome: 'allowed',
        details: { fromModel: previous ?? null, toModel: override ?? null, rebound },
      });

    // No provisioner (an embedder or test that runs no sandboxes): nothing can be
    // bound to the old model, so the row is the whole story.
    if (!this.#provisioner) {
      const updated = await this.store.sessions.update(sessionId, { modelOverride: override, updatedAt: now });
      await this.#bus.publish([{ sessionId, workspaceId: session.workspaceId, ...changed(false) }]);
      await audited(false);
      return updated;
    }

    if (session.status === 'queued') {
      // No sandbox yet; the bootstrap that follows provisioning reads the row. The
      // CAS on `queued` orders this write before that bootstrap can run.
      const updated = await this.store.sessions.compareAndSetStatus(sessionId, 'queued', 'queued', {
        modelOverride: override,
        updatedAt: now,
      });
      if (!updated) throw this.#modelChangeRaced(sessionId, keeps);
      await this.#bus.publish([{ sessionId, workspaceId: session.workspaceId, ...changed(false) }]);
      await audited(false);
      return updated;
    }

    if (session.status !== 'ready' && session.status !== 'idle') {
      throw conflict(
        session.status === 'running'
          ? `This session is mid-turn, and its sandbox keeps the model it booted with (${keeps}) until it is ` +
              `rebound, which cannot happen during a turn. Change the model once the turn ends, or interrupt it first.`
          : `This session is ${session.status}; its model can be changed once it is queued, ready or idle. Retry shortly.`,
        { sessionId, status: session.status },
      );
    }

    // One rebind of this session at a time (see `claimRebind`): an upgrade or
    // another model change holding the slot is rebinding the sandbox now.
    const holder = randomToken(12);
    if (!(await this.store.sessions.claimRebind(sessionId, holder, now + REBIND_CLAIM_MS, now))) {
      throw conflict(
        `This session's sandbox is being changed by an upgrade or another model change, so nothing was changed ` +
          `and it keeps ${keeps}. Retry shortly.`,
        { sessionId },
      );
    }
    try {
      // Guarded by a status CAS: a `turn.started` landing between the read above
      // and this write moves the session to `running`, and an unconditional write
      // would rebind a session mid-turn.
      const updated = await this.store.sessions.compareAndSetStatus(sessionId, session.status, session.status, {
        modelOverride: override,
        updatedAt: now,
      });
      if (!updated) throw this.#modelChangeRaced(sessionId, keeps);

      let outcome: RebindOutcome;
      try {
        outcome = await this.#provisioner.rebind(updated);
      } catch (error) {
        await this.store.sessions.rollbackModelOverride(sessionId, override, previous, this.clock.now());
        throw error;
      }

      if (outcome === 'ok') {
        // The same in-place generation boundary as an `ok` upgrade rebind (see
        // `upgrade`): the sandbox id is unchanged, so the previous generation's
        // billing markers must go or they would dedup — and under-bill — its turns.
        this.store.billedTurns.clearSession(sessionId);
        await this.#bus.publish([{ sessionId, workspaceId: session.workspaceId, ...changed(true) }]);
        await audited(true);
        return updated;
      }
      if (outcome === 'busy') {
        // The row lagged agent-core's synchronous `running=true`: a turn is
        // executing on the old model. Roll back on the override, not the status —
        // the `turn.started` that made the rebind busy may already have moved the
        // row to `running`, and a status-guarded rollback would then silently no-op.
        await this.store.sessions.rollbackModelOverride(sessionId, override, previous, this.clock.now());
        throw conflict(
          `A turn started while the model was being changed, so the change was rolled back and the session keeps ` +
            `${keeps}. Change it once the turn ends.`,
          { sessionId },
        );
      }
      // `changed`: the sandbox cannot be reused (its pool key moved — a rotated
      // credential, say), so it is released and the session cold-starts, reading
      // the new model at bootstrap.
      await this.#provisioner.release(updated, 'model change needed a fresh sandbox');
      const requeued = await this.transition(sessionId, updated.status, 'queued', {
        patch: { sandboxId: undefined },
        event: changed(false),
      });
      await audited(false);
      return requeued;
    } finally {
      await this.store.sessions.releaseRebind(sessionId, holder);
    }
  }

  #modelChangeRaced(sessionId: string, keeps: string): MaError {
    return conflict(
      `The session changed state while its model was being changed (a turn started, or it began provisioning), ` +
        `so nothing was changed and it keeps ${keeps}. Retry.`,
      { sessionId },
    );
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
   * The dedup check and the fold are ONE transaction, so a fold that rolls back
   * cannot lose the dedup and two concurrent reports of the same turn cannot both
   * bill. The marker is keyed by `sandboxId`, so a stale marker from an earlier
   * generation of the same session cannot dedup this report.
   *
   * The turn-keyed dedup is IDEMPOTENT: a report keyed by turn dedups against the
   * marker with a non-destructive `has`, and a report that bills also `mark`s its
   * turn — so a repeated `turn.completed` for the same turn (a buggy/foreign
   * runtime posting it twice, or two in one /events batch) is deduped rather than
   * billed again. Only the per-sandbox turn-less sentinel (a completion that
   * omitted its turn) is genuinely one-shot and `consume`d, since the next turn end
   * clears it. When nothing matches, the report is the only accounting there is and
   * is folded. Returns whether it billed (false when deduped or the session was
   * terminal).
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
      // Turn-keyed dedup is IDEMPOTENT, not one-shot. A marker for this exact
      // (session, sandbox, turn) — left by the `/completions` proxy, or by a
      // prior report of this same turn — means the turn is already accounted for,
      // so dedup WITHOUT removing it. Using a destructive consume here let a
      // *repeated* turn.completed for the same turn (a buggy/foreign runtime
      // posting it twice, or two turn.completed in one /events batch) slip through:
      // the first consume deleted the marker, the second found none and folded the
      // usage a second time — a double-bill. `has` leaves the marker in place, and
      // the fold below marks the turn, so the second report always finds it.
      if (turn !== undefined && tx.billedTurns.has(sessionId, sandboxId, turn)) return false;
      // The per-sandbox turn-less sentinel is genuinely one-shot: a `/completions`
      // that omitted its turn set it, and the next turn end consumes it. A report
      // carrying a turn also consumes it (that completion's usage is what this
      // report would otherwise double-count).
      if (tx.billedTurns.consume(sessionId, sandboxId, TURNLESS_BILLED_TURN)) return false;
      // Bill, and — for a turn-keyed report — mark the turn so a later repeat of
      // the same report dedups against it rather than billing again.
      return this.#foldUsageSync(
        tx,
        session,
        now,
        delta,
        turn === undefined ? undefined : (t) => t.billedTurns.mark(sessionId, sandboxId, turn, now),
      );
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
      /** Stops a content search between steps, e.g. when the client disconnects. */
      signal?: AbortSignal;
    },
  ): Promise<{
    events: SessionEvent[];
    earliestSeq: number;
    lastSeq: number;
    /** Present for a content search: how far it got. */
    search?: { scanned: number; truncated: boolean; resumeSeq?: number };
  }> {
    // Authorization happens here; the result is discarded because only the
    // check matters. It also gives us the session row, whose `lastSeq` is the
    // DURABLE watermark — maintained by every append and surviving retention
    // pruning, unlike `events.lastSeq()` (a `MAX(seq)` over the log that reads 0
    // once every row is pruned). Returning the durable watermark is what lets a
    // resuming client detect a FULLY-pruned gap: an empty result with
    // `earliestSeq === 0` but `lastSeq >= fromSeq` means the whole
    // `[fromSeq, lastSeq]` range was pruned and the next event will be
    // `lastSeq + 1` — the same signal the SSE path emits as `stream.lagged`. Were
    // this the log's `MAX(seq)` (also 0 on a fully-pruned log), REST and SSE would
    // disagree and a REST client would silently jump the gap.
    const session = await this.get(context, sessionId);

    if (options.q !== undefined && options.q.length > 0) {
      const [found, earliestSeq] = await Promise.all([
        this.store.events.search(sessionId, options),
        this.store.events.earliestSeq(sessionId),
      ]);
      return {
        events: found.events,
        earliestSeq,
        lastSeq: session.lastSeq,
        search: {
          scanned: found.scanned,
          truncated: found.truncated,
          ...(found.resumeSeq !== undefined ? { resumeSeq: found.resumeSeq } : {}),
        },
      };
    }

    const [events, earliestSeq] = await Promise.all([
      this.store.events.read(sessionId, options),
      this.store.events.earliestSeq(sessionId),
    ]);
    return { events, earliestSeq, lastSeq: session.lastSeq };
  }
}
