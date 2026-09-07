/**
 * `Result` — explicit success/failure for operations whose failure is an
 * expected outcome rather than a defect.
 *
 * We do not use this everywhere. Throwing `MaError` is right for the common
 * path: it composes with async/await and does not force every caller to unwrap.
 * `Result` is for the places where a failure is *data* — validation that
 * collects several problems, a batch where some items fail, a probe whose
 * negative answer is not exceptional.
 */

import { MaError } from './errors.ts';

export type Result<T, E = MaError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** Unwrap or throw. Use at the boundary where `Result` meets throwing code. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw MaError.from(result.error);
}

/** Unwrap or fall back. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapError<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Collect a list of results into a result of a list, failing on the first
 * error. Use when partial success is meaningless.
 */
export function allResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/** Run a throwing function and capture the failure as an `MaError`. */
export function attempt<T>(fn: () => T): Result<T, MaError> {
  try {
    return ok(fn());
  } catch (error) {
    return err(MaError.from(error));
  }
}

/** Async counterpart of `attempt`. */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T, MaError>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(MaError.from(error));
  }
}
