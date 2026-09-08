/**
 * Workspace, agent and agent-version repositories.
 *
 * The interesting logic here is `bumpVersion`: a compare-and-set that makes
 * concurrent version creation safe without a distributed lock.
 */

import { conflict, notFound } from '@ma/core';
import { quotaLimitsSchema } from '@ma/contracts';
import type { Agent, AgentVersion, Workspace } from '@ma/contracts';

import type { Database } from '../database.ts';
import {
  readJson,
  readNumber,
  readSchemaJson,
  readOptionalNumber,
  readString,
  writeJson,
  writeOptional,
  type Row,
  type SqlValue,
} from '../mapping.ts';
import type {
  AgentFilter,
  AgentRepository,
  AgentVersionRepository,
  Page,
  PageRequest,
  WorkspaceFilter,
  WorkspaceRepository,
} from '../repository.ts';
import { CrudRepository, condition, type Condition, type TableSpec } from './crud.ts';

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const workspaceSpec: TableSpec<Workspace> = {
  table: 'workspaces',
  kind: 'Workspace',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    slug: readString(row, 'slug'),
    name: readString(row, 'name'),
    description: readString(row, 'description'),
    status: readString(row, 'status') as Workspace['status'],
    members: readJson(row, 'members', []),
    // Parsed, not cast: a row written before a quota field existed would
    // otherwise return it as `undefined`, and `count >= undefined` is false —
    // an absent limit reads as unlimited rather than as its default.
    quota: readSchemaJson(row, 'quota', quotaLimitsSchema),
    systemPrompt: readString(row, 'system_prompt'),
    metadata: readJson(row, 'metadata', {}),
    ...(readOptionalNumber(row, 'archived_at') === undefined
      ? {}
      : { archivedAt: readOptionalNumber(row, 'archived_at')! }),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (workspace) => ({
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    description: workspace.description,
    status: workspace.status,
    members: writeJson(workspace.members),
    quota: writeJson(workspace.quota),
    system_prompt: workspace.systemPrompt,
    metadata: writeJson(workspace.metadata),
    archived_at: writeOptional(workspace.archivedAt),
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
    created_by: workspace.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    description: { column: 'description' },
    slug: { column: 'slug' },
    status: { column: 'status' },
    members: { column: 'members', encode: (value) => writeJson(value) },
    quota: { column: 'quota', encode: (value) => writeJson(value) },
    systemPrompt: { column: 'system_prompt' },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    archivedAt: { column: 'archived_at' },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteWorkspaceRepository extends CrudRepository<Workspace> implements WorkspaceRepository {
  constructor(db: Database) {
    super(db, workspaceSpec);
  }

  create(workspace: Workspace): Promise<Workspace> {
    return Promise.resolve(this.insert(workspace));
  }

  get(id: string): Promise<Workspace | undefined> {
    return Promise.resolve(this.findById(id));
  }

  getBySlug(slug: string): Promise<Workspace | undefined> {
    return Promise.resolve(this.findOne([condition('slug = ?', slug)]));
  }

  update(id: string, patch: Partial<Workspace>): Promise<Workspace> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: WorkspaceFilter): Promise<Page<Workspace>> {
    const conditions: Condition[] = [];
    if (!filter.includeArchived) conditions.push(condition("status != 'archived'"));
    if (filter.principalId) {
      // Membership lives in a JSON array. This is a deliberate simplification
      // for the SQLite driver: workspace counts are small, and a join table
      // would add a migration for a query that is never hot. The Postgres
      // driver can use a containment operator over the same column.
      conditions.push(condition('members LIKE ?', `%"${filter.principalId}"%`));
    }
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agentSpec: TableSpec<Agent> = {
  table: 'agents',
  kind: 'Agent',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    name: readString(row, 'name'),
    description: readString(row, 'description'),
    status: readString(row, 'status') as Agent['status'],
    latestVersion: readNumber(row, 'latest_version'),
    ...(readOptionalNumber(row, 'production_version') === undefined
      ? {}
      : { productionVersion: readOptionalNumber(row, 'production_version')! }),
    labels: readJson(row, 'labels', []),
    metadata: readJson(row, 'metadata', {}),
    ...(readOptionalNumber(row, 'archived_at') === undefined
      ? {}
      : { archivedAt: readOptionalNumber(row, 'archived_at')! }),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (agent) => ({
    id: agent.id,
    workspace_id: agent.workspaceId,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    latest_version: agent.latestVersion,
    production_version: writeOptional(agent.productionVersion),
    labels: writeJson(agent.labels),
    metadata: writeJson(agent.metadata),
    archived_at: writeOptional(agent.archivedAt),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
    created_by: agent.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    description: { column: 'description' },
    status: { column: 'status' },
    latestVersion: { column: 'latest_version' },
    productionVersion: { column: 'production_version' },
    labels: { column: 'labels', encode: (value) => writeJson(value) },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    archivedAt: { column: 'archived_at' },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteAgentRepository extends CrudRepository<Agent> implements AgentRepository {
  constructor(db: Database) {
    super(db, agentSpec);
  }

  create(agent: Agent): Promise<Agent> {
    return Promise.resolve(this.insert(agent));
  }

  createWithinLimit(agent: Agent, limit: number): Promise<Agent | undefined> {
    // Count and insert in one synchronous transaction; see the note on
    // SqliteSessionRepository.createWithinLimit for why splitting them is a
    // check-then-act race rather than a merely theoretical one.
    const created = this.db.transaction(() => {
      const active = this.count([
        condition('workspace_id = ?', agent.workspaceId),
        condition("status != 'archived'"),
      ]);
      if (active >= limit) return undefined;
      return this.insert(agent);
    });
    return Promise.resolve(created);
  }

  get(id: string): Promise<Agent | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Agent>): Promise<Agent> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: AgentFilter): Promise<Page<Agent>> {
    const conditions: Condition[] = [condition('workspace_id = ?', filter.workspaceId)];
    if (!filter.includeArchived) conditions.push(condition("status != 'archived'"));
    if (filter.nameContains) conditions.push(condition('name LIKE ?', `%${filter.nameContains}%`));
    for (const label of filter.labels ?? []) {
      conditions.push(condition('labels LIKE ?', `%"${label}"%`));
    }
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  /**
   * Compare-and-set on `latest_version`.
   *
   * Two concurrent "create version N+1" requests both read N and both try to
   * write N+1; the `latest_version = ?` predicate means exactly one UPDATE
   * matches, and the loser gets a CONFLICT it can retry from the new base. This
   * is what keeps version numbers dense and unambiguous without a lock service.
   */
  bumpVersion(id: string, expected: number, next: number, at: number): Promise<Agent> {
    const result = this.db.run(
      'UPDATE agents SET latest_version = ?, updated_at = ? WHERE id = ? AND latest_version = ?',
      [next, at, id, expected],
    );
    if (result.changes === 0) {
      const current = this.findById(id);
      if (!current) throw notFound('Agent', id);
      throw conflict('Agent version changed concurrently', {
        agentId: id,
        expected,
        actual: current.latestVersion,
      });
    }
    return Promise.resolve(this.requireById(id));
  }

  countByWorkspace(workspaceId: string): Promise<number> {
    return Promise.resolve(
      this.count([condition('workspace_id = ?', workspaceId), condition("status != 'archived'")]),
    );
  }
}

// ---------------------------------------------------------------------------
// AgentVersion
// ---------------------------------------------------------------------------

/**
 * Versions are stored with the whole spec in one JSON column.
 *
 * The alternative — a column per policy — would need a migration for every
 * field added to an agent's configuration, and the spec is never queried by
 * field: it is read whole when a session resolves it. Storing it as one
 * validated document keeps the schema stable and the read a single row fetch.
 */
function versionFromRow(row: Row): AgentVersion {
  const spec = readJson<Record<string, unknown>>(row, 'spec', {});
  return {
    ...spec,
    agentId: readString(row, 'agent_id'),
    version: readNumber(row, 'version'),
    ...(readOptionalNumber(row, 'base_version') === undefined
      ? {}
      : { baseVersion: readOptionalNumber(row, 'base_version')! }),
    changeSummary: readString(row, 'change_summary'),
    createdAt: readNumber(row, 'created_at'),
    createdBy: readString(row, 'created_by'),
  } as AgentVersion;
}

export class SqliteAgentVersionRepository implements AgentVersionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  create(version: AgentVersion): Promise<AgentVersion> {
    // Identity columns are stored separately for indexing; the rest rides in
    // `spec` so adding a policy field needs no migration.
    const { agentId, version: number, baseVersion, changeSummary, createdAt, createdBy, ...spec } = version;
    try {
      this.#db.run(
        `INSERT INTO agent_versions
           (agent_id, version, base_version, change_summary, spec, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          agentId,
          number,
          writeOptional(baseVersion),
          changeSummary ?? '',
          writeJson(spec),
          createdAt,
          createdBy,
        ] as SqlValue[],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE') || message.includes('PRIMARY KEY')) {
        throw conflict('Agent version already exists', { agentId, version: number });
      }
      throw error;
    }
    return Promise.resolve(version);
  }

  get(agentId: string, version: number): Promise<AgentVersion | undefined> {
    const row = this.#db.get('SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?', [
      agentId,
      version,
    ]);
    return Promise.resolve(row ? versionFromRow(row) : undefined);
  }

  list(agentId: string, page: PageRequest): Promise<Page<AgentVersion>> {
    const limit = Math.min(page.limit ?? 50, 200);
    const descending = page.order !== 'asc';
    const params: SqlValue[] = [agentId];

    // The cursor is the version number: dense integers make this exact.
    let cursorClause = '';
    if (page.cursor) {
      const parsed = Number(Buffer.from(page.cursor, 'base64url').toString('utf8'));
      if (Number.isFinite(parsed)) {
        cursorClause = descending ? 'AND version < ?' : 'AND version > ?';
        params.push(parsed);
      }
    }
    params.push(limit + 1);

    const rows = this.#db.all(
      `SELECT * FROM agent_versions WHERE agent_id = ? ${cursorClause}
       ORDER BY version ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(versionFromRow);
    if (!hasMore) return Promise.resolve({ items });

    const last = items[items.length - 1];
    return Promise.resolve({
      items,
      nextCursor: Buffer.from(String(last?.version ?? ''), 'utf8').toString('base64url'),
    });
  }

  latest(agentId: string): Promise<AgentVersion | undefined> {
    const row = this.#db.get(
      'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC LIMIT 1',
      [agentId],
    );
    return Promise.resolve(row ? versionFromRow(row) : undefined);
  }

  deleteForAgent(agentId: string): Promise<void> {
    this.#db.run('DELETE FROM agent_versions WHERE agent_id = ?', [agentId]);
    return Promise.resolve();
  }
}
