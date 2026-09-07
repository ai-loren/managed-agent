/**
 * Domain entities.
 *
 * Each entity is declared once as a schema; its TypeScript type is inferred.
 * The rule that shapes this file: **configuration that affects execution lives
 * on an immutable `AgentVersion`, never on the mutable `Agent`.** Anything a
 * running session depends on must be frozen at resolution time, or a concurrent
 * edit silently changes what a session is doing halfway through.
 */

import {
  array,
  boolean,
  enumOf,
  id,
  integer,
  number,
  object,
  optional,
  record,
  refine,
  sha256,
  string,
  timestamp,
  unknown,
  withDefault,
  type Infer,
  type Schema,
} from './schema.ts';
import {
  CONNECTOR_STATUSES,
  DOCUMENT_STATUSES,
  RECEIPT_STATUSES,
  RESOURCE_STATUSES,
  SANDBOX_STATUSES,
  SESSION_STATUSES,
} from './lifecycle.ts';

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/**
 * Free-form labels. Typed as string→string because these are for humans and
 * search, not for behaviour. Anything that changes execution gets a real field:
 * JSON-encoded config smuggled through a metadata map is unvalidatable and
 * un-migratable, a mistake worth not repeating.
 */
export const metadataSchema = withDefault(record(string({ maxLength: 1024 })), () => ({}));

/**
 * Build a value from a schema whose fields all carry defaults, by parsing `{}`.
 *
 * This keeps defaults declared exactly once — in the schema — rather than
 * duplicated in a hand-written literal that silently drifts when a field is
 * added. Throws at module load if the schema is not in fact fully defaultable,
 * which turns a latent runtime gap into an immediate startup failure.
 */
function parseDefault<T>(schema: Schema<T>): T {
  const result = schema.parse({}, {}, []);
  if (!result.ok) {
    throw new Error(
      `Schema is not fully defaultable: ${result.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    );
  }
  return result.value;
}

export const auditFieldsSchema = {
  createdAt: timestamp('Epoch ms when the resource was created'),
  updatedAt: timestamp('Epoch ms of the last modification'),
  createdBy: string({ description: 'Principal id or subject that created this' }),
} as const;

/** A structured failure recorded on a resource row. */
export const errorInfoSchema = object({
  code: string({ nonBlank: true }),
  message: string(),
  details: withDefault(record(unknown()), () => ({})),
  occurredAt: timestamp(),
  /** Whether a retry could plausibly succeed — drives operator affordances. */
  retryable: withDefault(boolean(), false),
});
export type ErrorInfo = Infer<typeof errorInfoSchema>;

export const usageSchema = object({
  inputTokens: withDefault(integer({ min: 0 }), 0),
  outputTokens: withDefault(integer({ min: 0 }), 0),
  cacheReadTokens: withDefault(integer({ min: 0 }), 0),
  cacheWriteTokens: withDefault(integer({ min: 0 }), 0),
  /** Micro-units of account currency, integer to avoid float drift. */
  costMicros: withDefault(integer({ min: 0 }), 0),
});
export type Usage = Infer<typeof usageSchema>;

// ---------------------------------------------------------------------------
// Workspace — the tenancy boundary
// ---------------------------------------------------------------------------

export const WORKSPACE_ROLES = ['owner', 'admin', 'developer', 'operator', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const workspaceMemberSchema = object({
  principalId: id('principal'),
  role: enumOf(WORKSPACE_ROLES),
  addedAt: timestamp(),
});
export type WorkspaceMember = Infer<typeof workspaceMemberSchema>;

/**
 * Quota is per workspace because that is the unit of billing and of blast
 * radius. A runaway agent should exhaust its own team's budget, not the fleet's.
 */
export const quotaLimitsSchema = object({
  maxConcurrentSessions: withDefault(integer({ min: 0 }), 20),
  maxSandboxes: withDefault(integer({ min: 0 }), 20),
  maxTokensPerDay: withDefault(integer({ min: 0 }), 50_000_000),
  maxStorageMb: withDefault(integer({ min: 0 }), 10_240),
  maxAgents: withDefault(integer({ min: 0 }), 200),
  /** How long session events are retained before compaction. */
  eventRetentionDays: withDefault(integer({ min: 1, max: 3650 }), 90),
});
export type QuotaLimits = Infer<typeof quotaLimitsSchema>;

export const workspaceSchema = object({
  id: id('workspace'),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: withDefault(string({ maxLength: 2000 }), ''),
  /** Stable human-readable key, unique per deployment; usable in URLs. */
  slug: string({ pattern: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/ }),
  status: enumOf(RESOURCE_STATUSES),
  members: withDefault(array(workspaceMemberSchema), () => []),
  quota: withDefault(quotaLimitsSchema, () => parseDefault(quotaLimitsSchema)),
  /** Prepended to every member agent's prompt — org-wide policy lives here. */
  systemPrompt: withDefault(string({ maxLength: 20_000 }), ''),
  metadata: metadataSchema,
  archivedAt: optional(timestamp()),
  ...auditFieldsSchema,
});
export type Workspace = Infer<typeof workspaceSchema>;

// ---------------------------------------------------------------------------
// Capability references — skills, plugins, MCP servers, sub-agents
// ---------------------------------------------------------------------------

export const CAPABILITY_SOURCES = ['registry', 'upload', 'git', 'builtin'] as const;
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

/**
 * A pinned reference to a capability artifact.
 *
 * `digest` is mandatory and is what actually gets installed — the source fields
 * only describe where it came from. This makes an AgentVersion reproducible:
 * re-resolving `main` a month later cannot change what runs.
 */
export const capabilityRefSchema = object({
  /** Stable name, e.g. `code-review`. Unique within its version. */
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  source: enumOf(CAPABILITY_SOURCES),
  digest: sha256('SHA-256 of the resolved artifact; what actually gets installed'),
  version: withDefault(string({ maxLength: 64 }), ''),
  /** For `git`: the repository and the commit the digest was resolved from. */
  repo: optional(string({ maxLength: 512 })),
  ref: optional(string({ maxLength: 256 })),
  commit: optional(string({ pattern: /^[0-9a-f]{7,40}$/ })),
  description: withDefault(string({ maxLength: 1000 }), ''),
  /** Roll a capability change to a slice of sessions before committing to it. */
  experiment: optional(
    object({
      group: string({ maxLength: 64 }),
      variant: string({ maxLength: 64 }),
    }),
  ),
});
export type CapabilityRef = Infer<typeof capabilityRefSchema>;

export const MCP_TRANSPORTS = ['stdio', 'sse', 'http'] as const;

export const mcpServerSchema = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  transport: enumOf(MCP_TRANSPORTS),
  /** stdio: the executable and its arguments. */
  command: optional(string({ maxLength: 512 })),
  args: withDefault(array(string({ maxLength: 512 })), () => []),
  /** sse/http: the endpoint. */
  url: optional(string({ maxLength: 2048 })),
  /**
   * Environment for the server process. Values are credential *references*
   * (`${cred:cr_...}`), never literals — a literal here would be a secret in
   * plaintext inside a version row that is readable by anyone with view access.
   */
  env: withDefault(record(string({ maxLength: 512 })), () => ({})),
  enabled: withDefault(boolean(), true),
  /** Tools to expose; empty means all the server advertises. */
  toolAllowlist: withDefault(array(string({ maxLength: 128 })), () => []),
});
export type McpServer = Infer<typeof mcpServerSchema>;

export const subAgentSchema = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: string({ maxLength: 1000 }),
  systemPrompt: string({ maxLength: 50_000 }),
  /** Inherits the parent's model when absent. */
  modelId: optional(string({ maxLength: 256 })),
  /** Tools this sub-agent may use — a strict subset of the parent's. */
  tools: withDefault(array(string({ maxLength: 128 })), () => []),
  maxTurns: withDefault(integer({ min: 1, max: 200 }), 30),
});
export type SubAgent = Infer<typeof subAgentSchema>;

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

export const PERMISSION_MODES = ['strict', 'prompt', 'auto', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const toolPolicySchema = object({
  /**
   * `strict`: only allowlisted tools, no prompting (the right default for
   * unattended agents). `prompt`: ask a human. `auto`: everything not denied.
   * `plan`: read-only tools only.
   */
  mode: withDefault(enumOf(PERMISSION_MODES), 'strict' as const),
  allow: withDefault(array(string({ maxLength: 128 })), () => []),
  deny: withDefault(array(string({ maxLength: 128 })), () => []),
  /** Shell commands matched as prefixes; denial wins over allowance. */
  allowedCommands: withDefault(array(string({ maxLength: 512 })), () => []),
  deniedCommands: withDefault(array(string({ maxLength: 512 })), () => []),
});
export type ToolPolicy = Infer<typeof toolPolicySchema>;

export const contextPolicySchema = object({
  /** Compact when the context reaches this many tokens. */
  compactThresholdTokens: withDefault(integer({ min: 1000 }), 150_000),
  /** Target size after compaction. Must be below the threshold. */
  compactTargetTokens: withDefault(integer({ min: 500 }), 60_000),
  /** Keep this many recent turns verbatim; older ones may be summarized. */
  keepRecentTurns: withDefault(integer({ min: 1, max: 100 }), 6),
  /** Persist a resumable snapshot every N turns. 0 disables. */
  snapshotEveryTurns: withDefault(integer({ min: 0, max: 100 }), 5),
});
export type ContextPolicy = Infer<typeof contextPolicySchema>;

export const networkPolicySchema = object({
  /** Deny-by-default: the sandbox reaches only these hosts. */
  egress: withDefault(enumOf(['deny', 'allowlist', 'allow'] as const), 'allowlist' as const),
  allowedHosts: withDefault(array(string({ maxLength: 256 })), () => []),
});
export type NetworkPolicy = Infer<typeof networkPolicySchema>;

/**
 * Policy objects whose fields all have defaults are themselves defaulted, so a
 * caller supplying only `{ model }` still gets a fully-specified version. The
 * defaults are the *safe* end of each policy, never the permissive one.
 */
const defaultedNetworkPolicy = withDefault(networkPolicySchema, () => parseDefault(networkPolicySchema));

export const sandboxSpecSchema = object({
  image: withDefault(string({ maxLength: 512 }), 'managed-agent/runtime:latest'),
  cpu: withDefault(number({ min: 0.1, max: 64 }), 2),
  memoryMb: withDefault(integer({ min: 256, max: 262_144 }), 4096),
  diskMb: withDefault(integer({ min: 512, max: 1_048_576 }), 20_480),
  /** Idle time before the sandbox is reclaimed. */
  idleTimeoutSeconds: withDefault(integer({ min: 30, max: 86_400 }), 900),
  /** Hard ceiling on a single session's sandbox lifetime. */
  maxLifetimeSeconds: withDefault(integer({ min: 60, max: 604_800 }), 86_400),
  network: defaultedNetworkPolicy,
  /**
   * Commands run once at sandbox start, in order. A failure here fails the
   * session rather than leaving an agent in a half-provisioned environment.
   */
  setupCommands: withDefault(
    array(
      object({
        name: string({ minLength: 1, maxLength: 128 }),
        command: string({ minLength: 1, maxLength: 8192 }),
        timeoutSeconds: withDefault(integer({ min: 1, max: 3600 }), 300),
        /** When true, a non-zero exit is logged but does not fail startup. */
        optional: withDefault(boolean(), false),
      }),
    ),
    () => [],
  ),
  /** Reuse a warm sandbox across sequential sessions of the same spec. */
  allowReuse: withDefault(boolean(), true),
});
export type SandboxSpec = Infer<typeof sandboxSpecSchema>;

export const modelConfigSchema = object({
  /** `<provider>/<model>`, resolved against the model catalogue. */
  modelId: string({ minLength: 1, maxLength: 256, nonBlank: true }),
  /** Fallbacks tried in order when the primary is unavailable. */
  fallbackModelIds: withDefault(array(string({ maxLength: 256 })), () => []),
  temperature: optional(number({ min: 0, max: 2 })),
  maxOutputTokens: optional(integer({ min: 1, max: 200_000 })),
  reasoningEffort: optional(enumOf(['low', 'medium', 'high', 'xhigh', 'max'] as const)),
});
export type ModelConfig = Infer<typeof modelConfigSchema>;

// ---------------------------------------------------------------------------
// Agent and AgentVersion
// ---------------------------------------------------------------------------

export const agentSchema = object({
  id: id('agent'),
  workspaceId: id('workspace'),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: withDefault(string({ maxLength: 2000 }), ''),
  status: enumOf(RESOURCE_STATUSES),
  /**
   * Pointer to the newest version. Sessions resolve this once at creation and
   * then never look at it again.
   */
  latestVersion: integer({ min: 0 }),
  /** Optional pin: sessions default to this instead of `latestVersion`. */
  productionVersion: optional(integer({ min: 1 })),
  labels: withDefault(array(string({ maxLength: 64 })), () => []),
  metadata: metadataSchema,
  archivedAt: optional(timestamp()),
  ...auditFieldsSchema,
});
export type Agent = Infer<typeof agentSchema>;

/**
 * The immutable execution contract. Everything the runtime needs to reproduce a
 * run is here; nothing here can change after creation.
 */
export const agentVersionSchema = refine(
  object({
    agentId: id('agent'),
    version: integer({ min: 1 }),
    /** The version this was derived from — gives an edit history. */
    baseVersion: optional(integer({ min: 1 })),
    changeSummary: withDefault(string({ maxLength: 1000 }), ''),

    systemPrompt: withDefault(string({ maxLength: 200_000 }), ''),
    model: modelConfigSchema,
    tools: withDefault(toolPolicySchema, () => parseDefault(toolPolicySchema)),
    context: withDefault(contextPolicySchema, () => parseDefault(contextPolicySchema)),
    sandbox: withDefault(sandboxSpecSchema, () => parseDefault(sandboxSpecSchema)),

    skills: withDefault(array(capabilityRefSchema), () => []),
    plugins: withDefault(array(capabilityRefSchema), () => []),
    mcpServers: withDefault(array(mcpServerSchema), () => []),
    subAgents: withDefault(array(subAgentSchema), () => []),

    /** Credential ids the runtime may exchange for values. */
    credentialIds: withDefault(array(id('credential')), () => []),
    /** Datasets exposed to the agent via the retrieval tool. */
    datasetIds: withDefault(array(id('dataset')), () => []),

    /** Service-account identity the sandbox runs as. */
    runAs: withDefault(string({ maxLength: 256 }), ''),
    maxTurnsPerSession: withDefault(integer({ min: 1, max: 10_000 }), 200),

    metadata: metadataSchema,
    createdAt: timestamp(),
    createdBy: string(),
  }),
  (value) => {
    if (value.context.compactTargetTokens >= value.context.compactThresholdTokens) {
      return 'context.compactTargetTokens must be below context.compactThresholdTokens';
    }
    // Duplicate capability names would make installation order-dependent.
    for (const [label, list] of [
      ['skills', value.skills],
      ['plugins', value.plugins],
      ['mcpServers', value.mcpServers],
      ['subAgents', value.subAgents],
    ] as const) {
      const names = list.map((item) => item.name);
      if (new Set(names).size !== names.length) return `${label} contains duplicate names`;
    }
    for (const server of value.mcpServers) {
      if (server.transport === 'stdio' && !server.command) {
        return `mcpServers.${server.name} uses stdio transport and requires a command`;
      }
      if (server.transport !== 'stdio' && !server.url) {
        return `mcpServers.${server.name} uses ${server.transport} transport and requires a url`;
      }
    }
    return true;
  },
);
export type AgentVersion = Infer<typeof agentVersionSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SESSION_ORIGINS = ['api', 'console', 'cli', 'connector', 'schedule', 'subagent'] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

export const sessionSchema = object({
  id: id('session'),
  workspaceId: id('workspace'),
  agentId: id('agent'),
  /** Frozen at creation. A running session ignores later agent edits. */
  resolvedVersion: integer({ min: 1 }),
  title: withDefault(string({ maxLength: 256 }), ''),
  status: enumOf(SESSION_STATUSES),
  origin: withDefault(enumOf(SESSION_ORIGINS), 'api' as const),

  sandboxId: optional(id('sandbox')),
  /** Credentials granted to this session, on top of the version's. */
  credentialIds: withDefault(array(id('credential')), () => []),

  /** Highest event sequence written; the resume cursor and the fold's version. */
  lastSeq: withDefault(integer({ min: 0 }), 0),
  turnCount: withDefault(integer({ min: 0 }), 0),
  usage: withDefault(usageSchema, () => parseDefault(usageSchema)),

  /** Logical session lease, distinct from the sandbox lease. */
  expiresAt: optional(timestamp()),
  startedAt: optional(timestamp()),
  lastActivityAt: optional(timestamp()),
  endedAt: optional(timestamp()),
  archivedAt: optional(timestamp()),

  error: optional(errorInfoSchema),
  metadata: metadataSchema,
  ...auditFieldsSchema,
});
export type Session = Infer<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export const sandboxSchema = object({
  id: id('sandbox'),
  workspaceId: id('workspace'),
  provider: string({ minLength: 1, maxLength: 64 }),
  status: enumOf(SANDBOX_STATUSES),
  /** Agent Core base URL inside the sandbox. */
  endpoint: withDefault(string({ maxLength: 2048 }), ''),
  spec: sandboxSpecSchema,
  /**
   * Hash of (image, resources, network, setup, credential set). Two sessions
   * may share a warm sandbox only when this matches — it is the isolation key.
   */
  poolKey: string({ maxLength: 128 }),
  sessionIds: withDefault(array(id('session')), () => []),
  /** Heartbeat-renewed. Lapse means lost, not released. */
  leaseExpiresAt: timestamp(),
  lastHeartbeatAt: optional(timestamp()),
  releasedAt: optional(timestamp()),
  error: optional(errorInfoSchema),
  /** Opaque provider handle (container id, pod name). */
  providerRef: withDefault(string({ maxLength: 512 }), ''),
  /**
   * SHA-256 of the token the sandbox presents when calling back.
   *
   * Persisted rather than held in memory so the binding survives a restart and
   * is visible to every process, not just the one that provisioned it. Only the
   * hash: a leaked row must not be a usable credential.
   */
  runtimeTokenHash: withDefault(string({ maxLength: 64 }), ''),
  ...auditFieldsSchema,
});
export type Sandbox = Infer<typeof sandboxSchema>;

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

export const CREDENTIAL_OWNER_TYPES = ['workspace', 'agent', 'session', 'principal'] as const;
export type CredentialOwnerType = (typeof CREDENTIAL_OWNER_TYPES)[number];

export const CREDENTIAL_TYPES = [
  'api_key',
  'oauth_token',
  'bearer_token',
  'env_vars',
  'file',
  'ssh_key',
  'basic_auth',
] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * Note what is absent: the value. This schema describes what the API returns,
 * and the API never returns a credential value to a human client. The sealed
 * form lives in the store row only.
 */
export const credentialSchema = object({
  id: id('credential'),
  workspaceId: id('workspace'),
  ownerType: enumOf(CREDENTIAL_OWNER_TYPES),
  ownerId: string({ maxLength: 64 }),
  type: enumOf(CREDENTIAL_TYPES),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: withDefault(string({ maxLength: 1000 }), ''),
  status: enumOf(['active', 'expiring', 'expired', 'revoked'] as const),
  /** Which KEK sealed the value; lets keys rotate without a migration. */
  keyVersion: string({ maxLength: 32 }),
  expiresAt: optional(timestamp()),
  lastUsedAt: optional(timestamp()),
  /** Non-secret shape hint, e.g. the env var names an `env_vars` cred sets. */
  valueKeys: withDefault(array(string({ maxLength: 128 })), () => []),
  metadata: metadataSchema,
  ...auditFieldsSchema,
});
export type Credential = Infer<typeof credentialSchema>;

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

export const modelCapabilitiesSchema = object({
  tools: withDefault(boolean(), true),
  vision: withDefault(boolean(), false),
  reasoningEffort: withDefault(array(enumOf(['low', 'medium', 'high', 'xhigh', 'max'] as const)), () => []),
  promptCaching: withDefault(boolean(), false),
});

/** Micro-units per million tokens, integer so cost accumulation cannot drift. */
export const modelPricingSchema = object({
  inputMicrosPerMillion: withDefault(integer({ min: 0 }), 0),
  outputMicrosPerMillion: withDefault(integer({ min: 0 }), 0),
  cacheReadMicrosPerMillion: withDefault(integer({ min: 0 }), 0),
  cacheWriteMicrosPerMillion: withDefault(integer({ min: 0 }), 0),
});

export const modelSchema = object({
  /** `<provider>/<model>`. */
  id: string({ minLength: 3, maxLength: 256 }),
  provider: string({ minLength: 1, maxLength: 64 }),
  model: string({ minLength: 1, maxLength: 128 }),
  displayName: withDefault(string({ maxLength: 128 }), ''),
  enabled: withDefault(boolean(), true),
  contextWindowTokens: integer({ min: 1000 }),
  maxOutputTokens: integer({ min: 1 }),
  /** Where the runtime should compact; served here so agents inherit sane defaults. */
  compactThresholdTokens: integer({ min: 1000 }),
  capabilities: withDefault(modelCapabilitiesSchema, () => parseDefault(modelCapabilitiesSchema)),
  pricing: withDefault(modelPricingSchema, () => parseDefault(modelPricingSchema)),
  /** Data-classification ceiling; gates which workspaces may use the model. */
  securityLevel: withDefault(string({ maxLength: 16 }), ''),
  /** Empty means available to every workspace. */
  allowedWorkspaceIds: withDefault(array(id('workspace')), () => []),
});
export type Model = Infer<typeof modelSchema>;

// ---------------------------------------------------------------------------
// Connectors, bindings, receipts, schedules
// ---------------------------------------------------------------------------

export const CONNECTOR_TYPES = ['webhook', 'chat', 'hook', 'schedule', 'eventbus'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const SESSION_POLICIES = ['new_per_event', 'reuse_per_scope', 'reuse_connector'] as const;
export type SessionPolicy = (typeof SESSION_POLICIES)[number];

export const connectorSchema = object({
  id: id('connector'),
  workspaceId: id('workspace'),
  type: enumOf(CONNECTOR_TYPES),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: withDefault(string({ maxLength: 1000 }), ''),
  status: enumOf(CONNECTOR_STATUSES),
  /** Target agent. Required before activation. */
  agentId: optional(id('agent')),
  /**
   * Stable external identity, immutable after creation: the path segment a
   * webhook posts to, the chat app id, the schedule's key. Changing it would
   * silently orphan every external configuration pointing at it.
   */
  externalKey: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  sessionPolicy: withDefault(enumOf(SESSION_POLICIES), 'new_per_event' as const),
  /** Type-specific settings, validated by the adapter, never secret. */
  config: withDefault(record(unknown()), () => ({})),
  /** Reference to the credential holding the signing secret / app secret. */
  secretCredentialId: optional(id('credential')),
  ownerPrincipalId: id('principal'),
  lastDeliveryAt: optional(timestamp()),
  error: optional(errorInfoSchema),
  metadata: metadataSchema,
  archivedAt: optional(timestamp()),
  ...auditFieldsSchema,
});
export type Connector = Infer<typeof connectorSchema>;

/** Cron settings for a schedule connector, stored in `config`. */
export const scheduleConfigSchema = object({
  cron: refine(string({ nonBlank: true }), (value) =>
    value.trim().split(/\s+/).length === 5 ? true : 'must be a five-field cron expression',
  ),
  timezone: withDefault(string({ maxLength: 64 }), 'UTC'),
  /** Prompt submitted on each fire. */
  prompt: string({ minLength: 1, maxLength: 100_000 }),
  /** Skip a fire if the previous run is still going. */
  skipIfRunning: withDefault(boolean(), true),
  /** Ignore a fire this far past its scheduled time (clock catch-up guard). */
  misfireGraceSeconds: withDefault(integer({ min: 0, max: 86_400 }), 300),
  enabledFrom: optional(timestamp()),
  enabledUntil: optional(timestamp()),
});
export type ScheduleConfig = Infer<typeof scheduleConfigSchema>;

/**
 * Maps an external scope (a chat, a repo, a topic) to a connector, so one
 * connector can serve many scopes with independent session reuse.
 */
export const bindingSchema = object({
  id: id('binding'),
  connectorId: id('connector'),
  workspaceId: id('workspace'),
  scopeType: string({ minLength: 1, maxLength: 64 }),
  /** Hashed: a chat id or repo path can itself be sensitive. */
  scopeKeyHash: sha256(),
  /** Non-identifying label for operators. */
  scopeLabel: withDefault(string({ maxLength: 256 }), ''),
  /** Session reused under `reuse_per_scope`. */
  activeSessionId: optional(id('session')),
  enabled: withDefault(boolean(), true),
  lastDeliveryAt: optional(timestamp()),
  ...auditFieldsSchema,
});
export type Binding = Infer<typeof bindingSchema>;

/** One inbound delivery. The audit trail for "what did this trigger do?". */
export const receiptSchema = object({
  id: id('receipt'),
  connectorId: id('connector'),
  workspaceId: id('workspace'),
  bindingId: optional(id('binding')),
  /** Deduplication key from the source system; unique per connector. */
  externalEventId: string({ minLength: 1, maxLength: 256 }),
  status: enumOf(RECEIPT_STATUSES),
  sessionId: optional(id('session')),
  attempt: withDefault(integer({ min: 0 }), 0),
  maxAttempts: withDefault(integer({ min: 1 }), 5),
  nextAttemptAt: optional(timestamp()),
  /** Renewed by the worker; lapse promotes the receipt to `zombie`. */
  leaseExpiresAt: optional(timestamp()),
  startedAt: optional(timestamp()),
  completedAt: optional(timestamp()),
  error: optional(errorInfoSchema),
  /** Redacted summary of the inbound payload, for debugging. */
  payloadSummary: withDefault(string({ maxLength: 4000 }), ''),
  ...auditFieldsSchema,
});
export type Receipt = Infer<typeof receiptSchema>;

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export const DOCUMENT_SOURCES = ['file', 'url', 'external_doc', 'inline'] as const;
export const SYNC_RULES = ['manual', 'hourly', 'daily', 'realtime'] as const;

export const datasetSchema = object({
  id: id('dataset'),
  workspaceId: id('workspace'),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: withDefault(string({ maxLength: 2000 }), ''),
  status: enumOf(RESOURCE_STATUSES),
  documentCount: withDefault(integer({ min: 0 }), 0),
  chunkCount: withDefault(integer({ min: 0 }), 0),
  sizeBytes: withDefault(integer({ min: 0 }), 0),
  /** Chosen at creation; changing it would invalidate every stored vector. */
  embeddingModel: withDefault(string({ maxLength: 128 }), ''),
  metadata: metadataSchema,
  archivedAt: optional(timestamp()),
  ...auditFieldsSchema,
});
export type Dataset = Infer<typeof datasetSchema>;

export const documentSchema = object({
  id: id('document'),
  datasetId: id('dataset'),
  workspaceId: id('workspace'),
  name: string({ minLength: 1, maxLength: 512, nonBlank: true }),
  source: enumOf(DOCUMENT_SOURCES),
  /** URL or external document reference for non-file sources. */
  sourceRef: withDefault(string({ maxLength: 2048 }), ''),
  contentType: withDefault(string({ maxLength: 128 }), 'text/plain'),
  sizeBytes: withDefault(integer({ min: 0 }), 0),
  /** Content digest; an unchanged digest skips re-embedding on sync. */
  digest: withDefault(string({ maxLength: 64 }), ''),
  status: enumOf(DOCUMENT_STATUSES),
  syncRule: withDefault(enumOf(SYNC_RULES), 'manual' as const),
  lastSyncedAt: optional(timestamp()),
  chunkCount: withDefault(integer({ min: 0 }), 0),
  error: optional(errorInfoSchema),
  metadata: metadataSchema,
  ...auditFieldsSchema,
});
export type Document = Infer<typeof documentSchema>;

// ---------------------------------------------------------------------------
// Principals and API keys
// ---------------------------------------------------------------------------

export const PRINCIPAL_TYPES = ['user', 'service_account', 'connector'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const principalSchema = object({
  id: id('principal'),
  type: enumOf(PRINCIPAL_TYPES),
  subject: string({ minLength: 1, maxLength: 256 }),
  displayName: withDefault(string({ maxLength: 256 }), ''),
  email: withDefault(string({ maxLength: 320 }), ''),
  /** Bypasses workspace membership checks. Granted sparingly. */
  isAdmin: withDefault(boolean(), false),
  disabled: withDefault(boolean(), false),
  lastSeenAt: optional(timestamp()),
  metadata: metadataSchema,
  ...auditFieldsSchema,
});
export type Principal = Infer<typeof principalSchema>;

export const apiKeySchema = object({
  id: id('apiKey'),
  principalId: id('principal'),
  workspaceId: optional(id('workspace')),
  name: string({ minLength: 1, maxLength: 128 }),
  /** First characters of the token, for identification in lists. */
  prefix: string({ maxLength: 16 }),
  /** SHA-256 of the token. The token itself is shown exactly once. */
  tokenHash: sha256(),
  scopes: withDefault(array(string({ maxLength: 64 })), () => []),
  expiresAt: optional(timestamp()),
  lastUsedAt: optional(timestamp()),
  revokedAt: optional(timestamp()),
  ...auditFieldsSchema,
});
export type ApiKey = Infer<typeof apiKeySchema>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditEntrySchema = object({
  id: id('auditEntry'),
  workspaceId: optional(id('workspace')),
  principalId: string({ maxLength: 64 }),
  action: string({ minLength: 1, maxLength: 128 }),
  resourceKind: string({ maxLength: 64 }),
  resourceId: string({ maxLength: 64 }),
  outcome: enumOf(['allowed', 'denied', 'error'] as const),
  /** Operator-supplied justification for destructive operations. */
  reason: withDefault(string({ maxLength: 1000 }), ''),
  requestId: withDefault(string({ maxLength: 64 }), ''),
  sourceIp: withDefault(string({ maxLength: 64 }), ''),
  details: withDefault(record(unknown()), () => ({})),
  at: timestamp(),
});
export type AuditEntry = Infer<typeof auditEntrySchema>;
