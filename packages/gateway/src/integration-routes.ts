/**
 * Connector, schedule and dataset routes.
 *
 * Split from the core resource routes because these three share a shape the
 * others do not: they are all *configuration for things that happen later*, and
 * each has an activation step whose validation is type-specific.
 */

import { newId, notFound, validationError, type Clock } from '@ma/core';
import { connectorMachine, parseOrThrow, type Connector } from '@ma/contracts';
import type { Store } from '@ma/store';
import type { Action, AuthContext, WorkspaceService } from '@ma/engine';

import { requireAuth } from './middleware.ts';
import { pageArgs, requireBody, requireParam, type Router } from './router.ts';
import {
  bindDatasetsBody,
  connectorStatusBody as statusBody,
  createConnectorBody,
  createDatasetBody,
  createDocumentBody,
  updateConnectorBody,
} from './request-schemas.ts';

/** What these routes need. Kept narrow so the gateway stays testable. */
export interface IntegrationDeps {
  store: Store;
  clock: Clock;
  workspaces: WorkspaceService;
  /**
   * Decides an action against a workspace.
   *
   * Passed in rather than inferred from `workspaces.get`: that call only proves
   * membership, and using it as the gate for a write silently grants every
   * member — including a viewer — permission to perform it.
   */
  authorize(auth: AuthContext, workspaceId: string, action: Action): Promise<void>;
  /**
   * Hands an uploaded document's bytes to the ingestion pipeline.
   *
   * Absent means uploads are accepted and never processed. The route used to
   * create the row and drop `content` on the floor, so every document sat at
   * `pending` forever and the knowledge base was permanently empty — while the
   * API reported success.
   */
  stageDocument?(documentId: string, content: string): void;
  /** Validates and activates a connector using its own adapter's rules. */
  activate(connectorId: string): Promise<Connector>;
  /** Recomputes a schedule's next fire time after a change. */
  rescheduleNext(connectorId: string): Promise<number | undefined>;
  /** Replays a terminal delivery as a fresh receipt. */
  retryReceipt(receiptId: string, reason: string): Promise<{ id: string }>;
}

export function registerIntegrationRoutes(router: Router, deps: IntegrationDeps): void {
  // --- connectors ----------------------------------------------------------

  router.post('/v1/workspaces/:workspaceId/connectors', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    await deps.authorize(auth, workspaceId, 'connector.create');
    const workspace = await deps.workspaces.get(auth, workspaceId);
    const input = parseOrThrow(createConnectorBody, requireBody(context));

    const now = deps.clock.now();
    const connector = await deps.store.connectors.create({
      id: newId('connector', now),
      workspaceId: workspace.id,
      type: input.type,
      name: input.name,
      description: input.description ?? '',
      // Always draft: a connector is validated and activated as a separate,
      // deliberate step, so a half-configured one never receives traffic.
      status: 'draft',
      ...(input.agentId ? { agentId: input.agentId } : {}),
      externalKey: input.externalKey,
      sessionPolicy: input.sessionPolicy,
      config: input.config,
      ...(input.secretCredentialId ? { secretCredentialId: input.secretCredentialId } : {}),
      ownerPrincipalId: auth.principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: auth.principal.id,
    });

    return { status: 201, body: { connector } };
  });

  router.get('/v1/workspaces/:workspaceId/connectors', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    await deps.authorize(auth, workspaceId, 'connector.read');

    const page = await deps.store.connectors.list({
      workspaceId,
      ...pageArgs(context),
      ...(context.query.get('type') ? { type: context.query.get('type')! } : {}),
      includeArchived: context.query.get('includeArchived') === 'true',
    });
    return { status: 200, body: page };
  });

  router.get('/v1/connectors/:connectorId', async (context) => {
    const auth = requireAuth(context);
    const connector = await deps.store.connectors.get(requireParam(context, 'connectorId'));
    if (!connector) throw notFound('Connector', requireParam(context, 'connectorId'));
    await deps.authorize(auth, connector.workspaceId, 'connector.read');
    return { status: 200, body: { connector } };
  });

  router.patch('/v1/connectors/:connectorId', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const existing = await deps.store.connectors.get(connectorId);
    if (!existing) throw notFound('Connector', connectorId);
    await deps.authorize(auth, existing.workspaceId, 'connector.update');

    const patch = parseOrThrow(updateConnectorBody, requireBody(context));
    const connector = await deps.store.connectors.update(connectorId, {
      ...patch,
      updatedAt: deps.clock.now(),
    });

    // A schedule whose cron changed needs its next fire recomputed, or it would
    // keep firing on the old expression until the next restart.
    if (connector.type === 'schedule' && patch.config) {
      await deps.rescheduleNext(connectorId);
    }
    return { status: 200, body: { connector } };
  });

  /**
   * Change a connector's status.
   *
   * Activation runs the adapter's own validation, so one integration's
   * requirements can never block another's. Archived connectors can return to
   * draft — restore is supported rather than forcing a recreate that loses the
   * delivery history.
   */
  router.post('/v1/connectors/:connectorId/status', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const existing = await deps.store.connectors.get(connectorId);
    if (!existing) throw notFound('Connector', connectorId);
    // Activation is an admin action: it is what puts a connector on the
    // network, so it is gated more tightly than editing a draft.
    await deps.authorize(auth, existing.workspaceId, 'connector.activate');

    const { status } = parseOrThrow(statusBody, requireBody(context));
    connectorMachine.assert(existing.status, status);

    if (status === 'active') {
      const connector = await deps.activate(connectorId);
      if (connector.type === 'schedule') await deps.rescheduleNext(connectorId);
      return { status: 200, body: { connector } };
    }

    const now = deps.clock.now();
    const connector = await deps.store.connectors.update(connectorId, {
      status,
      ...(status === 'archived' ? { archivedAt: now } : {}),
      updatedAt: now,
    });
    // A connector that is no longer active must stop being scheduled.
    if (connector.type === 'schedule') await deps.rescheduleNext(connectorId);
    return { status: 200, body: { connector } };
  });

  /** Delivery history — the answer to "what happened to that alert?". */
  router.get('/v1/connectors/:connectorId/receipts', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const connector = await deps.store.connectors.get(connectorId);
    if (!connector) throw notFound('Connector', connectorId);
    await deps.authorize(auth, connector.workspaceId, 'connector.receipt.read');

    const statuses = context.query.get('statuses');
    const page = await deps.store.receipts.list({
      connectorId,
      ...pageArgs(context),
      ...(statuses ? { statuses: statuses.split(',') as never } : {}),
    });
    return { status: 200, body: page };
  });

  router.post('/v1/receipts/:receiptId/retry', async (context) => {
    const auth = requireAuth(context);
    const receiptId = requireParam(context, 'receiptId');
    const receipt = await deps.store.receipts.get(receiptId);
    if (!receipt) throw notFound('Receipt', receiptId);
    await deps.authorize(auth, receipt.workspaceId, 'connector.receipt.retry');

    const reason =
      typeof (context.body as { reason?: unknown })?.reason === 'string'
        ? String((context.body as { reason: string }).reason)
        : 'replayed by an operator';
    const replay = await deps.retryReceipt(receiptId, reason);
    return { status: 202, body: { receiptId: replay.id } };
  });

  /**
   * Fire a schedule now, without waiting for its cron.
   *
   * Present because testing a nightly job by waiting until tonight is not a
   * workflow; the reference platform's absence of this is a real gap.
   */
  router.post('/v1/connectors/:connectorId/run', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const connector = await deps.store.connectors.get(connectorId);
    if (!connector) throw notFound('Connector', connectorId);
    // Firing a schedule starts real work, so it is an operator action rather
    // than a read.
    await deps.authorize(auth, connector.workspaceId, 'connector.receipt.retry');

    if (connector.type !== 'schedule') {
      throw validationError('Only schedule connectors can be run on demand', { connectorId });
    }
    if (connector.status !== 'active') {
      throw validationError('This schedule is not active', { status: connector.status });
    }

    const now = deps.clock.now();
    const { receipt, created } = await deps.store.receipts.createIfAbsent({
      id: newId('receipt', now),
      connectorId,
      workspaceId: connector.workspaceId,
      // Distinct from a cron-generated id, so a manual run and a scheduled one
      // in the same minute are two deliveries rather than one deduplicated away.
      externalEventId: `${connectorId}:manual:${now}`,
      status: 'pending',
      attempt: 0,
      maxAttempts: 3,
      payloadSummary: String((connector.config as { prompt?: string }).prompt ?? ''),
      responseContext: {},
      createdAt: now,
      updatedAt: now,
      createdBy: auth.principal.id,
    });

    return { status: 202, body: { receiptId: receipt.id, created } };
  });

  /** When a schedule will next fire, so an operator can verify a cron change. */
  router.get('/v1/connectors/:connectorId/next-fire', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const connector = await deps.store.connectors.get(connectorId);
    if (!connector) throw notFound('Connector', connectorId);
    await deps.authorize(auth, connector.workspaceId, 'connector.read');

    const nextFireAt = deps.store.connectors.nextFireAt(connectorId);
    return {
      status: 200,
      body: {
        nextFireAt: nextFireAt ?? null,
        nextFireIso: nextFireAt ? new Date(nextFireAt).toISOString() : null,
      },
    };
  });

  // --- datasets ------------------------------------------------------------

  router.post('/v1/workspaces/:workspaceId/datasets', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    await deps.authorize(auth, workspaceId, 'dataset.create');
    const workspace = await deps.workspaces.get(auth, workspaceId);
    const input = parseOrThrow(createDatasetBody, requireBody(context));

    const now = deps.clock.now();
    const dataset = await deps.store.datasets.create({
      id: newId('dataset', now),
      workspaceId: workspace.id,
      name: input.name,
      description: input.description ?? '',
      status: 'active',
      documentCount: 0,
      chunkCount: 0,
      sizeBytes: 0,
      embeddingModel: input.embeddingModel ?? '',
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: auth.principal.id,
    });
    return { status: 201, body: { dataset } };
  });

  router.get('/v1/workspaces/:workspaceId/datasets', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    await deps.authorize(auth, workspaceId, 'dataset.read');
    const page = await deps.store.datasets.list({ workspaceId, ...pageArgs(context) });
    return { status: 200, body: page };
  });

  router.post('/v1/datasets/:datasetId/documents', async (context) => {
    const auth = requireAuth(context);
    const datasetId = requireParam(context, 'datasetId');
    const dataset = await deps.store.datasets.get(datasetId);
    if (!dataset) throw notFound('Dataset', datasetId);
    // Documents reach an agent's context through retrieval, so writing one is
    // effectively writing to what the agent will read and believe.
    await deps.authorize(auth, dataset.workspaceId, 'dataset.document.upload');

    const input = parseOrThrow(createDocumentBody, requireBody(context));
    const now = deps.clock.now();

    const document = await deps.store.documents.create({
      id: newId('document', now),
      datasetId,
      workspaceId: dataset.workspaceId,
      name: input.name,
      source: input.source,
      sourceRef: input.sourceRef,
      contentType: input.contentType,
      sizeBytes: input.content ? Buffer.byteLength(input.content, 'utf8') : 0,
      digest: '',
      // Ingestion is asynchronous, so the document starts pending and the
      // pipeline moves it on. Returning "ready" here would be a lie.
      status: 'pending',
      syncRule: input.syncRule,
      chunkCount: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: auth.principal.id,
    });

    // The bytes, before anything can process them. The row exists either way;
    // without this the pipeline finds a document it cannot read and fails it.
    if (input.content !== undefined) deps.stageDocument?.(document.id, input.content);

    await deps.store.datasets.update(datasetId, {
      documentCount: dataset.documentCount + 1,
      updatedAt: now,
    });

    return { status: 202, body: { document } };
  });

  router.get('/v1/datasets/:datasetId/documents', async (context) => {
    const auth = requireAuth(context);
    const datasetId = requireParam(context, 'datasetId');
    const dataset = await deps.store.datasets.get(datasetId);
    if (!dataset) throw notFound('Dataset', datasetId);
    await deps.authorize(auth, dataset.workspaceId, 'dataset.read');

    const page = await deps.store.documents.list({
      datasetId,
      ...pageArgs(context),
      ...(context.query.get('status') ? { status: context.query.get('status')! } : {}),
    });
    return { status: 200, body: page };
  });

  /** Bind datasets to an agent, which is what exposes them to its retrieval tool. */
  router.put('/v1/agents/:agentId/datasets', async (context) => {
    const auth = requireAuth(context);
    const agentId = requireParam(context, 'agentId');
    const agent = await deps.store.agents.get(agentId);
    if (!agent) throw notFound('Agent', agentId);
    // Binding a dataset changes what the agent reads, so it is an agent update.
    await deps.authorize(auth, agent.workspaceId, 'agent.update');

    const { datasetIds } = parseOrThrow(bindDatasetsBody, requireBody(context));

    // Every dataset must exist and belong to the same workspace: a binding that
    // reached across workspaces would be a data-isolation breach.
    for (const datasetId of datasetIds) {
      const dataset = await deps.store.datasets.get(datasetId);
      if (!dataset) throw notFound('Dataset', datasetId);
      if (dataset.workspaceId !== agent.workspaceId) {
        throw validationError('A dataset must belong to the agent’s workspace', { datasetId });
      }
    }

    return { status: 200, body: { agentId, datasetIds } };
  });
}
