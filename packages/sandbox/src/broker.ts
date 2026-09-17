/**
 * The sandbox broker.
 *
 * Owns four things a session should not have to think about:
 *
 *  - **Pool keys.** A hash of everything that must be identical for two
 *    sessions to safely share an environment. Reuse is decided by this value
 *    and nothing else, which makes the isolation boundary inspectable rather
 *    than an emergent property of broker code.
 *  - **Leases.** A sandbox is held, not owned. It keeps its lease alive by
 *    heartbeating; a lapse means lost, and lost is recoverable.
 *  - **Placement.** Try a warm sandbox, then prewarm, then cold start.
 *  - **Failure classification.** "No capacity" and "your image does not exist"
 *    are different problems for the user, so they get different codes.
 */

import { createHash } from 'node:crypto';

import {
  MaError,
  newId,
  notFound,
  hashToken,
  randomToken,
  type Clock,
  type Logger,
} from '@ma/core';
import type { Sandbox, SandboxSpec, Session } from '@ma/contracts';
import type { Store } from '@ma/store';

import { SANDBOX_ERROR_CODES, type SandboxDriver } from './driver.ts';

export interface BrokerOptions {
  store: Store;
  clock: Clock;
  drivers: SandboxDriver[];
  /** Driver used when a spec does not name one. */
  defaultDriver?: string;
  logger?: Logger;
  /** How long a lease lasts before a missed heartbeat means loss. */
  leaseSeconds?: number;
  /** Base URL the sandbox calls back on. */
  controlPlaneUrl?: string;
  /** Idle sandboxes to keep warm per pool key. */
  prewarmPerPool?: number;
}

const DEFAULT_LEASE_SECONDS = 120;

/**
 * Everything that must match for two sessions to share a sandbox.
 *
 * Credentials are in the key because a warm sandbox already holds resolved
 * secrets in its environment; handing it to a session with a different
 * credential set would leak them. Setup commands are in it because they may
 * have mutated the filesystem in ways the next session must not inherit.
 */
export interface PoolKeyInput {
  workspaceId: string;
  spec: SandboxSpec;
  credentialIds: readonly string[];
  /**
   * An opaque digest of the credentials' *values* (not just their ids), so a
   * rotated secret gets a distinct pool key and cannot reuse a warm sandbox that
   * baked in the pre-rotation value. Left undefined when no credentials are in
   * play; `JSON.stringify` drops the field then, so existing keys are unchanged.
   */
  credentialFingerprint?: string;
}

export function computePoolKey(input: PoolKeyInput): string {
  const material = JSON.stringify({
    workspaceId: input.workspaceId,
    image: input.spec.image,
    cpu: input.spec.cpu,
    memoryMb: input.spec.memoryMb,
    diskMb: input.spec.diskMb,
    network: input.spec.network,
    setup: input.spec.setupCommands,
    // In the key, not just checked at acquire time. The acquire path tests the
    // *requester's* `allowReuse`, so without this a session that permits reuse
    // could claim a sandbox created by one that forbade it — the two shared a
    // key, and `claimFromPool` filters only on key, status and lease. A spec
    // saying "do not share this environment" has to change its identity, or it
    // is only a request that the next caller happens to honour.
    allowReuse: input.spec.allowReuse,
    // In the key for the same reason as credentials and setup: a reused warm
    // sandbox keeps its mounted volumes, so two sessions can only safely share
    // one when they mount exactly the same set. Order-normalized so a reordered
    // list is the same identity.
    mounts: [...input.spec.mounts]
      .map((m) => ({ name: m.name, target: m.target, readOnly: m.readOnly }))
      .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
    // In the key for the same reason as mounts: a reused warm sandbox keeps the
    // identity it was provisioned with (on k8s, a ServiceAccount bound to a cloud
    // IAM role), so a session asking for one identity must not claim a sandbox
    // running as another — that would let it act with credentials it never got.
    runAs: input.spec.runAs,
    // Order must not affect the key, or logically identical sets would miss.
    credentials: [...input.credentialIds].sort(),
    // The *values* behind those ids. A rotated credential keeps its id but gets
    // a new value; without this a warm sandbox still holding the old secret in
    // its env would be reused, and the agent would run with the pre-rotation
    // value for the warm window. A different fingerprint forces a cold start
    // with the freshly-resolved value. Undefined (no credentials) is omitted.
    credentialFingerprint: input.credentialFingerprint,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export interface AcquireRequest {
  session: Session;
  spec: SandboxSpec;
  /** Resolved environment. The broker never sees credential values elsewhere. */
  env: Record<string, string>;
  /**
   * Platform-generated credential env (`MA_CRED_<NAME>` secrets), kept separate
   * from `env` because it is trusted: the driver delivers it without sanitizing,
   * so it must never carry a credential-*supplied* key. See `ProvisionRequest`.
   */
  credentialEnv?: Record<string, string>;
  credentialIds: readonly string[];
  /** See `PoolKeyInput.credentialFingerprint`. Threaded through to the pool key. */
  credentialFingerprint?: string;
}

export interface AcquireResult {
  sandbox: Sandbox;
  reused: boolean;
  provisionMs: number;
  /** The sandbox's callback token. Returned once and never stored in the clear. */
  runtimeToken: string;
}

export class SandboxBroker {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #drivers = new Map<string, SandboxDriver>();
  readonly #defaultDriver: string;
  readonly #logger: Logger | undefined;
  readonly #leaseMs: number;
  readonly #controlPlaneUrl: string;
  readonly #prewarmPerPool: number;

  constructor(options: BrokerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#leaseMs = (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    this.#controlPlaneUrl = options.controlPlaneUrl ?? 'http://127.0.0.1:8080';
    this.#prewarmPerPool = options.prewarmPerPool ?? 0;

    for (const driver of options.drivers) this.#drivers.set(driver.name, driver);
    const fallback = options.defaultDriver ?? options.drivers[0]?.name;
    if (!fallback) throw new Error('A broker needs at least one driver');
    this.#defaultDriver = fallback;
  }

  /**
   * Get a sandbox for a session: reuse a warm one, or start a cold one.
   *
   * The reuse path is a single atomic claim in the store, so two sessions
   * racing for the last warm sandbox cannot both believe they own it.
   */
  async acquire(request: AcquireRequest): Promise<AcquireResult> {
    const startedAt = this.#clock.monotonic();
    const poolKey = computePoolKey({
      workspaceId: request.session.workspaceId,
      spec: request.spec,
      credentialIds: request.credentialIds,
      credentialFingerprint: request.credentialFingerprint,
    });

    if (request.spec.allowReuse) {
      const warm = await this.#store.sandboxes.claimFromPool(
        poolKey,
        request.session.id,
        this.#clock.now(),
      );
      if (warm) {
        this.#logger?.info('reused a warm sandbox', {
          sandboxId: warm.id,
          sessionId: request.session.id,
          poolKey,
        });
        return {
          sandbox: warm,
          reused: true,
          provisionMs: this.#clock.monotonic() - startedAt,
          // A reused sandbox already holds a valid token from its first start.
          runtimeToken: '',
        };
      }
    }

    const sandbox = await this.#provisionCold(request, poolKey);
    return {
      sandbox: sandbox.sandbox,
      reused: false,
      provisionMs: this.#clock.monotonic() - startedAt,
      runtimeToken: sandbox.runtimeToken,
    };
  }

  async #provisionCold(
    request: AcquireRequest,
    poolKey: string,
    idle = false,
  ): Promise<{ sandbox: Sandbox; runtimeToken: string }> {
    const driver = this.#driverFor(request.spec);
    const now = this.#clock.now();
    const id = newId('sandbox', now);
    const runtimeToken = randomToken(32);

    // `maxSandboxes` is enforced here, where a sandbox is actually created.
    // Checking it only at session admission — as the quota service does — left
    // it unenforced in practice: a workspace could hold as many sandboxes as it
    // had sessions, because nothing consulted the cap on this path at all.
    //
    // The workspace is re-read rather than passed in, so a limit lowered while
    // sessions are queued takes effect on the next provision.
    const workspace = await this.#store.workspaces.get(request.session.workspaceId);
    const maxSandboxes = workspace?.quota.maxSandboxes ?? Infinity;

    // Record the intent before calling the driver. If provisioning hangs or the
    // process dies mid-call, the reaper still finds the row and can clean up
    // the environment rather than leaking it.
    const pending = await this.#store.sandboxes.createWithinLimit({
      id,
      workspaceId: request.session.workspaceId,
      provider: driver.name,
      status: 'pending',
      endpoint: '',
      spec: request.spec,
      poolKey,
      sessionIds: [request.session.id],
      leaseExpiresAt: now + this.#leaseMs,
      providerRef: '',
      // Persisted so the sandbox can authenticate from any control-plane
      // process, and still after a restart. Only the hash — the token itself
      // goes to the sandbox and nowhere else.
      runtimeTokenHash: hashToken(runtimeToken),
      createdAt: now,
      updatedAt: now,
      createdBy: request.session.id,
    }, maxSandboxes);

    if (!pending) {
      throw new MaError({
        code: SANDBOX_ERROR_CODES.QUOTA_EXCEEDED,
        category: 'quota',
        message: `This workspace already holds its maximum of ${maxSandboxes} sandboxes`,
        // Sandboxes are released continuously, so retrying is genuinely likely
        // to succeed.
        retryable: true,
        retryAfterSeconds: 30,
      });
    }

    try {
      const provisioned = await driver.provision({
        sandboxId: id,
        workspaceId: request.session.workspaceId,
        spec: request.spec,
        env: request.env,
        ...(request.credentialEnv ? { credentialEnv: request.credentialEnv } : {}),
        runtimeToken,
        controlPlaneUrl: this.#controlPlaneUrl,
      });

      const readyAt = this.#clock.now();
      const ready = await this.#store.sandboxes.update(id, {
        status: 'ready',
        endpoint: provisioned.endpoint,
        providerRef: provisioned.providerRef,
        leaseExpiresAt: readyAt + this.#leaseMs,
        lastHeartbeatAt: readyAt,
        // A prewarmed sandbox is born holderless and idle, so the idle reaper
        // collects it if no session ever claims it. A cold sandbox for a real
        // session is held, so it has no idle marker.
        ...(idle ? { idleSince: readyAt } : {}),
        updatedAt: readyAt,
      });
      return { sandbox: ready, runtimeToken };
    } catch (error) {
      const info = classify(error, this.#clock.now());
      await this.#store.sandboxes.update(id, {
        status: 'lost',
        error: info,
        updatedAt: this.#clock.now(),
      });
      this.#logger?.error('sandbox provisioning failed', {
        sandboxId: id,
        sessionId: request.session.id,
        code: info.code,
        error,
      });
      throw new MaError({
        code: info.code,
        // Capacity problems are worth retrying; a missing image is not.
        category: info.retryable ? 'unavailable' : 'internal',
        message: info.message,
        details: { sandboxId: pending.id },
        cause: error,
        retryable: info.retryable,
      });
    }
  }

  /**
   * Extend a lease in response to a heartbeat.
   *
   * Returns `false` when the sandbox was already reaped. The runtime treats
   * that as "stop working" — continuing in an environment the control plane has
   * written off would produce events for a session that has moved on.
   *
   * A held sandbox heartbeats for as long as its agent-core process runs, so its
   * lease never lapses and neither reaper collects it (the idle reaper only sees
   * holderless sandboxes; the lease reaper only sees expired leases). The hard
   * `maxLifetimeSeconds` ceiling is otherwise checked solely on the release path,
   * so a long-lived held session would outlive it forever. Refuse the renewal
   * once past the ceiling: the falsey return stops the runtime, the lease then
   * lapses, and `reapExpiredLeases` collects it. Either way the session recovers:
   * one idle between turns is re-queued from its snapshot, and one interrupted
   * mid-turn now re-queues too (`handleSandboxLost` — the interrupted turn is
   * closed with a synthetic `turn.failed` and the session resumes from its last
   * turn-boundary snapshot rather than failing the whole conversation).
   */
  async heartbeat(sandboxId: string): Promise<boolean> {
    const now = this.#clock.now();
    const sandbox = await this.#store.sandboxes.get(sandboxId);
    if (!sandbox) return false;
    if (this.#agedOut(sandbox, now)) {
      this.#logger?.info('refused a heartbeat past max lifetime', {
        sandboxId,
        poolKey: sandbox.poolKey,
      });
      return false;
    }
    const renewed = await this.#store.sandboxes.renewLease(sandboxId, now + this.#leaseMs, now);
    return renewed !== undefined;
  }

  /** A sandbox has lived past its spec's hard `maxLifetimeSeconds` ceiling. */
  #agedOut(sandbox: Sandbox, now: number): boolean {
    return now >= sandbox.createdAt + sandbox.spec.maxLifetimeSeconds * 1000;
  }

  /**
   * Give a sandbox back.
   *
   * When other sessions still hold it, it stays `ready` and returns to the
   * pool; only the last holder drains it.
   */
  async release(sandboxId: string, sessionId: string, reason: string): Promise<void> {
    const sandbox = await this.#store.sandboxes.get(sandboxId);
    if (!sandbox) return;

    const remaining = sandbox.sessionIds.filter((id) => id !== sessionId);
    const now = this.#clock.now();

    // Holders remaining means the environment is in use, full stop. This used
    // to be gated on `sandbox.spec.allowReuse` — read from the *stored* spec,
    // so a sandbox created with reuse disabled that had nonetheless been shared
    // took the destroy path while another session was still working in it.
    // Whatever put a second session here, tearing the environment out from
    // under it is never the right answer; the lease reaper collects it if the
    // remaining holders turn out to be dead.
    if (remaining.length > 0) {
      if (!sandbox.spec.allowReuse) {
        // Unreachable now that `allowReuse` is part of the pool key. If it ever
        // fires, the key is wrong and sessions are sharing an environment that
        // asked not to be shared — worth an operator's attention.
        this.#logger?.error('a non-shareable sandbox has multiple sessions', {
          sandboxId,
          sessionIds: sandbox.sessionIds,
        });
      }
      await this.#store.sandboxes.update(sandboxId, { sessionIds: remaining, updatedAt: now });
      return;
    }

    // Last holder gone. Keep the environment warm for the next session of the
    // same pool key when the spec opted into reuse and the sandbox is still
    // within its hard lifetime ceiling — the next `claimFromPool` adopts it and
    // the provisioner rebinds its agent-core process to the new session. A
    // sandbox left warm this way is holderless (`sessionIds: []`) and marked
    // `idleSince`, so the idle reaper tears it down if no one claims it in time.
    // Reuse-off specs, or one past its lifetime, take the original destroy path.
    // Shares the one `#agedOut` formula with the two reapers so the lifetime
    // ceiling cannot drift between the keep-warm and reaping decisions.
    const withinLifetime = !this.#agedOut(sandbox, now);
    if (sandbox.spec.allowReuse && withinLifetime) {
      await this.#store.sandboxes.update(sandboxId, {
        sessionIds: [],
        idleSince: now,
        updatedAt: now,
      });
      this.#logger?.info('kept a sandbox warm for reuse', { sandboxId, poolKey: sandbox.poolKey });
      return;
    }

    await this.#store.sandboxes.update(sandboxId, {
      status: 'draining',
      sessionIds: remaining,
      updatedAt: now,
    });
    await this.#destroy(sandbox, reason);
  }

  /**
   * Tear down sandboxes kept warm past their welcome.
   *
   * A warm, holderless sandbox keeps heartbeating (its agent-core process is
   * alive and awaiting a rebind), so its lease never lapses and
   * `reapExpiredLeases` would renew it forever rather than collect it. This is
   * the reaper for the warm pool: a sandbox is destroyed once it has sat idle
   * past its spec's `idleTimeoutSeconds`, or has lived past `maxLifetimeSeconds`
   * regardless of idleness. Returns the ids it reaped.
   */
  async reapIdleSandboxes(limit = 50): Promise<string[]> {
    const now = this.#clock.now();
    const idle = await this.#store.sandboxes.findIdle(now, limit);
    const reaped: string[] = [];

    for (const sandbox of idle) {
      const idleMs = sandbox.spec.idleTimeoutSeconds * 1000;
      const idledOut = sandbox.idleSince !== undefined && now >= sandbox.idleSince + idleMs;
      const agedOut = this.#agedOut(sandbox, now);
      if (!idledOut && !agedOut) continue;

      // CAS-drain on the observed `idle_since`: between `findIdle` above and here
      // a concurrent `claimFromPool` may have adopted this warm sandbox (an atomic
      // transaction that clears `idle_since` and adds the real holder). An
      // unguarded `update(...,{status:'draining'})` would then tear down an
      // environment a live session just took. `drainIfIdle` only flips
      // `ready -> draining` while `idle_since` is unchanged, so a claim that raced
      // in wins and we skip this one rather than destroying it.
      const drained = await this.#store.sandboxes.drainIfIdle(sandbox.id, sandbox.idleSince!, now);
      if (!drained) continue;
      await this.#destroy(sandbox, agedOut ? 'exceeded max lifetime' : 'idle timeout');
      reaped.push(sandbox.id);
    }

    return reaped;
  }

  /**
   * Destroy a sandbox that cannot serve the session that just claimed it.
   *
   * The rebind-failure path: the provisioner reused a warm sandbox, its
   * agent-core process refused to rebind, and the session must fall back to a
   * cold one. The failed sandbox is unconditionally torn down (not kept warm —
   * a process that would not rebind must not be offered again) and the claiming
   * session is dropped from its holders so the row is consistent before destroy.
   */
  async discard(sandboxId: string, sessionId: string, reason: string): Promise<void> {
    const sandbox = await this.#store.sandboxes.get(sandboxId);
    if (!sandbox) return;
    const remaining = sandbox.sessionIds.filter((id) => id !== sessionId);
    await this.#store.sandboxes.update(sandboxId, {
      status: 'draining',
      sessionIds: remaining,
      idleSince: undefined,
      updatedAt: this.#clock.now(),
    });
    await this.#destroy(sandbox, reason);
  }

  /**
   * Reclaim sandboxes whose lease lapsed.
   *
   * The driver is asked whether the environment is genuinely gone before it is
   * written off: a paused process or a slow heartbeat should not cost a user
   * their session when the sandbox is in fact still there.
   */
  async reapExpiredLeases(limit = 50): Promise<{ reaped: string[]; recovered: string[] }> {
    const now = this.#clock.now();
    const expired = await this.#store.sandboxes.findExpiredLeases(now, limit);
    const reaped: string[] = [];
    const recovered: string[] = [];

    for (const sandbox of expired) {
      const driver = this.#drivers.get(sandbox.provider);
      if (!driver) {
        // No driver means nothing can confirm or clean up; mark it lost so it
        // stops being considered for reuse. Guarded by the lease CAS like every
        // other reap path, so a heartbeat that renewed the lease since the
        // `findExpiredLeases` read still wins.
        if (await this.#markLostIfStale(sandbox, 'no driver registered for this provider')) {
          reaped.push(sandbox.id);
        }
        continue;
      }

      // Past the hard lifetime ceiling: reap it even if the driver would report
      // it healthy. The recovery branch below renews a still-alive sandbox's
      // lease, which for an aged-out one would resurrect what `heartbeat`
      // refused to keep alive — so this must be checked BEFORE the health probe.
      // A recoverable session is re-queued from its snapshot by `#markLostIfStale`.
      if (this.#agedOut(sandbox, now)) {
        if (await this.#markLostIfStale(sandbox, 'exceeded max lifetime')) {
          await this.#destroy(sandbox, 'exceeded max lifetime');
          reaped.push(sandbox.id);
        }
        continue;
      }

      let health: Awaited<ReturnType<SandboxDriver['health']>>;
      try {
        health = await driver.health(sandbox.providerRef);
      } catch {
        health = 'unreachable';
      }

      if (health === 'healthy') {
        // Alive but silent — extend once so a transient hiccup does not kill it.
        await this.#store.sandboxes.renewLease(sandbox.id, now + this.#leaseMs, now);
        recovered.push(sandbox.id);
        continue;
      }

      // Mark lost only if the lease is still the one `findExpiredLeases` observed.
      // The health probe above is an event-loop yield; a heartbeat that renewed
      // the lease during it (advancing `lease_expires_at` and keeping the runtime
      // executing) must win — the CAS returns undefined and we leave the live
      // sandbox alone rather than destroying a pod out from under a running turn.
      if (await this.#markLostIfStale(sandbox, `lease expired and the sandbox is ${health}`)) {
        await this.#destroy(sandbox, 'lease expired');
        reaped.push(sandbox.id);
      }
    }

    return { reaped, recovered };
  }

  /**
   * Top up the warm pool.
   *
   * Prewarming trades idle cost for latency, so it is off unless configured
   * (`MA_SANDBOX_PREWARM`, default 0). Sessions that arrive during a cold start
   * do not wait for the pool.
   *
   * Called on the reactive-prewarm path: `platform.release` tops the pool back
   * up after a session of an `allowReuse` version finishes, so a just-used pool
   * likely to be used again stays warm. It is deliberately NOT warmed on a timer
   * for workspaces with no traffic — that would resolve credentials for a session
   * that may never arrive, holding secrets in a sandbox nobody asked for.
   *
   * A prewarmed sandbox is provisioned with an empty environment — it is
   * materialised against a synthetic session before any real one exists — so its
   * credentials are delivered on bind instead: the `/rebind` bootstrap carries
   * every granted credential by reference, and agent-core materialises file
   * credentials as files and `env_vars`/`api_key`/`bearer_token` into the process
   * environment (same audited exchange, same trust split as cold provision). So a
   * non-file credential now reaches an agent that lands on a prewarmed sandbox.
   */
  async prewarm(
    workspaceId: string,
    spec: SandboxSpec,
    credentialIds: readonly string[],
    env: Record<string, string>,
    credentialFingerprint?: string,
  ): Promise<number> {
    if (this.#prewarmPerPool <= 0) return 0;

    const poolKey = computePoolKey({ workspaceId, spec, credentialIds, credentialFingerprint });
    const existing = await this.#store.sandboxes.list({
      workspaceId,
      poolKey,
      statuses: ['ready', 'pending'],
      limit: this.#prewarmPerPool + 1,
    });

    const missing = this.#prewarmPerPool - existing.items.length;
    let created = 0;
    for (let index = 0; index < missing; index++) {
      try {
        // A prewarmed sandbox belongs to no session yet, so it is provisioned
        // against a synthetic one and adopted on first claim. Marked idle at
        // birth so the reaper collects it if no session ever claims it.
        await this.#provisionCold(
          {
            session: {
              id: `prewarm-${poolKey}-${index}`,
              workspaceId,
            } as Session,
            spec,
            env,
            credentialIds,
          },
          poolKey,
          true,
        );
        created++;
      } catch (error) {
        this.#logger?.warn('prewarm failed', { poolKey, error });
        // A failed prewarm is not a user-visible failure; stop trying this round.
        break;
      }
    }
    return created;
  }

  /**
   * Mark a sandbox `lost`, but only if its lease is still the one the reaper
   * observed — a compare-and-set on `lease_expires_at`. Returns whether the CAS
   * won: `false` means a heartbeat renewed the lease (or another reaper claimed
   * it) since `findExpiredLeases`, so the caller must NOT destroy it — it is
   * provably alive again. See `markLostIfLeaseUnchanged` for why the raw update
   * this replaced could tear down a live, heartbeating sandbox mid-turn.
   */
  async #markLostIfStale(sandbox: Sandbox, message: string): Promise<boolean> {
    const marked = await this.#store.sandboxes.markLostIfLeaseUnchanged(
      sandbox.id,
      sandbox.leaseExpiresAt,
      {
        code: SANDBOX_ERROR_CODES.UNREACHABLE,
        message,
        details: {},
        occurredAt: this.#clock.now(),
        retryable: true,
      },
      this.#clock.now(),
    );
    return marked !== undefined;
  }

  async #destroy(sandbox: Sandbox, reason: string): Promise<void> {
    const driver = this.#drivers.get(sandbox.provider);
    if (!driver || !sandbox.providerRef) return;
    try {
      await driver.destroy(sandbox.providerRef, reason);
      await this.#store.sandboxes.update(sandbox.id, {
        status: 'released',
        releasedAt: this.#clock.now(),
        updatedAt: this.#clock.now(),
      });
    } catch (error) {
      // A failed destroy is logged rather than thrown: the caller is usually
      // shutting a session down and cannot act on it, and the reaper will try
      // again on the next pass.
      this.#logger?.error('sandbox destroy failed', { sandboxId: sandbox.id, error });
    }
  }

  #driverFor(spec: SandboxSpec): SandboxDriver {
    void spec;
    const driver = this.#drivers.get(this.#defaultDriver);
    if (!driver) throw notFound('SandboxDriver', this.#defaultDriver);
    return driver;
  }

  async close(): Promise<void> {
    for (const driver of this.#drivers.values()) await driver.close?.();
  }
}

/**
 * Turn a driver failure into a code a user can act on.
 *
 * The distinction that matters: retryable means "the same request might work
 * shortly" (capacity), and non-retryable means "this will fail identically
 * until you change something" (a missing image, a broken setup command).
 */
function classify(
  error: unknown,
  at: number,
): { code: string; message: string; details: Record<string, unknown>; occurredAt: number; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  let code: string = SANDBOX_ERROR_CODES.STARTUP_FAILED;
  let retryable = false;

  if (lower.includes('quota') || lower.includes('limit')) {
    code = SANDBOX_ERROR_CODES.QUOTA_EXCEEDED;
    retryable = true;
  } else if (lower.includes('no capacity') || lower.includes('placement') || lower.includes('schedul')) {
    code = SANDBOX_ERROR_CODES.PLACEMENT_FAILED;
    retryable = true;
  } else if (lower.includes('image') || lower.includes('not found') || lower.includes('enoent')) {
    code = SANDBOX_ERROR_CODES.IMAGE_UNAVAILABLE;
  } else if (lower.includes('setup') || lower.includes('exit code')) {
    code = SANDBOX_ERROR_CODES.SETUP_FAILED;
  } else if (lower.includes('timeout') || lower.includes('unreachable') || lower.includes('econnrefused')) {
    code = SANDBOX_ERROR_CODES.UNREACHABLE;
    retryable = true;
  }

  return { code, message, details: {}, occurredAt: at, retryable };
}
