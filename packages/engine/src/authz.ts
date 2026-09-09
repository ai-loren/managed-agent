/**
 * Authorization.
 *
 * Every access decision goes through `authorize`. Scattering `if (role ===
 * 'admin')` through services is how a platform ends up with one endpoint that
 * forgot the check — so services state *what* they are doing and this module
 * decides whether it is allowed.
 *
 * The model is deliberately small: a principal holds a role in a workspace, and
 * each action names the minimum role that may perform it. No per-resource ACLs,
 * no inheritance graph. When something genuinely needs finer grain (a connector
 * owner, a private credential) it is expressed as an explicit ownership rule
 * below rather than by growing the role model.
 */

import { permissionDenied, unauthenticated, type Logger } from '@ma/core';
import type { Principal, Workspace, WorkspaceRole } from '@ma/contracts';

/** Ordered least- to most-privileged; comparisons rely on the index. */
export const ROLE_ORDER: readonly WorkspaceRole[] = [
  'viewer',
  'operator',
  'developer',
  'admin',
  'owner',
];

function rank(role: WorkspaceRole): number {
  return ROLE_ORDER.indexOf(role);
}

/**
 * The closed set of authorizable actions.
 *
 * Naming is `resource.verb`. Read verbs are separated from write verbs so a
 * viewer can be given genuine read access without any write reaching them by
 * accident.
 */
export const ACTIONS = {
  // Workspace
  'workspace.read': 'viewer',
  'workspace.update': 'admin',
  'workspace.archive': 'owner',
  'workspace.delete': 'owner',
  'workspace.members.update': 'admin',
  'workspace.quota.update': 'owner',

  // Agent
  'agent.read': 'viewer',
  'agent.create': 'developer',
  'agent.update': 'developer',
  'agent.archive': 'developer',
  'agent.delete': 'admin',
  'agent.version.create': 'developer',
  'agent.version.read': 'viewer',

  // Session — `operator` can run agents without being able to change them,
  // which is the common case for on-call and for automation principals.
  'session.read': 'viewer',
  'session.create': 'operator',
  'session.send': 'operator',
  'session.interrupt': 'operator',
  'session.terminate': 'operator',
  'session.delete': 'admin',

  // Credential — write-only by design; there is deliberately no `.reveal`.
  'credential.read': 'developer',
  'credential.create': 'developer',
  'credential.update': 'developer',
  'credential.delete': 'admin',

  // Connector
  'connector.read': 'viewer',
  'connector.create': 'developer',
  'connector.update': 'developer',
  'connector.activate': 'admin',
  'connector.delete': 'admin',
  'connector.receipt.read': 'operator',
  'connector.receipt.retry': 'operator',

  // Dataset
  'dataset.read': 'viewer',
  'dataset.create': 'developer',
  'dataset.update': 'developer',
  'dataset.delete': 'admin',
  'dataset.document.upload': 'developer',

  // Sandbox
  'sandbox.read': 'operator',
  'sandbox.release': 'admin',

  // Audit
  // Listing tells an operator what an agent produced; downloading hands them
  // content the agent chose. Different powers, so different actions — and the
  // download is audited, being the only path by which agent-authored bytes
  // reach a person.
  'artifact.read': 'viewer',
  'artifact.download': 'operator',
  'artifact.delete': 'developer',

  'memory.create': 'developer',
  'memory.read': 'viewer',
  'memory.update': 'developer',
  'memory.delete': 'developer',
  // Its own action, at a higher bar than editing. Promotion is the one
  // operation that moves agent-authored text into a system prompt, so a
  // developer changing a memory's wording must not promote it as a side effect.
  'memory.promote': 'admin',

  // Agent templates — a reusable, parameterised blueprint. Reading and
  // instantiating the catalogue is a viewer/developer affair (instantiating
  // produces an agent, so it sits at the same bar as `agent.create`); authoring
  // a workspace template is a developer's, and only an admin may remove one.
  'template.read': 'viewer',
  'template.create': 'developer',
  'template.update': 'developer',
  'template.delete': 'admin',
  'template.instantiate': 'developer',

  'audit.read': 'admin',
} as const satisfies Record<string, WorkspaceRole>;

export type Action = keyof typeof ACTIONS;

/** Who is asking. */
export interface AuthContext {
  principal: Principal;
  /** Scopes from the API key, when authentication came from one. */
  scopes?: readonly string[];
  requestId?: string;
  sourceIp?: string;
}

export interface AuthorizeOptions {
  /** For ownership rules: the principal that owns the target resource. */
  ownerPrincipalId?: string;
  /** Identifies the resource in the denial message and the audit entry. */
  resourceId?: string;
}

export interface Authorizer {
  /** The principal's role in a workspace, or `undefined` if not a member. */
  roleIn(principal: Principal, workspace: Workspace): WorkspaceRole | undefined;
  /** True when the action is permitted. */
  can(context: AuthContext, workspace: Workspace, action: Action, options?: AuthorizeOptions): boolean;
  /** Throw `PERMISSION_DENIED` unless the action is permitted. */
  require(context: AuthContext, workspace: Workspace, action: Action, options?: AuthorizeOptions): void;
}

export class RoleAuthorizer implements Authorizer {
  readonly #logger: Logger | undefined;

  constructor(logger?: Logger) {
    this.#logger = logger;
  }

  roleIn(principal: Principal, workspace: Workspace): WorkspaceRole | undefined {
    // Platform admins act as workspace owners everywhere. This is the one
    // global escape hatch, and it is audited like any other decision.
    if (principal.isAdmin) return 'owner';
    return workspace.members.find((member) => member.principalId === principal.id)?.role;
  }

  can(context: AuthContext, workspace: Workspace, action: Action, options: AuthorizeOptions = {}): boolean {
    const { principal } = context;
    if (principal.disabled) return false;

    // An API key may hold fewer scopes than its principal's role allows. The
    // effective permission is the intersection, so narrowing a key's scopes
    // genuinely narrows it rather than being advisory.
    if (context.scopes && !scopeAllows(context.scopes, action)) return false;

    const role = this.roleIn(principal, workspace);
    if (!role) return false;

    // Ownership can only *grant* beyond the role floor, never restrict below
    // it: a connector's owner may manage it even as a plain developer.
    if (options.ownerPrincipalId && options.ownerPrincipalId === principal.id) {
      if (rank(role) >= rank('developer')) return true;
    }

    return rank(role) >= rank(ACTIONS[action]);
  }

  require(
    context: AuthContext,
    workspace: Workspace,
    action: Action,
    options: AuthorizeOptions = {},
  ): void {
    if (this.can(context, workspace, action, options)) return;

    this.#logger?.warn('authorization denied', {
      principalId: context.principal.id,
      workspaceId: workspace.id,
      action,
      resourceId: options.resourceId,
      requestId: context.requestId,
    });
    throw permissionDenied(action, options.resourceId ?? workspace.id);
  }
}

/**
 * Scope matching. `ma:*` grants everything; `ma:agent:*` grants every agent
 * action; `ma:agent.read` grants exactly one. Read actions are also implied by
 * a matching `:write` scope, since a writer that cannot read its own work is
 * not a useful grant.
 */
function scopeAllows(scopes: readonly string[], action: Action): boolean {
  if (scopes.includes('ma:*')) return true;
  if (scopes.includes(`ma:${action}`)) return true;

  const resource = action.split('.')[0];
  if (!resource) return false;
  if (scopes.includes(`ma:${resource}:*`)) return true;

  const isRead = action.endsWith('.read');
  if (isRead && scopes.includes(`ma:${resource}:write`)) return true;
  if (isRead && scopes.includes(`ma:${resource}:read`)) return true;
  if (!isRead && scopes.includes(`ma:${resource}:write`)) return true;

  return false;
}

/** Reject an unauthenticated or disabled principal before anything else runs. */
export function requireActivePrincipal(context: AuthContext | undefined): AuthContext {
  if (!context) throw unauthenticated();
  if (context.principal.disabled) throw unauthenticated('This principal is disabled');
  return context;
}
