/**
 * Remaining repositories: credentials, datasets, documents, models,
 * principals, API keys, audit and idempotency.
 *
 * Two carry security weight:
 *
 *  - `credentials` is the only place ciphertext lives, and `getSealed` is the
 *    only method that returns it. Every other read path returns metadata, so
 *    "the API cannot leak a credential value" is enforced by the shape of this
 *    interface rather than by remembering to redact.
 *  - `idempotency` turns a client retry into a replay of the original response,
 *    which is what makes "one attempt, never replayed" safe to promise.
 */

import type {
  AgentTemplate,
  ApiKey,
  Artifact,
  ArtifactStatus,
  AuditEntry,
  Memory,
  Credential,
  Dataset,
  Document,
  ErrorInfo,
  Model,
  Principal,
} from '@ma/contracts';

import type { Database } from '../database.ts';
import {
  readBoolean,
  readJson,
  readNumber,
  readOptionalJson,
  readOptionalNumber,
  readOptionalString,
  readString,
  writeBoolean,
  writeJson,
  writeOptional,
  writeOptionalJson,
  type Row,
  type SqlValue,
} from '../mapping.ts';
import { MAX_PAGE_LIMIT } from '../repository.ts';
import type {
  AgentTemplateFilter,
  AgentTemplateRepository,
  ApiKeyRepository,
  ArtifactFilter,
  ArtifactRepository,
  MemoryFilter,
  MemoryRepository,
  AuditFilter,
  AuditRepository,
  CredentialFilter,
  CredentialRepository,
  DatasetFilter,
  DatasetRepository,
  DocumentFilter,
  DocumentRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  ModelRepository,
  Page,
  PageRequest,
  PrincipalRepository,
} from '../repository.ts';
import { CrudRepository, condition, inCondition, type Condition, type TableSpec } from './crud.ts';

function optionalNumber(field: string, row: Row, column: string): Record<string, number> {
  const value = readOptionalNumber(row, column);
  return value === undefined ? {} : { [field]: value };
}

function optionalString(field: string, row: Row, column: string): Record<string, string> {
  const value = readOptionalString(row, column);
  return value === undefined ? {} : { [field]: value };
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/** Note the absence of `sealed`: the entity never carries the ciphertext. */
const credentialSpec: TableSpec<Credential> = {
  table: 'credentials',
  kind: 'Credential',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    ownerType: readString(row, 'owner_type') as Credential['ownerType'],
    ownerId: readString(row, 'owner_id'),
    type: readString(row, 'type') as Credential['type'],
    name: readString(row, 'name'),
    description: readString(row, 'description'),
    status: readString(row, 'status') as Credential['status'],
    keyVersion: readString(row, 'key_version'),
    ...optionalNumber('expiresAt', row, 'expires_at'),
    ...optionalNumber('lastUsedAt', row, 'last_used_at'),
    valueKeys: readJson(row, 'value_keys', []),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (credential) => ({
    id: credential.id,
    workspace_id: credential.workspaceId,
    owner_type: credential.ownerType,
    owner_id: credential.ownerId,
    type: credential.type,
    name: credential.name,
    description: credential.description,
    status: credential.status,
    // Placeholder; `create` overwrites it with the real ciphertext.
    sealed: '',
    key_version: credential.keyVersion,
    expires_at: writeOptional(credential.expiresAt),
    last_used_at: writeOptional(credential.lastUsedAt),
    value_keys: writeJson(credential.valueKeys),
    metadata: writeJson(credential.metadata),
    created_at: credential.createdAt,
    updated_at: credential.updatedAt,
    created_by: credential.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    description: { column: 'description' },
    status: { column: 'status' },
    keyVersion: { column: 'key_version' },
    expiresAt: { column: 'expires_at' },
    lastUsedAt: { column: 'last_used_at' },
    valueKeys: { column: 'value_keys', encode: (value) => writeJson(value) },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteCredentialRepository extends CrudRepository<Credential> implements CredentialRepository {
  constructor(db: Database) {
    super(db, credentialSpec);
  }

  create(credential: Credential, sealed: string): Promise<Credential> {
    const columns = { ...credentialSpec.toColumns(credential), sealed };
    const names = Object.keys(columns);
    this.db.run(
      `INSERT INTO credentials (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      Object.values(columns),
    );
    return Promise.resolve(credential);
  }

  get(id: string): Promise<Credential | undefined> {
    return Promise.resolve(this.findById(id));
  }

  /**
   * The only path to ciphertext. Callers are the runtime credential-exchange
   * endpoint and nothing else; every use emits an audit event upstream.
   */
  getSealed(id: string): Promise<string | undefined> {
    const row = this.db.get('SELECT sealed FROM credentials WHERE id = ?', [id]);
    return Promise.resolve(row ? readString(row, 'sealed') : undefined);
  }

  update(id: string, patch: Partial<Credential>, sealed?: string): Promise<Credential> {
    return Promise.resolve(
      this.db.transaction(() => {
        const updated = this.patch(id, patch);
        if (sealed !== undefined) {
          this.db.run('UPDATE credentials SET sealed = ? WHERE id = ?', [sealed, id]);
        }
        return updated;
      }),
    );
  }

  list(filter: CredentialFilter): Promise<Page<Credential>> {
    const conditions: Condition[] = [condition('workspace_id = ?', filter.workspaceId)];
    if (filter.ownerType) conditions.push(condition('owner_type = ?', filter.ownerType));
    if (filter.ownerId) conditions.push(condition('owner_id = ?', filter.ownerId));
    if (filter.type) conditions.push(condition('type = ?', filter.type));
    if (filter.expiringBefore !== undefined) {
      conditions.push(condition('expires_at IS NOT NULL'));
      conditions.push(condition('expires_at < ?', filter.expiringBefore));
    }
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  markUsed(id: string, at: number): Promise<void> {
    this.db.run('UPDATE credentials SET last_used_at = ? WHERE id = ?', [at, id]);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Dataset and document
// ---------------------------------------------------------------------------

const datasetSpec: TableSpec<Dataset> = {
  table: 'datasets',
  kind: 'Dataset',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    name: readString(row, 'name'),
    description: readString(row, 'description'),
    status: readString(row, 'status') as Dataset['status'],
    documentCount: readNumber(row, 'document_count'),
    chunkCount: readNumber(row, 'chunk_count'),
    sizeBytes: readNumber(row, 'size_bytes'),
    embeddingModel: readString(row, 'embedding_model'),
    metadata: readJson(row, 'metadata', {}),
    ...optionalNumber('archivedAt', row, 'archived_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (dataset) => ({
    id: dataset.id,
    workspace_id: dataset.workspaceId,
    name: dataset.name,
    description: dataset.description,
    status: dataset.status,
    document_count: dataset.documentCount,
    chunk_count: dataset.chunkCount,
    size_bytes: dataset.sizeBytes,
    embedding_model: dataset.embeddingModel,
    metadata: writeJson(dataset.metadata),
    archived_at: writeOptional(dataset.archivedAt),
    created_at: dataset.createdAt,
    updated_at: dataset.updatedAt,
    created_by: dataset.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    description: { column: 'description' },
    status: { column: 'status' },
    documentCount: { column: 'document_count' },
    chunkCount: { column: 'chunk_count' },
    sizeBytes: { column: 'size_bytes' },
    embeddingModel: { column: 'embedding_model' },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    archivedAt: { column: 'archived_at' },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteDatasetRepository extends CrudRepository<Dataset> implements DatasetRepository {
  constructor(db: Database) {
    super(db, datasetSpec);
  }

  create(dataset: Dataset): Promise<Dataset> {
    return Promise.resolve(this.insert(dataset));
  }

  get(id: string): Promise<Dataset | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Dataset>): Promise<Dataset> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: DatasetFilter): Promise<Page<Dataset>> {
    const conditions: Condition[] = [condition('workspace_id = ?', filter.workspaceId)];
    if (!filter.includeArchived) conditions.push(condition("status != 'archived'"));
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }
}

const documentSpec: TableSpec<Document> = {
  table: 'documents',
  kind: 'Document',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    datasetId: readString(row, 'dataset_id'),
    workspaceId: readString(row, 'workspace_id'),
    name: readString(row, 'name'),
    source: readString(row, 'source') as Document['source'],
    sourceRef: readString(row, 'source_ref'),
    contentType: readString(row, 'content_type'),
    sizeBytes: readNumber(row, 'size_bytes'),
    digest: readString(row, 'digest'),
    status: readString(row, 'status') as Document['status'],
    syncRule: readString(row, 'sync_rule') as Document['syncRule'],
    ...optionalNumber('lastSyncedAt', row, 'last_synced_at'),
    chunkCount: readNumber(row, 'chunk_count'),
    ...(readOptionalJson<ErrorInfo>(row, 'error') === undefined
      ? {}
      : { error: readOptionalJson<ErrorInfo>(row, 'error')! }),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (document) => ({
    id: document.id,
    dataset_id: document.datasetId,
    workspace_id: document.workspaceId,
    name: document.name,
    source: document.source,
    source_ref: document.sourceRef,
    content_type: document.contentType,
    size_bytes: document.sizeBytes,
    digest: document.digest,
    status: document.status,
    sync_rule: document.syncRule,
    last_synced_at: writeOptional(document.lastSyncedAt),
    chunk_count: document.chunkCount,
    error: writeOptionalJson(document.error),
    metadata: writeJson(document.metadata),
    created_at: document.createdAt,
    updated_at: document.updatedAt,
    created_by: document.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    sourceRef: { column: 'source_ref' },
    contentType: { column: 'content_type' },
    sizeBytes: { column: 'size_bytes' },
    digest: { column: 'digest' },
    status: { column: 'status' },
    syncRule: { column: 'sync_rule' },
    lastSyncedAt: { column: 'last_synced_at' },
    chunkCount: { column: 'chunk_count' },
    error: { column: 'error', encode: (value) => writeOptionalJson(value) },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteDocumentRepository extends CrudRepository<Document> implements DocumentRepository {
  constructor(db: Database) {
    super(db, documentSpec);
  }

  create(document: Document): Promise<Document> {
    return Promise.resolve(this.insert(document));
  }

  get(id: string): Promise<Document | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Document>): Promise<Document> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: DocumentFilter): Promise<Page<Document>> {
    const conditions: Condition[] = [condition('dataset_id = ?', filter.datasetId)];
    if (filter.status) conditions.push(condition('status = ?', filter.status));
    if (filter.keyword) conditions.push(condition('name LIKE ?', `%${filter.keyword}%`));
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  deleteForDataset(datasetId: string): Promise<void> {
    this.db.run('DELETE FROM documents WHERE dataset_id = ?', [datasetId]);
    return Promise.resolve();
  }

  findPending(limit: number): Promise<Document[]> {
    return Promise.resolve(
      this.findMany([condition("status = 'pending'")], { orderBy: 'created_at', limit }),
    );
  }
}

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

export class SqliteModelRepository implements ModelRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  upsert(model: Model): Promise<Model> {
    this.#db.run(
      `INSERT INTO models (id, provider, model, display_name, enabled, context_window_tokens,
                           max_output_tokens, compact_threshold_tokens, capabilities, pricing,
                           security_level, allowed_workspace_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         model = excluded.model,
         display_name = excluded.display_name,
         enabled = excluded.enabled,
         context_window_tokens = excluded.context_window_tokens,
         max_output_tokens = excluded.max_output_tokens,
         compact_threshold_tokens = excluded.compact_threshold_tokens,
         capabilities = excluded.capabilities,
         pricing = excluded.pricing,
         security_level = excluded.security_level,
         allowed_workspace_ids = excluded.allowed_workspace_ids`,
      [
        model.id,
        model.provider,
        model.model,
        model.displayName,
        writeBoolean(model.enabled),
        model.contextWindowTokens,
        model.maxOutputTokens,
        model.compactThresholdTokens,
        writeJson(model.capabilities),
        writeJson(model.pricing),
        model.securityLevel,
        writeJson(model.allowedWorkspaceIds),
      ],
    );
    return Promise.resolve(model);
  }

  get(id: string): Promise<Model | undefined> {
    const row = this.#db.get('SELECT * FROM models WHERE id = ?', [id]);
    return Promise.resolve(row ? this.#fromRow(row) : undefined);
  }

  /**
   * Enabled models a workspace may use. An empty allowlist means "available to
   * everyone", so the filter is applied in code rather than SQL to keep that
   * rule in one readable place.
   */
  list(workspaceId?: string): Promise<Model[]> {
    const rows = this.#db.all('SELECT * FROM models WHERE enabled = 1 ORDER BY id');
    const models = rows.map((row) => this.#fromRow(row));
    if (!workspaceId) return Promise.resolve(models);
    return Promise.resolve(
      models.filter(
        (model) =>
          model.allowedWorkspaceIds.length === 0 || model.allowedWorkspaceIds.includes(workspaceId),
      ),
    );
  }

  delete(id: string): Promise<void> {
    this.#db.run('DELETE FROM models WHERE id = ?', [id]);
    return Promise.resolve();
  }

  #fromRow(row: Row): Model {
    return {
      id: readString(row, 'id'),
      provider: readString(row, 'provider'),
      model: readString(row, 'model'),
      displayName: readString(row, 'display_name'),
      enabled: readBoolean(row, 'enabled'),
      contextWindowTokens: readNumber(row, 'context_window_tokens'),
      maxOutputTokens: readNumber(row, 'max_output_tokens'),
      compactThresholdTokens: readNumber(row, 'compact_threshold_tokens'),
      capabilities: readJson(row, 'capabilities', {} as Model['capabilities']),
      pricing: readJson(row, 'pricing', {} as Model['pricing']),
      securityLevel: readString(row, 'security_level'),
      allowedWorkspaceIds: readJson(row, 'allowed_workspace_ids', []),
    };
  }
}

// ---------------------------------------------------------------------------
// Principal and API key
// ---------------------------------------------------------------------------

const principalSpec: TableSpec<Principal> = {
  table: 'principals',
  kind: 'Principal',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    type: readString(row, 'type') as Principal['type'],
    subject: readString(row, 'subject'),
    displayName: readString(row, 'display_name'),
    email: readString(row, 'email'),
    isAdmin: readBoolean(row, 'is_admin'),
    disabled: readBoolean(row, 'disabled'),
    ...optionalNumber('lastSeenAt', row, 'last_seen_at'),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (principal) => ({
    id: principal.id,
    type: principal.type,
    subject: principal.subject,
    display_name: principal.displayName,
    email: principal.email,
    is_admin: writeBoolean(principal.isAdmin),
    disabled: writeBoolean(principal.disabled),
    last_seen_at: writeOptional(principal.lastSeenAt),
    metadata: writeJson(principal.metadata),
    created_at: principal.createdAt,
    updated_at: principal.updatedAt,
    created_by: principal.createdBy,
  }),
  updateMapping: {
    displayName: { column: 'display_name' },
    email: { column: 'email' },
    isAdmin: { column: 'is_admin', encode: (value) => writeBoolean(value as boolean) },
    disabled: { column: 'disabled', encode: (value) => writeBoolean(value as boolean) },
    lastSeenAt: { column: 'last_seen_at' },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqlitePrincipalRepository extends CrudRepository<Principal> implements PrincipalRepository {
  constructor(db: Database) {
    super(db, principalSpec);
  }

  create(principal: Principal): Promise<Principal> {
    return Promise.resolve(this.insert(principal));
  }

  get(id: string): Promise<Principal | undefined> {
    return Promise.resolve(this.findById(id));
  }

  getBySubject(subject: string): Promise<Principal | undefined> {
    return Promise.resolve(this.findOne([condition('subject = ?', subject)]));
  }

  update(id: string, patch: Partial<Principal>): Promise<Principal> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(page: PageRequest): Promise<Page<Principal>> {
    return Promise.resolve(this.page([], page));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }
}

const apiKeySpec: TableSpec<ApiKey> = {
  table: 'api_keys',
  kind: 'ApiKey',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    principalId: readString(row, 'principal_id'),
    ...optionalString('workspaceId', row, 'workspace_id'),
    name: readString(row, 'name'),
    prefix: readString(row, 'prefix'),
    tokenHash: readString(row, 'token_hash'),
    scopes: readJson(row, 'scopes', []),
    ...optionalNumber('expiresAt', row, 'expires_at'),
    ...optionalNumber('lastUsedAt', row, 'last_used_at'),
    ...optionalNumber('revokedAt', row, 'revoked_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (key) => ({
    id: key.id,
    principal_id: key.principalId,
    workspace_id: writeOptional(key.workspaceId),
    name: key.name,
    prefix: key.prefix,
    token_hash: key.tokenHash,
    scopes: writeJson(key.scopes),
    expires_at: writeOptional(key.expiresAt),
    last_used_at: writeOptional(key.lastUsedAt),
    revoked_at: writeOptional(key.revokedAt),
    created_at: key.createdAt,
    updated_at: key.updatedAt,
    created_by: key.createdBy,
  }),
  updateMapping: {
    name: { column: 'name' },
    scopes: { column: 'scopes', encode: (value) => writeJson(value) },
    expiresAt: { column: 'expires_at' },
    lastUsedAt: { column: 'last_used_at' },
    revokedAt: { column: 'revoked_at' },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteApiKeyRepository extends CrudRepository<ApiKey> implements ApiKeyRepository {
  constructor(db: Database) {
    super(db, apiKeySpec);
  }

  create(key: ApiKey): Promise<ApiKey> {
    return Promise.resolve(this.insert(key));
  }

  get(id: string): Promise<ApiKey | undefined> {
    return Promise.resolve(this.findById(id));
  }

  /** Authentication looks up by hash; the raw token is never stored. */
  getByHash(tokenHash: string): Promise<ApiKey | undefined> {
    return Promise.resolve(this.findOne([condition('token_hash = ?', tokenHash)]));
  }

  listForPrincipal(principalId: string): Promise<ApiKey[]> {
    return Promise.resolve(this.findMany([condition('principal_id = ?', principalId)]));
  }

  revokeAllForPrincipal(principalId: string, revokedAt: number): Promise<number> {
    // A single UPDATE, so it is not bounded by the page cap a list+loop would hit
    // — every live key is revoked regardless of how many the principal holds.
    // Only touches keys not already revoked, so the count is the number newly
    // killed and a re-run is a no-op.
    const result = this.db.run(
      `UPDATE api_keys SET revoked_at = ?, updated_at = ? WHERE principal_id = ? AND revoked_at IS NULL`,
      [revokedAt, revokedAt, principalId],
    );
    return Promise.resolve(Number(result.changes ?? 0));
  }

  update(id: string, patch: Partial<ApiKey>): Promise<ApiKey> {
    return Promise.resolve(this.patch(id, patch));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export class SqliteAuditRepository implements AuditRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  append(entry: AuditEntry): Promise<AuditEntry> {
    this.#db.run(
      `INSERT INTO audit_entries (id, workspace_id, principal_id, action, resource_kind,
                                  resource_id, outcome, reason, request_id, source_ip, details, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        writeOptional(entry.workspaceId),
        entry.principalId,
        entry.action,
        entry.resourceKind,
        entry.resourceId,
        entry.outcome,
        entry.reason,
        entry.requestId,
        entry.sourceIp,
        writeJson(entry.details),
        entry.at,
      ],
    );
    return Promise.resolve(entry);
  }

  list(filter: AuditFilter): Promise<Page<AuditEntry>> {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (filter.workspaceId) {
      clauses.push('workspace_id = ?');
      values.push(filter.workspaceId);
    }
    if (filter.principalId) {
      clauses.push('principal_id = ?');
      values.push(filter.principalId);
    }
    if (filter.action) {
      clauses.push('action = ?');
      values.push(filter.action);
    }
    if (filter.resourceId) {
      clauses.push('resource_id = ?');
      values.push(filter.resourceId);
    }
    if (filter.after !== undefined) {
      clauses.push('at >= ?');
      values.push(filter.after);
    }
    if (filter.before !== undefined) {
      clauses.push('at < ?');
      values.push(filter.before);
    }
    if (filter.cursor) {
      const decoded = Buffer.from(filter.cursor, 'base64url').toString('utf8');
      clauses.push(filter.order === 'asc' ? 'id > ?' : 'id < ?');
      values.push(decoded);
    }

    const limit = Math.min(filter.limit ?? 50, 200);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const direction = filter.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.#db.all(
      `SELECT * FROM audit_entries ${where} ORDER BY id ${direction} LIMIT ?`,
      [...values, limit + 1],
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((row) => this.#fromRow(row));
    if (!hasMore) return Promise.resolve({ items });
    return Promise.resolve({
      items,
      nextCursor: Buffer.from(String(page[page.length - 1]?.id ?? ''), 'utf8').toString('base64url'),
    });
  }

  prune(before: number): Promise<number> {
    const result = this.#db.run('DELETE FROM audit_entries WHERE at < ?', [before]);
    return Promise.resolve(result.changes);
  }

  #fromRow(row: Row): AuditEntry {
    return {
      id: readString(row, 'id'),
      ...optionalString('workspaceId', row, 'workspace_id'),
      principalId: readString(row, 'principal_id'),
      action: readString(row, 'action'),
      resourceKind: readString(row, 'resource_kind'),
      resourceId: readString(row, 'resource_id'),
      outcome: readString(row, 'outcome') as AuditEntry['outcome'],
      reason: readString(row, 'reason'),
      requestId: readString(row, 'request_id'),
      sourceIp: readString(row, 'source_ip'),
      details: readJson(row, 'details', {}),
      at: readNumber(row, 'at'),
    };
  }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export class SqliteIdempotencyRepository implements IdempotencyRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Claim a key, or report who already holds it.
   *
   * Reservation and lookup happen in one transaction, so two concurrent
   * requests with the same key cannot both believe they are the original. An
   * expired reservation is reclaimed rather than blocking forever — otherwise a
   * crashed request would permanently poison its key.
   */
  reserve(
    key: string,
    scope: string,
    now: number,
    ttlMs: number,
  ): Promise<{ reserved: true } | { reserved: false; record: IdempotencyRecord }> {
    const outcome = this.#db.transaction(() => {
      const row = this.#db.get('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?', [
        key,
        scope,
      ]);

      if (row) {
        const record = this.#fromRow(row);
        if (record.expiresAt > now) return { reserved: false as const, record };
        this.#db.run('DELETE FROM idempotency_keys WHERE key = ? AND scope = ?', [key, scope]);
      }

      this.#db.run(
        'INSERT INTO idempotency_keys (key, scope, created_at, expires_at) VALUES (?, ?, ?, ?)',
        [key, scope, now, now + ttlMs],
      );
      return { reserved: true as const };
    });
    return Promise.resolve(outcome);
  }

  complete(
    key: string,
    scope: string,
    statusCode: number,
    response: string,
    at: number,
    requestHash?: string,
  ): Promise<void> {
    this.#db.run(
      `UPDATE idempotency_keys
          SET status_code = ?, response = ?, completed_at = ?, request_hash = ?
        WHERE key = ? AND scope = ?`,
      [statusCode, response, at, requestHash ?? null, key, scope],
    );
    return Promise.resolve();
  }

  /** Free a key whose request failed, so a retry is a fresh attempt. */
  release(key: string, scope: string): Promise<void> {
    this.#db.run('DELETE FROM idempotency_keys WHERE key = ? AND scope = ? AND completed_at IS NULL', [
      key,
      scope,
    ]);
    return Promise.resolve();
  }

  prune(before: number): Promise<number> {
    const result = this.#db.run('DELETE FROM idempotency_keys WHERE expires_at < ?', [before]);
    return Promise.resolve(result.changes);
  }

  #fromRow(row: Row): IdempotencyRecord {
    return {
      key: readString(row, 'key'),
      scope: readString(row, 'scope'),
      ...optionalNumber('statusCode', row, 'status_code'),
      ...optionalString('response', row, 'response'),
      ...optionalString('requestHash', row, 'request_hash'),
      createdAt: readNumber(row, 'created_at'),
      ...optionalNumber('completedAt', row, 'completed_at'),
      expiresAt: readNumber(row, 'expires_at'),
    };
  }
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

const artifactSpec: TableSpec<Artifact> = {
  table: 'artifacts',
  kind: 'Artifact',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    sessionId: readString(row, 'session_id'),
    ...optionalNumber('turn', row, 'turn'),
    path: readString(row, 'path'),
    contentType: readString(row, 'content_type'),
    sizeBytes: readNumber(row, 'size_bytes'),
    digest: readString(row, 'digest'),
    status: readString(row, 'status') as ArtifactStatus,
    ...optionalNumber('expiresAt', row, 'expires_at'),
    ...optionalNumber('purgedAt', row, 'purged_at'),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (artifact) => ({
    id: artifact.id,
    workspace_id: artifact.workspaceId,
    session_id: artifact.sessionId,
    turn: writeOptional(artifact.turn),
    path: artifact.path,
    content_type: artifact.contentType,
    size_bytes: artifact.sizeBytes,
    digest: artifact.digest,
    status: artifact.status,
    expires_at: writeOptional(artifact.expiresAt),
    purged_at: writeOptional(artifact.purgedAt),
    metadata: writeJson(artifact.metadata),
    created_at: artifact.createdAt,
    updated_at: artifact.updatedAt,
    created_by: artifact.createdBy,
  }),
  // Deliberately absent: digest, sizeBytes, sessionId, path. The bytes are
  // written once and never edited, so a patch that could change what a row
  // claims to contain would break the guarantee that a digest names content
  // this workspace actually uploaded.
  updateMapping: {
    status: { column: 'status' },
    contentType: { column: 'content_type' },
    expiresAt: { column: 'expires_at' },
    purgedAt: { column: 'purged_at' },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

/** Statuses whose bytes are still on disk and therefore still charged. */
const STORED_STATUSES = "status IN ('available', 'expired')";

export class SqliteArtifactRepository
  extends CrudRepository<Artifact>
  implements ArtifactRepository
{
  constructor(db: Database) {
    super(db, artifactSpec);
  }

  createIfAbsent(artifact: Artifact): Promise<{ artifact: Artifact; created: boolean }> {
    const result = this.db.transaction(() => {
      const existing = this.#findDuplicate(artifact);
      if (existing) return this.#dedupeOnto(existing, artifact);
      return { artifact: this.insert(artifact), created: true };
    });
    return Promise.resolve(result);
  }

  createWithinStorageLimit(
    artifact: Artifact,
    limitBytes: number,
  ): Promise<{ artifact: Artifact; created: boolean } | undefined> {
    // Sum and insert in one synchronous transaction. Splitting them is
    // check-then-act: concurrent uploads would each read a pre-insert total and
    // all pass a limit none of them had yet consumed.
    const result = this.db.transaction(() => {
      const existing = this.#findDuplicate(artifact);
      if (existing) {
        // A live duplicate is a retry of an upload already stored: it costs no
        // additional bytes, so it must not be refused for a limit it is not
        // adding to. A *purged* duplicate is different — its bytes were freed,
        // so reviving it adds them back and must pass the same check an insert
        // would. `#dedupeOnto` reports `created` for exactly that case.
        if (existing.status !== 'purged') return { artifact: existing, created: false };

        const stored = this.#totalBytes(artifact.workspaceId);
        if (stored + artifact.sizeBytes > limitBytes) return undefined;
        return this.#dedupeOnto(existing, artifact);
      }

      const stored = this.#totalBytes(artifact.workspaceId);
      if (stored + artifact.sizeBytes > limitBytes) return undefined;
      return { artifact: this.insert(artifact), created: true };
    });
    return Promise.resolve(result);
  }

  /**
   * Reconcile an upload against an existing row at the same
   * `(session, path, digest)`.
   *
   * A live row (`available`/`expired`) is a genuine retry: return it untouched,
   * `created: false`, so no bytes are re-stored and quota is charged once. A
   * `purged` row is the trap this method exists for: `UNIQUE(session, path,
   * digest)` forbids inserting a second row, so before this the re-publish
   * deduped straight onto the tombstone and returned `created: false` — the
   * caller skipped the byte write, and every later download of "restored"
   * content 404'd as purged forever. Revive the row instead (back to
   * `available`, tombstone cleared, expiry refreshed) and report `created: true`
   * so the caller re-stores the bytes it was about to drop.
   */
  #dedupeOnto(existing: Artifact, artifact: Artifact): { artifact: Artifact; created: boolean } {
    if (existing.status !== 'purged') return { artifact: existing, created: false };

    const revived = this.patch(existing.id, {
      status: 'available',
      // Explicit `undefined` so `buildUpdate` writes SQL NULL: the row is no
      // longer a tombstone.
      purgedAt: undefined,
      expiresAt: artifact.expiresAt,
      contentType: artifact.contentType,
      updatedAt: artifact.updatedAt,
    } as Partial<Artifact>);
    return { artifact: revived, created: true };
  }

  #findDuplicate(artifact: Artifact): Artifact | undefined {
    return this.findOne([
      condition('session_id = ?', artifact.sessionId),
      condition('path = ?', artifact.path),
      condition('digest = ?', artifact.digest),
    ]);
  }

  #totalBytes(workspaceId: string): number {
    const row = this.db.get(
      `SELECT COALESCE(SUM(size_bytes), 0) AS total FROM artifacts
        WHERE workspace_id = ? AND ${STORED_STATUSES}`,
      [workspaceId],
    );
    return row ? readNumber(row, 'total') : 0;
  }

  get(id: string): Promise<Artifact | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Artifact>): Promise<Artifact> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: ArtifactFilter): Promise<Page<Artifact>> {
    const conditions: Condition[] = [condition('workspace_id = ?', filter.workspaceId)];
    if (filter.sessionId) conditions.push(condition('session_id = ?', filter.sessionId));
    const statuses = inCondition('status', filter.statuses ?? []);
    if (statuses) conditions.push(statuses);
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  totalBytes(workspaceId: string): Promise<number> {
    return Promise.resolve(this.#totalBytes(workspaceId));
  }

  countByDigest(workspaceId: string, digest: string): Promise<number> {
    // Scoped to the workspace as well as the digest: blobs are never shared
    // across tenants, so one workspace's deletion must not consult another's
    // reference count.
    return Promise.resolve(
      this.count([
        condition('workspace_id = ?', workspaceId),
        condition('digest = ?', digest),
        condition(STORED_STATUSES),
      ]),
    );
  }

  findExpired(now: number, limit: number): Promise<Artifact[]> {
    return Promise.resolve(
      this.findMany(
        [
          condition('expires_at IS NOT NULL'),
          condition('expires_at <= ?', now),
          condition('purged_at IS NULL'),
        ],
        { orderBy: 'expires_at', limit },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const memorySpec: TableSpec<Memory> = {
  table: 'memories',
  kind: 'Memory',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    workspaceId: readString(row, 'workspace_id'),
    scope: readString(row, 'scope') as Memory['scope'],
    ...optionalString('agentId', row, 'agent_id'),
    kind: readString(row, 'kind') as Memory['kind'],
    content: readString(row, 'content'),
    origin: readString(row, 'origin') as Memory['origin'],
    injectable: readBoolean(row, 'injectable'),
    ...optionalString('sourceSessionId', row, 'source_session_id'),
    ...optionalString('promotedBy', row, 'promoted_by'),
    ...optionalNumberField('promotedAt', row, 'promoted_at'),
    contentHash: readString(row, 'content_hash'),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (memory) => ({
    id: memory.id,
    workspace_id: memory.workspaceId,
    scope: memory.scope,
    agent_id: writeOptional(memory.agentId),
    kind: memory.kind,
    content: memory.content,
    origin: memory.origin,
    injectable: writeBoolean(memory.injectable),
    source_session_id: writeOptional(memory.sourceSessionId),
    promoted_by: writeOptional(memory.promotedBy),
    promoted_at: writeOptional(memory.promotedAt),
    content_hash: memory.contentHash,
    metadata: writeJson(memory.metadata),
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    created_by: memory.createdBy,
  }),
  // `origin`, `scope`, `agentId` and `sourceSessionId` are deliberately absent.
  // The trust model reads origin to decide whether text may reach a system
  // prompt, so a patch able to rewrite it from 'agent' to 'human' would be the
  // whole vulnerability in one call. Omission is the enforcement.
  //
  // `injectable` is absent for the same reason and deserves its own note: it is
  // the flag that moves text across the trust boundary, and it is settable only
  // through `promoteInjectable` below. A plain `update` reaching it would let a
  // future caller promote a memory without the authorization check and the
  // audit entry that `MemoryService.promote` performs — silently, and in a way
  // that reads like an ordinary field write.
  updateMapping: {
    content: { column: 'content' },
    contentHash: { column: 'content_hash' },
    kind: { column: 'kind' },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

/** Spread helper: include an optional numeric field only when present. */
function optionalNumberField(field: string, row: Row, column: string): Record<string, number> {
  const value = readOptionalNumber(row, column);
  return value === undefined ? {} : { [field]: value };
}

export class SqliteMemoryRepository extends CrudRepository<Memory> implements MemoryRepository {
  constructor(db: Database) {
    super(db, memorySpec);
  }

  createIfAbsent(memory: Memory): Promise<{ memory: Memory; created: boolean }> {
    const result = this.db.transaction(() => {
      const existing = this.#findDuplicate(memory);
      if (existing) return { memory: existing, created: false };
      return { memory: this.insert(memory), created: true };
    });
    return Promise.resolve(result);
  }

  #findDuplicate(memory: Memory): Memory | undefined {
    return this.findOne([
      condition('workspace_id = ?', memory.workspaceId),
      memory.agentId === undefined
        ? condition('agent_id IS NULL')
        : condition('agent_id = ?', memory.agentId),
      condition('content_hash = ?', memory.contentHash),
    ]);
  }

  get(id: string): Promise<Memory | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<Memory>): Promise<Memory> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: MemoryFilter): Promise<Page<Memory>> {
    const conditions: Condition[] = [condition('workspace_id = ?', filter.workspaceId)];
    if (filter.scope) conditions.push(condition('scope = ?', filter.scope));
    if (filter.agentId) conditions.push(condition('agent_id = ?', filter.agentId));
    else if (filter.agentIdIsNull) conditions.push(condition('agent_id IS NULL'));
    if (filter.injectableOnly) conditions.push(condition('injectable = 1'));
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  /**
   * Set the injectable flag and its provenance.
   *
   * Separate from `update` on purpose. This is the only write that moves text
   * across the trust boundary into a system prompt, so it is a named operation
   * a reader can grep for rather than one field among many in a patch.
   */
  promoteInjectable(
    id: string,
    injectable: boolean,
    promotedBy: string | undefined,
    at: number,
  ): Promise<Memory> {
    this.db.run(
      `UPDATE memories SET injectable = ?, promoted_by = ?, promoted_at = ?, updated_at = ?
        WHERE id = ?`,
      [injectable ? 1 : 0, promotedBy ?? null, injectable ? at : null, at, id],
    );
    return Promise.resolve(this.requireById(id));
  }

  findForAgent(
    workspaceId: string,
    agentId: string,
    options: { injectableOnly?: boolean; limit: number },
  ): Promise<Memory[]> {
    // An agent sees its own memories and its workspace's, and nothing from a
    // sibling agent — sharing those would make one agent's learned text another
    // agent's context without anyone deciding so.
    // A negative or zero limit must never reach SQLite: `LIMIT -1` there means
    // *unbounded*, so an untrusted caller passing `limit=-1` would read the
    // whole scope. Clamp to at least 1 and at most the page cap.
    const limit = Math.max(1, Math.min(Math.trunc(options.limit), MAX_PAGE_LIMIT));
    const rows = this.db.all(
      `SELECT * FROM memories
        WHERE workspace_id = ?
          AND (agent_id = ? OR agent_id IS NULL)
          ${options.injectableOnly ? 'AND injectable = 1' : ''}
        ORDER BY created_at DESC
        LIMIT ?`,
      [workspaceId, agentId, limit],
    );
    return Promise.resolve(rows.map((row) => memorySpec.fromRow(row)));
  }

  countForScope(workspaceId: string, agentId: string | undefined): Promise<number> {
    return Promise.resolve(
      this.count([
        condition('workspace_id = ?', workspaceId),
        agentId === undefined ? condition('agent_id IS NULL') : condition('agent_id = ?', agentId),
      ]),
    );
  }

  findOldest(
    workspaceId: string,
    agentId: string | undefined,
    limit: number,
  ): Promise<Memory[]> {
    return Promise.resolve(
      this.findMany(
        [
          condition('workspace_id = ?', workspaceId),
          agentId === undefined
            ? condition('agent_id IS NULL')
            : condition('agent_id = ?', agentId),
          // A human's memory is never evicted to make room for an agent's.
          condition("origin = 'agent'"),
        ],
        { orderBy: 'created_at', limit },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Agent template
// ---------------------------------------------------------------------------

const agentTemplateSpec: TableSpec<AgentTemplate> = {
  table: 'agent_templates',
  kind: 'AgentTemplate',
  fromRow: (row) => ({
    id: readString(row, 'id'),
    ...optionalString('workspaceId', row, 'workspace_id'),
    name: readString(row, 'name'),
    description: readString(row, 'description'),
    category: readString(row, 'category'),
    builtin: readBoolean(row, 'builtin'),
    spec: readJson(row, 'spec', {}),
    variables: readJson(row, 'variables', []),
    metadata: readJson(row, 'metadata', {}),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
    createdBy: readString(row, 'created_by'),
  }),
  toColumns: (template) => ({
    id: template.id,
    workspace_id: writeOptional(template.workspaceId),
    name: template.name,
    description: template.description,
    category: template.category,
    builtin: writeBoolean(template.builtin),
    spec: writeJson(template.spec),
    variables: writeJson(template.variables),
    metadata: writeJson(template.metadata),
    created_at: template.createdAt,
    updated_at: template.updatedAt,
    created_by: template.createdBy,
  }),
  // `builtin` and `workspaceId` are absent: whether a template is a platform
  // built-in and which workspace owns it are set at creation and never patched,
  // so an edit cannot turn a workspace template into a built-in (or move it
  // between workspaces) as a side effect.
  updateMapping: {
    name: { column: 'name' },
    description: { column: 'description' },
    category: { column: 'category' },
    spec: { column: 'spec', encode: (value) => writeJson(value) },
    variables: { column: 'variables', encode: (value) => writeJson(value) },
    metadata: { column: 'metadata', encode: (value) => writeJson(value) },
    updatedAt: { column: 'updated_at' },
  },
};

export class SqliteAgentTemplateRepository
  extends CrudRepository<AgentTemplate>
  implements AgentTemplateRepository
{
  constructor(db: Database) {
    super(db, agentTemplateSpec);
  }

  create(template: AgentTemplate): Promise<AgentTemplate> {
    return Promise.resolve(this.insert(template));
  }

  get(id: string): Promise<AgentTemplate | undefined> {
    return Promise.resolve(this.findById(id));
  }

  update(id: string, patch: Partial<AgentTemplate>): Promise<AgentTemplate> {
    return Promise.resolve(this.patch(id, patch));
  }

  list(filter: AgentTemplateFilter): Promise<Page<AgentTemplate>> {
    // A catalogue listing is "this workspace's own templates plus the platform's
    // built-ins". Both are things a user may instantiate, so both belong in one
    // page. The scope predicate is therefore an OR, not a single equality.
    const conditions: Condition[] = [];
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (filter.workspaceId) {
      clauses.push('workspace_id = ?');
      values.push(filter.workspaceId);
    }
    // Built-ins are included by default, so a caller with no workspace still
    // sees the shared catalogue, and a workspace listing includes them too.
    if (filter.includeBuiltins ?? true) {
      clauses.push('builtin = 1');
    }
    if (clauses.length === 0) clauses.push('builtin = 1');
    conditions.push(condition(`(${clauses.join(' OR ')})`, ...values));
    if (filter.category) conditions.push(condition('category = ?', filter.category));
    return Promise.resolve(this.page(conditions, filter));
  }

  delete(id: string): Promise<void> {
    this.remove(id);
    return Promise.resolve();
  }

  upsertBuiltin(template: AgentTemplate): Promise<AgentTemplate> {
    // Keyed on name among built-ins (the partial unique index). Re-seeding a
    // shipped catalogue on every boot must refresh in place rather than
    // accumulate a copy per start.
    const result = this.db.transaction(() => {
      const existing = this.findOne([condition('builtin = 1'), condition('name = ?', template.name)]);
      if (!existing) return this.insert(template);
      return this.patch(existing.id, {
        description: template.description,
        category: template.category,
        spec: template.spec,
        variables: template.variables,
        metadata: template.metadata,
        updatedAt: template.updatedAt,
      });
    });
    return Promise.resolve(result);
  }
}
