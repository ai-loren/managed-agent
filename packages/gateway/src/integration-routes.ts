/**
 * Connector, schedule and dataset routes.
 *
 * Split from the core resource routes because these three share a shape the
 * others do not: they are all *configuration for things that happen later*, and
 * each has an activation step whose validation is type-specific.
 */

import { newId, notFound, validationError, type Clock } from '@ma/core';
import {
  connectorMachine,
  deliveryPrompt,
  parseOrThrow,
  type Connector,
  type GrantableResourceKind,
} from '@ma/contracts';
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
   * Like `authorize`, but for an action on a *specific* resource — it resolves
   * any fine-grained grant the principal holds on `(kind, id)` and lets it raise
   * the effective role. Connectors and datasets are grantable resource kinds, so
   * without this a grant on one connector/dataset is stored but never consulted:
   * the admin believes access was conferred and it silently is not. `kind` must
   * be the action's namespace (`connector` for `connector.*`, `dataset` for
   * `dataset.*`).
   */
  authorizeResource(
    auth: AuthContext,
    workspaceId: string,
    action: Action,
    resource: { kind: GrantableResourceKind; id: string },
  ): Promise<void>;
  /**
   * Hands an uploaded document's bytes to the ingestion pipeline.
   *
   * Absent means uploads are accepted and never processed. The route used to
   * create the row and drop `content` on the floor, so every document sat at
   * `pending` forever and the knowledge base was permanently empty — while the
   * API reported success.
   */
  stageDocument?(documentId: string, content: string): Promise<void>;
  /** Validates and activates a connector using its own adapter's rules. */
  activate(connectorId: string): Promise<Connector>;
  /** Recomputes a schedule's next fire time after a change. */
  rescheduleNext(connectorId: string): Promise<number | undefined>;
  /** Replays a terminal delivery as a fresh receipt. */
  retryReceipt(receiptId: string, reason: string): Promise<{ id: string }>;
  /**
   * Bind a set of datasets to an agent by cutting a new version whose
   * `datasetIds` are the merge of the current production version's and the
   * requested ones. Versions are immutable, so a "bind" is a new version rather
   * than an in-place edit — and `createVersion` is where dataset ownership is
   * authorized and enforced. Returns the datasetIds now in effect.
   */
  bindDatasets(
    auth: AuthContext,
    agentId: string,
    datasetIds: readonly string[],
  ): Promise<{ agentId: string; version: number; datasetIds: string[] }>;
  /**
   * Delete a dataset: evict its documents' chunks from the search index and
   * delete the row (documents cascade via the FK). Returns how many documents
   * were evicted. See `IngestionPipeline.deleteDataset` for why the eviction is
   * load-bearing (the index has no database FK to cascade through).
   */
  deleteDataset(datasetId: string): Promise<number>;
  /**
   * Delete one document, scoped to its dataset: evict its chunks from the search
   * index, drop staged content, decrement the dataset's counts, and delete the
   * row. A `(datasetId, documentId)` mismatch is a not-found. Returns chunks
   * evicted. See `IngestionPipeline.deleteDocument`.
   */
  deleteDocument(datasetId: string, documentId: string): Promise<number>;
}

export function registerIntegrationRoutes(router: Router, deps: IntegrationDeps): void {
  // --- connectors ----------------------------------------------------------

  /**
   * Confirm a caller-supplied `secretCredentialId` is one this workspace owns and
   * the caller may read.
   *
   * The connector's secret is later unsealed by the delivery pipeline with no
   * session to authorize against (`unsealForConnector`), and the unseal's AAD is
   * the credential's own id — so it succeeds for ANY credential id, including one
   * belonging to another workspace. Without this check a member of workspace A
   * could bind workspace B's credential id (learned out of band) to an A connector
   * and have the platform decrypt and use B's secret. Mirror the same gate
   * `SessionService.create` applies to caller-supplied credential ids: the
   * credential must belong to this workspace, and the caller must hold
   * `credential.read` on it. A not-found or foreign id is reported as not-found so
   * it cannot be used to probe another workspace's credential space.
   */
  async function requireOwnedSecretCredential(
    auth: AuthContext,
    workspaceId: string,
    secretCredentialId: string | undefined,
  ): Promise<void> {
    if (secretCredentialId === undefined) return;
    const credential = await deps.store.credentials.get(secretCredentialId);
    if (!credential || credential.workspaceId !== workspaceId) {
      throw notFound('Credential', secretCredentialId);
    }
    await deps.authorizeResource(auth, workspaceId, 'credential.read', {
      kind: 'credential',
      id: secretCredentialId,
    });
  }

  router.post('/v1/workspaces/:workspaceId/connectors', async (context) => {
    const auth = requireAuth(context);
    const workspaceId = requireParam(context, 'workspaceId');
    await deps.authorize(auth, workspaceId, 'connector.create');
    const workspace = await deps.workspaces.get(auth, workspaceId);
    const input = parseOrThrow(createConnectorBody, requireBody(context));
    await requireOwnedSecretCredential(auth, workspace.id, input.secretCredentialId);

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
    await deps.authorizeResource(auth, connector.workspaceId, 'connector.read', {
      kind: 'connector',
      id: connector.id,
    });
    return { status: 200, body: { connector } };
  });

  router.patch('/v1/connectors/:connectorId', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const existing = await deps.store.connectors.get(connectorId);
    if (!existing) throw notFound('Connector', connectorId);
    await deps.authorizeResource(auth, existing.workspaceId, 'connector.update', {
      kind: 'connector',
      id: connectorId,
    });

    const patch = parseOrThrow(updateConnectorBody, requireBody(context));
    // A patch that (re)points the connector at a secret must pass the same
    // workspace-ownership + read check as create — otherwise the ownership gate on
    // create is trivially sidestepped by creating without a secret then patching
    // one in.
    await requireOwnedSecretCredential(auth, existing.workspaceId, patch.secretCredentialId);
    const connector = await deps.store.connectors.update(connectorId, {
      ...patch,
      updatedAt: deps.clock.now(),
    });

    // A schedule whose cron changed needs its next fire recomputed, or it would
    // keep firing on the old expression until the next restart.
    if (connector.type === 'schedule' && patch.config) {
      await deps.rescheduleNext(connectorId);
      // rescheduleNext may disable an unfireable schedule, so re-read to return
      // the true post-reschedule state rather than the pre-reschedule object.
      const settled = await deps.store.connectors.get(connectorId);
      return { status: 200, body: { connector: settled ?? connector } };
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
    await deps.authorizeResource(auth, existing.workspaceId, 'connector.activate', {
      kind: 'connector',
      id: connectorId,
    });

    const { status } = parseOrThrow(statusBody, requireBody(context));
    connectorMachine.assert(existing.status, status);

    if (status === 'active') {
      const connector = await deps.activate(connectorId);
      if (connector.type === 'schedule') {
        await deps.rescheduleNext(connectorId);
        // rescheduleNext may disable an unfireable schedule (a cron with no next
        // occurrence in the horizon), so re-read rather than returning the
        // pre-reschedule object — otherwise the response would claim `active`
        // while the row is `failed`.
        const settled = await deps.store.connectors.get(connectorId);
        return { status: 200, body: { connector: settled ?? connector } };
      }
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

  /**
   * Hard-delete a connector and its history.
   *
   * Archive (via the status route) is the reversible default; this is the
   * deliberate, irreversible one — for a connector created in error, or a tenant
   * offboarding. Gated on `connector.delete` (admin), a higher bar than editing a
   * draft, because it destroys the delivery history rather than hiding it.
   *
   * The connector's bindings and receipts are removed atomically by the schema's
   * `ON DELETE CASCADE` foreign keys (with `PRAGMA foreign_keys = ON`), so there
   * is no manual cascade to get wrong. Ingress resolves a connector by its
   * external key and rejects anything not `active`, so the key stops working the
   * instant the row is gone; a `schedule` connector cannot be re-selected because
   * the poll-based scheduler claims by row and the row no longer exists.
   */
  router.delete('/v1/connectors/:connectorId', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const existing = await deps.store.connectors.get(connectorId);
    if (!existing) throw notFound('Connector', connectorId);
    await deps.authorizeResource(auth, existing.workspaceId, 'connector.delete', {
      kind: 'connector',
      id: connectorId,
    });
    await deps.store.connectors.delete(connectorId);
    return { status: 204 };
  });

  /** Delivery history — the answer to "what happened to that alert?". */
  router.get('/v1/connectors/:connectorId/receipts', async (context) => {
    const auth = requireAuth(context);
    const connectorId = requireParam(context, 'connectorId');
    const connector = await deps.store.connectors.get(connectorId);
    if (!connector) throw notFound('Connector', connectorId);
    await deps.authorizeResource(auth, connector.workspaceId, 'connector.receipt.read', {
      kind: 'connector',
      id: connectorId,
    });

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
    await deps.authorizeResource(auth, receipt.workspaceId, 'connector.receipt.retry', {
      kind: 'connector',
      id: receipt.connectorId,
    });

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
    await deps.authorizeResource(auth, connector.workspaceId, 'connector.receipt.retry', {
      kind: 'connector',
      id: connectorId,
    });

    if (connector.type !== 'schedule') {
      throw validationError('Only schedule connectors can be run on demand', { connectorId });
    }
    if (connector.status !== 'active') {
      throw validationError('This schedule is not active', { status: connector.status });
    }

    const now = deps.clock.now();
    const prompt = String((connector.config as { prompt?: string }).prompt ?? '');
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
      payloadSummary: prompt.slice(0, 4000),
      prompt: deliveryPrompt(prompt),
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
    await deps.authorizeResource(auth, connector.workspaceId, 'connector.read', {
      kind: 'connector',
      id: connectorId,
    });

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
    await deps.authorizeResource(auth, dataset.workspaceId, 'dataset.document.upload', {
      kind: 'dataset',
      id: datasetId,
    });

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
      // Size and chunk count are established by ingestion, not at creation. The
      // dataset's rolled-up `sizeBytes` is maintained by `process()` as a delta
      // (`dataset.sizeBytes - current.sizeBytes + newBytes`). If we seeded
      // `document.sizeBytes` with the content length here, the first ingest's delta
      // would be `- N + N = 0` and the dataset total would never accrue this
      // document's size — a permanent under-count. Start at 0, exactly as
      // `chunkCount` does, so ingestion establishes the real value.
      sizeBytes: 0,
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
    // Awaited so the content is durably staged (blob + digest) before the 202 —
    // a restart in the accept→first-tick window would otherwise lose it.
    if (input.content !== undefined) await deps.stageDocument?.(document.id, input.content);

    // Increment the dataset's document count by a signed delta, atomically. Not a
    // `get()`-then-`update(dataset.documentCount + 1)`: `dataset` was read at the
    // top of the handler, before the `documents.create` and `stageDocument`
    // awaits, so a concurrent delete's atomic decrement (or another create) can
    // commit in that wide window and be clobbered by an absolute write from the
    // stale count. `applyRollupDeltaSync` is one in-SQL statement, so the +1
    // composes with any concurrent rollup change.
    await deps.store.transaction((tx) => {
      tx.datasets.applyRollupDeltaSync(datasetId, { documentCount: 1 }, now);
    });

    return { status: 202, body: { document } };
  });

  router.get('/v1/datasets/:datasetId/documents', async (context) => {
    const auth = requireAuth(context);
    const datasetId = requireParam(context, 'datasetId');
    const dataset = await deps.store.datasets.get(datasetId);
    if (!dataset) throw notFound('Dataset', datasetId);
    await deps.authorizeResource(auth, dataset.workspaceId, 'dataset.read', {
      kind: 'dataset',
      id: datasetId,
    });

    const page = await deps.store.documents.list({
      datasetId,
      ...pageArgs(context),
      ...(context.query.get('status') ? { status: context.query.get('status')! } : {}),
    });
    return { status: 200, body: page };
  });

  /**
   * Delete one document from a dataset.
   *
   * Deleting a document releases the chunk-quota usage it held and closes the
   * `documentCount` over-count (the count was incremented on create but, before
   * this route existed, never decremented — there was no per-document delete at
   * all). Authorized under `dataset.document.upload`: deleting a document is the
   * same class of write to the agent-visible corpus as uploading one (delete is
   * symmetric with create), so it shares that action rather than expanding the
   * action surface. Scoped to the path dataset — a document whose datasetId does
   * not match is a not-found, not a cross-dataset delete.
   */
  router.delete('/v1/datasets/:datasetId/documents/:documentId', async (context) => {
    const auth = requireAuth(context);
    const datasetId = requireParam(context, 'datasetId');
    const documentId = requireParam(context, 'documentId');
    const dataset = await deps.store.datasets.get(datasetId);
    if (!dataset) throw notFound('Dataset', datasetId);
    await deps.authorizeResource(auth, dataset.workspaceId, 'dataset.document.upload', {
      kind: 'dataset',
      id: datasetId,
    });
    const chunksEvicted = await deps.deleteDocument(datasetId, documentId);
    return { status: 200, body: { datasetId, documentId, chunksEvicted } };
  });

  /**
   * Delete a dataset and everything under it.
   *
   * Datasets and their documents used to accumulate with no way to remove them —
   * `datasets.delete` existed in the store but had no route, no admin action
   * reached it, and there was no retention sweep, so the tables (and the
   * in-memory search index) grew without bound. This route closes that: it
   * authorizes the admin-gated `dataset.delete` (honouring a resource grant),
   * evicts the dataset's chunks from the index, and deletes the row (the document
   * rows cascade via the FK).
   */
  router.delete('/v1/datasets/:datasetId', async (context) => {
    const auth = requireAuth(context);
    const datasetId = requireParam(context, 'datasetId');
    const dataset = await deps.store.datasets.get(datasetId);
    if (!dataset) throw notFound('Dataset', datasetId);
    await deps.authorizeResource(auth, dataset.workspaceId, 'dataset.delete', {
      kind: 'dataset',
      id: datasetId,
    });
    const evicted = await deps.deleteDataset(datasetId);
    return { status: 200, body: { datasetId, documentsEvicted: evicted } };
  });

  /** Bind datasets to an agent, which is what exposes them to its retrieval tool. */
  router.put('/v1/agents/:agentId/datasets', async (context) => {
    const auth = requireAuth(context);
    const agentId = requireParam(context, 'agentId');
    const { datasetIds } = parseOrThrow(bindDatasetsBody, requireBody(context));

    // Delegate to the version-cutting path. It authorizes `agent.version.create`
    // and `dataset.read` on each newly-pinned dataset, and enforces that a
    // dataset belongs to the agent's workspace — the sole tenant boundary on
    // retrieval. This route used to validate ownership and then persist nothing,
    // returning a false 200: a bound dataset never reached the retrieval tool.
    const result = await deps.bindDatasets(auth, agentId, datasetIds);
    return { status: 200, body: result };
  });
}
