/**
 * The composition root.
 *
 * Every dependency is constructed here and injected downwards. No module
 * reaches for a global, which is what makes the whole platform startable in a
 * test with an in-memory store and a fake clock.
 *
 * The wiring also resolves one genuine circularity: the session service needs a
 * provisioner, and the provisioner needs to publish session events. It is
 * broken with a small adapter rather than by making either module know about
 * the other.
 */

import {
  createLogger,
  MaError,
  notFound,
  systemClock,
  type Clock,
  type KeyProvider,
  type Logger,
} from '@ma/core';
import type { AgentVersion, Model, Session, UniversalEvent } from '@ma/contracts';
import type { HarnessEvents, ModelClient, ToolRegistry } from '@ma/runtime';
import { createSqliteStore, type Store } from '@ma/store';
import {
  AgentService,
  ArtifactService,
  FilesystemBlobStore,
  MemoryBlobStore,
  MemoryService,
  CapabilityService,
  CredentialService,
  EventBus,
  IngestionPipeline,
  KeywordIndex,
  MemoryArtifactStore,
  QuotaService,
  RegistryResolver,
  RetrievalService,
  RoleAuthorizer,
  SessionService,
  UploadResolver,
  WorkspaceService,
  type SessionProvisioner,
} from '@ma/engine';
import { ContainerSandboxDriver, LocalSandboxDriver, SandboxBroker } from '@ma/sandbox';
import {
  AdapterRegistry,
  DeliveryPipeline,
  Scheduler,
  chatAdapter,
  hookAdapter,
  scheduleAdapter,
  webhookAdapter,
} from '@ma/connectors';
import {
  Gateway,
  RuntimeBridge,
  type ModelProvider,
  SseBridge,
  buildOpenApi,
  registerIntegrationRoutes,
  registerRuntimeRoutes,
} from '@ma/gateway';
import { renderConsole } from '@ma/console';

import type { ServerConfig } from './config.ts';
import { buildToolset } from './toolset.ts';

export interface Platform {
  store: Store;
  bus: EventBus;
  broker: SandboxBroker;
  gateway: Gateway;
  scheduler: Scheduler;
  runtime: RuntimeBridge;
  services: {
    workspaces: WorkspaceService;
    agents: AgentService;
    sessions: SessionService;
    credentials: CredentialService;
    quota: QuotaService;
    capabilities: CapabilityService;
    retrieval: RetrievalService;
    ingestion: IngestionPipeline;
  };
  /** Build the tool registry a session may use, from its pinned version. */
  buildToolset(input: {
    session: Session;
    version: AgentVersion;
    model: ModelClient;
    events: HarnessEvents;
    workDir: string;
  }): ToolRegistry;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export interface BuildOptions {
  config: ServerConfig;
  clock?: Clock;
  logger?: Logger;
  /** Overrides the config's key provider, for tests. */
  keys?: KeyProvider;
  /**
   * Upstream model access.
   *
   * Injected rather than constructed here, because attaching a provider
   * credential is a deployment decision and this package must not depend on any
   * particular vendor SDK. Absent means agents cannot call a model: the bridge
   * answers `MODEL_GATEWAY_UNAVAILABLE`, which is honest and loud rather than a
   * silent failure at the first turn.
   */
  models?: ModelProvider;
  /**
   * Models to register in the catalogue at startup.
   *
   * The gateway refuses any model that is not catalogued — that is the
   * per-workspace allowlist and the cost accounting. Nothing populated it:
   * `models.upsert` had no caller and no admin route, so the catalogue was
   * always empty and every agent's first model call answered 404. A deployment
   * declares its models here, beside the provider that serves them.
   */
  modelCatalogue?: readonly Model[];
}

export function buildPlatform(options: BuildOptions): Platform {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const keys = options.keys ?? config.encryptionKeys;

  const store = createSqliteStore({ location: config.databaseUrl, logger, clock });
  const bus = new EventBus(store, clock, logger);
  const quota = new QuotaService(store, clock);
  const authorizer = new RoleAuthorizer(logger);

  // The driver is the trust boundary: `local` is a child process sharing the
  // host, `container` is a real one. Which to use is a deployment decision, not
  // a code one.
  const driver =
    config.sandbox.driver === 'container'
      ? new ContainerSandboxDriver({
          clock,
          logger,
          ...(config.sandbox.containerBinary ? { binary: config.sandbox.containerBinary } : {}),
        })
      : new LocalSandboxDriver({
          clock,
          logger,
          ...(config.sandbox.agentCommand ? { command: config.sandbox.agentCommand } : {}),
          ...(config.sandbox.agentArgs ? { args: config.sandbox.agentArgs } : {}),
        });

  const broker = new SandboxBroker({
    store,
    clock,
    drivers: [driver],
    logger,
    leaseSeconds: config.sandbox.leaseSeconds,
    controlPlaneUrl: config.controlPlaneUrl,
    prewarmPerPool: config.sandbox.prewarmPerPool,
  });

  // Knowledge and capability artifacts share one content-addressed store, so a
  // skill and a document uploaded with identical bytes are one artifact.
  const artifacts = new MemoryArtifactStore();
  const registry = new RegistryResolver(artifacts);
  const capabilities = new CapabilityService({
    artifacts,
    clock,
    logger,
    resolvers: [registry, new UploadResolver(artifacts)],
  });

  const chunkIndex = new KeywordIndex();
  const ingestion = new IngestionPipeline({ store, clock, index: chunkIndex, logger });
  const retrieval = new RetrievalService({ index: chunkIndex });

  // Assigned once the bridge below is constructed. The provisioner needs it and
  // is declared first, which is the cycle this breaks.
  let runtimeRef: RuntimeBridge | undefined;

  const serviceDeps = { store, clock, logger, authorizer, quota };
  const workspaces = new WorkspaceService(serviceDeps);
  const agents = new AgentService(serviceDeps);
  const credentials = new CredentialService({ ...serviceDeps, keys });

  // `:memory:` mirrors the database setting, so an ephemeral run is ephemeral
  // in both places rather than leaving files behind from a throwaway server.
  const blobs =
    config.artifacts.root === ':memory:'
      ? new MemoryBlobStore()
      : new FilesystemBlobStore({ root: config.artifacts.root, logger });
  const memories = new MemoryService(serviceDeps);
  const sessionArtifacts = new ArtifactService({
    ...serviceDeps,
    blobs,
    maxBytes: config.artifacts.maxMb * 1024 * 1024,
    retentionDays: config.artifacts.retentionDays,
  });

  /**
   * Runtime tokens minted during provisioning, so release can revoke them.
   *
   * Keyed by sandbox id. The store holds the authoritative binding; this only
   * lets `release` tell the bridge to drop its cache entry, which it cannot do
   * from a hash alone.
   */
  const runtimeTokens = new Map<string, string>();

  /**
   * Bridges the engine to the sandbox layer.
   *
   * Declared before the session service so it can be injected, and it reaches
   * back through a late-bound reference — which is the smallest way to break
   * the cycle without either side importing the other.
   */
  const provisioner: SessionProvisioner = {
    async provision(session: Session) {
      const version = await store.agentVersions.get(session.agentId, session.resolvedVersion);
      if (!version) throw new Error(`Missing version ${session.resolvedVersion}`);

      // Credential *values* are resolved here and handed to the driver as
      // environment; the driver never sees a credential id.
      const env: Record<string, string> = {};
      for (const credentialId of session.credentialIds) {
        try {
          const value = await credentials.exchange(session, credentialId, 'sandbox startup');
          const credential = await store.credentials.get(credentialId);
          if (credential?.type === 'env_vars') {
            // Parsed in its own try: V8's SyntaxError embeds the first several
            // characters of the input, so letting a malformed credential's
            // parse error escape would put its plaintext prefix into the
            // session's error field and its event log.
            let parsed: Record<string, string>;
            try {
              parsed = JSON.parse(value) as Record<string, string>;
            } catch {
              throw new Error(
                `Credential '${credential.name}' is typed env_vars but its value is not valid JSON`,
              );
            }
            Object.assign(env, parsed);
          } else if (credential) {
            env[`MA_CRED_${credential.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = value;
          }
        } catch (error) {
          // A single unusable credential should not silently become a
          // mysterious failure inside the agent.
          logger.error('failed to resolve a credential for a sandbox', {
            sessionId: session.id,
            credentialId,
            error,
          });
          throw error;
        }
      }

      const result = await broker.acquire({
        session,
        spec: version.sandbox,
        env,
        credentialIds: session.credentialIds,
      });

      // A cold sandbox mints a token; a reused one already has a live binding
      // from its first start. Caching it here means this process answers its
      // sandbox's calls without a database round trip, while the persisted hash
      // covers every other process and any restart.
      if (result.runtimeToken.length > 0) {
        runtimeTokens.set(result.sandbox.id, result.runtimeToken);
        runtimeRef?.bind(result.runtimeToken, session.id, result.sandbox.id);
      }

      return {
        sandboxId: result.sandbox.id,
        reused: result.reused,
        provisionMs: result.provisionMs,
      };
    },

    async release(session: Session, reason: string) {
      if (!session.sandboxId) return;
      const token = runtimeTokens.get(session.sandboxId);
      if (token !== undefined) {
        runtimeTokens.delete(session.sandboxId);
        runtimeRef?.unbind(token);
      }
      await broker.release(session.sandboxId, session.id, reason);
    },

    async submit(session: Session, events: readonly UniversalEvent[]) {
      const prompts = events.filter((event) => event.type === 'user.message');

      // On the log first, so a delivery is durable even if the sandbox is
      // mid-restart when it arrives.
      await bus.publish(
        prompts.map((event) => ({
          sessionId: session.id,
          workspaceId: session.workspaceId,
          type: 'message.completed' as const,
          payload: { role: 'user' as const, text: (event as { text: string }).text },
        })),
      );

      // Then to the sandbox. This used to end at the line above, with a comment
      // saying "the runtime consumes these over its own transport" — there was
      // no such transport, so a prompt reached the event log and nothing else.
      // The session looked healthy and the agent never heard from anyone.
      if (!session.sandboxId || prompts.length === 0) return;
      const sandbox = await store.sandboxes.get(session.sandboxId);
      if (!sandbox?.endpoint) return;

      const response = await fetch(`${sandbox.endpoint}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: prompts.map((event) => ({ text: (event as { text: string }).text })),
        }),
      });

      if (!response.ok) {
        const body = await response
          .text()
          .then((text) => text.slice(0, 200))
          .catch(() => '');

        // A 409 means the session is mid-turn, not that anything is wrong: the
        // sandbox refuses an overlapping submit and will accept the next one
        // once the turn ends, seconds away. It must be *retryable* — a bare
        // Error becomes category `internal`, which the delivery pipeline treats
        // as terminal and fails the receipt permanently, dropping a follow-up
        // message that a reuse_per_scope connector will never redeliver. Mark it
        // `unavailable` so the pipeline backs off and retries instead.
        if (response.status === 409) {
          throw new MaError({
            code: 'SESSION_BUSY',
            category: 'unavailable',
            message: `The session is running a turn and cannot accept another yet: ${body}`,
            retryable: true,
          });
        }

        throw new Error(`The sandbox refused the prompt: ${response.status} ${body}`);
      }
    },
  };

  const sessions = new SessionService({ ...serviceDeps, bus, provisioner });
  // Named separately so the runtime bridge below can take it without either
  // one importing the other.
  const sessionsRef = sessions;

  const adapters = new AdapterRegistry()
    .register(webhookAdapter({ clock }))
    .register(chatAdapter({ clock }))
    .register(hookAdapter({ clock }))
    .register(scheduleAdapter());

  const pipeline = new DeliveryPipeline({
    store,
    clock,
    adapters,
    sessions,
    credentials,
    logger,
  });

  const scheduler = new Scheduler({
    store,
    clock,
    pipeline,
    sessions,
    credentials,
    logger,
    tickMs: config.scheduler.tickMs,
    batchSize: config.scheduler.batchSize,
    // The scheduler drives the sandbox reaper too, so there is one periodic
    // loop rather than several competing ones.
    onSandboxReap: async () => {
      const { reaped } = await broker.reapExpiredLeases();
      // Artifact retention rides the same loop as every other sweep, rather
      // than competing with it on its own timer.
      if (config.artifacts.retentionDays > 0) await sessionArtifacts.purgeExpired();
      // Documents are ingested on the same loop rather than a competing timer:
      // one periodic worker is far easier to reason about under load.
      for (let processed = 0; processed < 5; processed++) {
        if (!(await ingestion.processNext())) break;
      }
    },
  });

  // The sandbox's own callback surface. Separate from the public API because it
  // authenticates with a session-scoped token rather than a principal's
  // credential, and conflating the two auth models is how a sandbox ends up
  // able to do something a sandbox should not.
  const runtime: RuntimeBridge = new RuntimeBridge({
    store,
    clock,
    bus,
    sessions: sessionsRef,
    credentials,
    artifacts: sessionArtifacts,
    memories,
    ...(options.models ? { models: options.models } : {}),
    logger,
    renewLease: (sandboxId) => broker.heartbeat(sandboxId),
  });
  // Closes the cycle: the provisioner above is built before the bridge exists,
  // so it reaches it through this reference rather than a direct binding.
  runtimeRef = runtime;

  const gateway = new Gateway({
    store,
    clock,
    logger,
    quota,
    authorizer,
    workspaces,
    agents,
    sessions,
    credentials,
    artifacts: sessionArtifacts,
    memories,
    sse: new SseBridge({ bus, store, clock, logger }),
    version: '0.1.0',
    corsOrigins: config.corsOrigins,
    rateLimit: config.rateLimit,
    trustForwardedFor: config.trustForwardedFor,
  });

  // The console is a static document that authenticates itself with a token the
  // operator supplies in the browser, so the page itself needs no credential.
  registerRuntimeRoutes(gateway.router, runtime);

  registerIntegrationRoutes(gateway.router, {
    store,
    clock,
    workspaces,
    // Each route names the action it performs; membership alone never
    // authorizes a write.
    authorize: async (auth, workspaceId, action) => {
      const workspace = await store.workspaces.get(workspaceId);
      if (!workspace) throw notFound('Workspace', workspaceId);
      authorizer.require(auth, workspace, action, { resourceId: workspaceId });
    },
    stageDocument: (documentId, content) => ingestion.stage(documentId, content),
    activate: (connectorId) => pipeline.activate(connectorId),
    rescheduleNext: (connectorId) => scheduler.scheduleNext(connectorId),
    retryReceipt: (receiptId, reason) => pipeline.retry(receiptId, reason),
  });

  // Schemas come from the same declarations the gateway validates against; the
  // path list is hand-written and kept honest by a test that walks the router.
  const openApi = buildOpenApi({
    version: '0.1.0',
    servers: [{ url: config.controlPlaneUrl }],
  });
  gateway.router.get('/openapi.json', () =>
    Promise.resolve({ status: 200, body: openApi }),
  );

  const consoleHtml = renderConsole({ version: '0.1.0' });

  gateway.router.get('/', (context) => {
    context.raw.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The console loads only its own inline assets, so a strict policy costs
      // nothing and removes an entire class of injection.
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      'x-content-type-options': 'nosniff',
    });
    context.raw.res.end(consoleHtml);
    return Promise.resolve(undefined);
  });

  // Inbound connector deliveries are public by URL and authenticated by
  // signature, so they are registered outside the bearer-token middleware.
  gateway.router.post('/ingress/v1/:workspaceId/:externalKey', async (context) => {    const result = await pipeline.accept(
      context.params.workspaceId!,
      context.params.externalKey!,
      {
        headers: context.headers,
        rawBody: context.rawBody,
        body: context.body,
        query: context.query,
        sourceIp: context.raw.req.socket.remoteAddress ?? '',
        receivedAt: clock.now(),
      },
    );

    if (result.immediateResponse) {
      return { status: result.immediateResponse.status, body: result.immediateResponse.body };
    }
    if (result.status === 'rejected') {
      return { status: 401, body: { error: { code: 'DELIVERY_REJECTED', message: result.reason } } };
    }
    // A duplicate is reported as accepted with the original receipt: from the
    // sender's point of view its event was received, which is true.
    return {
      status: result.status === 'duplicate' ? 200 : 202,
      body: { status: result.status, receiptId: result.receipt?.id },
    };
  });

  return {
    store,
    bus,
    broker,
    gateway,
    scheduler,
    runtime,
    services: { workspaces, agents, sessions, credentials, quota, capabilities, retrieval, ingestion },

    // The seam where platform capabilities become one agent's capabilities.
    // Exposed so a host embedding the platform can assemble a session's tools
    // the same way the runtime does.
    buildToolset: (input) => buildToolset({ ...input, retrieval, clock, logger }),

    async start() {
      // Before anything can run a turn: an uncatalogued model is refused.
      for (const model of options.modelCatalogue ?? []) {
        await store.models.upsert(model);
      }

      // Before accepting work: a control plane that crashed mid-provision left
      // labelled containers with no row pointing at them, and nothing else will
      // ever find them. `docs/operations.md` says to run this at startup; until
      // now nothing did, so that leak was real and permanent.
      if (driver instanceof ContainerSandboxDriver) {
        try {
          const live = await store.sandboxes.list({ statuses: ['pending', 'ready', 'draining'] });
          const reaped = await driver.reapOrphans(live.items.map((sandbox) => sandbox.providerRef));
          if (reaped.length > 0) logger.info('reaped orphaned containers', { count: reaped.length });
        } catch (error) {
          // A container runtime that is not answering yet must not stop the
          // control plane from starting; the next restart tries again.
          logger.warn('could not reap orphaned containers at startup', { error });
        }
      }

      const address = await gateway.listen(config.port, config.host);
      if (config.scheduler.enabled) scheduler.start();
      logger.info('platform started', {
        ...address,
        scheduler: config.scheduler.enabled,
        database: config.databaseUrl,
      });
      return address;
    },

    async stop() {
      // Order matters: stop accepting work, let the schedulers settle, then
      // release sandboxes and close the store.
      await gateway.close();
      await scheduler.stop();
      bus.closeAll();
      await broker.close();
      await store.close();
      logger.info('platform stopped');
    },
  };
}
