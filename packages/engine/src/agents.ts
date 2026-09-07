/**
 * Workspace, agent and agent-version services.
 *
 * Two decisions worth reading the code for:
 *
 *  1. **Version creation takes a base plus a patch.** Versions remain immutable
 *     full snapshots — reproducibility demands it — but a caller supplying only
 *     the fields they changed cannot accidentally drop a capability by omitting
 *     it. The resulting diff is returned so the change is visible *before* it is
 *     relied on.
 *  2. **Version numbers are claimed by compare-and-set.** Two concurrent creates
 *     cannot both take N+1; the loser is told the new base and can retry.
 */

import {
  conflict,
  newId,
  notFound,
  validationError,
  type Clock,
  type Logger,
} from '@ma/core';
import {
  agentVersionSchema,
  parseOrThrow,
  resourceMachine,
  workspaceSchema,
  type Agent,
  type AgentVersion,
  type Workspace,
  type WorkspaceRole,
} from '@ma/contracts';
import type { Page, PageRequest, Store } from '@ma/store';

import { RoleAuthorizer, type AuthContext, type Authorizer } from './authz.ts';
import { QuotaService } from './quota.ts';

export interface ServiceDeps {
  store: Store;
  clock: Clock;
  authorizer?: Authorizer;
  quota?: QuotaService;
  logger?: Logger;
}

/** Shared plumbing: workspace lookup plus the authorization gate. */
export class BaseService {
  protected readonly store: Store;
  protected readonly clock: Clock;
  protected readonly authorizer: Authorizer;
  protected readonly quota: QuotaService;
  protected readonly logger: Logger | undefined;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.authorizer = deps.authorizer ?? new RoleAuthorizer(deps.logger);
    this.quota = deps.quota ?? new QuotaService(deps.store, deps.clock);
    this.logger = deps.logger;
  }

  protected async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.store.workspaces.get(workspaceId);
    if (!workspace) throw notFound('Workspace', workspaceId);
    return workspace;
  }

  /** Audit trail for a decision or a mutation. */
  protected async audit(
    context: AuthContext,
    entry: {
      workspaceId?: string;
      action: string;
      resourceKind: string;
      resourceId: string;
      outcome: 'allowed' | 'denied' | 'error';
      reason?: string;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.store.audit.append({
      id: newId('auditEntry', this.clock.now()),
      ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
      principalId: context.principal.id,
      action: entry.action,
      resourceKind: entry.resourceKind,
      resourceId: entry.resourceId,
      outcome: entry.outcome,
      reason: entry.reason ?? '',
      requestId: context.requestId ?? '',
      sourceIp: context.sourceIp ?? '',
      details: entry.details ?? {},
      at: this.clock.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  description?: string;
  systemPrompt?: string;
  members?: { principalId: string; role: WorkspaceRole }[];
}

export class WorkspaceService extends BaseService {
  /**
   * Create a workspace. The creator is always an owner: a workspace nobody can
   * administer is a support ticket waiting to happen.
   */
  async create(context: AuthContext, input: CreateWorkspaceInput): Promise<Workspace> {
    const now = this.clock.now();
    const members = [
      { principalId: context.principal.id, role: 'owner' as const, addedAt: now },
      ...(input.members ?? [])
        .filter((member) => member.principalId !== context.principal.id)
        .map((member) => ({ ...member, addedAt: now })),
    ];

    const workspace: Workspace = parseOrThrow(workspaceSchema, {
      id: newId('workspace', now),
      name: input.name,
      slug: input.slug,
      description: input.description ?? '',
      status: 'active',
      members,
      quota: {},
      systemPrompt: input.systemPrompt ?? '',
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: context.principal.id,
    });

    const created = await this.store.workspaces.create(workspace);
    await this.audit(context, {
      workspaceId: created.id,
      action: 'workspace.create',
      resourceKind: 'workspace',
      resourceId: created.id,
      outcome: 'allowed',
    });
    return created;
  }

  async get(context: AuthContext, workspaceId: string): Promise<Workspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'workspace.read', { resourceId: workspaceId });
    return workspace;
  }

  async list(context: AuthContext, page: PageRequest & { includeArchived?: boolean }): Promise<Page<Workspace>> {
    // Scoped to membership at the query, so an unauthorized workspace is not
    // merely hidden from the response — it is never read.
    return this.store.workspaces.list({
      ...page,
      ...(context.principal.isAdmin ? {} : { principalId: context.principal.id }),
    });
  }

  async update(
    context: AuthContext,
    workspaceId: string,
    patch: { name?: string; description?: string; systemPrompt?: string },
  ): Promise<Workspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'workspace.update', { resourceId: workspaceId });

    const updated = await this.store.workspaces.update(workspaceId, {
      ...patch,
      updatedAt: this.clock.now(),
    });
    await this.audit(context, {
      workspaceId,
      action: 'workspace.update',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      outcome: 'allowed',
      details: { fields: Object.keys(patch) },
    });
    return updated;
  }

  async updateMembers(
    context: AuthContext,
    workspaceId: string,
    members: { principalId: string; role: WorkspaceRole }[],
  ): Promise<Workspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'workspace.members.update', { resourceId: workspaceId });

    // Refuse to leave a workspace unadministered.
    if (!members.some((member) => member.role === 'owner')) {
      throw validationError('A workspace must retain at least one owner');
    }

    const now = this.clock.now();
    return this.store.workspaces.update(workspaceId, {
      members: members.map((member) => ({ ...member, addedAt: now })),
      updatedAt: now,
    });
  }

  async updateQuota(
    context: AuthContext,
    workspaceId: string,
    quota: Partial<Workspace['quota']>,
  ): Promise<Workspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'workspace.quota.update', { resourceId: workspaceId });

    const updated = await this.store.workspaces.update(workspaceId, {
      quota: { ...workspace.quota, ...quota },
      updatedAt: this.clock.now(),
    });
    await this.audit(context, {
      workspaceId,
      action: 'workspace.quota.update',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      outcome: 'allowed',
      details: { quota },
    });
    return updated;
  }

  async archive(context: AuthContext, workspaceId: string, reason: string): Promise<Workspace> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'workspace.archive', { resourceId: workspaceId });
    resourceMachine.assert(workspace.status, 'archived');

    const now = this.clock.now();
    const archived = await this.store.workspaces.update(workspaceId, {
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    });
    await this.audit(context, {
      workspaceId,
      action: 'workspace.archive',
      resourceKind: 'workspace',
      resourceId: workspaceId,
      outcome: 'allowed',
      reason,
    });
    return archived;
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  workspaceId: string;
  name: string;
  description?: string;
  labels?: string[];
  /** Optional initial version, so an agent is usable immediately. */
  spec?: Record<string, unknown>;
}

/** A field-level diff between two versions, surfaced before the write lands. */
export interface VersionDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export class AgentService extends BaseService {
  async create(context: AuthContext, input: CreateAgentInput): Promise<Agent> {
    const workspace = await this.requireWorkspace(input.workspaceId);
    this.authorizer.require(context, workspace, 'agent.create');
    await this.quota.requireAgentAdmission(workspace);

    const now = this.clock.now();
    const agent: Agent = {
      id: newId('agent', now),
      workspaceId: workspace.id,
      name: input.name,
      description: input.description ?? '',
      status: 'active',
      latestVersion: 0,
      labels: input.labels ?? [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: context.principal.id,
    };

    const created = await this.store.agents.create(agent);
    if (input.spec) {
      await this.createVersion(context, created.id, { spec: input.spec });
      return (await this.store.agents.get(created.id))!;
    }
    return created;
  }

  async get(context: AuthContext, agentId: string): Promise<Agent> {
    const agent = await this.store.agents.get(agentId);
    if (!agent) throw notFound('Agent', agentId);
    const workspace = await this.requireWorkspace(agent.workspaceId);
    this.authorizer.require(context, workspace, 'agent.read', { resourceId: agentId });
    return agent;
  }

  async list(
    context: AuthContext,
    workspaceId: string,
    page: PageRequest & { includeArchived?: boolean; labels?: string[] },
  ): Promise<Page<Agent>> {
    const workspace = await this.requireWorkspace(workspaceId);
    this.authorizer.require(context, workspace, 'agent.read');
    return this.store.agents.list({ workspaceId, ...page });
  }

  async update(
    context: AuthContext,
    agentId: string,
    patch: { name?: string; description?: string; labels?: string[]; productionVersion?: number },
  ): Promise<Agent> {
    const agent = await this.get(context, agentId);
    const workspace = await this.requireWorkspace(agent.workspaceId);
    this.authorizer.require(context, workspace, 'agent.update', { resourceId: agentId });

    if (patch.productionVersion !== undefined) {
      const version = await this.store.agentVersions.get(agentId, patch.productionVersion);
      if (!version) {
        throw validationError(`Version ${patch.productionVersion} does not exist`, {
          agentId,
          version: patch.productionVersion,
        });
      }
    }

    return this.store.agents.update(agentId, { ...patch, updatedAt: this.clock.now() });
  }

  /**
   * Create a new immutable version.
   *
   * `spec` is merged over `baseVersion` (defaulting to the current latest), so a
   * caller changing one field does not have to restate the rest — and cannot
   * silently drop a capability by omitting it. Pass `replace: true` for a true
   * full-snapshot write.
   *
   * The version number is claimed by compare-and-set: on a concurrent create the
   * loser gets a CONFLICT naming the new base rather than overwriting.
   */
  async createVersion(
    context: AuthContext,
    agentId: string,
    input: {
      spec: Record<string, unknown>;
      baseVersion?: number;
      changeSummary?: string;
      replace?: boolean;
    },
  ): Promise<{ version: AgentVersion; diff: VersionDiff }> {
    const agent = await this.get(context, agentId);
    const workspace = await this.requireWorkspace(agent.workspaceId);
    this.authorizer.require(context, workspace, 'agent.version.create', { resourceId: agentId });

    const baseNumber = input.baseVersion ?? agent.latestVersion;
    let base: Record<string, unknown> = {};
    if (!input.replace && baseNumber > 0) {
      const found = await this.store.agentVersions.get(agentId, baseNumber);
      if (!found) throw notFound('AgentVersion', `${agentId}@${baseNumber}`);
      const { agentId: _a, version: _v, createdAt: _c, createdBy: _b, changeSummary: _s, baseVersion: _bv, ...rest } =
        found;
      base = rest as Record<string, unknown>;
    }

    const next = agent.latestVersion + 1;
    const now = this.clock.now();
    const merged = { ...base, ...input.spec };

    const candidate = parseOrThrow(agentVersionSchema, {
      ...merged,
      agentId,
      version: next,
      ...(baseNumber > 0 ? { baseVersion: baseNumber } : {}),
      changeSummary: input.changeSummary ?? '',
      createdAt: now,
      createdBy: context.principal.id,
    });

    const diff = diffSpecs(base, merged);

    // Claim the number first: if this fails, nothing was written.
    await this.store.agents.bumpVersion(agentId, agent.latestVersion, next, now);
    try {
      await this.store.agentVersions.create(candidate);
    } catch (error) {
      // The number is claimed but the body failed to write. Rolling the pointer
      // back would race another writer that already claimed next+1, so the
      // version number is simply burned — versions are dense, not gapless, and
      // a gap is far cheaper than a lost update.
      this.logger?.error('agent version body failed after claiming a number', {
        agentId,
        version: next,
        error,
      });
      throw error;
    }

    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'agent.version.create',
      resourceKind: 'agent',
      resourceId: agentId,
      outcome: 'allowed',
      details: { version: next, baseVersion: baseNumber, diff },
    });

    return { version: candidate, diff };
  }

  async getVersion(context: AuthContext, agentId: string, version: number): Promise<AgentVersion> {
    const agent = await this.get(context, agentId);
    const workspace = await this.requireWorkspace(agent.workspaceId);
    this.authorizer.require(context, workspace, 'agent.version.read', { resourceId: agentId });

    const found = await this.store.agentVersions.get(agentId, version);
    if (!found) throw notFound('AgentVersion', `${agentId}@${version}`);
    return found;
  }

  async listVersions(context: AuthContext, agentId: string, page: PageRequest): Promise<Page<AgentVersion>> {
    await this.get(context, agentId);
    return this.store.agentVersions.list(agentId, page);
  }

  /**
   * Resolve which version a new session should pin.
   *
   * Precedence: an explicit request, then the agent's production pin, then
   * latest. Resolution happens exactly once, at session creation — after that
   * the session is immune to edits of its agent.
   */
  async resolveVersion(agent: Agent, requested?: number): Promise<AgentVersion> {
    const wanted = requested ?? agent.productionVersion ?? agent.latestVersion;
    if (wanted < 1) {
      throw validationError('This agent has no versions yet', { agentId: agent.id });
    }
    const version = await this.store.agentVersions.get(agent.id, wanted);
    if (!version) throw notFound('AgentVersion', `${agent.id}@${wanted}`);
    return version;
  }

  async archive(context: AuthContext, agentId: string, reason: string): Promise<Agent> {
    const agent = await this.get(context, agentId);
    const workspace = await this.requireWorkspace(agent.workspaceId);
    this.authorizer.require(context, workspace, 'agent.archive', { resourceId: agentId });

    // An archived agent whose sessions are still running would keep consuming
    // sandboxes with no obvious owner.
    const active = await this.store.sessions.list({
      agentId,
      statuses: ['queued', 'provisioning', 'ready', 'running', 'idle'],
      limit: 1,
    });
    if (active.items.length > 0) {
      throw conflict('Cannot archive an agent with active sessions', {
        agentId,
        activeSessionId: active.items[0]?.id,
      });
    }

    const now = this.clock.now();
    const archived = await this.store.agents.update(agentId, {
      status: 'archived',
      archivedAt: now,
      updatedAt: now,
    });
    await this.audit(context, {
      workspaceId: workspace.id,
      action: 'agent.archive',
      resourceKind: 'agent',
      resourceId: agentId,
      outcome: 'allowed',
      reason,
    });
    return archived;
  }
}

/** Shallow field-level diff. Enough to show what a version change did. */
function diffSpecs(base: Record<string, unknown>, next: Record<string, unknown>): VersionDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const key of Object.keys(next)) {
    if (!(key in base)) added.push(key);
    else if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) changed.push(key);
  }
  for (const key of Object.keys(base)) {
    if (!(key in next)) removed.push(key);
  }

  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
