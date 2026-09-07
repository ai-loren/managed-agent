/**
 * The platform's error taxonomy.
 *
 * Two rules make errors useful rather than decorative:
 *
 *  1. Every failure carries a stable machine-readable `code`. Clients branch on
 *     the code, never on the message; messages are free to improve.
 *  2. Every failure knows whether retrying it could possibly help (`retryable`).
 *     Callers must not guess this from the HTTP status — a 500 from a quota
 *     reaper is retryable, a 500 from a schema violation is not.
 */

/** Broad class of a failure; determines the default HTTP status. */
export type ErrorCategory =
  | 'validation' // the request is malformed or violates a schema
  | 'not_found' // the addressed resource does not exist (or is not visible)
  | 'conflict' // the request lost a race or violates a uniqueness/state rule
  | 'permission' // authenticated but not allowed
  | 'unauthenticated' // no or invalid credentials
  | 'quota' // admission refused; resource limits exhausted
  | 'precondition' // the resource is in a state that forbids this operation
  | 'unavailable' // a dependency is down or overloaded; retry may help
  | 'timeout' // the operation exceeded its deadline
  | 'internal'; // a defect on our side

const CATEGORY_STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  unauthenticated: 401,
  permission: 403,
  not_found: 404,
  conflict: 409,
  precondition: 412,
  quota: 429,
  internal: 500,
  unavailable: 503,
  timeout: 504,
};

/** Categories where a later identical attempt could plausibly succeed. */
const RETRYABLE: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'unavailable',
  'timeout',
  'quota',
]);

export interface MaErrorOptions {
  /** Machine-readable, SCREAMING_SNAKE, stable across releases. */
  code: string;
  category: ErrorCategory;
  message: string;
  /** Structured context. Must never contain secret values. */
  details?: Record<string, unknown>;
  /** The underlying failure, preserved for logs (never sent to clients). */
  cause?: unknown;
  /** Overrides the category default when the semantics genuinely differ. */
  retryable?: boolean;
  /** For `quota`/`unavailable`: how long the client should wait, in seconds. */
  retryAfterSeconds?: number;
}

/**
 * The only error type crossing a module boundary. Anything thrown from a
 * dependency is wrapped at the boundary so callers face one shape.
 */
export class MaError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(options: MaErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MaError';
    this.code = options.code;
    this.category = options.category;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(options.category);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** The HTTP status this error maps to at the gateway. */
  get status(): number {
    return CATEGORY_STATUS[this.category];
  }

  /** The client-facing shape. Deliberately excludes `cause` and stack. */
  toJSON(): {
    code: string;
    category: ErrorCategory;
    message: string;
    details: Record<string, unknown>;
    retryable: boolean;
    retryAfterSeconds?: number;
  } {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }

  static is(value: unknown): value is MaError {
    return value instanceof MaError;
  }

  /**
   * Coerce anything caught into an `MaError`. Unknown throws become `INTERNAL`
   * with the original preserved as `cause` for the logs.
   */
  static from(value: unknown, fallbackCode = 'INTERNAL'): MaError {
    if (value instanceof MaError) return value;
    const message = value instanceof Error ? value.message : String(value);
    return new MaError({
      code: fallbackCode,
      category: 'internal',
      message,
      cause: value,
    });
  }
}

// ---------------------------------------------------------------------------
// Constructors for the common cases. These exist so call sites read as prose
// and so codes stay consistent across packages.
// ---------------------------------------------------------------------------

export function validationError(
  message: string,
  details?: Record<string, unknown>,
  code = 'VALIDATION_FAILED',
): MaError {
  return new MaError({ code, category: 'validation', message, details: details ?? {} });
}

export function notFound(kind: string, id: string): MaError {
  return new MaError({
    code: 'NOT_FOUND',
    category: 'not_found',
    message: `${kind} '${id}' was not found`,
    details: { kind, id },
  });
}

export function conflict(message: string, details?: Record<string, unknown>): MaError {
  return new MaError({
    code: 'CONFLICT',
    category: 'conflict',
    message,
    details: details ?? {},
  });
}

export function permissionDenied(action: string, resource: string): MaError {
  return new MaError({
    code: 'PERMISSION_DENIED',
    category: 'permission',
    message: `Not permitted to ${action} on ${resource}`,
    details: { action, resource },
  });
}

export function unauthenticated(message = 'Authentication required'): MaError {
  return new MaError({ code: 'UNAUTHENTICATED', category: 'unauthenticated', message });
}

export function quotaExceeded(
  dimension: string,
  limit: number,
  observed: number,
  retryAfterSeconds?: number,
): MaError {
  return new MaError({
    code: 'QUOTA_EXCEEDED',
    category: 'quota',
    message: `Quota '${dimension}' exhausted (limit ${limit}, observed ${observed})`,
    details: { dimension, limit, observed },
    retryAfterSeconds,
  });
}

/**
 * A state machine rejected a transition. Carries both states so the client can
 * explain the problem without a second round trip.
 */
export function invalidTransition(kind: string, from: string, to: string): MaError {
  return new MaError({
    code: 'INVALID_STATE_TRANSITION',
    category: 'precondition',
    message: `${kind} cannot move from '${from}' to '${to}'`,
    details: { kind, from, to },
  });
}

export function unavailable(message: string, retryAfterSeconds?: number): MaError {
  return new MaError({
    code: 'UNAVAILABLE',
    category: 'unavailable',
    message,
    retryAfterSeconds,
  });
}

export function timeout(operation: string, ms: number): MaError {
  return new MaError({
    code: 'TIMEOUT',
    category: 'timeout',
    message: `Operation '${operation}' exceeded ${ms}ms`,
    details: { operation, timeoutMs: ms },
  });
}

export function internalError(message: string, cause?: unknown): MaError {
  return new MaError({ code: 'INTERNAL', category: 'internal', message, cause });
}
