/**
 * `@ma/engine` — the control plane.
 */

export {
  ACTIONS,
  ROLE_ORDER,
  RoleAuthorizer,
  requireActivePrincipal,
  type Action,
  type AuthContext,
  type AuthorizeOptions,
  type Authorizer,
} from './authz.ts';

export {
  QuotaService,
  type AdmissionResult,
  type QuotaDimension,
  type QuotaUsage,
} from './quota.ts';

export {
  EventBus,
  type EventInput,
  type SubscribeOptions,
  type Subscription,
} from './event-bus.ts';

export {
  AgentService,
  BaseService,
  WorkspaceService,
  type CreateAgentInput,
  type CreateWorkspaceInput,
  type ServiceDeps,
  type VersionDiff,
} from './agents.ts';

export {
  SessionService,
  type CreateSessionInput,
  type SessionProvisioner,
  type SessionServiceDeps,
} from './sessions.ts';

export {
  CredentialService,
  type CreateCredentialInput,
  type CredentialServiceDeps,
} from './credentials.ts';

export {
  IngestionPipeline,
  KeywordIndex,
  RetrievalService,
  chunkText,
  type Chunk,
  type ChunkIndex,
  type ChunkOptions,
  type Embedder,
  type IngestionOptions,
  type RetrievalOptions,
  type SearchResult,
} from './knowledge.ts';

export {
  ArtifactService,
  FilesystemBlobStore,
  MemoryBlobStore,
  sanitizePath,
  sniffContentType,
  type ArtifactServiceOptions,
  type BlobStore,
  type FilesystemBlobStoreOptions,
  type PublishRequest,
} from './artifacts.ts';

export {
  CapabilityService,
  GitResolver,
  MemoryArtifactStore,
  RegistryResolver,
  UploadResolver,
  type ArtifactStore,
  type CapabilityArtifact,
  type CapabilityResolver,
  type CapabilityServiceOptions,
  type GitFetcher,
  type InstallPlan,
} from './capabilities.ts';
