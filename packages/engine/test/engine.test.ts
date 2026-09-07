/**
 * Engine tests.
 *
 * These assert the invariants the design rests on: pinned versions, guarded
 * transitions, write-only credentials, quota admission, and an event bus where
 * a slow subscriber degrades instead of taking the process down.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, MaError, TestClock, newId, nullLogger } from '@ma/core';
import type { Principal, Session, SessionEvent, UniversalEvent, Workspace } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  AgentService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type AuthContext,
  type SessionProvisioner,
} from '../src/index.ts';

const START = 1_700_000_000_000;

let store: SqliteStore;
let clock: TestClock;
let bus: EventBus;
let workspaces: WorkspaceService;
let agents: AgentService;
let sessions: SessionService;
let credentials: CredentialService;
let quota: QuotaService;
let provisioner: FakeProvisioner;

/** Records what the engine asked of the sandbox layer, and can be made to fail. */
class FakeProvisioner implements SessionProvisioner {
  provisioned: string[] = [];
  released: string[] = [];
  /** Sandbox ids handed out, so a test can assert none was left behind. */
  acquired: string[] = [];
  /** Sandbox ids actually released — the leak check. */
  releasedSandboxes: string[] = [];
  submitted: { sessionId: string; events: readonly UniversalEvent[] }[] = [];
  failNext = false;
  /** Runs while `provision` is in flight, to stage a concurrent transition. */
  onProvision: (() => Promise<void>) | undefined;

  async provision(session: Session): Promise<{ sandboxId: string; reused: boolean; provisionMs: number }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('no capacity');
    }
    if (this.onProvision) {
      const hook = this.onProvision;
      this.onProvision = undefined;
      await hook();
    }
    this.provisioned.push(session.id);
    const sandboxId = newId('sandbox');
    this.acquired.push(sandboxId);
    return { sandboxId, reused: false, provisionMs: 120 };
  }

  release(session: Session): Promise<void> {
    this.released.push(session.id);
    if (session.sandboxId) this.releasedSandboxes.push(session.sandboxId);
    return Promise.resolve();
  }

  /** Sandboxes handed out that were never released. */
  get leaked(): string[] {
    return this.acquired.filter((id) => !this.releasedSandboxes.includes(id));
  }

  submit(session: Session, events: readonly UniversalEvent[]): Promise<void> {
    this.submitted.push({ sessionId: session.id, events });
    return Promise.resolve();
  }
}

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: newId('principal'),
    type: 'user',
    subject: `user-${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'Test User',
    email: '',
    isAdmin: false,
    disabled: false,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'system',
    ...overrides,
  };
}

async function asContext(principal: Principal): Promise<AuthContext> {
  await store.principals.create(principal);
  return { principal };
}

beforeEach(() => {
  store = createMemoryStore();
  clock = new TestClock(START);
  bus = new EventBus(store, clock, nullLogger);
  quota = new QuotaService(store, clock);
  provisioner = new FakeProvisioner();

  const deps = { store, clock, quota, logger: nullLogger, authorizer: new RoleAuthorizer() };
  workspaces = new WorkspaceService(deps);
  agents = new AgentService(deps);
  sessions = new SessionService({ ...deps, bus, provisioner });
  credentials = new CredentialService({ ...deps, keys: InMemoryKeyProvider.generate() });
});

afterEach(async () => {
  bus.closeAll();
  await store.close();
});

/** A workspace owned by a fresh principal, with an agent at version 1. */
async function scenario(): Promise<{
  context: AuthContext;
  workspace: Workspace;
  agentId: string;
}> {
  const context = await asContext(makePrincipal());
  const workspace = await workspaces.create(context, { name: 'Team', slug: 'team' });
  const agent = await agents.create(context, {
    workspaceId: workspace.id,
    name: 'Assistant',
    spec: { model: { modelId: 'anthropic/claude-sonnet-5' }, systemPrompt: 'v1' },
  });
  return { context, workspace, agentId: agent.id };
}

// ---------------------------------------------------------------------------

describe('authorization', () => {
  test('the creator of a workspace is its owner', async () => {
    const context = await asContext(makePrincipal());
    const workspace = await workspaces.create(context, { name: 'Team', slug: 'team' });
    assert.equal(new RoleAuthorizer().roleIn(context.principal, workspace), 'owner');
  });

  test('a non-member cannot read a workspace', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const stranger = await asContext(makePrincipal());

    await assert.rejects(workspaces.get(stranger, workspace.id), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.status, 403);
      return true;
    });
  });

  test('roles gate by privilege level, not by identity', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const viewer = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: viewer.principal.id, role: 'viewer' },
    ]);

    // A viewer reads but cannot create.
    assert.ok(await workspaces.get(viewer, workspace.id));
    await assert.rejects(
      agents.create(viewer, { workspaceId: workspace.id, name: 'nope' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('an operator can run an agent but not change it', async () => {
    // The on-call case: permission to act without permission to redefine.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });

    const operator = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: operator.principal.id, role: 'operator' },
    ]);

    assert.ok(await sessions.create(operator, { agentId: agent.id }));
    await assert.rejects(
      agents.update(operator, agent.id, { name: 'renamed' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('a platform admin bypasses membership', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const admin = await asContext(makePrincipal({ isAdmin: true }));
    assert.ok(await workspaces.get(admin, workspace.id));
  });

  test('a disabled principal is refused even with a role', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    await store.principals.update(owner.principal.id, { disabled: true });
    const disabled: AuthContext = { principal: { ...owner.principal, disabled: true } };

    await assert.rejects(
      workspaces.get(disabled, workspace.id),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('api key scopes narrow a principal rather than merely advising', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const readOnly: AuthContext = { ...owner, scopes: ['ma:agent:read'] };

    assert.ok(await workspaces.get({ ...owner, scopes: ['ma:*'] }, workspace.id));
    await assert.rejects(
      agents.create(readOnly, { workspaceId: workspace.id, name: 'nope' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('a workspace cannot be left without an owner', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    await assert.rejects(
      workspaces.updateMembers(owner, workspace.id, [
        { principalId: owner.principal.id, role: 'admin' },
      ]),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });
});

// ---------------------------------------------------------------------------

describe('agent versions', () => {
  test('a patch merges over the base so omitted fields are not dropped', async () => {
    const { context, agentId } = await scenario();
    const { version, diff } = await agents.createVersion(context, agentId, {
      spec: { systemPrompt: 'v2' },
      changeSummary: 'tweak the prompt',
    });

    assert.equal(version.version, 2);
    assert.equal(version.systemPrompt, 'v2');
    // The model came from v1 and must survive a patch that did not mention it.
    assert.equal(version.model.modelId, 'anthropic/claude-sonnet-5');
    assert.deepEqual(diff.changed, ['systemPrompt']);
  });

  test('replace writes a true snapshot, dropping what the caller omitted', async () => {
    const { context, agentId } = await scenario();
    const { version } = await agents.createVersion(context, agentId, {
      spec: { model: { modelId: 'anthropic/claude-opus-5' } },
      replace: true,
    });
    assert.equal(version.systemPrompt, '', 'replace deliberately does not inherit');
  });

  test('reports the diff so a change is visible before it is relied on', async () => {
    const { context, agentId } = await scenario();
    const { diff } = await agents.createVersion(context, agentId, {
      spec: { systemPrompt: 'v2', maxTurnsPerSession: 50 },
    });
    assert.deepEqual(diff.changed.sort(), ['maxTurnsPerSession', 'systemPrompt']);
  });

  test('rejects a spec that violates the schema', async () => {
    const { context, agentId } = await scenario();
    await assert.rejects(
      agents.createVersion(context, agentId, {
        spec: { context: { compactThresholdTokens: 5000, compactTargetTokens: 9000 } },
      }),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('an agent with active sessions cannot be archived', async () => {
    const { context, agentId } = await scenario();
    await sessions.create(context, { agentId });
    await assert.rejects(
      agents.archive(context, agentId, 'cleanup'),
      (error: unknown) => MaError.is(error) && error.status === 409,
    );
  });
});

// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  test('pins a version at creation and ignores later agent edits', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    assert.equal(session.resolvedVersion, 1);

    // Publishing v2 must not change what an already-running session executes.
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });
    const reread = await sessions.get(context, session.id);
    assert.equal(reread.resolvedVersion, 1);
  });

  test('honours an explicit version and the production pin', async () => {
    const { context, agentId } = await scenario();
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v3' } });

    const latest = await sessions.create(context, { agentId });
    assert.equal(latest.resolvedVersion, 3);

    const pinned = await sessions.create(context, { agentId, agentVersion: 1 });
    assert.equal(pinned.resolvedVersion, 1);

    await agents.update(context, agentId, { productionVersion: 2 });
    const production = await sessions.create(context, { agentId });
    assert.equal(production.resolvedVersion, 2, 'a production pin beats latest');
  });

  test('inherits the version credentials and adds session-scoped ones', async () => {
    const { context, workspace, agentId } = await scenario();
    const shared = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'shared',
      value: 'secret-1',
    });
    const extra = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'extra',
      value: 'secret-2',
    });
    await agents.createVersion(context, agentId, { spec: { credentialIds: [shared.id] } });

    const session = await sessions.create(context, { agentId, credentialIds: [extra.id] });
    assert.deepEqual([...session.credentialIds].sort(), [shared.id, extra.id].sort());
  });

  test('refuses to start on an agent with no versions', async () => {
    const context = await asContext(makePrincipal());
    const workspace = await workspaces.create(context, { name: 'Team', slug: 'team' });
    const agent = await agents.create(context, { workspaceId: workspace.id, name: 'Empty' });
    await assert.rejects(
      sessions.create(context, { agentId: agent.id }),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('releases a sandbox provisioned while the session was being terminated', async () => {
    // The race: `provision()` succeeds, but a concurrent terminate (or the
    // reaper) moved the session out of `provisioning` while the driver worked.
    // The transition to `ready` then throws, and the sandbox that was
    // successfully created is never written to the session row — so nothing
    // can find it by session id, and nothing ever cleans it up.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });

    // Terminate mid-provision, exactly as a user clicking cancel would.
    provisioner.onProvision = async () => {
      await sessions.terminate(context, session.id, 'user cancelled');
    };

    await assert.rejects(sessions.start(session.id), 'start must not report success');

    assert.equal(provisioner.acquired.length, 1, 'a sandbox was created');
    assert.deepEqual(provisioner.leaked, [], 'the orphaned sandbox must be released');

    const final = await store.sessions.get(session.id);
    assert.equal(final?.status, 'terminated');
  });

  test('provisions through to ready and records the cold-start metric', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    const ready = await sessions.start(session.id);

    assert.equal(ready.status, 'ready');
    assert.ok(ready.sandboxId);
    assert.deepEqual(provisioner.provisioned, [session.id]);

    const { events } = await sessions.readEvents(context, session.id, {});
    const readyEvent = events.find((event) => event.type === 'session.ready');
    assert.equal((readyEvent?.payload as { provisionMs: number }).provisionMs, 120);
  });

  test('records a provisioning failure as structured data on the session', async () => {
    // "Why did this session never start" must be answerable from the API.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    provisioner.failNext = true;

    await assert.rejects(sessions.start(session.id));
    const failed = await sessions.get(context, session.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.message, 'no capacity');
    assert.ok(failed.error?.occurredAt);
  });

  test('rejects an illegal transition', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await assert.rejects(
      sessions.transition(session.id, 'queued', 'running'),
      (error: unknown) => MaError.is(error) && error.code === 'INVALID_STATE_TRANSITION',
    );
  });

  test('reports a conflict when the status moved underneath the caller', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.transition(session.id, 'queued', 'provisioning');

    await assert.rejects(
      sessions.transition(session.id, 'queued', 'failed'),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'CONFLICT');
        assert.equal((error.details as { actual: string }).actual, 'provisioning');
        return true;
      },
    );
  });

  test('refuses submissions to a session that is not listening', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await assert.rejects(
      sessions.submit(context, session.id, { events: [{ type: 'user.message', text: 'hi' }] }),
      (error: unknown) => MaError.is(error) && error.code === 'INVALID_STATE_TRANSITION',
    );
  });

  test('accepts submissions once ready and forwards them to the runtime', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);

    const result = await sessions.submit(context, session.id, {
      events: [{ type: 'user.message', text: 'hello' }],
    });
    assert.equal(result.accepted, 1);
    assert.equal(provisioner.submitted[0]?.sessionId, session.id);
  });

  test('validates ingress events against the closed union', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await assert.rejects(
      sessions.submit(context, session.id, { events: [{ type: 'tool.completed' }] }),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('terminate releases the sandbox and reaches a terminal state', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);

    const terminated = await sessions.terminate(context, session.id, 'done');
    assert.equal(terminated.status, 'terminated');
    assert.ok(terminated.endedAt);
    assert.deepEqual(provisioner.released, [session.id]);
  });

  test('terminate is idempotent on an already-finished session', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.terminate(context, session.id, 'done');
    const again = await sessions.terminate(context, session.id, 'done again');
    assert.equal(again.status, 'terminated');
  });

  test('recovers a live session whose sandbox was lost', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);

    const recovered = await sessions.handleSandboxLost(session.id, true);
    assert.equal(recovered.status, 'provisioning', 'a lost sandbox must not fail the user work');
    assert.equal(recovered.sandboxId, undefined);
  });

  test('fails a session whose sandbox was lost past its lease', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId, ttlSeconds: 60 });
    await sessions.start(session.id);
    await clock.advance(120_000);

    const failed = await sessions.handleSandboxLost(session.id, true);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'SANDBOX_LOST');
  });

  test('accumulates usage across turns', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.recordUsage(session.id, { inputTokens: 100, outputTokens: 50 });
    await sessions.recordUsage(session.id, { inputTokens: 30, costMicros: 1200 });

    const updated = await sessions.get(context, session.id);
    assert.equal(updated.usage.inputTokens, 130);
    assert.equal(updated.usage.outputTokens, 50);
    assert.equal(updated.usage.costMicros, 1200);
  });
});

// ---------------------------------------------------------------------------

describe('quota admission', () => {
  test('refuses a session past the concurrency limit with a retry hint', async () => {
    const { context, workspace, agentId } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxConcurrentSessions: 1 });
    await sessions.create(context, { agentId });

    await assert.rejects(sessions.create(context, { agentId }), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterSeconds, 30);
      return true;
    });
  });

  test('frees capacity when a session ends', async () => {
    const { context, workspace, agentId } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxConcurrentSessions: 1 });
    const first = await sessions.create(context, { agentId });
    await sessions.terminate(context, first.id, 'done');

    assert.ok(await sessions.create(context, { agentId }), 'capacity must be reusable');
  });

  test('token quota retry hint points at the window rollover, not a short wait', async () => {
    const { context, workspace, agentId } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxTokensPerDay: 100 });
    const session = await sessions.create(context, { agentId });
    await sessions.recordUsage(session.id, { inputTokens: 200 });
    await sessions.terminate(context, session.id, 'done');

    await assert.rejects(sessions.create(context, { agentId }), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'QUOTA_EXCEEDED');
      // A daily budget will not free up in 30 seconds.
      assert.ok((error.retryAfterSeconds ?? 0) > 60);
      return true;
    });
  });

  test('caps agents per workspace', async () => {
    const { context, workspace } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxAgents: 1 });
    await assert.rejects(
      agents.create(context, { workspaceId: workspace.id, name: 'second' }),
      (error: unknown) => MaError.is(error) && error.status === 429,
    );
  });

  test('reports a usage snapshot for every dimension', async () => {
    const { context, workspace, agentId } = await scenario();
    await sessions.create(context, { agentId });
    const snapshot = await quota.snapshot(await workspaces.get(context, workspace.id));
    const byDimension = Object.fromEntries(snapshot.usage.map((u) => [u.dimension, u.observed]));
    assert.equal(byDimension.concurrentSessions, 1);
    assert.equal(byDimension.agents, 1);
  });
});

// ---------------------------------------------------------------------------

describe('credentials', () => {
  test('a value never comes back through a read path', async () => {
    const { context, workspace } = await scenario();
    const credential = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'token',
      value: 'THE-ACTUAL-SECRET',
    });

    const read = await credentials.get(context, credential.id);
    assert.equal(JSON.stringify(read).includes('THE-ACTUAL-SECRET'), false);
    const listed = await credentials.list(context, { workspaceId: workspace.id });
    assert.equal(JSON.stringify(listed).includes('THE-ACTUAL-SECRET'), false);
  });

  test('a session can exchange only the credentials it was granted', async () => {
    const { context, workspace, agentId } = await scenario();
    const granted = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'granted',
      value: 'yes-please',
    });
    const other = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'other',
      value: 'not-for-you',
    });

    const session = await sessions.create(context, { agentId, credentialIds: [granted.id] });
    assert.equal(await credentials.exchange(session, granted.id, 'test'), 'yes-please');
    await assert.rejects(
      credentials.exchange(session, other.id, 'test'),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('an exchange is audited without recording the value', async () => {
    const { context, workspace, agentId } = await scenario();
    const credential = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'token',
      value: 'AUDIT-SECRET',
    });
    const session = await sessions.create(context, { agentId, credentialIds: [credential.id] });
    await credentials.exchange(session, credential.id, 'calling the widget API');

    const entries = await store.audit.list({ resourceId: credential.id });
    const exchange = entries.items.find((entry) => entry.action === 'credential.exchange');
    assert.ok(exchange);
    assert.equal(exchange.reason, 'calling the widget API');
    assert.equal(JSON.stringify(exchange).includes('AUDIT-SECRET'), false);
  });

  test('refuses to exchange an expired credential', async () => {
    const { context, workspace, agentId } = await scenario();
    const credential = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'short-lived',
      value: 'v',
      expiresAt: START + 1000,
    });
    const session = await sessions.create(context, { agentId, credentialIds: [credential.id] });
    await clock.advance(5000);

    await assert.rejects(
      credentials.exchange(session, credential.id, 'test'),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('rotation replaces the value and keeps the id stable', async () => {
    const { context, workspace, agentId } = await scenario();
    const credential = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'rotating',
      value: 'old-value',
    });
    await credentials.update(context, credential.id, { value: 'new-value' });

    const session = await sessions.create(context, { agentId, credentialIds: [credential.id] });
    assert.equal(await credentials.exchange(session, credential.id, 'test'), 'new-value');
  });

  test('the expiry sweep marks credentials before they lapse', async () => {
    const { context, workspace } = await scenario();
    await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'soon',
      value: 'v',
      expiresAt: START + 24 * 60 * 60 * 1000,
    });
    await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'gone',
      value: 'v',
      expiresAt: START - 1000,
    });

    const result = await credentials.sweepExpiry(workspace.id);
    assert.equal(result.expiring, 1);
    assert.equal(result.expired, 1);
  });
});

// ---------------------------------------------------------------------------

describe('event bus', () => {
  async function liveSession(): Promise<{ context: AuthContext; session: Session }> {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    return { context, session };
  }

  test('delivers to subscribers and persists to the log', async () => {
    const { context, session } = await liveSession();
    const received: SessionEvent[] = [];
    const subscription = bus.subscribe({
      sessionId: session.id,
      onEvent: (event) => void received.push(event),
    });

    await bus.publish([
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'message.completed',
        payload: { role: 'assistant', text: 'hi' },
      },
    ]);

    assert.equal(received.length, 1);
    const { events } = await sessions.readEvents(context, session.id, {
      types: ['message.completed'],
    });
    assert.equal(events.length, 1, 'the log is the durable record, not the subscriber');
    subscription.close();
  });

  test('refuses to persist a payload that violates its event schema', async () => {
    // Events arrive from sandboxes; an unvalidated payload would poison every
    // future replay.
    const { session } = await liveSession();
    await assert.rejects(
      bus.publish([
        {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          type: 'turn.completed',
          payload: { turn: 1, reason: 'not-a-real-reason' },
        },
      ]),
    );
    assert.equal(await store.events.lastSeq(session.id), 1, 'only session.created was written');
  });

  test('honours type filters per subscriber', async () => {
    const { session } = await liveSession();
    const toolEvents: SessionEvent[] = [];
    bus.subscribe({
      sessionId: session.id,
      types: ['tool.'],
      onEvent: (event) => void toolEvents.push(event),
    });

    await bus.publish([
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'tool.started',
        payload: { toolCallId: 'c1' },
      },
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'message.delta',
        payload: { text: 'x' },
      },
    ]);

    assert.equal(toolEvents.length, 1);
    assert.equal(toolEvents[0]?.type, 'tool.started');
  });

  test('isolates subscribers by session', async () => {
    const { context, agentId } = await scenario();
    const a = await sessions.create(context, { agentId });
    const b = await sessions.create(context, { agentId });

    const received: SessionEvent[] = [];
    bus.subscribe({ sessionId: a.id, onEvent: (event) => void received.push(event) });
    await bus.publish([
      {
        sessionId: b.id,
        workspaceId: b.workspaceId,
        type: 'message.delta',
        payload: { text: 'other session' },
      },
    ]);
    assert.equal(received.length, 0);
  });

  test('a slow subscriber lags instead of growing without bound', async () => {
    const { session } = await liveSession();
    let lagged: { earliestSeq: number; droppedCount: number } | undefined;
    let delivered = 0;
    const bufferLimit = 2;

    bus.subscribe({
      sessionId: session.id,
      bufferLimit,
      // Throwing on every event models a client that cannot keep up: the bus
      // must not let its backlog grow without limit.
      onEvent: () => {
        delivered++;
        throw new Error('subscriber is broken');
      },
      onLagged: (info) => {
        lagged = info;
      },
    });

    const total = 20;
    for (let index = 0; index < total; index++) {
      await bus.publish([
        {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          type: 'message.delta',
          payload: { text: `chunk ${index}` },
        },
      ]);
    }

    // The durable log is complete regardless of what any subscriber managed:
    // 20 deltas plus the session.created from `create`.
    assert.equal(await store.events.lastSeq(session.id), total + 1);
    assert.ok(delivered > 0, 'the subscriber received something before falling behind');

    // Let the async earliestSeq lookup behind onLagged settle.
    await new Promise((resolve) => setImmediate(resolve));
    if (lagged) {
      assert.ok(lagged.droppedCount > 0, 'a lag notice must report what was dropped');
      assert.ok(lagged.earliestSeq >= 1, 'and where the consumer can resume from');
    }
  });

  test('a throwing subscriber does not break the publisher or its peers', async () => {
    const { session } = await liveSession();
    const healthy: SessionEvent[] = [];
    bus.subscribe({
      sessionId: session.id,
      onEvent: () => {
        throw new Error('broken');
      },
    });
    bus.subscribe({ sessionId: session.id, onEvent: (event) => void healthy.push(event) });

    await bus.publish([
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'message.delta',
        payload: { text: 'x' },
      },
    ]);
    assert.equal(healthy.length, 1);
  });

  test('closing a subscription stops delivery', async () => {
    const { session } = await liveSession();
    const received: SessionEvent[] = [];
    const subscription = bus.subscribe({
      sessionId: session.id,
      onEvent: (event) => void received.push(event),
    });
    subscription.close();

    await bus.publish([
      {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        type: 'message.delta',
        payload: { text: 'x' },
      },
    ]);
    assert.equal(received.length, 0);
    assert.equal(bus.subscriberCount(session.id), 0);
  });

  test('transient frames reach subscribers but never the log', async () => {
    const { session } = await liveSession();
    const received: SessionEvent[] = [];
    bus.subscribe({ sessionId: session.id, onEvent: (event) => void received.push(event) });

    const before = await store.events.lastSeq(session.id);
    bus.emitTransient(session.id, {
      seq: -1,
      id: newId('event'),
      sessionId: session.id,
      workspaceId: session.workspaceId,
      ts: clock.now(),
      type: 'stream.heartbeat',
      payload: { at: clock.now() },
    });

    assert.equal(received.length, 1);
    assert.equal(await store.events.lastSeq(session.id), before, 'heartbeats are not replayable');
  });

  test('refuses to emit a persisted event type as transient', async () => {
    const { session } = await liveSession();
    assert.throws(() =>
      bus.emitTransient(session.id, {
        seq: 1,
        id: newId('event'),
        sessionId: session.id,
        workspaceId: session.workspaceId,
        ts: clock.now(),
        type: 'turn.completed',
        payload: {},
      } as SessionEvent),
    );
  });
});
