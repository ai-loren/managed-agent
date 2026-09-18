/**
 * Request-body schemas.
 *
 * One home for every `POST`/`PATCH`/`PUT` body the gateway parses, shared by the
 * route handlers that validate against them and the OpenAPI generator that
 * documents them. That sharing is the point: a hand-written spec beside a
 * hand-written validator is two descriptions of one API that agree only until
 * someone edits one. Response and entity schemas already come from a single
 * declaration; these are the request side of the same guarantee, so a documented
 * body cannot drift from the one the server actually accepts.
 *
 * The generator renders each of these with `.toJsonSchema()`; the handlers run
 * each through `parseOrThrow`. Neither owns the shape.
 */

import {
  array,
  boolean,
  enumOf,
  id,
  integer,
  object,
  optional,
  record,
  string,
  unknown,
  withDefault,
} from '@ma/contracts';

// --- sessions --------------------------------------------------------------

export const createSessionBody = object({
  agentId: string({ nonBlank: true }),
  title: optional(string({ maxLength: 256 })),
  agentVersion: optional(
    integer({ min: 1, description: 'Pin explicitly; otherwise the production pin, else the latest.' }),
  ),
  credentialIds: optional(array(string())),
  ttlSeconds: optional(integer({ min: 60, max: 604_800 })),
  metadata: optional(record(string({ maxLength: 1024 }))),
});

export const renewSessionBody = object({
  /** Bounded like the create path: a TTL is a promise to release, not a lease forever. */
  ttlSeconds: integer({ min: 60, max: 604_800 }),
});

/**
 * A reason-only body, shared by every operation whose entire payload is an
 * optional operator justification (session interrupt/terminate, receipt retry).
 */
export const reasonBody = object({
  reason: withDefault(string({ maxLength: 1000 }), ''),
});

// --- workspaces ------------------------------------------------------------

export const createWorkspaceBody = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  slug: string({ pattern: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/ }),
  description: optional(string({ maxLength: 2000 })),
  systemPrompt: optional(
    string({
      maxLength: 20_000,
      description: 'Prepended to every member agent’s prompt — org policy lives here.',
    }),
  ),
});

export const updateWorkspaceBody = object({
  name: optional(string({ minLength: 1, maxLength: 128 })),
  description: optional(string({ maxLength: 2000 })),
  systemPrompt: optional(string({ maxLength: 20_000 })),
});

export const membersBody = object({
  members: array(
    object({
      principalId: string({ nonBlank: true }),
      role: enumOf(['owner', 'admin', 'developer', 'operator', 'viewer'] as const),
    }),
  ),
});

/**
 * Change a workspace's quota limits. Every dimension is optional — a caller
 * raising one limit need not restate the rest, and `updateQuota` merges over the
 * current values. Bounds mirror the entity schema so an out-of-range limit is
 * refused at parse.
 */
export const updateQuotaBody = object({
  maxConcurrentSessions: optional(integer({ min: 0 })),
  maxSandboxes: optional(integer({ min: 0 })),
  maxTokensPerDay: optional(integer({ min: 0 })),
  maxCostMicrosPerDay: optional(integer({ min: 0 })),
  maxStorageMb: optional(integer({ min: 0 })),
  maxAgents: optional(integer({ min: 0 })),
  maxKnowledgeChunks: optional(integer({ min: 0 })),
  eventRetentionDays: optional(integer({ min: 1, max: 3650 })),
});

/** Grant a principal a role on one specific resource. */
export const grantResourceRoleBody = object({
  principalId: string({ nonBlank: true }),
  resourceKind: enumOf(['agent', 'dataset', 'connector', 'credential', 'template'] as const),
  resourceId: string({ minLength: 1, maxLength: 64, nonBlank: true }),
  role: enumOf(['owner', 'admin', 'developer', 'operator', 'viewer'] as const),
});

// --- agents ----------------------------------------------------------------

export const createAgentBody = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: optional(string({ maxLength: 2000 })),
  labels: withDefault(array(string({ maxLength: 64 })), () => []),
  // An agent spec is a nested document (model config, tool policy, sandbox
  // spec), not a flat string map. It is validated in full by the version
  // schema in the engine, so accepting an object here rather than
  // re-describing that structure keeps one source of truth.
  spec: optional(
    object({}, {
      passthrough: true,
      description: 'An optional first version, so the agent is usable immediately.',
    }),
  ),
});

export const updateAgentBody = object({
  name: optional(string({ minLength: 1, maxLength: 128 })),
  description: optional(string({ maxLength: 2000 })),
  labels: optional(array(string({ maxLength: 64 }))),
  productionVersion: optional(
    integer({ min: 1, description: 'New sessions pin this instead of the latest version.' }),
  ),
});

export const createVersionBody = object({
  spec: object({}, { passthrough: true }),
  baseVersion: optional(integer({ min: 1 })),
  changeSummary: optional(string({ maxLength: 1000 })),
  replace: withDefault(boolean('Write a full snapshot instead of merging.'), false),
});

// --- credentials -----------------------------------------------------------

export const createCredentialBody = object({
  ownerType: enumOf(['workspace', 'agent', 'session', 'principal'] as const),
  ownerId: optional(string()),
  type: enumOf(['api_key', 'oauth_token', 'bearer_token', 'env_vars', 'file', 'ssh_key', 'basic_auth'] as const),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: optional(string({ maxLength: 1000 })),
  value: string({ minLength: 1, description: 'Never returned by any endpoint.' }),
  expiresAt: optional(integer({ min: 0 })),
  valueKeys: optional(array(string({ maxLength: 128 }))),
});

// --- memories --------------------------------------------------------------

export const createMemoryBody = object({
  content: string({ minLength: 1, maxLength: 2000, nonBlank: true }),
  scope: optional(enumOf(['workspace', 'agent'] as const)),
  agentId: optional(string({ nonBlank: true })),
  kind: optional(enumOf(['fact', 'preference', 'procedure'] as const)),
  /**
   * A human may write a memory they do not want injected yet. Defaults to
   * true in the service — a person writing one generally means it to be used.
   */
  injectable: optional(boolean()),
});

export const updateMemoryBody = object({
  content: optional(string({ minLength: 1, maxLength: 2000, nonBlank: true })),
  kind: optional(enumOf(['fact', 'preference', 'procedure'] as const)),
});

export const promoteMemoryBody = object({
  injectable: boolean(),
});

// --- templates -------------------------------------------------------------

export const templateVariableBody = object({
  key: string({ minLength: 1, maxLength: 64, nonBlank: true }),
  label: withDefault(string({ maxLength: 128 }), ''),
  description: withDefault(string({ maxLength: 1000 }), ''),
  type: withDefault(enumOf(['string', 'number', 'boolean', 'enum'] as const), 'string' as const),
  required: withDefault(boolean(), false),
  options: withDefault(array(string({ maxLength: 256 })), () => [] as string[]),
  default: optional(unknown()),
});

export const createTemplateBody = object({
  name: string({ minLength: 1, maxLength: 200, nonBlank: true }),
  description: optional(string({ maxLength: 2000 })),
  category: optional(string({ maxLength: 64 })),
  spec: record(unknown(), 'Agent spec with {{variable}} placeholders'),
  variables: optional(array(templateVariableBody)),
});

export const updateTemplateBody = object({
  name: optional(string({ minLength: 1, maxLength: 200, nonBlank: true })),
  description: optional(string({ maxLength: 2000 })),
  category: optional(string({ maxLength: 64 })),
  spec: optional(record(unknown())),
  variables: optional(array(templateVariableBody)),
});

export const instantiateTemplateBody = object({
  agentName: optional(string({ minLength: 1, maxLength: 200 })),
  description: optional(string({ maxLength: 2000 })),
  labels: optional(array(string({ maxLength: 128 }))),
  variables: optional(record(unknown(), 'Values for the template’s variables')),
});

// --- connectors ------------------------------------------------------------

export const createConnectorBody = object({
  type: enumOf(['webhook', 'chat', 'hook', 'schedule', 'eventbus'] as const),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: optional(string({ maxLength: 1000 })),
  agentId: optional(string()),
  externalKey: string({
    minLength: 1,
    maxLength: 128,
    nonBlank: true,
    description: 'Immutable after creation: external systems point at it.',
  }),
  sessionPolicy: withDefault(
    enumOf(['new_per_event', 'reuse_per_scope', 'reuse_connector'] as const),
    'new_per_event' as const,
  ),
  config: withDefault(record(unknown()), () => ({})),
  secretCredentialId: optional(string()),
});

export const updateConnectorBody = object({
  name: optional(string({ minLength: 1, maxLength: 128 })),
  description: optional(string({ maxLength: 1000 })),
  agentId: optional(string()),
  sessionPolicy: optional(enumOf(['new_per_event', 'reuse_per_scope', 'reuse_connector'] as const)),
  config: optional(record(unknown())),
  secretCredentialId: optional(string()),
  // Note the absence of `externalKey`: it is immutable because external systems
  // are configured to point at it.
});

export const connectorStatusBody = object({
  status: enumOf(['active', 'disabled', 'archived', 'draft'] as const),
  reason: withDefault(string({ maxLength: 1000 }), ''),
});

// --- datasets --------------------------------------------------------------

export const createDatasetBody = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: optional(string({ maxLength: 2000 })),
  embeddingModel: optional(string({ maxLength: 128 })),
});

export const createDocumentBody = object({
  name: string({ minLength: 1, maxLength: 512, nonBlank: true }),
  source: withDefault(enumOf(['file', 'url', 'external_doc', 'inline'] as const), 'inline' as const),
  sourceRef: withDefault(string({ maxLength: 2048 }), ''),
  contentType: withDefault(string({ maxLength: 128 }), 'text/plain'),
  content: optional(string({ maxLength: 5_000_000 })),
  syncRule: withDefault(enumOf(['manual', 'hourly', 'daily', 'realtime'] as const), 'manual' as const),
});

export const bindDatasetsBody = object({
  datasetIds: array(id('dataset')),
});
