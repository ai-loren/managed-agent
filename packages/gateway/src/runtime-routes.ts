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
    const identity = await authenticate(context);
    return { status: 200, body: await bridge.bootstrap(identity) };
  });

  /** Append events to this sandbox's own session log. */
  router.post(`${PREFIX}/events`, async (context) => {
    const identity = await authenticate(context);
    return { status: 202, body: await bridge.appendEvents(identity, context.body) };
  });

  /**
   * Renew the sandbox lease.
   *
   * A `200` with `alive: false` rather than an error, because "you have been
   * reaped" is a normal answer the runtime must act on, not an exception.
   */
  router.post(`${PREFIX}/heartbeat`, async (context) => {
    const identity = await authenticate(context);
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
}
