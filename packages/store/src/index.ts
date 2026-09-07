/**
 * `@ma/store` — persistence.
 *
 * Services depend on the repository interfaces; the SQLite driver is the
 * reference implementation and the one tests run against.
 */

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type AgentFilter,
  type AgentRepository,
  type AgentVersionRepository,
  type ApiKeyRepository,
  type AuditFilter,
  type AuditRepository,
  type BindingRepository,
  type ConnectorFilter,
  type ConnectorRepository,
  type CredentialFilter,
  type CredentialRepository,
  type DatasetFilter,
  type DatasetRepository,
  type DocumentFilter,
  type DocumentRepository,
  type EventRepository,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type ModelRepository,
  type Page,
  type PageRequest,
  type PrincipalRepository,
  type ReceiptFilter,
  type ReceiptRepository,
  type SandboxFilter,
  type SandboxRepository,
  type SessionFilter,
  type SessionRepository,
  type Store,
  type TransactionFn,
  type WorkspaceFilter,
  type WorkspaceRepository,
} from './repository.ts';

export { MIGRATIONS, migrationChecksum, type Migration } from './migrations.ts';

export { Database, openDatabase, type DatabaseOptions } from './database.ts';

export {
  SqliteStore,
  createMemoryStore,
  createSqliteStore,
  type SqliteStoreOptions,
} from './sqlite/store.ts';
