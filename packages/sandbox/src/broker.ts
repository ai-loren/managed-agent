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
    // Order must not affect the key, or logically identical sets would miss.
    credentials: [...input.credentialIds].sort(),
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export interface AcquireRequest {
  session: Session;
  spec: SandboxSpec;
  /** Resolved environment. The broker never sees credential values elsewhere. */
  env: Record<string, string>;
  credentialIds: readonly string[];
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
  ): Promise<{ sandbox: Sandbox; runtimeToken: string }> {
    const driver = this.#driverFor(request.spec);
    const now = this.#clock.now();
    const id = newId('sandbox', now);
    const runtimeToken = randomToken(32);

    // Record the intent before calling the driver. If provisioning hangs or the
    // process dies mid-call, the reaper still finds the row and can clean up
    // the environment rather than leaking it.
    const pending = await this.#store.sandboxes.create({
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
      createdAt: now,
      updatedAt: now,
      createdBy: request.session.id,
    });

    try {
      const provisioned = await driver.provision({
        sandboxId: id,
        workspaceId: request.session.workspaceId,
        spec: request.spec,
        env: request.env,
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
   */
  async heartbeat(sandboxId: string): Promise<boolean> {
    const now = this.#clock.now();
    const renewed = await this.#store.sandboxes.renewLease(sandboxId, now + this.#leaseMs, now);
    return renewed !== undefined;
  }

  /**
   * Give a sandbox back.
   *
   * When reuse is enabled and other sessions still hold it, it stays `ready`
   * and returns to the pool; only the last holder drains it.
   */
  async release(sandboxId: string, sessionId: string, reason: string): Promise<void> {
    const sandbox = await this.#store.sandboxes.get(sandboxId);
    if (!sandbox) return;

    const remaining = sandbox.sessionIds.filter((id) => id !== sessionId);
    const now = this.#clock.now();

    if (remaining.length > 0 && sandbox.spec.allowReuse) {
      await this.#store.sandboxes.update(sandboxId, { sessionIds: remaining, updatedAt: now });
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
        // stops being considered for reuse.
        await this.#markLost(sandbox, 'no driver registered for this provider');
        reaped.push(sandbox.id);
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

      await this.#markLost(sandbox, `lease expired and the sandbox is ${health}`);
      await this.#destroy(sandbox, 'lease expired');
      reaped.push(sandbox.id);
    }

    return { reaped, recovered };
  }

  /**
   * Top up the warm pool.
   *
   * Prewarming trades idle cost for latency, so it is off unless configured.
   * Sessions that arrive during a cold start do not wait for the pool.
   */
  async prewarm(
    workspaceId: string,
    spec: SandboxSpec,
    credentialIds: readonly string[],
    env: Record<string, string>,
  ): Promise<number> {
    if (this.#prewarmPerPool <= 0) return 0;

    const poolKey = computePoolKey({ workspaceId, spec, credentialIds });
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
        // against a synthetic one and adopted on first claim.
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

  async #markLost(sandbox: Sandbox, message: string): Promise<void> {
    await this.#store.sandboxes.update(sandbox.id, {
      status: 'lost',
      error: {
        code: SANDBOX_ERROR_CODES.UNREACHABLE,
        message,
        details: {},
        occurredAt: this.#clock.now(),
        retryable: true,
      },
      updatedAt: this.#clock.now(),
    });
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
