/**
 * The delivery pipeline.
 *
 * One path from "something happened outside" to "an agent is working on it",
 * shared by every adapter. What it guarantees:
 *
 *  - **Exactly one run per external event.** Source systems retry; the
 *    `(connector, externalEventId)` unique constraint means a retry returns the
 *    original receipt instead of starting a second agent.
 *  - **Every delivery has a receipt.** "What happened to that alert?" is
 *    answerable, including for the ones that failed.
 *  - **Work is leased, not just flagged.** A worker that dies mid-delivery
 *    leaves a lease that lapses, and the reaper can tell that apart from a
 *    worker that is merely slow.
 */

import {
  MaError,
  backoffDelay,
  newId,
  notFound,
  sha256Hex,
  type Clock,
  type Logger,
  type RetryPolicy,
} from '@ma/core';
import { connectorMachine, receiptMachine, type Binding, type Connector, type Receipt } from '@ma/contracts';
import type { Store } from '@ma/store';
import type { AuthContext, CredentialService, EventBus, SessionService } from '@ma/engine';

import type { AdapterRegistry, InboundRequest, TriggerEvent } from './adapter.ts';

export interface PipelineOptions {
  store: Store;
  clock: Clock;
  adapters: AdapterRegistry;
  sessions: SessionService;
  credentials: CredentialService;
  /**
   * Event bus, for connectors that reply. After a delivery, the pipeline waits
   * on the session's stream for the turn to complete and sends the answer back
   * through the adapter's `respond`. Absent means fire-and-forget only.
   */
  bus?: EventBus;
  logger?: Logger;
  /** How long a worker holds a receipt before the reaper calls it a zombie. */
  leaseSeconds?: number;
  retry?: Partial<RetryPolicy>;
  /** How long to wait for a reply turn before giving up. */
  replyTimeoutMs?: number;
}

export interface DeliveryResult {
  status: 'accepted' | 'duplicate' | 'ignored' | 'rejected';
  receipt?: Receipt;
  /** Set when the adapter answered the request directly (a handshake). */
  immediateResponse?: { status: number; body: unknown };
  reason?: string;
}

const DEFAULT_LEASE_SECONDS = 120;

export class DeliveryPipeline {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #adapters: AdapterRegistry;
  readonly #sessions: SessionService;
  readonly #credentials: CredentialService;
  readonly #logger: Logger | undefined;
  readonly #leaseMs: number;
  readonly #retry: RetryPolicy;
  readonly #bus: EventBus | undefined;
  readonly #replyTimeoutMs: number;

  constructor(options: PipelineOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#adapters = options.adapters;
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#bus = options.bus;
    this.#replyTimeoutMs = options.replyTimeoutMs ?? 120_000;
    this.#logger = options.logger;
    this.#leaseMs = (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    this.#retry = {
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 300_000,
      multiplier: 3,
      jitter: true,
      ...options.retry,
    };
  }

  /**
   * Accept an inbound request.
   *
   * Deliberately returns quickly: the receipt is created and the actual agent
   * run happens under a lease. A source system waiting on an HTTP response
   * should not be held open for the length of an agent turn.
   */
  async accept(
    workspaceId: string,
    externalKey: string,
    request: InboundRequest,
  ): Promise<DeliveryResult> {
    const connector = await this.#store.connectors.getByExternalKey(workspaceId, externalKey);
    if (!connector) throw notFound('Connector', `${workspaceId}/${externalKey}`);

    if (connector.status !== 'active') {
      // A disabled connector rejects rather than queueing: silently accumulating
      // work for something an operator turned off is a surprise nobody wants.
      return { status: 'rejected', reason: `Connector is ${connector.status}` };
    }

    const adapter = this.#adapters.get(connector.type);
    if (!adapter) return { status: 'rejected', reason: `No adapter for '${connector.type}'` };

    const secret = await this.#resolveSecret(connector);
    const verification = await adapter.verify(request, connector, secret);

    if (verification.immediateResponse) {
      // A provider handshake. No receipt: nothing was delivered.
      return { status: 'ignored', immediateResponse: verification.immediateResponse };
    }
    if (!verification.ok) {
      this.#logger?.warn('connector verification failed', {
        connectorId: connector.id,
        reason: verification.reason,
        sourceIp: request.sourceIp,
      });
      // The reason is logged but not returned: telling an unauthenticated
      // caller *why* their signature failed helps them fix it.
      return { status: 'rejected', reason: 'verification failed' };
    }

    const trigger = await adapter.normalize(request, connector);
    if (!trigger) return { status: 'ignored', reason: 'the adapter ignored this event' };

    const binding = await this.#resolveBinding(connector, trigger);

    const now = this.#clock.now();
    const { receipt, created } = await this.#store.receipts.createIfAbsent({
      id: newId('receipt', now),
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      ...(binding ? { bindingId: binding.id } : {}),
      externalEventId: trigger.externalEventId,
      status: 'pending',
      attempt: 0,
      maxAttempts: this.#retry.maxAttempts,
      payloadSummary: trigger.summary.slice(0, 4000),
      responseContext: normalizeResponseContext(trigger.responseContext),
      createdAt: now,
      updatedAt: now,
      createdBy: `connector:${connector.id}`,
    });

    if (!created) {
      // The source system retried. Its original delivery is already recorded,
      // and reporting that is more useful than pretending this is new.
      return { status: 'duplicate', receipt };
    }

    await this.#store.connectors.update(connector.id, { lastDeliveryAt: now, updatedAt: now });
    return { status: 'accepted', receipt };
  }

  /**
   * Run one due delivery.
   *
   * Returns `false` when there was nothing to do, so a worker loop can back off
   * rather than spin.
   */
  async processNext(): Promise<boolean> {
    const now = this.#clock.now();
    const receipt = await this.#store.receipts.claimNext(now, now + this.#leaseMs);
    if (!receipt) return false;

    try {
      await this.#deliver(receipt);
    } catch (error) {
      await this.reportFailure(receipt, error);
    }
    return true;
  }

  async #deliver(receipt: Receipt): Promise<void> {
    const connector = await this.#store.connectors.get(receipt.connectorId);
    if (!connector) throw notFound('Connector', receipt.connectorId);
    if (!connector.agentId) {
      throw new MaError({
        code: 'CONNECTOR_HAS_NO_AGENT',
        category: 'precondition',
        message: 'This connector is not bound to an agent',
      });
    }

    const binding = receipt.bindingId
      ? await this.#store.bindings.get(receipt.bindingId)
      : undefined;

    // Connectors act as themselves, not as whoever configured them: a webhook
    // firing at 3am should not carry a human's full authority.
    const auth = await this.#connectorAuth(connector);
    const session = await this.#resolveSession(connector, binding, auth);

    await this.#store.receipts.update(receipt.id, {
      sessionId: session.id,
      updatedAt: this.#clock.now(),
    });

    // Decide up front whether this delivery expects a reply, and if so start
    // listening *before* submitting the prompt. `submit` returns as soon as the
    // prompt is enqueued, not when the turn finishes, so a fast turn can emit
    // `turn.completed` before a subscription opened afterwards would exist —
    // subscribing first is the only way the reply is not occasionally missed.
    const adapter = this.#adapters.get(connector.type);
    const wantsReply =
      adapter?.respond !== undefined &&
      this.#bus !== undefined &&
      Object.keys(receipt.responseContext).length > 0;
    const replyWaiter = wantsReply ? this.#listenForReply(session.id) : undefined;

    // The trigger's events were normalized at accept time and summarized onto
    // the receipt; the prompt is reconstructed from the summary so the delivery
    // stays replayable without keeping raw payloads.
    try {
      await this.#sessions.submit(auth, session.id, {
        events: [{ type: 'user.message', text: receipt.payloadSummary }],
      });
    } catch (error) {
      // A subscription opened before submit must not leak when submit throws;
      // the failure propagates to reportFailure as before.
      replyWaiter?.close();
      throw error;
    }

    const completedAt = this.#clock.now();
    receiptMachine.assert(receipt.status === 'pending' ? 'working' : receipt.status, 'succeeded');
    // Guarded like the failure paths. The assert above validates against the
    // caller's in-memory copy, which is exactly the value that goes stale when
    // a slow worker is reaped mid-delivery — so it cannot see that the row is
    // now a terminal `zombie`.
    const settled = await this.#store.receipts.compareAndSetStatus(receipt.id, 'working', {
      status: 'succeeded',
      completedAt,
      leaseExpiresAt: undefined,
      updatedAt: completedAt,
    });
    if (!settled) {
      // The delivery did happen; the receipt just no longer belongs to us. The
      // binding update below is skipped so a reaped run cannot advance state
      // that a live one may be advancing too.
      replyWaiter?.close();
      this.#logReaped(receipt, 'succeeded');
      return;
    }

    if (binding) {
      await this.#store.bindings.update(binding.id, {
        lastDeliveryAt: completedAt,
        activeSessionId: session.id,
        updatedAt: completedAt,
      });
    }

    // Reply loop: if this connector can answer (its adapter implements
    // `respond`) and it recorded where to send, wait for the turn to produce an
    // assistant message and send it back. Best-effort and out of band — a reply
    // that fails or times out does not fail the delivery, which already
    // succeeded when the prompt was accepted. The receipt is already terminal
    // here, so no lease is held during the wait; the worker loop does block for
    // it, which is the throughput cost of the chosen wait-for-turn model.
    if (replyWaiter) {
      try {
        const reply = await replyWaiter.promise;
        if (reply !== undefined) {
          // The same secret verification uses, so an adapter that signs its
          // outbound post (a chat send, a hook callback) can authenticate.
          const secret = await this.#resolveSecret(connector);
          await adapter!.respond!(
            { responseContext: receipt.responseContext } as never,
            { sessionId: session.id, reply },
            connector,
            secret,
          );
        }
      } catch (error) {
        this.#logger?.warn('failed to deliver a connector reply', {
          receiptId: receipt.id,
          error,
        });
      }
    }
  }

  /**
   * Begin listening for a session's next assistant reply, bounded by a timeout.
   *
   * Returns immediately with a `promise` that resolves to the assistant text (or
   * `undefined` on timeout / a turn that produced no message) and a `close` to
   * abandon the wait. The subscription is live the moment this returns, so the
   * caller can open it *before* submitting and not race a fast turn.
   */
  #listenForReply(sessionId: string): { promise: Promise<string | undefined>; close: () => void } {
    const bus = this.#bus;
    if (!bus) return { promise: Promise.resolve(undefined), close: () => {} };

    let latest: string | undefined;
    let settled = false;
    let finish!: (value: string | undefined) => void;

    const promise = new Promise<string | undefined>((resolve) => {
      finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        subscription.close();
        resolve(value);
      };
    });

    const subscription = bus.subscribe({
      sessionId,
      types: ['message.completed', 'turn.completed', 'turn.failed'],
      onEvent: (event) => {
        if (settled) return;
        const payload = event.payload as { role?: string; text?: string };
        if (event.type === 'message.completed' && payload.role === 'assistant') {
          latest = payload.text ?? '';
        } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          finish(latest);
        }
      },
    });

    // A clock-driven deadline, so a session that never completes a turn does not
    // leak a subscription forever.
    void this.#clock.sleep(this.#replyTimeoutMs).then(() => finish(latest));

    return { promise, close: () => finish(latest) };
  }

  /**
   * Decide which session serves this delivery.
   *
   * `new_per_event` is the safe default — one event, one session, no shared
   * state. The reuse policies exist for conversational connectors where a chat
   * thread genuinely is one continuing conversation, and they fall back to a
   * new session whenever the remembered one is no longer usable.
   */
  async #resolveSession(
    connector: Connector,
    binding: Binding | undefined,
    auth: AuthContext,
  ): Promise<{ id: string }> {
    const reusable = async (sessionId: string | undefined): Promise<string | undefined> => {
      if (!sessionId) return undefined;
      const existing = await this.#store.sessions.get(sessionId);
      if (!existing) return undefined;
      // A finished session cannot take more work; start a fresh one instead of
      // failing the delivery.
      return ['ready', 'running', 'idle'].includes(existing.status) ? existing.id : undefined;
    };

    if (connector.sessionPolicy === 'reuse_per_scope' && binding) {
      const found = await reusable(binding.activeSessionId);
      if (found) return { id: found };
    }

    if (connector.sessionPolicy === 'reuse_connector') {
      const recent = await this.#store.sessions.list({
        workspaceId: connector.workspaceId,
        agentId: connector.agentId!,
        statuses: ['ready', 'running', 'idle'],
        limit: 1,
        order: 'desc',
      });
      const found = await reusable(recent.items[0]?.id);
      if (found) return { id: found };
    }

    const created = await this.#sessions.create(auth, {
      agentId: connector.agentId!,
      title: binding?.scopeLabel ?? connector.name,
      origin: connector.type === 'schedule' ? 'schedule' : 'connector',
    });
    return { id: created.id };
  }

  /**
   * Record a failure and schedule a retry, or give up.
   *
   * Non-retryable failures stop immediately: retrying a misconfigured connector
   * five times produces five identical errors and delays the operator noticing.
   *
   * Public so a test can drive the case that matters: a worker whose delivery
   * outlived its lease, reporting an outcome for a receipt the reaper has
   * already written off. That path is otherwise only reachable by timing.
   */
  async reportFailure(receipt: Receipt, error: unknown): Promise<void> {
    const failure = MaError.from(error);
    const now = this.#clock.now();
    const attempt = receipt.attempt;
    const exhausted = attempt >= receipt.maxAttempts;

    const info = {
      code: failure.code,
      message: failure.message,
      details: failure.details,
      occurredAt: now,
      retryable: failure.retryable,
    };

    if (exhausted || !failure.retryable) {
      const settled = await this.#store.receipts.compareAndSetStatus(receipt.id, 'working', {
        status: 'failed',
        error: info,
        completedAt: now,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });
      if (!settled) {
        this.#logReaped(receipt, 'failed');
        return;
      }
      this.#logger?.error('connector delivery failed', {
        receiptId: receipt.id,
        connectorId: receipt.connectorId,
        attempt,
        retryable: failure.retryable,
        code: failure.code,
      });
      return;
    }

    // Back to pending with a backoff. Jitter matters: many connectors failing
    // on the same downstream outage would otherwise retry in lockstep.
    //
    // Guarded on `working`, which is the whole point: a worker that outlived
    // its lease has already been reaped to `zombie`, and `zombie` is terminal.
    // A plain update here resurrected it to `pending`, so the same external
    // event was claimed and delivered a second time — breaking the exactly-once
    // guarantee this file opens by promising, and quietly making a terminal
    // state non-terminal.
    const delayMs = backoffDelay(attempt, this.#retry);
    const requeued = await this.#store.receipts.compareAndSetStatus(receipt.id, 'working', {
      status: 'pending',
      error: info,
      nextAttemptAt: now + delayMs,
      leaseExpiresAt: undefined,
      updatedAt: now,
    });
    if (!requeued) this.#logReaped(receipt, 'pending');
  }

  /**
   * Note that a worker's outcome was discarded because it lost its receipt.
   *
   * Not an error: the reaper did the right thing, and so did the worker. But an
   * operator seeing a zombie needs to know the work may in fact have completed.
   */
  #logReaped(receipt: Receipt, intended: string): void {
    this.#logger?.warn('discarded the outcome of a reaped delivery', {
      receiptId: receipt.id,
      connectorId: receipt.connectorId,
      intendedStatus: intended,
      attempt: receipt.attempt,
    });
  }

  /**
   * Promote abandoned deliveries to `zombie`.
   *
   * A `working` receipt whose lease lapsed means its worker died mid-delivery.
   * That is genuinely different from a failure — we do not know whether the
   * work happened — so it gets its own terminal state rather than being retried
   * blindly or reported as a clean failure.
   */
  async reapZombies(limit = 50): Promise<string[]> {
    const now = this.#clock.now();
    const abandoned = await this.#store.receipts.findExpiredLeases(now, limit);
    const reaped: string[] = [];

    for (const receipt of abandoned) {
      await this.#store.receipts.update(receipt.id, {
        status: 'zombie',
        error: {
          code: 'WORKER_ABANDONED',
          message: 'The worker holding this delivery stopped reporting',
          details: {},
          occurredAt: now,
          retryable: true,
        },
        completedAt: now,
        updatedAt: now,
      });
      reaped.push(receipt.id);
    }

    if (reaped.length > 0) {
      this.#logger?.warn('reaped abandoned deliveries', { count: reaped.length });
    }
    return reaped;
  }

  /**
   * Replay a failed or zombie delivery as a new receipt.
   *
   * A new row rather than reopening the old one: the original attempt happened
   * and its record should stay intact, and a retried delivery is a distinct
   * event in the audit trail.
   */
  async retry(receiptId: string, reason: string): Promise<Receipt> {
    const original = await this.#store.receipts.get(receiptId);
    if (!original) throw notFound('Receipt', receiptId);
    if (!receiptMachine.isTerminal(original.status)) {
      throw new MaError({
        code: 'RECEIPT_NOT_TERMINAL',
        category: 'conflict',
        message: `Cannot retry a receipt that is still ${original.status}`,
      });
    }

    const now = this.#clock.now();
    const { receipt } = await this.#store.receipts.createIfAbsent({
      ...original,
      id: newId('receipt', now),
      // A distinct event id, or the dedupe would hand back the original.
      externalEventId: `${original.externalEventId}:retry:${now}`,
      status: 'pending',
      attempt: 0,
      ...(original.sessionId === undefined ? {} : { sessionId: undefined }),
      nextAttemptAt: now,
      leaseExpiresAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      payloadSummary: `${original.payloadSummary}\n[replayed: ${reason}]`,
      createdAt: now,
      updatedAt: now,
    } as Receipt);

    return receipt;
  }

  /** Validate and activate a connector, using its own adapter's rules. */
  async activate(connectorId: string): Promise<Connector> {
    const connector = await this.#store.connectors.get(connectorId);
    if (!connector) throw notFound('Connector', connectorId);

    connectorMachine.assert(connector.status, 'active');

    if (!connector.agentId) {
      throw new MaError({
        code: 'CONNECTOR_HAS_NO_AGENT',
        category: 'precondition',
        message: 'A connector must target an agent before it can be activated',
      });
    }

    const adapter = this.#adapters.get(connector.type);
    if (!adapter) {
      throw new MaError({
        code: 'UNKNOWN_CONNECTOR_TYPE',
        category: 'validation',
        message: `No adapter is registered for '${connector.type}'`,
      });
    }

    // Type-specific validation, dispatched through the adapter. One
    // integration's requirements can never block another's activation.
    await adapter.validateConfig?.(connector);

    return this.#store.connectors.update(connectorId, {
      status: 'active',
      error: undefined,
      updatedAt: this.#clock.now(),
    });
  }

  async #resolveBinding(
    connector: Connector,
    trigger: TriggerEvent,
  ): Promise<Binding | undefined> {
    if (!trigger.scopeKey) return undefined;

    const scopeKeyHash = sha256Hex(`${connector.id}:${trigger.scopeKey}`);
    const existing = await this.#store.bindings.findByScope(connector.id, scopeKeyHash);
    if (existing) return existing;

    const now = this.#clock.now();
    return this.#store.bindings.create({
      id: newId('binding', now),
      connectorId: connector.id,
      workspaceId: connector.workspaceId,
      scopeType: trigger.scopeType,
      scopeKeyHash,
      scopeLabel: trigger.scopeLabel,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      createdBy: `connector:${connector.id}`,
    });
  }

  async #resolveSecret(connector: Connector): Promise<string | undefined> {
    if (!connector.secretCredentialId) return undefined;
    const sealed = await this.#store.credentials.getSealed(connector.secretCredentialId);
    if (!sealed) return undefined;
    // Verification needs the plaintext, and this is the one place a connector
    // secret is unsealed. It never leaves this call.
    return this.#credentials.unsealForConnector(connector.secretCredentialId, sealed);
  }

  /**
   * The identity a connector acts as.
   *
   * A connector is its own principal, so its actions are attributable to the
   * integration rather than to whoever happened to configure it, and revoking
   * an employee does not silently disable production automation.
   */
  async #connectorAuth(connector: Connector): Promise<AuthContext> {
    const principal = await this.#store.principals.get(connector.ownerPrincipalId);
    if (!principal) throw notFound('Principal', connector.ownerPrincipalId);
    return { principal, requestId: `connector:${connector.id}` };
  }
}

/**
 * Coerce a trigger's response context to the string map the receipt persists.
 *
 * A trigger may carry richer values; only string entries are kept, since the
 * stored shape is `Record<string,string>` (a channel id, a thread id — routing,
 * never a secret).
 */
function normalizeResponseContext(context: Record<string, unknown> | undefined): Record<string, string> {
  if (!context) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}
