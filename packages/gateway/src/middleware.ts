/**
 * Gateway middleware: authentication, idempotency, rate limiting and error
 * mapping.
 *
 * Ordering matters and is asserted by the server that composes these:
 * errors outermost (so everything below is caught), then request logging, then
 * rate limiting (cheap, before we do work), then authentication, then
 * idempotency (which needs to know who is asking).
 */

import { MaError, hashToken, safeEqual, sha256Hex, unauthenticated, type Clock, type Logger, type MetricsRegistry } from '@ma/core';
import type { Principal } from '@ma/contracts';
import type { Store } from '@ma/store';
import type { AuthContext } from '@ma/engine';

import type { HandlerResult, Middleware, RequestContext } from './router.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Turn any thrown value into an HTTP response.
 *
 * Outermost so nothing escapes as a bare stack trace. Internal errors are
 * logged in full and reported as a generic message with the request id: a
 * client learns enough to file a useful bug report and nothing about our
 * internals.
 */
export function errorMiddleware(logger: Logger): Middleware {
  return async (context, next) => {
    try {
      return await next(context);
    } catch (error) {
      const failure = MaError.from(error);
      const headers: Record<string, string> = { 'x-request-id': context.requestId };
      if (failure.retryAfterSeconds !== undefined) {
        headers['retry-after'] = String(failure.retryAfterSeconds);
      }

      if (failure.category === 'internal') {
        logger.error('unhandled error', {
          requestId: context.requestId,
          path: context.path,
          method: context.method,
          error: failure,
        });
        return {
          status: 500,
          headers,
          body: {
            error: {
              code: 'INTERNAL',
              category: 'internal',
              message: 'An internal error occurred',
              requestId: context.requestId,
              retryable: false,
            },
          },
        };
      }

      return {
        status: failure.status,
        headers,
        body: { error: { ...failure.toJSON(), requestId: context.requestId } },
      };
    }
  };
}

/** One structured log line per request, with its latency and outcome. */
export function loggingMiddleware(logger: Logger, clock: Clock): Middleware {
  return async (context, next) => {
    const startedAt = clock.monotonic();
    const result = await next(context);
    logger.info('request', {
      requestId: context.requestId,
      method: context.method,
      path: context.path,
      status: result?.status ?? 200,
      durationMs: clock.monotonic() - startedAt,
    });
    return result;
  };
}

// ---------------------------------------------------------------------------
// Metrics (RED: rate, errors, duration)
// ---------------------------------------------------------------------------

/**
 * Record request count, error count and latency per route and status.
 *
 * The label is the route *template* (`/v1/agents/:id`), not the concrete path,
 * or every id would be its own series and the cardinality would be unbounded.
 * The server sets `context.params` before dispatch, so the template is recovered
 * by replacing each param *value* in the path with `:name`. A request that
 * matched no route is bucketed as `<unmatched>` rather than labelled with its
 * arbitrary (attacker-chosen) path — the other cardinality hole.
 *
 * Recording is a map lookup and an add, and it happens after `next` returns, so
 * it never delays the response; a throw is impossible here (the registry never
 * throws), but even so the record runs in a finally-free straight line after the
 * result is in hand.
 */
export function metricsMiddleware(
  metrics: MetricsRegistry,
  clock: Clock,
  knownRoutes: () => ReadonlySet<string>,
): Middleware {
  return async (context, next) => {
    const startedAt = clock.monotonic();
    let status = 200;
    try {
      const result = await next(context);
      status = result?.status ?? 200;
      return result;
    } catch (error) {
      // The error middleware (outermost) maps this to a status; mirror its
      // mapping so the metric matches what the client receives, then re-throw.
      status = MaError.is(error) ? error.status : 500;
      throw error;
    } finally {
      const durationSeconds = (clock.monotonic() - startedAt) / 1000;
      const route = routeTemplate(context, knownRoutes());
      const labels = { method: context.method, route, status: String(status) };
      metrics.incrementCounter('http_requests_total', labels);
      if (status >= 500) {
        metrics.incrementCounter('http_request_errors_total', labels);
      }
      metrics.observeHistogram('http_request_duration_seconds', durationSeconds, {
        method: context.method,
        route,
      });
    }
  };
}

/**
 * The route template for a request, for a bounded metric label.
 *
 * Rebuilds `/v1/agents/:id` from the concrete `/v1/agents/ag_123` by swapping
 * each matched param value back to its `:name` (the server sets `context.params`
 * before dispatch). The result is checked against the set of registered route
 * templates: anything not in it — an unmatched 404 path, which is
 * attacker-controlled — collapses to `<unmatched>`, so a flood of distinct
 * unknown paths cannot explode the series count.
 */
function routeTemplate(context: RequestContext, knownRoutes: ReadonlySet<string>): string {
  const params = context.params;
  const paramNames = Object.keys(params);

  let candidate: string;
  if (paramNames.length === 0) {
    candidate = context.path;
  } else {
    // Replace each param value with :name. Values are matched by exact segment.
    const byValue = new Map(paramNames.map((name) => [params[name]!, name]));
    candidate = context.path
      .split('/')
      .map((segment) => {
        const name = byValue.get(segment);
        return name ? `:${name}` : segment;
      })
      .join('/');
  }

  // Only emit a label the router actually serves; everything else is one bucket.
  return knownRoutes.has(candidate) ? candidate : '<unmatched>';
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface AuthOptions {
  store: Store;
  clock: Clock;
  /** Paths that skip authentication entirely, e.g. health and webhooks. */
  publicPaths?: (path: string) => boolean;
  /**
   * Whether a proxy in front of this process rewrites `X-Forwarded-For`.
   *
   * Off by default, because the header is client-supplied otherwise and
   * `sourceIp` goes into the audit trail — a forged value there is a false
   * entry in a security record.
   */
  trustForwardedFor?: boolean;
}

/**
 * Resolve the caller from a bearer token.
 *
 * Only the hash of an API key is stored, so a database leak yields nothing
 * usable. The lookup is by hash, and the comparison that follows is
 * constant-time — a timing oracle on token equality is exactly the kind of bug
 * that survives review because the code "looks fine".
 */
export function authMiddleware(options: AuthOptions): Middleware {
  return async (context, next) => {
    if (options.publicPaths?.(context.path)) return next(context);

    const header = context.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw unauthenticated('A bearer token is required');
    }

    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) throw unauthenticated('A bearer token is required');

    const key = await options.store.apiKeys.getByHash(hashToken(token));
    if (!key) throw unauthenticated('Unknown API key');
    // Defence in depth: the hash lookup already matched, and this makes the
    // final equality check constant-time regardless.
    if (!safeEqual(key.tokenHash, hashToken(token))) throw unauthenticated('Unknown API key');

    const now = options.clock.now();
    if (key.revokedAt !== undefined) throw unauthenticated('This API key was revoked');
    if (key.expiresAt !== undefined && key.expiresAt <= now) {
      throw unauthenticated('This API key has expired');
    }

    const principal = await options.store.principals.get(key.principalId);
    if (!principal) throw unauthenticated('The principal for this key no longer exists');
    if (principal.disabled) throw unauthenticated('This principal is disabled');

    // Best-effort: a failed usage stamp must not fail the request. `update()`
    // resolves `this.patch(...)`, which runs the `UPDATE` SYNCHRONOUSLY as its
    // argument is evaluated — so a synchronous store throw (SQLITE_BUSY under
    // cross-replica WAL write-lock contention, or a not-found from a concurrent
    // key delete in the await window above) would escape BEFORE `.catch` is ever
    // attached and 500 an otherwise-valid authenticated request. A plain
    // `try/catch` only guards a synchronous throw; defer the call a microtask so
    // both the synchronous throw and any async rejection are swallowed.
    void Promise.resolve()
      .then(() => options.store.apiKeys.update(key.id, { lastUsedAt: now }))
      .catch(() => {});

    const auth: AuthContext = {
      principal,
      scopes: key.scopes,
      apiKeyId: key.id,
      requestId: context.requestId,
      sourceIp: clientIp(context, options.trustForwardedFor ?? false),
    };
    return next({ ...context, auth });
  };
}

/** The authenticated caller, or a 401 if the route was reached without one. */
export function requireAuth(context: RequestContext): AuthContext {
  if (!context.auth) throw unauthenticated();
  return context.auth as AuthContext;
}

/**
 * The caller's address.
 *
 * `X-Forwarded-For` is set by the client unless a proxy overwrites it, so it is
 * only consulted when the deployment says a proxy is in front — otherwise any
 * caller could put any address in the audit trail, and rotate it to evade the
 * rate limiter. The socket address is the only value nobody can choose for
 * themselves, so it is the default and the fallback.
 *
 * Even when trusted, the header is read from the RIGHT, not the left. A proxy
 * *appends* the peer it saw (`nginx $proxy_add_x_forwarded_for`, AWS ALB,
 * Envoy), so a client that sends `X-Forwarded-For: 9.9.9.9` produces
 * `9.9.9.9, <real-client>` — the leftmost entry is attacker-chosen, the
 * rightmost is what the one trusted hop actually observed. Taking the leftmost
 * would let a caller forge the audit-trail `sourceIp` and pick which rate-limit
 * bucket it lands in (evade its own, or poison another address's). This assumes
 * a single trusted proxy; a deeper chain would need a configured trusted-hop
 * depth, but "one hop, take the last" is correct for the deployments this serves
 * and never trusts a client-supplied entry.
 */
function clientIp(context: RequestContext, trustForwardedFor = false): string {
  if (trustForwardedFor) {
    const forwarded = context.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const hops = forwarded.split(',');
      const rightmost = hops[hops.length - 1]!.trim();
      if (rightmost.length > 0) return rightmost;
    }
  }
  return context.raw.req.socket.remoteAddress ?? '';
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  store: Store;
  clock: Clock;
  /** Retention window a *completed* record replays for. */
  ttlMs?: number;
  /**
   * The short in-flight lease a fresh reservation holds before `complete`.
   * Distinct from `ttlMs`: an abandoned reservation (a hard crash between
   * reserve and complete/release) self-heals once this lapses, rather than
   * returning a misleading "in flight" 409 for the whole retention window. Must
   * exceed the longest a keyed handler legitimately runs, or a slow-but-live
   * request could be reclaimed and its side effect executed twice. Keyed
   * mutations here are fast control-plane writes (session create leaves the
   * session `queued` for the scheduler; nothing provisions synchronously), so
   * minutes is comfortably safe.
   */
  inFlightLeaseMs?: number;
}

const DEFAULT_IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;
const DEFAULT_IN_FLIGHT_LEASE = 5 * 60 * 1000;

/**
 * Make a retried mutation replay its original response.
 *
 * The failure this prevents is concrete: a client's request succeeds, the
 * response is lost to a network blip, the client retries, and a second agent
 * session starts. With a key, the retry returns the first response instead.
 *
 * A key reserved but not yet completed means the original request is still in
 * flight; that gets a 409 rather than a duplicate execution, because we cannot
 * know yet what the answer will be.
 */
export function idempotencyMiddleware(options: IdempotencyOptions): Middleware {
  const ttl = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL;
  const inFlightLease = options.inFlightLeaseMs ?? DEFAULT_IN_FLIGHT_LEASE;

  return async (context, next) => {
    const key = context.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) return next(context);
    if (context.method === 'GET' || context.method === 'HEAD') return next(context);

    if (key.length < 8 || key.length > 128) {
      throw new MaError({
        code: 'INVALID_IDEMPOTENCY_KEY',
        category: 'validation',
        message: 'Idempotency-Key must be between 8 and 128 characters',
      });
    }

    // Only an authenticated request is idempotency-tracked. On a public/unauth
    // path (SCIM, runtime, ingress, auth) `authMiddleware` calls next() without
    // setting `context.auth`, so there is no principal to scope the record to.
    // Tracking those would (a) let an unauthenticated caller persist an unbounded
    // number of durable 24h-TTL rows — one per distinct key, no per-scope cap — a
    // storage-amplification DoS, and (b) collapse every anonymous caller into one
    // shared `anonymous:METHOD:PATH` keyspace whose replay branch returns the
    // stored response WITHOUT re-running the handler's own authorization (SCIM
    // authorize, the runtime token check), so a key+body match could serve one
    // caller's answer to another. Public paths run their own auth inside the
    // handler and must neither populate nor replay from a principal-scoped cache,
    // so skip — mirroring the per-principal rate-limit tier's skip-when-unauth.
    const auth = context.auth as AuthContext | undefined;
    if (!auth) return next(context);

    // Scoped by principal as well as route: two tenants using the same key
    // must not collide, and a key is not a capability to read someone else's
    // response.
    const scope = `${auth.principal.id}:${context.method}:${context.path}`;
    // Fingerprint of the exact bytes sent. A key identifies one *request*, so
    // reusing it for a different body is a client bug — and answering that with
    // the first request's response is the worst way to report it: the caller
    // receives a 200 describing a resource it did not ask for and never notices.
    // Hashing the raw body rather than the parsed one means the check cannot
    // drift from what was actually on the wire. Bytes, not a decoded string:
    // decoding maps every invalid sequence to U+FFFD, so two different binary
    // uploads would share a fingerprint.
    const fingerprint = sha256Hex(context.rawBody);
    const now = options.clock.now();

    const reservation = await options.store.idempotency.reserve(key, scope, now, inFlightLease);

    if (!reservation.reserved) {
      const record = reservation.record;
      if (record.statusCode === undefined) {
        throw new MaError({
          code: 'IDEMPOTENT_REQUEST_IN_FLIGHT',
          category: 'conflict',
          message: 'A request with this Idempotency-Key is still being processed',
          retryAfterSeconds: 2,
        });
      }
      if (record.requestHash !== undefined && !safeEqual(record.requestHash, fingerprint)) {
        throw new MaError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          category: 'conflict',
          message:
            'This Idempotency-Key was already used for a different request body. ' +
            'A key identifies one request; use a new key for a new request.',
        });
      }
      return {
        status: record.statusCode,
        headers: { 'idempotent-replay': 'true' },
        body: record.response === undefined ? undefined : JSON.parse(record.response),
      };
    }

    try {
      const result = await next(context);
      if (result && result.status < 500) {
        await options.store.idempotency.complete(
          key,
          scope,
          result.status,
          JSON.stringify(result.body ?? null),
          options.clock.now(),
          ttl,
          fingerprint,
        );
      } else {
        // A 5xx is not a settled outcome; releasing lets an honest retry run.
        await options.store.idempotency.release(key, scope);
      }
      return result;
    } catch (error) {
      await options.store.idempotency.release(key, scope);
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  clock: Clock;
  /** Requests allowed per window, per principal. */
  limit?: number;
  windowMs?: number;
  /**
   * Whether a proxy in front of this process rewrites `X-Forwarded-For`.
   *
   * Off by default. When off, unauthenticated callers are bucketed by socket
   * address; when on, by the left-most forwarded address. Turning it on without
   * an actual proxy hands every caller a free choice of bucket.
   */
  trustForwardedFor?: boolean;
  /**
   * When true, the `x-ratelimit-*` response headers are written only if not
   * already set. Used by the outer (IP) tier so it does not clobber the headers
   * the inner (per-principal) tier already set — a tenant cares about its own
   * per-principal budget, so that tier's numbers are the authoritative ones.
   */
  setHeadersIfAbsent?: boolean;
  /**
   * When true, a request with no authenticated principal is passed straight
   * through — the per-principal tier uses this so public/unauthenticated paths
   * (already governed by the pre-auth IP tier) are not re-limited by IP at the
   * lower per-principal budget.
   */
  skipWhenUnauthenticated?: boolean;
}

/**
 * A fixed-window limiter, per principal.
 *
 * In-memory, so it is per-process — honest about being a guard against a single
 * runaway client rather than a distributed quota. Workspace-level fairness is
 * the quota service's job, which is backed by the store and therefore shared.
 */
export function rateLimitMiddleware(options: RateLimitOptions): Middleware {
  const limit = options.limit ?? 600;
  const windowMs = options.windowMs ?? 60_000;
  const counters = new Map<string, { count: number; resetAt: number }>();

  return async (context, next) => {
    const auth = context.auth as AuthContext | undefined;
    // The per-principal tier defers to the IP tier for anything not yet
    // authenticated: a public/runtime/ingress path (no principal) was already
    // bucketed by the pre-auth IP tier, and re-limiting it here — by IP, at the
    // usually-lower per-principal budget — would cap exactly those high-volume
    // paths below the IP tier's headroom and 429 live runtime traffic.
    if (options.skipWhenUnauthenticated && !auth) return next(context);

    // An unauthenticated caller is bucketed by address. It used to be read
    // straight from `X-Forwarded-For`, which the client sets — so rotating the
    // header gave a fresh bucket every request and the limit did nothing:
    // twelve requests against a limit of five produced zero refusals. Worse,
    // a caller could pick someone else's address and spend their budget.
    const bucketKey =
      auth?.principal.id ?? clientIp(context, options.trustForwardedFor ?? false) ?? 'anonymous';
    const now = options.clock.now();

    let bucket = counters.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      counters.set(bucketKey, bucket);
    }

    bucket.count++;
    if (bucket.count > limit) {
      throw new MaError({
        code: 'RATE_LIMITED',
        category: 'quota',
        message: `Rate limit of ${limit} requests per ${windowMs}ms exceeded`,
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      });
    }

    // Opportunistic cleanup so the map does not grow without bound across a
    // long-lived process seeing many distinct callers.
    if (counters.size > 10_000) {
      for (const [key, entry] of counters) {
        if (entry.resetAt <= now) counters.delete(key);
      }
      // A flood of *distinct* keys within one window (e.g. rotated addresses)
      // leaves nothing expired to prune, so the sweep above frees nothing. Bound
      // memory hard by evicting oldest-inserted entries (Map preserves insertion
      // order) down to the cap. Evicting a live bucket only resets that key's
      // count — at worst it grants a few extra requests to a key that is, by
      // construction, barely used; it cannot lift another key's limit.
      if (counters.size > 20_000) {
        const excess = counters.size - 10_000;
        let removed = 0;
        for (const key of counters.keys()) {
          counters.delete(key);
          if (++removed >= excess) break;
        }
      }
    }

    const result = await next(context);
    if (result) {
      const headers = { ...result.headers };
      // The outer (IP) tier defers to headers the inner (per-principal) tier
      // already set, so a client sees its per-principal budget rather than the
      // coarser IP-shield numbers. When no inner tier ran, it sets them itself.
      const alreadySet =
        headers['x-ratelimit-limit'] !== undefined ||
        headers['x-ratelimit-remaining'] !== undefined ||
        headers['x-ratelimit-reset'] !== undefined;
      if (!(options.setHeadersIfAbsent && alreadySet)) {
        headers['x-ratelimit-limit'] = String(limit);
        headers['x-ratelimit-remaining'] = String(Math.max(0, limit - bucket.count));
        headers['x-ratelimit-reset'] = String(Math.ceil(bucket.resetAt / 1000));
      }
      result.headers = headers;
    }
    return result;
  };
}

/** Convenience for handlers that return nothing. */
export const noContent: HandlerResult = { status: 204 };
