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
  ResourceGrant,
} from '@ma/contracts';

import { canonicalJson, internalError, sha256Hex } from '@ma/core';

import type { Database } from '../database.ts';
import {
  buildUpdate,
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
  ChainVerification,
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
  ResourceGrantRepository,
  UsageDay,
  UsageRepository,
  BilledTurnRepository,
} from '../repository.ts';
import { CrudRepository, condition, inCondition, type Condition, type TableSpec } from './crud.ts';

/**
 * Escape SQL `LIKE` metacharacters (`\`, `%`, `_`) so a value matches literally
 * under an explicit `ESCAPE '\'` clause. Used for prefix scans on indexed text
 * columns (e.g. a principal `subject` provider prefix).
 */
function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

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

  knowledgeChunksForWorkspace(workspaceId: string): Promise<number> {
    return Promise.resolve(this.knowledgeChunksForWorkspaceSync(workspaceId));
  }

  knowledgeChunksForWorkspaceSync(workspaceId: string): number {
    // Sum the maintained `chunk_count` rollup across the workspace's live datasets
    // — the authoritative indexed-chunk total that drives the O(chunks) BM25 scan
    // the `maxKnowledgeChunks` quota bounds. Archived datasets hold no live index
    // chunks (deleteDataset is the only eviction), so excluding them matches `list`.
    // Exposed synchronously so the ingest commit can re-read it INSIDE its
    // finalize transaction (under BEGIN IMMEDIATE) and enforce the cap atomically
    // with the rollup increment — a plain async read before the commit is a
    // read-then-act that concurrent ingests (across replicas) race past, exactly
    // as the token/cost budget's `admitAndReserve` guards against.
    const row = this.db.get(
      `SELECT COALESCE(SUM(chunk_count), 0) AS total FROM datasets
        WHERE workspace_id = ? AND status != 'archived'`,
      [workspaceId],
    );
    return row ? readNumber(row, 'total') : 0;
  }

  applyDocumentRemovalSync(datasetId: string, chunkCount: number, sizeBytes: number, at: number): void {
    // A removal is a signed delta: one fewer document, and this document's chunks
    // and bytes gone. Delegates to the atomic delta below so removal and addition
    // share one clamp-at-zero, single-statement implementation.
    this.applyRollupDeltaSync(
      datasetId,
      { documentCount: -1, chunkCount: -chunkCount, sizeBytes: -sizeBytes },
      at,
    );
  }

  applyRollupDeltaSync(
    datasetId: string,
    delta: { documentCount?: number; chunkCount?: number; sizeBytes?: number },
    at: number,
  ): void {
    // A single atomic UPDATE applying signed deltas to the rollup columns, each
    // clamped at zero (`MAX(0, col + ?)`) so a delta can never drive a count
    // negative — pre-existing drift or a double-applied removal must not underflow.
    //
    // This is one SQL statement, so it is inherently atomic without a surrounding
    // transaction: the read-and-write happen inside the engine, not across an
    // awaited get()/update() pair. That is the whole point — the callers that
    // RAISE the rollup (ingest re-sync, document create) previously read the row,
    // then wrote an absolute value computed from that stale read; a concurrent
    // delete's decrement (which is atomic) committing in the await window was then
    // clobbered by the stale-based absolute write, so chunk_count — the basis the
    // maxKnowledgeChunks quota sums — drifted below the true live sum and let the
    // corpus index past the cap. Expressing every mutation as an in-SQL signed
    // delta makes add and remove compose regardless of interleaving.
    this.db.run(
      `UPDATE datasets
          SET document_count = MAX(0, document_count + ?),
              chunk_count    = MAX(0, chunk_count + ?),
              size_bytes     = MAX(0, size_bytes + ?),
              updated_at     = ?
        WHERE id = ?`,
      [delta.documentCount ?? 0, delta.chunkCount ?? 0, delta.sizeBytes ?? 0, at, datasetId],
    );
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
    ...(readOptionalString(row, 'processing_token') === undefined
      ? {}
      : { processingToken: readOptionalString(row, 'processing_token')! }),
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
    processing_token: writeOptional(document.processingToken),
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
    processingToken: { column: 'processing_token' },
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

  updateSync(id: string, patch: Partial<Document>): Document {
    // `patch` is already synchronous; this exposes it under the interface name the
    // sync-core convention uses, so a caller can compose a document row change and
    // a dependent rollup delta into one `Store.transaction`.
    return this.patch(id, patch);
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

  removeSync(id: string): boolean {
    const result = this.db.run('DELETE FROM documents WHERE id = ?', [id]);
    return result.changes > 0;
  }

  claimForProcessing(id: string, token: string, at: number): boolean {
    // Atomic pending→processing claim: exactly one caller wins the row. The
    // predicate `status = 'pending'` is the serialization point — a second worker
    // (another replica, or a retry) whose UPDATE affects 0 rows lost the claim and
    // must not ingest, or both would apply the chunk-rollup delta and permanently
    // double-count. Mirrors receipts.claimNext. The `token` is stamped so the final
    // commit can verify this worker still owns the row: if the stuck-processing
    // reaper requeued it (clearing the token) and another worker re-claimed it (new
    // token), this worker's commit will find its token gone and discard its work.
    const result = this.db.run(
      `UPDATE documents SET status = 'processing', processing_token = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      [token, at, id],
    );
    return result.changes > 0;
  }

  finalizeIfOwnedSync(id: string, token: string, patch: Partial<Document>): boolean {
    // Apply a terminal ingestion write (ready/failed + counts) ONLY if this worker
    // still owns the `processing` row under its claim token. A worker slower than
    // the stuck-processing recovery window may have been requeued and re-claimed by
    // another worker; without this gate it would commit a second time and
    // double-count the chunk rollup. The token is cleared as part of the write, so
    // the row leaves `processing` cleanly. Returns whether this worker's write won.
    const { clause, values } = buildUpdate(patch as Record<string, unknown>, documentSpec.updateMapping);
    // `processing_token = NULL` is appended unconditionally so a terminal write
    // always clears ownership; callers pass the status/counts in `patch`.
    const setClause = clause === '' ? 'processing_token = NULL' : `${clause}, processing_token = NULL`;
    const result = this.db.run(
      `UPDATE documents SET ${setClause} WHERE id = ? AND status = 'processing' AND processing_token = ?`,
      [...values, id, token],
    );
    return result.changes > 0;
  }

  requeueIfProcessingSync(id: string, staleBefore: number, at: number): boolean {
    // Requeue a stuck row to `pending` and clear its ownership token, but ONLY if
    // it is still `processing` AND still stale (`updated_at < staleBefore`).
    // `findStaleProcessing` applies the staleness filter at READ time; re-asserting
    // it in the write closes a cross-replica TOCTOU: between the reaper's stale-scan
    // read and this write, the owning worker could complete (→ ready), a re-sync
    // flip it to pending, and a fresh worker re-claim it (a NEW `updated_at`). A
    // status-only predicate would clobber that freshly-claimed row back to pending
    // (disowning the new worker → a wasted re-ingest). Gating on `updated_at`
    // means a row touched since the scan is left alone: only a genuinely still-stale
    // row is requeued.
    const result = this.db.run(
      `UPDATE documents SET status = 'pending', processing_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND updated_at < ?`,
      [at, id, staleBefore],
    );
    return result.changes > 0;
  }

  deleteForDataset(datasetId: string): Promise<void> {
    this.db.run('DELETE FROM documents WHERE dataset_id = ?', [datasetId]);
    return Promise.resolve();
  }

  findPending(limit: number): Promise<Document[]> {
    return Promise.resolve(
      this.findMany([condition("status = 'pending'")], {
        orderBy: 'created_at',
        limit,
        // The ingestion worker runs this up to five times per scheduler tick, and
        // the only other documents index is dataset_id-leading. Force the partial
        // pending index so it scans the un-ingested backlog, not the whole
        // (ever-growing) documents table. See migration 15.
        indexedBy: 'idx_documents_pending',
      }),
    );
  }

  findReady(limit: number, afterId?: string): Promise<Document[]> {
    // Ordered by id, not created_at: the id is a ULID (creation-ordered) and
    // unique, so it is a stable keyset cursor — two documents created in the same
    // millisecond cannot make a page boundary skip or repeat a row the way a
    // created_at cursor could.
    const conditions = [condition("status = 'ready'")];
    if (afterId !== undefined) conditions.push(condition('id > ?', afterId));
    return Promise.resolve(this.findMany(conditions, { orderBy: 'id', limit }));
  }

  findStaleProcessing(staleBefore: number, limit: number): Promise<Document[]> {
    // A document last touched (updated_at) before `staleBefore` while still
    // `processing` was owned by a worker that has since died — return it so a
    // recovery sweep can requeue it. Oldest first, so the longest-stuck are
    // recovered before newer ones. Runs on every scheduler tick, so force the
    // partial `processing` index (migration 18): it holds only the in-flight set
    // and serves both the updated_at range filter and the ORDER BY, instead of
    // full-scanning the ever-growing documents table.
    return Promise.resolve(
      this.findMany([condition("status = 'processing'"), condition('updated_at < ?', staleBefore)], {
        orderBy: 'updated_at',
        limit,
        indexedBy: 'idx_documents_processing',
      }),
    );
  }

  findFailed(limit: number, maxAttempts?: number): Promise<Document[]> {
    // Documents that ended `failed` and are still ACTIONABLE by the reprocess
    // sweep — oldest first so the longest-waiting failures are retried first.
    //
    // The `error` column holds an ErrorInfo JSON and `metadata` an object with
    // `ingestAttempts`. Permanently-dead rows — a non-retryable failure, or one
    // that exhausted `maxAttempts` — are excluded HERE, at the query, not merely
    // skipped in the engine after the fetch. That distinction is load-bearing:
    // this is a capped (`limit`) oldest-first window, so if >= `limit` dead rows
    // accumulate, an engine-side skip returns the same dead rows every tick and
    // requeues nothing — a genuinely-transient failure (newer, retryable) never
    // enters the window and dead-ends `failed` forever, deployment-wide. Filtering
    // at the query keeps the window full of rows the sweep can actually act on.
    // The retry POLICY (the `maxAttempts` value) still lives with the caller; only
    // its application to the selection is pushed into SQL. Still an indexed
    // `status='failed'` scan (partial index, migration 18); the JSON predicates
    // filter the already-narrow failed set.
    const conditions = [condition("status = 'failed'")];
    // Keep only retryable failures (a missing error is treated as retryable, the
    // pre-existing engine default). `json_extract` returns 1 for JSON `true`.
    conditions.push(
      condition("(error IS NULL OR json_extract(error, '$.retryable') = 1)"),
    );
    // Drop rows that have already burned their attempt budget.
    if (maxAttempts !== undefined) {
      conditions.push(
        condition("COALESCE(json_extract(metadata, '$.ingestAttempts'), 0) < ?", maxAttempts),
      );
    }
    return Promise.resolve(
      this.findMany(conditions, {
        orderBy: 'updated_at',
        limit,
        indexedBy: 'idx_documents_failed',
      }),
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

  list(page: PageRequest & { subjectPrefix?: string }): Promise<Page<Principal>> {
    const conditions: Condition[] =
      page.subjectPrefix === undefined
        ? []
        : // Escape LIKE metacharacters in the prefix so a literal `_`/`%`/`\` in a
          // provider id matches literally, then anchor with `%` for a prefix scan
          // (uses the UNIQUE index on `subject`).
          [condition('subject LIKE ? ESCAPE \'\\\'', `${escapeLikePrefix(page.subjectPrefix)}%`)];
    return Promise.resolve(this.page(conditions, page));
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
// Resource grants
// ---------------------------------------------------------------------------

export class SqliteResourceGrantRepository implements ResourceGrantRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  upsert(grant: ResourceGrant): Promise<ResourceGrant> {
    // One grant per (workspace, principal, resource): a re-grant replaces the
    // role rather than accumulating rows, so resolution reads at most one.
    this.#db.run(
      `INSERT INTO resource_grants (id, workspace_id, principal_id, resource_kind, resource_id,
                                    role, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, principal_id, resource_kind, resource_id)
       DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      [
        grant.id,
        grant.workspaceId,
        grant.principalId,
        grant.resourceKind,
        grant.resourceId,
        grant.role,
        grant.createdAt,
        grant.updatedAt,
        grant.createdBy,
      ],
    );
    return Promise.resolve(grant);
  }

  find(input: {
    workspaceId: string;
    principalId: string;
    resourceKind: string;
    resourceId: string;
  }): Promise<ResourceGrant | undefined> {
    const row = this.#db.get(
      `SELECT * FROM resource_grants
        WHERE workspace_id = ? AND principal_id = ? AND resource_kind = ? AND resource_id = ?`,
      [input.workspaceId, input.principalId, input.resourceKind, input.resourceId],
    );
    return Promise.resolve(row ? this.#fromRow(row) : undefined);
  }

  listForWorkspace(workspaceId: string): Promise<ResourceGrant[]> {
    const rows = this.#db.all(
      'SELECT * FROM resource_grants WHERE workspace_id = ? ORDER BY id ASC',
      [workspaceId],
    );
    return Promise.resolve(rows.map((row) => this.#fromRow(row)));
  }

  delete(id: string, workspaceId: string): Promise<boolean> {
    // Scoped to the workspace: the id alone is not enough to authorize a delete,
    // because authorization ran against the caller's workspace, not the grant's.
    const result = this.#db.run('DELETE FROM resource_grants WHERE id = ? AND workspace_id = ?', [
      id,
      workspaceId,
    ]);
    return Promise.resolve(result.changes > 0);
  }

  #fromRow(row: Row): ResourceGrant {
    return {
      id: readString(row, 'id'),
      workspaceId: readString(row, 'workspace_id'),
      principalId: readString(row, 'principal_id'),
      resourceKind: readString(row, 'resource_kind') as ResourceGrant['resourceKind'],
      resourceId: readString(row, 'resource_id'),
      role: readString(row, 'role') as ResourceGrant['role'],
      createdAt: readNumber(row, 'created_at'),
      updatedAt: readNumber(row, 'updated_at'),
      createdBy: readString(row, 'created_by'),
    };
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

  /**
   * Append an entry, extending the tamper-evident hash chain.
   *
   * The read-of-head and the insert happen inside one `transaction`, so under
   * `BEGIN IMMEDIATE`'s write lock no other append can interleave and fork the
   * chain — the same serialization the event log relies on for its sequence
   * numbers. The head (last seq + last hash) lives in its own one-row table, not
   * derived from `MAX(seq)`, so retention pruning the oldest rows never resets
   * the chain.
   */
  append(entry: AuditEntry): Promise<AuditEntry> {
    this.#db.transaction(() => {
      const head = this.#db.get(
        'SELECT last_seq, last_hash FROM audit_chain_head WHERE id = 1',
      );
      const prevSeq = toNumber(head?.last_seq);
      const prevHash = typeof head?.last_hash === 'string' ? head.last_hash : '';
      const seq = prevSeq + 1;
      const entryHash = auditEntryHash(entry, prevHash);

      this.#db.run(
        `INSERT INTO audit_entries (id, workspace_id, principal_id, action, resource_kind,
                                    resource_id, outcome, reason, request_id, source_ip, details, at,
                                    seq, prev_hash, entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          seq,
          prevHash,
          entryHash,
        ],
      );

      const updated = this.#db.run(
        'UPDATE audit_chain_head SET last_seq = ?, last_hash = ? WHERE id = 1',
        [seq, entryHash],
      );
      // The head row must exist and advance on every append. If it does not (a
      // deleted/missing head), the next append would recompute seq=1 and, with a
      // unique seq index, the insert would fail — but fail loudly here first so
      // the transaction rolls the orphaned insert back rather than leaving a row
      // whose head never moved.
      if (updated.changes !== 1) {
        throw internalError('audit chain head is missing; cannot append');
      }
    });
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

  /**
   * Prune entries older than `before`, recording a checkpoint so the chain stays
   * verifiable across retention.
   *
   * Retention is expressed in wall-clock time ("keep N days"), but pruning is by
   * seq-PREFIX, not by a raw `at < before` sweep. We delete only the maximal
   * contiguous run of oldest rows that are ALL expired: the largest K such that
   * every row with `seq <= K` has `at < before`. Concretely K = (the smallest seq
   * whose `at >= before`) − 1 — because that seq is the *minimum* still-live one,
   * every lower seq is necessarily expired.
   *
   * Why not delete every `at < before` row: `at` is stamped from the wall clock
   * (`clock.now()`), which NTP steps / DST / a manual set can move backwards, so
   * `at` is not monotonic with `seq`. A raw time-cutoff delete would then remove a
   * *skewed* old row from the middle while retaining newer-`at` rows below it —
   * stranding a retained row below the prune watermark, where `verifyChain`
   * exempts it from linkage checks and it becomes silently deletable/forgeable. A
   * prefix delete keeps the watermark invariant ("everything at/below it is gone")
   * true, so no live row is ever linkage-exempt. A skewed expired row above the
   * prefix simply lingers past its window until the prefix catches up — the safe
   * direction. Mirrors `events.prune`'s head-truncation contract. One transaction
   * so the checkpoint and delete cannot diverge.
   */
  prune(before: number): Promise<number> {
    const changes = this.#db.transaction(() => {
      // The smallest seq that is NOT yet expired — the first row to keep. Every
      // seq below it is expired (it is the minimum live seq), so `firstKept - 1`
      // is the largest all-expired prefix boundary.
      const firstKept = this.#db.get(
        'SELECT seq FROM audit_entries WHERE at >= ? ORDER BY seq ASC LIMIT 1',
        [before],
      );
      // No live row → everything is expired; the prefix is the whole table.
      const boundarySeqLimit =
        firstKept === undefined
          ? toNumber(this.#db.get('SELECT MAX(seq) AS seq FROM audit_entries')?.seq)
          : toNumber(firstKept.seq) - 1;
      if (!Number.isFinite(boundarySeqLimit) || boundarySeqLimit < 1) return 0;

      // The highest-seq row in the deleted prefix is the checkpoint the live chain
      // re-anchors to.
      const boundary = this.#db.get(
        'SELECT seq, entry_hash FROM audit_entries WHERE seq <= ? ORDER BY seq DESC LIMIT 1',
        [boundarySeqLimit],
      );
      const result = this.#db.run('DELETE FROM audit_entries WHERE seq <= ?', [boundarySeqLimit]);
      if (boundary && result.changes > 0) {
        const boundarySeq = toNumber(boundary.seq);
        const boundaryHash = typeof boundary.entry_hash === 'string' ? boundary.entry_hash : '';
        // Advance the high-water mark monotonically — never move it backwards, so
        // a later prune with an earlier cutoff cannot lower the anchor.
        this.#db.run(
          `UPDATE audit_chain_head
             SET pruned_through_seq = ?, pruned_through_hash = ?
             WHERE id = 1 AND ? > pruned_through_seq`,
          [boundarySeq, boundaryHash, boundarySeq],
        );
      }
      return result.changes;
    });
    return Promise.resolve(changes);
  }

  verifyChain(): Promise<ChainVerification> {
    const head = this.#db.get(
      `SELECT last_seq, last_hash, pruned_through_seq, pruned_through_hash
         FROM audit_chain_head WHERE id = 1`,
    );
    const prunedThroughSeq = toNumber(head?.pruned_through_seq);
    const prunedThroughHash = typeof head?.pruned_through_hash === 'string' ? head.pruned_through_hash : '';
    // The live chain — everything above the prune high-water mark — must link
    // contiguously from the pruned checkpoint to the head. Because pruning is now
    // by seq-PREFIX (see `prune`), the watermark is a true deleted-prefix boundary:
    // every RETAINED row sits above it, in this linkage-verified live zone, so a
    // deletion breaks contiguity and a (recomputed) content forgery breaks the
    // next row's prev-hash link — both caught. The only rows that can appear at or
    // below the mark are the pre-chain legacy prefix (empty hashes, skipped below);
    // a genuine row can no longer be stranded there and slip past linkage checks.
    let expectedPrev = prunedThroughHash;
    let expectedSeq = prunedThroughSeq + 1;
    let checked = 0;

    // Stream in chain order. `seq` is gap-free and monotonic for the live chain.
    const rows = this.#db.all('SELECT * FROM audit_entries ORDER BY seq ASC');
    for (const row of rows) {
      const seq = toNumber(row.seq);
      const storedPrev = typeof row.prev_hash === 'string' ? row.prev_hash : '';
      const storedHash = typeof row.entry_hash === 'string' ? row.entry_hash : '';
      const id = readString(row, 'id');

      // Content integrity is unconditional for CHAINED rows: recomputing the hash
      // from the row's own stored prev_hash must reproduce what was stored, for
      // every surviving chained row. This is what catches a `denied`→`allowed`
      // edit regardless of prune state — the most important audit guarantee.
      //
      // Pre-chain legacy rows are exempt: migration 10 added `entry_hash`/
      // `prev_hash` with DEFAULT '' and assigned seq to the rows that pre-dated
      // the chain, but it never computed their hashes (it cannot — the pre-image
      // is gone). Such a row has both hashes empty; recomputing a real hash for it
      // would never equal '' and would falsely report tampering on any install
      // that upgraded across migration 10. They carry no linkage either, so they
      // are the legacy prefix below the chain and are skipped entirely.
      if (storedHash === '' && storedPrev === '') continue;

      const recomputed = auditEntryHash(this.#fromRow(row), storedPrev);
      if (recomputed !== storedHash) {
        return Promise.resolve({
          ok: false,
          checked,
          brokenAtSeq: seq,
          brokenId: id,
          reason: `entry_hash at seq ${seq} does not match its contents — the row was modified after it was written`,
        });
      }

      // Rows in the pruned zone are content-verified above but not part of the
      // live linkage (retention is removing that zone).
      if (seq <= prunedThroughSeq) continue;

      // Live zone: seq must be contiguous and each row must link to the prior one.
      if (seq !== expectedSeq) {
        return Promise.resolve({
          ok: false,
          checked,
          brokenAtSeq: expectedSeq,
          reason: `expected seq ${expectedSeq} but found ${seq} — a live entry was deleted or reordered`,
        });
      }
      if (storedPrev !== expectedPrev) {
        return Promise.resolve({
          ok: false,
          checked,
          brokenAtSeq: seq,
          brokenId: id,
          reason: `prev_hash at seq ${seq} does not link to the previous entry — a row was inserted, deleted or reordered`,
        });
      }

      expectedPrev = storedHash;
      expectedSeq = seq + 1;
      checked++;
    }

    // The endpoint check — without it, deleting the newest rows (a tail
    // truncation that erases recent actions) leaves every survivor linking
    // cleanly and passes. The head records the last seq/hash ever appended,
    // maintained on every write, so the live walk must arrive exactly there.
    const lastSeq = toNumber(head?.last_seq);
    const lastHash = typeof head?.last_hash === 'string' ? head.last_hash : '';
    if (expectedSeq - 1 !== lastSeq || expectedPrev !== lastHash) {
      return Promise.resolve({
        ok: false,
        checked,
        brokenAtSeq: expectedSeq,
        reason:
          `the chain ends at seq ${expectedSeq - 1} but the recorded head is seq ${lastSeq} — ` +
          `the most recent entries were truncated`,
      });
    }

    return Promise.resolve({ ok: true, checked });
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

/**
 * The hash of one audit entry, chained to the previous entry's hash.
 *
 * Over a canonical serialization of the entry's business fields (never the
 * chain columns — `seq`/`prev_hash`/`entry_hash` are the chain, not content)
 * folded together with the previous hash, so each link commits to both its own
 * contents and everything before it. `canonicalJson` sorts keys recursively, so
 * the hash is stable no matter how the row round-tripped through the database.
 */
export function auditEntryHash(entry: AuditEntry, prevHash: string): string {
  const material = canonicalJson({
    id: entry.id,
    workspaceId: entry.workspaceId ?? null,
    principalId: entry.principalId,
    action: entry.action,
    resourceKind: entry.resourceKind,
    resourceId: entry.resourceId,
    outcome: entry.outcome,
    reason: entry.reason,
    requestId: entry.requestId,
    sourceIp: entry.sourceIp,
    // `details` is stored as JSON text and read back via JSON.parse, so hashing
    // it must use the *reparsed* form too — otherwise a value JSON.stringify
    // transforms but canonicalize does not (a Date → ISO string, anything with a
    // toJSON, undefined → null) would hash one way at append and another at
    // verify, reporting a legitimately-written row as tampered. Normalizing
    // through the same parse∘stringify the database round-trip applies makes
    // append-time and verify-time material identical by construction.
    details: normalizeJson(entry.details),
    at: entry.at,
  });
  return sha256Hex(`${prevHash}\n${material}`);
}

/** The value as it survives a JSON text round-trip — what the database stores and reads back. */
function normalizeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
   *
   * `leaseMs` is the *in-flight* lease, deliberately short (minutes), NOT the
   * retention window: a reservation abandoned by a hard crash between here and
   * `complete`/`release` must self-heal quickly rather than return a misleading
   * "still in flight" 409 for the whole retention TTL. `complete` then extends the
   * expiry to the full retention window, so a completed record still replays for
   * as long as intended. The lease must exceed the longest legitimate time a
   * handler holds the reservation, or a slow-but-live request could be reclaimed
   * and its side effect run twice.
   */
  reserve(
    key: string,
    scope: string,
    now: number,
    leaseMs: number,
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
        [key, scope, now, now + leaseMs],
      );
      return { reserved: true as const };
    });
    return Promise.resolve(outcome);
  }

  /**
   * Record the original response and promote the reservation's short in-flight
   * lease to the full retention window.
   *
   * `reserve` gives a fresh reservation only a short lease, so an abandoned
   * request (crash/eviction between reserve and here) self-heals in minutes
   * instead of blocking its key for the whole retention TTL. A *completed* record
   * must outlive that lease — it is the replay answer for the retention window —
   * so completing it pushes `expires_at` out to `at + retentionTtlMs`.
   */
  complete(
    key: string,
    scope: string,
    statusCode: number,
    response: string,
    at: number,
    retentionTtlMs: number,
    requestHash?: string,
  ): Promise<void> {
    this.#db.run(
      `UPDATE idempotency_keys
          SET status_code = ?, response = ?, completed_at = ?, expires_at = ?, request_hash = ?
        WHERE key = ? AND scope = ?`,
      [statusCode, response, at, at + retentionTtlMs, requestHash ?? null, key, scope],
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

// ---------------------------------------------------------------------------
// Daily usage counter
// ---------------------------------------------------------------------------

export class SqliteUsageRepository implements UsageRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  addTokens(
    workspaceId: string,
    utcDay: number,
    inputTokens: number,
    outputTokens: number,
    costMicros: number,
  ): Promise<void> {
    // Atomic upsert-add: the first billed usage of the day inserts the row, every
    // later one accumulates onto it. Called inside `recordUsage`'s transaction, so
    // the counters and the session-usage row commit or roll back together.
    this.#db.run(
      `INSERT INTO usage_daily (workspace_id, utc_day, input_tokens, output_tokens, cost_micros)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, utc_day) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cost_micros = cost_micros + excluded.cost_micros`,
      [workspaceId, utcDay, inputTokens, outputTokens, costMicros],
    );
    return Promise.resolve();
  }

  tokensToday(workspaceId: string, utcDay: number): Promise<number> {
    const row = this.#db.get(
      'SELECT input_tokens + output_tokens AS value FROM usage_daily WHERE workspace_id = ? AND utc_day = ?',
      [workspaceId, utcDay],
    );
    return Promise.resolve(Number(row?.value ?? 0));
  }

  costToday(workspaceId: string, utcDay: number): Promise<number> {
    const row = this.#db.get(
      'SELECT cost_micros AS value FROM usage_daily WHERE workspace_id = ? AND utc_day = ?',
      [workspaceId, utcDay],
    );
    return Promise.resolve(Number(row?.value ?? 0));
  }

  reserveDaily(
    workspaceId: string,
    utcDay: number,
    estTokens: number,
    estMicros: number,
    tokenLimit: number,
    costLimit: number,
  ): Promise<{ admitted: boolean; dimension?: 'tokensPerDay' | 'costPerDay'; tokensUsed: number; costUsed: number }> {
    // Atomically admit-and-reserve, or refuse, under BEGIN IMMEDIATE — so N
    // concurrent completions cannot all observe the same under-cap snapshot and
    // race past the cap. The gate counts billed + already-reserved: a call is
    // admitted only if billed_tokens + reserved_tokens + est <= tokenLimit (and the
    // same for cost when costLimit > 0). `costLimit === 0` means unlimited cost
    // (opt-in), matching the pre-existing gate. On admission the estimate is added
    // to the reserved columns and released at settle. Must run inside a store
    // transaction; the enclosing `store.transaction` provides the write lock.
    const outcome = this.#db.transaction(() => {
      const row = this.#db.get(
        `SELECT input_tokens + output_tokens AS tokens, cost_micros AS cost,
                reserved_tokens AS rtokens, reserved_micros AS rmicros
           FROM usage_daily WHERE workspace_id = ? AND utc_day = ?`,
        [workspaceId, utcDay],
      );
      const tokensUsed = Number(row?.tokens ?? 0);
      const costUsed = Number(row?.cost ?? 0);
      const reservedTokens = Number(row?.rtokens ?? 0);
      const reservedMicros = Number(row?.rmicros ?? 0);

      if (tokensUsed + reservedTokens + estTokens > tokenLimit) {
        return { admitted: false, dimension: 'tokensPerDay' as const, tokensUsed, costUsed };
      }
      if (costLimit > 0 && costUsed + reservedMicros + estMicros > costLimit) {
        return { admitted: false, dimension: 'costPerDay' as const, tokensUsed, costUsed };
      }

      // Admit: hold the estimate. Upsert so the day's first call creates the row.
      this.#db.run(
        `INSERT INTO usage_daily (workspace_id, utc_day, input_tokens, output_tokens, cost_micros, reserved_tokens, reserved_micros)
         VALUES (?, ?, 0, 0, 0, ?, ?)
         ON CONFLICT(workspace_id, utc_day) DO UPDATE SET
           reserved_tokens = reserved_tokens + excluded.reserved_tokens,
           reserved_micros = reserved_micros + excluded.reserved_micros`,
        [workspaceId, utcDay, estTokens, estMicros],
      );
      return { admitted: true, tokensUsed, costUsed };
    });
    return Promise.resolve(outcome);
  }

  releaseDaily(workspaceId: string, utcDay: number, estTokens: number, estMicros: number): Promise<void> {
    // Release a held reservation (at settle, or on a failed completion). Clamped at
    // 0 with MAX so a double-release or a reservation lost to a crash-and-rollover
    // can never drive the counter negative. Called inside the settle transaction
    // where the real usage is folded, so release + bill commit together.
    this.#db.run(
      `UPDATE usage_daily
          SET reserved_tokens = MAX(0, reserved_tokens - ?),
              reserved_micros = MAX(0, reserved_micros - ?)
        WHERE workspace_id = ? AND utc_day = ?`,
      [estTokens, estMicros, workspaceId, utcDay],
    );
    return Promise.resolve();
  }

  usageBetween(workspaceId: string, fromDay: number, toDay: number): Promise<UsageDay[]> {
    const rows = this.#db.all(
      `SELECT utc_day, input_tokens, output_tokens, cost_micros
         FROM usage_daily
        WHERE workspace_id = ? AND utc_day BETWEEN ? AND ?
        ORDER BY utc_day ASC`,
      [workspaceId, fromDay, toDay],
    );
    return Promise.resolve(
      rows.map((row) => ({
        utcDay: Number(row.utc_day),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        costMicros: Number(row.cost_micros),
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// Durable billing-dedup markers
// ---------------------------------------------------------------------------

export class SqliteBilledTurnRepository implements BilledTurnRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  mark(sessionId: string, sandboxId: string, turn: number, at: number): void {
    // Idempotent: a turn is billed once even though a multi-call tool loop marks
    // it on every /completions iteration. `INSERT OR IGNORE` on the (session,
    // sandbox, turn) primary key keeps the first mark's timestamp. Must run inside
    // the fold's transaction so the marker and the usage commit together.
    this.#db.run(
      'INSERT OR IGNORE INTO billed_turns (session_id, sandbox_id, turn, at) VALUES (?, ?, ?, ?)',
      [sessionId, sandboxId, turn, at],
    );
  }

  consume(sessionId: string, sandboxId: string, turn: number): boolean {
    // Atomic check-and-delete: DELETE reports how many rows it removed, so the
    // "did the marker exist?" read and its removal are one statement — two
    // concurrent reports of the same turn cannot both see it present. Scoped to the
    // sandbox generation, so a stale marker from an earlier generation of the same
    // session can never match. Must run inside the report-fold's transaction so the
    // decision and the fold are one unit (a marker consumed here, then a fold that
    // rolls back, would lose the dedup and let a retry double-bill).
    const result = this.#db.run(
      'DELETE FROM billed_turns WHERE session_id = ? AND sandbox_id = ? AND turn = ?',
      [sessionId, sandboxId, turn],
    );
    return result.changes > 0;
  }

  has(sessionId: string, sandboxId: string, turn: number): boolean {
    // Non-destructive existence check, for a dedup that must be *idempotent* rather
    // than one-shot: a turn.completed report keyed by turn dedups against the marker
    // WITHOUT removing it, so a second report of the same turn (a buggy/foreign
    // runtime posting the same turn twice, or two turn.completed in one batch) is
    // deduped too instead of billing again. Scoped to the sandbox generation like
    // `consume`. Must run inside the report-fold's transaction.
    const row = this.#db.get(
      'SELECT 1 FROM billed_turns WHERE session_id = ? AND sandbox_id = ? AND turn = ?',
      [sessionId, sandboxId, turn],
    );
    return row !== undefined;
  }

  clearSession(sessionId: string): void {
    this.#db.run('DELETE FROM billed_turns WHERE session_id = ?', [sessionId]);
  }

  prune(before: number): Promise<number> {
    const result = this.#db.run('DELETE FROM billed_turns WHERE at < ?', [before]);
    return Promise.resolve(result.changes);
  }
}
