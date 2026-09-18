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
  isPlainObject,
  mergeEnvVars,
  MetricsRegistry,
  notFound,
  safeEqual,
  sha256Hex,
  systemClock,
  type Clock,
  type KeyProvider,
  type Logger,
} from '@ma/core';
import type { AgentVersion, Model, Session, UniversalEvent } from '@ma/contracts';
import { join } from 'node:path';
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
  FilesystemArtifactStore,
  GitResolver,
  IngestionPipeline,
  KeywordIndex,
  MemoryArtifactStore,
  OidcService,
  ScimService,
  QuotaService,
  RegistryResolver,
  RetrievalService,
  RoleAuthorizer,
  SessionService,
  ShellGitFetcher,
  TemplateService,
  PreviewService,
  UploadResolver,
  WorkspaceService,
  type RebindOutcome,
  type SessionProvisioner,
} from '@ma/engine';
import {
  ContainerSandboxDriver,
  K8sSandboxDriver,
  KubeHttpClient,
  LocalSandboxDriver,
  SandboxBroker,
  VolumeManager,
  computePoolKey,
} from '@ma/sandbox';
import {
  AdapterRegistry,
  DeliveryPipeline,
  Scheduler,
  chatAdapter,
  eventBusAdapter,
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
  registerAuthRoutes,
  registerIntegrationRoutes,
  registerRuntimeRoutes,
  registerScimRoutes,
} from '@ma/gateway';
import { renderConsole } from '@ma/console';

import type { ServerConfig } from './config.ts';
import { buildToolset } from './toolset.ts';
import { BUILTIN_TEMPLATES } from './builtin-templates.ts';

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

  // One in-process metrics registry, injected downwards like every other
  // dependency. The gateway records per-request RED metrics into it, and the
  // /metrics route below adds scrape-time gauges from the store.
  const metrics = new MetricsRegistry();

  // The driver is the trust boundary: `local` is a child process sharing the
  // host, `container` is a real one. Which to use is a deployment decision, not
  // a code one.
  //
  // Platform-managed volume storage is shared across all drivers: it maps a
  // (workspace, name) to a confined directory under one root. Absent (or
  // `:memory:`) means volumes are disabled and any spec declaring mounts is
  // refused — fail-closed, like a missing egress proxy.
  const volumes = new VolumeManager(
    config.sandbox.volumeRoot ? { root: config.sandbox.volumeRoot } : {},
  );

  const driver = ((): ContainerSandboxDriver | LocalSandboxDriver | K8sSandboxDriver => {
    if (config.sandbox.driver === 'container') {
      return new ContainerSandboxDriver({
        clock,
        logger,
        volumes,
        ...(config.sandbox.containerBinary ? { binary: config.sandbox.containerBinary } : {}),
        ...(config.sandbox.egressProxy ? { egressProxy: config.sandbox.egressProxy } : {}),
        ...(config.sandbox.internalNetwork
          ? { internalNetwork: config.sandbox.internalNetwork }
          : {}),
      });
    }
    if (config.sandbox.driver === 'k8s') {
      const namespace = config.sandbox.k8sNamespace ?? 'managed-agent';
      return new K8sSandboxDriver({
        clock,
        logger,
        volumes,
        kube: new KubeHttpClient({ namespace }),
        namespace,
        ...(config.sandbox.egressProxy ? { egressProxy: config.sandbox.egressProxy } : {}),
        ...(config.sandbox.egressProxyCidr
          ? { egressProxyCidr: config.sandbox.egressProxyCidr }
          : {}),
        ...(config.sandbox.dnsCidr ? { dnsCidr: config.sandbox.dnsCidr } : {}),
        ...(config.sandbox.controlPlaneCidr
          ? { controlPlaneCidr: config.sandbox.controlPlaneCidr }
          : {}),
      });
    }
    return new LocalSandboxDriver({
      clock,
      logger,
      volumes,
      ...(config.sandbox.agentCommand ? { command: config.sandbox.agentCommand } : {}),
      ...(config.sandbox.agentArgs ? { args: config.sandbox.agentArgs } : {}),
    });
  })();

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
  // Persistent on disk unless the deployment is ephemeral (`:memory:`), so a
  // restart does not lose every uploaded/git-fetched capability — which would
  // break the download endpoint and thus every installed skill.
  const artifacts =
    config.artifacts.root === ':memory:'
      ? new MemoryArtifactStore()
      : new FilesystemArtifactStore(join(config.artifacts.root, 'capabilities'));
  const registry = new RegistryResolver(artifacts);
  const capabilities = new CapabilityService({
    artifacts,
    clock,
    logger,
    // git resolves a repo+ref to a pinned commit and archives its tree; upload
    // and registry serve bytes already in the artifact store.
    resolvers: [
      registry,
      new UploadResolver(artifacts),
      new GitResolver(new ShellGitFetcher(), artifacts),
    ],
  });

  const chunkIndex = new KeywordIndex();

  // Assigned once the bridge below is constructed. The provisioner needs it and
  // is declared first, which is the cycle this breaks.
  let runtimeRef: RuntimeBridge | undefined;

  const serviceDeps = { store, clock, logger, authorizer, quota };
  const workspaces = new WorkspaceService(serviceDeps);
  const agents = new AgentService({ ...serviceDeps, capabilities });
  const credentials = new CredentialService({ ...serviceDeps, keys });

  // `:memory:` mirrors the database setting, so an ephemeral run is ephemeral
  // in both places rather than leaving files behind from a throwaway server.
  const blobs =
    config.artifacts.root === ':memory:'
      ? new MemoryBlobStore()
      : new FilesystemBlobStore({ root: config.artifacts.root, logger });
  // Context snapshots share the blob-store machinery but live under their own
  // root, so a snapshot and an artifact with identical bytes never collide and
  // an artifact-retention sweep never reclaims a snapshot. `:memory:` follows the
  // same ephemeral rule as artifacts and the database.
  const snapshots =
    config.artifacts.root === ':memory:'
      ? new MemoryBlobStore()
      : new FilesystemBlobStore({ root: `${config.artifacts.root}/snapshots`, logger });
  // Knowledge-base document content lives under its own root too, so a document
  // and an artifact with identical bytes never collide and an artifact-retention
  // sweep never reclaims a document blob. This is what makes ingested documents
  // survive a restart: the bytes are durable, and the index is rebuilt from them
  // at startup rather than living only in the process that ingested them.
  const documentBlobs =
    config.artifacts.root === ':memory:'
      ? new MemoryBlobStore()
      : new FilesystemBlobStore({ root: `${config.artifacts.root}/documents`, logger });
  const ingestion = new IngestionPipeline({
    store,
    clock,
    index: chunkIndex,
    blobs: documentBlobs,
    logger,
  });
  const retrieval = new RetrievalService({ index: chunkIndex });
  const memories = new MemoryService(serviceDeps);
  const templates = new TemplateService(serviceDeps);
  const previews = new PreviewService({
    clock,
    keys: config.encryptionKeys,
    ...(config.artifacts.previewOrigin ? { previewOrigin: config.artifacts.previewOrigin } : {}),
    ...(config.artifacts.consoleOrigin ? { consoleOrigin: config.artifacts.consoleOrigin } : {}),
  });
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
   * A digest of a session's credentials' *rotation state*, folded into the pool
   * key so a rotated secret cannot reuse a warm sandbox that baked in the old
   * value (see `computePoolKey`). Per credential we hash `id:keyVersion:updatedAt`.
   * `updatedAt` is the signal: `credentials.update` always bumps it (rotation is a
   * subset of update), so a real rotation ALWAYS changes the fingerprint — the
   * security-critical direction. `markUsed` touches only `last_used_at`, so an
   * ordinary exchange never fragments the pool.
   *
   * `updatedAt` is not a *pure* rotation signal, though: a metadata-only edit, or
   * the automatic `expiring`/`expired` status flip from `sweepExpiry`, also bumps
   * it. Each such bump costs a one-time cold start as the pool re-coheres around
   * the new fingerprint — the fingerprint only ever over-fragments, never reuses
   * a stale secret, so this is safe waste, not a correctness or leak risk. (A
   * dedicated value-rotation counter would avoid the churn without exposing the
   * sealed value; not worth it until the churn is shown to matter.)
   *
   * Load-bearing: every `computePoolKey` call for a session must feed the SAME
   * fingerprint (acquire, rebind, prewarm), or a rotation would be seen by one
   * path and not another and reuse would silently misbehave.
   */
  const credentialFingerprint = async (
    credentialIds: readonly string[],
  ): Promise<string | undefined> => {
    if (credentialIds.length === 0) return undefined;
    const parts: string[] = [];
    for (const credentialId of credentialIds) {
      const credential = await store.credentials.get(credentialId);
      // A missing credential contributes its id alone: it still changes the
      // fingerprint if it later reappears, and its absence is not a value to hash.
      parts.push(
        credential
          ? `${credential.id}:${credential.keyVersion}:${credential.updatedAt}`
          : `${credentialId}:missing`,
      );
    }
    parts.sort();
    return sha256Hex(parts.join('\n'));
  };

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
      //
      // Two maps, split by trust. `env` carries `env_vars`-credential contents,
      // whose keys a workspace member chooses — untrusted, so the driver runs it
      // through `sanitizeEnv` (which strips all `MA_*`). `credentialEnv` carries
      // the platform-generated `MA_CRED_<NAME>` secrets: the keys are ours, so it
      // is delivered without sanitizing. Keeping the `MA_CRED_*` secrets out of
      // `env` is what stops `sanitizeEnv` from dropping them — the bug where an
      // api_key/bearer_token credential silently never reached the agent.
      const env: Record<string, string> = {};
      const credentialEnv: Record<string, string> = {};
      for (const credentialId of session.credentialIds) {
        try {
          const value = await credentials.exchange(session, credentialId, 'sandbox startup');
          const credential = await store.credentials.get(credentialId);
          if (credential?.type === 'env_vars') {
            // Parsed in its own try: V8's SyntaxError embeds the first several
            // characters of the input, so letting a malformed credential's
            // parse error escape would put its plaintext prefix into the
            // session's error field and its event log.
            let parsed: unknown;
            try {
              parsed = JSON.parse(value);
            } catch {
              throw new Error(
                `Credential '${credential.name}' is typed env_vars but its value is not valid JSON`,
              );
            }
            // Valid JSON but not a {key: value} map (`null`, a scalar, an array)
            // would make `Object.entries` throw a raw TypeError (crashing provision
            // with a message that leaks nothing but is confusing) or spread a
            // string's characters as env vars. Reject it with the same clean,
            // value-free error as a syntax failure.
            if (!isPlainObject(parsed)) {
              throw new Error(
                `Credential '${credential.name}' is typed env_vars but its value is not a JSON object`,
              );
            }
            mergeEnvVars(env, parsed as Record<string, string>);
          } else if (credential?.type === 'file' || credential?.type === 'ssh_key') {
            // A file credential is materialised by the sandbox as a file (it
            // fetches the value itself through the audited exchange and writes it
            // to disk), so it is deliberately NOT placed in the driver env — a
            // secret in spawn env is visible to `docker inspect` and would only
            // reach the process environment, not a file the agent can read.
            continue;
          } else if (credential) {
            credentialEnv[`MA_CRED_${credential.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] =
              value;
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

      const fingerprint = await credentialFingerprint(session.credentialIds);
      const result = await broker.acquire({
        session,
        spec: version.sandbox,
        env,
        ...(Object.keys(credentialEnv).length > 0 ? { credentialEnv } : {}),
        credentialIds: session.credentialIds,
        credentialFingerprint: fingerprint,
      });

      // A cold sandbox mints a token; a reused one already has a live binding
      // from its first start. Caching it here means this process answers its
      // sandbox's calls without a database round trip, while the persisted hash
      // covers every other process and any restart.
      if (result.runtimeToken.length > 0) {
        runtimeTokens.set(result.sandbox.id, result.runtimeToken);
        runtimeRef?.bind(result.runtimeToken, session.id, result.sandbox.id);
      }

      // A reused sandbox is a warm agent-core process still holding the previous
      // session's context. Tell it to rebind: drop that context, re-bootstrap
      // as this session, and rebuild its workdir/tools/MCP. Until this returns
      // the process is serving stale identity, so a submit must not race it —
      // `start` awaits provision before moving the session to `ready`.
      if (result.reused) {
        const rebound = await rebindSandbox(
          result.sandbox.endpoint,
          session.id,
          result.sandbox.runtimeTokenHash,
        );
        if (rebound !== 'ok') {
          // Rebind failed: the warm process cannot be trusted to serve this
          // session. Tear it down and fall back to a fresh cold sandbox, so
          // reuse degrades to correctness rather than wedging the session. A
          // freshly-claimed warm sandbox holds no live session, so a `busy` here
          // is not the mid-turn upgrade case — any non-`ok` outcome is a cold
          // fallback.
          logger.warn('rebind failed; falling back to a cold sandbox', {
            sessionId: session.id,
            sandboxId: result.sandbox.id,
            outcome: rebound,
          });
          await broker.discard(result.sandbox.id, session.id, 'rebind failed');
          const cold = await broker.acquire({
            session,
            spec: { ...version.sandbox, allowReuse: false },
            env,
            ...(Object.keys(credentialEnv).length > 0 ? { credentialEnv } : {}),
            credentialIds: session.credentialIds,
            credentialFingerprint: fingerprint,
          });
          if (cold.runtimeToken.length > 0) {
            runtimeTokens.set(cold.sandbox.id, cold.runtimeToken);
            runtimeRef?.bind(cold.runtimeToken, session.id, cold.sandbox.id);
          }
          return {
            sandboxId: cold.sandbox.id,
            reused: false,
            provisionMs: cold.provisionMs,
          };
        }
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
      // Always drop the bridge's cached binding for this sandbox, even when this
      // process holds no plaintext token for it — a reusing session never does,
      // and a stale cache entry is what would misroute the next session's calls.
      runtimeRef?.forgetSandbox(session.sandboxId);
      await broker.release(session.sandboxId, session.id, reason);

      // Reactive prewarm: a pool that was just used is a pool likely to be used
      // again, so top it back up to the configured depth. Only when prewarm is
      // enabled and the version opts into reuse — otherwise there is no warm pool
      // to keep full. Best-effort: a warming failure must not fail the release.
      // Prewarmed sandboxes boot idle with no session credentials (each is
      // materialised on the first real bind), so an empty env is correct here.
      if (config.sandbox.prewarmPerPool > 0) {
        try {
          const version = await store.agentVersions.get(session.agentId, session.resolvedVersion);
          if (version?.sandbox.allowReuse) {
            await broker.prewarm(
              session.workspaceId,
              version.sandbox,
              session.credentialIds,
              {},
              await credentialFingerprint(session.credentialIds),
            );
          }
        } catch (error) {
          logger.warn('reactive prewarm failed', { sessionId: session.id, error });
        }
      }
    },

    async rebind(session: Session): Promise<RebindOutcome> {
      if (!session.sandboxId) return 'changed';
      const sandbox = await store.sandboxes.get(session.sandboxId);
      if (!sandbox || sandbox.status !== 'ready') return 'changed';

      // The environment can only be reused for the new version if its pool key
      // still matches — the pool key hashes the sandbox spec and credential set,
      // so a version that changed resources, network, setup or credentials gets
      // a different key and must not rebind into the old environment.
      const version = await store.agentVersions.get(session.agentId, session.resolvedVersion);
      if (!version) return 'changed';
      const newPoolKey = computePoolKey({
        workspaceId: session.workspaceId,
        spec: version.sandbox,
        credentialIds: session.credentialIds,
        credentialFingerprint: await credentialFingerprint(session.credentialIds),
      });
      if (newPoolKey !== sandbox.poolKey) return 'changed';

      // Same environment shape: ask the running agent-core to re-bootstrap into
      // the new version. It re-reads `resolvedVersion` from the row (already
      // re-pinned by the caller), so the rebind picks up the new config. The
      // outcome (`ok`/`busy`/`changed`) is passed straight through so the caller
      // can back off on `busy` rather than releasing a mid-turn sandbox.
      return rebindSandbox(sandbox.endpoint, session.id, sandbox.runtimeTokenHash);
    },

    async submit(session: Session, events: readonly UniversalEvent[]) {
      const prompts = events.filter((event) => event.type === 'user.message');

      const publishToLog = async (): Promise<void> => {
        await bus.publish(
          prompts.map((event) => ({
            sessionId: session.id,
            workspaceId: session.workspaceId,
            type: 'message.completed' as const,
            payload: { role: 'user' as const, text: (event as { text: string }).text },
          })),
        );
      };

      // No sandbox to deliver to yet (a queued session) — the log is the only
      // durable record, so write it and return. There is no retry that could
      // duplicate it on this path.
      if (!session.sandboxId || prompts.length === 0) {
        await publishToLog();
        return;
      }
      const sandbox = await store.sandboxes.get(session.sandboxId);
      if (!sandbox?.endpoint) {
        await publishToLog();
        return;
      }

      // Deliver to the sandbox *before* writing the durable log entry. The log
      // write used to come first ("durable even if the sandbox is mid-restart"),
      // but once an overlapping submit became a retryable 409 that ordering
      // duplicated the message: the pipeline re-runs the whole submit on retry,
      // and a publish-first submit appended the user's message to the log on
      // every attempt. Nothing redelivers user messages from the log, so the log
      // entry and the POST are independent side effects — writing the log only
      // after the sandbox accepts makes the whole submit safe to retry, and
      // keeps history honest: a message that was never accepted never appears.
      const response = await fetch(`${sandbox.endpoint}/submit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Authenticate to the sandbox. agent-core binds all interfaces on the
          // container/k8s drivers, so its endpoints are reachable by co-located
          // sandboxes and cluster pods; the runtime-token hash is the shared
          // secret that proves this call is the control plane. The hash (not the
          // raw token) is persisted on the record and readable by any control-
          // plane process, so this works after a restart and from a replica that
          // did not provision the sandbox.
          authorization: `Bearer ${sandbox.runtimeTokenHash}`,
        },
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
        // once the turn ends, seconds away. Make it *retryable* so the delivery
        // pipeline backs off and retries rather than failing the receipt
        // permanently — but category `conflict` (409), not `unavailable` (503),
        // because a busy session is a per-resource state conflict, not a
        // platform outage a client should circuit-break on. The pipeline keys
        // off the `retryable` flag, not the category, so the explicit override
        // preserves the retry while giving a direct API caller a correct 409.
        if (response.status === 409) {
          throw new MaError({
            code: 'SESSION_BUSY',
            category: 'conflict',
            message: `The session is running a turn and cannot accept another yet: ${body}`,
            retryable: true,
          });
        }

        throw new Error(`The sandbox refused the prompt: ${response.status} ${body}`);
      }

      // The sandbox accepted it; now it is a real, delivered message worth
      // recording. On the retry path this line is reached exactly once — the
      // attempt that finally succeeded.
      await publishToLog();
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
    .register(eventBusAdapter({ clock }))
    .register(scheduleAdapter());

  const pipeline = new DeliveryPipeline({
    store,
    clock,
    adapters,
    sessions,
    credentials,
    bus,
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
    auditRetentionDays: config.scheduler.auditRetentionDays,
    // The scheduler drives the sandbox reaper too, so there is one periodic
    // loop rather than several competing ones.
    onSandboxReap: async () => {
      const { reaped } = await broker.reapExpiredLeases();
      // Warm, holderless sandboxes never lapse their lease (their process keeps
      // heartbeating), so they need their own idle sweep rather than the
      // lease reaper. Runs on the same loop; the ids it destroys held no live
      // session, so they need no recovery.
      const idleReaped = await broker.reapIdleSandboxes();
      // Both reaper paths destroy a sandbox, so — exactly like `release` — forget
      // the RuntimeBridge state keyed to it: the cached token binding and its
      // billed-turn markers. Without this the caches grow unbounded (one leaked
      // entry per reaped sandbox over a node's lifetime), and a stray call from a
      // still-terminating agent-core on the old token could resolve to and append
      // to a since-re-queued session — the reuse misroute `forgetSandbox` exists
      // to prevent. Cover ids from both sweeps.
      for (const sandboxId of [...reaped, ...idleReaped]) {
        const token = runtimeTokens.get(sandboxId);
        if (token !== undefined) runtimeTokens.delete(sandboxId);
        runtimeRef?.forgetSandbox(sandboxId);
      }
      // Artifact retention rides the same loop as every other sweep, rather
      // than competing with it on its own timer.
      if (config.artifacts.retentionDays > 0) await sessionArtifacts.purgeExpired();
      // Documents are ingested on the same loop rather than a competing timer:
      // one periodic worker is far easier to reason about under load. First
      // requeue any document a killed worker left stuck `processing`, so an
      // interrupted ingest resumes rather than sitting stuck forever; then
      // requeue any that ended `failed` with a retryable error (a transient
      // embedder/blob hiccup), bounded by an attempt counter so a permanently
      // broken document is not retried forever.
      await ingestion.recoverStuckProcessing();
      await ingestion.reprocessFailed();
      for (let processed = 0; processed < 5; processed++) {
        if (!(await ingestion.processNext())) break;
      }
      // Hand the reaped sandbox ids back to the scheduler so it can recover the
      // sessions that held them. Returning them is the whole point of the
      // callback's contract — dropping them left every lost sandbox stranding
      // its session `ready` against an environment that no longer exists.
      return reaped;
    },
    // Translate each tick's deltas into counters. The scheduler stays free of any
    // metrics dependency; this closure over the registry does the mapping.
    onTick: (report) => {
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'sessions_started' }, report.sessionsStarted);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'sessions_upgraded' }, report.sessionsUpgraded);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'schedules_fired' }, report.schedulesFired);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'zombies_reaped' }, report.zombiesReaped);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'sessions_expired' }, report.sessionsExpired);
      // Retention/GC sweeps: surfaced so an operator can see the platform is
      // actually reclaiming storage, not silently letting a table grow.
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'events_pruned' }, report.eventsPruned);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'audit_pruned' }, report.auditPruned);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'idempotency_pruned' }, report.idempotencyPruned);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'billed_turns_pruned' }, report.billedTurnsPruned);
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'credentials_expired' }, report.credentialsExpired);
    },
    // Delivery draining runs on its own loop (not the maintenance tick), so its
    // count is reported separately — same counter and label, so the metric is
    // unchanged for operators.
    onDelivery: (processed) => {
      metrics.incrementCounter('ma_scheduler_ticks_total', { kind: 'deliveries_processed' }, processed);
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
    snapshots,
    memories,
    retrieval,
    capabilityBytes: artifacts,
    ...(options.models ? { models: options.models } : {}),
    logger,
    renewLease: (sandboxId) => broker.heartbeat(sandboxId),
    metrics,
    modelRetry: {
      maxAttempts: config.modelRetry.attempts,
      initialDelayMs: config.modelRetry.baseDelayMs,
      maxDelayMs: config.modelRetry.maxDelayMs,
    },
    modelBreaker: {
      enabled: config.modelBreaker.enabled,
      failureThreshold: config.modelBreaker.threshold,
      windowMs: config.modelBreaker.windowMs,
      resetMs: config.modelBreaker.resetMs,
    },
    // Enforce the daily-token budget on every completion, not just at admission.
    quota,
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
    templates,
    previews,
    sse: new SseBridge({ bus, store, clock, logger }),
    version: '0.1.0',
    corsOrigins: config.corsOrigins,
    rateLimit: config.rateLimit,
    trustForwardedFor: config.trustForwardedFor,
    metrics,
  });

  // The console is a static document that authenticates itself with a token the
  // operator supplies in the browser, so the page itself needs no credential.
  registerRuntimeRoutes(gateway.router, runtime);

  // Identity federation (SSO). Off unless a deployment configured an IdP: with
  // no providers the service reports none and the public /auth routes are inert.
  // The login flow ends by minting an ordinary session token, so the bearer
  // middleware and authorizer apply to a federated caller unchanged.
  const oidc = new OidcService({
    clock,
    keys: config.encryptionKeys,
    store,
    logger,
    providers: config.sso?.providers ?? [],
    clientSecrets: config.sso?.clientSecrets ?? {},
  });
  registerAuthRoutes(gateway.router, {
    oidc,
    ...(config.sso?.consoleLoginRedirect
      ? { consoleLoginRedirect: config.sso.consoleLoginRedirect }
      : {}),
  });

  // SCIM 2.0 provisioning. Off unless a token is configured. It provisions into
  // the same subject space as the named OIDC provider, so provision-ahead and a
  // later login converge on one principal; deactivation revokes the principal's
  // tokens, closing the offboarding gap login alone cannot.
  const scim = new ScimService({
    clock,
    store,
    logger,
    ...(config.scim ? { token: config.scim.token, providerId: config.scim.providerId } : {}),
  });
  registerScimRoutes(gateway.router, { scim });

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
    authorizeResource: async (auth, workspaceId, action, resource) => {
      // Resource-scoped authorization that honours a fine-grained grant: resolve
      // the principal's grant on (kind, id) and let it raise the effective role,
      // exactly as BaseService.requireOnResource does for agents. Connectors and
      // datasets are grantable kinds, so without this a grant on one is stored
      // and never consulted. The grant lookup is skipped when the workspace role
      // already suffices (it could only be a no-op).
      const workspace = await store.workspaces.get(workspaceId);
      if (!workspace) throw notFound('Workspace', workspaceId);
      const grant = authorizer.can(auth, workspace, action, { resourceId: resource.id })
        ? undefined
        : await store.resourceGrants.find({
            workspaceId,
            principalId: auth.principal.id,
            resourceKind: resource.kind,
            resourceId: resource.id,
          });
      authorizer.require(auth, workspace, action, {
        resourceId: resource.id,
        ...(grant ? { resourceGrantRole: grant.role } : {}),
      });
    },
    stageDocument: (documentId, content) => ingestion.stage(documentId, content),
    activate: (connectorId) => pipeline.activate(connectorId),
    rescheduleNext: (connectorId) => scheduler.scheduleNext(connectorId),
    retryReceipt: (receiptId, reason) => pipeline.retry(receiptId, reason),
    deleteDataset: (datasetId) => ingestion.deleteDataset(datasetId),
    deleteDocument: (datasetId, documentId) => ingestion.deleteDocument(datasetId, documentId),
    bindDatasets: async (auth, agentId, datasetIds) => {
      // Binding is a new immutable version whose datasetIds are the union of the
      // current version's and the requested ones. createVersion authorizes
      // `agent.version.create` and `dataset.read` per newly-pinned dataset and
      // enforces same-workspace ownership — the whole point of routing through it
      // rather than writing datasetIds directly.
      const agent = await agents.get(auth, agentId);
      const current = agent.latestVersion > 0 ? await agents.getVersion(auth, agentId, agent.latestVersion) : undefined;
      const merged = [...new Set([...(current?.datasetIds ?? []), ...datasetIds])];
      const { version } = await agents.createVersion(auth, agentId, {
        spec: { datasetIds: merged },
        changeSummary: `Bound ${datasetIds.length} dataset(s)`,
      });
      return { agentId, version: version.version, datasetIds: version.datasetIds };
    },
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

  // Scrape-time gauges: session and sandbox counts by status, queried live so
  // the exposition is always current rather than coupled to a background tick.
  metrics.registerCollector('ma_sessions', 'Sessions by status', async () => {
    const counts = await store.sessions.countByStatus();
    return Object.entries(counts).map(([status, value]) => ({ labels: { status }, value }));
  });
  metrics.registerCollector('ma_sandboxes', 'Sandboxes by status', async () => {
    const counts = await store.sandboxes.countByStatus();
    return Object.entries(counts).map(([status, value]) => ({ labels: { status }, value }));
  });
  metrics.registerCollector('ma_receipts', 'Connector delivery receipts by status', async () => {
    const counts = await store.receipts.countByStatus();
    return Object.entries(counts).map(([status, value]) => ({ labels: { status }, value }));
  });
  metrics.describe('http_requests_total', 'Total HTTP requests by method, route and status');
  metrics.describe('http_request_errors_total', 'HTTP requests that returned a 5xx');
  metrics.describe('http_request_duration_seconds', 'HTTP request latency in seconds');
  metrics.describe('ma_model_requests_total', 'Model completion calls by model and outcome');
  metrics.describe('ma_model_tokens_total', 'Model tokens by model and kind');
  metrics.describe('ma_model_cost_micros_total', 'Model cost in micros by model');
  metrics.describe('ma_model_duration_seconds', 'Model completion latency in seconds by model');
  metrics.describe('ma_scheduler_ticks_total', 'Scheduler tick outcomes, by kind');

  // The metrics scrape endpoint. Its own auth surface (a static scrape token,
  // not a principal), so a Prometheus scraper never touches the principal
  // database and the scrape path stays off the tenant API. Disabled — a plain
  // 404 — when no token is configured, so nothing is exposed by default. Public
  // in the bearer middleware's eyes (checked below in publicPaths) but guarded
  // here by the scrape token.
  const metricsToken = config.metrics?.token;
  gateway.router.get('/metrics', async (context) => {
    if (!metricsToken) {
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Metrics are not enabled' } } };
    }
    const header = context.headers.authorization;
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : '';
    // Constant-time compare, and refuse an empty token even against an empty
    // configured one (it never is — loadMetrics requires non-empty).
    if (bearer.length === 0 || !safeEqual(bearer, metricsToken)) {
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Invalid metrics token' } } };
    }
    const body = await metrics.render();
    context.raw.res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    });
    context.raw.res.end(body);
    return undefined;
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

      // Refresh the built-in template catalogue. Idempotent by name, so a
      // restart keeps it current without accumulating a copy per boot.
      try {
        await templates.seedBuiltins(BUILTIN_TEMPLATES);
      } catch (error) {
        // A malformed built-in must not stop the platform from starting; it is
        // a shipped-catalogue bug, logged for the next deploy to fix.
        logger.warn('could not seed built-in templates', { error });
      }

      // Before accepting work: a control plane that crashed mid-provision left
      // labelled sandboxes (containers or pods) with no row pointing at them,
      // and nothing else will ever find them. `docs/operations.md` says to run
      // this at startup; until now nothing did, so that leak was real and
      // permanent. Both real drivers implement `reapOrphans`.
      if (driver instanceof ContainerSandboxDriver || driver instanceof K8sSandboxDriver) {
        try {
          const live = await store.sandboxes.list({ statuses: ['pending', 'ready', 'draining'] });
          const reaped = await driver.reapOrphans(live.items.map((sandbox) => sandbox.providerRef));
          if (reaped.length > 0) logger.info('reaped orphaned sandboxes', { count: reaped.length });
        } catch (error) {
          // A backend that is not answering yet must not stop the control plane
          // from starting; the next restart tries again.
          logger.warn('could not reap orphaned sandboxes at startup', { error });
        }
      }

      // Before accepting traffic: rebuild the in-memory search index from
      // durable document storage. The index lives in this process, so a fresh
      // boot starts blind to every document ingested before it — this repopulates
      // it from the blob store. A failure here must not stop the platform: the
      // index simply starts empty and refills as documents re-sync.
      try {
        const rebuilt = await ingestion.rebuild();
        if (rebuilt > 0) logger.info('rebuilt the knowledge index', { documents: rebuilt });
      } catch (error) {
        logger.warn('could not rebuild the knowledge index at startup', { error });
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

/**
 * Re-exported from `@ma/core`, where the env-trust helpers now live (so the
 * sandbox drivers, this provisioner, and agent-core's rebind all share one
 * implementation). Kept exported here because tests import it from the platform.
 */
export { mergeEnvVars } from '@ma/core';

/**
 * Ask a warm sandbox to rebind to a new session.
 *
 * POSTs to the sandbox's `/rebind`, which drops the previous session's context
 * and re-bootstraps as `sessionId` (resolving through the same runtime token,
 * now pointing at the new session in the store). Returns whether the rebind
 * succeeded; a `false` tells the provisioner to fall back to a cold sandbox. A
 * 409 (a turn is somehow still running) counts as failure — the caller must not
 * hand a busy process to a new session. Bounded by a timeout and one retry, so
 * a briefly-slow process is given a second chance before the expensive fallback.
 *
 * `credential` is the sandbox's runtime-token hash, which authenticates this
 * call as the control plane (see the /submit dial for why this is needed once
 * agent-core binds all interfaces).
 */
async function rebindSandbox(
  endpoint: string,
  sessionId: string,
  credential: string,
): Promise<RebindOutcome> {
  if (!endpoint) return 'changed';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${endpoint}/rebind`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return 'ok';
      // A 409 means the process is mid-turn: distinct from a broken environment.
      // Retry once (the turn may end), then report `busy` so the caller backs off
      // rather than tearing the sandbox down under the running turn. Any other 4xx
      // is a permanent refusal — the environment cannot serve this session, so
      // report `changed` and let the caller cold-provision. 5xx is retried once.
      if (response.status === 409) {
        if (attempt === 1) return 'busy';
        continue;
      }
      if (response.status < 500) return 'changed';
    } catch {
      // Network error / timeout — retry once, then give up to the cold fallback.
    }
  }
  return 'changed';
}
