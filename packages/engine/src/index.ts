/**
 * `@ma/engine` — the control plane.
 */

export {
  ACTIONS,
  ROLE_ORDER,
  RoleAuthorizer,
  requireActivePrincipal,
  scopeAllows,
  type Action,
  type AuthContext,
  type AuthorizeOptions,
  type Authorizer,
} from './authz.ts';

export {
  QuotaService,
  secondsUntilDailyReset,
  utcDayStart,
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
  type RebindOutcome,
  type SessionProvisioner,
  type SessionServiceDeps,
} from './sessions.ts';
export { ApprovalService, type ApprovalRequest, type ApprovalServiceDeps } from './approvals.ts';

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
  previewContentType,
  type ArtifactServiceOptions,
  type BlobStore,
  type FilesystemBlobStoreOptions,
  type PublishRequest,
  type UploadRequest,
} from './artifacts.ts';

export { sessionFiles, type SessionFile } from './attachments.ts';

export {
  MemoryService,
  hashContent,
  type MemoryServiceOptions,
  type RememberRequest,
} from './memory.ts';

export {
  TemplateService,
  resolveVariables,
  substitute,
  type CreateTemplateInput,
  type UpdateTemplateInput,
  type InstantiateInput,
} from './templates.ts';

export {
  PreviewService,
  type PreviewOptions,
  type PreviewToken,
} from './preview.ts';

export {
  OidcService,
  type OidcServiceDeps,
  type FetchLike,
  type LoginResult,
  type AuthorizationRedirect,
} from './oidc.ts';

export { federatedSubject } from './federation.ts';

export {
  ScimService,
  ScimError,
  type ScimServiceDeps,
  type ScimUser,
} from './scim.ts';

export {
  CapabilityService,
  FilesystemArtifactStore,
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
export { ShellGitFetcher, type ShellGitFetcherOptions } from './git-fetcher.ts';
