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
import type { Page, PageRequest } from '@ma/store';

import { BaseService, type ServiceDeps } from './agents.ts';
import type { AuthContext } from './authz.ts';
import type { EventBus } from './event-bus.ts';

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
}

export interface CreateSessionInput {
  agentId: string;
  title?: string;
  /** Pins a specific version; otherwise production, else latest. */
  agentVersion?: number;
  credentialIds?: string[];
  origin?: SessionOrigin;
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
    } = {},
  ): Promise<Session> {
    sessionMachine.assert(from, to);

    const now = this.clock.now();
    const updated = await this.store.sessions.compareAndSetStatus(sessionId, from, to, {
      ...options.patch,
      updatedAt: now,
    });

    if (!updated) {
      const current = await this.store.sessions.get(sessionId);
      if (!current) throw notFound('Session', sessionId);
      throw conflict('Session status changed concurrently', {
        sessionId,
        expected: from,
        actual: current.status,
      });
    }

    if (options.event) {
      await this.#bus.publish([
        {
          sessionId,
          workspaceId: updated.workspaceId,
          type: options.event.type,
          payload: options.event.payload,
        },
      ]);
    }

    return updated;
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

    return this.transition(session.id, 'terminating', 'terminated', {
      patch: { endedAt: this.clock.now() },
      event,
    });
  }

  /**
   * Recover a session whose sandbox vanished.
   *
   * A lost sandbox is not the session's fault, so a session that has not yet
   * exhausted its logical lease returns to `provisioning` and continues from its
   * last context snapshot rather than failing the user's work.
   */
  async handleSandboxLost(sessionId: string, recoverable: boolean): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);
    if (sessionMachine.isTerminal(session.status)) return session;

    const now = this.clock.now();
    const canRecover =
      recoverable && session.expiresAt !== undefined && session.expiresAt > now;

    await this.#bus.publish([
      {
        sessionId,
        workspaceId: session.workspaceId,
        type: 'sandbox.lost',
        payload: {
          sandboxId: session.sandboxId ?? '',
          recoverable: canRecover,
        },
      },
    ]);

    if (canRecover && sessionMachine.canTransition(session.status, 'queued')) {
      // Back to the *queue*, not straight to provisioning. The queue has the one
      // atomic claim in the whole start path — `findQueued` selects `queued`
      // rows and `start()` compare-and-sets `queued → provisioning`, so exactly
      // one worker ever provisions a session. Recovering directly to
      // `provisioning` had no such claim before the expensive provision() call:
      // two replicas could both pick up one recovering session and each acquire
      // a sandbox, and a slow-but-live start() was indistinguishable from an
      // abandoned one. Re-queuing reuses the proven path and sidesteps both.
      return this.transition(sessionId, session.status, 'queued', {
        patch: { sandboxId: undefined },
      });
    }

    const info = {
      code: 'SANDBOX_LOST',
      message: 'The sandbox was lost and the session could not be recovered',
      details: {},
      occurredAt: now,
      retryable: false,
    };
    return this.transition(sessionId, session.status, 'failed', {
      patch: { error: info, endedAt: now },
      event: { type: 'session.failed', payload: { error: info } },
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

  /** Record token usage from a completed turn. */
  async recordUsage(
    sessionId: string,
    delta: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros?: number },
  ): Promise<void> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) return;
    await this.store.sessions.update(sessionId, {
      usage: {
        inputTokens: session.usage.inputTokens + (delta.inputTokens ?? 0),
        outputTokens: session.usage.outputTokens + (delta.outputTokens ?? 0),
        cacheReadTokens: session.usage.cacheReadTokens + (delta.cacheReadTokens ?? 0),
        cacheWriteTokens: session.usage.cacheWriteTokens + (delta.cacheWriteTokens ?? 0),
        costMicros: session.usage.costMicros + (delta.costMicros ?? 0),
      },
      updatedAt: this.clock.now(),
    });
  }

  /** Read the event log. This is how a client resumes. */
  async readEvents(
    context: AuthContext,
    sessionId: string,
    options: { fromSeq?: number; toSeq?: number; limit?: number; types?: string[]; turn?: number },
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
