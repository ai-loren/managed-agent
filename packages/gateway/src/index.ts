/**
 * `@ma/gateway` — the HTTP API.
 */

export {
  Router,
  pageArgs,
  readBody,
  requireBody,
  requireParam,
  resolveRequestId,
  type Handler,
  type HandlerResult,
  type Method,
  type Middleware,
  type RequestContext,
} from './router.ts';

export {
  authMiddleware,
  errorMiddleware,
  idempotencyMiddleware,
  loggingMiddleware,
  noContent,
  rateLimitMiddleware,
  requireAuth,
  type AuthOptions,
  type IdempotencyOptions,
  type RateLimitOptions,
} from './middleware.ts';

export {
  SseBridge,
  openStream,
  resolveFromSeq,
  type SseOptions,
  type StreamRequest,
} from './sse.ts';

export { buildRoutes, routeNotFound, type RouteDeps } from './routes.ts';

export { Gateway, type GatewayOptions } from './server.ts';
