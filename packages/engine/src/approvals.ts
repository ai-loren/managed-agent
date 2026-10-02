/**
 * Tool calls a person approves before they run.
 *
 * A sandbox whose policy routes a call to a person asks here and waits; a
 * principal with `session.approve` answers through the API. The record — the
 * decision, who made it and when — is the control plane's, never a sandbox's
 * claim, so it can stand as the audit trail.
 */

import { conflict, newId, notFound } from '@ma/core';
import { sessionMachine, type Approval, type ApprovalStatus, type Session } from '@ma/contracts';
import type { Page, PageRequest } from '@ma/store';

import { BaseService, type ServiceDeps } from './agents.ts';
import type { AuthContext } from './authz.ts';
import type { EventBus } from './event-bus.ts';

/** Sessions no person is attending: a call there is denied at once rather than left waiting. */
const UNATTENDED_ORIGINS: ReadonlySet<string> = new Set(['connector', 'schedule']);
/** What a person is shown of a call's arguments; a tool's input can be a whole file. */
const MAX_INPUT_CHARS = 16_000;

export interface ApprovalServiceDeps extends ServiceDeps {
  bus: EventBus;
}

/** A call the sandbox wants a person to look at. */
export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  turn: number;
  /** The sandbox asking. A session that has since moved to another sandbox has no turn waiting. */
  sandboxId?: string;
}

export class ApprovalService extends BaseService {
  readonly #bus: EventBus;

  constructor(deps: ApprovalServiceDeps) {
    super(deps);
    this.#bus = deps.bus;
  }

  /**
   * Record a call as waiting on a person, or deny it now when no one can answer.
   * Asking again for the same call returns the same approval.
   */
  async request(session: Session, call: ApprovalRequest, timeoutSeconds: number): Promise<Approval> {
    const now = this.clock.now();
    const { approval, created } = await this.store.approvals.createIfAbsent({
      id: newId('approval', now),
      sessionId: session.id,
      workspaceId: session.workspaceId,
      ...(call.sandboxId === undefined ? {} : { sandboxId: call.sandboxId }),
      turn: call.turn,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: boundedInput(call.input),
      reason: call.reason,
      status: 'pending',
      requestedAt: now,
      expiresAt: now + timeoutSeconds * 1000,
      decisionReason: '',
    });
    if (!created) return this.#settleIfDue(approval);
    await this.#bus.publish([
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'approval.requested',
        turn: approval.turn,
        payload: {
          approvalId: approval.id,
          toolCallId: approval.toolCallId,
          toolName: approval.toolName,
          input: approval.input,
          reason: approval.reason,
          expiresAt: approval.expiresAt,
        },
      },
    ]);
    await this.#appendAudit(approval, {
      principalId: `session:${session.id}`,
      action: 'session.approval.request',
      outcome: 'allowed',
      reason: approval.reason,
    });
    if (!UNATTENDED_ORIGINS.has(session.origin)) return approval;
    const denied = await this.store.approvals.decide(
      approval.id,
      {
        status: 'denied',
        reason:
          `This session was started by a ${session.origin}, so no one is there to approve the call. ` +
          "Allow the tool in the agent's policy, or run it in a session someone attends.",
      },
      now,
    );
    if (!denied) return this.#settleIfDue(approval);
    await this.#publishDecided(denied);
    return denied;
  }

  /** The approval as the waiting sandbox sees it, settled once no one can answer it. */
  async status(session: Session, approvalId: string): Promise<Approval> {
    const approval = await this.store.approvals.get(approvalId);
    if (!approval || approval.sessionId !== session.id) throw notFound('Approval', approvalId);
    return this.#settle(approval, await this.store.sessions.get(session.id));
  }

  /**
   * Wait up to `waitMs` for the approval to be settled, returning it as it then
   * stands. Wakes on its `approval.decided` — which the bus carries from any
   * replica — or when its time runs out, whichever comes first.
   */
  async waitForDecision(session: Session, approvalId: string, waitMs: number, signal?: AbortSignal): Promise<Approval> {
    const before = await this.status(session, approvalId);
    if (before.status !== 'pending' || waitMs <= 0) return before;
    const wake = new AbortController();
    const onAbort = (): void => wake.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const subscription = this.#bus.subscribe({
      sessionId: session.id,
      types: ['approval.decided'],
      onEvent: (event) => {
        if ((event.payload as { approvalId?: unknown }).approvalId === approvalId) wake.abort();
      },
    });
    try {
      // Decided between the first look and the subscription: nothing will wake it.
      const current = await this.status(session, approvalId);
      if (current.status !== 'pending') return current;
      const remaining = Math.max(0, current.expiresAt - this.clock.now());
      await this.clock.sleep(Math.min(waitMs, remaining), wake.signal).catch(() => undefined);
      return await this.status(session, approvalId);
    } finally {
      subscription.close();
      signal?.removeEventListener('abort', onAbort);
      wake.abort();
    }
  }

  /** A person's answer to a call waiting in one of their sessions. */
  async decide(
    context: AuthContext,
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    reason: string,
  ): Promise<Approval> {
    const session = await this.#readableSession(context, sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.approve', { resourceId: sessionId });
    const approval = await this.store.approvals.get(approvalId);
    if (!approval || approval.sessionId !== sessionId) throw notFound('Approval', approvalId);
    await this.#settle(approval, session);

    const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'denied';
    const settled = await this.store.approvals.decide(
      approvalId,
      { status, decidedBy: context.principal.id, reason },
      this.clock.now(),
    );
    if (!settled) {
      const current = await this.#settleIfDue((await this.store.approvals.get(approvalId)) ?? approval);
      throw conflict(
        `This call is already ${current.status}${current.decisionReason ? ` (${current.decisionReason})` : ''}, ` +
          'so the decision was not recorded. A new call that needs approval appears as a new approval on the session.',
        { approvalId, status: current.status },
      );
    }
    await this.#publishDecided(settled, true);
    await this.audit(context, {
      workspaceId: session.workspaceId,
      action: 'session.approve',
      resourceKind: 'session',
      resourceId: sessionId,
      outcome: 'allowed',
      reason,
      details: { approvalId, toolCallId: settled.toolCallId, toolName: settled.toolName, decision: status },
    });
    return settled;
  }

  async get(context: AuthContext, sessionId: string, approvalId: string): Promise<Approval> {
    const session = await this.#readableSession(context, sessionId);
    const approval = await this.store.approvals.get(approvalId);
    if (!approval || approval.sessionId !== sessionId) throw notFound('Approval', approvalId);
    return this.#settle(approval, session);
  }

  /** One session's approvals, or a workspace's, in the order they were asked. */
  async list(
    context: AuthContext,
    filter: ({ sessionId: string; workspaceId?: undefined } | { workspaceId: string; sessionId?: undefined }) & {
      statuses?: readonly ApprovalStatus[];
    } & PageRequest,
  ): Promise<Page<Approval>> {
    if (filter.sessionId !== undefined) {
      await this.#readableSession(context, filter.sessionId);
    } else {
      const workspace = await this.requireWorkspace(filter.workspaceId!);
      this.authorizer.require(context, workspace, 'session.read');
    }
    const page = await this.store.approvals.list(filter);
    // Settled lazily as well as by the sweep, so a list never shows a call as
    // still waiting once its time is up or its session has ended.
    const sessions = new Map<string, Session | undefined>();
    const items: Approval[] = [];
    for (const approval of page.items) {
      if (!sessions.has(approval.sessionId)) sessions.set(approval.sessionId, await this.store.sessions.get(approval.sessionId));
      items.push(await this.#settle(approval, sessions.get(approval.sessionId)));
    }
    const statuses = filter.statuses;
    return {
      ...page,
      items: statuses && statuses.length > 0 ? items.filter((approval) => statuses.includes(approval.status)) : items,
    };
  }

  /** Settle pending calls whose time is up; how many it settled. */
  async expireDue(limit = 100): Promise<number> {
    const now = this.clock.now();
    let settled = 0;
    for (const approval of await this.store.approvals.findDue(now, limit)) {
      const expired = await this.store.approvals.expire(approval.id, now, expiredReason(approval));
      if (!expired) continue;
      await this.#publishDecided(expired);
      settled++;
    }
    return settled;
  }

  /**
   * A turn or the session ended: nothing waits on its calls any more. Only
   * turns up to `throughTurn` when given — a turn's end can be reported after
   * the next turn has already asked.
   */
  async cancelForSession(sessionId: string, reason: string, throughTurn?: number): Promise<number> {
    const cancelled = await this.store.approvals.cancelPending(sessionId, this.clock.now(), reason, throughTurn);
    for (const approval of cancelled) await this.#publishDecided(approval);
    return cancelled.length;
  }

  async #readableSession(context: AuthContext, sessionId: string): Promise<Session> {
    const session = await this.store.sessions.get(sessionId);
    if (!session) throw notFound('Session', sessionId);
    const workspace = await this.requireWorkspace(session.workspaceId);
    this.authorizer.require(context, workspace, 'session.read', { resourceId: sessionId });
    return session;
  }

  /**
   * Settle a pending approval nothing waits on any more: its session ended, the
   * sandbox whose turn asked is no longer the session's (it was lost, and the
   * turn with it), or its time is up.
   */
  async #settle(approval: Approval, session: Session | undefined): Promise<Approval> {
    if (approval.status !== 'pending') return approval;
    if (session && sessionMachine.isTerminal(session.status)) {
      await this.cancelForSession(approval.sessionId, 'The session ended before anyone decided.');
      return (await this.store.approvals.get(approval.id)) ?? approval;
    }
    if (session && approval.sandboxId !== undefined && session.sandboxId !== approval.sandboxId) {
      const cancelled = await this.store.approvals.decide(
        approval.id,
        { status: 'cancelled', reason: 'The sandbox running the turn was lost before anyone decided, and the turn with it.' },
        this.clock.now(),
      );
      if (cancelled) {
        await this.#publishDecided(cancelled);
        return cancelled;
      }
    }
    return this.#settleIfDue((await this.store.approvals.get(approval.id)) ?? approval);
  }

  async #settleIfDue(approval: Approval): Promise<Approval> {
    if (approval.status !== 'pending' || approval.expiresAt > this.clock.now()) return approval;
    const expired = await this.store.approvals.expire(approval.id, this.clock.now(), expiredReason(approval));
    if (!expired) return (await this.store.approvals.get(approval.id)) ?? approval;
    await this.#publishDecided(expired);
    return expired;
  }

  /** Every settlement's event; one no person made is audited here too, as the system's. */
  async #publishDecided(approval: Approval, byPerson = false): Promise<void> {
    await this.#bus.publish([
      {
        sessionId: approval.sessionId,
        workspaceId: approval.workspaceId,
        type: 'approval.decided',
        turn: approval.turn,
        payload: {
          approvalId: approval.id,
          toolCallId: approval.toolCallId,
          decision: approval.status as Exclude<ApprovalStatus, 'pending'>,
          by: approval.decidedBy ?? '',
          reason: approval.decisionReason,
        },
      },
    ]);
    if (byPerson) return;
    await this.#appendAudit(approval, {
      principalId: 'system',
      action: 'session.approval.settle',
      outcome: 'denied',
      reason: approval.decisionReason,
    });
  }

  async #appendAudit(
    approval: Approval,
    entry: { principalId: string; action: string; outcome: 'allowed' | 'denied'; reason: string },
  ): Promise<void> {
    const now = this.clock.now();
    await this.store.audit.append({
      id: newId('auditEntry', now),
      workspaceId: approval.workspaceId,
      principalId: entry.principalId,
      action: entry.action,
      resourceKind: 'session',
      resourceId: approval.sessionId,
      outcome: entry.outcome,
      reason: entry.reason,
      requestId: '',
      sourceIp: '',
      details: {
        approvalId: approval.id,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName,
        turn: approval.turn,
        decision: approval.status,
      },
      at: now,
    });
  }
}

function expiredReason(approval: Approval): string {
  const seconds = Math.round((approval.expiresAt - approval.requestedAt) / 1000);
  return `No one approved or denied the call within ${seconds} s, so it was denied.`;
}

/**
 * The arguments as a person sees them: whole when small, else the JSON cut at
 * the limit and marked as cut, so a large write cannot bloat every list.
 */
function boundedInput(input: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(input ?? {});
  if (json.length <= MAX_INPUT_CHARS) return input ?? {};
  return { truncated: true, preview: json.slice(0, MAX_INPUT_CHARS) };
}
