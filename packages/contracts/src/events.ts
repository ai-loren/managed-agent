/**
 * The event protocol.
 *
 * Session state is a fold over an append-only log. That single decision is what
 * makes resume, audit, replay and live streaming the *same* mechanism instead of
 * four subsystems that drift apart.
 *
 * Two invariants hold the design up:
 *
 *  1. **`seq` is gap-free and monotonic per session**, assigned under the same
 *     lock that appends the row. Resume is `fromSeq`, which is exact. The
 *     platform we studied cursored on millisecond timestamps, which cannot
 *     distinguish two events in the same millisecond — a resume there either
 *     replays or skips, with no third option.
 *  2. **`ts` is informational.** Never sort or cursor on it. Clocks skew.
 */

import {
  array,
  boolean,
  discriminatedUnion,
  enumOf,
  id,
  integer,
  literal,
  object,
  optional,
  record,
  string,
  timestamp,
  unknown,
  withDefault,
  type Infer,
  type Schema,
} from './schema.ts';
import { errorInfoSchema, usageSchema } from './entities.ts';

/** Usage is defaulted in payloads: a turn that used no tokens still reports zeros. */
const defaultedUsage = withDefault(usageSchema, () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
}));

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * The closed taxonomy. Namespaced by subject so a consumer can subscribe to
 * `tool.*` without enumerating members.
 *
 * The platform we studied exported exactly three types (`item.completed`,
 * `turn.ended`, `error`) and still listed full event production as roadmap. A
 * three-type log cannot answer "which commands did this agent run", which is
 * the question audit exists to answer.
 */
export const EVENT_TYPES = [
  // Session lifecycle
  'session.created',
  'session.queued',
  'session.ready',
  'session.resumed',
  'session.interrupted',
  'session.expired',
  'session.terminated',
  'session.failed',

  // Turn lifecycle — one prompt through to a final answer
  'turn.started',
  'turn.completed',
  'turn.failed',

  // Assistant output
  'message.delta',
  'message.completed',
  'thinking.delta',
  'thinking.completed',

  // Tool use
  'tool.requested',
  'tool.approved',
  'tool.denied',
  'tool.started',
  'tool.output',
  'tool.completed',
  'tool.failed',

  // Model calls
  'model.requested',
  'model.completed',
  'model.failed',

  // Context management
  'context.compacted',
  'context.snapshot',

  // Sandbox lifecycle, mirrored into the session log so one stream explains a run
  'sandbox.provisioning',
  'sandbox.bound',
  'sandbox.renewed',
  'sandbox.released',
  'sandbox.lost',

  // Artifacts the agent produced
  'artifact.created',
  'artifact.updated',

  // Security-relevant actions
  'audit.credential.accessed',
  'audit.permission.decided',

  // Stream control — synthesized by the bridge, never persisted
  'stream.lagged',
  'stream.heartbeat',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Events the bridge synthesizes for a live consumer; not part of the log. */
export const TRANSIENT_EVENT_TYPES: readonly EventType[] = ['stream.lagged', 'stream.heartbeat'];

export function isTransientEvent(type: EventType): boolean {
  return TRANSIENT_EVENT_TYPES.includes(type);
}

/**
 * The SSE wire contract, stated once because it has three implementations.
 *
 * The bridge writes this format; the SDK and the browser console each parse it
 * with their own loop — the console's script is an inlined string that runs in
 * a page and cannot import from a package, so the duplication is structural
 * rather than lazy. What follows is the part both readers must agree on.
 *
 * Three frame shapes go down the wire:
 *
 *  1. **A session event.** `id: <seq>`, `event: <type>`, `data: <the event>`.
 *     The only shape whose `data` is a `SessionEvent`, and the only one that
 *     may advance a resume cursor.
 *  2. **A heartbeat.** A bare `: comment` line with no `data:` at all, so a
 *     parser that keys on `data:` skips it naturally.
 *  3. **A stream notice**, currently only `stream.lagged`. It has `event:` and
 *     `data:` but deliberately **no `id:`** — a notice is metadata about the
 *     stream, not a position in it, and giving it an id rewinds a resuming
 *     browser onto an event it has already seen.
 *
 * Shape 3 is the one that bites. Both parsers assumed every `data:` frame was
 * an event: the SDK yielded an object with no `seq` to its caller and computed
 * `undefined + 1` for the cursor, and the console called
 * `event.type.startsWith(...)` on it and threw into a catch that discarded the
 * frame. Use `isStreamEvent` before treating a decoded frame as an event.
 */
export function isStreamEvent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { seq?: unknown; type?: unknown };
  return Number.isInteger(candidate.seq) && typeof candidate.type === 'string';
}

/** Terminal turn outcomes. */
export const TURN_END_REASONS = [
  'completed',
  'error',
  'interrupted',
  'cancelled',
  'max_turns',
  'context_exhausted',
] as const;
export type TurnEndReason = (typeof TURN_END_REASONS)[number];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const toolCallSchema = object({
  toolCallId: string({ minLength: 1, maxLength: 128 }),
  toolName: string({ minLength: 1, maxLength: 128 }),
  /** Arguments as the model produced them, before policy evaluation. */
  input: withDefault(record(unknown()), () => ({})),
});

const permissionDecisionSchema = object({
  decision: enumOf(['allow', 'deny', 'prompt'] as const),
  /** Which policy rule decided, so a denial is explainable. */
  rule: withDefault(string({ maxLength: 256 }), ''),
  reason: withDefault(string({ maxLength: 1000 }), ''),
});

/**
 * Payload schemas keyed by event type. Kept as a table so the validator, the
 * TypeScript union and the generated docs all read from one source.
 */
export const EVENT_PAYLOADS = {
  'session.created': object({
    agentId: id('agent'),
    resolvedVersion: integer({ min: 1 }),
    origin: string({ maxLength: 32 }),
  }),
  'session.queued': object({
    reason: withDefault(string({ maxLength: 256 }), ''),
    queuePosition: optional(integer({ min: 0 })),
  }),
  'session.ready': object({
    sandboxId: id('sandbox'),
    /** Milliseconds from creation to ready — the cold-start metric. */
    provisionMs: integer({ min: 0 }),
    reused: withDefault(boolean(), false),
  }),
  'session.resumed': object({
    fromSeq: integer({ min: 0 }),
    /** Snapshot the context was restored from, when one existed. */
    snapshotSeq: optional(integer({ min: 0 })),
  }),
  'session.interrupted': object({
    reason: withDefault(string({ maxLength: 256 }), ''),
    by: withDefault(string({ maxLength: 64 }), ''),
  }),
  'session.expired': object({ expiredAt: timestamp() }),
  'session.terminated': object({
    reason: withDefault(string({ maxLength: 256 }), ''),
    usage: defaultedUsage,
  }),
  'session.failed': object({ error: errorInfoSchema }),

  'turn.started': object({
    turn: integer({ min: 1 }),
    /** Redacted preview; the full prompt lives in the message item. */
    promptPreview: withDefault(string({ maxLength: 500 }), ''),
  }),
  'turn.completed': object({
    turn: integer({ min: 1 }),
    reason: enumOf(TURN_END_REASONS),
    durationMs: integer({ min: 0 }),
    usage: defaultedUsage,
  }),
  'turn.failed': object({
    turn: integer({ min: 1 }),
    error: errorInfoSchema,
  }),

  'message.delta': object({
    /** Incremental text. Consumers concatenate by `itemId`. */
    text: string(),
  }),
  'message.completed': object({
    role: enumOf(['user', 'assistant', 'system'] as const),
    text: string(),
  }),
  'thinking.delta': object({ text: string() }),
  'thinking.completed': object({ text: string() }),

  'tool.requested': toolCallSchema,
  'tool.approved': object({
    toolCallId: string({ maxLength: 128 }),
    decision: permissionDecisionSchema,
  }),
  'tool.denied': object({
    toolCallId: string({ maxLength: 128 }),
    decision: permissionDecisionSchema,
  }),
  'tool.started': object({ toolCallId: string({ maxLength: 128 }) }),
  'tool.output': object({
    toolCallId: string({ maxLength: 128 }),
    /** Incremental output for long-running tools. */
    chunk: string(),
    stream: withDefault(enumOf(['stdout', 'stderr'] as const), 'stdout' as const),
  }),
  'tool.completed': object({
    toolCallId: string({ maxLength: 128 }),
    durationMs: integer({ min: 0 }),
    /** Truncated result; large outputs become artifacts. */
    resultPreview: withDefault(string({ maxLength: 4000 }), ''),
    truncated: withDefault(boolean(), false),
  }),
  'tool.failed': object({
    toolCallId: string({ maxLength: 128 }),
    error: errorInfoSchema,
  }),

  'model.requested': object({
    modelId: string({ maxLength: 256 }),
    inputTokens: integer({ min: 0 }),
    /** Set when a fallback was used, naming what failed first. */
    fallbackFrom: optional(string({ maxLength: 256 })),
  }),
  'model.completed': object({
    modelId: string({ maxLength: 256 }),
    durationMs: integer({ min: 0 }),
    usage: defaultedUsage,
    stopReason: withDefault(string({ maxLength: 64 }), ''),
  }),
  'model.failed': object({
    modelId: string({ maxLength: 256 }),
    error: errorInfoSchema,
  }),

  'context.compacted': object({
    beforeTokens: integer({ min: 0 }),
    afterTokens: integer({ min: 0 }),
    turnsSummarized: integer({ min: 0 }),
    /** How compaction was chosen, for debugging context loss complaints. */
    strategy: withDefault(string({ maxLength: 64 }), 'summarize'),
  }),
  'context.snapshot': object({
    /** Content-addressed snapshot; a resume restores from this. */
    digest: string({ maxLength: 64 }),
    tokens: integer({ min: 0 }),
    turn: integer({ min: 0 }),
  }),

  'sandbox.provisioning': object({
    provider: string({ maxLength: 64 }),
    poolKey: string({ maxLength: 128 }),
  }),
  'sandbox.bound': object({
    sandboxId: id('sandbox'),
    provider: string({ maxLength: 64 }),
    reused: withDefault(boolean(), false),
  }),
  'sandbox.renewed': object({
    sandboxId: id('sandbox'),
    leaseExpiresAt: timestamp(),
  }),
  'sandbox.released': object({
    sandboxId: id('sandbox'),
    reason: withDefault(string({ maxLength: 256 }), ''),
  }),
  'sandbox.lost': object({
    sandboxId: id('sandbox'),
    /** True when the session can re-provision and continue. */
    recoverable: withDefault(boolean(), true),
    error: optional(errorInfoSchema),
  }),

  /**
   * A sandbox announcing a file it produced.
   *
   * Every field here is asserted by the sandbox, which is untrusted: `artifact.*`
   * is in the set a sandbox may append, so an agent can claim any path, size and
   * digest it likes. That is acceptable only because nothing reads these events
   * as fact — they are a notification for a watching client.
   *
   * When artifact *storage* is built, the row recording real bytes must be
   * written by the control plane from the bytes it received, with the digest
   * computed server-side. If a stored row were ever derived from this payload,
   * an agent could point a row at content it never uploaded. Keep the
   * announcement and the record separate.
   */
  'artifact.created': object({
    path: string({ maxLength: 1024 }),
    sizeBytes: integer({ min: 0 }),
    contentType: withDefault(string({ maxLength: 128 }), 'application/octet-stream'),
    digest: withDefault(string({ maxLength: 64 }), ''),
  }),
  'artifact.updated': object({
    path: string({ maxLength: 1024 }),
    sizeBytes: integer({ min: 0 }),
    digest: withDefault(string({ maxLength: 64 }), ''),
  }),

  'audit.credential.accessed': object({
    credentialId: id('credential'),
    /** Never the value — only which credential, by whom, for what. */
    purpose: withDefault(string({ maxLength: 256 }), ''),
  }),
  'audit.permission.decided': object({
    toolName: string({ maxLength: 128 }),
    decision: permissionDecisionSchema,
  }),

  'stream.lagged': object({
    /** Oldest seq still available; the consumer must re-read from here. */
    earliestSeq: integer({ min: 0 }),
    droppedCount: integer({ min: 0 }),
  }),
  'stream.heartbeat': object({ at: timestamp() }),
} as const satisfies Record<EventType, Schema<unknown>>;

export type EventPayloads = { [K in EventType]: Infer<(typeof EVENT_PAYLOADS)[K]> };

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * One envelope for every event, from every source. This uniformity is what lets
 * the SSE bridge, the audit reader and the state fold share one code path.
 */
export interface SessionEvent<K extends EventType = EventType> {
  /** Gap-free, monotonic per session. The ordering and resume authority. */
  seq: number;
  id: string;
  sessionId: string;
  workspaceId: string;
  /** Wall clock, informational only — never sort by this. */
  ts: number;
  type: K;
  /** The turn that produced it; absent for session-scoped events. */
  turn?: number;
  /** Groups deltas belonging to one logical item (a message, a tool call). */
  itemId?: string;
  payload: EventPayloads[K];
}

export const sessionEventSchema = object({
  seq: integer({ min: 0 }),
  id: id('event'),
  sessionId: id('session'),
  workspaceId: id('workspace'),
  ts: timestamp(),
  type: enumOf(EVENT_TYPES),
  turn: optional(integer({ min: 0 })),
  itemId: optional(string({ maxLength: 128 })),
  payload: unknown(),
});

/**
 * Validate an event's payload against the schema for its type.
 *
 * Deliberately separate from envelope validation: the envelope is written by us
 * and always well-formed, but payloads arriving from a sandbox are untrusted and
 * must be checked against the allowlist for the claimed type.
 */
export function validateEventPayload(
  type: EventType,
  payload: unknown,
): { ok: true; value: unknown } | { ok: false; issues: { path: string; message: string }[] } {
  const schema = EVENT_PAYLOADS[type] as Schema<unknown> | undefined;
  if (!schema) {
    return { ok: false, issues: [{ path: 'type', message: `unknown event type '${type}'` }] };
  }
  return schema.parse(payload, {}, []);
}

// ---------------------------------------------------------------------------
// Ingress — what a client may submit to drive a session
// ---------------------------------------------------------------------------

/**
 * The closed set of client-submitted events. Everything a caller can do to a
 * running session goes through this union, which keeps the ingress surface
 * small enough to audit.
 */
export const universalEventSchema = discriminatedUnion('type', {
  'user.message': object({
    type: literal('user.message'),
    text: string({ minLength: 1, maxLength: 500_000 }),
    /** Attachment references already uploaded to the session workspace. */
    attachments: withDefault(array(string({ maxLength: 1024 })), () => []),
  }),
  'user.interrupt': object({
    type: literal('user.interrupt'),
    reason: withDefault(string({ maxLength: 256 }), ''),
  }),
  /** Answers a `tool.requested` that policy routed to a human. */
  'user.tool_decision': object({
    type: literal('user.tool_decision'),
    toolCallId: string({ minLength: 1, maxLength: 128 }),
    decision: enumOf(['allow', 'deny'] as const),
    reason: withDefault(string({ maxLength: 1000 }), ''),
  }),
  'control.compact': object({
    type: literal('control.compact'),
    targetTokens: optional(integer({ min: 500 })),
  }),
  'control.snapshot': object({ type: literal('control.snapshot') }),
  'control.terminate': object({
    type: literal('control.terminate'),
    reason: withDefault(string({ maxLength: 256 }), ''),
  }),
});

export type UniversalEvent = Infer<typeof universalEventSchema>;

/** One submission: a batch of ingress events plus its idempotency key. */
export const submitEventsSchema = object({
  events: array(universalEventSchema, { minItems: 1, maxItems: 50 }),
  /**
   * Client-supplied dedupe key. A retry with the same key returns the original
   * outcome instead of submitting twice — the difference between a network
   * retry and a duplicate agent run.
   */
  idempotencyKey: optional(string({ minLength: 8, maxLength: 128 })),
});
export type SubmitEvents = Infer<typeof submitEventsSchema>;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const eventQuerySchema = object({
  /** Inclusive lower bound. Resume passes `lastSeen + 1`. */
  fromSeq: withDefault(integer({ min: 0 }), 0),
  /** Exclusive upper bound, for reading a closed range. */
  toSeq: optional(integer({ min: 0 })),
  limit: withDefault(integer({ min: 1, max: 1000 }), 200),
  /** Filter to specific types, or namespace prefixes like `tool.`. */
  types: withDefault(array(string({ maxLength: 64 })), () => []),
  turn: optional(integer({ min: 0 })),
  order: withDefault(enumOf(['asc', 'desc'] as const), 'asc' as const),
});
export type EventQuery = Infer<typeof eventQuerySchema>;

/** True when `type` matches a filter entry, supporting `namespace.` prefixes. */
export function matchesEventFilter(type: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => (filter.endsWith('.') ? type.startsWith(filter) : filter === type));
}
