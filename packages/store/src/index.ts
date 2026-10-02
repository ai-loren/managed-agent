/**
 * `@ma/store` — persistence.
 *
 * Services depend on the repository interfaces; the SQLite driver is the
 * reference implementation and the one tests run against. The Postgres driver
 * runs the same repositories, translating their SQL.
 */

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type AgentFilter,
  type AgentRepository,
  type AgentTemplateFilter,
  type AgentTemplateRepository,
  type AgentVersionRepository,
  type ApiKeyRepository,
  type AuditFilter,
  type AuditRepository,
  type BilledTurnRepository,
  TURNLESS_BILLED_TURN,
  type BindingRepository,
  type ConnectorFilter,
  type ConnectorRepository,
  type CredentialFilter,
  type CredentialRepository,
  type DatasetFilter,
  type DatasetRepository,
  type DocumentFilter,
  type DocumentRepository,
  type EventReadOptions,
  type EventRepository,
  type EventSearchResult,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type ModelRepository,
  type Page,
  type PageRequest,
  type PrincipalRepository,
  type ReceiptFilter,
  type PullLeaseRepository,
  type ApprovalFilter,
  type ApprovalOutcome,
  type ApprovalRepository,
  type SessionAttachment,
  type SessionAttachmentRepository,
  type ReceiptRepository,
  type SandboxFilter,
  type SandboxRepository,
  type SessionFilter,
  type SessionRepository,
  type Store,
  type TransactionFn,
  type UsageDay,
  type UsageRepository,
  type WorkspaceFilter,
  type WorkspaceRepository,
} from './repository.ts';

export { MIGRATIONS, migrationChecksum, type Migration } from './migrations.ts';

export { Database, openDatabase, type DatabaseOptions, type SqlDatabase } from './database.ts';

export {
  PgDatabase,
  describeDatabase,
  isPostgresUrl,
  parsePostgresUrl,
  readPasswordFile,
  type PgDatabaseOptions,
} from './postgres/bridge.ts';

export { auditEntryHash } from './sqlite/resources.ts';

export {
  SqliteStore,
  createMemoryStore,
  createPostgresStore,
  createSqliteStore,
  type SqliteStoreOptions,
} from './sqlite/store.ts';
