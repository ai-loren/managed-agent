/**
 * `@ma/sdk` — the typed client.
 */

export {
  ManagedAgentClient,
  type ClientOptions,
  type Page,
  type PageRequest,
} from './client.ts';

// Re-exported so a consumer types against the platform's own model rather than
// redeclaring it.
export type {
  Agent,
  AgentVersion,
  Credential,
  Model,
  Session,
  SessionEvent,
  SessionStatus,
  UniversalEvent,
  Workspace,
  WorkspaceRole,
} from '@ma/contracts';

export { MaError } from '@ma/core';
