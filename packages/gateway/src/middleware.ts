/**
 * Gateway middleware: authentication, idempotency, rate limiting and error
 * mapping.
 *
 * Ordering matters and is asserted by the server that composes these:
 * errors outermost (so everything below is caught), then request logging, then
 * rate limiting (cheap, before we do work), then authentication, then
 * idempotency (which needs to know who is asking).
 */

import { MaError, hashToken, safeEqual, unauthenticated, type Clock, type Logger, type MetricsRegistry } from '@ma/core';
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

    // Best-effort: a failed usage stamp must not fail the request.
    void options.store.apiKeys.update(key.id, { lastUsedAt: now }).catch(() => {});

    const auth: AuthContext = {
      principal,
      scopes: key.scopes,
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
 */
function clientIp(context: RequestContext, trustForwardedFor = false): string {
  if (trustForwardedFor) {
    const forwarded = context.headers['x-forwarded-for'];
    // Left-most is the original client; the rest are the proxy chain.
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]!.trim();
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
  ttlMs?: number;
}

const DEFAULT_IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

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

    // Scoped by principal as well as route: two tenants using the same key
    // must not collide, and a key is not a capability to read someone else's
    // response.
    const auth = context.auth as AuthContext | undefined;
    const scope = `${auth?.principal.id ?? 'anonymous'}:${context.method}:${context.path}`;
    // Fingerprint of the exact bytes sent. A key identifies one *request*, so
    // reusing it for a different body is a client bug — and answering that with
    // the first request's response is the worst way to report it: the caller
    // receives a 200 describing a resource it did not ask for and never notices.
    // Hashing the raw body rather than the parsed one means the check cannot
    // drift from what was actually on the wire.
    const fingerprint = hashToken(context.rawBody.toString('utf8'));
    const now = options.clock.now();

    const reservation = await options.store.idempotency.reserve(key, scope, now, ttl);

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
    }

    const result = await next(context);
    if (result) {
      result.headers = {
        ...result.headers,
        'x-ratelimit-limit': String(limit),
        'x-ratelimit-remaining': String(Math.max(0, limit - bucket.count)),
        'x-ratelimit-reset': String(Math.ceil(bucket.resetAt / 1000)),
      };
    }
    return result;
  };
}

/** Convenience for handlers that return nothing. */
export const noContent: HandlerResult = { status: 204 };
