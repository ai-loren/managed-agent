/**
 * The HTTP router.
 *
 * Hand-rolled rather than framework-based, for two reasons that matter here:
 * streaming and backpressure need direct control over the socket, and a
 * control plane that brokers credentials should not carry a dependency tree it
 * cannot review.
 *
 * Routes are matched by an exact-segment-then-parameter walk over a trie, so
 * `/v1/sessions/:id` and `/v1/sessions/current` coexist with the literal
 * winning — the usual source of "why is my static route being swallowed".
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { MaError, newId, notFound, validationError, type Logger } from '@ma/core';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** Everything a handler needs, assembled once per request. */
export interface RequestContext {
  method: Method;
  path: string;
  /** Path parameters, e.g. `{ id: 'sn_...' }`. */
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  /** Parsed JSON body, or `undefined` when there was none. */
  body: unknown;
  /** Raw body bytes, needed to verify webhook signatures. */
  rawBody: Buffer;
  requestId: string;
  /** Set by the authentication middleware. */
  auth?: unknown;
  logger: Logger;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  /** The underlying response, for streaming handlers. */
  raw: { req: IncomingMessage; res: ServerResponse };
}

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A handler returns a result, or `undefined` when it has written the response
 * itself — which is how SSE and other streaming endpoints opt out of the
 * normal serialize-and-send path.
 */
export type Handler = (context: RequestContext) => Promise<HandlerResult | undefined>;

/** Wraps a handler. Middleware runs outside-in, in registration order. */
export type Middleware = (context: RequestContext, next: Handler) => Promise<HandlerResult | undefined>;

interface RouteNode {
  /** Literal children, matched first. */
  children: Map<string, RouteNode>;
  /** Single parameter child, e.g. `:id`. */
  param?: { name: string; node: RouteNode };
  /** Catch-all, e.g. `*path`. Matches the remainder. */
  wildcard?: { name: string; node: RouteNode };
  handlers: Map<Method, Handler>;
}

function emptyNode(): RouteNode {
  return { children: new Map(), handlers: new Map() };
}

export class Router {
  readonly #root = emptyNode();
  readonly #middleware: Middleware[] = [];
  /**
   * Every registered route, in registration order.
   *
   * The trie is built for matching and cannot be walked back into patterns, so
   * this is recorded alongside it. It exists so a test can assert the OpenAPI
   * document covers the API that actually exists — the generator shares the
   * gateway's *schemas*, but its path list is hand-written and had silently
   * drifted eleven routes behind the router.
   */
  readonly #registered: { method: Method; pattern: string }[] = [];

  use(middleware: Middleware): this {
    this.#middleware.push(middleware);
    return this;
  }

  route(method: Method, pattern: string, handler: Handler): this {
    this.#registered.push({ method, pattern });
    let node = this.#root;
    for (const segment of split(pattern)) {
      if (segment.startsWith('*')) {
        node.wildcard ??= { name: segment.slice(1), node: emptyNode() };
        node = node.wildcard.node;
        break;
      }
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        if (node.param && node.param.name !== name) {
          // Two different parameter names at the same position would make the
          // extracted key depend on registration order.
          throw new Error(
            `Route conflict at '${pattern}': ':${node.param.name}' is already registered here`,
          );
        }
        node.param ??= { name, node: emptyNode() };
        node = node.param.node;
        continue;
      }
      let child = node.children.get(segment);
      if (!child) {
        child = emptyNode();
        node.children.set(segment, child);
      }
      node = child;
    }

    if (node.handlers.has(method)) {
      throw new Error(`Duplicate route: ${method} ${pattern}`);
    }
    node.handlers.set(method, handler);
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.route('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.route('POST', pattern, handler);
  }
  patch(pattern: string, handler: Handler): this {
    return this.route('PATCH', pattern, handler);
  }
  put(pattern: string, handler: Handler): this {
    return this.route('PUT', pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.route('DELETE', pattern, handler);
  }

  /** Every route registered on this router, for documentation and diagnostics. */
  get registered(): readonly { method: Method; pattern: string }[] {
    return this.#registered;
  }

  /**
   * Find a handler.
   *
   * Returns `methodMismatch` when the path exists but the method does not, so
   * the caller can answer 405 with an `Allow` header rather than a misleading
   * 404.
   */
  match(
    method: Method,
    path: string,
  ):
    | { handler: Handler; params: Record<string, string> }
    | { methodMismatch: true; allowed: Method[] }
    | undefined {
    const segments = split(path);
    const params: Record<string, string> = {};
    const node = this.#walk(this.#root, segments, 0, params);
    if (!node) return undefined;

    const handler = node.handlers.get(method);
    if (handler) return { handler, params };
    if (node.handlers.size > 0) {
      return { methodMismatch: true, allowed: [...node.handlers.keys()] };
    }
    return undefined;
  }

  /**
   * Depth-first walk. Literals are tried before the parameter branch, and the
   * parameter branch before the wildcard, so a static route always beats a
   * dynamic one at the same depth.
   */
  #walk(
    node: RouteNode,
    segments: string[],
    index: number,
    params: Record<string, string>,
  ): RouteNode | undefined {
    if (index === segments.length) return node.handlers.size > 0 ? node : undefined;

    const segment = segments[index]!;

    const literal = node.children.get(segment);
    if (literal) {
      const found = this.#walk(literal, segments, index + 1, params);
      if (found) return found;
    }

    if (node.param) {
      const found = this.#walk(node.param.node, segments, index + 1, params);
      if (found) {
        params[node.param.name] = decodeURIComponent(segment);
        return found;
      }
    }

    if (node.wildcard) {
      params[node.wildcard.name] = segments.slice(index).map(decodeURIComponent).join('/');
      return node.wildcard.node.handlers.size > 0 ? node.wildcard.node : undefined;
    }

    return undefined;
  }

  /** Run the middleware chain around a handler. */
  async dispatch(context: RequestContext, handler: Handler): Promise<HandlerResult | undefined> {
    let index = -1;
    const run = async (current: RequestContext): Promise<HandlerResult | undefined> => {
      index++;
      const middleware = this.#middleware[index];
      if (!middleware) return handler(current);
      return middleware(current, run);
    };
    return run(context);
  }
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read and parse the request body.
 *
 * Bounded: an unbounded read is a trivial way to exhaust the process's memory,
 * and the limit is enforced as bytes arrive rather than after buffering.
 */
export async function readBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ raw: Buffer; parsed: unknown }> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      throw new MaError({
        code: 'PAYLOAD_TOO_LARGE',
        category: 'validation',
        message: `Request body exceeds ${maxBytes} bytes`,
      });
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { raw, parsed: undefined };

  const contentType = req.headers['content-type'] ?? '';
  // Parse JSON and any `+json`-structured media type (e.g. `application/scim+json`,
  // the SCIM content type). Non-JSON bodies (webhook payloads, uploads) reach the
  // handler as raw bytes.
  if (!/application\/(json|[\w.+-]*\+json)\b/.test(contentType)) {
    return { raw, parsed: undefined };
  }

  try {
    return { raw, parsed: JSON.parse(raw.toString('utf8')) };
  } catch {
    throw validationError('Request body is not valid JSON');
  }
}

/** The body as a typed object, or a validation error naming the problem. */
export function requireBody(context: RequestContext): Record<string, unknown> {
  if (context.body === undefined || context.body === null) {
    throw validationError('A JSON request body is required');
  }
  if (typeof context.body !== 'object' || Array.isArray(context.body)) {
    throw validationError('The request body must be a JSON object');
  }
  return context.body as Record<string, unknown>;
}

/** A required path parameter. */
export function requireParam(context: RequestContext, name: string): string {
  const value = context.params[name];
  if (!value) throw notFound('Route parameter', name);
  return value;
}

/** Pagination arguments from the query string, with coercion and bounds. */
export function pageArgs(context: RequestContext): {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
} {
  const limitRaw = context.query.get('limit');
  const cursor = context.query.get('cursor') ?? undefined;
  const orderRaw = context.query.get('order');

  const args: { limit?: number; cursor?: string; order?: 'asc' | 'desc' } = {};
  if (limitRaw !== null) {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw validationError('limit must be an integer between 1 and 200', { limit: limitRaw });
    }
    args.limit = limit;
  }
  if (cursor) args.cursor = cursor;
  if (orderRaw === 'asc' || orderRaw === 'desc') args.order = orderRaw;
  return args;
}

/** A fresh request id, or the caller's if it supplied one worth trusting. */
export function resolveRequestId(headers: IncomingMessage['headers']): string {
  const supplied = headers['x-request-id'];
  if (typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 128) {
    return supplied;
  }
  return newId('event');
}
