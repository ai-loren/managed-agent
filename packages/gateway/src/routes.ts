/**
 * API routes.
 *
 * Handlers stay thin: parse, delegate to a service, shape the response. Every
 * business rule lives in the engine, so the HTTP layer can be read for what it
 * is — a transport — and the rules are testable without a socket.
 */

import { notFound, validationError } from '@ma/core';
import { parseOrThrow, string, object, optional, integer, array, enumOf, withDefault, boolean, record } from '@ma/contracts';
import type {
  AgentService,
  CredentialService,
  QuotaService,
  SessionService,
  WorkspaceService,
} from '@ma/engine';
import type { Store } from '@ma/store';

import { requireAuth } from './middleware.ts';
import {
  Router,
  pageArgs,
  requireBody,
  requireParam,
  type HandlerResult,
  type RequestContext,
} from './router.ts';
import { SseBridge, openStream, resolveFromSeq } from './sse.ts';

export interface RouteDeps {
  store: Store;
  workspaces: WorkspaceService;
  agents: AgentService;
  sessions: SessionService;
  credentials: CredentialService;
  quota: QuotaService;
  sse: SseBridge;
  version: string;
}

// --- request schemas -------------------------------------------------------

const createWorkspaceBody = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  slug: string({ pattern: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/ }),
  description: optional(string({ maxLength: 2000 })),
  systemPrompt: optional(string({ maxLength: 20_000 })),
});

const updateWorkspaceBody = object({
  name: optional(string({ minLength: 1, maxLength: 128 })),
  description: optional(string({ maxLength: 2000 })),
  systemPrompt: optional(string({ maxLength: 20_000 })),
});

const membersBody = object({
  members: array(
    object({
      principalId: string({ nonBlank: true }),
      role: enumOf(['owner', 'admin', 'developer', 'operator', 'viewer'] as const),
    }),
  ),
});

const createAgentBody = object({
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: optional(string({ maxLength: 2000 })),
  labels: withDefault(array(string({ maxLength: 64 })), () => []),
  // An agent spec is a nested document (model config, tool policy, sandbox
  // spec), not a flat string map. It is validated in full by the version
  // schema in the engine, so accepting an object here rather than
  // re-describing that structure keeps one source of truth.
  spec: optional(object({}, { passthrough: true })),
});

const updateAgentBody = object({
  name: optional(string({ minLength: 1, maxLength: 128 })),
  description: optional(string({ maxLength: 2000 })),
  labels: optional(array(string({ maxLength: 64 }))),
  productionVersion: optional(integer({ min: 1 })),
});

const createVersionBody = object({
  spec: object({}, { passthrough: true }),
  baseVersion: optional(integer({ min: 1 })),
  changeSummary: optional(string({ maxLength: 1000 })),
  replace: withDefault(boolean(), false),
});

const createSessionBody = object({
  agentId: string({ nonBlank: true }),
  title: optional(string({ maxLength: 256 })),
  agentVersion: optional(integer({ min: 1 })),
  credentialIds: optional(array(string())),
  ttlSeconds: optional(integer({ min: 60, max: 604_800 })),
  metadata: optional(record(string({ maxLength: 1024 }))),
});

const createCredentialBody = object({
  ownerType: enumOf(['workspace', 'agent', 'session', 'principal'] as const),
  ownerId: optional(string()),
  type: enumOf(['api_key', 'oauth_token', 'bearer_token', 'env_vars', 'file', 'ssh_key', 'basic_auth'] as const),
  name: string({ minLength: 1, maxLength: 128, nonBlank: true }),
  description: optional(string({ maxLength: 1000 })),
  value: string({ minLength: 1 }),
  expiresAt: optional(integer({ min: 0 })),
  valueKeys: optional(array(string({ maxLength: 128 }))),
});

const reasonBody = object({
  reason: withDefault(string({ maxLength: 1000 }), ''),
});

// --- routes ----------------------------------------------------------------

export function buildRoutes(deps: RouteDeps): Router {
  const router = new Router();

  // Health is public and deliberately cheap: a check that queries the database
  // reports the database's health, not the service's readiness to answer.
  router.get('/health', () =>
    Promise.resolve({ status: 200, body: { status: 'ok', version: deps.version } }),
  );

  router.get('/v1/models', async (context) => {
    const auth = requireAuth(context);
    void auth;
    const workspaceId = context.query.get('workspaceId') ?? undefined;
    return { status: 200, body: { models: await deps.store.models.list(workspaceId) } };
  });

  // --- workspaces ----------------------------------------------------------

  router.post('/v1/workspaces', async (context) => {
    const auth = requireAuth(context);
    const input = parseOrThrow(createWorkspaceBody, requireBody(context));
    const workspace = await deps.workspaces.create(auth, input);
    return { status: 201, body: { workspace } };
  });

  router.get('/v1/workspaces', async (context) => {
    const auth = requireAuth(context);
    const page = await deps.workspaces.list(auth, {
      ...pageArgs(context),
      includeArchived: context.query.get('includeArchived') === 'true',
    });
    return { status: 200, body: page };
  });

  router.get('/v1/workspaces/:workspaceId', async (context) => {
    const auth = requireAuth(context);
    const workspace = await deps.workspaces.get(auth, requireParam(context, 'workspaceId'));
    return { status: 200, body: { workspace } };
  });

  router.patch('/v1/workspaces/:workspaceId', async (context) => {
    const auth = requireAuth(context);
    const patch = parseOrThrow(updateWorkspaceBody, requireBody(context));
    const workspace = await deps.workspaces.update(
      auth,
      requireParam(context, 'workspaceId'),
      patch,
    );
    return { status: 200, body: { workspace } };
  });

  router.put('/v1/workspaces/:workspaceId/members', async (context) => {
    const auth = requireAuth(context);
    const { members } = parseOrThrow(membersBody, requireBody(context));
    const workspace = await deps.workspaces.updateMembers(
      auth,
      requireParam(context, 'workspaceId'),
      members,
    );
    return { status: 200, body: { workspace } };
  });

  router.get('/v1/workspaces/:workspaceId/quota', async (context) => {
    const auth = requireAuth(context);
    const workspace = await deps.workspaces.get(auth, requireParam(context, 'workspaceId'));
    return { status: 200, body: await deps.quota.snapshot(workspace) };
  });

  router.post('/v1/workspaces/:workspaceId/archive', async (context) => {
    const auth = requireAuth(context);
    const { reason } = parseOrThrow(reasonBody, context.body ?? {});
    const workspace = await deps.workspaces.archive(
      auth,
      requireParam(context, 'workspaceId'),
      reason,
    );
    return { status: 200, body: { workspace } };
  });

  // --- agents --------------------------------------------------------------

  router.post('/v1/workspaces/:workspaceId/agents', async (context) => {
    const auth = requireAuth(context);
    const input = parseOrThrow(createAgentBody, requireBody(context));
    const agent = await deps.agents.create(auth, {
      workspaceId: requireParam(context, 'workspaceId'),
      ...input,
    });
    return { status: 201, body: { agent } };
  });

  router.get('/v1/workspaces/:workspaceId/agents', async (context) => {
    const auth = requireAuth(context);
    const page = await deps.agents.list(auth, requireParam(context, 'workspaceId'), {
      ...pageArgs(context),
      includeArchived: context.query.get('includeArchived') === 'true',
    });
    return { status: 200, body: page };
  });

  router.get('/v1/agents/:agentId', async (context) => {
    const auth = requireAuth(context);
    const agent = await deps.agents.get(auth, requireParam(context, 'agentId'));
    return { status: 200, body: { agent } };
  });

  router.patch('/v1/agents/:agentId', async (context) => {
    const auth = requireAuth(context);
    const patch = parseOrThrow(updateAgentBody, requireBody(context));
    const agent = await deps.agents.update(auth, requireParam(context, 'agentId'), patch);
    return { status: 200, body: { agent } };
  });

  router.post('/v1/agents/:agentId/archive', async (context) => {
    const auth = requireAuth(context);
    const { reason } = parseOrThrow(reasonBody, context.body ?? {});
    const agent = await deps.agents.archive(auth, requireParam(context, 'agentId'), reason);
    return { status: 200, body: { agent } };
  });

  router.post('/v1/agents/:agentId/versions', async (context) => {
    const auth = requireAuth(context);
    const input = parseOrThrow(createVersionBody, requireBody(context));
    // The diff goes back with the version so a caller sees what changed before
    // anything starts depending on it.
    const result = await deps.agents.createVersion(auth, requireParam(context, 'agentId'), {
      spec: input.spec as Record<string, unknown>,
      ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
      ...(input.changeSummary === undefined ? {} : { changeSummary: input.changeSummary }),
      replace: input.replace,
    });
    return { status: 201, body: result };
  });

  router.get('/v1/agents/:agentId/versions', async (context) => {
    const auth = requireAuth(context);
    const page = await deps.agents.listVersions(
      auth,
      requireParam(context, 'agentId'),
      pageArgs(context),
    );
    return { status: 200, body: page };
  });

  router.get('/v1/agents/:agentId/versions/:version', async (context) => {
    const auth = requireAuth(context);
    const raw = requireParam(context, 'version');
    const version = Number(raw);
    if (!Number.isInteger(version) || version < 1) {
      throw validationError('Version must be a positive integer', { version: raw });
    }
    const found = await deps.agents.getVersion(auth, requireParam(context, 'agentId'), version);
    return { status: 200, body: { version: found } };
  });

  // --- sessions ------------------------------------------------------------

  router.post('/v1/sessions', async (context) => {
    const auth = requireAuth(context);
    const input = parseOrThrow(createSessionBody, requireBody(context));
    const session = await deps.sessions.create(auth, { ...input, origin: 'api' });
    return { status: 201, body: { session } };
  });

  router.get('/v1/sessions', async (context) => {
    const auth = requireAuth(context);
    const statuses = context.query.get('statuses');
    const page = await deps.sessions.list(auth, {
      ...pageArgs(context),
      ...(context.query.get('workspaceId')
        ? { workspaceId: context.query.get('workspaceId')! }
        : {}),
      ...(context.query.get('agentId') ? { agentId: context.query.get('agentId')! } : {}),
      ...(statuses
        ? { statuses: statuses.split(',') as Parameters<typeof deps.sessions.list>[1]['statuses'] }
        : {}),
    });
    return { status: 200, body: page };
  });

  router.get('/v1/sessions/:sessionId', async (context) => {
    const auth = requireAuth(context);
    const session = await deps.sessions.get(auth, requireParam(context, 'sessionId'));
    return { status: 200, body: { session } };
  });

  router.post('/v1/sessions/:sessionId/events', async (context) => {
    const auth = requireAuth(context);
    const body = requireBody(context);
    const key = context.headers['idempotency-key'];
    const result = await deps.sessions.submit(auth, requireParam(context, 'sessionId'), {
      events: body.events,
      ...(typeof key === 'string' ? { idempotencyKey: key } : {}),
    });
    return { status: 202, body: { accepted: result.accepted, session: result.session } };
  });

  router.get('/v1/sessions/:sessionId/events', async (context) => {
    const auth = requireAuth(context);
    const fromSeq = Number(context.query.get('fromSeq') ?? '0');
    const limit = Number(context.query.get('limit') ?? '200');
    const types = context.query.get('types');

    const result = await deps.sessions.readEvents(auth, requireParam(context, 'sessionId'), {
      fromSeq: Number.isInteger(fromSeq) && fromSeq >= 0 ? fromSeq : 0,
      limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 200,
      ...(types ? { types: types.split(',') } : {}),
    });
    return { status: 200, body: result };
  });

  /**
   * Live event stream.
   *
   * Returns `undefined` because the handler writes the response itself: SSE
   * cannot go through the normal serialize-and-send path.
   */
  router.get('/v1/sessions/:sessionId/events/stream', async (context) => {
    const auth = requireAuth(context);
    const sessionId = requireParam(context, 'sessionId');
    // Authorize before opening the stream, so an unauthorized caller gets a
    // clean 403 rather than an empty stream that never explains itself.
    await deps.sessions.get(auth, sessionId);

    const fromSeq = resolveFromSeq(
      context.headers['last-event-id'],
      context.query.get('fromSeq'),
    );
    const types = context.query.get('types');

    openStream(context.raw.res, context.requestId);
    await deps.sse.stream(
      {
        sessionId,
        fromSeq,
        ...(types ? { types: types.split(',') } : {}),
        signal: context.signal,
      },
      context.raw.res,
    );
    return undefined;
  });

  router.post('/v1/sessions/:sessionId/interrupt', async (context) => {
    const auth = requireAuth(context);
    const { reason } = parseOrThrow(reasonBody, context.body ?? {});
    const session = await deps.sessions.interrupt(
      auth,
      requireParam(context, 'sessionId'),
      reason,
    );
    return { status: 200, body: { session } };
  });

  router.post('/v1/sessions/:sessionId/terminate', async (context) => {
    const auth = requireAuth(context);
    const { reason } = parseOrThrow(reasonBody, context.body ?? {});
    const session = await deps.sessions.terminate(
      auth,
      requireParam(context, 'sessionId'),
      reason,
    );
    return { status: 200, body: { session } };
  });

  // --- credentials ---------------------------------------------------------

  router.post('/v1/workspaces/:workspaceId/credentials', async (context) => {
    const auth = requireAuth(context);
    const input = parseOrThrow(createCredentialBody, requireBody(context));
    const credential = await deps.credentials.create(auth, {
      workspaceId: requireParam(context, 'workspaceId'),
      ...input,
    });
    // The response carries metadata only. There is deliberately no endpoint
    // that returns a credential value.
    return { status: 201, body: { credential } };
  });

  router.get('/v1/workspaces/:workspaceId/credentials', async (context) => {
    const auth = requireAuth(context);
    const page = await deps.credentials.list(auth, {
      workspaceId: requireParam(context, 'workspaceId'),
      ...pageArgs(context),
    });
    return { status: 200, body: page };
  });

  router.get('/v1/credentials/:credentialId', async (context) => {
    const auth = requireAuth(context);
    const credential = await deps.credentials.get(auth, requireParam(context, 'credentialId'));
    return { status: 200, body: { credential } };
  });

  router.delete('/v1/credentials/:credentialId', async (context) => {
    const auth = requireAuth(context);
    const { reason } = parseOrThrow(reasonBody, context.body ?? {});
    await deps.credentials.delete(auth, requireParam(context, 'credentialId'), reason);
    return { status: 204 };
  });

  // --- audit ---------------------------------------------------------------

  router.get('/v1/workspaces/:workspaceId/audit', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    const workspace = await deps.workspaces.get(auth, workspaceId);
    if (!workspace) throw notFound('Workspace', workspaceId);

    const page = await deps.store.audit.list({
      workspaceId,
      ...pageArgs(context),
      ...(context.query.get('action') ? { action: context.query.get('action')! } : {}),
    });
    return { status: 200, body: page };
  });

  return router;
}

/** Used by the server for a 404 that names what was not found. */
export function routeNotFound(context: RequestContext): HandlerResult {
  return {
    status: 404,
    body: {
      error: {
        code: 'ROUTE_NOT_FOUND',
        category: 'not_found',
        message: `No route for ${context.method} ${context.path}`,
        retryable: false,
        requestId: context.requestId,
      },
    },
  };
}
