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
