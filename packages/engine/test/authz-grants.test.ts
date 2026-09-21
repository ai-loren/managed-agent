/**
 * Resource-scoped grant authorization tests.
 *
 * These exercise the authorizer's grant logic directly and purely: a grant
 * raises the effective role for one resource, never lowers it, never leaks to
 * another resource, and is still gated by API-key scopes. The properties that
 * must hold no matter how the grant was stored are asserted here at the decision
 * point; the store/service/route wiring is covered by the engine and regression
 * suites.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { newId } from '@ma/core';
import type { Principal, Workspace, WorkspaceRole } from '@ma/contracts';

import { RoleAuthorizer, type AuthContext } from '../src/index.ts';

const authz = new RoleAuthorizer();

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: newId('principal'),
    type: 'user',
    subject: `u-${Math.random().toString(36).slice(2, 8)}`,
    displayName: '',
    email: '',
    isAdmin: false,
    disabled: false,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'test',
    ...overrides,
  };
}

function workspace(members: { principalId: string; role: WorkspaceRole }[]): Workspace {
  return {
    id: newId('workspace'),
    name: 'W',
    description: '',
    slug: 'w',
    status: 'active',
    members: members.map((m) => ({ ...m, addedAt: 0 })),
    quota: {
      maxConcurrentSessions: 20,
      maxSandboxes: 20,
      maxTokensPerDay: 1,
      maxCostMicrosPerDay: 0,
      maxStorageMb: 1,
      maxAgents: 1,
      maxKnowledgeChunks: 100_000,
      eventRetentionDays: 90,
    },
    systemPrompt: '',
    version: 1,
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
    createdBy: 'test',
  };
}

describe('resource-scoped grants', () => {
  test('a grant raises access to an action the workspace role could not reach', () => {
    const p = principal();
    const ctx: AuthContext = { principal: p };
    const ws = workspace([{ principalId: p.id, role: 'viewer' }]);

    // A viewer cannot update an agent.
    assert.equal(authz.can(ctx, ws, 'agent.update', { resourceId: 'ag_1' }), false);
    // With a developer grant on that agent, they can.
    assert.equal(
      authz.can(ctx, ws, 'agent.update', { resourceId: 'ag_1', resourceGrantRole: 'developer' }),
      true,
    );
  });

  test('a grant is scoped to the resource it names — it does not leak to siblings', () => {
    const p = principal();
    const ctx: AuthContext = { principal: p };
    const ws = workspace([{ principalId: p.id, role: 'viewer' }]);

    // The caller resolves the grant per resource: agent ag_1 has it, ag_2 does not.
    // (The authorizer is passed the grant only for the resource being checked.)
    assert.equal(
      authz.can(ctx, ws, 'agent.update', { resourceId: 'ag_1', resourceGrantRole: 'developer' }),
      true,
    );
    assert.equal(
      authz.can(ctx, ws, 'agent.update', { resourceId: 'ag_2' }),
      false,
      'no grant passed for ag_2 → still a viewer there',
    );
  });

  test('a grant can only raise, never lower, the effective role', () => {
    const p = principal();
    const ctx: AuthContext = { principal: p };
    const ws = workspace([{ principalId: p.id, role: 'admin' }]);

    // An admin with a lower (viewer) grant on a resource is still an admin there:
    // the effective role is the MAX, so the grant does not demote.
    assert.equal(
      authz.can(ctx, ws, 'agent.delete', { resourceId: 'ag_1', resourceGrantRole: 'viewer' }),
      true,
      'agent.delete needs admin; the admin keeps it despite a viewer grant',
    );
  });

  test('a grant lets a non-member act on just that resource', () => {
    const p = principal();
    const ctx: AuthContext = { principal: p };
    const ws = workspace([]); // not a member at all

    // No workspace role → normally denied everything.
    assert.equal(authz.can(ctx, ws, 'agent.read', { resourceId: 'ag_1' }), false);
    // A grant on one agent lets them read exactly that agent.
    assert.equal(
      authz.can(ctx, ws, 'agent.read', { resourceId: 'ag_1', resourceGrantRole: 'viewer' }),
      true,
    );
    // But nothing workspace-wide, and nothing on another resource.
    assert.equal(authz.can(ctx, ws, 'agent.read'), false);
  });

  test('API-key scopes still bind — a grant raises the role, not the key’s reach', () => {
    const p = principal();
    // A key scoped to read only.
    const ctx: AuthContext = { principal: p, scopes: ['ma:agent:read'] };
    const ws = workspace([{ principalId: p.id, role: 'viewer' }]);

    // Even a developer grant cannot exceed the key's read-only scope for a write.
    assert.equal(
      authz.can(ctx, ws, 'agent.update', { resourceId: 'ag_1', resourceGrantRole: 'developer' }),
      false,
      'the scope intersection is applied before the role check',
    );
    // The grant does work for a read the scope permits.
    assert.equal(
      authz.can(ctx, ws, 'agent.read', { resourceId: 'ag_1', resourceGrantRole: 'developer' }),
      true,
    );
  });

  test('a disabled principal is denied even with a grant', () => {
    const p = principal({ disabled: true });
    const ctx: AuthContext = { principal: p };
    const ws = workspace([{ principalId: p.id, role: 'admin' }]);
    assert.equal(
      authz.can(ctx, ws, 'agent.read', { resourceId: 'ag_1', resourceGrantRole: 'owner' }),
      false,
    );
  });

  test('omitting the grant is exactly the workspace-role decision (regression guard)', () => {
    const p = principal();
    const ctx: AuthContext = { principal: p };
    const ws = workspace([{ principalId: p.id, role: 'developer' }]);
    // Every check with no resourceGrantRole must behave as before the feature.
    assert.equal(authz.can(ctx, ws, 'agent.update', { resourceId: 'ag_1' }), true);
    assert.equal(authz.can(ctx, ws, 'agent.delete', { resourceId: 'ag_1' }), false); // needs admin
    assert.equal(authz.can(ctx, ws, 'agent.read'), true);
  });

  test('the ownership rule is unaffected by grants', () => {
    const p = principal();
    const ctx: AuthContext = { principal: p };
    const ws = workspace([{ principalId: p.id, role: 'developer' }]);
    // Ownership still grants a developer management of their own resource.
    assert.equal(
      authz.can(ctx, ws, 'connector.activate', { resourceId: 'cn_1', ownerPrincipalId: p.id }),
      true,
    );
  });

  test('a :write scope conveys ordinary writes but not the admin-tier verbs', () => {
    // The role model separates admin-tier write verbs from developer-tier ones
    // *within* a resource, on purpose: memory.promote (admin) vs memory.update
    // (developer), with a comment that promotion must not happen as a side
    // effect of an edit. A coarse `ma:<resource>:write` that also conveyed the
    // admin-tier verbs would be identical to `ma:<resource>:*`, so an admin who
    // minted a `:write`-scoped key expecting it to *exclude* promote/activate
    // would silently retain those powers. The role floor is satisfied here
    // (admin), so the scope alone is what must deny.
    const p = principal();
    const ws = workspace([{ principalId: p.id, role: 'admin' }]);
    const writeKey: AuthContext = { principal: p, scopes: ['ma:memory:write'] };

    // Ordinary (developer-tier) write: allowed.
    assert.equal(authz.can(writeKey, ws, 'memory.update', { resourceId: 'mem_1' }), true);
    // Read is implied by write: allowed.
    assert.equal(authz.can(writeKey, ws, 'memory.read', { resourceId: 'mem_1' }), true);
    // Admin-tier verb: denied by the scope, even though the admin role would allow it.
    assert.equal(
      authz.can(writeKey, ws, 'memory.promote', { resourceId: 'mem_1' }),
      false,
      'a :write scope must not convey the admin-tier promote verb',
    );
    // The same for another resource's admin-tier verb.
    assert.equal(
      authz.can(
        { principal: p, scopes: ['ma:connector:write'] },
        ws,
        'connector.activate',
        { resourceId: 'cn_1' },
      ),
      false,
      'a :write scope must not convey the admin-tier activate verb',
    );
  });

  test('the resource wildcard and an explicit action scope still convey an admin-tier verb', () => {
    // `:write` is the tier-limited scope; `:*` and an explicit `ma:<action>` are
    // the two ways to deliberately convey an admin-tier verb, so narrowing
    // `:write` does not make those verbs unreachable — it makes reaching them
    // explicit.
    const p = principal();
    const ws = workspace([{ principalId: p.id, role: 'admin' }]);
    assert.equal(
      authz.can({ principal: p, scopes: ['ma:memory:*'] }, ws, 'memory.promote', {
        resourceId: 'mem_1',
      }),
      true,
      'the resource wildcard conveys every action on the resource',
    );
    assert.equal(
      authz.can({ principal: p, scopes: ['ma:memory.promote'] }, ws, 'memory.promote', {
        resourceId: 'mem_1',
      }),
      true,
      'an explicit action scope is the narrow way to convey exactly one admin-tier verb',
    );
  });
});
