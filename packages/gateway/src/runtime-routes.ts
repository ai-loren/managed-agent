/**
 * Runtime bridge routes.
 *
 * Registered separately from the main API because they authenticate
 * differently: a session-scoped runtime token rather than a principal's bearer
 * credential. Keeping them apart means the two auth models cannot be confused,
 * and the sandbox surface stays small enough to read in one sitting.
 */

import { unauthenticated } from '@ma/core';

import type { Router, RequestContext } from './router.ts';
import type { RuntimeBridge, RuntimeIdentity } from './runtime-bridge.ts';

const PREFIX = '/runtime/v1';

/** True for a path the bearer-token middleware must skip. */
export function isRuntimePath(path: string): boolean {
  return path.startsWith(`${PREFIX}/`);
}

function bearer(context: RequestContext): string {
  const header = context.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw unauthenticated('A runtime token is required');
  }
  return header.slice('Bearer '.length).trim();
}

export function registerRuntimeRoutes(router: Router, bridge: RuntimeBridge): void {
  const authenticate = (context: RequestContext): Promise<RuntimeIdentity> =>
    bridge.authenticate(bearer(context));

  /** Fetch the pinned configuration this sandbox should run. */
  router.get(`${PREFIX}/bootstrap`, async (context) => {
    // A prewarmed sandbox boots before any session claims it, so bootstrap
    // resolves the sandbox (not a required session) and may answer `unbound`.
    const identity = await bridge.authenticateSandbox(bearer(context));
    return { status: 200, body: await bridge.bootstrap(identity) };
  });

  /** Append events to this sandbox's own session log. */
  router.post(`${PREFIX}/events`, async (context) => {
    const identity = await authenticate(context);
    return { status: 202, body: await bridge.appendEvents(identity, context.body) };
  });

  /** Store a file this sandbox produced, so it outlives the sandbox. */
  router.post(`${PREFIX}/artifacts`, async (context) => {
    const identity = await authenticate(context);
    return { status: 201, body: await bridge.publishArtifact(identity, context.body) };
  });

  /** Persist a context snapshot, so a lost sandbox can resume this session. */
  router.post(`${PREFIX}/snapshots`, async (context) => {
    const identity = await authenticate(context);
    return { status: 201, body: await bridge.saveSnapshot(identity, context.body) };
  });

  /** Fetch this session's latest snapshot bytes, for a recovering sandbox. */
  router.get(`${PREFIX}/snapshots/:digest`, async (context) => {
    const identity = await authenticate(context);
    return { status: 200, body: await bridge.getSnapshot(identity, context.params.digest!) };
  });

  /** Record something this agent learned, for a later session to recall. */
  router.post(`${PREFIX}/memories`, async (context) => {
    const identity = await authenticate(context);
    return { status: 201, body: await bridge.remember(identity, context.body) };
  });

  /** Read back what this agent remembers. */
  router.get(`${PREFIX}/memories`, async (context) => {
    const identity = await authenticate(context);
    // A non-positive or non-integer limit falls back to the default rather than
    // reaching the service. A negative one is the dangerous case: it would
    // become an unbounded `LIMIT -1` in SQLite. The service and store clamp too,
    // but a bad query string should not silently mean "everything".
    const requested = Number(context.query.get('limit') ?? '20');
    const limit = Number.isInteger(requested) && requested > 0 ? requested : 20;
    return {
      status: 200,
      body: await bridge.recall(identity, limit),
    };
  });

  /**
   * Renew the sandbox lease.
   *
   * A `200` with `alive: false` rather than an error, because "you have been
   * reaped" is a normal answer the runtime must act on, not an exception.
   */
  router.post(`${PREFIX}/heartbeat`, async (context) => {
    // Heartbeat keeps even an unclaimed prewarmed sandbox's lease alive, so it
    // authenticates by sandbox rather than requiring a bound session.
    const identity = await bridge.authenticateSandbox(bearer(context));
    return { status: 200, body: await bridge.heartbeat(identity) };
  });

  /** Exchange a granted credential reference for its value. */
  router.post(`${PREFIX}/credentials/:credentialId`, async (context) => {
    const identity = await authenticate(context);
    const purpose =
      typeof (context.body as { purpose?: unknown })?.purpose === 'string'
        ? String((context.body as { purpose: string }).purpose)
        : '';
    const result = await bridge.exchangeCredential(
      identity,
      context.params.credentialId!,
      purpose,
    );
    return {
      status: 200,
      // A credential value must never sit in a proxy or browser cache.
      headers: { 'cache-control': 'no-store' },
      body: result,
    };
  });

  /** Call a model through the gateway, which holds the provider credential. */
  router.post(`${PREFIX}/completions`, async (context) => {
    const identity = await authenticate(context);
    return { status: 200, body: await bridge.complete(identity, context.body) };
  });

  /** Search the knowledge bases attached to this session's pinned version. */
  router.post(`${PREFIX}/search`, async (context) => {
    const identity = await authenticate(context);
    const body = (context.body ?? {}) as { query?: unknown; limit?: unknown };
    const query = typeof body.query === 'string' ? body.query : '';
    const requested = Number(body.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? requested : undefined;
    return { status: 200, body: await bridge.search(identity, query, limit) };
  });

  /** Download a capability artifact (skill/plugin) this version references. */
  router.get(`${PREFIX}/capabilities/:digest`, async (context) => {
    const identity = await authenticate(context);
    return { status: 200, body: await bridge.fetchCapability(identity, context.params.digest!) };
  });
}
