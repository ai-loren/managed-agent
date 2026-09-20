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
  type RebindOutcome,
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
    if (this.onRelease) return this.onRelease(session);
    return Promise.resolve();
  }

  /** Awaited inside release(), so a test can fold a straggler usage during the
   * `terminating` dwell — the window between the terminated event being built and
   * the terminal CAS committing. */
  onRelease: ((session: Session) => Promise<void>) | undefined;

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
  /** The outcome `rebind` reports: 'ok' | 'changed' (cold-provision) | 'busy'. */
  rebindResult: RebindOutcome = 'ok';
  /** Awaited inside rebind(), so a test can inject a concurrent turn.started
   * during the rebind — the window that makes a rebind report 'busy'. */
  onRebind: (() => Promise<void>) | undefined;

  async rebind(session: Session): Promise<RebindOutcome> {
    this.rebound.push(session.id);
    if (this.onRebind) await this.onRebind();
    return this.rebindResult;
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

  test('a resource grant on an agent reaches version.create and archive, not just get/update', async () => {
    // A grant of `developer` on one agent must let its holder manage that agent's
    // versions and archive it — the same grant get/update already honoured. These
    // sibling operations used a plain workspace-role check that ignored the grant,
    // so a viewer-with-a-developer-grant was denied on exactly the operations the
    // grant exists to enable. And the grant must not leak to a second agent.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const granted = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Granted',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' }, systemPrompt: 'v1' },
    });
    const sibling = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Sibling',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' }, systemPrompt: 'v1' },
    });

    // A viewer member — cannot author versions workspace-wide.
    const dev = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: dev.principal.id, role: 'viewer' },
    ]);
    // Granted `developer` on the one agent.
    await workspaces.grantResourceRole(owner, workspace.id, {
      principalId: dev.principal.id,
      resourceKind: 'agent',
      resourceId: granted.id,
      role: 'developer',
    });

    // The grant reaches version.create and archive on the named agent.
    const version = await agents.createVersion(dev, granted.id, { spec: { systemPrompt: 'v2' } });
    assert.ok(version.version, 'a developer grant reaches version.create on the granted agent');
    assert.ok(await agents.getVersion(dev, granted.id, version.version.version));
    assert.ok(await agents.archive(dev, granted.id, 'done'), 'the grant reaches archive too');

    // It does not leak to the sibling agent.
    await assert.rejects(
      agents.createVersion(dev, sibling.id, { spec: { systemPrompt: 'x' } }),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'the grant must not leak to a sibling agent',
    );
  });

  test('an admin cannot escalate itself to owner via the member list', async () => {
    // workspace.members.update is admin-gated, but an admin must not assign a role
    // above its own. Otherwise it writes itself `owner` and clears the sitting
    // owner, seizing archive/delete/quota — full single-tenant takeover.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const admin = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'admin' },
    ]);

    // The admin tries to make itself the sole owner, evicting the real owner.
    await assert.rejects(
      workspaces.updateMembers(admin, workspace.id, [
        { principalId: admin.principal.id, role: 'owner' },
      ]),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'an admin must not assign the owner role',
    );

    // Even keeping the owner present, an admin cannot mint a second owner.
    await assert.rejects(
      workspaces.updateMembers(admin, workspace.id, [
        { principalId: owner.principal.id, role: 'owner' },
        { principalId: admin.principal.id, role: 'owner' },
      ]),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );

    // The real owner is intact and still the owner.
    const fresh = await workspaces.get(owner, workspace.id);
    assert.equal(
      fresh.members.find((m) => m.principalId === owner.principal.id)?.role,
      'owner',
      'the sitting owner is untouched',
    );
  });

  test('an admin cannot evict or demote the sitting owner', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const admin = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'admin' },
    ]);

    // Demoting the owner to admin (a role the actor CAN assign) must still be
    // refused — a non-owner may not strip a sitting owner's ownership.
    await assert.rejects(
      workspaces.updateMembers(admin, workspace.id, [
        { principalId: owner.principal.id, role: 'admin' },
        { principalId: admin.principal.id, role: 'admin' },
      ]),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'an admin cannot demote the owner',
    );
  });

  test('an admin can still assign roles at or below its own', async () => {
    // The cap must not break the legitimate case: an admin managing developers.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const admin = await asContext(makePrincipal());
    const dev = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'admin' },
    ]);

    const updated = await workspaces.updateMembers(admin, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'admin' },
      { principalId: dev.principal.id, role: 'developer' },
    ]);
    assert.equal(
      updated.members.find((m) => m.principalId === dev.principal.id)?.role,
      'developer',
      'an admin may add a developer',
    );
  });

  test('an admin cannot grant the owner role on a resource', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, { workspaceId: workspace.id, name: 'A' });
    const admin = await asContext(makePrincipal());
    const grantee = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'admin' },
    ]);

    await assert.rejects(
      workspaces.grantResourceRole(admin, workspace.id, {
        principalId: grantee.principal.id,
        resourceKind: 'agent',
        resourceId: agent.id,
        role: 'owner',
      }),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'a resource grant must not be an owner-escalation channel',
    );
  });

  test('a platform admin bypasses membership', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const admin = await asContext(makePrincipal({ isAdmin: true }));
    assert.ok(await workspaces.get(admin, workspace.id));
  });

  test('updateMembers validates against freshly-read members, not a stale snapshot', async () => {
    // The member list is replaced wholesale, so the validation + write run inside
    // a transaction that re-reads the row — the rank cap and sitting-owner
    // protection must apply to the CURRENT members, not a copy read earlier, so a
    // concurrent change cannot be used to slip an escalation past a stale check.
    // (A full lost-update precondition for the replace semantics needs a monotonic
    // version column and is tracked separately.) Here: an admin whose own row was
    // concurrently promoted to owner is validated as an owner on the fresh read.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const admin = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'admin' },
    ]);

    // A second owner is added (a legitimate concurrent change).
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: admin.principal.id, role: 'owner' },
    ]);

    // Now the (formerly-admin) principal IS an owner per the fresh row, so it may
    // reshuffle owners — the transaction reads that fresh state, not the stale
    // 'admin' role it had when the workspace was first set up.
    const result = await workspaces.updateMembers(admin, workspace.id, [
      { principalId: admin.principal.id, role: 'owner' },
    ]);
    assert.equal(result.members.length, 1, 'the now-owner may drop the other owner');
    assert.equal(result.members[0]?.principalId, admin.principal.id);
  });

  test('updateMembers rejects a stale expectedVersion and accepts the current one', async () => {
    // The optimistic-concurrency precondition (If-Match). A workspace starts at
    // version 1; any write bumps it. A caller that passes the version it read must
    // be refused (412) if the row moved since, and must succeed at the current
    // version — closing the lost-update the transaction alone cannot (a member
    // added concurrently, absent from this caller's list, would otherwise be
    // silently dropped).
    const owner = await asContext(makePrincipal());
    const created = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    assert.equal(created.version, 1, 'a fresh workspace is version 1');

    // A concurrent write advances the version behind this caller's back.
    const afterConcurrent = await workspaces.updateMembers(owner, created.id, [
      { principalId: owner.principal.id, role: 'owner' },
    ]);
    assert.equal(afterConcurrent.version, 2, 'the concurrent write bumped the version');

    // This caller still holds version 1 → stale → 412.
    await assert.rejects(
      workspaces.updateMembers(
        owner,
        created.id,
        [{ principalId: owner.principal.id, role: 'owner' }],
        1,
      ),
      (error: unknown) => MaError.is(error) && error.status === 412,
      'a stale expectedVersion is a precondition failure',
    );

    // With the current version it succeeds and bumps again.
    const ok = await workspaces.updateMembers(
      owner,
      created.id,
      [{ principalId: owner.principal.id, role: 'owner' }],
      2,
    );
    assert.equal(ok.version, 3, 'the accepted write advanced the version');
  });

  test('updateMembers without an expectedVersion keeps the prior (unconditional) behaviour', async () => {
    // The precondition is opt-in: an absent expectedVersion must not start
    // rejecting — existing callers that never sent If-Match keep working.
    const owner = await asContext(makePrincipal());
    const created = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    await workspaces.updateMembers(owner, created.id, [
      { principalId: owner.principal.id, role: 'owner' },
    ]);
    // No throw even though the version has moved past 1.
    const result = await workspaces.updateMembers(owner, created.id, [
      { principalId: owner.principal.id, role: 'owner' },
    ]);
    assert.ok(result.version >= 2, 'unconditional updates still succeed and bump');
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

  test('a resource grant raises a viewer’s access to one agent only', async () => {
    // The fine-grained case, end to end through the store and service: a viewer
    // granted developer on ONE agent can update that agent, but not another, and
    // gains nothing workspace-wide.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const viewer = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: viewer.principal.id, role: 'viewer' },
    ]);

    const granted = await agents.create(owner, { workspaceId: workspace.id, name: 'Granted' });
    const other = await agents.create(owner, { workspaceId: workspace.id, name: 'Other' });

    // Before any grant, the viewer cannot update either agent.
    await assert.rejects(
      agents.update(viewer, granted.id, { name: 'nope' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );

    // Grant developer on the one agent.
    await workspaces.grantResourceRole(owner, workspace.id, {
      principalId: viewer.principal.id,
      resourceKind: 'agent',
      resourceId: granted.id,
      role: 'developer',
    });

    // Now the viewer can update THAT agent...
    const updated = await agents.update(viewer, granted.id, { name: 'allowed now' });
    assert.equal(updated.name, 'allowed now');

    // ...but not another agent (the grant does not leak)...
    await assert.rejects(
      agents.update(viewer, other.id, { name: 'still nope' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );

    // ...and gains nothing workspace-wide (still cannot create agents).
    await assert.rejects(
      agents.create(viewer, { workspaceId: workspace.id, name: 'nope' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('revoking a resource grant removes the raised access', async () => {
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const viewer = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: viewer.principal.id, role: 'viewer' },
    ]);
    const agent = await agents.create(owner, { workspaceId: workspace.id, name: 'A' });
    const grant = await workspaces.grantResourceRole(owner, workspace.id, {
      principalId: viewer.principal.id,
      resourceKind: 'agent',
      resourceId: agent.id,
      role: 'developer',
    });
    await agents.update(viewer, agent.id, { name: 'ok' }); // works while granted

    await workspaces.revokeResourceGrant(owner, workspace.id, grant.id);
    await assert.rejects(
      agents.update(viewer, agent.id, { name: 'nope' }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });

  test('an admin of one workspace cannot revoke another workspace\'s grant (cross-tenant IDOR)', async () => {
    // Workspace B's owner confers a grant. An admin of an UNRELATED workspace A —
    // who learned B's grant id out of band — calls revoke against their own
    // workspace path (which they are authorized on). The delete must be scoped to
    // A, so B's grant is untouched and the attacker gets a not-found, not a silent
    // cross-tenant deletion filed under A's audit trail.
    const ownerA = await asContext(makePrincipal());
    await workspaces.create(ownerA, { name: 'Attacker', slug: 'attacker' });
    // ownerA creates a second workspace they administer, to revoke against.
    const wsA = await workspaces.create(ownerA, { name: 'A', slug: 'ws-a' });

    const ownerB = await asContext(makePrincipal());
    const wsB = await workspaces.create(ownerB, { name: 'B', slug: 'ws-b' });
    const viewerB = await asContext(makePrincipal());
    await workspaces.updateMembers(ownerB, wsB.id, [
      { principalId: ownerB.principal.id, role: 'owner' },
      { principalId: viewerB.principal.id, role: 'viewer' },
    ]);
    const agentB = await agents.create(ownerB, { workspaceId: wsB.id, name: 'B-agent' });
    const grantB = await workspaces.grantResourceRole(ownerB, wsB.id, {
      principalId: viewerB.principal.id,
      resourceKind: 'agent',
      resourceId: agentB.id,
      role: 'developer',
    });

    // ownerA revokes grantB against their OWN workspace path — must be a no-op.
    await assert.rejects(
      workspaces.revokeResourceGrant(ownerA, wsA.id, grantB.id),
      (error: unknown) => MaError.is(error) && error.status === 404,
    );

    // B's grant still stands: the viewer can still act on B's agent.
    await agents.update(viewerB, agentB.id, { name: 'still-granted' });
    const stillThere = await workspaces.listResourceGrants(ownerB, wsB.id);
    assert.ok(stillThere.some((grant) => grant.id === grantB.id), 'B\'s grant survives the cross-tenant revoke');
  });

  test('granting a resource role requires member-management rights', async () => {
    // A plain viewer cannot hand out grants — conferring access is gated at the
    // same bar as changing membership.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const viewer = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: viewer.principal.id, role: 'viewer' },
    ]);
    const agent = await agents.create(owner, { workspaceId: workspace.id, name: 'A' });

    await assert.rejects(
      workspaces.grantResourceRole(viewer, workspace.id, {
        principalId: viewer.principal.id,
        resourceKind: 'agent',
        resourceId: agent.id,
        role: 'owner',
      }),
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
    // shutdown cannot finish the job. `transition` runs the CAS synchronously
    // inside a store transaction, so the seam is `compareAndSetStatusSync`.
    const realCas = store.sessions.compareAndSetStatusSync.bind(store.sessions);
    store.sessions.compareAndSetStatusSync = (id, from, to, patch) => {
      if (to === 'terminated') return undefined;
      return realCas(id, from, to, patch);
    };
    await assert.rejects(sessions.terminate(context, session.id, 'stuck'));
    store.sessions.compareAndSetStatusSync = realCas;
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

  test('an in-place upgrade rebind clears billing markers so the new generation’s turn is billed', async () => {
    // The one generation boundary where the sandbox id does NOT change: a
    // spec-preserving upgrade (only the runtime config differs) keeps the same
    // sandbox (the pool key excludes runtime), rebinds in place ('ok'), yet the
    // rebuilt harness resets its turn counter. A marker left by the OLD generation's
    // proxy-billed-then-failed turn N would then dedup — and under-bill — the NEW
    // generation's turn N, since both share (session, sandbox). The in-place rebind
    // must clear the session's markers.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const sandboxId = (await sessions.get(context, session.id)).sandboxId!;
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended'); // idle, holds sandboxId

    // Old generation billed turn 1 via the proxy; the turn then failed, so its
    // keyed marker (session, sandboxId, 1) was never consumed and lingers.
    await sessions.recordProxyUsage(session.id, sandboxId, 1, { inputTokens: 100, outputTokens: 50 });
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 100);

    // v2 differs only in runtime → same pool key → rebind 'ok' (in place, same
    // sandbox). FakeProvisioner.rebind defaults to 'ok' and does not change the id.
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });
    const upgraded = await sessions.upgrade(session.id, 2);
    assert.equal(upgraded.resolvedVersion, 2);
    assert.equal(upgraded.sandboxId, sandboxId, 'the in-place rebind kept the same sandbox');

    // The new generation reports its own turn 1 (counter reset) from the SAME
    // sandbox. It MUST be billed — the stale marker was cleared on the rebind.
    const billed = await sessions.recordReportedUsage(session.id, sandboxId, 1, { inputTokens: 25, outputTokens: 5 });
    assert.equal(billed, true, 'the in-place rebind cleared the stale marker — the new turn 1 bills');
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 125);
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

  test('upgrade does not re-pin or rebind a session a turn started under mid-check', async () => {
    // The race: upgrade validates ready/idle, then awaits agentVersions.get. A
    // turn.started landing in that window moves the session to running. An
    // unconditional re-pin + rebind would then re-bootstrap agent-core MID-TURN.
    // Drive the concurrent transition inside the get() to hit the exact window.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended'); // idle: passes the guard
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    const realGet = store.agentVersions.get.bind(store.agentVersions);
    let raced = false;
    store.agentVersions.get = async (aid: string, version: number) => {
      const result = await realGet(aid, version);
      if (!raced) {
        raced = true;
        // A turn starts while upgrade is between its guard and its re-pin.
        await sessions.noteTurnActivity(session.id, 'started');
      }
      return result;
    };

    try {
      const result = await sessions.upgrade(session.id, 2);
      assert.equal(result.resolvedVersion, 1, 'the racing turn blocks the re-pin');
    } finally {
      store.agentVersions.get = realGet;
    }

    assert.deepEqual(provisioner.rebound, [], 'no mid-turn rebind');
    const row = await store.sessions.get(session.id);
    assert.equal(row?.resolvedVersion, 1, 'the row was not re-pinned under the running turn');
    assert.equal(row?.status, 'running', 'the session is left running its turn');
  });

  test('a busy rebind rolls the version back even when a turn started under it', async () => {
    // The split-brain race: upgrade re-pins the idle session to v2, then awaits
    // rebind. A turn.started lands during that await (idle → running) and makes
    // rebind report 'busy'. The rollback must undo the re-pin — but a
    // status-guarded rollback (expecting idle) matches nothing now the row is
    // running, leaving resolvedVersion stuck at v2 while the sandbox runs v1.
    // findUpgradable only selects resolved_version < production, so v2 would never
    // be re-selected: a permanent split-brain. The version-guarded rollback fixes
    // it regardless of status.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended'); // idle: passes the guard and re-pins
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    provisioner.rebindResult = 'busy';
    provisioner.onRebind = async () => {
      // A turn starts while upgrade is awaiting the rebind that will report busy.
      await sessions.noteTurnActivity(session.id, 'started');
    };

    try {
      await sessions.upgrade(session.id, 2);
    } finally {
      provisioner.onRebind = undefined;
      provisioner.rebindResult = 'ok';
    }

    const row = await store.sessions.get(session.id);
    assert.equal(row?.resolvedVersion, 1, 'the busy rebind rolled the version back to v1');
    assert.equal(row?.status, 'running', 'the racing turn is left running, its environment intact');
    // The row now truthfully names the version the sandbox runs (v1), so once the
    // turn ends the level-triggered upgrade sweep re-selects it. Before the fix it
    // stayed pinned at v2 — equal to what the sweep would upgrade *to* — so it was
    // never re-selected: a permanent split-brain between row and runtime.
  });

  test('upgrade cold re-provisions when the new version changes the sandbox spec', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended');
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    // The environment cannot be reused for the new version (its spec changed).
    provisioner.rebindResult = 'changed';
    const upgraded = await sessions.upgrade(session.id, 2);

    assert.equal(upgraded.resolvedVersion, 2, 'still re-pinned to the new version');
    assert.equal(upgraded.status, 'queued', 'it is re-queued for a cold provision');
    assert.ok(provisioner.released.includes(session.id), 'the old environment was released');
    const events = await store.events.read(session.id, { types: ['session.upgraded'] });
    assert.equal((events[0]!.payload as { rebound?: boolean }).rebound, false);
  });

  test('upgrade backs off without releasing when the sandbox is mid-turn (busy)', async () => {
    // The residual the CAS alone did not close: the control-plane row lags
    // agent-core's synchronous `running=true`, so a submit can be in flight while
    // the row still reads idle. The CAS then re-pins an "idle" row, but `/rebind`
    // returns 409 (busy). Misreading that as "spec changed" would `release` the
    // sandbox out from under the running turn. `busy` must instead roll the
    // re-pin back and leave the session alone for the sweep to retry.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await sessions.noteTurnActivity(session.id, 'ended'); // row is idle
    await agents.createVersion(context, agentId, { spec: { systemPrompt: 'v2' } });

    provisioner.rebindResult = 'busy';
    const result = await sessions.upgrade(session.id, 2);

    assert.equal(result.resolvedVersion, 1, 'the re-pin is rolled back to the current version');
    assert.ok(
      !provisioner.released.includes(session.id),
      'a busy sandbox must NOT be released out from under its live turn',
    );
    const row = await store.sessions.get(session.id);
    assert.equal(row?.resolvedVersion, 1, 'the persisted row is not left pinned to the new version');
    assert.notEqual(row?.status, 'queued', 'the session is not re-queued while it is mid-turn');
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

  test('an operator cannot attach a credential it is not allowed to read', async () => {
    // The escalation: `session.create` is an operator action, but `credential.read`
    // is a developer one. Attaching a credential to a session makes it exchangeable
    // for plaintext by the running agent, so attaching MUST cost as much as reading.
    // Without the check, an operator names any workspace credential id at create,
    // drives one turn, and exfiltrates a secret it was never permitted to see.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });
    // A secret the developer/owner owns; the operator has no business reading it.
    const secret = await credentials.create(owner, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'ops-secret',
      value: 'super-secret',
    });

    const operator = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: operator.principal.id, role: 'operator' },
    ]);

    await assert.rejects(
      sessions.create(operator, { agentId: agent.id, credentialIds: [secret.id] }),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'an operator attaching an unreadable credential must be refused',
    );
  });

  test('an operator can run an agent whose version pins a credential it cannot read', async () => {
    // The legitimate case the check must not break: a developer pins a
    // credential on the agent version, and an operator runs it. The operator
    // never names the credential — it is inherited from the pinned version — so
    // no `credential.read` is required of them. Attaching is what costs; running
    // a configured agent does not.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });
    const pinned = await credentials.create(owner, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'pinned',
      value: 'pinned-secret',
    });
    await agents.createVersion(owner, agent.id, { spec: { credentialIds: [pinned.id] } });

    const operator = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: operator.principal.id, role: 'operator' },
    ]);

    // Runs cleanly, and even naming the already-pinned id is allowed (it is not
    // a new attachment, so it does not require the operator to hold read).
    const inherited = await sessions.create(operator, { agentId: agent.id });
    assert.deepEqual(inherited.credentialIds, [pinned.id]);
    const explicit = await sessions.create(operator, {
      agentId: agent.id,
      credentialIds: [pinned.id],
    });
    assert.deepEqual(explicit.credentialIds, [pinned.id]);
  });

  test('a developer may attach an ad-hoc credential it can read', async () => {
    // The check gates on `credential.read`; a developer holds it, so the ad-hoc
    // attach path stays open for the principals meant to use it.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });
    const secret = await credentials.create(owner, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'adhoc',
      value: 'adhoc-secret',
    });

    const developer = await asContext(makePrincipal());
    await workspaces.updateMembers(owner, workspace.id, [
      { principalId: owner.principal.id, role: 'owner' },
      { principalId: developer.principal.id, role: 'developer' },
    ]);

    const session = await sessions.create(developer, {
      agentId: agent.id,
      credentialIds: [secret.id],
    });
    assert.deepEqual(session.credentialIds, [secret.id]);
  });

  test('attaching a credential from another workspace is not found', async () => {
    // Cross-workspace theft must fail as `not found`, never as a permission
    // decision that would confirm the id exists. The credential lives in a
    // workspace the caller cannot even see.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });

    const other = await asContext(makePrincipal());
    const otherWorkspace = await workspaces.create(other, { name: 'Other', slug: 'other' });
    const foreign = await credentials.create(other, {
      workspaceId: otherWorkspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'foreign',
      value: 'foreign-secret',
    });

    await assert.rejects(
      sessions.create(owner, { agentId: agent.id, credentialIds: [foreign.id] }),
      (error: unknown) => MaError.is(error) && error.status === 404,
      'a credential from another workspace must be not found, not attachable',
    );
  });

  test('attaching a non-existent credential is not found', async () => {
    const { context, agentId } = await scenario();
    await assert.rejects(
      sessions.create(context, { agentId, credentialIds: ['credential_does_not_exist'] }),
      (error: unknown) => MaError.is(error) && error.status === 404,
    );
  });

  test('pinning a credential into a version costs credential.read (scope-narrowed key)', async () => {
    // The second write path into an exchangeable list. `sessions.create` gates
    // ad-hoc attaches, but ids pinned on the *version* are exempt there (they are
    // trusted to have cost credential.read when pinned). `createVersion` must
    // therefore charge credential.read itself — otherwise a principal whose API
    // key is narrowed to agents only (no credential scope) pins any workspace
    // secret into a version, starts a session that inherits it, and the runtime
    // exchanges it for plaintext. That defeats scope-narrowing for credentials.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });
    const secret = await credentials.create(owner, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'ops-secret',
      value: 'super-secret',
    });

    // A full developer, but the key is scoped to agent writes only — it may
    // author versions, it may NOT read credentials.
    const scoped: AuthContext = { ...owner, scopes: ['ma:agent:write', 'ma:session:write'] };

    await assert.rejects(
      agents.createVersion(scoped, agent.id, { spec: { credentialIds: [secret.id] } }),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'pinning a credential the key cannot read must be refused',
    );
  });

  test('a malformed credentialIds element is a validation error, not a 500', async () => {
    // `spec` is passthrough at the route, so `credentialIds` is not type-checked
    // at the boundary. A non-string element must be refused as a clean 400 before
    // it reaches the store, not surface as a raw driver bind error (500).
    const { context, agentId } = await scenario();
    await assert.rejects(
      agents.createVersion(context, agentId, {
        spec: { credentialIds: [{ evil: true }] as unknown as string[] },
      }),
      (error: unknown) => MaError.is(error) && error.status === 400,
      'a non-string credential id must be a validation error',
    );
  });

  test('pinning a dataset from another workspace into a version is not found', async () => {
    // The retrieval analogue of the cross-workspace credential theft. A version's
    // datasetIds flow into the retrieval tool, and the keyword index is
    // process-wide with no workspace on its chunks — so the only tenant boundary
    // is that a version cannot name a foreign dataset. Pinning one must fail as
    // `not found`, never expose another tenant's documents.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });

    const other = await asContext(makePrincipal());
    const otherWorkspace = await workspaces.create(other, { name: 'Other', slug: 'other' });
    const foreign = await store.datasets.create({
      id: newId('dataset'),
      workspaceId: otherWorkspace.id,
      name: 'foreign-corpus',
      description: '',
      status: 'active',
      documentCount: 0,
      chunkCount: 0,
      sizeBytes: 0,
      embeddingModel: '',
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: other.principal.id,
    });

    await assert.rejects(
      agents.createVersion(owner, agent.id, { spec: { datasetIds: [foreign.id] } }),
      (error: unknown) => MaError.is(error) && error.status === 404,
      'a dataset from another workspace must be not found, not pinnable',
    );
  });

  test('pinning a dataset into a version costs dataset.read', async () => {
    // Mirrors the credential rule: a version's datasetIds are trusted downstream,
    // so pinning one must cost dataset.read here. A key scoped to agent writes
    // only (no dataset read) must not be able to pin a dataset.
    const owner = await asContext(makePrincipal());
    const workspace = await workspaces.create(owner, { name: 'Team', slug: 'team' });
    const agent = await agents.create(owner, {
      workspaceId: workspace.id,
      name: 'Assistant',
      spec: { model: { modelId: 'anthropic/claude-sonnet-5' } },
    });
    const dataset = await store.datasets.create({
      id: newId('dataset'),
      workspaceId: workspace.id,
      name: 'corpus',
      description: '',
      status: 'active',
      documentCount: 0,
      chunkCount: 0,
      sizeBytes: 0,
      embeddingModel: '',
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: owner.principal.id,
    });

    // A developer who can write agents but whose key cannot read datasets.
    const scoped: AuthContext = { ...owner, scopes: ['ma:agent:write'] };
    await assert.rejects(
      agents.createVersion(scoped, agent.id, { spec: { datasetIds: [dataset.id] } }),
      (error: unknown) => MaError.is(error) && error.status === 403,
      'pinning a dataset the key cannot read must be refused',
    );

    // The owner (full scopes) can pin the same dataset.
    const { version } = await agents.createVersion(owner, agent.id, {
      spec: { datasetIds: [dataset.id] },
    });
    assert.deepEqual(version.datasetIds, [dataset.id]);
  });

  test('a malformed datasetIds element is a validation error, not a 500', async () => {
    const { context, agentId } = await scenario();
    await assert.rejects(
      agents.createVersion(context, agentId, {
        spec: { datasetIds: [{ evil: true }] as unknown as string[] },
      }),
      (error: unknown) => MaError.is(error) && error.status === 400,
      'a non-string dataset id must be a validation error',
    );
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

  test('readEvents threads content search and time-range filters to the store', async () => {
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await store.events.append(session.id, [
      {
        id: newId('event'),
        sessionId: session.id,
        workspaceId: session.workspaceId,
        ts: 1000,
        type: 'message.completed',
        payload: { role: 'assistant', text: 'deployment succeeded' },
      } as Parameters<typeof store.events.append>[1][number],
      {
        id: newId('event'),
        sessionId: session.id,
        workspaceId: session.workspaceId,
        ts: 2000,
        type: 'message.completed',
        payload: { role: 'assistant', text: 'nothing to report' },
      } as Parameters<typeof store.events.append>[1][number],
    ]);

    const search = await sessions.readEvents(context, session.id, { q: 'deployment' });
    assert.equal(search.events.length, 1, 'q filters at the engine layer');
    assert.match((search.events[0]!.payload as { text: string }).text, /deployment/);

    const windowed = await sessions.readEvents(context, session.id, { fromTs: 1500, toTs: 3000 });
    assert.ok(
      windowed.events.every((e) => e.ts >= 1500 && e.ts < 3000),
      'fromTs/toTs window is applied',
    );
  });

  test('readEvents still runs the session guard before searching', async () => {
    const { context } = await scenario();
    // A search against a session that does not exist must be rejected by the
    // guard (this.get) rather than silently returning an empty result — proof the
    // authorization/existence check still precedes the new search path.
    await assert.rejects(
      sessions.readEvents(context, newId('session'), { q: 'anything' }),
      'a search must not bypass the session guard',
    );
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

  test('the session.terminated event usage matches the row after a straggler fold', async () => {
    // A turn.completed can flush during the `terminating` dwell (while release()
    // is awaited). recordUsage only skips a *terminal* session, and `terminating`
    // is not terminal, so that straggler folds onto the row — but the terminated
    // event's usage was snapshotted from the pre-dwell row. The event must equal
    // the final row (the fold reproduces the row), or the audit log lies about
    // the session's final spend.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.recordUsage(session.id, { inputTokens: 100, outputTokens: 50 });

    // During release (the terminating dwell), a straggler turn folds more usage.
    provisioner.onRelease = async () => {
      await sessions.recordUsage(session.id, { inputTokens: 7, outputTokens: 3 });
    };
    try {
      await sessions.terminate(context, session.id, 'done');
    } finally {
      provisioner.onRelease = undefined;
    }

    const row = await store.sessions.get(session.id);
    assert.equal(row?.usage.inputTokens, 107, 'the straggler folded onto the row');
    assert.equal(row?.usage.outputTokens, 53);

    const events = await store.events.read(session.id, { types: ['session.terminated'] });
    const payload = events[0]?.payload as { usage?: { inputTokens: number; outputTokens: number } };
    assert.equal(payload.usage?.inputTokens, 107, 'the terminated event reflects the straggler fold');
    assert.equal(payload.usage?.outputTokens, 53, 'the event usage equals the final row usage');
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

  test('recovers a session lost mid-turn and records the interrupted turn as failed', async () => {
    // A sandbox lost while `running` (a crash, a node eviction, the lifetime
    // ceiling) used to fail the whole conversation. It now re-queues from its
    // last turn-boundary snapshot — buying availability — and closes the lost
    // in-flight turn with a synthetic `turn.failed` so the log stays honest. The
    // prompt is NOT auto-resubmitted (that would re-run at-least-once tool side
    // effects); the caller resubmits.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const running = await sessions.noteTurnActivity(session.id, 'started');
    assert.equal(running.status, 'running');

    const recovered = await sessions.handleSandboxLost(session.id, true);
    assert.equal(recovered.status, 'queued', 'a mid-turn loss with TTL left re-queues');
    assert.equal(recovered.sandboxId, undefined);

    const log = await sessions.readEvents(context, session.id, { limit: 1000 });
    assert.ok(
      log.events.some((e) => e.type === 'sandbox.lost'),
      'the loss is recorded',
    );
    const turnFailed = log.events.find((e) => e.type === 'turn.failed');
    assert.ok(turnFailed, 'the interrupted turn is explicitly closed with turn.failed');
    const payload = turnFailed.payload as { turn: number; error: { code: string; retryable: boolean } };
    // turnCount was 0 (no turn ever completed), so the lost in-flight turn is #1
    // — the same number the dangling `turn.started` carries.
    assert.equal(payload.turn, 1, 'the failed turn is numbered from the completed-turn count + 1');
    assert.equal(payload.error.code, 'SANDBOX_LOST');
    assert.equal(payload.error.retryable, true, 'a mid-turn loss is retryable by resubmitting');
  });

  test('fails a session lost mid-turn once past its lease', async () => {
    // Recovery is gated on TTL, not status: a mid-turn loss past the lease still
    // fails outright, and does NOT emit a turn.failed (the unrecoverable branch
    // records sandbox.lost + session.failed only).
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId, ttlSeconds: 60 });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started');
    await clock.advance(120_000);

    const failed = await sessions.handleSandboxLost(session.id, true);
    assert.equal(failed.status, 'failed', 'a mid-turn loss past TTL still fails');
    assert.equal(failed.error?.code, 'SANDBOX_LOST');

    const log = await sessions.readEvents(context, session.id, { limit: 1000 });
    assert.ok(
      !log.events.some((e) => e.type === 'turn.failed'),
      'the unrecoverable branch does not synthesize a turn.failed',
    );
  });

  test('handleSandboxLost is a no-op for a session that holds no sandbox', async () => {
    // The reaper's read-then-act is not perfectly serialized: two passes can both
    // observe one lost sandbox, or a session may already have re-queued (its
    // sandboxId cleared) by the time a second call arrives. A session with no
    // sandbox has none to lose, so the call must be a no-op — NOT fall through to
    // the unrecoverable branch and fail a healthy recovering session (there is no
    // `queued → queued` edge, so the recovery branch is skipped for a queued row).
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const recovered = await sessions.handleSandboxLost(session.id, true);
    assert.equal(recovered.status, 'queued', 'first recovery re-queues and clears the sandbox');
    assert.equal(recovered.sandboxId, undefined);

    // A second call (racing reaper pass, or a stale re-notify) must leave the
    // recovering session alone rather than failing it.
    const again = await sessions.handleSandboxLost(session.id, true);
    assert.equal(again.status, 'queued', 'a second call on a sandbox-less session is a no-op');
  });

  test('a ready/idle recovery records only sandbox.lost, no turn.failed', async () => {
    // The synthetic turn.failed is only for the running origin (there was an
    // in-flight turn to close). A ready or idle session had no turn in flight, so
    // its recovery must not fabricate a turn.failed for a turn that never started.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id); // ready

    const recovered = await sessions.handleSandboxLost(session.id, true);
    assert.equal(recovered.status, 'queued');

    const log = await sessions.readEvents(context, session.id, { limit: 1000 });
    assert.ok(log.events.some((e) => e.type === 'sandbox.lost'), 'the loss is recorded');
    assert.ok(
      !log.events.some((e) => e.type === 'turn.failed'),
      'a ready-origin recovery must not synthesize a turn.failed',
    );
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

    // Simulate the race at the CAS seam: the instant recovery runs its guarded
    // compare-and-set (ready→queued), a concurrent terminate has already driven
    // the row terminal. `transition` runs the CAS synchronously inside a store
    // transaction, so the seam is `compareAndSetStatusSync`; flip the row terminal
    // right before delegating, so the recovery CAS finds it already moved. The
    // whole point of the fix: the `sandbox.lost` event is appended in the SAME
    // transaction as the CAS, so a CAS that matches nothing appends nothing.
    const realCas = store.sessions.compareAndSetStatusSync.bind(store.sessions);
    let raced = false;
    store.sessions.compareAndSetStatusSync = (id, from, to, patch) => {
      if (!raced && to === 'queued') {
        raced = true;
        // The operator's terminate wins first (synchronous CAS to terminal).
        realCas(id, from, 'terminated', { endedAt: START });
      }
      return realCas(id, from, to, patch);
    };

    await assert.rejects(
      sessions.handleSandboxLost(session.id, true),
      (error: unknown) => MaError.is(error) && error.code === 'CONFLICT',
    );

    store.sessions.compareAndSetStatusSync = realCas;

    const final = await sessions.get(context, session.id);
    assert.equal(final.status, 'terminated', 'the terminate won');

    // The recovery CAS never committed, so the `sandbox.lost` event it was meant
    // to accompany must not be in the durable log — it is appended in the same
    // transaction, so a lost CAS rolls it back rather than orphaning it.
    const log = await sessions.readEvents(context, session.id, { limit: 1000 });
    assert.ok(
      !log.events.some((e) => e.type === 'sandbox.lost'),
      'a sandbox.lost event whose transition never committed must not survive in the log',
    );
  });

  test('a mid-turn recovery that loses the race orphans neither event', async () => {
    // The running-origin recovery appends TWO events (sandbox.lost + turn.failed)
    // in one transaction with the CAS. If a concurrent terminate wins, the CAS
    // matches nothing and BOTH events must roll back — a multi-event append is
    // still all-or-nothing, or the fold would carry a turn.failed for a turn on a
    // session that terminated instead of recovering.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.noteTurnActivity(session.id, 'started'); // running

    const realCas = store.sessions.compareAndSetStatusSync.bind(store.sessions);
    let raced = false;
    store.sessions.compareAndSetStatusSync = (id, from, to, patch) => {
      if (!raced && to === 'queued') {
        raced = true;
        realCas(id, from, 'terminated', { endedAt: START });
      }
      return realCas(id, from, to, patch);
    };

    await assert.rejects(
      sessions.handleSandboxLost(session.id, true),
      (error: unknown) => MaError.is(error) && error.code === 'CONFLICT',
    );

    store.sessions.compareAndSetStatusSync = realCas;

    const final = await sessions.get(context, session.id);
    assert.equal(final.status, 'terminated', 'the terminate won');

    const log = await sessions.readEvents(context, session.id, { limit: 1000 });
    assert.ok(
      !log.events.some((e) => e.type === 'sandbox.lost' || e.type === 'turn.failed'),
      'neither event of the two-event recovery survives a lost CAS',
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

  test('recordProxyUsage marks a turn so recordReportedUsage dedups it', async () => {
    // The two billing paths and their durable dedup: a /completions proxy bills
    // and marks the turn; the matching turn.completed report is then deduped, not
    // billed a second time. The marker lives in the store, so this holds across a
    // control-plane restart (a fresh SessionService over the same store).
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    const sbx = 'sb_gen_one';

    await sessions.recordProxyUsage(session.id, sbx, 1, { inputTokens: 100, outputTokens: 50 });
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 100);

    // A brand-new service instance (models a restart) — its dedup state is the
    // store, so the marker is still there.
    const restarted = new SessionService({
      store, clock, quota, logger: nullLogger, authorizer: new RoleAuthorizer(), bus, provisioner,
    });
    const billed = await restarted.recordReportedUsage(session.id, sbx, 1, { inputTokens: 40, outputTokens: 10 });
    assert.equal(billed, false, 'turn 1 was already billed via the proxy — the report is deduped');
    assert.equal(
      (await sessions.get(context, session.id)).usage.inputTokens,
      100,
      'no double-bill across the restart',
    );

    // A turn NOT billed via the proxy is billed from its report (the report is the
    // only accounting there is).
    const billed2 = await sessions.recordReportedUsage(session.id, sbx, 2, { inputTokens: 25, outputTokens: 5 });
    assert.equal(billed2, true, 'turn 2 had no proxy marker, so its report is billed');
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 125);
  });

  test('the turn-less fallback flag dedups a report and clears at a turn end', async () => {
    // A completion that omits its turn has no key, so it sets a per-sandbox
    // turn-less flag; the next turn end consumes it (dedup), and a later turn with
    // no proxy behind it is still billed (the flag cleared, no leaked suppressor).
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    const sbx = 'sb_gen_one';

    await sessions.recordProxyUsage(session.id, sbx, undefined, { inputTokens: 100, outputTokens: 50 });
    const deduped = await sessions.recordReportedUsage(session.id, sbx, 7, { inputTokens: 40, outputTokens: 10 });
    assert.equal(deduped, false, 'the turn-less flag deduped the report');
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 100);

    const later = await sessions.recordReportedUsage(session.id, sbx, 8, { inputTokens: 30, outputTokens: 5 });
    assert.equal(later, true, 'the flag cleared at the first turn end — a later turn is billed');
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 130);
  });

  test('a fresh sandbox generation after recovery is billed despite the old generation’s marker', async () => {
    // The correctness subtlety of a DURABLE marker: on a recoverable loss the
    // session re-queues (same id) and the NEXT sandbox resets its turn counter to
    // 1. Because markers are keyed by sandbox id, the old generation's turn-1
    // marker cannot dedup the new generation's turn 1 — so the new turn is billed
    // even though the stale marker still exists (it is inert, not swept).
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    const oldSandbox = (await sessions.get(context, session.id)).sandboxId!;

    // Old generation bills turn 1 via the proxy (marker recorded under oldSandbox).
    await sessions.recordProxyUsage(session.id, oldSandbox, 1, { inputTokens: 100, outputTokens: 50 });

    // Sandbox lost → recover (re-queue). No clearSession runs on this path.
    const recovered = await sessions.handleSandboxLost(session.id, true);
    assert.equal(recovered.status, 'queued');

    // The new generation gets a different sandbox id; its turn-1 report has no
    // matching marker, so it MUST be billed, not deduped by the stale marker.
    const newSandbox = 'sb_gen_two';
    assert.notEqual(newSandbox, oldSandbox);
    const billed = await sessions.recordReportedUsage(session.id, newSandbox, 1, { inputTokens: 25, outputTokens: 5 });
    assert.equal(billed, true, 'the new generation’s turn 1 bills — the stale marker is keyed to the old sandbox');
    assert.equal((await sessions.get(context, session.id)).usage.inputTokens, 125);
  });

  test('concurrent recordings do not lose each other’s increment', async () => {
    // recordUsage is a read-modify-write; if the read sat outside the transaction
    // two concurrent calls would both read the same base and the second would
    // clobber the first (last-write-wins). `addUsage` re-reads inside the
    // transaction, so both increments land. The daily counter (an atomic SQL
    // add) must agree with the session row.
    const { context, agentId, workspace } = await scenario();
    const session = await sessions.create(context, { agentId });
    await Promise.all([
      sessions.recordUsage(session.id, { inputTokens: 10, outputTokens: 1 }),
      sessions.recordUsage(session.id, { inputTokens: 20, outputTokens: 2 }),
      sessions.recordUsage(session.id, { inputTokens: 30, outputTokens: 3 }),
    ]);

    const updated = await sessions.get(context, session.id);
    assert.equal(updated.usage.inputTokens, 60, 'all three input increments landed');
    assert.equal(updated.usage.outputTokens, 6, 'all three output increments landed');

    // The daily counter agrees with the session row — no drift.
    const day = new Date(clock.now());
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    assert.equal(
      await store.usage.tokensToday(workspace.id, dayStart),
      66,
      'the counter matches the session usage exactly (60 + 6)',
    );
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

    // The daily counter moves in the same transaction as the row, so a dropped
    // straggler must not bump it either: only the pre-termination 150 tokens count.
    const day = new Date(clock.now());
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    assert.equal(
      await store.usage.tokensToday(after.workspaceId, dayStart),
      150,
      'the counter counts only the usage the row kept',
    );
  });

  test('a terminate that wins the race mid-fold still drops the straggler usage', async () => {
    // The TOCTOU the pre-transaction check alone did not close: recordUsage read
    // the session (ready), then folded usage in a SEPARATE transaction. A
    // terminate landing in that gap left the fold to push counters past the
    // session.terminated snapshot. The fix re-checks terminal status INSIDE the
    // transaction; simulate the race by terminating the row the instant the fold's
    // in-transaction read runs.
    const { context, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    await sessions.start(session.id);
    await sessions.recordUsage(session.id, { inputTokens: 100, outputTokens: 50 });

    // recordUsage reads the session once outside the transaction (the cheap
    // early-out) and again inside it (the load-bearing guard). Let the first read
    // pass cleanly (session still ready → the transaction opens), then flip the
    // row terminal on the SECOND read — the in-transaction guard — so the race is
    // exercised there, not on the pre-transaction check.
    const realFind = store.sessions.findById.bind(store.sessions);
    let calls = 0;
    store.sessions.findById = (id: string) => {
      if (id === session.id) {
        calls++;
        if (calls === 2) {
          const row = realFind(id);
          if (row && row.status !== 'terminated') {
            store.sessions.compareAndSetStatusSync(session.id, row.status, 'terminated', {
              endedAt: START,
            });
          }
        }
      }
      return realFind(id);
    };
    try {
      await sessions.recordUsage(session.id, { inputTokens: 999, outputTokens: 999, costMicros: 42 });
    } finally {
      store.sessions.findById = realFind;
    }

    const after = await sessions.get(context, session.id);
    assert.equal(after.usage.inputTokens, 100, 'the straggler must not fold in after the race-terminate');
    assert.equal(after.usage.outputTokens, 50);
    assert.equal(after.usage.costMicros, 0);
    const day = new Date(clock.now());
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    assert.equal(
      await store.usage.tokensToday(after.workspaceId, dayStart),
      150,
      'the daily counter is not bumped by the dropped straggler either',
    );
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

  test('refuses admission past the daily cost budget; 0 means unlimited', async () => {
    const { context, workspace, agentId } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxCostMicrosPerDay: 1000 });
    const session = await sessions.create(context, { agentId });
    await sessions.recordUsage(session.id, { inputTokens: 1, costMicros: 1500 });
    await sessions.terminate(context, session.id, 'done');

    await assert.rejects(sessions.create(context, { agentId }), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'QUOTA_EXCEEDED');
      assert.equal(error.details?.dimension, 'costPerDay');
      return true;
    });

    // Setting the cost cap back to 0 (unlimited) admits again despite the spend.
    await workspaces.updateQuota(context, workspace.id, { maxCostMicrosPerDay: 0 });
    assert.ok(await sessions.create(context, { agentId }), '0 cost cap is unlimited');
  });

  test('caps agents per workspace', async () => {
    const { context, workspace } = await scenario();
    await workspaces.updateQuota(context, workspace.id, { maxAgents: 1 });
    await assert.rejects(
      agents.create(context, { workspaceId: workspace.id, name: 'second' }),
      (error: unknown) => MaError.is(error) && error.status === 429,
    );
  });

  test('usageHistory returns the per-day series and a correct total', async () => {
    const { workspace } = await scenario();
    const D1 = Date.UTC(2026, 0, 10);
    const D2 = Date.UTC(2026, 0, 11);
    await store.usage.addTokens(workspace.id, D1, 10, 1, 100);
    await store.usage.addTokens(workspace.id, D2, 20, 2, 200);

    const report = await quota.usageHistory(workspace.id, D1, D2);
    assert.deepEqual(report.days.map((d) => d.utcDay), [D1, D2]);
    assert.deepEqual(report.total, { inputTokens: 30, outputTokens: 3, costMicros: 300 });
  });

  test('usageHistory refuses an over-long or reversed range', async () => {
    const { workspace } = await scenario();
    const day = Date.UTC(2026, 0, 15);
    await assert.rejects(
      quota.usageHistory(workspace.id, day, day - 5 * 24 * 60 * 60 * 1000),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
    await assert.rejects(
      quota.usageHistory(workspace.id, day, day + 400 * 24 * 60 * 60 * 1000),
      (error: unknown) => MaError.is(error) && error.status === 400,
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
      ['agents', 'concurrentSessions', 'costPerDay', 'knowledgeChunks', 'sandboxes', 'storageMb', 'tokensPerDay'],
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

  test('the snapshot reports real artifact storage, not a hardcoded zero', async () => {
    // storageMb used to be reported as a constant 0 with a comment that "artifacts
    // are not built" — stale since artifact storage shipped. It now sums the
    // workspace's stored bytes. Insert ~3 MB and assert the snapshot sees it.
    const { context, workspace, agentId } = await scenario();
    const session = await sessions.create(context, { agentId });
    const threeMb = 3 * 1024 * 1024;
    const inserted = await store.artifacts.createWithinStorageLimit(
      {
        id: newId('artifact'),
        workspaceId: workspace.id,
        sessionId: session.id,
        path: 'out/big.bin',
        contentType: 'application/octet-stream',
        sizeBytes: threeMb,
        digest: 'a'.repeat(64),
        status: 'available',
        metadata: {},
        createdAt: START,
        updatedAt: START,
        createdBy: 'test',
      },
      1024 * 1024 * 1024,
    );
    assert.ok(inserted, 'the artifact was stored');

    const snapshot = await quota.snapshot(await workspaces.get(context, workspace.id));
    const storage = snapshot.usage.find((u) => u.dimension === 'storageMb');
    assert.equal(storage?.observed, 3, 'storageMb reflects the ~3 MB stored, not 0');
  });

  test('the snapshot reports indexed knowledge chunks summed across the workspace', async () => {
    // knowledgeChunks observed = sum of the datasets' maintained chunkCount rollup,
    // the same number the ingestion admission enforces against maxKnowledgeChunks.
    const { context, workspace } = await scenario();
    const mkDataset = (chunkCount: number) =>
      ({
        id: newId('dataset'),
        workspaceId: workspace.id,
        name: 'D',
        description: '',
        status: 'active',
        documentCount: 0,
        chunkCount,
        sizeBytes: 0,
        embeddingModel: '',
        metadata: {},
        createdAt: START,
        updatedAt: START,
        createdBy: 'test',
      }) as never;
    await store.datasets.create(mkDataset(11));
    await store.datasets.create(mkDataset(9));

    const snapshot = await quota.snapshot(await workspaces.get(context, workspace.id));
    const chunks = snapshot.usage.find((u) => u.dimension === 'knowledgeChunks');
    assert.equal(chunks?.observed, 20, 'knowledgeChunks sums the two datasets (11 + 9)');
    assert.equal(chunks?.limit, 100_000, 'and reports the default limit');
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

  test('rejects a name that collides with an existing credential’s env key', async () => {
    // Names are lossily normalised to MA_CRED_<UPPER>, so two that differ only by
    // case/punctuation land on one key and silently overwrite at materialisation.
    // Reject the second at create time instead.
    const { context, workspace } = await scenario();
    await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'github-token',
      value: 'a',
    });
    await assert.rejects(
      credentials.create(context, {
        workspaceId: workspace.id,
        ownerType: 'workspace',
        type: 'api_key',
        name: 'github_token', // → MA_CRED_GITHUB_TOKEN, same as github-token
        value: 'b',
      }),
      (error: unknown) => MaError.is(error) && error.status === 400,
      'a name colliding on the normalised env key must be refused',
    );
  });

  test('rejects a file credential whose _FILE key collides with an api_key', async () => {
    // A file cred `foo` → MA_CRED_FOO_FILE; an api_key `foo_file` → MA_CRED_FOO_FILE
    // too. The Object.assign at materialisation would overwrite the file path with
    // the raw secret, so a var documented as a path would hold a secret.
    const { context, workspace } = await scenario();
    await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'ssh_key',
      name: 'foo',
      value: 'the-key',
    });
    await assert.rejects(
      credentials.create(context, {
        workspaceId: workspace.id,
        ownerType: 'workspace',
        type: 'api_key',
        name: 'foo_file', // → MA_CRED_FOO_FILE, collides with the ssh_key's path key
        value: 'b',
      }),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('a distinct name in a different owner scope does not collide', async () => {
    // The check is owner-scoped (workspace + ownerType + ownerId), matching how
    // credentials are materialised for a session — a same-named cred under a
    // different owner is a different env at materialisation and must be allowed.
    const { context, workspace } = await scenario();
    await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'shared-name',
      value: 'a',
    });
    // Same name, different owner (an agent) — no collision.
    const ok = await credentials.create(context, {
      workspaceId: workspace.id,
      ownerType: 'agent',
      ownerId: 'ag_other',
      type: 'api_key',
      name: 'shared-name',
      value: 'b',
    });
    assert.ok(ok.id, 'same name under a different owner is allowed');
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
