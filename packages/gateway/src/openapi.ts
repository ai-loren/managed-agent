/**
 * OpenAPI generation.
 *
 * Request and response *schemas* come from the same declarations the gateway
 * validates against, so those cannot drift: a hand-written spec beside a
 * hand-written validator is two descriptions of one API that agree only until
 * someone changes one of them.
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
  WORKSPACE_ROLES,
  agentSchema,
  auditEntrySchema,
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
  universalEventSchema,
  workspaceSchema,
  type JsonSchema,
  type Schema,
} from '@ma/contracts';

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
  AuditEntry: auditEntrySchema as Schema<unknown>,
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
      { name: 'Credentials', description: 'Write-only secret storage' },
      { name: 'Connectors', description: 'Triggers, deliveries and schedules' },
      { name: 'Datasets', description: 'Knowledge bases' },
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
          requestBody: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 128 },
              slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' },
              description: { type: 'string' },
              systemPrompt: {
                type: 'string',
                description: 'Prepended to every member agent’s prompt — org policy lives here.',
              },
            },
            required: ['name', 'slug'],
          },
          responses: { 201: { description: 'Created', schema: wrap('workspace', 'Workspace') } },
        }),
      },

      '/v1/workspaces/{workspaceId}': {
        get: operation({
          summary: 'Get a workspace',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          responses: { 200: { description: 'The workspace', schema: wrap('workspace', 'Workspace') } },
        }),
        patch: operation({
          summary: 'Update a workspace',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              systemPrompt: { type: 'string' },
            },
          },
          responses: { 200: { description: 'Updated', schema: wrap('workspace', 'Workspace') } },
        }),
      },

      '/v1/workspaces/{workspaceId}/members': {
        put: operation({
          summary: 'Replace a workspace’s member list',
          tags: ['Workspaces'],
          parameters: [PATH_PARAM('workspaceId')],
          requestBody: {
            type: 'object',
            required: ['members'],
            properties: {
              members: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['principalId', 'role'],
                  properties: {
                    principalId: { type: 'string' },
                    role: { type: 'string', enum: [...WORKSPACE_ROLES] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated', schema: wrap('workspace', 'Workspace') } },
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
          requestBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              labels: { type: 'array', items: { type: 'string' } },
              spec: {
                type: 'object',
                description: 'An optional first version, so the agent is usable immediately.',
              },
            },
            required: ['name'],
          },
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
          requestBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              labels: { type: 'array', items: { type: 'string' } },
              productionVersion: {
                type: 'integer',
                description: 'New sessions pin this instead of the latest version.',
              },
            },
          },
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
          requestBody: {
            type: 'object',
            required: ['datasetIds'],
            properties: { datasetIds: { type: 'array', items: { type: 'string' } } },
          },
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
          requestBody: {
            type: 'object',
            properties: {
              spec: { type: 'object' },
              baseVersion: { type: 'integer' },
              changeSummary: { type: 'string' },
              replace: {
                type: 'boolean',
                default: false,
                description: 'Write a full snapshot instead of merging.',
              },
            },
            required: ['spec'],
          },
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
          requestBody: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              title: { type: 'string' },
              agentVersion: {
                type: 'integer',
                description: 'Pin explicitly; otherwise the production pin, else the latest.',
              },
              credentialIds: { type: 'array', items: { type: 'string' } },
              ttlSeconds: { type: 'integer', minimum: 60, maximum: 604800 },
            },
            required: ['agentId'],
          },
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
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 } },
            {
              name: 'types',
              in: 'query',
              description: 'Comma-separated. A trailing dot matches a namespace, e.g. `tool.`',
              schema: { type: 'string' },
            },
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
                },
              },
            },
          },
        }),
        post: operation({
          summary: 'Submit events to a session',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: {
            type: 'object',
            properties: { events: { type: 'array', items: ref('UniversalEvent') } },
            required: ['events'],
          },
          responses: {
            202: {
              description: 'Accepted',
              schema: {
                type: 'object',
                properties: { accepted: { type: 'integer' }, session: ref('Session') },
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
          requestBody: { type: 'object', properties: { reason: { type: 'string' } } },
          responses: { 200: { description: 'Interrupted', schema: wrap('session', 'Session') } },
        }),
      },

      '/v1/sessions/{sessionId}/terminate': {
        post: operation({
          summary: 'End a session',
          description: 'Irreversible. The sandbox is released and the session cannot resume.',
          tags: ['Sessions'],
          parameters: [PATH_PARAM('sessionId')],
          requestBody: { type: 'object', properties: { reason: { type: 'string' } } },
          responses: { 200: { description: 'Terminated', schema: wrap('session', 'Session') } },
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
          requestBody: {
            type: 'object',
            properties: {
              ownerType: { type: 'string', enum: ['workspace', 'agent', 'session', 'principal'] },
              type: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'string', description: 'Never returned by any endpoint.' },
              expiresAt: { type: 'integer' },
            },
            required: ['ownerType', 'type', 'name', 'value'],
          },
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
          requestBody: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['webhook', 'chat', 'hook', 'schedule', 'eventbus'] },
              name: { type: 'string' },
              agentId: { type: 'string' },
              externalKey: {
                type: 'string',
                description: 'Immutable after creation: external systems point at it.',
              },
              sessionPolicy: {
                type: 'string',
                enum: ['new_per_event', 'reuse_per_scope', 'reuse_connector'],
              },
              config: { type: 'object' },
              secretCredentialId: { type: 'string' },
            },
            required: ['type', 'name', 'externalKey'],
          },
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
          requestBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              agentId: { type: 'string' },
              config: { type: 'object' },
            },
          },
          responses: { 200: { description: 'Updated', schema: wrap('connector', 'Connector') } },
        }),
      },

      '/v1/receipts/{receiptId}/retry': {
        post: operation({
          summary: 'Replay a delivery, creating a new receipt',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('receiptId')],
          requestBody: {
            type: 'object',
            properties: { reason: { type: 'string' } },
          },
          responses: {
            201: { description: 'The replacement receipt', schema: wrap('receipt', 'Receipt') },
          },
        }),
      },

      '/v1/connectors/{connectorId}/status': {
        post: operation({
          summary: 'Change a connector’s status',
          description:
            'Activation validates against the adapter’s own rules. Archived connectors can return to draft; restore is supported rather than forcing a recreate that loses delivery history.',
          tags: ['Connectors'],
          parameters: [PATH_PARAM('connectorId')],
          requestBody: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['active', 'disabled', 'archived', 'draft'] },
              reason: { type: 'string' },
            },
            required: ['status'],
          },
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
          requestBody: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' } },
            required: ['name'],
          },
          responses: { 201: { description: 'Created', schema: wrap('dataset', 'Dataset') } },
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
          requestBody: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              source: { type: 'string', enum: ['file', 'url', 'external_doc', 'inline'] },
              content: { type: 'string' },
              syncRule: { type: 'string', enum: ['manual', 'hourly', 'daily', 'realtime'] },
            },
            required: ['name'],
          },
          responses: { 202: { description: 'Queued for ingestion', schema: wrap('document', 'Document') } },
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
            200: { description: 'A duplicate; the original receipt is returned' },
            401: { description: 'Signature verification failed' },
          },
        },
      },
    },
  };
}
