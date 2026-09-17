/**
 * Sandbox networking helpers, plus a re-export of the shared env-trust helpers.
 *
 * `sanitizeEnv`/`reservedKeys` moved to `@ma/core` so agent-core (which rebinds
 * a warm sandbox and must apply the same credential-env trust boundary) can use
 * them without depending on `@ma/sandbox`. They are re-exported here so the
 * drivers' existing imports keep working. The loopback / control-plane-port
 * helpers below are sandbox-specific and stay.
 */

export { sanitizeEnv, reservedKeys } from '@ma/core';

/**
 * Whether a control-plane URL's host is loopback / not routable from inside a
 * sandbox.
 *
 * `127.0.0.0/8`, `::1`, `localhost`, and an empty/`0.0.0.0` host all resolve to
 * "the sandbox itself" once inside a container or pod network namespace, so a
 * restricted sandbox given such a URL can never reach the control plane. An
 * unparseable URL is treated as not-loopback here — it is a separate
 * misconfiguration surfaced elsewhere, and this check should not swallow it.
 */
export function isLoopbackControlPlane(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  // URL.hostname wraps an IPv6 literal in brackets, e.g. `[::1]`.
  let bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  // A trailing dot is a valid FQDN form of the same name (`localhost.`).
  if (bare.endsWith('.')) bare = bare.slice(0, -1);
  const lower = bare.toLowerCase();
  if (lower === '' || lower === 'localhost' || lower === '0.0.0.0' || lower === '::1' || lower === '::') {
    return true;
  }
  // Any 127.x.x.x address, including its IPv4-mapped IPv6 forms
  // (`::ffff:127.0.0.1` / `::ffff:7f00:1`).
  return /^127\./.test(lower) || /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(lower);
}

/**
 * The TCP port a control-plane URL actually answers on.
 *
 * An explicit `:port` wins; otherwise the scheme default (443 for https, 80 for
 * everything else). This is what a k8s NetworkPolicy egress rule must open, so a
 * control plane fronted by a cluster Service on :80 — or any non-default
 * `MA_PORT` — is reachable rather than silently fenced off by a hardcoded port.
 * An unparseable URL falls back to 80 (an http-shaped default); the loopback
 * guard rejects such misconfigurations before a policy is ever built.
 */
export function controlPlanePort(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 80;
  }
}
