/**
 * Schema migrations.
 *
 * Migrations are ordered, immutable, and applied inside a transaction with a
 * recorded checksum. The checksum matters: editing a migration that has already
 * run in production is the single most common way a schema silently diverges
 * between environments, so we detect it and refuse to start.
 *
 * SQL is written for SQLite first and kept close to portable. Where a dialect
 * genuinely differs (autoincrement, upsert syntax), the driver adapts rather
 * than the migration branching.
 */

export interface Migration {
  /** Monotonic. Gaps are allowed; order is by this number. */
  id: number;
  name: string;
  /** Statements applied in order, all inside one transaction. */
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    statements: [
      // --- tenancy ------------------------------------------------------
      `CREATE TABLE workspaces (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL,
        members       TEXT NOT NULL DEFAULT '[]',
        quota         TEXT NOT NULL DEFAULT '{}',
        system_prompt TEXT NOT NULL DEFAULT '',
        metadata      TEXT NOT NULL DEFAULT '{}',
        archived_at   INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        created_by    TEXT NOT NULL
      )`,
      `CREATE INDEX idx_workspaces_status ON workspaces(status, id)`,

      `CREATE TABLE principals (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        subject      TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        email        TEXT NOT NULL DEFAULT '',
        is_admin     INTEGER NOT NULL DEFAULT 0,
        disabled     INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER,
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        created_by   TEXT NOT NULL
      )`,

      `CREATE TABLE api_keys (
        id           TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
        workspace_id TEXT,
        name         TEXT NOT NULL,
        prefix       TEXT NOT NULL,
        -- Only the hash is stored; the token is shown once at creation.
        token_hash   TEXT NOT NULL UNIQUE,
        scopes       TEXT NOT NULL DEFAULT '[]',
        expires_at   INTEGER,
        last_used_at INTEGER,
        revoked_at   INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        created_by   TEXT NOT NULL
      )`,
      `CREATE INDEX idx_api_keys_principal ON api_keys(principal_id)`,

      // --- agents -------------------------------------------------------
      `CREATE TABLE agents (
        id                 TEXT PRIMARY KEY,
        workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL,
        latest_version     INTEGER NOT NULL DEFAULT 0,
        production_version INTEGER,
        labels             TEXT NOT NULL DEFAULT '[]',
        metadata           TEXT NOT NULL DEFAULT '{}',
        archived_at        INTEGER,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        created_by         TEXT NOT NULL
      )`,
      `CREATE INDEX idx_agents_workspace ON agents(workspace_id, status, id)`,

      // Versions are immutable; the primary key enforces one row per number,
      // which is what makes the compare-and-set version bump safe.
      `CREATE TABLE agent_versions (
        agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version        INTEGER NOT NULL,
        base_version   INTEGER,
        change_summary TEXT NOT NULL DEFAULT '',
        spec           TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        created_by     TEXT NOT NULL,
        PRIMARY KEY (agent_id, version)
      )`,

      // --- sessions -----------------------------------------------------
      `CREATE TABLE sessions (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        resolved_version INTEGER NOT NULL,
        title            TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL,
        origin           TEXT NOT NULL DEFAULT 'api',
        sandbox_id       TEXT,
        credential_ids   TEXT NOT NULL DEFAULT '[]',
        last_seq         INTEGER NOT NULL DEFAULT 0,
        turn_count       INTEGER NOT NULL DEFAULT 0,
        usage            TEXT NOT NULL DEFAULT '{}',
        expires_at       INTEGER,
        started_at       INTEGER,
        last_activity_at INTEGER,
        ended_at         INTEGER,
        archived_at      INTEGER,
        error            TEXT,
        metadata         TEXT NOT NULL DEFAULT '{}',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        created_by       TEXT NOT NULL
      )`,
      `CREATE INDEX idx_sessions_agent ON sessions(agent_id, status, id)`,
      `CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, status, id)`,
      // Drives the expiry reaper; partial so it stays small as sessions end.
      `CREATE INDEX idx_sessions_expiry ON sessions(expires_at)
         WHERE expires_at IS NOT NULL AND ended_at IS NULL`,

      // The event log. (session_id, seq) is the primary key, so a duplicate
      // sequence is impossible even if two writers race.
      `CREATE TABLE events (
        session_id   TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        id           TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        type         TEXT NOT NULL,
        turn         INTEGER,
        item_id      TEXT,
        payload      TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      )`,
      `CREATE INDEX idx_events_type ON events(session_id, type, seq)`,
      `CREATE INDEX idx_events_turn ON events(session_id, turn, seq)`,

      // --- sandboxes ----------------------------------------------------
      `CREATE TABLE sandboxes (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        status            TEXT NOT NULL,
        endpoint          TEXT NOT NULL DEFAULT '',
        spec              TEXT NOT NULL DEFAULT '{}',
        -- Hash of (image, resources, network, setup, credentials): two sessions
        -- may share a warm sandbox only when this matches.
        pool_key          TEXT NOT NULL,
        session_ids       TEXT NOT NULL DEFAULT '[]',
        lease_expires_at  INTEGER NOT NULL,
        last_heartbeat_at INTEGER,
        released_at       INTEGER,
        error             TEXT,
        provider_ref      TEXT NOT NULL DEFAULT '',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        created_by        TEXT NOT NULL
      )`,
      // Serves pool claims: find a ready sandbox for a pool key by lease.
      `CREATE INDEX idx_sandboxes_pool ON sandboxes(pool_key, status, lease_expires_at)`,
      `CREATE INDEX idx_sandboxes_lease ON sandboxes(status, lease_expires_at)`,
      `CREATE INDEX idx_sandboxes_workspace ON sandboxes(workspace_id, status)`,

      // --- credentials --------------------------------------------------
      `CREATE TABLE credentials (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_type   TEXT NOT NULL,
        owner_id     TEXT NOT NULL DEFAULT '',
        type         TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL,
        -- Envelope-encrypted. Never returned through any read API.
        sealed       TEXT NOT NULL,
        key_version  TEXT NOT NULL,
        expires_at   INTEGER,
        last_used_at INTEGER,
        value_keys   TEXT NOT NULL DEFAULT '[]',
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        created_by   TEXT NOT NULL
      )`,
      `CREATE INDEX idx_credentials_owner ON credentials(workspace_id, owner_type, owner_id)`,
      `CREATE INDEX idx_credentials_expiry ON credentials(expires_at)
         WHERE expires_at IS NOT NULL`,

      // --- connectors ---------------------------------------------------
      `CREATE TABLE connectors (
        id                   TEXT PRIMARY KEY,
        workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type                 TEXT NOT NULL,
        name                 TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        status               TEXT NOT NULL,
        agent_id             TEXT,
        -- Immutable after creation: external systems point at this key.
        external_key         TEXT NOT NULL,
        session_policy       TEXT NOT NULL DEFAULT 'new_per_event',
        config               TEXT NOT NULL DEFAULT '{}',
        secret_credential_id TEXT,
        owner_principal_id   TEXT NOT NULL,
        next_fire_at         INTEGER,
        last_delivery_at     INTEGER,
        error                TEXT,
        metadata             TEXT NOT NULL DEFAULT '{}',
        archived_at          INTEGER,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        created_by           TEXT NOT NULL,
        UNIQUE (workspace_id, external_key)
      )`,
      `CREATE INDEX idx_connectors_workspace ON connectors(workspace_id, type, status)`,
      // Drives the schedule tick.
      `CREATE INDEX idx_connectors_due ON connectors(status, next_fire_at)
         WHERE next_fire_at IS NOT NULL`,

      `CREATE TABLE bindings (
        id                TEXT PRIMARY KEY,
        connector_id      TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        workspace_id      TEXT NOT NULL,
        scope_type        TEXT NOT NULL,
        -- Hashed: an external scope key can itself be sensitive.
        scope_key_hash    TEXT NOT NULL,
        scope_label       TEXT NOT NULL DEFAULT '',
        active_session_id TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        last_delivery_at  INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        created_by        TEXT NOT NULL,
        UNIQUE (connector_id, scope_key_hash)
      )`,

      `CREATE TABLE receipts (
        id                TEXT PRIMARY KEY,
        connector_id      TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
        workspace_id      TEXT NOT NULL,
        binding_id        TEXT,
        external_event_id TEXT NOT NULL,
        status            TEXT NOT NULL,
        session_id        TEXT,
        attempt           INTEGER NOT NULL DEFAULT 0,
        max_attempts      INTEGER NOT NULL DEFAULT 5,
        next_attempt_at   INTEGER,
        lease_expires_at  INTEGER,
        started_at        INTEGER,
        completed_at      INTEGER,
        error             TEXT,
        payload_summary   TEXT NOT NULL DEFAULT '',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        created_by        TEXT NOT NULL,
        -- The idempotency guarantee: one receipt per external event.
        UNIQUE (connector_id, external_event_id)
      )`,
      `CREATE INDEX idx_receipts_connector ON receipts(connector_id, status, id)`,
      // Serves both claiming due work and reaping expired leases.
      `CREATE INDEX idx_receipts_due ON receipts(status, next_attempt_at)`,
      `CREATE INDEX idx_receipts_lease ON receipts(status, lease_expires_at)`,

      // --- datasets -----------------------------------------------------
      `CREATE TABLE datasets (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL,
        document_count  INTEGER NOT NULL DEFAULT 0,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        size_bytes      INTEGER NOT NULL DEFAULT 0,
        embedding_model TEXT NOT NULL DEFAULT '',
        metadata        TEXT NOT NULL DEFAULT '{}',
        archived_at     INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        created_by      TEXT NOT NULL
      )`,
      `CREATE INDEX idx_datasets_workspace ON datasets(workspace_id, status)`,

      `CREATE TABLE documents (
        id             TEXT PRIMARY KEY,
        dataset_id     TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        workspace_id   TEXT NOT NULL,
        name           TEXT NOT NULL,
        source         TEXT NOT NULL,
        source_ref     TEXT NOT NULL DEFAULT '',
        content_type   TEXT NOT NULL DEFAULT 'text/plain',
        size_bytes     INTEGER NOT NULL DEFAULT 0,
        digest         TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL,
        sync_rule      TEXT NOT NULL DEFAULT 'manual',
        last_synced_at INTEGER,
        chunk_count    INTEGER NOT NULL DEFAULT 0,
        error          TEXT,
        metadata       TEXT NOT NULL DEFAULT '{}',
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        created_by     TEXT NOT NULL
      )`,
      `CREATE INDEX idx_documents_dataset ON documents(dataset_id, status, id)`,

      // --- model catalogue ----------------------------------------------
      `CREATE TABLE models (
        id                       TEXT PRIMARY KEY,
        provider                 TEXT NOT NULL,
        model                    TEXT NOT NULL,
        display_name             TEXT NOT NULL DEFAULT '',
        enabled                  INTEGER NOT NULL DEFAULT 1,
        context_window_tokens    INTEGER NOT NULL,
        max_output_tokens        INTEGER NOT NULL,
        compact_threshold_tokens INTEGER NOT NULL,
        capabilities             TEXT NOT NULL DEFAULT '{}',
        pricing                  TEXT NOT NULL DEFAULT '{}',
        security_level           TEXT NOT NULL DEFAULT '',
        allowed_workspace_ids    TEXT NOT NULL DEFAULT '[]'
      )`,

      // --- audit ----------------------------------------------------------
      `CREATE TABLE audit_entries (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT,
        principal_id  TEXT NOT NULL,
        action        TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id   TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        reason        TEXT NOT NULL DEFAULT '',
        request_id    TEXT NOT NULL DEFAULT '',
        source_ip     TEXT NOT NULL DEFAULT '',
        details       TEXT NOT NULL DEFAULT '{}',
        at            INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_audit_workspace ON audit_entries(workspace_id, at)`,
      `CREATE INDEX idx_audit_resource ON audit_entries(resource_id, at)`,
      `CREATE INDEX idx_audit_principal ON audit_entries(principal_id, at)`,

      // --- idempotency ------------------------------------------------------
      // A reserved row with no status_code means a request is still in flight;
      // a completed row lets a retry replay the original response.
      `CREATE TABLE idempotency_keys (
        key          TEXT NOT NULL,
        scope        TEXT NOT NULL,
        status_code  INTEGER,
        response     TEXT,
        created_at   INTEGER NOT NULL,
        completed_at INTEGER,
        expires_at   INTEGER NOT NULL,
        PRIMARY KEY (key, scope)
      )`,
      `CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at)`,
    ],
  },
  {
    id: 2,
    name: 'sandbox_runtime_token',
    statements: [
      // A sandbox authenticates back to the control plane with a runtime token.
      // That binding lived only in a process-local map, which meant it did not
      // survive a restart and did not exist at all in the process that had not
      // provisioned the sandbox — so in any multi-process deployment every
      // runtime call failed with "Unknown runtime token".
      //
      // Only the hash is stored. A leaked database row should not be a working
      // credential, and the control plane never needs the token itself: it
      // hashes what the caller presents and compares.
      `ALTER TABLE sandboxes ADD COLUMN runtime_token_hash TEXT NOT NULL DEFAULT ''`,
      // Serves authentication: hash → sandbox, on every runtime call.
      `CREATE INDEX idx_sandboxes_runtime_token ON sandboxes(runtime_token_hash)`,
    ],
  },
  {
    id: 3,
    name: 'idempotency_request_hash',
    statements: [
      // An Idempotency-Key identifies one request. Reusing it for a different
      // body used to replay the first request's response, so a caller received
      // a 200 describing a resource it had not asked for. Storing the body's
      // fingerprint lets that be refused instead. Nullable: rows written before
      // this migration have no hash and are replayed as before rather than
      // being rejected on an absent value.
      `ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT`,
    ],
  },
  {
    id: 4,
    name: 'artifacts',
    statements: [
      `CREATE TABLE artifacts (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn         INTEGER,
        -- The agent's declared label. Display only: blobs are addressed by
        -- digest, so a traversal string here can never reach a filesystem.
        path         TEXT NOT NULL,
        -- Sniffed from the bytes. The uploader's declared type is deliberately
        -- not stored, because it reaches a Content-Type header on download.
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        -- SHA-256 over the bytes actually received, so a row can only ever
        -- name content this workspace really uploaded.
        digest       TEXT NOT NULL,
        status       TEXT NOT NULL,
        expires_at   INTEGER,
        purged_at    INTEGER,
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        created_by   TEXT NOT NULL,
        -- The same bytes at the same path in one session is one artifact, so an
        -- upload retried after a dropped connection returns the original row
        -- rather than charging storage quota twice.
        UNIQUE (session_id, path, digest)
      )`,
      `CREATE INDEX idx_artifacts_session ON artifacts(session_id, created_at)`,
      `CREATE INDEX idx_artifacts_workspace ON artifacts(workspace_id, status, created_at)`,
      // Serves the storage-quota sum, which runs on every upload.
      `CREATE INDEX idx_artifacts_size ON artifacts(workspace_id, status, size_bytes)`,
      // Serves the retention sweep; partial so it stays small as rows age out.
      `CREATE INDEX idx_artifacts_expiry ON artifacts(expires_at)
         WHERE expires_at IS NOT NULL AND purged_at IS NULL`,
    ],
  },
  {
    id: 5,
    name: 'memories',
    statements: [
      `CREATE TABLE memories (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        scope             TEXT NOT NULL,
        -- Set for an agent-scoped memory, null for a workspace one. Cascades,
        -- so deleting an agent takes what it remembered with it.
        agent_id          TEXT REFERENCES agents(id) ON DELETE CASCADE,
        kind              TEXT NOT NULL DEFAULT 'fact',
        content           TEXT NOT NULL,
        -- Who wrote it. The trust model rests on this, so it is never updated.
        origin            TEXT NOT NULL,
        -- Whether this may enter the system prompt. Only a human sets it.
        injectable        INTEGER NOT NULL DEFAULT 0,
        -- Provenance that survives promotion: which session an agent wrote it
        -- in, and which principal decided it could be injected.
        source_session_id TEXT,
        promoted_by       TEXT,
        promoted_at       INTEGER,
        content_hash      TEXT NOT NULL,
        metadata          TEXT NOT NULL DEFAULT '{}',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        created_by        TEXT NOT NULL,
        -- The same fact is remembered once per scope. agent_id is part of the
        -- key and is nullable, and SQLite treats NULLs as distinct in a UNIQUE
        -- index -- which is what we want here: a workspace memory and an agent
        -- memory with identical text are genuinely different facts.
        UNIQUE (workspace_id, agent_id, content_hash)
      )`,
      // Serves the recall query: a scope's memories, newest first.
      `CREATE INDEX idx_memories_scope ON memories(workspace_id, scope, agent_id, created_at)`,
      // Serves session-start injection, which reads only the injectable ones.
      `CREATE INDEX idx_memories_injectable ON memories(workspace_id, injectable, created_at)
         WHERE injectable = 1`,
    ],
  },
  {
    id: 6,
    name: 'agent_templates',
    statements: [
      `CREATE TABLE agent_templates (
        id           TEXT PRIMARY KEY,
        -- Null for a built-in template shared across every workspace; set for a
        -- workspace's own blueprint. Cascades, so a deleted workspace takes its
        -- templates with it while built-ins survive.
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        category     TEXT NOT NULL DEFAULT 'general',
        -- Whether the platform ships this one. Built-ins are read-only: update
        -- and delete refuse them, so a re-seed on the next boot cannot be
        -- silently shadowed by an edited copy.
        builtin      INTEGER NOT NULL DEFAULT 0,
        -- The agent spec with placeholder variables, opaque JSON: it is a
        -- valid AgentVersion only after substitution, so it is not validated as
        -- one at rest.
        spec         TEXT NOT NULL DEFAULT '{}',
        variables    TEXT NOT NULL DEFAULT '[]',
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        created_by   TEXT NOT NULL
      )`,
      // The catalogue listing: a workspace's own templates plus the built-ins,
      // grouped by category.
      `CREATE INDEX idx_templates_scope ON agent_templates(workspace_id, category, created_at)`,
      // Serves the built-in re-seed, which upserts by (builtin, name).
      `CREATE UNIQUE INDEX idx_templates_builtin_name ON agent_templates(name)
         WHERE builtin = 1`,
    ],
  },
  {
    id: 7,
    name: 'receipt_response_context',
    statements: [
      // Where to route a reply back to the source system (e.g. a chat channel
      // id). Persisted so the reply can be delivered after the turn completes,
      // which is a different moment than accept.
      `ALTER TABLE receipts ADD COLUMN response_context TEXT NOT NULL DEFAULT '{}'`,
    ],
  },
];

/**
 * Stable checksum of a migration's SQL, used to detect edits to already-applied
 * migrations. Whitespace is normalized so reformatting is not a false alarm,
 * but any semantic change is.
 */
export function migrationChecksum(migration: Migration): string {
  const normalized = migration.statements
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .join(';');
  // FNV-1a: short, dependency-free, and adequate for change detection (this is
  // not a security boundary — it catches mistakes, not attackers).
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
