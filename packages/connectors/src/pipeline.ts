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
  unavailable,
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
  /**
   * Absolute ceiling on how long the lease heartbeat keeps a single delivery
   * alive. A delivery that runs longer than this stops being renewed, so its
   * lease lapses and the reaper can zombie it — the backstop that keeps a
   * genuinely wedged delivery (e.g. a `/submit` that accepts the connection and
   * never answers) from renewing forever and pinning a worker invisibly.
   * Defaults to a generous multiple of the lease.
   */
  maxDeliverySeconds?: number;
  retry?: Partial<RetryPolicy>;
  /** How long to wait for a reply turn before giving up. */
  replyTimeoutMs?: number;
  /**
   * How long a delivery waits for a peer that won the provisioning race to bring
   * a freshly-created session live, and the poll interval. Bounded so a stuck
   * provision requeues the delivery rather than pinning the worker.
   */
  readyWaitMs?: number;
  readyPollMs?: number;
}

export interface DeliveryResult {
  status: 'accepted' | 'duplicate' | 'ignored' | 'rejected';
  receipt?: Receipt;
  /** Set when the adapter answered the request directly (a handshake). */
  immediateResponse?: { status: number; body: unknown };
  reason?: string;
}

const DEFAULT_LEASE_SECONDS = 120;

/**
 * How long a delivery waits for a peer that won the provisioning race to bring
 * the session live before giving up and requeuing the delivery, and how often it
 * re-checks. Bounded so a genuinely stuck provision cannot pin the worker; a
 * timeout requeues rather than fails, since the session will be live by then.
 */
const READY_WAIT_MS = 30_000;
const READY_POLL_MS = 100;
/**
 * How long a delivery steps aside when its conversation already has one in
 * flight in this process. Short: the wait is only for the turn ahead of it.
 */
const CONVERSATION_BUSY_DELAY_MS = 1_000;

export class DeliveryPipeline {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #adapters: AdapterRegistry;
  readonly #sessions: SessionService;
  readonly #credentials: CredentialService;
  readonly #logger: Logger | undefined;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #maxDeliveryMs: number;
  readonly #retry: RetryPolicy;
  readonly #bus: EventBus | undefined;
  readonly #replyTimeoutMs: number;
  readonly #readyWaitMs: number;
  readonly #readyPollMs: number;
  /** Conversations (see `#conversationOf`) with a delivery in flight here. */
  readonly #busyConversations = new Set<string>();

  constructor(options: PipelineOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#adapters = options.adapters;
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#bus = options.bus;
    this.#replyTimeoutMs = options.replyTimeoutMs ?? 120_000;
    this.#readyWaitMs = options.readyWaitMs ?? READY_WAIT_MS;
    this.#readyPollMs = options.readyPollMs ?? READY_POLL_MS;
    this.#logger = options.logger;
    this.#leaseMs = (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    // Heartbeat at half the lease, so one missed beat still lands a renewal
    // before expiry. Floored at 1s so a tiny lease cannot spin the loop.
    this.#heartbeatMs = Math.max(1_000, Math.floor(this.#leaseMs / 2));
    // Default the delivery ceiling to a wide multiple of the lease — long enough
    // that no honest delivery (cold provision + submit + retries) is cut off,
    // short enough that a hung one still lapses within an operational window.
    // Clamp above both the lease and one heartbeat interval so a misconfigured
    // tiny ceiling can never starve a healthy delivery of its first renewal: the
    // first beat fires at `#heartbeatMs`, so the ceiling must sit beyond it, or
    // the lease would lapse under a running delivery even though nothing is wrong.
    const configuredMaxMs =
      (options.maxDeliverySeconds ?? (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 10) * 1000;
    this.#maxDeliveryMs = Math.max(this.#leaseMs, this.#heartbeatMs, configuredMaxMs);
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
   * rather than spin. Safe to call concurrently: deliveries to different
   * conversations run side by side, while one whose conversation already has a
   * delivery in flight here steps aside, so a conversation's events reach its
   * session one at a time and in order.
   */
  async processNext(): Promise<boolean> {
    const now = this.#clock.now();
    const receipt = await this.#store.receipts.claimNext(now, now + this.#leaseMs);
    if (!receipt) return false;

    const conversation = await this.#conversationOf(receipt);
    if (conversation !== undefined) {
      if (this.#busyConversations.has(conversation)) {
        await this.#stepAside(receipt);
        return true;
      }
      this.#busyConversations.add(conversation);
    }
    try {
      await this.#run(receipt);
    } finally {
      if (conversation !== undefined) this.#busyConversations.delete(conversation);
    }
    return true;
  }

  /**
   * The conversation a delivery joins: the reused session it will be submitted
   * to, keyed before that session is known. A `new_per_event` delivery (or a
   * scoped one with no scope) gets a session of its own, so it joins none.
   */
  async #conversationOf(receipt: Receipt): Promise<string | undefined> {
    const connector = await this.#store.connectors.get(receipt.connectorId);
    if (!connector) return undefined;
    if (connector.sessionPolicy === 'reuse_per_scope' && receipt.bindingId) return `binding:${receipt.bindingId}`;
    if (connector.sessionPolicy === 'reuse_connector') return `connector:${connector.id}`;
    return undefined;
  }

  /**
   * Hand a claimed receipt back for later, as if it had never been claimed:
   * its conversation is busy, which is not an attempt and must not use one up.
   */
  async #stepAside(receipt: Receipt): Promise<void> {
    const now = this.#clock.now();
    const attempt = receipt.attempt - 1;
    const returned = await this.#store.receipts.compareAndSetStatus(receipt.id, 'working', {
      status: 'pending',
      attempt,
      nextAttemptAt: now + CONVERSATION_BUSY_DELAY_MS,
      leaseExpiresAt: undefined,
      ...(attempt === 0 ? { startedAt: undefined } : {}),
      updatedAt: now,
    });
    if (!returned) this.#logReaped(receipt, 'pending');
  }

  async #run(receipt: Receipt): Promise<void> {

    // Keep the lease ahead of the reaper for as long as the delivery is
    // actually running. `claimNext` leases `#leaseMs` (120s default), but
    // `#deliver` holds the `working` receipt across a cold sandbox provision
    // (k8s/container cold starts can exceed that) plus the submit — and agent
    // turns routinely run longer still. Without renewal, `reapZombies` promotes
    // the *live* delivery to `zombie`; the delivery's own succeed-CAS then loses
    // (logged as reaped though it ran), and an operator `retry` of that
    // false-zombie double-runs the same external event. The heartbeat settles
    // itself the moment the receipt leaves `working` (the succeed/fail CAS, or a
    // genuine reap), and is torn down here so a truly dead worker still lapses.
    const heartbeat = this.#startLeaseHeartbeat(receipt.id);
    try {
      await this.#deliver(receipt);
    } catch (error) {
      await this.reportFailure(receipt, error);
    } finally {
      await heartbeat.stop();
    }
  }

  /**
   * Renew a claimed receipt's lease in the background while it is delivered.
   *
   * Runs detached (not awaited by `#deliver`) so it renews *during* the slow
   * provision/submit rather than after. Renews at half the lease, so one missed
   * beat still lands a renewal before expiry. A `renewLease` that returns
   * `undefined` means the receipt is no longer `working` — settled or already
   * reaped — so the loop stops rather than fighting a terminal state. `stop`
   * aborts the pending sleep and awaits the loop, so no timer leaks and a
   * process that stops delivering lets the lease lapse as the reaper expects.
   *
   * Two failure modes are deliberately guarded, both flagged in review:
   *   - A transient `renewLease` throw (SQLITE_BUSY under write contention, a
   *     closed handle during shutdown) is caught and the loop retries on the
   *     next beat rather than unwinding. Unwinding would (a) surface as an
   *     unhandled rejection — the loop's rejection has no handler until `stop`
   *     runs in the caller's `finally` — and (b) permanently stop renewing, so
   *     the lease lapses and the reaper zombies the *live* delivery: the exact
   *     double-run this renewal exists to prevent, reintroduced by one hiccup.
   *   - An unbounded delivery. Without a ceiling, a wedged delivery (a `/submit`
   *     that accepts the socket and never answers) would renew forever and never
   *     be reaped — strictly worse than the pre-renewal behaviour, where the
   *     lease lapsed and the stuck receipt became a visible, retryable `zombie`.
   *     After `#maxDeliveryMs` the loop stops renewing, so the lease lapses and
   *     the reaper reclaims it.
   */
  #startLeaseHeartbeat(receiptId: string): { stop: () => Promise<void> } {
    const controller = new AbortController();
    const intervalMs = this.#heartbeatMs;
    const renewUntil = this.#clock.monotonic() + this.#maxDeliveryMs;
    const loop = (async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          await this.#clock.sleep(intervalMs, controller.signal);
        } catch {
          return; // aborted — the delivery finished
        }
        if (this.#clock.monotonic() >= renewUntil) {
          // Delivery has run past its ceiling: stop renewing so the lease lapses
          // and the reaper can zombie a genuinely stuck delivery.
          this.#logger?.warn('delivery exceeded its renewal ceiling; letting the lease lapse', {
            receiptId,
          });
          return;
        }
        const now = this.#clock.now();
        try {
          const renewed = await this.#store.receipts.renewLease(receiptId, now + this.#leaseMs, now);
          if (!renewed) return; // no longer ours (settled or reaped) — stop renewing
        } catch (error) {
          // A transient store error must not unwind the loop: retry next beat.
          // Renewals run at half the lease, so a single missed beat still leaves
          // a full half-lease of headroom before the reaper could act.
          this.#logger?.warn('failed to renew a delivery lease; will retry next beat', {
            receiptId,
            error,
          });
        }
      }
    })();
    // The loop is detached, so guard against an escaped rejection surfacing as an
    // unhandledRejection before `stop` attaches its own handler. Errors inside
    // the loop are already handled above; this covers only a defect in the loop
    // itself.
    loop.catch(() => {});
    return {
      stop: async (): Promise<void> => {
        controller.abort();
        await loop.catch(() => {});
      },
    };
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
    const { id: sessionId, created } = await this.#resolveSession(connector, binding, auth);
    const session = { id: sessionId };

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
    // Named here, before submitting, so the listener knows which turn is ours
    // the moment it starts.
    const submissionId = newId('submission', this.#clock.now());
    const replyWaiter = wantsReply ? this.#listenForReply(session.id, submissionId) : undefined;

    // The trigger's events were normalized at accept time and summarized onto
    // the receipt; the prompt is reconstructed from the summary so the delivery
    // stays replayable without keeping raw payloads.
    try {
      await this.#sessions.submit(auth, session.id, {
        events: [{ type: 'user.message', text: receipt.payloadSummary }],
        submissionId,
      });
    } catch (error) {
      // A subscription opened before submit must not leak when submit throws;
      // the failure propagates to reportFailure as before.
      replyWaiter?.close();
      // A session we created *for this delivery* was just provisioned and holds a
      // sandbox. If the submit failed, nothing else references it, so release it
      // now rather than waiting for the TTL reaper — otherwise every failed
      // new-session delivery orphans a sandbox for hours. A *reused* session is
      // shared and may be mid-turn, so it is never torn down here.
      if (created) {
        try {
          const live = await this.#store.sessions.get(session.id);
          if (live) await this.#sessions.shutdown(live, 'connector delivery failed', {
            type: 'session.terminated',
            payload: { reason: 'connector delivery failed', usage: live.usage },
          });
        } catch (releaseError) {
          this.#logger?.warn('failed to release a session after a failed delivery', {
            sessionId: session.id,
            error: releaseError,
          });
        }
      }
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
   * Begin listening for the reply to one submission, bounded by a timeout.
   *
   * Returns immediately with a `promise` that resolves to the assistant text (or
   * `undefined` on timeout / a turn that produced no message) and a `close` to
   * abandon the wait. The subscription is live the moment this returns, so the
   * caller can open it *before* submitting and not race a fast turn.
   *
   * Correlation is by identity. The session may be reused, so other turns —
   * another delivery's, a person's typed into the same session — can start and
   * finish on it while this one waits; capturing whichever assistant message
   * comes next would post that turn's answer to this connector's destination.
   * The submission is named before it is sent, the sandbox echoes the name on
   * the `turn.started` of the turn it runs, and only that turn's messages are
   * this reply. No ordering between submit returning and turn events is
   * assumed: an earlier attempt that keyed on it was wrong under ordinary
   * event-loop scheduling.
   *
   * A runtime that predates submission ids names no submission. For one of
   * those the first such `turn.started` after subscribing is taken as ours,
   * which holds because `processNext` sends one delivery at a time to a
   * conversation.
   */
  #listenForReply(
    sessionId: string,
    submissionId: string,
  ): {
    promise: Promise<string | undefined>;
    close: () => void;
  } {
    const bus = this.#bus;
    if (!bus) {
      return { promise: Promise.resolve(undefined), close: () => {} };
    }

    let latest: string | undefined;
    // The turn this delivery started, learned from the first `turn.started` we
    // see. Until it is set nothing is captured — that is what keeps a prior turn's
    // tail (whose `turn.started` fired before we subscribed) out of this reply.
    let myTurn: number | undefined;
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
      types: ['turn.started', 'message.completed', 'turn.completed', 'turn.failed'],
      onEvent: (event) => {
        if (settled) return;
        if (event.type === 'turn.started') {
          // Once armed, stay armed: a self-loop re-report must not move us.
          if (myTurn !== undefined) return;
          const started = event.payload as { turn?: number; submissionId?: string };
          if (started.submissionId === submissionId || started.submissionId === undefined) {
            myTurn = started.turn ?? event.turn;
          }
          return;
        }
        // Nothing counts until our turn has started.
        if (myTurn === undefined) return;
        if (event.type === 'message.completed') {
          const payload = event.payload as { role?: string; text?: string };
          if (payload.role === 'assistant') latest = payload.text ?? '';
        } else if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          // Correlate by turn number: only our turn's end settles the wait.
          if ((event.turn ?? (event.payload as { turn?: number }).turn) === myTurn) finish(latest);
        }
      },
    });

    // A clock-driven deadline, so a session that never completes a turn does not
    // leak a subscription forever.
    void this.#clock.sleep(this.#replyTimeoutMs).then(() => finish(latest));

    // Abandoning the wait sends nothing — a close is "give up", not "here is the
    // reply", so it must never hand back a half-captured message.
    return { promise, close: () => finish(undefined) };
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
  ): Promise<{ id: string; created: boolean }> {
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
      if (found) return { id: found, created: false };
    }

    if (connector.sessionPolicy === 'reuse_connector') {
      const recent = await this.#store.sessions.list({
        workspaceId: connector.workspaceId,
        agentId: connector.agentId!,
        // Scope to *this* connector's own sessions. Without it the lookup matched
        // any live session for the agent — a human's chat, or another connector's
        // conversation — and would inject this connector's inbound event into it
        // and post the reply out to this connector's external destination: a
        // cross-conversation and cross-destination leak.
        connectorId: connector.id,
        statuses: ['ready', 'running', 'idle'],
        limit: 1,
        order: 'desc',
      });
      const found = await reusable(recent.items[0]?.id);
      if (found) return { id: found, created: false };
    }

    const created = await this.#sessions.create(auth, {
      agentId: connector.agentId!,
      title: binding?.scopeLabel ?? connector.name,
      origin: connector.type === 'schedule' ? 'schedule' : 'connector',
      // Stamp the creating connector so reuse/reply/running-run checks stay scoped
      // to this connector rather than reaching across to another's sessions.
      connectorId: connector.id,
    });

    // `create` leaves the session `queued`; `submit` (the caller's next step)
    // refuses anything that is not `ready`. The scheduler provisions queued
    // sessions on its own tick, but a delivery submits synchronously, right now —
    // so without provisioning here every default `new_per_event` delivery would
    // throw INVALID_STATE_TRANSITION and fail permanently. Bring it to `ready`
    // before returning, so the session this method hands back is always live.
    return { id: await this.#ready(created.id), created: true };
  }

  /**
   * Provision a freshly-created session to `ready`, tolerating the race with a
   * scheduler (or another replica) that may provision the same queued session on
   * its tick.
   *
   * The subtlety is the *lost* race. `start` compare-and-sets `queued →
   * provisioning`, and the winner then runs the slow `provision()`. If a peer
   * wins, our `start` throws `conflict` and, on re-read, the row is still
   * `provisioning` — the peer is mid-flight, not done. Treating that as failure
   * would permanently fail the delivery (a non-retryable `conflict`) while the
   * peer's session ends up `ready` with a sandbox and no prompt. So on a lost
   * race we *wait* for the in-flight peer to land the session in a live state,
   * bounded so a genuinely stuck provision cannot block the worker forever.
   */
  async #ready(sessionId: string): Promise<string> {
    try {
      const started = await this.#sessions.start(sessionId);
      return started.id;
    } catch (error) {
      return this.#awaitReady(sessionId, error);
    }
  }

  /** States that can still reach `ready` — someone is bringing the session up. */
  static readonly #IN_FLIGHT: readonly string[] = ['queued', 'provisioning', 'terminating'];
  static readonly #LIVE: readonly string[] = ['ready', 'running', 'idle'];

  /**
   * After a lost `start`, wait (bounded) for whoever won to bring the session to
   * a live state. Rethrows the original error if the session is already live-less
   * and terminal, or if the wait elapses without it becoming live.
   */
  async #awaitReady(sessionId: string, startError: unknown): Promise<string> {
    const deadline = this.#clock.monotonic() + this.#readyWaitMs;
    for (;;) {
      const current = await this.#store.sessions.get(sessionId);
      if (current && DeliveryPipeline.#LIVE.includes(current.status)) {
        return current.id;
      }
      // Terminal without ever going live (a genuine provisioning failure the peer
      // recorded), or the session vanished: surface the real reason to retry
      // logic rather than spinning.
      if (!current || !DeliveryPipeline.#IN_FLIGHT.includes(current.status)) {
        throw startError;
      }
      if (this.#clock.monotonic() >= deadline) {
        // The peer is taking too long. Fail retryably so the delivery is
        // requeued rather than lost — the session will be live by the retry.
        throw unavailable('Session provisioning did not complete in time', 1);
      }
      await this.#clock.sleep(this.#readyPollMs);
    }
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
      // Compare-and-set on `working`, not a raw update: `findExpiredLeases` read
      // these as `working`, but the original worker can settle one
      // (succeeded/failed) between that read and this write. An unguarded update
      // would overwrite a terminal state with `zombie` — a state-machine
      // violation and a lie (a delivery that actually succeeded recorded as
      // abandoned). If the CAS loses, the worker won; leave its outcome alone.
      const reapedReceipt = await this.#store.receipts.compareAndSetStatus(receipt.id, 'working', {
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
      if (reapedReceipt) reaped.push(receipt.id);
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
    try {
      return await this.#store.bindings.create({
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
    } catch (error) {
      // Two inbound deliveries for the *same brand-new scope* (a new chat thread,
      // or the same external event the source retried fast) both read no binding
      // above and both reach `create`; the loser hits the
      // `UNIQUE (connector_id, scope_key_hash)` constraint and `insert` throws a
      // `conflict`. That is a lost race on a get-or-create, not a delivery
      // failure: converge on the winner rather than letting a raw 409 escape
      // `accept()` *before* the receipt exists — which would drop the delivery
      // and break the "every delivery has a receipt" guarantee for the first
      // event on a new scope. Mirrors the OIDC `#federate` first-login race and
      // the receipt `createIfAbsent` dedup. Re-read; only a genuine non-conflict
      // error (or a still-absent row) propagates.
      if (MaError.from(error).category === 'conflict') {
        const raced = await this.#store.bindings.findByScope(connector.id, scopeKeyHash);
        if (raced) return raced;
      }
      throw error;
    }
  }

  async #resolveSecret(connector: Connector): Promise<string | undefined> {
    if (!connector.secretCredentialId) return undefined;
    // Re-check the credential belongs to this connector's workspace at the point of
    // use, not only where it was bound. The create/patch routes gate the binding,
    // but this unseal is where the secret is actually decrypted, and the unseal's
    // AAD is the credential's own id — so it would succeed for a foreign-workspace
    // credential id regardless. Enforcing the tenant scope here means a pre-existing
    // or future row that slipped a foreign id past the entry-point check still
    // cannot be decrypted cross-tenant (defense in depth: gate every path to the
    // secret, not just the writers).
    const credential = await this.#store.credentials.get(connector.secretCredentialId);
    if (!credential || credential.workspaceId !== connector.workspaceId) return undefined;
    // Liveness, checked on the entity BEFORE decrypting: a revoked/expired
    // signing key must stop authenticating inbound traffic. Pre-check with the
    // non-throwing predicate and treat an unusable secret as none (the adapter
    // fails closed), rather than catching the throw — that would also swallow a
    // classified MaError from unseal itself (a missing KEK, an AAD/tamper
    // failure), which must propagate loudly instead of looking like "no secret".
    if (!this.#credentials.isUsable(credential)) {
      this.#logger?.warn('connector signing credential is unusable; rejecting delivery', {
        connectorId: connector.id,
        credentialId: connector.secretCredentialId,
        status: credential.status,
      });
      return undefined;
    }
    const sealed = await this.#store.credentials.getSealed(connector.secretCredentialId);
    if (!sealed) return undefined;
    // Verification needs the plaintext, and this is the one place a connector
    // secret is unsealed. It never leaves this call.
    return this.#credentials.unsealForConnector(credential, sealed);
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
