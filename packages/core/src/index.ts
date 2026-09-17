/**
 * `@ma/core` — primitives every other package depends on.
 *
 * Nothing here knows about agents, sessions or HTTP. If a symbol needs a
 * domain concept to make sense, it belongs in `@ma/contracts` or higher.
 */

export {
  ID_PREFIXES,
  ULID_LENGTH,
  isId,
  kindOf,
  newId,
  timeOf,
  ulid,
  type Id,
  type IdPrefix,
  type ResourceKind,
} from './ids.ts';

export {
  MaError,
  conflict,
  internalError,
  invalidTransition,
  notFound,
  permissionDenied,
  quotaExceeded,
  timeout,
  unauthenticated,
  unavailable,
  validationError,
  type ErrorCategory,
  type MaErrorOptions,
} from './errors.ts';

export {
  allResults,
  attempt,
  attemptAsync,
  err,
  isErr,
  isOk,
  mapError,
  mapResult,
  ok,
  unwrap,
  unwrapOr,
  type Result,
} from './result.ts';

export { TestClock, systemClock, type Clock } from './clock.ts';

export {
  consoleSink,
  createLogger,
  memorySink,
  nullLogger,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type Logger,
  type LoggerOptions,
} from './logger.ts';

export {
  DEFAULT_RETRY,
  PROVISIONING_RETRY,
  backoffDelay,
  withRetry,
  withTimeout,
  type RetryOptions,
  type RetryPolicy,
} from './retry.ts';

export {
  CircuitBreaker,
  type BreakerState,
  type CircuitBreakerOptions,
} from './circuit-breaker.ts';

export {
  InMemoryKeyProvider,
  canonicalJson,
  hashToken,
  hmacSha256Hex,
  randomToken,
  safeEqual,
  seal,
  sha256Hex,
  unseal,
  verifySignature,
  type KeyProvider,
  type SealedValue,
} from './crypto.ts';

export { StateMachine, type StateMachineSpec } from './state-machine.ts';

export { sanitizeEnv, reservedKeys, mergeEnvVars } from './env.ts';

export {
  MetricsRegistry,
  DEFAULT_LATENCY_BUCKETS,
  type MetricLabels,
  type GaugeCollector,
} from './metrics.ts';
