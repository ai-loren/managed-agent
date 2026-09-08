/**
 * Connector adapters.
 *
 * Every inbound integration — a webhook, a chat bot, a cron tick, an event
 * subscription — reduces to the same three questions, so the adapter answers
 * only those and the pipeline behind them is shared:
 *
 *  1. `verify` — is this request genuinely from who it claims?
 *  2. `normalize` — what session-facing prompt does it mean?
 *  3. `respond` — where does the answer go, if anywhere?
 *
 * Keeping adapters this thin is what stops one integration's assumptions from
 * leaking into the others. The platform we studied let a chat-specific
 * validation into the generic activation path, which permanently disabled
 * status transitions for every other connector type.
 */

import type { Connector, UniversalEvent } from '@ma/contracts';

/** A raw inbound request, before any interpretation. */
export interface InboundRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Exact bytes as received — signatures are computed over these. */
  rawBody: Buffer;
  /** Parsed JSON body when the content type said so. */
  body: unknown;
  query: URLSearchParams;
  sourceIp: string;
  receivedAt: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Why verification failed, for the operator. Never echoed to the caller. */
  reason?: string;
  /**
   * Some providers require an immediate echo to prove ownership of an endpoint
   * (a challenge/handshake). Returning a response here short-circuits the
   * pipeline without creating a receipt.
   */
  immediateResponse?: { status: number; body: unknown };
}

/** A verified inbound event, ready for the pipeline. */
export interface TriggerEvent {
  /**
   * Deduplication key from the source system. Two deliveries with the same id
   * on the same connector are one event, however many times it arrives.
   */
  externalEventId: string;
  /**
   * The external scope this belongs to — a chat id, a repository, a topic.
   * Hashed before storage, because a scope key can itself be sensitive.
   */
  scopeType: string;
  scopeKey: string;
  /** Human-readable label for operators. Must not contain sensitive values. */
  scopeLabel: string;
  /** What the agent is asked to do. */
  events: UniversalEvent[];
  /** Redacted summary kept on the receipt for debugging. */
  summary: string;
  /** Adapter-specific context needed by `respond`. */
  responseContext?: Record<string, unknown>;
}

export interface DeliveryOutcome {
  sessionId: string;
  /** Final assistant text, when the pipeline waited for one. */
  reply?: string;
  error?: { code: string; message: string };
}

export interface ConnectorAdapter {
  /** Matches `Connector.type`. */
  readonly type: string;

  /**
   * Authenticate the request.
   *
   * `secret` is the resolved value of the connector's secret credential, or
   * `undefined` when none is configured — which most adapters should treat as
   * a failure rather than an invitation to skip verification.
   */
  verify(request: InboundRequest, connector: Connector, secret?: string): Promise<VerifyResult>;

  /** Turn a verified request into a trigger, or `undefined` to ignore it. */
  normalize(request: InboundRequest, connector: Connector): Promise<TriggerEvent | undefined>;

  /**
   * Deliver the result back to the source system. Optional: a fire-and-forget
   * connector has nowhere to reply to.
   *
   * **Not currently called**, and the reason is structural rather than an
   * oversight. `outcome.reply` is the agent's answer, which does not exist when
   * a delivery completes: the pipeline hands a prompt to a session and returns,
   * because an agent turn can take minutes and a webhook caller cannot be held
   * open for it. Replying needs the pipeline to *wait* for a
   * `turn.completed` — a different delivery model, with its own timeout,
   * retry and partial-answer questions.
   *
   * The honest shapes are: subscribe to the session's event stream and reply
   * when a turn ends, or let the agent call a `reply` tool and send from there.
   * Both are real designs; neither is wiring. `docs/parity.md` records chat as
   * inbound-only rather than claiming a round trip that does not happen.
   */
  respond?(
    trigger: TriggerEvent,
    outcome: DeliveryOutcome,
    connector: Connector,
    secret?: string,
  ): Promise<void>;

  /**
   * Validate configuration before a connector is activated.
   *
   * Type-specific by construction: this is the seam that keeps one adapter's
   * requirements out of every other adapter's activation path.
   */
  validateConfig?(connector: Connector): Promise<void> | void;
}

/** Adapters by type. */
export class AdapterRegistry {
  readonly #adapters = new Map<string, ConnectorAdapter>();

  register(adapter: ConnectorAdapter): this {
    if (this.#adapters.has(adapter.type)) {
      throw new Error(`An adapter for '${adapter.type}' is already registered`);
    }
    this.#adapters.set(adapter.type, adapter);
    return this;
  }

  get(type: string): ConnectorAdapter | undefined {
    return this.#adapters.get(type);
  }

  types(): string[] {
    return [...this.#adapters.keys()];
  }
}
