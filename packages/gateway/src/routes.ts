/**
 * API routes.
 *
 * Handlers stay thin: parse, delegate to a service, shape the response. Every
 * business rule lives in the engine, so the HTTP layer can be read for what it
 * is — a transport — and the rules are testable without a socket.
 */

import { MaError, notFound, permissionDenied, validationError } from '@ma/core';
import { parseOrThrow } from '@ma/contracts';
import type {
  AgentService,
  ArtifactService,
  MemoryService,
  TemplateService,
  PreviewService,
  Authorizer,
  CredentialService,
  QuotaService,
  SessionService,
  WorkspaceService,
} from '@ma/engine';
import { previewContentType } from '@ma/engine';
import type { Store } from '@ma/store';

import { requireAuth } from './middleware.ts';
import {
  Router,
  pageArgs,
  intQuery,
  requireBody,
  requireParam,
  type HandlerResult,
  type RequestContext,
} from './router.ts';
import {
  createAgentBody,
  createCredentialBody,
  createMemoryBody,
  createSessionBody,
  createTemplateBody,
  createVersionBody,
  createWorkspaceBody,
  instantiateTemplateBody,
  grantResourceRoleBody,
  membersBody,
  updateQuotaBody,
  promoteMemoryBody,
  reasonBody,
  renewSessionBody,
  updateAgentBody,
  updateMemoryBody,
  updateTemplateBody,
  updateWorkspaceBody,
} from './request-schemas.ts';
import { SseBridge, openStream, resolveFromSeq } from './sse.ts';

export interface RouteDeps {
  store: Store;
  /** Decides actions that membership alone must not authorize. */
  authorizer: Authorizer;
  workspaces: WorkspaceService;
  agents: AgentService;
  sessions: SessionService;
  credentials: CredentialService;
  artifacts: ArtifactService;
  memories: MemoryService;
  templates: TemplateService;
  previews: PreviewService;
  quota: QuotaService;
  sse: SseBridge;
  version: string;
}

// --- request schemas -------------------------------------------------------

// Request-body schemas live in one shared module (`request-schemas.ts`) so the
// OpenAPI generator documents the exact shape the handlers parse. See that file.

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
    const workspaceId = context.query.get('workspaceId') ?? undefined;

    // Scoping by a workspace reveals which models it may use, which is
    // information about that workspace — so membership is required to ask.
    if (workspaceId !== undefined) {
      const workspace = await deps.workspaces.get(auth, workspaceId);
      return { status: 200, body: { models: await deps.store.models.list(workspace.id) } };
    }

    // Unscoped, a caller sees only models available to everyone.
    const all = await deps.store.models.list();
    return {
      status: 200,
      body: { models: all.filter((model) => model.allowedWorkspaceIds.length === 0) },
    };
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

  // --- resource-scoped grants ----------------------------------------------

  router.get('/v1/workspaces/:workspaceId/grants', async (context) => {
    const auth = requireAuth(context);
    const grants = await deps.workspaces.listResourceGrants(
      auth,
      requireParam(context, 'workspaceId'),
    );
    return { status: 200, body: { grants } };
  });

  router.post('/v1/workspaces/:workspaceId/grants', async (context) => {
    const auth = requireAuth(context);
    const body = parseOrThrow(grantResourceRoleBody, requireBody(context));
    const grant = await deps.workspaces.grantResourceRole(
      auth,
      requireParam(context, 'workspaceId'),
      body,
    );
    return { status: 201, body: { grant } };
  });

  router.delete('/v1/workspaces/:workspaceId/grants/:grantId', async (context) => {
    const auth = requireAuth(context);
    await deps.workspaces.revokeResourceGrant(
      auth,
      requireParam(context, 'workspaceId'),
      requireParam(context, 'grantId'),
    );
    return { status: 204 };
  });

  router.get('/v1/workspaces/:workspaceId/quota', async (context) => {
    const auth = requireAuth(context);
    const workspace = await deps.workspaces.get(auth, requireParam(context, 'workspaceId'));
    return { status: 200, body: await deps.quota.snapshot(workspace) };
  });

  router.put('/v1/workspaces/:workspaceId/quota', async (context) => {
    const auth = requireAuth(context);
    const quota = parseOrThrow(updateQuotaBody, requireBody(context));
    const workspace = await deps.workspaces.updateQuota(
      auth,
      requireParam(context, 'workspaceId'),
      quota,
    );
    return { status: 200, body: { workspace } };
  });

  router.get('/v1/workspaces/:workspaceId/usage', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    const workspace = await deps.workspaces.get(auth, workspaceId);
    if (!workspace) throw notFound('Workspace', workspaceId);
    // Spend history is billing data — gated above a viewer, like the audit trail.
    deps.authorizer.require(auth, workspace, 'usage.read', { resourceId: workspaceId });

    // `from`/`to` are `YYYY-MM-DD` (UTC) or epoch-ms; the engine floors each to
    // its UTC day and defaults an absent bound (last 30 days ending today).
    const report = await deps.quota.usageHistory(
      workspaceId,
      parseDay(context.query.get('from')),
      parseDay(context.query.get('to')),
    );
    return { status: 200, body: report };
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
    // Membership is not enough: the audit trail records who did what, including
    // actions a viewer has no business seeing.
    deps.authorizer.require(auth, workspace, 'audit.read', { resourceId: workspaceId });

    // Thread every advertised filter, not just `action`. Dropping `principalId`
    // and `resourceId` silently widened an audit search to the whole workspace
    // trail — an auditor asking "what did Alice do?" got everyone's entries. The
    // store applies all of these (SqliteAuditRepository.list); the route was the
    // only place they were lost.
    const after = intQuery(context, 'after');
    const before = intQuery(context, 'before');
    const page = await deps.store.audit.list({
      workspaceId,
      ...pageArgs(context),
      ...(context.query.get('action') ? { action: context.query.get('action')! } : {}),
      ...(context.query.get('principalId') ? { principalId: context.query.get('principalId')! } : {}),
      ...(context.query.get('resourceId') ? { resourceId: context.query.get('resourceId')! } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(before !== undefined ? { before } : {}),
    });
    return { status: 200, body: page };
  });

  /**
   * Verify the tamper-evident audit hash chain.
   *
   * A platform-integrity check, not a per-workspace one: the chain spans the
   * whole audit log, so it is restricted to platform admins rather than a
   * workspace role. Returns where the chain broke, if anywhere — the answer an
   * operator or an external monitor needs to trust the audit trail. Exposed as a
   * route so the capability is reachable, not a method with no caller.
   */
  router.get('/v1/audit/verify', async (context) => {
    const auth = requireAuth(context);
    if (!auth.principal.isAdmin) {
      // Global integrity is a platform-admin concern; a workspace role does not
      // grant it, and the denial is audited like any other.
      throw permissionDenied('audit.verify', 'audit-chain');
    }
    const result = await deps.store.audit.verifyChain();
    // A broken chain is a real answer, not a server error: 200 with ok:false so
    // a monitor can poll this and alert on the body, not on a status code.
    return { status: 200, body: result };
  });

  /**
   * Extend a session's TTL.
   *
   * The service had this and no route, so a long-running agent was killed
   * mid-work by the expiry reaper with no way for its owner to say "still
   * needed". A session that outlives its purpose is the problem the TTL exists
   * for; one that outlives its *estimate* is not.
   */
  router.post('/v1/sessions/:sessionId/renew', async (context) => {
    const auth = requireAuth(context);
    const parsed = parseOrThrow(renewSessionBody, context.body);
    const session = await deps.sessions.renew(
      auth,
      requireParam(context, 'sessionId'),
      parsed.ttlSeconds,
    );
    return { status: 200, body: { session } };
  });

  // --- memories ------------------------------------------------------------

  router.get('/v1/workspaces/:workspaceId/memories', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    const agentId = context.query.get('agentId');
    return {
      status: 200,
      body: await deps.memories.list(auth, workspaceId, {
        ...pageArgs(context),
        ...(agentId ? { agentId } : {}),
        ...(context.query.get('injectableOnly') === 'true' ? { injectableOnly: true } : {}),
      }),
    };
  });

  router.post('/v1/workspaces/:workspaceId/memories', async (context) => {
    const auth = requireAuth(context);
    const result = await deps.memories.create(
      auth,
      requireParam(context, 'workspaceId'),
      parseOrThrow(createMemoryBody, context.body),
    );
    return { status: result.created ? 201 : 200, body: { memory: result.memory } };
  });

  router.get('/v1/memories/:memoryId', async (context) => {
    const auth = requireAuth(context);
    const memory = await deps.memories.get(auth, requireParam(context, 'memoryId'));
    return { status: 200, body: { memory } };
  });

  router.patch('/v1/memories/:memoryId', async (context) => {
    const auth = requireAuth(context);
    const memory = await deps.memories.update(
      auth,
      requireParam(context, 'memoryId'),
      parseOrThrow(updateMemoryBody, context.body),
    );
    return { status: 200, body: { memory } };
  });

  /**
   * Move a memory across the trust boundary, or back.
   *
   * Its own route rather than a field on PATCH, mirroring the service: this is
   * the only operation that lets agent-authored text into a system prompt, and
   * it should be impossible to perform by accident while editing something else.
   */
  router.post('/v1/memories/:memoryId/promote', async (context) => {
    const auth = requireAuth(context);
    const parsed = parseOrThrow(promoteMemoryBody, context.body);
    const memory = await deps.memories.promote(
      auth,
      requireParam(context, 'memoryId'),
      parsed.injectable,
    );
    return { status: 200, body: { memory } };
  });

  router.delete('/v1/memories/:memoryId', async (context) => {
    const auth = requireAuth(context);
    await deps.memories.forget(
      auth,
      requireParam(context, 'memoryId'),
      context.query.get('reason') ?? 'deleted through the API',
    );
    return { status: 204, body: undefined };
  });

  // --- agent templates -----------------------------------------------------

  router.get('/v1/workspaces/:workspaceId/templates', async (context) => {
    const auth = requireAuth(context);
    const category = context.query.get('category');
    return {
      status: 200,
      body: await deps.templates.list(auth, requireParam(context, 'workspaceId'), {
        ...pageArgs(context),
        ...(category ? { category } : {}),
      }),
    };
  });

  router.post('/v1/workspaces/:workspaceId/templates', async (context) => {
    const auth = requireAuth(context);
    const template = await deps.templates.create(
      auth,
      requireParam(context, 'workspaceId'),
      parseOrThrow(createTemplateBody, context.body),
    );
    return { status: 201, body: { template } };
  });

  router.get('/v1/templates/:templateId', async (context) => {
    const auth = requireAuth(context);
    const template = await deps.templates.get(auth, requireParam(context, 'templateId'));
    return { status: 200, body: { template } };
  });

  router.patch('/v1/templates/:templateId', async (context) => {
    const auth = requireAuth(context);
    const template = await deps.templates.update(
      auth,
      requireParam(context, 'templateId'),
      parseOrThrow(updateTemplateBody, context.body),
    );
    return { status: 200, body: { template } };
  });

  router.delete('/v1/templates/:templateId', async (context) => {
    const auth = requireAuth(context);
    await deps.templates.delete(auth, requireParam(context, 'templateId'));
    return { status: 204, body: undefined };
  });

  /**
   * Build an agent from a template. The new agent lands in the workspace named
   * in the path, which need not be the template's own — a built-in has none.
   */
  router.post('/v1/workspaces/:workspaceId/templates/:templateId/instantiate', async (context) => {
    const auth = requireAuth(context);
    const parsed = parseOrThrow(instantiateTemplateBody, context.body);
    const agent = await deps.templates.instantiate(auth, requireParam(context, 'templateId'), {
      workspaceId: requireParam(context, 'workspaceId'),
      ...parsed,
    });
    return { status: 201, body: { agent } };
  });

  // --- artifacts -----------------------------------------------------------

  router.get('/v1/workspaces/:workspaceId/artifacts', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    const sessionId = context.query.get('sessionId');
    return {
      status: 200,
      body: await deps.artifacts.list(auth, workspaceId, {
        ...pageArgs(context),
        ...(sessionId ? { sessionId } : {}),
      }),
    };
  });

  router.get('/v1/artifacts/:artifactId', async (context) => {
    const auth = requireAuth(context);
    const artifact = await deps.artifacts.get(auth, requireParam(context, 'artifactId'));
    return { status: 200, body: { artifact } };
  });

  /**
   * Stream an artifact's bytes.
   *
   * Written directly to the socket rather than returned as a body, because the
   * headers are the security boundary and every one of them is deliberate:
   *
   *  - `Content-Type` is the sniffed type, never the uploader's claim. It can
   *    only ever be something a browser will not execute.
   *  - `X-Content-Type-Options: nosniff` stops the browser second-guessing that
   *    and rendering the bytes as HTML anyway.
   *  - `Content-Disposition: attachment` makes it a download rather than a
   *    page. The filename is quoted and stripped of quotes and control
   *    characters, so an agent-chosen path cannot splice a second header.
   *  - `Content-Security-Policy: sandbox` is the belt-and-braces layer: even if
   *    something upstream got the type wrong, the content has no origin
   *    privileges. This matters because the console is served from the same
   *    origin as the API.
   */
  router.get('/v1/artifacts/:artifactId/content', async (context) => {
    const auth = requireAuth(context);
    const { artifact, bytes } = await deps.artifacts.download(
      auth,
      requireParam(context, 'artifactId'),
    );

    context.raw.res.writeHead(200, {
      'content-type': artifact.contentType,
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename="${downloadFilename(artifact.path)}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      // Agent output is not something an intermediary should hold.
      'cache-control': 'private, no-store',
    });
    context.raw.res.end(Buffer.from(bytes));
    return undefined;
  });

  router.delete('/v1/artifacts/:artifactId', async (context) => {
    const auth = requireAuth(context);
    const artifact = await deps.artifacts.purge(
      auth,
      requireParam(context, 'artifactId'),
      context.query.get('reason') ?? 'deleted through the API',
    );
    return { status: 200, body: { artifact } };
  });

  /**
   * Mint a signed, expiring URL that renders an artifact on the preview origin.
   *
   * Authenticated and authorized as a download — the same power to see the
   * bytes — but the URL it returns needs no bearer, so a browser can load it.
   * The URL points at a *separate* origin (see the public route below); if none
   * is configured, minting fails, because there is no safe same-origin preview.
   */
  router.post('/v1/artifacts/:artifactId/preview-token', async (context) => {
    const auth = requireAuth(context);
    const artifactId = requireParam(context, 'artifactId');
    // Reuse download's authorization + existence/purged checks: whoever may see
    // the bytes may mint a preview of them, and a purged artifact has none.
    await deps.artifacts.download(auth, artifactId);
    return { status: 201, body: deps.previews.mint(artifactId) };
  });

  /**
   * Serve artifact content for rendering, on the isolated preview origin.
   *
   * Public — a signed token in the query is the authorization, not a bearer,
   * because a browser navigation or an `<iframe>` carries none. This route is
   * safe to render agent-authored HTML *only* because it is served from an
   * origin distinct from the console (so it cannot reach the operator's session)
   * under a `sandbox` CSP. Both come from `PreviewService`.
   */
  router.get('/preview/v1/:artifactId', async (context) => {
    const artifactId = requireParam(context, 'artifactId');
    const exp = Number(context.query.get('exp') ?? '');
    const nonce = context.query.get('nonce') ?? '';
    const signature = context.query.get('sig') ?? '';

    if (!deps.previews.verify(artifactId, exp, nonce, signature)) {
      throw new MaError({
        code: 'PREVIEW_TOKEN_INVALID',
        category: 'unauthenticated',
        message: 'The preview token is missing, invalid, or expired',
      });
    }

    const { artifact, bytes } = await deps.artifacts.readForPreview(artifactId);
    // The content type here MAY be renderable (html/svg) — safe only because of
    // the separate origin and CSP the preview headers enforce.
    const contentType = previewContentType(bytes);
    void artifact;

    context.raw.res.writeHead(200, deps.previews.headers(contentType, bytes.byteLength));
    context.raw.res.end(Buffer.from(bytes));
    return undefined;
  });

  return router;
}

/**
 * A filename safe to put inside a quoted `Content-Disposition`.
 *
 * The path has already been sanitised on the way in; this is the second half of
 * the same job, at the point the value actually enters a header. Quotes would
 * end the quoted string early and control characters would end the header, so
 * both go — and only the last segment is used, since a directory prefix in a
 * download filename means nothing.
 */
function downloadFilename(path: string): string {
  const base = path.split('/').pop() ?? 'artifact';
  const safe = base.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
  return safe.length > 0 ? safe.slice(0, 255) : 'artifact';
}

/**
 * Parse a usage-range bound: a `YYYY-MM-DD` date (interpreted as UTC) or an
 * epoch-ms integer. Returns `undefined` when the param is absent so the caller
 * can apply its default; throws a validation error on a malformed value rather
 * than silently treating garbage as "now".
 */
function parseDay(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(ms)) throw validationError(`Invalid date '${value}'`);
    return ms;
  }
  if (/^\d+$/.test(value)) return Number(value);
  throw validationError(`A usage date must be YYYY-MM-DD or epoch milliseconds, got '${value}'`);
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
