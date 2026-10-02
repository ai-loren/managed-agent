/**
 * Approval tests.
 *
 * A call the policy routes to a person must run only on a person's yes, and
 * every way it can end without one — a no, nobody attending, the time running
 * out, the session or its sandbox going away — must read as a denial that is
 * on the record.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, TestClock, newId, nullLogger } from '@ma/core';
import type { Approval, Principal, Session } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  AgentService,
  ApprovalService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  WorkspaceService,
  type ApprovalRequest,
  type AuthContext,
} from '../src/index.ts';

const START = 1_700_000_000_000;
const TIMEOUT_SECONDS = 60;

let store: SqliteStore;
let clock: TestClock;
let bus: EventBus;
let approvals: ApprovalService;
let owner: AuthContext;
let operator: AuthContext;
let viewer: AuthContext;
let workspaceId: string;
let agentId: string;
let session: Session;
let sandboxId: string;

async function person(subject: string, isAdmin = false): Promise<Principal> {
  return store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject,
    displayName: subject,
    email: '',
    isAdmin,
    disabled: false,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'system',
  });
}

async function sessionWith(overrides: Partial<Session> = {}): Promise<Session> {
  return store.sessions.create({
    id: newId('session'),
    workspaceId,
    agentId,
    resolvedVersion: 1,
    title: '',
    status: 'running',
    origin: 'api',
    sandboxId,
    credentialIds: [],
    lastSeq: 0,
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: owner.principal.id,
    ...overrides,
  });
}

beforeEach(async () => {
  store = createMemoryStore();
  clock = new TestClock(START);
  bus = new EventBus(store, clock, nullLogger);
  const deps = { store, clock, logger: nullLogger, authorizer: new RoleAuthorizer(), quota: new QuotaService(store, clock) };
  approvals = new ApprovalService({ ...deps, bus });

  const admin = await person('owner', true);
  owner = { principal: admin } as AuthContext;
  const workspace = await new WorkspaceService(deps).create(owner, { name: 'Team', slug: 'approval-test' });
  workspaceId = workspace.id;
  const operatorPrincipal = await person('operator');
  const viewerPrincipal = await person('viewer');
  await store.workspaces.update(workspaceId, {
    members: [
      { principalId: admin.id, role: 'owner', addedAt: START },
      { principalId: operatorPrincipal.id, role: 'operator', addedAt: START },
      { principalId: viewerPrincipal.id, role: 'viewer', addedAt: START },
    ],
    updatedAt: START,
  });
  operator = { principal: operatorPrincipal } as AuthContext;
  viewer = { principal: viewerPrincipal } as AuthContext;

  const agent = await new AgentService(deps).create(owner, {
    workspaceId,
    name: 'Assistant',
    spec: { systemPrompt: 'x', model: { modelId: 'm' } },
  });
  agentId = agent.id;
  sandboxId = newId('sandbox');
  session = await sessionWith();
});

afterEach(async () => {
  await store.close();
});

function call(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId: 'call_1',
    toolName: 'shell',
    input: { command: 'rm -rf build' },
    reason: 'shell needs approval',
    turn: 1,
    sandboxId,
    ...overrides,
  };
}

function ask(overrides: Partial<ApprovalRequest> = {}, on: Session = session): Promise<Approval> {
  return approvals.request(on, call(overrides), TIMEOUT_SECONDS);
}

async function eventsOf(type: string, on: Session = session) {
  return store.events.read(on.id, { types: [type] });
}

async function auditOf(action: string) {
  return (await store.audit.list({ workspaceId, action })).items;
}

/** Until something sleeps on the clock; a wait that never starts fails here rather than spinning forever. */
async function untilSleeping(on: TestClock): Promise<void> {
  for (let spins = 0; on.pendingCount === 0; spins++) {
    if (spins > 10_000) assert.fail('nothing started waiting on the clock');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function isConflict(pattern: RegExp) {
  return (error: unknown) => MaError.is(error) && error.status === 409 && pattern.test(error.message);
}

describe('asking', () => {
  test('a call that needs approval waits as pending, on the session log and in the audit trail', async () => {
    const approval = await ask();
    assert.equal(approval.status, 'pending');
    assert.equal(approval.expiresAt, START + TIMEOUT_SECONDS * 1000);
    assert.equal(approval.sandboxId, sandboxId);

    const [requested, ...more] = await eventsOf('approval.requested');
    assert.equal(more.length, 0);
    assert.deepEqual(requested?.payload, {
      approvalId: approval.id,
      toolCallId: 'call_1',
      toolName: 'shell',
      input: { command: 'rm -rf build' },
      reason: 'shell needs approval',
      expiresAt: approval.expiresAt,
    });
    assert.equal(requested?.turn, 1);
    const [entry] = await auditOf('session.approval.request');
    assert.equal(entry?.principalId, `session:${session.id}`);
    assert.equal(entry?.resourceId, session.id);
    assert.deepEqual(entry?.details, { approvalId: approval.id, toolCallId: 'call_1', toolName: 'shell', turn: 1, decision: 'pending' });
  });

  test('asking again for the same call returns the same approval and records nothing new', async () => {
    const first = await ask();
    const again = await ask({ reason: 'asked after a dropped connection' });
    assert.equal(again.id, first.id);
    assert.equal(again.reason, 'shell needs approval');
    assert.equal((await eventsOf('approval.requested')).length, 1);
    assert.equal((await auditOf('session.approval.request')).length, 1);
    assert.notEqual((await ask({ toolCallId: 'call_2' })).id, first.id);
  });

  for (const origin of ['connector', 'schedule'] as const) {
    test(`a session started by a ${origin} has no one to ask, so the call is denied at once, on the record`, async () => {
      const unattended = await sessionWith({ origin });
      const approval = await ask({}, unattended);
      assert.equal(approval.status, 'denied');
      assert.equal(approval.decidedBy, undefined);
      assert.match(approval.decisionReason, new RegExp(`started by a ${origin}`));
      assert.match(approval.decisionReason, /Allow the tool in the agent's policy/);

      const [decided] = await eventsOf('approval.decided', unattended);
      assert.deepEqual(decided?.payload, {
        approvalId: approval.id,
        toolCallId: 'call_1',
        decision: 'denied',
        by: '',
        reason: approval.decisionReason,
      });
      const [entry] = await auditOf('session.approval.settle');
      assert.equal(entry?.principalId, 'system');
      assert.equal(entry?.outcome, 'denied');
      assert.equal((entry?.details as { decision?: string }).decision, 'denied');
    });
  }

  test('a large input is cut for the person reading it, and marked as cut', async () => {
    const approval = await ask({ input: { content: 'x'.repeat(20_000) } });
    const shown = approval.input as { truncated?: boolean; preview?: string };
    assert.equal(shown.truncated, true);
    assert.equal(shown.preview?.length, 16_000);
    const small = await ask({ toolCallId: 'call_2', input: { content: 'x'.repeat(100) } });
    assert.deepEqual(small.input, { content: 'x'.repeat(100) });
  });
});

describe('deciding', () => {
  test('an operator approves, and the decision is recorded with who made it, on the log and in the audit trail', async () => {
    const approval = await ask();
    const decided = await approvals.decide(operator, session.id, approval.id, 'approve', 'reviewed the command');
    assert.equal(decided.status, 'approved');
    assert.equal(decided.decidedBy, operator.principal.id);
    assert.equal(decided.decisionReason, 'reviewed the command');

    const [event] = await eventsOf('approval.decided');
    assert.deepEqual(event?.payload, {
      approvalId: approval.id,
      toolCallId: 'call_1',
      decision: 'approved',
      by: operator.principal.id,
      reason: 'reviewed the command',
    });
    const [entry, ...more] = await auditOf('session.approve');
    assert.equal(more.length, 0);
    assert.equal(entry?.principalId, operator.principal.id);
    assert.equal(entry?.outcome, 'allowed');
    assert.equal((entry?.details as { decision?: string }).decision, 'approved');
    assert.equal((await auditOf('session.approval.settle')).length, 0, 'a person decided, not the system');
  });

  test('a denial carries the reason the agent will read', async () => {
    const approval = await ask();
    const decided = await approvals.decide(owner, session.id, approval.id, 'deny', 'not on production');
    assert.equal(decided.status, 'denied');
    assert.equal(decided.decisionReason, 'not on production');
  });

  test('a viewer cannot decide, and the call stays pending', async () => {
    const approval = await ask();
    await assert.rejects(
      approvals.decide(viewer, session.id, approval.id, 'approve', ''),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
    assert.equal((await approvals.get(viewer, session.id, approval.id)).status, 'pending');
  });

  test('someone outside the workspace cannot see or decide the call', async () => {
    const approval = await ask();
    const stranger = { principal: await person('stranger') } as AuthContext;
    await assert.rejects(approvals.decide(stranger, session.id, approval.id, 'approve', ''), (error: unknown) => MaError.is(error));
    await assert.rejects(approvals.get(stranger, session.id, approval.id), (error: unknown) => MaError.is(error));
    assert.equal((await approvals.get(owner, session.id, approval.id)).status, 'pending');
  });

  test('an approval is reached only through its own session', async () => {
    const approval = await ask();
    const other = await sessionWith();
    await assert.rejects(
      approvals.decide(owner, other.id, approval.id, 'approve', ''),
      (error: unknown) => MaError.is(error) && error.status === 404,
    );
    await assert.rejects(approvals.status(other, approval.id), (error: unknown) => MaError.is(error) && error.status === 404);
  });

  test('the first answer stands: a second is refused with the status it already has', async () => {
    const approval = await ask();
    await approvals.decide(operator, session.id, approval.id, 'approve', '');
    await assert.rejects(
      approvals.decide(owner, session.id, approval.id, 'deny', 'changed my mind'),
      isConflict(/already approved/),
    );
    assert.equal((await approvals.get(owner, session.id, approval.id)).status, 'approved');
    assert.equal((await eventsOf('approval.decided')).length, 1);
  });
});

describe('when no one answers', () => {
  test('the sweep denies a call nobody decided in time, and a late answer is refused', async () => {
    const approval = await ask();
    await clock.advance(TIMEOUT_SECONDS * 1000 - 1);
    assert.equal(await approvals.expireDue(), 0, 'not yet');
    await clock.advance(1);
    assert.equal(await approvals.expireDue(), 1);
    assert.equal(await approvals.expireDue(), 0, 'once');

    const expired = await approvals.get(owner, session.id, approval.id);
    assert.equal(expired.status, 'expired');
    assert.match(expired.decisionReason, /within 60 s/);
    const [event] = await eventsOf('approval.decided');
    assert.equal((event?.payload as { decision?: string }).decision, 'expired');
    assert.equal((await auditOf('session.approval.settle')).length, 1);
    await assert.rejects(approvals.decide(operator, session.id, approval.id, 'approve', ''), isConflict(/already expired/));
  });

  test('a call whose time is up reads as expired before the sweep has run', async () => {
    const approval = await ask();
    await clock.advance(TIMEOUT_SECONDS * 1000);
    const waiting = await approvals.list(owner, { sessionId: session.id, statuses: ['pending'] });
    assert.deepEqual(waiting.items, [], 'not listed among the calls still waiting');
    assert.equal((await approvals.status(session, approval.id)).status, 'expired');
  });

  test("a turn's end cancels the calls it left waiting, not a later turn's", async () => {
    const early = await ask({ toolCallId: 'call_1', turn: 1 });
    const later = await ask({ toolCallId: 'call_2', turn: 2 });
    assert.equal(await approvals.cancelForSession(session.id, 'The turn ended before anyone decided.', 1), 1);
    assert.equal((await approvals.get(owner, session.id, early.id)).status, 'cancelled');
    assert.equal((await approvals.get(owner, session.id, later.id)).status, 'pending');
    const [event] = await eventsOf('approval.decided');
    assert.equal((event?.payload as { decision?: string; approvalId?: string }).approvalId, early.id);
    assert.equal((event?.payload as { decision?: string }).decision, 'cancelled');
  });

  test("an ended session's call reads as cancelled and can no longer be approved", async () => {
    const approval = await ask();
    await store.sessions.update(session.id, { status: 'terminated', updatedAt: START });
    const [listed] = (await approvals.list(owner, { workspaceId })).items;
    assert.equal(listed?.status, 'cancelled');
    assert.match(listed?.decisionReason ?? '', /session ended/);
    await assert.rejects(approvals.decide(operator, session.id, approval.id, 'approve', ''), isConflict(/already cancelled/));
  });

  test('a call asked by a sandbox the session has since lost is cancelled, and cannot be approved', async () => {
    const approval = await ask();
    await store.sessions.update(session.id, { status: 'queued', sandboxId: undefined, updatedAt: START });
    await assert.rejects(approvals.decide(operator, session.id, approval.id, 'approve', ''), isConflict(/already cancelled.*sandbox/));
    assert.equal((await eventsOf('approval.decided')).length, 1);
  });

  test("the same sandbox coming back finds its call still waiting", async () => {
    const approval = await ask();
    // A control-plane restart or a dropped connection: the sandbox asks again.
    const again = await ask();
    assert.equal(again.id, approval.id);
    assert.equal((await approvals.status(session, approval.id)).status, 'pending');
  });
});

describe('waiting', () => {
  test('the wait wakes on the decision, not at the end of its time', async () => {
    const approval = await ask();
    const outcome: { settled?: Approval } = {};
    const waiting = approvals.waitForDecision(session, approval.id, 25_000).then((result) => (outcome.settled = result));
    await untilSleeping(clock);
    const before = outcome.settled;
    assert.equal(before, undefined);

    await approvals.decide(operator, session.id, approval.id, 'approve', '');
    await waiting;
    assert.equal(outcome.settled?.status, 'approved');
    assert.equal(clock.now(), START, 'no time had to pass');
  });

  test('a decision announced after the wait read the call but before it subscribed still wakes it', async () => {
    const approval = await ask();
    const realGet = store.approvals.get.bind(store.approvals);
    let decided = false;
    // Every read before the wait subscribes sees the call pending, and the
    // decision is committed and announced in that window: only a look after
    // subscribing can find it.
    store.approvals.get = async (id) => {
      const row = await realGet(id);
      if (id !== approval.id || bus.subscriberCount(session.id) > 0) return row;
      if (!decided) {
        decided = true;
        await approvals.decide(operator, session.id, approval.id, 'approve', '');
      }
      return row && { ...row, status: 'pending' };
    };
    try {
      const outcome: { settled?: Approval } = {};
      const waiting = approvals.waitForDecision(session, approval.id, 25_000).then((result) => (outcome.settled = result));
      for (let spins = 0; !outcome.settled && spins < 200; spins++) await new Promise((resolve) => setImmediate(resolve));
      const settled = outcome.settled;
      if (!settled) {
        await clock.advance(25_000);
        await waiting;
      }
      assert.ok(decided, 'the decision landed in the window');
      assert.equal(settled?.status, 'approved', 'the wait found the decision without waiting out its time');
    } finally {
      store.approvals.get = realGet;
    }
  });

  test('a decision landing at any point of the wait starting up still wakes it', async () => {
    for (let delay = 0; delay < 40; delay++) {
      const approval = await ask({ toolCallId: `call_race_${delay}` });
      const outcome: { settled?: Approval } = {};
      const waiting = approvals.waitForDecision(session, approval.id, 25_000).then((result) => (outcome.settled = result));
      for (let tick = 0; tick < delay; tick++) await Promise.resolve();
      await approvals.decide(operator, session.id, approval.id, 'approve', '');
      for (let spins = 0; !outcome.settled && spins < 200; spins++) await new Promise((resolve) => setImmediate(resolve));
      const settled = outcome.settled;
      if (!settled) {
        await clock.advance(25_000);
        await waiting;
      }
      assert.equal(settled?.status, 'approved', `a decision ${delay} microtasks into the wait was missed`);
    }
  });

  test('the wait answers pending when its time passes without a decision', async () => {
    const approval = await ask();
    const waiting = approvals.waitForDecision(session, approval.id, 5_000);
    await untilSleeping(clock);
    await clock.advance(5_000);
    assert.equal((await waiting).status, 'pending');
  });

  test('the wait ends when the time to decide runs out, and says so', async () => {
    const approval = await ask();
    await clock.advance(TIMEOUT_SECONDS * 1000 - 2_000);
    const waiting = approvals.waitForDecision(session, approval.id, 25_000);
    await untilSleeping(clock);
    await clock.advance(2_000);
    assert.equal((await waiting).status, 'expired');
  });

  test('an aborted wait returns at once with the call still pending', async () => {
    const approval = await ask();
    const abort = new AbortController();
    const waiting = approvals.waitForDecision(session, approval.id, 25_000, abort.signal);
    await untilSleeping(clock);
    abort.abort();
    assert.equal((await waiting).status, 'pending');
    assert.equal(clock.pendingCount, 0, 'nothing left sleeping');
    assert.equal(bus.subscriberCount(session.id), 0, 'nothing left subscribed');
  });
});

describe('listing', () => {
  test("a workspace's queue lists every session's pending calls, oldest first, to anyone who can read it", async () => {
    const other = await sessionWith();
    const first = await ask();
    await clock.advance(1);
    const second = await ask({}, other);
    await clock.advance(1);
    const decided = await ask({ toolCallId: 'call_2' });
    await approvals.decide(operator, session.id, decided.id, 'deny', '');

    const queue = await approvals.list(viewer, { workspaceId, statuses: ['pending'] });
    assert.deepEqual(queue.items.map((approval) => approval.id), [first.id, second.id]);
    const mine = await approvals.list(viewer, { sessionId: session.id });
    assert.deepEqual(mine.items.map((approval) => approval.id), [first.id, decided.id]);
  });
});
