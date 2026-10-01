/**
 * The transport for `hook` connector callbacks.
 *
 * A hook's caller names the URL its result goes to, inside the signed inbound
 * request. Signed only proves the caller holds the connector's secret, so the
 * URL is still the caller's choice: posted to blindly, it would let anyone with
 * that secret aim the control plane at an internal service or a cloud metadata
 * endpoint. So a callback goes only to an origin an operator listed, a redirect
 * is not followed (it would leave the list), and the body is signed with the
 * connector's secret exactly as inbound hooks are, so the receiver can check
 * it came from this platform.
 */

import { MaError, hmacSha256Hex, validationError, type Clock } from '@ma/core';

export interface HookCallbackOptions {
  /** `scheme://host[:port]` origins a callback may go to. */
  allowedOrigins: readonly string[];
  clock: Clock;
  /** How long one callback may take. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The `post` a `hookAdapter` calls with each finished turn's outcome. */
export function hookCallbackPoster(
  options: HookCallbackOptions,
): (url: string, payload: unknown, secret?: string) => Promise<void> {
  const allowed = new Set(options.allowedOrigins);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (url, payload, secret) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw validationError(`A hook callback URL must be absolute; got ${JSON.stringify(url.slice(0, 200))}.`);
    }
    if (!allowed.has(target.origin)) {
      throw new MaError({
        code: 'HOOK_CALLBACK_NOT_ALLOWED',
        category: 'permission',
        message:
          `The hook asked for its result at ${target.origin}, which is not in MA_HOOK_CALLBACK_ORIGINS. ` +
          'Add that origin to the list to allow callbacks to it.',
      });
    }

    const body = JSON.stringify(payload);
    const timestamp = options.clock.now();
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ma-timestamp': String(timestamp),
          ...(secret ? { 'x-ma-signature': hmacSha256Hex(secret, `${timestamp}.${body}`) } : {}),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MaError({
        code: 'HOOK_CALLBACK_FAILED',
        category: 'unavailable',
        message: `Could not reach the hook callback at ${target.origin}: ${error instanceof Error ? error.message : String(error)}.`,
        cause: error,
      });
    }
    await response.body?.cancel();
    if (response.status < 200 || response.status >= 300) {
      throw new MaError({
        code: 'HOOK_CALLBACK_FAILED',
        category: 'unavailable',
        message:
          `The hook callback at ${target.origin} answered ${response.status}` +
          (response.status >= 300 && response.status < 400 ? ' (a redirect, which is not followed)' : '') +
          '; expected a 2xx.',
      });
    }
  };
}

/**
 * Parse `MA_HOOK_CALLBACK_ORIGINS`: comma-separated origins, each exactly
 * `scheme://host[:port]` so the comparison with a callback's origin is exact.
 */
export function parseCallbackOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      let origin: string;
      try {
        origin = new URL(entry).origin;
      } catch {
        origin = '';
      }
      if (origin === '' || origin === 'null' || origin !== entry.replace(/\/$/, '') || !/^https?:/.test(origin)) {
        throw validationError(
          `MA_HOOK_CALLBACK_ORIGINS expects http(s) origins like https://hooks.example.com:8443, comma-separated; got ${JSON.stringify(entry)}. ` +
            'Drop any path, query or credentials.',
        );
      }
      return origin;
    });
}
