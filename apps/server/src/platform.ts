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
  systemClock,
  type Clock,
  type KeyProvider,
  type Logger,
} from '@ma/core';
import type { Session, UniversalEvent } from '@ma/contracts';
import { createSqliteStore, type Store } from '@ma/store';
import {
  AgentService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type SessionProvisioner,
} from '@ma/engine';
import { LocalSandboxDriver, SandboxBroker } from '@ma/sandbox';
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
  SseBridge,
  registerIntegrationRoutes,
  registerRuntimeRoutes,
} from '@ma/gateway';
import { renderConsole } from '@ma/console';

import type { ServerConfig } from './config.ts';

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
  };
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export interface BuildOptions {
  config: ServerConfig;
  clock?: Clock;
  logger?: Logger;
  /** Overrides the config's key provider, for tests. */
  keys?: KeyProvider;
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

  const driver = new LocalSandboxDriver({
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

  const serviceDeps = { store, clock, logger, authorizer, quota };
  const workspaces = new WorkspaceService(serviceDeps);
  const agents = new AgentService(serviceDeps);
  const credentials = new CredentialService({ ...serviceDeps, keys });

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
            Object.assign(env, JSON.parse(value) as Record<string, string>);
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

      return {
        sandboxId: result.sandbox.id,
        reused: result.reused,
        provisionMs: result.provisionMs,
      };
    },

    async release(session: Session, reason: string) {
      if (!session.sandboxId) return;
      await broker.release(session.sandboxId, session.id, reason);
    },

    async submit(session: Session, events: readonly UniversalEvent[]) {
      // The runtime inside the sandbox consumes these over its own transport.
      // Recording them on the log first means a delivery is durable even if the
      // sandbox is mid-restart when it arrives.
      await bus.publish(
        events
          .filter((event) => event.type === 'user.message')
          .map((event) => ({
            sessionId: session.id,
            workspaceId: session.workspaceId,
            type: 'message.completed' as const,
            payload: { role: 'user' as const, text: (event as { text: string }).text },
          })),
      );
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
    logger,
    tickMs: config.scheduler.tickMs,
    batchSize: config.scheduler.batchSize,
    // The scheduler drives the sandbox reaper too, so there is one periodic
    // loop rather than several competing ones.
    onSandboxReap: async () => {
      await broker.reapExpiredLeases();
    },
  });

  // The sandbox's own callback surface. Separate from the public API because it
  // authenticates with a session-scoped token rather than a principal's
  // credential, and conflating the two auth models is how a sandbox ends up
  // able to do something a sandbox should not.
  const runtime = new RuntimeBridge({
    store,
    clock,
    bus,
    sessions: sessionsRef,
    credentials,
    logger,
    renewLease: (sandboxId) => broker.heartbeat(sandboxId),
  });

  const gateway = new Gateway({
    store,
    clock,
    logger,
    quota,
    workspaces,
    agents,
    sessions,
    credentials,
    sse: new SseBridge({ bus, store, clock, logger }),
    version: '0.1.0',
    corsOrigins: config.corsOrigins,
    rateLimit: config.rateLimit,
  });

  // The console is a static document that authenticates itself with a token the
  // operator supplies in the browser, so the page itself needs no credential.
  registerRuntimeRoutes(gateway.router, runtime);

  registerIntegrationRoutes(gateway.router, {
    store,
    clock,
    workspaces,
    activate: (connectorId) => pipeline.activate(connectorId),
    rescheduleNext: (connectorId) => scheduler.scheduleNext(connectorId),
    retryReceipt: (receiptId, reason) => pipeline.retry(receiptId, reason),
  });

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
    services: { workspaces, agents, sessions, credentials, quota },

    async start() {
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
