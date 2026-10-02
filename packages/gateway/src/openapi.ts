/**
 * OpenAPI generation.
 *
 * Request and response *schemas* come from the same declarations the gateway
 * validates against, so those cannot drift: a hand-written spec beside a
 * hand-written validator is two descriptions of one API that agree only until
 * someone changes one of them. Response and entity schemas render from the
 * contracts' entity schemas; request bodies render from the shared
 * `request-schemas.ts` module the route handlers parse with — `.toJsonSchema()`
 * on the same constant, never a re-typed literal. This was not always so: every
 * request body used to be a hand-written literal here, and several had already
 * drifted (a missing `sessionPolicy`, a dropped `metadata`, an absent
 * `embeddingModel`). A test in `test/openapi.test.ts` now deep-equals each
 * documented body against its parse schema and fails the moment one is replaced
 * by a literal.
 *
 * The *path list below is hand-written*, and that part can drift — it did, by
 * eleven routes, while this comment claimed otherwise. Anyone generating a
 * client from the document could not reach a quarter of the API, and the
 * comment told them there was nothing to check. A test in
 * `test/openapi.test.ts` now walks the real router and fails when a registered
 * route is missing here, or when a documented one has no handler. Adding a
 * route means adding it here too; the test is what makes that non-optional.
 *
 * The generator is deliberately small. It emits enough for a client generator
 * and for someone reading the API — paths, schemas, auth, error shapes — and
 * does not attempt every OpenAPI feature.
 */

import {
  APPROVAL_STATUSES,
  agentSchema,
  approvalSchema,
  artifactSchema,
  auditEntrySchema,
  resourceGrantSchema,
  memorySchema,
  agentTemplateSchema,
  templateVariableSchema,
  agentVersionSchema,
  connectorSchema,
  credentialSchema,
  datasetSchema,
  documentSchema,
  modelSchema,
  receiptSchema,
  sandboxSchema,
  sessionEventSchema,
  sessionSchema,
  SUBMISSION_ID_PATTERN,
  universalEventSchema,
  workspaceSchema,
  type JsonSchema,
  type Schema,
} from '@ma/contracts';

import {
  bindDatasetsBody,
  connectorStatusBody,
  createAgentBody,
  createConnectorBody,
  createCredentialBody,
  createDatasetBody,
  createDocumentBody,
  createMemoryBody,
  createSessionBody,
  createTemplateBody,
  createVersionBody,
  createWorkspaceBody,
  decideApprovalBody,
  instantiateTemplateBody,
  grantResourceRoleBody,
  membersBody,
  updateQuotaBody,
  promoteMemoryBody,
  reasonBody,
  renewSessionBody,
  updateAgentBody,
  updateConnectorBody,
  updateMemoryBody,
  updateTemplateBody,
  updateWorkspaceBody,
  registerFreeModelBody,
  setSessionModelBody,
} from './request-schemas.ts';

export interface OpenApiOptions {
  version: string;
  /** Servers a client may target. */
  servers?: { url: string; description?: string }[];
}

/** Entity schemas, exposed as reusable components. */
const COMPONENTS: Record<string, Schema<unknown>> = {
  Workspace: workspaceSchema as Schema<unknown>,
  Agent: agentSchema as Schema<unknown>,
  AgentVersion: agentVersionSchema as Schema<unknown>,
  Session: sessionSchema as Schema<unknown>,
  SessionEvent: sessionEventSchema as Schema<unknown>,
  UniversalEvent: universalEventSchema as Schema<unknown>,
  Sandbox: sandboxSchema as Schema<unknown>,
  Credential: credentialSchema as Schema<unknown>,
  Connector: connectorSchema as Schema<unknown>,
  Receipt: receiptSchema as Schema<unknown>,
  Dataset: datasetSchema as Schema<unknown>,
  Document: documentSchema as Schema<unknown>,
  Model: modelSchema as Schema<unknown>,
  Artifact: artifactSchema as Schema<unknown>,
  Memory: memorySchema as Schema<unknown>,
  AgentTemplate: agentTemplateSchema as Schema<unknown>,
  TemplateVariable: templateVariableSchema as Schema<unknown>,
  AuditEntry: auditEntrySchema as Schema<unknown>,
  ResourceGrant: resourceGrantSchema as Schema<unknown>,
  Approval: approvalSchema as Schema<unknown>,
};

/**
 * A discovered free model. This is a *response-only* view — never persisted — so
 * it has no entity schema to derive from; declaring it here keeps the document
 * complete and honest about the shape.
 */
const FREE_MODEL_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'contextLength', 'tools', 'modalities'],
  properties: {
    id: { type: 'string', description: 'The id to pin in an agent version.' },
    name: { type: 'string' },
    contextLength: { type: 'integer' },
    tools: { type: 'boolean', description: 'Accepts OpenAI function-calling.' },
    modalities: { type: 'array', items: { type: 'string' } },
  },
};

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function page(name: string): JsonSchema {
  return {
    type: 'object',
    properties: {
      items: { type: 'array', items: ref(name) },
      nextCursor: {
        type: 'string',
        description: 'Present only when more results exist. Pass it back as `cursor`.',
      },
    },
    required: ['items'],
  };
}

function wrap(key: string, name: string): JsonSchema {
  return { type: 'object', properties: { [key]: ref(name) }, required: [key] };
}

/** Query parameters shared by every list endpoint. */
const PAGE_PARAMS = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
  {
    name: 'cursor',
    in: 'query',
    description: 'Opaque cursor from a previous response.',
    schema: { type: 'string' },
  },
  {
    name: 'order',
    in: 'query',
    schema: { type: 'string', enum: ['asc', 'desc'] },
  },
];

const PATH_PARAM = (name: string): JsonSchema => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
});

const APPROVAL_STATUSES_PARAM: JsonSchema = {
  name: 'statuses',
  in: 'query',
  description: `Comma-separated: ${APPROVAL_STATUSES.join(', ')}. All of them when absent.`,
  schema: { type: 'string' },
};

/** Responses every endpoint can produce, referenced rather than repeated. */
const COMMON_ERRORS: Record<string, JsonSchema> = {
  400: { $ref: '#/components/responses/ValidationError' },
  401: { $ref: '#/components/responses/Unauthenticated' },
  403: { $ref: '#/components/responses/PermissionDenied' },
  404: { $ref: '#/components/responses/NotFound' },
  429: { $ref: '#/components/responses/QuotaExceeded' },
};

function operation(spec: {
  summary: string;
  description?: string;
  tags: string[];
  parameters?: JsonSchema[];
  requestBody?: JsonSchema;
  responses: Record<string, { description: string; schema?: JsonSchema; headers?: Record<string, JsonSchema> }>;
}): JsonSchema {
  const responses: Record<string, JsonSchema> = { ...COMMON_ERRORS };

  for (const [status, response] of Object.entries(spec.responses)) {
    responses[status] = {
      description: response.description,
      ...(response.headers ? { headers: response.headers } : {}),
      ...(response.schema ? { content: { 'application/json': { schema: response.schema } } } : {}),
    };
  }

  return {
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    tags: spec.tags,
    ...(spec.parameters ? { parameters: spec.parameters } : {}),
    ...(spec.requestBody
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: spec.requestBody } },
          },
        }
      : {}),
    responses,
  };
}

/** Build the OpenAPI document. */
export function buildOpenApi(options: OpenApiOptions): JsonSchema {
  const schemas: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(COMPONENTS)) {
    schemas[name] = schema.toJsonSchema();
  }

  schemas.Error = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Stable, machine-readable. Branch on this.' },
          category: { type: 'string' },
          message: { type: 'string', description: 'Human-readable. Free to change.' },
          details: { type: 'object' },
          retryable: {
            type: 'boolean',
            description:
              'Whether an identical retry could plausibly succeed. Do not infer this from the status code.',
          },
          retryAfterSeconds: { type: 'integer' },
          requestId: { type: 'string' },
        },
        required: ['code', 'category', 'message', 'retryable'],
      },
    },
    required: ['error'],
  };

  const errorResponse = (description: string): JsonSchema => ({
    description,
    content: { 'application/json': { schema: ref('Error') } },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Managed-Agent',
      version: options.version,
      description: [
        'A platform for hosting, governing and observing autonomous agents.',
        '',
        '## Errors',
        '',
        'Every failure carries a stable `code` and an explicit `retryable` flag. Branch on the',
        'code, never the message; and trust `retryable` rather than inferring from the status —',
        'a 500 from a transient dependency is retryable, a 500 from a schema violation is not.',
        '',
        '## Idempotency',
        '',
        'Any mutation accepts an `Idempotency-Key` header. A retry with the same key replays the',
        'original response rather than performing the work twice. Keys are scoped per principal',
        'and route, and expire after 24 hours.',
        '',
        '## Streaming',
        '',
        '`GET /v1/sessions/{sessionId}/events/stream` is server-sent events. Each frame carries',
        "its event sequence in the SSE `id:` field, so a browser's automatic `Last-Event-ID`",
        'reconnect resumes exactly — no gap, no duplicate. A consumer that falls behind receives',
        'a `stream.lagged` frame naming the earliest sequence still available.',
        '',
        '## Pagination',
        '',
        'Keyset, not offset. Pass the `nextCursor` from a response back as `cursor`; a cursor',
        'remains valid as rows are inserted, which an offset does not.',
      ].join('\n'),
    },
    servers: options.servers ?? [{ url: 'http://127.0.0.1:8080' }],

    security: [{ bearerAuth: [] }],

    tags: [
      { name: 'Workspaces', description: 'Tenancy, membership and quota' },
      { name: 'Agents', description: 'Agents and their immutable versions' },
      { name: 'Sessions', description: 'Running agents and their event logs' },
      { name: 'Approvals', description: 'Tool calls waiting for a person to approve or deny them' },
      { name: 'Credentials', description: 'Write-only secret storage' },
      { name: 'Connectors', description: 'Triggers, deliveries and schedules' },
      { name: 'Datasets', description: 'Knowledge bases' },
      { name: 'Artifacts', description: 'Files agents produced' },
      { name: 'Memories', description: 'What agents carry between sessions' },
      { name: 'Templates', description: 'Reusable, parameterised agent blueprints' },
      { name: 'System', description: 'Health and the model catalogue' },
    ],

    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API key. Only its hash is stored, so it cannot be recovered.',
        },
      },
      responses: {
        ValidationError: errorResponse(
          'The request is malformed. `details.issues` lists every problem, not just the first.',
        ),
        Unauthenticated: errorResponse('Missing, unknown, expired or revoked credentials.'),
        PermissionDenied: errorResponse('Authenticated, but not permitted.'),
        NotFound: errorResponse('No such resource, or it is not visible to this caller.'),
        QuotaExceeded: errorResponse(
          'A limit was reached. `Retry-After` is honest about when it may clear — seconds for concurrency, hours for a daily budget.',
        ),
      },
      parameters: {},
    },

    paths: {
      '/health': {
        get: {
          summary: 'Liveness',
          description:
            'Deliberately cheap: it reports that this process is serving, not that every dependency is healthy.',
          tags: ['System'],
          security: [],
          responses: {
            200: {
              description: 'Serving',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string' }, version: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },

      '/v1/models/free': {
        get: operation({
          summary: 'List the free models the provider offers',
          description:
            'Discovered live from the configured model provider, tools-capable first. Read-only: ' +
            'this is how an operator sees which free models exist before registering one.',
          tags: ['System'],
          responses: {
            200: {
              description: 'Free models currently offered by the provider',
              schema: {
                type: 'object',
                properties: { models: { type: 'array', items: FREE_MODEL_SCHEMA } },
              },
            },
            503: {
              description:
                'No model provider is configured (not retryable), or its catalogue is unavailable right now (retryable)',
            },
          },
        }),
        post: operation({
          summary: 'Register a free model into the catalogue',
          description:
            'Admin-only, and an API key must also carry the `model.register` scope (`ma:model:*` ' +
            'or `ma:*`). The id is re-checked against the provider’s live catalogue, so a paid ' +
            'model can never be registered by naming one; a model is free only as a published ' +
            '`:free` variant priced at zero. Re-registering a catalogued model refreshes what ' +
            'the provider reports but keeps whether it is enabled, which workspaces may use it, ' +
            'its security level and a tightened output cap. Audited.',
          tags: ['System'],
          requestBody: registerFreeModelBody.toJsonSchema(),
          responses: {
            200: {
              description: 'Already catalogued: the provider-reported details were refreshed, operator settings kept',
              schema: { type: 'object', properties: { model: ref('Model') } },
            },
            201: {
              description: 'The registered model',
              schema: { type: 'object', properties: { model: ref('Model') } },
            },
            400: { description: 'Not currently offered as a free model' },
            403: { description: 'Not a platform admin, or the API key lacks the scope' },
            503: {
              description:
                'No model provider is configured (not retryable), or its catalogue is unavailable right now (retryable)',
            },
          },
        }),
      },

      '/v1/models': {
        get: operation({
          summary: 'List available models',
          tags: ['System'],
          parameters: [{ name: 'workspaceId', in: 'query', schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Models this workspace may use',
              schema: {
                type: 'object',
                properties: { models: { type: 'array', items: ref('Model') } },
              },
            },
          },
        }),
      },

      '/v1/workspaces': {
        get: operation({
          summary: 'List workspaces',
          description: 'Scoped to the caller’s membership at the query, not filtered afterwards.',
          tags: ['Workspaces'],
          parameters: PAGE_PARAMS,
          responses: { 200: { description: 'A page of workspaces', schema: page('Workspace') } },
        }),
        post: operation({
          summary: 'Create a workspace',
          description: 'The creator becomes an owner; a workspace nobody can administer is a support ticket.',
          tags: ['Workspaces'],
          requestBody: createWorkspaceBody.toJsonSchema(),
          responses: { 201: { description: 'Created', schema: wrap('workspace', 'Workspace') } },
        }),
      },

      '/v1/workspaces/{workspaceId}': {
        get: operation({
          summary: 'Get a workspace',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          responses: {
            200: {
              description: 'The workspace. The `ETag` response header carries the workspace version, to echo back as `If-Match` on a member update.',
              schema: wrap('workspace', 'Workspace'),
            },
          },
        }),
        patch: operation({
          summary: 'Update a workspace',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: updateWorkspaceBody.toJsonSchema(),
          responses: { 200: { description: 'Updated (ETag carries the new version)', schema: wrap('workspace', 'Workspace') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/members': {
        put: operation({
          summary: 'Replace a workspace’s member list',
          tags: ['Workspaces'],
          parameters: [
            PATH_PARAM('workspaceId'),
            {
              name: 'If-Match',
              in: 'header',
              required: false,
              description:
                'Optional optimistic-concurrency precondition: the workspace version (from a prior read’s `ETag` or `workspace.version`). If the workspace has changed since, the update is refused with 412 rather than clobbering the concurrent change. Absent ⇒ unconditional replace.',
              schema: { type: 'string' },
            },
          ],
          requestBody: membersBody.toJsonSchema(),
          responses: {
            200: { description: 'Updated (ETag carries the new version)', schema: wrap('workspace', 'Workspace') },
            412: { description: 'The If-Match version no longer matches; re-read and retry.' },
          },
        }),
      },

      '/v1/workspaces/{workspaceId}/grants': {
        get: operation({
          summary: 'List a workspace’s resource-scoped grants',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          responses: {
            200: {
              description: 'Grants',
              schema: {
                type: 'object',
                properties: { grants: { type: 'array', items: ref('ResourceGrant') } },
                required: ['grants'],
              },
            },
          },
        }),
        post: operation({
          summary: 'Grant a principal a role on one specific resource',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: grantResourceRoleBody.toJsonSchema(),
          responses: { 201: { description: 'Granted', schema: wrap('grant', 'ResourceGrant') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/grants/{grantId}': {
        delete: operation({
          summary: 'Revoke a resource-scoped grant',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId'), PATH_PARAM('grantId')],
          responses: { 204: { description: 'Revoked' } },
        }),
      },

      '/v1/workspaces/{workspaceId}/archive': {
        post: operation({
          summary: 'Archive a workspace',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          responses: { 200: { description: 'Archived', schema: wrap('workspace', 'Workspace') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/quota': {
        get: operation({
          summary: 'Quota limits and current usage',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          responses: {
            200: {
              description: 'Every dimension, with what is currently consumed',
              schema: {
                type: 'object',
                properties: {
                  limits: { type: 'object' },
                  usage: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        dimension: { type: 'string' },
                        limit: { type: 'integer' },
                        observed: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        put: operation({
          summary: 'Change a workspace’s quota limits (owner only)',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: updateQuotaBody.toJsonSchema(),
          responses: { 200: { description: 'Updated', schema: wrap('workspace', 'Workspace') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/usage': {
        get: operation({
          summary: 'Daily token and cost usage history (admin only)',
          description:
            'The per-day token and cost series over a date range, plus a summed total — the spend ' +
            'history behind the daily budgets. `from`/`to` are YYYY-MM-DD (UTC) or epoch-ms; both ' +
            'default to the last 30 days. A day with no usage is omitted (it is zero). Admin-gated, ' +
            'because it is billing data.',
          tags: ['Workspaces'],
          parameters: [
            PATH_PARAM('workspaceId'),
            { name: 'from', in: 'query', schema: { type: 'string' } },
            { name: 'to', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'The daily usage series and its total',
              schema: {
                type: 'object',
                properties: {
                  days: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        utcDay: { type: 'integer' },
                        inputTokens: { type: 'integer' },
                        outputTokens: { type: 'integer' },
                        costMicros: { type: 'integer' },
                      },
                    },
                  },
                  total: {
                    type: 'object',
                    properties: {
                      inputTokens: { type: 'integer' },
                      outputTokens: { type: 'integer' },
                      costMicros: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        }),
      },

      '/v1/workspaces/{workspaceId}/agents': {
        get: operation({
          summary: 'List agents',
          tags: ['Agents'],
          parameters: [PATH_PARAM('workspaceId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of agents', schema: page('Agent') } },
        }),
        post: operation({
          summary: 'Create an agent',
          tags: ['Agents'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: createAgentBody.toJsonSchema(),
          responses: { 201: { description: 'Created', schema: wrap('agent', 'Agent') } },
        }),
      },

      '/v1/agents/{agentId}': {
        get: operation({
          summary: 'Get an agent',
          tags: ['Agents'],
          parameters: [PATH_PARAM('agentId')],
          responses: { 200: { description: 'The agent', schema: wrap('agent', 'Agent') } },
        }),
        patch: operation({
          summary: 'Update agent metadata',
          description:
            'Metadata only. Behaviour lives on versions, so changing an agent never alters what a running session does.',
          tags: ['Agents'],
          parameters: [PATH_PARAM('agentId')],
          requestBody: updateAgentBody.toJsonSchema(),
          responses: { 200: { description: 'Updated', schema: wrap('agent', 'Agent') } },
        }),
      },

      '/v1/agents/{agentId}/archive': {
        post: operation({
          summary: 'Archive an agent',
          tags: ['Agents'],
          parameters: [PATH_PARAM('agentId')],
          responses: { 200: { description: 'Archived', schema: wrap('agent', 'Agent') } },
        }),
      },

      '/v1/agents/{agentId}/datasets': {
        put: operation({
          summary: 'Replace the datasets an agent can retrieve from',
          tags: ['Agents'],
          parameters: [PATH_PARAM('agentId')],
          requestBody: bindDatasetsBody.toJsonSchema(),
          responses: {
            200: { description: 'Updated', schema: wrap('version', 'AgentVersion') },
          },
        }),
      },

      '/v1/agents/{agentId}/versions': {
        get: operation({
          summary: 'List versions',
          tags: ['Agents'],
          parameters: [PATH_PARAM('agentId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of versions', schema: page('AgentVersion') } },
        }),
        post: operation({
          summary: 'Publish a version',
          description:
            'The spec is merged over its base unless `replace` is set, so omitting a field cannot silently drop a capability. The response includes the resulting diff.',
          tags: ['Agents'],
          parameters: [PATH_PARAM('agentId')],
          requestBody: createVersionBody.toJsonSchema(),
          responses: {
            201: {
              description: 'Published',
              schema: {
                type: 'object',
                properties: {
                  version: ref('AgentVersion'),
                  diff: {
                    type: 'object',
                    properties: {
                      added: { type: 'array', items: { type: 'string' } },
                      removed: { type: 'array', items: { type: 'string' } },
                      changed: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
            409: { description: 'Another version was published concurrently; re-read and retry.' },
          },
        }),
      },

      '/v1/sessions': {
        get: operation({
          summary: 'List sessions',
          tags: ['Sessions'],
          parameters: [
            { name: 'workspaceId', in: 'query', schema: { type: 'string' } },
            { name: 'agentId', in: 'query', schema: { type: 'string' } },
            {
              name: 'statuses',
              in: 'query',
              description: 'Comma-separated.',
              schema: { type: 'string' },
            },
            ...PAGE_PARAMS,
          ],
          responses: { 200: { description: 'A page of sessions', schema: page('Session') } },
        }),
        post: operation({
          summary: 'Start a session',
          description:
            'Resolves and pins an agent version at creation. The session is thereafter immune to edits of its agent.',
          tags: ['Sessions'],
          requestBody: createSessionBody.toJsonSchema(),
          responses: {
            201: { description: 'Created', schema: wrap('session', 'Session') },
          },
        }),
      },

      '/v1/sessions/{sessionId}': {
        get: operation({
          summary: 'Get a session',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          responses: { 200: { description: 'The session', schema: wrap('session', 'Session') } },
        }),
      },

      '/v1/sessions/{sessionId}/events': {
        get: operation({
          summary: 'Read the event log',
          description:
            'Sequences are gap-free per session, so `fromSeq` resumes exactly. This is how a client catches up before streaming.',
          tags: ['Sessions'],
          parameters: [
            PATH_PARAM('sessionId'),
            { name: 'fromSeq', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'toSeq', in: 'query', description: 'Exclusive upper bound on seq.', schema: { type: 'integer', minimum: 0 } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 } },
            {
              name: 'types',
              in: 'query',
              description: 'Comma-separated. A trailing dot matches a namespace, e.g. `tool.`',
              schema: { type: 'string' },
            },
            { name: 'turn', in: 'query', description: 'Only events from this turn.', schema: { type: 'integer', minimum: 0 } },
            { name: 'order', in: 'query', description: 'Sort by seq; `asc` (default) or `desc`.', schema: { type: 'string', enum: ['asc', 'desc'] } },
            {
              name: 'q',
              in: 'query',
              description:
                'Case-insensitive substring search over the string and number values of each event payload (not its field names), scoped to this session and walked in `order` from `fromSeq` or `toSeq`. One request examines at most 100,000 events; when it stops there, `search.truncated` is true and `search.resumeSeq` is where to carry on. Events logged before the search index existed fold ASCII case only. Max 1024 chars.',
              schema: { type: 'string', maxLength: 1024 },
            },
            { name: 'fromTs', in: 'query', description: 'Inclusive lower bound on event timestamp (ms). A filter window, not a resume cursor.', schema: { type: 'integer', minimum: 0 } },
            { name: 'toTs', in: 'query', description: 'Exclusive upper bound on event timestamp (ms).', schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            200: {
              description: 'Events, with the bounds of what is retained',
              schema: {
                type: 'object',
                properties: {
                  events: { type: 'array', items: ref('SessionEvent') },
                  earliestSeq: { type: 'integer' },
                  lastSeq: { type: 'integer' },
                  search: {
                    type: 'object',
                    description: 'Present when `q` was given: how far the search got.',
                    properties: {
                      scanned: { type: 'integer', description: 'Events examined.' },
                      truncated: {
                        type: 'boolean',
                        description: 'The per-request cap stopped the search before the end of its range.',
                      },
                      resumeSeq: {
                        type: 'integer',
                        description: 'When truncated: repeat the query with this as `toSeq` (order=desc) or `fromSeq` (order=asc).',
                      },
                    },
                    required: ['scanned', 'truncated'],
                  },
                },
              },
            },
            429: {
              description: 'Too many event-log searches are running on this server (`SEARCH_BUSY`); retry after `Retry-After`.',
              schema: ref('Error'),
            },
          },
        }),
        post: operation({
          summary: 'Submit events to a session',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: {
            type: 'object',
            properties: {
              events: { type: 'array', items: ref('UniversalEvent') },
              submissionId: {
                type: 'string',
                pattern: SUBMISSION_ID_PATTERN.source,
                description:
                  'Names this submission; the turn it starts carries it on `turn.started`. Generated when absent. Supply one to correlate before the response arrives.',
              },
            },
            required: ['events'],
          },
          responses: {
            202: {
              description: 'Accepted',
              schema: {
                type: 'object',
                properties: {
                  accepted: { type: 'integer' },
                  session: ref('Session'),
                  submissionId: {
                    type: 'string',
                    description: 'The `submissionId` the turn this starts will carry on `turn.started`.',
                  },
                },
              },
            },
            412: { description: 'The session is not in a state that accepts input.' },
          },
        }),
      },

      '/v1/sessions/{sessionId}/events/stream': {
        get: {
          summary: 'Stream events',
          description: [
            'Server-sent events. Each frame carries its sequence in the SSE `id:` field, so a',
            "browser's automatic `Last-Event-ID` reconnect resumes exactly.",
            '',
            'History is replayed from `fromSeq` first, then the stream goes live with no gap at',
            'the handover and no duplicate. A consumer that cannot keep up receives a',
            '`stream.lagged` frame naming the earliest sequence still available.',
          ].join('\n'),
          tags: ['Sessions'],
          parameters: [
            PATH_PARAM('sessionId'),
            { name: 'fromSeq', in: 'query', schema: { type: 'integer' } },
            { name: 'types', in: 'query', schema: { type: 'string' } },
            {
              name: 'Last-Event-ID',
              in: 'header',
              description: 'Sent automatically on reconnect. Takes precedence over `fromSeq`.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: { description: 'An event stream', content: { 'text/event-stream': {} } },
            403: { $ref: '#/components/responses/PermissionDenied' },
          },
        },
      },

      '/v1/sessions/{sessionId}/interrupt': {
        post: operation({
          summary: 'Interrupt the running turn',
          description: 'Cooperative: the turn ends at a coherent boundary and the session continues.',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: reasonBody.toJsonSchema(),
          responses: { 200: { description: 'Interrupted', schema: wrap('session', 'Session') } },
        }),
      },

      '/v1/sessions/{sessionId}/terminate': {
        post: operation({
          summary: 'End a session',
          description: 'Irreversible. The sandbox is released and the session cannot resume.',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: reasonBody.toJsonSchema(),
          responses: { 200: { description: 'Terminated', schema: wrap('session', 'Session') } },
        }),
      },

      '/v1/sessions/{sessionId}/approvals': {
        get: operation({
          summary: "List a session's tool-call approvals",
          description: [
            'A tool call the agent version\'s policy decides `prompt` waits here for a person. The',
            'turn is paused on it until someone decides, the session ends, or the version\'s',
            '`tools.approvalTimeoutSeconds` passes (then it is `expired` and the call is denied).',
            'Oldest first. A call whose time is up reads as `expired` even before the sweep runs.',
          ].join('\n'),
          tags: ['Approvals'],
          parameters: [PATH_PARAM('sessionId'), APPROVAL_STATUSES_PARAM, ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of approvals', schema: page('Approval') } },
        }),
      },

      '/v1/sessions/{sessionId}/approvals/{approvalId}': {
        get: operation({
          summary: 'Get one approval',
          tags: ['Approvals'],
          parameters: [PATH_PARAM('sessionId'), PATH_PARAM('approvalId')],
          responses: { 200: { description: 'The approval', schema: wrap('approval', 'Approval') } },
        }),
      },

      '/v1/sessions/{sessionId}/approvals/{approvalId}/decision': {
        post: operation({
          summary: 'Approve or deny a waiting tool call',
          description: [
            'Requires `session.approve` (operator or above). Approve runs the call; deny returns',
            '"Permission denied: <reason>" to the agent as the tool result. Either is recorded on',
            'the session as `approval.decided` and in the audit log. Only a `pending` approval can be',
            'decided: one already approved, denied, expired or cancelled answers 409 with its status.',
          ].join('\n'),
          tags: ['Approvals'],
          parameters: [PATH_PARAM('sessionId'), PATH_PARAM('approvalId')],
          requestBody: decideApprovalBody.toJsonSchema(),
          responses: {
            200: { description: 'Decided', schema: wrap('approval', 'Approval') },
            409: { description: 'The approval is no longer pending.', schema: ref('Error') },
          },
        }),
      },

      '/v1/workspaces/{workspaceId}/approvals': {
        get: operation({
          summary: "List a workspace's tool-call approvals",
          description: 'Every session in the workspace, oldest first. `statuses=pending` is the queue waiting for someone.',
          tags: ['Approvals'],
          parameters: [PATH_PARAM('workspaceId'), APPROVAL_STATUSES_PARAM, ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of approvals', schema: page('Approval') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/credentials': {
        get: operation({
          summary: 'List credential metadata',
          description: 'Metadata only. There is no endpoint that returns a credential value.',
          tags: ['Credentials'],
          parameters: [PATH_PARAM('workspaceId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of credentials', schema: page('Credential') } },
        }),
        post: operation({
          summary: 'Store a credential',
          description: 'The value is write-only: it can be referenced but never read back.',
          tags: ['Credentials'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: createCredentialBody.toJsonSchema(),
          responses: { 201: { description: 'Stored', schema: wrap('credential', 'Credential') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/connectors': {
        get: operation({
          summary: 'List connectors',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('workspaceId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of connectors', schema: page('Connector') } },
        }),
        post: operation({
          summary: 'Create a connector',
          description:
            'Always created as a draft. Activation is a separate, deliberate step that runs the adapter’s own validation.',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: createConnectorBody.toJsonSchema(),
          responses: { 201: { description: 'Created as a draft', schema: wrap('connector', 'Connector') } },
        }),
      },

      '/v1/agents/{agentId}/versions/{version}': {
        get: operation({
          summary: 'Get one immutable agent version',
          tags: ['Agents'],
          parameters: [
            PATH_PARAM('agentId'),
            { name: 'version', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'The version', schema: wrap('version', 'AgentVersion') } },
        }),
      },

      '/v1/credentials/{credentialId}': {
        get: operation({
          summary: 'Get credential metadata (never its value)',
          tags: ['Credentials'],
          parameters: [PATH_PARAM('credentialId')],
          responses: {
            200: { description: 'Metadata', schema: wrap('credential', 'Credential') },
          },
        }),
        delete: operation({
          summary: 'Delete a credential',
          tags: ['Credentials'],
          parameters: [PATH_PARAM('credentialId')],
          responses: { 204: { description: 'Deleted' } },
        }),
      },

      '/v1/workspaces/{workspaceId}/audit': {
        get: operation({
          summary: 'Read the workspace audit trail',
          tags: ['Workspaces'],
          parameters: [
            PATH_PARAM('workspaceId'),
            { name: 'principalId', in: 'query', schema: { type: 'string' } },
            { name: 'action', in: 'query', schema: { type: 'string' } },
            { name: 'resourceId', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Audit entries', schema: page('AuditEntry') } },
        }),
      },

      '/v1/audit/verify': {
        get: operation({
          summary: 'Verify the tamper-evident audit hash chain (platform admin)',
          tags: ['Workspaces'],
          responses: {
            200: {
              description:
                'Chain verification result. ok:false with a break location when a row was ' +
                'edited, inserted, deleted or reordered.',
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  checked: { type: 'integer' },
                  brokenAtSeq: { type: 'integer' },
                  brokenId: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['ok', 'checked'],
              },
            },
          },
        }),
      },

      '/v1/connectors/{connectorId}': {
        get: operation({
          summary: 'Get a connector',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          responses: { 200: { description: 'The connector', schema: wrap('connector', 'Connector') } },
        }),
        patch: operation({
          summary: 'Update a connector',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          requestBody: updateConnectorBody.toJsonSchema(),
          responses: { 200: { description: 'Updated', schema: wrap('connector', 'Connector') } },
        }),
        delete: operation({
          summary: 'Delete a connector and its delivery history',
          description:
            'Irreversible, and admin-only. Archive (via the status endpoint) is the reversible ' +
            'default; this removes the connector along with its bindings and receipts, and frees ' +
            'its external key. For a connector created in error or a tenant being offboarded.',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          responses: { 204: { description: 'Deleted' } },
        }),
      },

      '/v1/receipts/{receiptId}/retry': {
        post: operation({
          summary: 'Replay a delivery, creating a new receipt',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('receiptId')],
          requestBody: reasonBody.toJsonSchema(),
          responses: {
            // The handler queues a replay and returns 202 with the new receipt's
            // id — not a full Receipt entity, and not 201. Mirrors the sibling
            // /run op, and matches the SDK's retryReceipt(): { receiptId }.
            202: {
              description: 'Replay queued',
              schema: {
                type: 'object',
                properties: { receiptId: { type: 'string' } },
                required: ['receiptId'],
              },
            },
          },
        }),
      },

      '/v1/sessions/{sessionId}/renew': {
        post: operation({
          summary: 'Extend a session’s TTL',
          description:
            'A session that outlives its purpose is what the TTL is for; one that outlives ' +
            'its estimate is not. Renewing keeps a long-running agent alive past the reaper.',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: renewSessionBody.toJsonSchema(),
          responses: { 200: { description: 'Renewed', schema: wrap('session', 'Session') } },
        }),
      },

      '/v1/sessions/{sessionId}/model': {
        put: operation({
          summary: 'Choose the model this session calls',
          description:
            'Affects this session only; the agent version is untouched. The id must name a ' +
            'catalogue model visible to this workspace. Send `null` to clear the choice and ' +
            'return to the model the pinned version declares. A queued session picks it up when ' +
            'it provisions; a ready or idle one is rebound so the change takes effect at once. A ' +
            'session mid-turn or still starting answers 409 and keeps its model: change it ' +
            'between turns.',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: setSessionModelBody.toJsonSchema(),
          responses: {
            200: { description: 'The updated session', schema: wrap('session', 'Session') },
            400: { description: 'Not a model this workspace may use' },
            409: {
              description:
                'The session has ended, is mid-turn or starting, or a turn began during the change ' +
                '(which was rolled back)',
            },
          },
        }),
      },

      '/v1/workspaces/{workspaceId}/memories': {
        get: operation({
          summary: 'List what this workspace and its agents remember',
          tags: ['Memories'],
          parameters: [
            PATH_PARAM('workspaceId'),
            { name: 'agentId', in: 'query', schema: { type: 'string' } },
            {
              name: 'injectableOnly',
              in: 'query',
              description: 'Only memories a human has allowed into the system prompt.',
              schema: { type: 'boolean' },
            },
            ...PAGE_PARAMS,
          ],
          responses: { 200: { description: 'Memories', schema: page('Memory') } },
        }),
        post: operation({
          summary: 'Write a memory as a human',
          description:
            'Human-authored memories are injectable by default — a person writing one ' +
            'generally means it to be used. Agent-authored memories are written through ' +
            'the runtime bridge and are never injectable without an explicit promotion.',
          tags: ['Memories'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: createMemoryBody.toJsonSchema(),
          responses: {
            201: { description: 'Created', schema: wrap('memory', 'Memory') },
            // Deduplicated: an identical (workspace, agent, content) memory already
            // exists, so the existing one is returned unchanged with 200 rather than
            // a second row. A strict client must accept both.
            200: { description: 'A duplicate; the existing memory is returned', schema: wrap('memory', 'Memory') },
          },
        }),
      },

      '/v1/memories/{memoryId}': {
        get: operation({
          summary: 'Get one memory',
          tags: ['Memories'],
          parameters: [PATH_PARAM('memoryId')],
          responses: { 200: { description: 'The memory', schema: wrap('memory', 'Memory') } },
        }),
        patch: operation({
          summary: 'Edit a memory’s text',
          description:
            'Cannot change `injectable` — that is what `/promote` is for, so editing ' +
            'wording can never move text into the system prompt as a side effect.',
          tags: ['Memories'],
          parameters: [PATH_PARAM('memoryId')],
          requestBody: updateMemoryBody.toJsonSchema(),
          responses: { 200: { description: 'Updated', schema: wrap('memory', 'Memory') } },
        }),
        delete: operation({
          summary: 'Forget a memory',
          tags: ['Memories'],
          parameters: [
            PATH_PARAM('memoryId'),
            { name: 'reason', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 204: { description: 'Forgotten' } },
        }),
      },

      '/v1/memories/{memoryId}/promote': {
        post: operation({
          summary: 'Allow a memory into the system prompt, or withdraw it',
          description:
            'The only operation that moves agent-authored text across the trust boundary. ' +
            'Requires `memory.promote` (admin), which is a higher bar than editing, and is ' +
            'audited with the session the agent wrote it in — so an injected line can ' +
            'always be traced back to what suggested it.',
          tags: ['Memories'],
          parameters: [PATH_PARAM('memoryId')],
          requestBody: promoteMemoryBody.toJsonSchema(),
          responses: { 200: { description: 'Updated', schema: wrap('memory', 'Memory') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/templates': {
        get: operation({
          summary: 'List the agent templates a workspace can instantiate',
          description:
            'Returns the workspace’s own templates plus the platform’s built-ins — both are ' +
            'things a user may instantiate, so both appear in one catalogue.',
          tags: ['Templates'],
          parameters: [
            PATH_PARAM('workspaceId'),
            { name: 'category', in: 'query', schema: { type: 'string' } },
            ...PAGE_PARAMS,
          ],
          responses: { 200: { description: 'Templates', schema: page('AgentTemplate') } },
        }),
        post: operation({
          summary: 'Author a workspace template',
          description:
            'Creates a workspace-owned template. Built-ins are seeded by the platform and are ' +
            'read-only; this never creates one.',
          tags: ['Templates'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: createTemplateBody.toJsonSchema(),
          responses: { 201: { description: 'Created', schema: wrap('template', 'AgentTemplate') } },
        }),
      },

      '/v1/templates/{templateId}': {
        get: operation({
          summary: 'Get one template',
          tags: ['Templates'],
          parameters: [PATH_PARAM('templateId')],
          responses: {
            200: { description: 'The template', schema: wrap('template', 'AgentTemplate') },
          },
        }),
        patch: operation({
          summary: 'Edit a workspace template',
          description: 'A built-in cannot be edited through the API; the attempt is a conflict.',
          tags: ['Templates'],
          parameters: [PATH_PARAM('templateId')],
          requestBody: updateTemplateBody.toJsonSchema(),
          responses: { 200: { description: 'Updated', schema: wrap('template', 'AgentTemplate') } },
        }),
        delete: operation({
          summary: 'Delete a workspace template',
          description: 'A built-in cannot be deleted through the API; the attempt is a conflict.',
          tags: ['Templates'],
          parameters: [PATH_PARAM('templateId')],
          responses: { 204: { description: 'Deleted' } },
        }),
      },

      '/v1/workspaces/{workspaceId}/templates/{templateId}/instantiate': {
        post: operation({
          summary: 'Create an agent from a template',
          description:
            'Substitutes the supplied variables into the template’s spec and creates an agent ' +
            'in the path workspace — which need not be the template’s own, since a built-in has ' +
            'none. Runs the same authorization and quota as creating an agent directly.',
          tags: ['Templates'],
          parameters: [PATH_PARAM('workspaceId'), PATH_PARAM('templateId')],
          requestBody: instantiateTemplateBody.toJsonSchema(),
          responses: { 201: { description: 'The created agent', schema: wrap('agent', 'Agent') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/artifacts': {
        get: operation({
          summary: 'List the files agents produced in this workspace',
          tags: ['Artifacts'],
          parameters: [
            PATH_PARAM('workspaceId'),
            { name: 'sessionId', in: 'query', schema: { type: 'string' } },
            ...PAGE_PARAMS,
          ],
          responses: { 200: { description: 'Artifacts', schema: page('Artifact') } },
        }),
      },

      '/v1/artifacts/{artifactId}': {
        get: operation({
          summary: 'Get an artifact’s metadata',
          tags: ['Artifacts'],
          parameters: [PATH_PARAM('artifactId')],
          responses: { 200: { description: 'The artifact', schema: wrap('artifact', 'Artifact') } },
        }),
        delete: operation({
          summary: 'Delete an artifact’s content, keeping its record',
          description:
            'The row survives as `purged`, so what a session produced stays answerable ' +
            'after the content itself is gone.',
          tags: ['Artifacts'],
          parameters: [
            PATH_PARAM('artifactId'),
            { name: 'reason', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Purged', schema: wrap('artifact', 'Artifact') } },
        }),
      },

      '/v1/artifacts/{artifactId}/content': {
        get: operation({
          summary: 'Download an artifact’s bytes',
          description:
            'Served as an attachment with the content type the control plane sniffed from ' +
            'the bytes — never one the uploading agent declared — plus `nosniff` and a ' +
            'sandbox CSP. Requires `artifact.download`, which is a distinct action from ' +
            'listing because it is the only path by which agent-authored bytes reach a person.',
          tags: ['Artifacts'],
          parameters: [PATH_PARAM('artifactId')],
          responses: { 200: { description: 'The bytes, as an attachment' } },
        }),
      },

      '/v1/artifacts/{artifactId}/preview-token': {
        post: operation({
          summary: 'Mint a signed URL to preview an artifact',
          description:
            'Returns a short-lived, signed URL on a *separate* preview origin that renders ' +
            'the artifact in a browser. Authorized as a download — the same power to see the ' +
            'bytes. Fails when no preview origin is configured, because there is no safe ' +
            'same-origin preview of agent-authored content.',
          tags: ['Artifacts'],
          parameters: [PATH_PARAM('artifactId')],
          responses: {
            201: {
              description: 'A signed preview URL and its expiry',
              schema: {
                type: 'object',
                properties: { url: { type: 'string' }, expiresAt: { type: 'integer' } },
              },
            },
            412: { description: 'Preview is disabled: no separate preview origin is configured.' },
          },
        }),
      },

      '/preview/v1/{artifactId}': {
        get: {
          summary: 'Render an artifact on the isolated preview origin',
          description: [
            'Serves artifact content for rendering, authenticated by the signed token in the',
            'query rather than a bearer — a browser navigation or an <iframe> carries none.',
            '',
            'Safe to render agent-authored HTML only because it is served from an origin',
            'distinct from the console, under a sandbox CSP with a restricted frame-ancestors,',
            'so the content cannot reach the operator’s session.',
          ].join('\n'),
          tags: ['Artifacts'],
          security: [],
          parameters: [
            PATH_PARAM('artifactId'),
            { name: 'exp', in: 'query', required: true, schema: { type: 'integer' } },
            { name: 'nonce', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'sig', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'The content, rendered under a sandbox CSP' },
            401: { description: 'The preview token is missing, invalid, or expired.' },
          },
        },
      },

      '/v1/connectors/{connectorId}/status': {
        post: operation({
          summary: 'Change a connector’s status',
          description:
            'Activation validates against the adapter’s own rules. Archived connectors can return to draft; restore is supported rather than forcing a recreate that loses delivery history.',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          requestBody: connectorStatusBody.toJsonSchema(),
          responses: {
            200: { description: 'Updated', schema: wrap('connector', 'Connector') },
            412: { description: 'That status transition is not legal from the current one.' },
          },
        }),
      },

      '/v1/connectors/{connectorId}/receipts': {
        get: operation({
          summary: 'Delivery history',
          description: 'One receipt per inbound event — the answer to "what happened to that alert?".',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of receipts', schema: page('Receipt') } },
        }),
      },

      '/v1/connectors/{connectorId}/run': {
        post: operation({
          summary: 'Fire a schedule now',
          description: 'Testing a nightly job by waiting until tonight is not a workflow.',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          responses: {
            202: {
              description: 'Queued',
              schema: {
                type: 'object',
                properties: { receiptId: { type: 'string' }, created: { type: 'boolean' } },
              },
            },
          },
        }),
      },

      '/v1/connectors/{connectorId}/next-fire': {
        get: operation({
          summary: 'When a schedule will next fire',
          description: 'Verifies a cron change without waiting for it.',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          responses: {
            200: {
              description: 'The next fire time, or null if it is not scheduled',
              schema: {
                type: 'object',
                properties: {
                  nextFireAt: { type: ['integer', 'null'] },
                  nextFireIso: { type: ['string', 'null'] },
                },
              },
            },
          },
        }),
      },

      '/v1/workspaces/{workspaceId}/datasets': {
        get: operation({
          summary: 'List datasets',
          tags: ['Datasets'],
          parameters: [PATH_PARAM('workspaceId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of datasets', schema: page('Dataset') } },
        }),
        post: operation({
          summary: 'Create a dataset',
          tags: ['Datasets'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: createDatasetBody.toJsonSchema(),
          responses: { 201: { description: 'Created', schema: wrap('dataset', 'Dataset') } },
        }),
      },

      '/v1/datasets/{datasetId}': {
        delete: operation({
          summary: 'Delete a dataset and all its documents',
          description:
            'Irreversible, and admin-only. Removes the dataset row (its documents cascade) and ' +
            'evicts every one of its chunks from the search index, so retrieval stops returning them.',
          tags: ['Datasets'],
          parameters: [PATH_PARAM('datasetId')],
          responses: { 200: { description: 'Deleted, with the count of documents evicted' } },
        }),
      },

      '/v1/datasets/{datasetId}/documents': {
        get: operation({
          summary: 'List documents',
          tags: ['Datasets'],
          parameters: [PATH_PARAM('datasetId'), ...PAGE_PARAMS],
          responses: { 200: { description: 'A page of documents', schema: page('Document') } },
        }),
        post: operation({
          summary: 'Add a document',
          description:
            'Ingestion is asynchronous. The document starts `pending` and the pipeline moves it on; poll its status.',
          tags: ['Datasets'],
          parameters: [PATH_PARAM('datasetId')],
          requestBody: createDocumentBody.toJsonSchema(),
          responses: { 202: { description: 'Queued for ingestion', schema: wrap('document', 'Document') } },
        }),
      },

      '/v1/datasets/{datasetId}/documents/{documentId}': {
        delete: operation({
          summary: 'Delete a document',
          description:
            'Evicts the document\'s chunks from the search index, decrements the dataset\'s document and ' +
            'chunk counts (releasing knowledge-chunk quota), and deletes the row. Scoped to the dataset: a ' +
            'document that does not belong to it is a 404.',
          tags: ['Datasets'],
          parameters: [PATH_PARAM('datasetId'), PATH_PARAM('documentId')],
          responses: { 200: { description: 'Deleted, with the count of chunks evicted' } },
        }),
      },

      '/ingress/v1/{workspaceId}/{externalKey}': {
        post: {
          summary: 'Inbound connector delivery',
          description: [
            'Authenticated by signature rather than a bearer token, since the caller is an',
            'external system rather than a principal.',
            '',
            'Deduplicated on the event id: a retry returns the original receipt rather than',
            'starting a second agent run.',
            '',
            'The headers below are a webhook’s. A chat connector on Slack or Feishu checks the',
            'platform’s own instead — `X-Slack-Signature` with `X-Slack-Request-Timestamp`, or',
            '`X-Lark-Signature` with the request timestamp and nonce — so the platform’s event',
            'subscription points straight at this URL.',
          ].join('\n'),
          tags: ['Connectors'],
          security: [],
          parameters: [
            PATH_PARAM('workspaceId'),
            PATH_PARAM('externalKey'),
            {
              name: 'X-MA-Signature',
              in: 'header',
              required: true,
              description: 'HMAC-SHA256 of `{timestamp}.{body}`.',
              schema: { type: 'string' },
            },
            {
              name: 'X-MA-Timestamp',
              in: 'header',
              required: true,
              description: 'Epoch ms. Outside the tolerance window the request is rejected as a replay.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            202: { description: 'Accepted; a receipt was created' },
            200: { description: 'A duplicate, and the original receipt is returned; or a platform’s URL check, answered with its challenge' },
            401: { description: 'Signature verification failed' },
          },
        },
      },
    },
  };
}
