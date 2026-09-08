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
  unauthenticated,
  type Clock,
  type Logger,
} from '@ma/core';
import {
  EVENT_TYPES,
  array,
  enumOf,
  integer,
  object,
  optional,
  parseOrThrow,
  string,
  unknown,
  withDefault,
  type EventType,
  type Session,
} from '@ma/contracts';
import type { Store } from '@ma/store';
import type { CredentialService, EventBus, SessionService } from '@ma/engine';

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

const completionSchema = object({
  modelId: string({ minLength: 1, maxLength: 256 }),
  messages: array(
    object({
      role: enumOf(['system', 'user', 'assistant', 'tool'] as const),
      content: string(),
      toolCallId: optional(string({ maxLength: 128 })),
    }),
    { minItems: 1 },
  ),
  tools: withDefault(array(unknown()), () => []),
  maxOutputTokens: optional(integer({ min: 1 })),
  temperature: optional(integer({ min: 0, max: 2 })),
});

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
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }>;
}

export interface RuntimeBridgeOptions {
  store: Store;
  clock: Clock;
  bus: EventBus;
  sessions: SessionService;
  credentials: CredentialService;
  models?: ModelProvider;
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

  constructor(options: RuntimeBridgeOptions) {
    this.#options = options;
  }

  /** Cache a token binding when this process provisions a sandbox. */
  bind(token: string, sessionId: string, sandboxId: string): void {
    this.#tokens.set(hashToken(token), { sessionId, sandboxId });
  }

  /** Forget a token when its sandbox is released. */
  unbind(token: string): void {
    this.#tokens.delete(hashToken(token));
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
    for (const event of parsed.events) {
      if (event.type !== 'turn.completed') continue;
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

    return {
      accepted: stored.length,
      lastSeq: stored[stored.length - 1]?.seq ?? identity.session.lastSeq,
    };
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
  async bootstrap(identity: RuntimeIdentity): Promise<unknown> {
    const version = await this.#options.store.agentVersions.get(
      identity.session.agentId,
      identity.session.resolvedVersion,
    );
    if (!version) throw notFound('AgentVersion', String(identity.session.resolvedVersion));

    const workspace = await this.#options.store.workspaces.get(identity.session.workspaceId);

    return {
      sessionId: identity.session.id,
      // Workspace policy is prepended, so an org-wide rule cannot be dropped by
      // an agent author who did not know about it.
      systemPrompt: [workspace?.systemPrompt, version.systemPrompt]
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
