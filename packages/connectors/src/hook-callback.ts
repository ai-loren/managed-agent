/**
 * The transport for `hook` connector callbacks.
 *
 * A hook's caller names the URL its result goes to, inside the signed inbound
 * request. Signed only proves the caller holds the connector's secret, so the
 * URL is still the caller's choice: posted to blindly, it would let anyone with
 * that secret aim the control plane at an internal service or a cloud metadata
 * endpoint. So a callback goes only to an origin an operator listed, a redirect
 * is not followed (it would leave the list), and the body is signed with the
 * connector's secret, so the receiver can check it came from this platform.
 *
 * The signed string is `callback.<timestamp>.<body>`, not the inbound
 * `<timestamp>.<body>`: with the same secret and the same string, anyone who
 * saw a callback could post it back to the hook's inbound endpoint, and it would
 * verify there as the caller's own request.
 */

import { MaError, hmacSha256Hex, validationError, type Clock } from '@ma/core';

import { exactOrigin, redactCredentials } from './origin.ts';

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
      throw validationError(
        `A hook callback URL must be absolute; got ${JSON.stringify(redactCredentials(url.slice(0, 200)))}.`,
      );
    }
    // Before the origin check: a `blob:` URL reports the origin of the URL inside it.
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw validationError(
        `A hook callback URL must be http(s); got a ${target.protocol} URL. Give the receiver's http(s) address as the callbackUrl.`,
      );
    }
    if (target.username !== '' || target.password !== '') {
      throw validationError(
        `The hook asked for its result at a URL for ${target.origin} that carries credentials, which a callback ` +
          'does not send. Drop them from the callbackUrl; the receiver authenticates a callback by its x-ma-signature.',
      );
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
    if (!secret) {
      throw new MaError({
        code: 'HOOK_CALLBACK_UNSIGNED',
        category: 'precondition',
        message:
          `The hook's result was not sent to ${target.origin}: the connector has no usable signing secret, and an ` +
          'unsigned callback cannot be told from a forged one. Give the connector an active secret credential.',
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
          'x-ma-signature': hmacSha256Hex(secret, `callback.${timestamp}.${body}`),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Described, not quoted: a fetch error's text can repeat the URL it was given.
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `no answer within ${timeoutMs} ms`
          : (errorCode(error) ?? 'the connection failed');
      throw new MaError({
        code: 'HOOK_CALLBACK_FAILED',
        category: 'unavailable',
        message:
          `Could not reach the hook callback at ${target.origin} (${reason}). ` +
          'Check that the receiver is up and reachable from the control plane.',
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

/** The system error code under a failed fetch (`ECONNREFUSED`, `ENOTFOUND`, …), if there is one. */
function errorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === 'string' ? cause.code : undefined;
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
      const origin = exactOrigin(entry);
      if (origin === undefined) {
        throw validationError(
          `MA_HOOK_CALLBACK_ORIGINS expects http(s) origins like https://hooks.example.com:8443, comma-separated; ` +
            `got ${JSON.stringify(redactCredentials(entry))}. Give each as scheme://host[:port] alone, with no path, query, fragment or credentials.`,
        );
      }
      return origin;
    });
}
