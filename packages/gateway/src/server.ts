/**
 * The HTTP server.
 *
 * Composes the middleware chain, dispatches to the router, and handles the
 * mechanics a framework would otherwise hide: body limits, client disconnects,
 * CORS, and a shutdown that drains in-flight requests instead of cutting them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { systemClock, type Clock, type Logger } from '@ma/core';
import { nullLogger } from '@ma/core';

import {
  authMiddleware,
  errorMiddleware,
  idempotencyMiddleware,
  loggingMiddleware,
  rateLimitMiddleware,
} from './middleware.ts';
import {
  Router,
  readBody,
  resolveRequestId,
  type HandlerResult,
  type Method,
  type RequestContext,
} from './router.ts';
import { buildRoutes, routeNotFound, type RouteDeps } from './routes.ts';
import { isRuntimePath } from './runtime-routes.ts';

export interface GatewayOptions extends RouteDeps {
  clock?: Clock;
  logger?: Logger;
  /** Origins allowed to call the API from a browser. */
  corsOrigins?: string[];
  rateLimit?: { limit: number; windowMs: number };
  maxBodyBytes?: number;
  /**
   * Set only when a reverse proxy in front of this process rewrites
   * `X-Forwarded-For`. Off by default: the header is client-supplied
   * otherwise, so trusting it lets any caller choose its own rate-limit bucket
   * and write an arbitrary address into the audit trail.
   */
  trustForwardedFor?: boolean;
}

export class Gateway {
  readonly #router: Router;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #corsOrigins: Set<string>;
  readonly #maxBodyBytes: number;
  readonly #inflight = new Set<Promise<void>>();
  #server: Server | undefined;
  #shuttingDown = false;

  constructor(options: GatewayOptions) {
    this.#logger = options.logger ?? nullLogger;
    this.#clock = options.clock ?? systemClock;
    this.#corsOrigins = new Set(options.corsOrigins ?? []);
    this.#maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;

    this.#router = buildRoutes(options);

    // Order is deliberate: errors outermost so nothing escapes, logging next so
    // every request is recorded whatever happens, rate limiting before we do
    // real work, authentication before idempotency (which scopes keys by
    // principal).
    this.#router.use(errorMiddleware(this.#logger));
    this.#router.use(loggingMiddleware(this.#logger, this.#clock));
    this.#router.use(
      rateLimitMiddleware({
        clock: this.#clock,
        trustForwardedFor: options.trustForwardedFor ?? false,
        ...(options.rateLimit ?? {}),
      }),
    );
    this.#router.use(
      authMiddleware({
        store: options.store,
        clock: this.#clock,
        trustForwardedFor: options.trustForwardedFor ?? false,
        // These authenticate differently rather than not at all: connector
        // deliveries by signature, runtime calls by a session-scoped token,
        // the console by a token the operator supplies in the browser, and a
        // preview by a signed, expiring token in its URL.
        publicPaths: (path) =>
          path === '/health' ||
          path === '/' ||
          isRuntimePath(path) ||
          path.startsWith('/auth/v1/') ||
          /^\/preview\/v1\/[^/]+$/.test(path) ||
          /^\/ingress\/v1\/[^/]+\/[^/]+$/.test(path),
      }),
    );
    this.#router.use(idempotencyMiddleware({ store: options.store, clock: this.#clock }));
  }

  /** The router, so a host can add routes (connector webhooks, the console). */
  get router(): Router {
    return this.#router;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = resolveRequestId(req.headers);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase() as Method;

    this.#applyCors(req, res);

    // A preflight must not reach authentication: the browser sends it without
    // credentials by design.
    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (this.#shuttingDown) {
      this.#send(res, requestId, {
        status: 503,
        headers: { connection: 'close' },
        body: { error: { code: 'SHUTTING_DOWN', message: 'The server is shutting down' } },
      });
      return;
    }

    // Aborted when the client goes away, so a streaming handler and any
    // in-flight work can stop rather than writing into a dead socket.
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let body: unknown;
    let rawBody: Buffer = Buffer.alloc(0);
    try {
      const read = await readBody(req, this.#maxBodyBytes);
      body = read.parsed;
      rawBody = read.raw;
    } catch (error) {
      this.#sendError(res, requestId, error);
      return;
    }

    const context: RequestContext = {
      method,
      path: url.pathname,
      params: {},
      query: url.searchParams,
      headers: req.headers,
      body,
      rawBody,
      requestId,
      logger: this.#logger.child({ requestId }),
      signal: controller.signal,
      raw: { req, res },
    };

    const matched = this.#router.match(method, url.pathname);

    if (matched && 'methodMismatch' in matched) {
      // 405 with Allow, rather than a 404 that would send a client hunting for
      // a path that is in fact right.
      this.#send(res, requestId, {
        status: 405,
        headers: { allow: matched.allowed.join(', ') },
        body: {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `${method} is not supported for ${url.pathname}`,
            requestId,
          },
        },
      });
      return;
    }

    const handler = matched?.handler ?? (() => Promise.resolve(routeNotFound(context)));
    if (matched) context.params = matched.params;

    const work = (async () => {
      try {
        const result = await this.#router.dispatch(context, handler);
        // `undefined` means the handler wrote the response itself (SSE).
        if (result && !res.headersSent) this.#send(res, requestId, result);
      } catch (error) {
        this.#sendError(res, requestId, error);
      }
    })();

    this.#inflight.add(work);
    try {
      await work;
    } finally {
      this.#inflight.delete(work);
    }
  }

  #applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return;
    // Echo only origins that were explicitly configured. A reflected wildcard
    // with credentials is the classic way to make an API readable by any page
    // the user happens to visit.
    if (!this.#corsOrigins.has(origin) && !this.#corsOrigins.has('*')) return;

    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'authorization, content-type, idempotency-key, last-event-id, x-request-id',
    );
    res.setHeader('access-control-expose-headers', 'x-request-id, retry-after, idempotent-replay');
    res.setHeader('vary', 'origin');
  }

  #send(res: ServerResponse, requestId: string, result: HandlerResult): void {
    if (res.headersSent) return;
    const headers: Record<string, string> = {
      'x-request-id': requestId,
      ...result.headers,
    };

    if (result.body === undefined) {
      res.writeHead(result.status, headers).end();
      return;
    }

    const payload = JSON.stringify(result.body);
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(Buffer.byteLength(payload));
    res.writeHead(result.status, headers).end(payload);
  }

  #sendError(res: ServerResponse, requestId: string, error: unknown): void {
    if (res.headersSent) {
      // Mid-stream: the status is already sent, so all we can do is stop.
      res.end();
      return;
    }
    this.#logger.error('request failed outside the middleware chain', { requestId, error });
    this.#send(res, requestId, {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'An internal error occurred', requestId } },
    });
  }

  listen(port: number, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });
      // SSE connections are long-lived by design; the default 2-minute socket
      // timeout would sever them mid-stream.
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.keepAliveTimeout = 65_000;

      server.once('error', reject);
      server.listen(port, host, () => {
        this.#server = server;
        const address = server.address();
        const actual = typeof address === 'object' && address ? address.port : port;
        this.#logger.info('gateway listening', { host, port: actual });
        resolve({ port: actual, host });
      });
    });
  }

  /**
   * Stop accepting connections and let in-flight requests finish.
   *
   * A shutdown that severs live requests turns a routine deploy into user-
   * visible errors, so new requests get a 503 while existing ones drain.
   */
  async close(drainTimeoutMs = 15_000): Promise<void> {
    this.#shuttingDown = true;
    const server = this.#server;
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Nudge idle keep-alive sockets, which would otherwise hold the close open.
      server.closeIdleConnections?.();
    });

    if (this.#inflight.size > 0) {
      const deadline = new AbortController();
      await Promise.race([
        Promise.allSettled([...this.#inflight]),
        this.#clock.sleep(drainTimeoutMs, deadline.signal).then(() => {
          this.#logger.warn('drain timed out with requests still in flight', {
            inflight: this.#inflight.size,
          });
        }),
      ]);
      deadline.abort();
    }

    this.#server = undefined;
  }
}
