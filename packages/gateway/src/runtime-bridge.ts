/**
 * The runtime bridge.
 *
 * A sandbox is not trusted. It runs code an agent wrote, against files an agent
 * chose, and a compromised one must not be able to reach anything beyond its
 * own session. This module is the entire surface it can call, and every
 * endpoint here is scoped by a session-bound token rather than by a principal.
 *
 * What a sandbox may do:
 *  - append events to *its own* session log
 *  - renew its lease
 *  - exchange a credential *reference* it was granted for a value
 *  - call a model through the gateway
 *
 * What it may not do, by construction rather than by check: read another
 * session, enumerate credentials, mutate control-plane resources, or hold a
 * provider API key.
 */

import {
  MaError,
  CircuitBreaker,
  hashToken,
  notFound,
  permissionDenied,
  quotaExceeded,
  safeEqual,
  sha256Hex,
  validationError,
  unauthenticated,
  withRetry,
  type BreakerState,
  type Clock,
  type Logger,
  type MetricsRegistry,
  type RetryPolicy,
} from '@ma/core';
import {
  EVENT_TYPES,
  array,
  enumOf,
  integer,
  number,
  object,
  optional,
  parseOrThrow,
  record,
  string,
  unknown,
  withDefault,
  type AgentVersion,
  type EventType,
  type Infer,
  type SandboxSpec,
  type Session,
} from '@ma/contracts';
import type { Store } from '@ma/store';
import { secondsUntilDailyReset, type CredentialService, type EventBus, type EventInput, type SessionService } from '@ma/engine';

/**
 * Events a sandbox is permitted to append.
 *
 * Deliberately a subset. A sandbox reporting `session.terminated` or
 * `audit.permission.decided` would be asserting something only the control
 * plane can know, and a log that accepts such claims is not an audit trail.
 */
const SANDBOX_EVENT_TYPES: readonly EventType[] = EVENT_TYPES.filter(
  (type) =>
    type.startsWith('turn.') ||
    type.startsWith('message.') ||
    type.startsWith('thinking.') ||
    type.startsWith('tool.') ||
    type.startsWith('model.') ||
    type.startsWith('context.') ||
    type.startsWith('artifact.'),
);

const appendEventsSchema = object({
  events: array(
    object({
      type: enumOf(SANDBOX_EVENT_TYPES as unknown as readonly [string, ...string[]]),
      payload: withDefault(unknown(), () => ({})),
      turn: optional(integer({ min: 0 })),
      itemId: optional(string({ maxLength: 128 })),
    }),
    { minItems: 1, maxItems: 100 },
  ),
});

const publishArtifactSchema = object({
  path: string({ minLength: 1, maxLength: 1024, nonBlank: true }),
  /** Base64. Bounded here too, so a hostile body is refused before decoding. */
  content: string({ maxLength: 40 * 1024 * 1024 }),
  turn: optional(integer({ min: 0 })),
});

const saveSnapshotSchema = object({
  /** SHA-256 of the decoded bytes; the bridge recomputes and refuses a mismatch. */
  digest: string({ minLength: 1, maxLength: 64 }),
  /** The turn the snapshot was taken at, recorded for the resume event. */
  turn: withDefault(integer({ min: 0 }), 0),
  tokens: withDefault(integer({ min: 0 }), 0),
  /** Base64 of the serialized context snapshot. Bounded before decoding. */
  content: string({ maxLength: 40 * 1024 * 1024 }),
});

const rememberSchema = object({
  content: string({ minLength: 1, maxLength: 2000, nonBlank: true }),
});

const completionSchema = object({
  modelId: string({ minLength: 1, maxLength: 256 }),
  /** Which turn this call belongs to, so its usage is billed exactly once. */
  turn: optional(integer({ min: 0 })),
  messages: array(
    object({
      role: enumOf(['system', 'user', 'assistant', 'tool'] as const),
      content: string(),
      toolCallId: optional(string({ maxLength: 128 })),
      // An assistant message that asked for tools carries them, so the model
      // sees its own prior tool calls when the conversation resumes. Without
      // this the tool-use loop cannot be represented at all.
      toolCalls: optional(
        array(
          object({
            id: string({ maxLength: 128 }),
            name: string({ maxLength: 128 }),
            arguments: withDefault(record(unknown()), () => ({})),
          }),
        ),
      ),
    }),
    { minItems: 1 },
  ),
  tools: withDefault(array(unknown()), () => []),
  maxOutputTokens: optional(integer({ min: 1 })),
  // A float, not an integer: 0.7 is the single most common temperature and the
  // integer bound rejected it, failing every turn that set one.
  temperature: optional(number({ min: 0, max: 2 })),
});

/**
 * Somewhere for a sandbox's files to go.
 *
 * Narrower than the full `ArtifactService` on purpose: the bridge may publish
 * and nothing else. It cannot list, download or delete, so a compromised
 * sandbox reaching this interface still cannot read back what another session
 * produced.
 */
export interface ArtifactPublisher {
  publish(request: {
    workspaceId: string;
    sessionId: string;
    path: string;
    bytes: Uint8Array;
    turn?: number;
  }): Promise<{
    artifact: { id: string; digest: string; sizeBytes: number; contentType: string };
    created: boolean;
  }>;
}

/**
 * Durable storage for context snapshots.
 *
 * Content-addressed like artifacts, but internal: a snapshot is only ever read
 * back by a recovering sandbox of the *same* session, never served to a browser,
 * so it needs none of the artifact download/preview machinery — just put and
 * get by digest, scoped to the workspace.
 */
export interface SnapshotStore {
  put(workspaceId: string, digest: string, bytes: Uint8Array): Promise<void>;
  get(workspaceId: string, digest: string): Promise<Uint8Array | undefined>;
}

/**
 * The memory operations a sandbox may perform.
 *
 * Narrow on purpose, and note what is *not* here: no promote. A sandbox can
 * write a memory and read one back, but nothing it does can mark text
 * injectable — that requires a human, and this interface is the reason an
 * agent cannot reach the operation even by accident.
 */
export interface MemoryPort {
  remember(request: {
    workspaceId: string;
    agentId: string;
    sessionId: string;
    content: string;
  }): Promise<{ memory: { id: string; content: string }; created: boolean }>;
  recall(
    workspaceId: string,
    agentId: string,
    limit?: number,
  ): Promise<{ id: string; content: string; kind: string; origin: string }[]>;
  /**
   * Memories a human allowed into the system prompt.
   *
   * Separate from `recall` rather than a flag on it, so the bootstrap path
   * cannot ask for the wrong set by passing the wrong argument.
   */
  injectable(
    workspaceId: string,
    agentId: string,
  ): Promise<{ id: string; content: string; kind: string }[]>;
}

/**
 * Everything a sandbox needs to start work.
 *
 * Typed rather than `unknown` so a caller — and a test — can assert on the
 * assembled system prompt, which is the field the memory trust boundary is
 * about.
 */
export interface SandboxBootstrap {
  sessionId: string;
  systemPrompt: string;
  model: AgentVersion['model'];
  tools: AgentVersion['tools'];
  context: AgentVersion['context'];
  /** Which runtime the sandbox should run — the built-in harness or a command. */
  runtime: AgentVersion['runtime'];
  skills: AgentVersion['skills'];
  plugins: AgentVersion['plugins'];
  mcpServers: AgentVersion['mcpServers'];
  subAgents: AgentVersion['subAgents'];
  maxTurnsPerSession: number;
  /**
   * Wall-clock ceiling on one turn.
   *
   * Omitting it made the harness compute `undefined * 1000` — NaN — and abort
   * every turn the instant it started, with a message reading "exceeded its
   * undefineds budget". A field the consumer needs and the producer does not
   * send is invisible until something actually consumes it.
   */
  turnTimeoutSeconds: number;
  /**
   * Commands to run once before the first turn.
   *
   * Served here rather than executed by the driver because only the sandbox has
   * the working directory they operate on — and on the container driver the
   * driver is outside the container entirely.
   */
  setupCommands: SandboxSpec['setupCommands'];
  credentialIds: string[];
  /**
   * Credentials the sandbox should materialise as files (types `file` and
   * `ssh_key`), by id and name. A file credential is a file, not an env var:
   * the sandbox exchanges each and writes it into its own filesystem, so the
   * secret never sits in the process environment (visible to `docker inspect`)
   * and a tool can read it by path.
   */
  fileCredentials: { id: string; name: string }[];
  /**
   * Non-file credentials (`env_vars`, `api_key`, `bearer_token`), by id, name and
   * type. Materialised into the process environment on bind (see agent-core's
   * `materializeCredentialEnv`) — a prewarmed/rebound sandbox never re-runs the
   * driver's `provision()`, where the drivers otherwise bake these. References
   * only; each value is fetched one at a time through the audited `exchange`.
   */
  envCredentials: { id: string; name: string; type: string }[];
  datasetIds: string[];
  /**
   * The latest persisted context snapshot, when the session has one. A
   * recovering sandbox fetches these bytes (via `getSnapshot`) and restores the
   * conversation rather than starting over. Absent on a first boot.
   */
  snapshotDigest?: string;
  snapshotTurn?: number;
}

/** Resolved from a runtime token: which session is calling. */
export interface RuntimeIdentity {
  session: Session;
  sandboxId: string;
}

/** Upstream model access. The gateway owns provider credentials, not the sandbox. */
export interface ModelProvider {
  /**
   * Call a model. Implementations attach the provider credential, so a
   * compromised sandbox has no key to steal.
   */
  complete(request: {
    modelId: string;
    messages: { role: string; content: string; toolCallId?: string }[];
    tools: unknown[];
    maxOutputTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    /**
     * Tool calls the model requested this turn.
     *
     * Without this a completion could carry text but never a tool call, so the
     * agent core could run text-only turns and the harness's entire
     * tool-dispatch half was unreachable through it — the model gateway spoke
     * half the protocol. Optional so a text-only provider need not supply it.
     */
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }>;
}

/** What the bridge needs to answer a sandbox's knowledge-base search. */
export interface DatasetSearchPort {
  search(
    datasetIds: readonly string[],
    query: string,
    limit?: number,
  ): Promise<{ source: string; index: number; text: string; score: number }[]>;
}

export interface RuntimeBridgeOptions {
  store: Store;
  clock: Clock;
  bus: EventBus;
  sessions: SessionService;
  credentials: CredentialService;
  models?: ModelProvider;
  /** Artifact storage. Absent means a sandbox cannot publish files. */
  artifacts?: ArtifactPublisher;
  /**
   * Context-snapshot storage. Absent means snapshots are not persisted, so a
   * lost sandbox restarts rather than resuming — the behaviour before this was
   * wired.
   */
  snapshots?: SnapshotStore;
  /** Agent memory. Absent means a sandbox cannot remember or recall. */
  memories?: MemoryPort;
  /** Knowledge-base retrieval. Absent means a sandbox cannot search datasets. */
  retrieval?: DatasetSearchPort;
  /**
   * Content-addressed capability bytes (skills, plugins). Absent means a sandbox
   * cannot download its skills. Read-only by digest — the sandbox pulls only
   * artifacts its pinned version references.
   */
  capabilityBytes?: { get(digest: string): Promise<Uint8Array | undefined> };
  logger?: Logger;
  /** Extends a sandbox lease on heartbeat. */
  renewLease(sandboxId: string): Promise<boolean>;
  /**
   * Metrics registry for model-call observability. Absent means model calls are
   * unmeasured (the bridge still works); when present, each `complete` records
   * request/token/cost counters and a latency histogram, labelled by model id
   * (bounded — models are catalogued) and outcome.
   */
  metrics?: MetricsRegistry;
  /**
   * How a *single* model is retried before the failover loop moves to the next
   * one. A transient provider blip (a 503, a reset, a brief rate-limit) on the
   * requested model is worth a bounded retry in place — failing straight over to
   * a fallback burns a weaker/pricier model for a glitch a retry would absorb.
   * Overrides merge over a gateway-appropriate default (short and bounded, so it
   * never threatens the turn deadline); `maxAttempts: 1` disables retry.
   */
  modelRetry?: Partial<RetryPolicy>;
  /**
   * Circuit-breaker policy for a sustained (not transient) model outage. Once a
   * model fails `failureThreshold` times within `windowMs`, the gateway skips it
   * *instantly* — no retry, no provider call — for `resetMs`, then admits one
   * probe. This stops every session paying the full retry budget against a
   * provider everyone already knows is down. Per-model and in-process.
   * `enabled: false` (or `failureThreshold: 0`) turns it off — exactly today's
   * behaviour. Absent means the gateway default applies.
   */
  modelBreaker?: {
    enabled?: boolean;
    failureThreshold?: number;
    windowMs?: number;
    resetMs?: number;
  };
  /**
   * The daily-budget gate. When set, every completion atomically reserves an
   * estimate against the workspace's `maxTokensPerDay`/`maxCostMicrosPerDay` before
   * the upstream call and releases it on settle — so the quotas are real ceilings
   * that concurrent completions cannot race past, not just admission gates a
   * long-running session can burn through. A structural port `QuotaService`
   * satisfies; absent means no mid-session check (the pre-existing behaviour), so
   * nothing regresses where it is not wired.
   */
  quota?: {
    reserveDailyBudget(
      workspaceId: string,
      estTokens: number,
      estMicros: number,
      tokenLimit: number,
      costLimit: number,
    ): Promise<{ admitted: boolean; dimension?: 'tokensPerDay' | 'costPerDay'; tokensUsed: number; costUsed: number }>;
    releaseDailyBudget(workspaceId: string, estTokens: number, estMicros: number): Promise<void>;
  };
}

/**
 * Default per-model circuit-breaker policy for the gateway. Conservative: five
 * failures in a 30s window trips it, and it stays open 30s before probing — long
 * enough to matter, short enough that a recovered provider is picked up quickly.
 */
const GATEWAY_MODEL_BREAKER = { failureThreshold: 5, windowMs: 30_000, resetMs: 30_000 };

/**
 * Default per-model retry policy for the gateway.
 *
 * Deliberately shorter and less patient than `@ma/core`'s `DEFAULT_RETRY` (which
 * caps at 10s): a model call is bound by the session's turn deadline, so a retry
 * must add sub-second-ish latency, not seconds. Three attempts total, 250ms base
 * growing to a 2s ceiling, full jitter to avoid a thundering herd on one degraded
 * provider.
 */
const GATEWAY_MODEL_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  multiplier: 2,
  jitter: true,
};

export class RuntimeBridge {
  readonly #options: RuntimeBridgeOptions;
  readonly #modelRetry: RetryPolicy;
  /** Per-model circuit breaker; `undefined` when disabled by config. */
  readonly #breaker: CircuitBreaker | undefined;
  /**
   * Token hash → session, for sandboxes provisioned by this process.
   *
   * A cache in front of the store, not the source of truth. It used to be the
   * only record, which had two consequences: nothing outside the provisioning
   * process could authenticate a sandbox, and nothing could after a restart.
   * Since the platform never actually called `bind`, that meant every runtime
   * call from a real sandbox failed and the bridge was dead code in production.
   */
  readonly #tokens = new Map<string, { sessionId: string; sandboxId: string }>();

  constructor(options: RuntimeBridgeOptions) {
    this.#options = options;
    this.#modelRetry = { ...GATEWAY_MODEL_RETRY, ...options.modelRetry };
    // Build a breaker unless explicitly disabled. `failureThreshold: 0` also
    // disables it (the breaker itself treats that as off), so an operator has two
    // equivalent ways to turn it off.
    const breaker = { ...GATEWAY_MODEL_BREAKER, ...options.modelBreaker };
    this.#breaker =
      breaker.enabled === false
        ? undefined
        : new CircuitBreaker({
            clock: options.clock,
            failureThreshold: breaker.failureThreshold,
            windowMs: breaker.windowMs,
            resetMs: breaker.resetMs,
          });
  }

  /** Cache a token binding when this process provisions a sandbox. */
  bind(token: string, sessionId: string, sandboxId: string): void {
    this.#tokens.set(hashToken(token), { sessionId, sandboxId });
  }

  /** Forget a token when its sandbox is released. */
  unbind(token: string): void {
    const hashed = hashToken(token);
    this.#tokens.delete(hashed);
    // Billing-dedup markers are now durable (`store.billedTurns`) and reclaimed at
    // the session's terminal transition (`SessionService.shutdown` → clearSession),
    // with the session-row CASCADE as the final backstop — so there is nothing
    // in-memory to sweep here.
  }

  /**
   * Forget every cached binding for a sandbox, by sandbox id.
   *
   * Reuse is why this exists. A reused sandbox keeps its original runtime token,
   * so its token-hash cache entry survives its first session and would still
   * name that (now terminated) session after the sandbox rebinds to a second.
   * `authenticate` prefers the cache over the store, so a stale entry makes the
   * second session's calls resolve to the first — the reuse misroute this whole
   * design exists to prevent. On release the provisioner calls this so the next
   * `authenticate` falls through to `#bindingFromStore`, which reads the current
   * (last) holder. Billing-dedup markers are durable and reclaimed at the
   * session's terminal transition, so there are none to sweep here.
   */
  forgetSandbox(sandboxId: string): void {
    for (const [hash, binding] of this.#tokens) {
      if (binding.sandboxId !== sandboxId) continue;
      this.#tokens.delete(hash);
    }
  }

  /**
   * Resolve a bearer token to its sandbox, without requiring a bound session.
   *
   * For the two endpoints a not-yet-bound sandbox uses: heartbeat (keeps a
   * prewarmed environment's lease alive while it waits to be claimed) and
   * bootstrap (which answers `unbound` for a prewarm holder rather than failing).
   * Returns the sandbox id always, and the current *real* session when the
   * sandbox has one — a synthetic `prewarm-*` holder resolves to no session.
   * Every session-bearing endpoint uses `authenticate` instead, which requires a
   * live session, so an unbound sandbox can do nothing but heartbeat and wait.
   */
  async authenticateSandbox(
    token: string | undefined,
  ): Promise<{ sandboxId: string; session?: Session }> {
    if (!token || token.length === 0) throw unauthenticated('A runtime token is required');
    const hashed = hashToken(token);
    const sandbox = await this.#options.store.sandboxes.getByRuntimeTokenHash(hashed);
    if (!sandbox || sandbox.status === 'released' || sandbox.status === 'lost') {
      throw unauthenticated('Unknown runtime token');
    }
    const sessionId = sandbox.sessionIds[sandbox.sessionIds.length - 1];
    const session = sessionId ? await this.#options.store.sessions.get(sessionId) : undefined;
    // A terminal session counts as no session here: a bound sandbox whose
    // session ended is effectively unbound and awaiting its next claim.
    const live = session && !['terminated', 'failed'].includes(session.status) ? session : undefined;
    return { sandboxId: sandbox.id, ...(live ? { session: live } : {}) };
  }

  /**
   * Resolve a bearer token to the session it may act for.
   *
   * A token that resolves to a finished session is rejected: a sandbox that
   * outlived its session must not keep writing to a log the control plane
   * considers closed.
   */
  async authenticate(token: string | undefined): Promise<RuntimeIdentity> {
    if (!token || token.length === 0) throw unauthenticated('A runtime token is required');

    const hashed = hashToken(token);
    const cached = this.#tokens.get(hashed);
    const binding = cached ?? (await this.#bindingFromStore(hashed));
    if (!binding) throw unauthenticated('Unknown runtime token');

    // On a cache hit, `#bindingFromStore` — the only path that checks the
    // sandbox's own status — was skipped, so a cached binding kept authenticating
    // against a sandbox the control plane had already written off. The lease
    // reaper marks a sandbox `lost` (and release marks it `released`) and only
    // *later*, on a separate path, does the platform call `forgetSandbox` to drop
    // this cache entry — and some release paths (a warm sandbox discarded by
    // another process) never reach this process's cache at all. Re-validate the
    // sandbox row on the cache-hit path too, so a stale entry cannot outlive the
    // sandbox it names, independent of whether `forgetSandbox` ran. A missing row
    // is tolerated (the binding may predate a sandbox row in tests, and prod
    // always has one); a row that exists and is terminal is refused.
    if (cached) {
      const sandbox = await this.#options.store.sandboxes.get(binding.sandboxId);
      if (sandbox && (sandbox.status === 'released' || sandbox.status === 'lost')) {
        this.#tokens.delete(hashed);
        throw unauthenticated('Unknown runtime token');
      }
    }

    const session = await this.#options.store.sessions.get(binding.sessionId);
    if (!session) throw notFound('Session', binding.sessionId);
    if (['terminated', 'failed'].includes(session.status)) {
      throw new MaError({
        code: 'SESSION_CLOSED',
        category: 'precondition',
        message: 'This session has ended; the sandbox should stop',
      });
    }

    return { session, sandboxId: binding.sandboxId };
  }

  /**
   * Recover a token binding from the store.
   *
   * The lookup is by hash, so a constant-time comparison afterwards adds
   * nothing — the database matched the full hash or it did not. A released
   * sandbox is refused here rather than at the session check, because a
   * released sandbox may still have a live session that other sandboxes serve.
   */
  async #bindingFromStore(
    hashed: string,
  ): Promise<{ sessionId: string; sandboxId: string } | undefined> {
    const sandbox = await this.#options.store.sandboxes.getByRuntimeTokenHash(hashed);
    if (!sandbox) return undefined;
    if (sandbox.status === 'released' || sandbox.status === 'lost') return undefined;

    // A sandbox may serve several sessions over its life: `claimFromPool`
    // APPENDS the claiming session, so the list is ordered oldest-first and the
    // *last* entry is the session the environment currently serves.
    //
    // This read `sessionIds[0]` — the session the sandbox was created for. A
    // pooled sandbox reused by a second session therefore wrote that session's
    // events, turn transcript and token usage into the *first* session's log,
    // which by then was finished. The events were not lost; they were filed
    // under the wrong session, which is worse than losing them because the log
    // is the audit trail and it read as authoritative.
    //
    // Credential exchange is checked against the same identity, but that is not
    // exploitable: `computePoolKey` includes both the sorted credential set AND
    // the agent id, so two sessions can only share a sandbox when their grants are
    // identical and they belong to the same agent. The agent-id scoping is what
    // keeps a reused runtime token (which the sandbox holds across occupants)
    // within one agent's own sessions — it can never resolve to a different
    // agent's session and read that agent's datasets/models/skills.
    const sessionId = sandbox.sessionIds[sandbox.sessionIds.length - 1];
    if (!sessionId) return undefined;

    const binding = { sessionId, sandboxId: sandbox.id };
    this.#tokens.set(hashed, binding);
    return binding;
  }

  /**
   * Append events to the caller's own session.
   *
   * The session id comes from the token, never from the request body — a
   * sandbox naming a different session would otherwise be able to forge
   * another agent's history.
   */
  async appendEvents(identity: RuntimeIdentity, body: unknown): Promise<{ accepted: number; lastSeq: number }> {
    const parsed = parseOrThrow(appendEventsSchema, body);

    const stored = await this.#options.bus.publish(
      parsed.events.map((event) => ({
        sessionId: identity.session.id,
        workspaceId: identity.session.workspaceId,
        type: event.type as EventType,
        payload: event.payload,
        ...(event.turn === undefined ? {} : { turn: event.turn }),
        ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
      })),
    );

    // Usage reported on a completed turn is what drives quota, so it is folded
    // into the session rather than left only on the log.
    //
    // Only for turns this bridge did not already bill.
    //
    // A turn whose model calls went through `/completions` has had its usage
    // recorded there, from the provider's own response. Folding the sandbox's
    // `turn.completed` report in as well would bill a workspace twice for one
    // call and exhaust its daily budget at half the real spend. But a sandbox
    // holding its own model client is not billed anywhere else, so its report
    // is the only accounting there is — and dropping it unconditionally would
    // make that workspace's usage read as zero.
    //
    // The dedup markers are DURABLE (`store.billedTurns`), not an in-memory set,
    // and each check/fold runs in one transaction inside `recordReportedUsage` /
    // `clearTurnlessBillingFlag` — so a control-plane restart between a
    // `/completions` billing and this report cannot lose the marker and
    // double-bill. `recordReportedUsage` bills only when neither the exact turn
    // key nor the per-session turn-less flag says the turn was already charged; a
    // turn end (completed *or* failed) also clears the turn-less flag so it never
    // leaks into a later turn.
    for (const event of parsed.events) {
      const sessionId = identity.session.id;
      if (event.type === 'turn.failed') {
        // A failed turn ends the turn: clear any turn-less-completion flag so it
        // does not suppress a later billable turn. turn.failed carries no usage.
        await this.#options.sessions.clearTurnlessBillingFlag(sessionId, identity.sandboxId);
        continue;
      }
      if (event.type !== 'turn.completed') continue;
      // Read the turn from the payload, which the event schema *requires* for
      // `turn.completed`, not the envelope's optional `turn` field — so the
      // precise per-turn dedup does not silently degrade to the fallback just
      // because the sandbox omitted the redundant envelope copy.
      //
      // Dedup trusts the sandbox's own turn numbering: a sandbox that bills a
      // completion under turn N but reports `turn.completed` for a different turn
      // (or reports the same turn twice) can bill twice. The bundled agent-core
      // uses one turn counter for both, so this only bites a buggy/hostile
      // sandbox — a broader trust question than this dedup, out of scope here.
      const payloadTurn = (event.payload as { turn?: number }).turn;
      const eventTurn = payloadTurn ?? event.turn;
      const usage = (event.payload as { usage?: Record<string, number> }).usage ?? {};
      // recordReportedUsage consumes the durable marker (keyed by this sandbox
      // generation) and folds only if the turn was not already billed via
      // /completions — the check and fold are one transaction, so two concurrent
      // reports cannot both bill and a rolled-back fold cannot lose a consumed
      // marker.
      await this.#options.sessions.recordReportedUsage(sessionId, identity.sandboxId, eventTurn, {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        costMicros: usage.costMicros ?? 0,
      });
    }

    // Drive the session status from the turn lifecycle: a turn beginning takes
    // it to `running`, a turn ending (completed or failed) returns it to `idle`.
    // This is what produces the `idle` state — the reaper's signal that a
    // sandbox was productive. Processed in arrival order so a batch carrying a
    // whole turn (started … completed) lands running then idle. noteTurnActivity
    // is a no-op on a session already in the target state or one that has
    // finished, so a stale report from a terminating sandbox is harmless.
    for (const event of parsed.events) {
      if (event.type === 'turn.started') {
        await this.#options.sessions.noteTurnActivity(identity.session.id, 'started');
      } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        await this.#options.sessions.noteTurnActivity(identity.session.id, 'ended');
      }
    }

    // Derive the audit record of each permission decision from the *trusted*
    // tool.approved / tool.denied events the sandbox reported. A sandbox may not
    // assert `audit.permission.decided` itself (it is not in SANDBOX_EVENT_TYPES
    // — a sandbox claiming its own policy verdict is not an audit trail), so the
    // control plane emits it here, keyed by tool name resolved from the matching
    // tool.requested in the same batch.
    const toolNameById = new Map<string, string>();
    for (const event of parsed.events) {
      if (event.type === 'tool.requested') {
        const p = event.payload as { toolCallId?: string; toolName?: string };
        if (p.toolCallId && p.toolName) toolNameById.set(p.toolCallId, p.toolName);
      }
    }
    const decisionEvents: EventInput[] = [];
    for (const event of parsed.events) {
      if (event.type !== 'tool.approved' && event.type !== 'tool.denied') continue;
      const p = event.payload as { toolCallId?: string; decision?: { decision: string; rule: string; reason: string } };
      if (!p.decision) continue;
      decisionEvents.push({
        sessionId: identity.session.id,
        workspaceId: identity.session.workspaceId,
        type: 'audit.permission.decided',
        payload: {
          toolName: (p.toolCallId && toolNameById.get(p.toolCallId)) || '',
          decision: p.decision,
        },
      });
    }
    if (decisionEvents.length > 0) await this.#options.bus.publish(decisionEvents);

    return {
      accepted: stored.length,
      lastSeq: stored[stored.length - 1]?.seq ?? identity.session.lastSeq,
    };
  }

  /**
   * Store a file this sandbox produced.
   *
   * The workspace and session come from the resolved identity, never from the
   * request — a sandbox names only its own bytes. The digest and content type
   * are computed by the service from those bytes, so the row records what was
   * actually received rather than what the sandbox claimed.
   *
   * Note the deliberate asymmetry with `artifact.created` events: a sandbox may
   * append one of those saying anything at all, and nothing reads it. This is
   * the only path that produces a record.
   */
  async publishArtifact(
    identity: RuntimeIdentity,
    body: unknown,
  ): Promise<{
    artifactId: string;
    digest: string;
    sizeBytes: number;
    contentType: string;
    created: boolean;
  }> {
    const publisher = this.#options.artifacts;
    if (!publisher) {
      throw new MaError({
        code: 'ARTIFACTS_UNAVAILABLE',
        category: 'precondition',
        message: 'This deployment has no artifact storage configured',
      });
    }

    const parsed = parseOrThrow(publishArtifactSchema, body);
    // Base64 rather than a raw body: the runtime posts JSON everywhere else,
    // and one encoding used by one endpoint is a parser nobody maintains.
    const bytes = decodeBase64(parsed.content);

    const result = await publisher.publish({
      workspaceId: identity.session.workspaceId,
      sessionId: identity.session.id,
      path: parsed.path,
      bytes,
      ...(parsed.turn === undefined ? {} : { turn: parsed.turn }),
    });

    return {
      artifactId: result.artifact.id,
      digest: result.artifact.digest,
      sizeBytes: result.artifact.sizeBytes,
      contentType: result.artifact.contentType,
      created: result.created,
    };
  }

  /**
   * Persist a context snapshot so a lost sandbox can resume this session.
   *
   * The bytes are content-addressed and the digest is re-verified here: the
   * sandbox is untrusted, so a snapshot whose bytes do not hash to the claimed
   * digest is refused rather than stored — a restore later checks the same
   * digest, and a mismatch there would silently corrupt the resumed context.
   * The session row records the digest so bootstrap can hand it back; "latest
   * wins", so a newer snapshot supersedes the old.
   */
  async saveSnapshot(
    identity: RuntimeIdentity,
    body: unknown,
  ): Promise<{ digest: string; stored: boolean }> {
    const store = this.#options.snapshots;
    // Absent storage is not an error: the sandbox always tries to save, and a
    // deployment without snapshot storage simply does not resume. Report it so
    // the caller does not believe it is protected when it is not.
    if (!store) return { digest: '', stored: false };

    const parsed = parseOrThrow(saveSnapshotSchema, body);
    const bytes = decodeBase64(parsed.content);
    if (sha256Hex(bytes) !== parsed.digest) {
      throw new MaError({
        code: 'SNAPSHOT_INTEGRITY',
        category: 'validation',
        message: 'The snapshot bytes do not match the declared digest',
      });
    }

    const workspaceId = identity.session.workspaceId;
    await store.put(workspaceId, parsed.digest, bytes);
    // Record the reference last: a row pointing at bytes that failed to store
    // would be a resume that cannot find its snapshot.
    await this.#options.store.sessions.update(identity.session.id, {
      snapshotDigest: parsed.digest,
      snapshotTurn: parsed.turn,
      updatedAt: this.#options.clock.now(),
    });

    return { digest: parsed.digest, stored: true };
  }

  /**
   * Fetch a snapshot's bytes for a recovering sandbox.
   *
   * Scoped to the caller's own session: the digest must be the one recorded on
   * that session's row, so a sandbox cannot read another session's context by
   * guessing a digest. Returned base64-encoded, like `fetchCapability`.
   */
  async getSnapshot(
    identity: RuntimeIdentity,
    digest: string,
  ): Promise<{ digest: string; content: string }> {
    const store = this.#options.snapshots;
    if (!store) throw notFound('Snapshot', digest);
    if (identity.session.snapshotDigest !== digest) {
      // Not this session's snapshot — refuse rather than serve arbitrary bytes.
      throw permissionDenied('fetch', digest);
    }
    const bytes = await store.get(identity.session.workspaceId, digest);
    if (!bytes) throw notFound('Snapshot', digest);
    // Re-verify on the way out, as the capability fetch does: on-disk corruption
    // must surface as an error the sandbox can fall back from, not as a silently
    // wrong context.
    if (sha256Hex(bytes) !== digest) {
      throw new MaError({
        code: 'SNAPSHOT_INTEGRITY',
        category: 'precondition',
        message: 'A stored snapshot does not match its digest',
      });
    }
    return { digest, content: Buffer.from(bytes).toString('base64') };
  }

  /**
   * Record something this agent learned.
   *
   * `origin` is fixed to `agent` and `injectable` to false by the service, so
   * nothing a sandbox sends can produce a memory that reaches a system prompt.
   * The workspace and agent come from the resolved identity, never the request.
   */
  async remember(
    identity: RuntimeIdentity,
    body: unknown,
  ): Promise<{ memoryId: string; created: boolean }> {
    const port = this.#requireMemories();
    const parsed = parseOrThrow(rememberSchema, body);

    const result = await port.remember({
      workspaceId: identity.session.workspaceId,
      agentId: identity.session.agentId,
      sessionId: identity.session.id,
      content: parsed.content,
    });

    return { memoryId: result.memory.id, created: result.created };
  }

  /**
   * Read back what this agent remembers.
   *
   * Returns `origin` on every entry so the runtime can present a memory to the
   * model as what it is. An agent-authored line is the agent's own past claim,
   * not an instruction from its operator, and the two should not look alike in
   * the transcript.
   */
  async recall(
    identity: RuntimeIdentity,
    limit?: number,
  ): Promise<{ memories: { id: string; content: string; kind: string; origin: string }[] }> {
    const port = this.#requireMemories();
    const memories = await port.recall(
      identity.session.workspaceId,
      identity.session.agentId,
      limit,
    );
    // Project to the four fields the runtime needs, explicitly. The sandbox is
    // untrusted, and a full Memory row carries `promotedBy` (a principal id),
    // `sourceSessionId`, `createdBy` and `workspaceId` — internal provenance an
    // agent has no business reading. The return *type* was already narrow, but
    // returning the rows verbatim satisfied it structurally while leaking every
    // extra field over the wire. This is the enforcement, not the annotation.
    return {
      memories: memories.map((memory) => ({
        id: memory.id,
        content: memory.content,
        kind: memory.kind,
        origin: memory.origin,
      })),
    };
  }

  #requireMemories(): MemoryPort {
    const port = this.#options.memories;
    if (!port) {
      throw new MaError({
        code: 'MEMORY_UNAVAILABLE',
        category: 'precondition',
        message: 'This deployment has no agent memory configured',
      });
    }
    return port;
  }

  /**
   * Search the knowledge bases attached to this session's pinned version.
   *
   * The datasets are read from the pinned `AgentVersion`, never from the request:
   * a sandbox may only search what its version was granted, and widening the
   * agent's datasets never widens a session already running. The intersection
   * with any requested ids is taken so a sandbox cannot reach a dataset outside
   * its grant even by naming it.
   */
  async search(
    identity: RuntimeIdentity,
    query: string,
    limit?: number,
  ): Promise<{ results: { source: string; index: number; text: string; score: number }[] }> {
    const port = this.#options.retrieval;
    if (!port) {
      throw new MaError({
        code: 'RETRIEVAL_UNAVAILABLE',
        category: 'precondition',
        message: 'This deployment has no knowledge retrieval configured',
      });
    }
    const version = await this.#options.store.agentVersions.get(
      identity.session.agentId,
      identity.session.resolvedVersion,
    );
    const datasetIds = version?.datasetIds ?? [];
    if (datasetIds.length === 0) return { results: [] };

    const results = await port.search(datasetIds, query, limit);
    return { results };
  }

  /**
   * Download a capability artifact (skill or plugin) by digest.
   *
   * Authorized against the session's *pinned* version: a sandbox may pull only a
   * digest its own version references, never an arbitrary one. This is how a
   * skill's bytes reach the sandbox — the sandbox has no other read path, and
   * the artifact store is otherwise publish-only from a sandbox's side.
   */
  async fetchCapability(
    identity: RuntimeIdentity,
    digest: string,
  ): Promise<{ digest: string; content: string; contentType: string }> {
    const store = this.#options.capabilityBytes;
    if (!store) {
      throw new MaError({
        code: 'CAPABILITIES_UNAVAILABLE',
        category: 'precondition',
        message: 'This deployment has no capability artifact store configured',
      });
    }
    const version = await this.#options.store.agentVersions.get(
      identity.session.agentId,
      identity.session.resolvedVersion,
    );
    const allowed = new Set([
      ...(version?.skills ?? []).map((ref) => ref.digest),
      ...(version?.plugins ?? []).map((ref) => ref.digest),
    ]);
    if (!allowed.has(digest)) {
      // Not on this version — refuse rather than serve an arbitrary artifact to
      // untrusted sandbox code.
      throw permissionDenied('fetch', digest);
    }

    const content = await store.get(digest);
    if (!content) throw notFound('CapabilityArtifact', digest);
    // Re-verify the bytes hash to the requested digest before handing them to
    // untrusted sandbox code — the same integrity check CapabilityService.plan
    // makes. Catches on-disk corruption or an out-of-band replacement of a
    // stored blob, which content addressing exists to detect.
    if (sha256Hex(content) !== digest) {
      throw new MaError({
        code: 'CAPABILITY_INTEGRITY',
        category: 'precondition',
        message: 'A stored capability artifact does not match its digest',
      });
    }
    return {
      digest,
      content: Buffer.from(content).toString('base64'),
      contentType: 'application/octet-stream',
    };
  }

  /**
   * Extend the sandbox lease.
   *
   * A `false` answer means the control plane has written this sandbox off, and
   * the runtime should stop rather than keep working in an environment nobody
   * is watching.
   */
  async heartbeat(identity: { sandboxId: string }): Promise<{ alive: boolean; expiresAt?: number }> {
    const renewed = await this.#options.renewLease(identity.sandboxId);
    if (!renewed) return { alive: false };

    const sandbox = await this.#options.store.sandboxes.get(identity.sandboxId);
    return {
      alive: true,
      ...(sandbox ? { expiresAt: sandbox.leaseExpiresAt } : {}),
    };
  }

  /**
   * Exchange a credential reference for its value.
   *
   * Authorized against the session's *pinned* credential list, so widening an
   * agent's credentials never retroactively widens a session already running.
   * Every exchange is audited by id and purpose, never by value.
   */
  async exchangeCredential(
    identity: RuntimeIdentity,
    credentialId: string,
    purpose: string,
  ): Promise<{ value: string }> {
    if (!identity.session.credentialIds.includes(credentialId)) {
      throw permissionDenied('exchange', credentialId);
    }
    const value = await this.#options.credentials.exchange(
      identity.session,
      credentialId,
      purpose || 'runtime request',
    );
    // Record the access in the session's own event log, by id and purpose only —
    // never the value. This complements the separate audit store with a trace
    // that travels with the session's replayable history.
    await this.#options.bus.publish([
      {
        sessionId: identity.session.id,
        workspaceId: identity.session.workspaceId,
        type: 'audit.credential.accessed',
        payload: { credentialId, purpose: purpose || 'runtime request' },
      },
    ]);
    return { value };
  }

  /**
   * Call a model on the sandbox's behalf.
   *
   * The provider credential lives here, so the sandbox never holds one. Usage
   * is recorded against the session as the call returns, which is what makes
   * token quota accurate rather than an estimate.
   */
  async complete(identity: RuntimeIdentity, body: unknown): Promise<unknown> {
    if (!this.#options.models) {
      throw new MaError({
        code: 'MODEL_GATEWAY_UNAVAILABLE',
        category: 'unavailable',
        message: 'No model provider is configured',
      });
    }

    const request = parseOrThrow(completionSchema, body);

    // The session may only use the model its pinned version declares, plus its
    // declared fallbacks. Otherwise a compromised agent could route a workload
    // to an expensive or less-restricted model.
    const version = await this.#options.store.agentVersions.get(
      identity.session.agentId,
      identity.session.resolvedVersion,
    );
    if (!version) throw notFound('AgentVersion', String(identity.session.resolvedVersion));

    const permitted = [version.model.modelId, ...version.model.fallbackModelIds];
    if (!permitted.includes(request.modelId)) {
      throw permissionDenied('use model', request.modelId);
    }

    // Atomically reserve an estimate against the daily token AND cost budgets
    // before the (irreversible) upstream call, releasing it on settle. A plain
    // read-then-compare gate let N concurrent completions all observe the same
    // under-cap snapshot and each proceed, racing past the cap the comment below
    // promises to enforce as a real ceiling. The reservation counts billed +
    // already-reserved atomically, so only as many concurrent calls as the budget
    // allows are admitted. The estimate is the WORST case for this call — its input
    // tokens plus the effective max output it could generate (bounded by the same
    // per-model/per-version clamp `#completeWith` applies) — so even if every
    // in-flight call maxes out, the cap holds. One reservation covers the whole
    // failover chain: a budget does not care which model answers. Absent quota port
    // → no reservation (unchanged where unwired). Cost cap `0` means unlimited.
    let budgetReservation:
      | { workspaceId: string; estTokens: number; estMicros: number }
      | undefined;
    if (this.#options.quota) {
      const workspace = await this.#options.store.workspaces.get(identity.session.workspaceId);
      if (workspace) {
        const now = this.#options.clock.now();
        const requestedModel = await this.#options.store.models.get(request.modelId);
        const outputCeiling = Math.min(
          requestedModel?.maxOutputTokens ?? request.maxOutputTokens ?? 0,
          version.model.maxOutputTokens ?? requestedModel?.maxOutputTokens ?? request.maxOutputTokens ?? 0,
        );
        const estOutput = Math.max(
          1,
          request.maxOutputTokens !== undefined && outputCeiling > 0
            ? Math.min(request.maxOutputTokens, outputCeiling)
            : outputCeiling || (request.maxOutputTokens ?? 0),
        );
        const estInput = estimatePromptTokens(request.messages);
        const estTokens = estInput + estOutput;
        const estMicros = requestedModel
          ? priceOf(requestedModel, {
              inputTokens: estInput,
              outputTokens: estOutput,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            })
          : 0;
        const decision = await this.#options.quota.reserveDailyBudget(
          workspace.id,
          estTokens,
          estMicros,
          workspace.quota.maxTokensPerDay,
          workspace.quota.maxCostMicrosPerDay,
        );
        if (!decision.admitted) {
          const dimension = decision.dimension ?? 'tokensPerDay';
          const limit =
            dimension === 'costPerDay'
              ? workspace.quota.maxCostMicrosPerDay
              : workspace.quota.maxTokensPerDay;
          const observed = dimension === 'costPerDay' ? decision.costUsed : decision.tokensUsed;
          throw quotaExceeded(dimension, limit, observed, secondsUntilDailyReset(now));
        }
        budgetReservation = { workspaceId: workspace.id, estTokens, estMicros };
      }
    }

    try {
      return await this.#runCompletionChain(identity, request, version, permitted);
    } finally {
      // Release the held estimate however the chain ends — success billed the
      // actual usage into the separate billed columns, and a failure billed
      // nothing; either way the reservation must not linger.
      if (budgetReservation) {
        await this.#options.quota!.releaseDailyBudget(
          budgetReservation.workspaceId,
          budgetReservation.estTokens,
          budgetReservation.estMicros,
        );
      }
    }
  }

  /**
   * The failover chain: the requested model first, then every declared model that
   * comes *after* it in the pinned order, so a retryable provider failure falls
   * through to the next choice the version authorised — never to one it did not.
   * Requesting a fallback directly starts the chain there, so a caller that already
   * knows the primary is down does not re-try it. Split from `complete` so the
   * budget reservation there can wrap the whole chain in one try/finally.
   */
  async #runCompletionChain(
    identity: RuntimeIdentity,
    request: Infer<typeof completionSchema>,
    version: AgentVersion,
    permitted: string[],
  ): Promise<unknown> {
    const requestedIndex = permitted.indexOf(request.modelId);
    const chain = permitted.slice(requestedIndex);

    let lastError: MaError | undefined;
    for (let i = 0; i < chain.length; i++) {
      const modelId = chain[i]!;

      // Circuit breaker: skip a model that is already known-down, instantly, with
      // no retry budget and no provider call. Treated exactly like a failed
      // attempt that is not the requested-model authority case — record a failover
      // hop and move on. When the breaker is open on the *requested* model this is
      // still correct: an open breaker is evidence of a transient/outage
      // condition, not a caller error, so failing over is the right move.
      if (this.#breaker) {
        const decision = this.#breaker.canAttempt(modelId);
        this.#recordBreakerState(modelId);
        if (!decision.allowed) {
          this.#options.metrics?.incrementCounter('ma_model_breaker_skips_total', { model: modelId });
          lastError = new MaError({
            code: 'MODEL_CIRCUIT_OPEN',
            category: 'unavailable',
            message: `Model ${modelId} is circuit-broken (too many recent failures)`,
          });
          if (i + 1 < chain.length) {
            this.#options.metrics?.incrementCounter('ma_model_failover_total', {
              from: modelId,
              to: chain[i + 1]!,
            });
          }
          continue;
        }
      }

      try {
        const result = await this.#completeWith(identity, request, modelId, {
          isFallback: i > 0,
          from: i > 0 ? request.modelId : undefined,
          // The pinned version's own output ceiling, enforced at the sink
          // alongside each model's catalogue cap. A single value that applies
          // whichever model in the chain answers.
          ...(version.model.maxOutputTokens === undefined
            ? {}
            : { versionMaxOutputTokens: version.model.maxOutputTokens }),
        });
        // A success closes the breaker (or settles a half-open probe).
        this.#breaker?.recordSuccess(modelId);
        this.#recordBreakerState(modelId);
        return result;
      } catch (error) {
        const failure = MaError.from(error);
        lastError = failure;
        // Always settle the attempt with the breaker so an admitted half-open
        // probe can never leave `probing` stuck (which would lock the model out
        // forever). But a non-retryable failure is the caller's fault, not
        // provider ill-health, so it must not *count toward tripping* a closed
        // breaker — `countsTowardTrip` carries that distinction. (A failed probe
        // re-opens regardless, which is the fail-safe choice.)
        if (this.#breaker) {
          this.#breaker.recordFailure(modelId, failure.retryable);
          this.#recordBreakerState(modelId);
        }
        // The requested model is authoritative: a non-retryable failure there —
        // a bad request, no access, a disabled/unknown model — is the caller's
        // answer, so surface it at once rather than fanning a deterministic error
        // across every fallback. Once past it into the fallbacks, each is
        // best-effort: any failure (a retryable provider outage, or a
        // misconfigured/disabled fallback) skips to the next, so one broken
        // fallback cannot defeat a healthy later one. Only when the whole chain
        // is exhausted do we surface the last error (below).
        if (i === 0 && !failure.retryable) throw failure;
        // Record the hop when there is a next model to try.
        if (i + 1 < chain.length) {
          this.#options.metrics?.incrementCounter('ma_model_failover_total', {
            from: modelId,
            to: chain[i + 1]!,
          });
        }
      }
    }

    // Every model in the chain failed retryably. Surface the last failure — the
    // caller sees a real provider error, not a synthetic one, and it is already
    // marked retryable so the harness can back off.
    throw lastError ?? new MaError({
      code: 'MODEL_GATEWAY_UNAVAILABLE',
      category: 'unavailable',
      message: 'All models failed',
    });
  }

  /**
   * One model attempt: enforce the per-model preconditions, call the provider,
   * and on success bill usage and emit the completion event/metrics for the
   * model that actually answered. A precondition failure (disabled, unknown, not
   * allowed for this workspace) throws a *non-retryable* error, so the failover
   * loop does not treat a misconfigured fallback as worth retrying past — it
   * still advances only on a retryable provider error.
   */
  async #completeWith(
    identity: RuntimeIdentity,
    request: Infer<typeof completionSchema>,
    modelId: string,
    context: { isFallback: boolean; from?: string; versionMaxOutputTokens?: number },
  ): Promise<unknown> {
    const model = await this.#options.store.models.get(modelId);
    if (!model || !model.enabled) throw notFound('Model', modelId);
    if (
      model.allowedWorkspaceIds.length > 0 &&
      !model.allowedWorkspaceIds.includes(identity.session.workspaceId)
    ) {
      throw permissionDenied('use model', modelId);
    }

    // Clamp the requested output ceiling to what the version and the catalogue
    // model actually permit, before it reaches the provider. `completionSchema`
    // bounds `maxOutputTokens` below (min 1) but not above, and the value comes
    // from an untrusted sandbox: without this clamp a sandbox calling the bridge
    // directly could request an arbitrarily large `maxOutputTokens` (the bundled
    // harness self-limits, but the bridge is the trust boundary), overrunning the
    // per-model/per-version envelope and — since the daily-budget gate is a
    // pre-call threshold, not a reservation — the daily cap in a single call. The
    // catalogue cap (`model.maxOutputTokens`) always applies; the version's own
    // ceiling tightens it further when set. An omitted request value inherits the
    // catalogue cap rather than the provider's default, so "unset" cannot mean
    // "unbounded" either.
    const ceiling = Math.min(
      model.maxOutputTokens,
      context.versionMaxOutputTokens ?? model.maxOutputTokens,
    );
    const effectiveMaxOutputTokens = Math.min(
      request.maxOutputTokens ?? ceiling,
      ceiling,
    );

    // The provider call is retried in place before the failover loop (in
    // `complete`) moves to the next model: a transient blip on the requested
    // model is worth a bounded, backed-off retry rather than an immediate
    // downgrade to a fallback. `withRetry` uses `MaError.retryable` — the same
    // classification the failover loop uses — so a non-retryable error (a bad
    // request, no access) is thrown on the first attempt and the failover loop's
    // `i === 0` short-circuit still fires. `model.failed` is emitted per failed
    // attempt (inside the retried body), so the operator sees every try.
    return await withRetry(
      async () => {
        const startedAt = this.#options.clock.monotonic();
        try {
          const result = await this.#options.models!.complete({
            modelId,
            messages: request.messages,
            tools: request.tools,
            maxOutputTokens: effectiveMaxOutputTokens,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          });

          const costMicros = priceOf(model, result.usage);
          const durationMs = this.#options.clock.monotonic() - startedAt;
          // Metrics and billing are attributed to the model that ACTUALLY answered,
          // not the one originally requested.
          this.#recordModelMetrics(modelId, 'ok', durationMs, { ...result.usage, costMicros });
          // Bill the usage AND durably mark the turn billed, in one transaction, so
          // the matching `turn.completed` report is deduped and the workspace is not
          // charged twice for one call. The marker is durable (not an in-memory set)
          // and committed atomically with the fold, so a control-plane restart
          // between this billing and the report cannot lose the dedup and
          // double-bill. It is keyed by this sandbox generation, so a re-queue onto
          // a fresh sandbox (recovery/upgrade) cannot let a stale marker under-bill
          // the new generation. A completion carrying a turn is keyed by turn (the
          // exact dedup); one that omits it sets the per-sandbox turn-less flag,
          // which the next turn end clears.
          await this.#options.sessions.recordProxyUsage(identity.session.id, identity.sandboxId, request.turn, {
            ...result.usage,
            costMicros,
          });

          await this.#options.bus.publish([
            {
              sessionId: identity.session.id,
              workspaceId: identity.session.workspaceId,
              type: 'model.completed',
              payload: {
                modelId,
                durationMs,
                usage: { ...result.usage, costMicros },
                stopReason: result.stopReason,
                // When a fallback answered, record which model was originally asked
                // for, so the log tells the operator a failover happened.
                ...(context.isFallback && context.from ? { fallbackFrom: context.from } : {}),
              },
            },
          ]);

          return { ...result, usage: { ...result.usage, costMicros } };
        } catch (error) {
          const failure = MaError.from(error);
          this.#recordModelMetrics(modelId, 'error', this.#options.clock.monotonic() - startedAt);
          await this.#options.bus.publish([
            {
              sessionId: identity.session.id,
              workspaceId: identity.session.workspaceId,
              type: 'model.failed',
              payload: {
                modelId,
                error: {
                  code: failure.code,
                  message: failure.message,
                  details: {},
                  occurredAt: this.#options.clock.now(),
                  retryable: failure.retryable,
                },
              },
            },
          ]);
          // `withRetry` honours a server-supplied `Retry-After` over its own
          // backoff — correct in general, but a model call is bound by the turn
          // deadline, so a provider that asks for a long wait must not be allowed
          // to park the whole turn. Clamp an oversized hint to the policy ceiling
          // before it reaches the retry loop; the failover chain is the better
          // answer to a model that needs minutes, not a multi-minute sleep here.
          if (
            failure.retryable &&
            failure.retryAfterSeconds !== undefined &&
            failure.retryAfterSeconds * 1000 > this.#modelRetry.maxDelayMs
          ) {
            throw new MaError({
              code: failure.code,
              category: failure.category,
              message: failure.message,
              retryable: true,
              retryAfterSeconds: Math.ceil(this.#modelRetry.maxDelayMs / 1000),
            });
          }
          throw failure;
        }
      },
      {
        policy: this.#modelRetry,
        clock: this.#options.clock,
        // Each in-place retry is observable, mirroring `ma_model_failover_total`.
        onRetry: () =>
          this.#options.metrics?.incrementCounter('ma_model_retries_total', { model: modelId }),
      },
    );
  }

  /**
   * Record model-call metrics. Labelled by model id (bounded — models are
   * catalogued and the caller already validated the id against the allowlist)
   * and outcome; never by session or workspace, which would be unbounded. A
   * no-op when no registry is configured.
   */
  #recordModelMetrics(
    modelId: string,
    outcome: 'ok' | 'error',
    durationMs: number,
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costMicros: number },
  ): void {
    const metrics = this.#options.metrics;
    if (!metrics) return;
    metrics.incrementCounter('ma_model_requests_total', { model: modelId, outcome });
    metrics.observeHistogram('ma_model_duration_seconds', durationMs / 1000, { model: modelId });
    if (usage) {
      metrics.incrementCounter('ma_model_tokens_total', { model: modelId, kind: 'input' }, usage.inputTokens);
      metrics.incrementCounter('ma_model_tokens_total', { model: modelId, kind: 'output' }, usage.outputTokens);
      metrics.incrementCounter('ma_model_tokens_total', { model: modelId, kind: 'cache_read' }, usage.cacheReadTokens);
      metrics.incrementCounter('ma_model_tokens_total', { model: modelId, kind: 'cache_write' }, usage.cacheWriteTokens);
      metrics.incrementCounter('ma_model_cost_micros_total', { model: modelId }, usage.costMicros);
    }
  }

  /**
   * Reflect a model's breaker state as a gauge (0 closed / 1 open / 2 half-open),
   * so an operator can see which model is shedding load and when it recovers.
   * A no-op when the breaker or the metrics registry is absent.
   */
  #recordBreakerState(modelId: string): void {
    if (!this.#breaker || !this.#options.metrics) return;
    const state: BreakerState = this.#breaker.stateOf(modelId);
    const value = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.#options.metrics.setGauge('ma_model_breaker_state', value, { model: modelId });
  }

  /** The pinned version's execution config, fetched by the sandbox at startup. */
  async bootstrap(
    identity: { sandboxId: string; session?: Session },
  ): Promise<SandboxBootstrap | { unbound: true }> {
    // A prewarmed sandbox boots before any session claims it: its only holder is
    // a synthetic `prewarm-*` id with no session row. Tell it so, so it boots
    // idle and waits for a `/rebind` rather than failing to start.
    if (!identity.session) return { unbound: true };
    const session = identity.session;
    const version = await this.#options.store.agentVersions.get(
      session.agentId,
      session.resolvedVersion,
    );
    if (!version) throw notFound('AgentVersion', String(session.resolvedVersion));

    const workspace = await this.#options.store.workspaces.get(session.workspaceId);

    // Only the memories a human allowed in. `injectable()` filters on that flag
    // rather than taking a parameter, so this call site cannot accidentally ask
    // for the agent-authored ones — those are reachable only through `recall`,
    // as tool output, which is a different trust position entirely.
    const remembered = this.#options.memories
      ? await this.#options.memories.injectable(
          session.workspaceId,
          session.agentId,
        )
      : [];

    // Identify which granted credentials are files (vs env/api-key), so the
    // sandbox knows to materialise them. Only id and name cross the wire — the
    // value is fetched later through the audited exchange, one at a time.
    const fileCredentials: { id: string; name: string }[] = [];
    // Non-file credentials (env_vars/api_key/bearer_token) are delivered on bind
    // too, by reference: a prewarmed/rebound sandbox never re-runs the driver's
    // provision() where these would otherwise be baked into the environment.
    const envCredentials: { id: string; name: string; type: string }[] = [];
    for (const credentialId of session.credentialIds) {
      const credential = await this.#options.store.credentials.get(credentialId);
      if (!credential) continue;
      if (credential.type === 'file' || credential.type === 'ssh_key') {
        fileCredentials.push({ id: credential.id, name: credential.name });
      } else {
        envCredentials.push({ id: credential.id, name: credential.name, type: credential.type });
      }
    }

    // The latest context snapshot the recovering sandbox will restore from.
    const snapshotRef =
      session.snapshotDigest === undefined
        ? undefined
        : {
            snapshotDigest: session.snapshotDigest,
            snapshotTurn: session.snapshotTurn ?? 0,
          };

    // Announce the resume from the control plane, not the sandbox: `session.*`
    // events assert something only the control plane can know, so the sandbox
    // event filter rejects them. Bootstrap is fetched exactly once per boot (the
    // agent-core client does not retry it), so this cannot double-emit. Only when
    // a snapshot is actually being handed over — a first boot is not a resume.
    if (snapshotRef) {
      await this.#options.bus.publish([
        {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          type: 'session.resumed',
          payload: {
            fromSeq: session.lastSeq,
            snapshotSeq: snapshotRef.snapshotTurn,
          },
        },
      ]);
    }

    return {
      sessionId: session.id,
      // Workspace policy is prepended, so an org-wide rule cannot be dropped by
      // an agent author who did not know about it. Memories come last: they are
      // context the agent accumulated, and should not displace the instructions
      // it was configured with.
      systemPrompt: [
        workspace?.systemPrompt,
        version.systemPrompt,
        formatMemories(remembered),
      ]
        .filter((part) => part && part.length > 0)
        .join('\n\n'),
      model: version.model,
      tools: version.tools,
      context: version.context,
      runtime: version.runtime,
      skills: version.skills,
      plugins: version.plugins,
      mcpServers: version.mcpServers,
      subAgents: version.subAgents,
      maxTurnsPerSession: version.maxTurnsPerSession,
      turnTimeoutSeconds: version.turnTimeoutSeconds,
      setupCommands: version.sandbox.setupCommands,
      // References only. Values are fetched one at a time through `exchange`,
      // each one audited.
      credentialIds: session.credentialIds,
      fileCredentials,
      envCredentials,
      datasetIds: version.datasetIds,
      // The latest context snapshot, when one exists. A recovering sandbox
      // fetches these bytes and restores instead of starting the conversation
      // over. Absent on a first boot, so the common path is unaffected.
      ...(snapshotRef ?? {}),
    };
  }
}

/**
 * A cheap, provider-agnostic estimate of a prompt's input tokens, for the
 * pre-call budget reservation only (never for billing — the provider's own count
 * is what `#completeWith` bills). Roughly four characters per token, plus a small
 * per-message and per-tool-call overhead, matching the runtime's own heuristic
 * closely enough to size a reservation. Deliberately an over-estimate on the safe
 * side: a reservation that is a little large refuses a near-cap call, never lets
 * one through.
 */
function estimatePromptTokens(
  messages: readonly { content: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] }[],
): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length + 8;
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length + JSON.stringify(call.arguments).length + 8;
    }
  }
  return Math.ceil(chars / 4);
}

/** Cost in micro-units, from the catalogue's per-million rates. */
function priceOf(
  model: { pricing: Record<string, number> },
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): number {
  const rate = (key: string): number => model.pricing[key] ?? 0;
  return Math.round(
    (usage.inputTokens * rate('inputMicrosPerMillion') +
      usage.outputTokens * rate('outputMicrosPerMillion') +
      usage.cacheReadTokens * rate('cacheReadMicrosPerMillion') +
      usage.cacheWriteTokens * rate('cacheWriteMicrosPerMillion')) /
      1_000_000,
  );
}

/**
 * Decode base64 strictly.
 *
 * `Buffer.from(x, 'base64')` silently discards anything that is not base64, so
 * a corrupted upload would be stored as whatever survived — under a digest of
 * those surviving bytes, which would then look entirely valid. Re-encoding and
 * comparing is the cheapest way to refuse that.
 */
function decodeBase64(content: string): Uint8Array {
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== content.replace(/=+$/, '')) {
    throw validationError('Artifact content must be valid base64');
  }
  return bytes;
}

/**
 * Render approved memories for the system prompt.
 *
 * Labelled rather than concatenated bare: the model should be able to tell
 * standing instructions from remembered facts, and an operator reading a
 * transcript should be able to tell which lines came from memory. Every entry
 * here has been through a human, so this is the one place memory text is
 * presented as instruction rather than as data.
 */
function formatMemories(memories: readonly { content: string }[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((memory) => `- ${memory.content}`).join('\n');
  return `Remembered context for this workspace:\n${lines}`;
}
