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
  hashToken,
  notFound,
  permissionDenied,
  safeEqual,
  validationError,
  unauthenticated,
  type Clock,
  type Logger,
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
  type SandboxSpec,
  type Session,
} from '@ma/contracts';
import type { Store } from '@ma/store';
import type { CredentialService, EventBus, EventInput, SessionService } from '@ma/engine';

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

/** Identifies one turn of one session, for billing deduplication. */
function turnKey(identity: RuntimeIdentity, turn: number): string {
  return `${identity.session.id}:${turn}`;
}

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
  datasetIds: string[];
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
  /** Agent memory. Absent means a sandbox cannot remember or recall. */
  memories?: MemoryPort;
  /** Knowledge-base retrieval. Absent means a sandbox cannot search datasets. */
  retrieval?: DatasetSearchPort;
  logger?: Logger;
  /** Extends a sandbox lease on heartbeat. */
  renewLease(sandboxId: string): Promise<boolean>;
}

export class RuntimeBridge {
  readonly #options: RuntimeBridgeOptions;
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
  /**
   * Turns this bridge has already billed through `/completions`.
   *
   * An entry is removed as its `turn.completed` arrives. A turn cut short before
   * it reports — a sandbox crash, a reap — would otherwise leave its marker
   * forever, so `unbind` sweeps whatever remains for a session when the session
   * is released. The keys are short (`sessionId:turn`) precisely because a few
   * may linger between a crash and the release that reclaims them.
   */
  readonly #billedTurns = new Set<string>();

  constructor(options: RuntimeBridgeOptions) {
    this.#options = options;
  }

  /** Cache a token binding when this process provisions a sandbox. */
  bind(token: string, sessionId: string, sandboxId: string): void {
    this.#tokens.set(hashToken(token), { sessionId, sandboxId });
  }

  /** Forget a token when its sandbox is released. */
  unbind(token: string): void {
    const hashed = hashToken(token);
    const binding = this.#tokens.get(hashed);
    this.#tokens.delete(hashed);

    // Drop any billed-turn markers for this session. Normally each is removed as
    // its `turn.completed` arrives, but a turn cut short by a crash or a reap
    // never reports one — so without this the marker would live for the lifetime
    // of the process. Release is the session's definitive end, so it is the
    // right place to reclaim whatever leaked.
    if (binding) {
      const prefix = `${binding.sessionId}:`;
      for (const key of this.#billedTurns) {
        if (key.startsWith(prefix)) this.#billedTurns.delete(key);
      }
    }
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
    const binding = this.#tokens.get(hashed) ?? (await this.#bindingFromStore(hashed));
    if (!binding) throw unauthenticated('Unknown runtime token');

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
    // exploitable: `computePoolKey` includes the sorted credential set, so two
    // sessions can only share a sandbox when their grants are identical.
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
    // `#billedTurns` records which turns this bridge charged, so the answer is
    // per turn rather than per deployment.
    for (const event of parsed.events) {
      if (event.type !== 'turn.completed') continue;
      if (event.turn !== undefined && this.#billedTurns.delete(turnKey(identity, event.turn))) {
        continue;
      }
      const usage = (event.payload as { usage?: Record<string, number> }).usage;
      if (!usage) continue;
      await this.#options.sessions.recordUsage(identity.session.id, {
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
   * Extend the sandbox lease.
   *
   * A `false` answer means the control plane has written this sandbox off, and
   * the runtime should stop rather than keep working in an environment nobody
   * is watching.
   */
  async heartbeat(identity: RuntimeIdentity): Promise<{ alive: boolean; expiresAt?: number }> {
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

    const model = await this.#options.store.models.get(request.modelId);
    if (!model || !model.enabled) throw notFound('Model', request.modelId);
    if (
      model.allowedWorkspaceIds.length > 0 &&
      !model.allowedWorkspaceIds.includes(identity.session.workspaceId)
    ) {
      throw permissionDenied('use model', request.modelId);
    }

    const startedAt = this.#options.clock.monotonic();
    try {
      const result = await this.#options.models.complete({
        modelId: request.modelId,
        messages: request.messages,
        tools: request.tools,
        ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      });

      const costMicros = priceOf(model, result.usage);
      // Noted before recording, so the matching `turn.completed` knows this
      // turn is already billed and does not charge the workspace twice.
      if (request.turn !== undefined) this.#billedTurns.add(turnKey(identity, request.turn));
      await this.#options.sessions.recordUsage(identity.session.id, {
        ...result.usage,
        costMicros,
      });

      await this.#options.bus.publish([
        {
          sessionId: identity.session.id,
          workspaceId: identity.session.workspaceId,
          type: 'model.completed',
          payload: {
            modelId: request.modelId,
            durationMs: this.#options.clock.monotonic() - startedAt,
            usage: { ...result.usage, costMicros },
            stopReason: result.stopReason,
          },
        },
      ]);

      return { ...result, usage: { ...result.usage, costMicros } };
    } catch (error) {
      const failure = MaError.from(error);
      await this.#options.bus.publish([
        {
          sessionId: identity.session.id,
          workspaceId: identity.session.workspaceId,
          type: 'model.failed',
          payload: {
            modelId: request.modelId,
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
      throw failure;
    }
  }

  /** The pinned version's execution config, fetched by the sandbox at startup. */
  async bootstrap(identity: RuntimeIdentity): Promise<SandboxBootstrap> {
    const version = await this.#options.store.agentVersions.get(
      identity.session.agentId,
      identity.session.resolvedVersion,
    );
    if (!version) throw notFound('AgentVersion', String(identity.session.resolvedVersion));

    const workspace = await this.#options.store.workspaces.get(identity.session.workspaceId);

    // Only the memories a human allowed in. `injectable()` filters on that flag
    // rather than taking a parameter, so this call site cannot accidentally ask
    // for the agent-authored ones — those are reachable only through `recall`,
    // as tool output, which is a different trust position entirely.
    const remembered = this.#options.memories
      ? await this.#options.memories.injectable(
          identity.session.workspaceId,
          identity.session.agentId,
        )
      : [];

    return {
      sessionId: identity.session.id,
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
      skills: version.skills,
      plugins: version.plugins,
      mcpServers: version.mcpServers,
      subAgents: version.subAgents,
      maxTurnsPerSession: version.maxTurnsPerSession,
      turnTimeoutSeconds: version.turnTimeoutSeconds,
      setupCommands: version.sandbox.setupCommands,
      // References only. Values are fetched one at a time through `exchange`,
      // each one audited.
      credentialIds: identity.session.credentialIds,
      datasetIds: version.datasetIds,
    };
  }
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
