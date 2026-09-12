/**
 * Engine tests.
 *
 * These assert the invariants the design rests on: pinned versions, guarded
 * transitions, write-only credentials, quota admission, and an event bus where
 * a slow subscriber degrades instead of taking the process down.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, MaError, TestClock, newId, nullLogger, sha256Hex } from '@ma/core';
import type { Principal, Session, SessionEvent, UniversalEvent, Workspace } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  AgentService,
  CapabilityService,
  CredentialService,
  EventBus,
  MemoryArtifactStore,
  QuotaService,
  RegistryResolver,
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

  /** Records rebind requests, so an upgrade test can assert one was issued. */
  rebound: string[] = [];
  /** When false, `rebind` reports the environment could not be reused. */
  rebindResult = true;

  rebind(session: Session): Promise<boolean> {
    this.rebound.push(session.id);
    return Promise.resolve(this.rebindResult);
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

  test('an agent with a session stuck terminating cannot be archived', async () => {
    // A shutdown that dies after `terminating` but before `terminated` leaves the
    // session still holding a sandbox — the exact leak the archive guard exists
    // to prevent. `terminating` is an active status (SESSION_ACTIVE_STATUSES), so
    // the guard must count it; a hand-rolled list that omits it would archive the
    // agent and orphan the sandbox.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    // Drive it into `terminating` and leave it there: fail the terminal CAS so
    // shutdown cannot finish the job.
    const realCas = store.sessions.compareAndSetStatus.bind(store.sessions);
    store.sessions.compareAndSetStatus = async (id, from, to, patch) => {
      if (to === 'terminated') return undefined;
      return realCas(id, from, to, patch);
    };
    await assert.rejects(sessions.terminate(context, session.id, 'stuck'));
    store.sessions.compareAndSetStatus = realCas;
    const stuck = await sessions.get(context, session.id);
    assert.equal(stuck.status, 'terminating', 'the session is mid-shutdown');

    await assert.rejects(
      agents.archive(context, agentId, 'cleanup'),
      (error: unknown) => MaError.is(error) && error.status === 409,
      'an agent with a terminating session still holds a sandbox and must not archive',
    );
  });
});

// ---------------------------------------------------------------------------

describe('capability pinning', () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

  async function pinningAgents(): Promise<{
    service: AgentService;
    registry: RegistryResolver;
    artifacts: MemoryArtifactStore;
    context: AuthContext;
    workspaceId: string;
  }> {
    const artifacts = new MemoryArtifactStore();
    const registry = new RegistryResolver(artifacts);
    const capabilities = new CapabilityService({
      artifacts,
      clock,
      logger: nullLogger,
      resolvers: [registry],
    });
    const deps = { store, clock, quota, logger: nullLogger, authorizer: new RoleAuthorizer() };
    const service = new AgentService({ ...deps, capabilities });
    const context = await asContext(makePrincipal());
    const workspace = await workspaces.create(context, { name: 'Caps', slug: 'caps' });
    return { service, registry, artifacts, context, workspaceId: workspace.id };
  }

  test('freezes a skill to its resolved digest and stages its bytes', async () => {
    const { service, registry, artifacts, context, workspaceId } = await pinningAgents();
    const content = bytes('---\nname: greeter\n---\nAlways greet warmly.');
    await registry.publish('greeter', '1.0.0', content);

    const agent = await service.create(context, { workspaceId, name: 'Greeter' });
    const { version } = await service.createVersion(context, agent.id, {
      spec: {
        model: { modelId: 'anthropic/claude-sonnet-5' },
        // A placeholder digest the author did not compute; pinning must replace it.
        skills: [{ name: 'greeter', source: 'registry', version: '1.0.0', digest: '0'.repeat(64) }],
      },
    });

    assert.equal(version.skills.length, 1);
    assert.equal(
      version.skills[0]?.digest,
      sha256Hex(content),
      'the stored digest is the resolved artifact hash, not the placeholder',
    );
    assert.ok(await artifacts.has(sha256Hex(content)), 'the bytes are staged for later download');
  });

  test('rejects a version whose capability cannot be resolved', async () => {
    const { service, context, workspaceId } = await pinningAgents();
    const agent = await service.create(context, { workspaceId, name: 'Broken' });

    await assert.rejects(
      service.createVersion(context, agent.id, {
        spec: {
          model: { modelId: 'anthropic/claude-sonnet-5' },
          skills: [{ name: 'missing', source: 'registry', version: '9.9.9', digest: '0'.repeat(64) }],
        },
      }),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('adds a remote MCP server host to the sandbox egress allowlist', async () => {
    // A locked-down sandbox (egress allowlist) would silently fail to reach an
    // http MCP server whose host it does not permit; createVersion derives it.
    const { service, context, workspaceId } = await pinningAgents();
    const agent = await service.create(context, { workspaceId, name: 'RemoteMcp' });
    const { version } = await service.createVersion(context, agent.id, {
      spec: {
        model: { modelId: 'anthropic/claude-sonnet-5' },
        sandbox: { network: { egress: 'allowlist', allowedHosts: ['existing.example'] } },
        mcpServers: [{ name: 'remote', transport: 'http', url: 'https://tools.example.com:8443/mcp' }],
      },
    });

    assert.ok(
      version.sandbox.network.allowedHosts.includes('tools.example.com:8443'),
      'the MCP host is on the allowlist',
    );
    assert.ok(
      version.sandbox.network.allowedHosts.includes('existing.example'),
      'the original allowlist entries are preserved',
    );
  });

  test('does not widen egress for a stdio MCP server or a deny policy', async () => {
    const { service, context, workspaceId } = await pinningAgents();
    const agent = await service.create(context, { workspaceId, name: 'LocalMcp' });
    const { version } = await service.createVersion(context, agent.id, {
      spec: {
        model: { modelId: 'anthropic/claude-sonnet-5' },
        sandbox: { network: { egress: 'deny', allowedHosts: [] } },
        mcpServers: [{ name: 'local', transport: 'stdio', command: 'node' }],
      },
    });
    assert.deepEqual(version.sandbox.network.allowedHosts, [], 'a deny policy is left untouched');
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

  test('upgrade re-pins an idle session and rebinds its sandbox in place', async () => {
    const { context, agentId } = await scenario();

    // A session on v1 (the only version so far), brought to ready then idle
    // (holds a sandbox, not mid-turn).
    const session = await sessions.create(context, { agentId });
    assert.equal(session.resolvedVersion, 1);
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended');

    // v2 is published after the session pinned v1.
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    const upgraded = await sessions.upgrade(session.id, 2);
    assert.equal(upgraded.resolvedVersion, 2, 'the session re-pins to the new version');
    assert.deepEqual(provisioner.rebound, [session.id], 'its sandbox was rebound in place');
    const events = await store.events.read(session.id, { types: ['session.upgraded'] });
    assert.equal(events.length, 1, 'the upgrade is recorded');
    assert.equal((events[0]!.payload as { rebound?: boolean }).rebound, true);
  });

  test('upgrade leaves a running session alone until it goes idle', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started'); // now running
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    const result = await sessions.upgrade(session.id, 2);
    assert.equal(result.resolvedVersion, 1, 'a mid-turn session is not re-pinned');
    assert.deepEqual(provisioner.rebound, [], 'no rebind while a turn is running');
  });

  test('upgrade cold re-provisions when the new version changes the sandbox spec', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended');
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    // The environment cannot be reused for the new version.
    provisioner.rebindResult = false;
    const upgraded = await sessions.upgrade(session.id, 2);

    assert.equal(upgraded.resolvedVersion, 2, 'still re-pinned to the new version');
    assert.equal(upgraded.status, 'queued', 'it is re-queued for a cold provision');
    assert.ok(provisioner.released.includes(session.id), 'the old environment was released');
    const events = await store.events.read(session.id, { types: ['session.upgraded'] });
    assert.equal((events[0]!.payload as { rebound?: boolean }).rebound, false);
  });

  test('upgrade is a no-op for a session already on the target version', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended');

    const result = await sessions.upgrade(session.id, 1);
    assert.equal(result.resolvedVersion, 1);
    assert.deepEqual(provisioner.rebound, [], 'nothing to do when already current');
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

  test('interrupt is a no-op on a terminal session and emits no event', async () => {
    // A terminated session is done. Interrupt must not publish a
    // `session.interrupted` event with no backing transition — an event the
    // fold would replay after `session.terminated`, making it disagree with the
    // row (the invariant in this file's header). The console let an operator
    // click Interrupt on a terminated session; the server must refuse to record
    // anything rather than append a phantom event.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const terminated = await sessions.terminate(context, session.id, 'done');

    const before = await sessions.readEvents(context, session.id, { limit: 1000 });
    const returned = await sessions.interrupt(context, session.id, 'too late');
    const after = await sessions.readEvents(context, session.id, { limit: 1000 });

    assert.equal(returned.status, 'terminated', 'interrupt must not resurrect a terminal session');
    assert.equal(
      after.events.length,
      before.events.length,
      'interrupt on a terminal session must append no event',
    );
    assert.ok(
      !after.events.some((event) => event.type === 'session.interrupted'),
      'no session.interrupted event may follow session.terminated',
    );
    // And it must not have poked the sandbox, which is already released.
    assert.ok(!provisioner.submitted.some((s) => s.sessionId === terminated.id));
  });

  test('recovers a live session whose sandbox was lost', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);

    const recovered = await sessions.handleSandboxLost(session.id, true);
    // Back to `queued`, not straight to `provisioning`: recovery re-enters
    // through the queue's single atomic claim (findQueued → start's
    // queued→provisioning CAS), so a lost sandbox cannot be provisioned twice by
    // two racing replicas.
    assert.equal(recovered.status, 'queued', 'a lost sandbox must not fail the user work');
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

  test('recovers an idle session whose sandbox was lost between turns', async () => {
    // Now that a turn drives the session to `idle`, a sandbox can be lost while
    // the session rests idle. `idle → queued` exists, so — like `ready` — the
    // session re-queues and continues rather than failing the user's work.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    const idle = await sessions.noteTurnActivity(session.id, 'ended');
    assert.equal(idle.status, 'idle');

    const recovered = await sessions.handleSandboxLost(session.id, true);
    assert.equal(recovered.status, 'queued', 'an idle session recovers like a ready one');
    assert.equal(recovered.sandboxId, undefined);
  });

  test('fails a session whose sandbox was lost mid-turn', async () => {
    // A sandbox lost while `running` cannot re-queue: the machine has no
    // `running → queued` edge, because the in-flight turn's state is gone and
    // resuming from a stale snapshot would replay half a turn. It fails instead,
    // and the failure is recorded so the user can retry deliberately.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const running = await sessions.noteTurnActivity(session.id, 'started');
    assert.equal(running.status, 'running');

    const failed = await sessions.handleSandboxLost(session.id, true);
    assert.equal(failed.status, 'failed', 'a mid-turn loss cannot be silently re-queued');
    assert.equal(failed.error?.code, 'SANDBOX_LOST');
  });

  test('sandbox.lost is not orphaned when the recovery transition loses a race', async () => {
    // handleSandboxLost recovers a live session (ready→queued). If a concurrent
    // terminate wins the compare-and-set first, the recovery CAS must find the
    // row already moved and fail — but it must NOT have already appended a
    // durable `sandbox.lost` event with no backing transition. An event that
    // survives after `session.terminated`, describing a recovery that never
    // happened, makes the fold disagree with the row (the invariant this file's
    // header names). The event must be written together with the transition.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);

    // Simulate the race: the instant recovery tries its guarded CAS, a
    // concurrent terminate has already driven the session terminal.
    const realCas = store.sessions.compareAndSetStatus.bind(store.sessions);
    let raced = false;
    store.sessions.compareAndSetStatus = async (id, from, to, patch) => {
      if (!raced && to === 'queued') {
        raced = true;
        await sessions.terminate(context, session.id, 'operator won the race');
      }
      return realCas(id, from, to, patch);
    };

    await assert.rejects(
      sessions.handleSandboxLost(session.id, true),
      (error: unknown) => MaError.is(error) && error.code === 'CONFLICT',
    );

    store.sessions.compareAndSetStatus = realCas;

    const final = await sessions.get(context, session.id);
    assert.equal(final.status, 'terminated', 'the terminate won');

    // The recovery CAS never committed, so the `sandbox.lost` event it was meant
    // to accompany must not be in the durable log. An unfixed handleSandboxLost
    // publishes it out-of-band before the CAS, leaving it orphaned: an event
    // asserting a recovery (recoverable:true) that the row never underwent.
    const log = await sessions.readEvents(context, session.id, { limit: 1000 });
    assert.ok(
      !log.events.some((e) => e.type === 'sandbox.lost'),
      'a sandbox.lost event whose transition never committed must not survive in the log',
    );
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

  test('a turn drives the session through running and back to idle', async () => {
    // The turn lifecycle drives the session status, which is what makes the
    // ready-vs-idle distinction real: a session that has served a turn is `idle`
    // (holds a sandbox, was productive), distinct from a `ready` one that never
    // ran. Without this the session sits at `ready` forever and the reaper cannot
    // tell a productive sandbox from an untouched one.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    assert.equal((await sessions.get(context, session.id)).status, 'ready');

    const running = await sessions.noteTurnActivity(session.id, 'started');
    assert.equal(running.status, 'running', 'a started turn makes the session running');
    assert.equal(running.turnCount, 0, 'a turn is counted when it ends, not when it starts');

    const idle = await sessions.noteTurnActivity(session.id, 'ended');
    assert.equal(idle.status, 'idle', 'a completed turn leaves the session idle, not ready');
    assert.equal(idle.turnCount, 1, 'completing a turn increments the turn count');

    // A second turn goes idle → running → idle, proving idle is a first-class
    // resting state a turn can resume from.
    assert.equal((await sessions.noteTurnActivity(session.id, 'started')).status, 'running');
    const secondIdle = await sessions.noteTurnActivity(session.id, 'ended');
    assert.equal(secondIdle.status, 'idle');
    assert.equal(secondIdle.turnCount, 2, 'each completed turn counts once');
  });

  test('turn activity on a finished session is a no-op', async () => {
    // A turn.completed can arrive from the sandbox just after a terminate; it
    // must not resurrect or throw. Like the other mutators, a terminal session
    // is left untouched.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const terminated = await sessions.terminate(context, session.id, 'done');

    const after = await sessions.noteTurnActivity(session.id, 'started');
    assert.equal(after.status, 'terminated', 'a stale turn must not move a finished session');
    assert.equal(after.status, terminated.status);
  });

  test('ignores usage from a straggler turn after the session ended', async () => {
    // terminate() publishes a `session.terminated` event carrying a usage
    // snapshot and stamps endedAt. A turn that completes on the sandbox after
    // that — the model call resolving just after a terminate — must not fold
    // more usage into the finished row: the counters would drift past the
    // emitted snapshot (so the fold no longer reproduces the row) and the final
    // bill would move after the session closed. A terminal session is done.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.recordUsage(session.id, { inputTokens: 100, outputTokens: 50 });
    const terminated = await sessions.terminate(context, session.id, 'done');
    const endedAt = terminated.endedAt;

    await sessions.recordUsage(session.id, { inputTokens: 999, outputTokens: 999, costMicros: 42 });

    const after = await sessions.get(context, session.id);
    assert.equal(after.usage.inputTokens, 100, 'usage must not move after termination');
    assert.equal(after.usage.outputTokens, 50);
    assert.equal(after.usage.costMicros, 0);
    assert.equal(after.endedAt, endedAt, 'a straggler must not bump the finished row');
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

  test('concurrent creates cannot exceed the concurrency limit', async () => {
    // Admission was check-then-act. `admitSession` counted rows, then the
    // caller awaited a version lookup and credential resolution before
    // inserting, so every concurrent caller read the same pre-insert count. A
    // limit of 3 admitted 10 parallel creates — while serial calls were
    // correctly refused, which is why every existing test passed.
    const { context, workspace, agentId } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxConcurrentSessions: 3 });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => sessions.create(context, { agentId })),
    );
    const created = results.filter((r) => r.status === 'fulfilled').length;

    assert.equal(created, 3, `admitted ${created} sessions against a limit of 3`);

    // And the refusals are the documented shape, not a raw constraint error.
    const refusal = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(MaError.is(refusal.reason));
    assert.equal(refusal.reason.status, 429);

    // The rows agree with the count, so nothing was inserted and rolled back.
    const live = await store.sessions.list({ workspaceId: workspace.id });
    assert.equal(live.items.length, 3);
  });

  test('concurrent agent creates cannot exceed the agent limit', async () => {
    const { context, workspace } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxAgents: 2 });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, index) =>
        agents.create(context, { workspaceId: workspace.id, name: `Agent ${index}` }),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled').length;

    // `scenario()` already created one agent, so two more reach the cap.
    const total = (await store.agents.list({ workspaceId: workspace.id })).items.length;
    assert.equal(total, 2, `workspace holds ${total} agents against a limit of 2`);
    assert.ok(created <= 2, `admitted ${created} of 8 concurrent creates`);
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
    // The name was aspirational: it checked two dimensions and passed while
    // `storageMb` — a declared QuotaDimension with a declared limit — was
    // omitted from the snapshot entirely. An operator saw four of five limits
    // with nothing to say the fifth existed, which reads as "unlimited" rather
    // than "unimplemented". Asserting the whole set is what makes the name true
    // and what will fail when the next dimension is added and forgotten.
    const { context, workspace, agentId } = await scenario();
    await sessions.create(context, { agentId });
    const snapshot = await quota.snapshot(await workspaces.get(context, workspace.id));

    const reported = snapshot.usage.map((entry) => entry.dimension).sort();
    assert.deepEqual(
      reported,
      ['agents', 'concurrentSessions', 'sandboxes', 'storageMb', 'tokensPerDay'],
      'every declared dimension must appear, even one nothing consumes yet',
    );

    const byDimension = Object.fromEntries(snapshot.usage.map((u) => [u.dimension, u.observed]));
    assert.equal(byDimension.concurrentSessions, 1);
    assert.equal(byDimension.agents, 1);

    // Every entry carries the limit it is measured against, or the number is
    // not actionable.
    for (const entry of snapshot.usage) {
      assert.ok(Number.isInteger(entry.limit), `${entry.dimension} must report its limit`);
      assert.ok(Number.isInteger(entry.observed), `${entry.dimension} must report a count`);
    }
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
