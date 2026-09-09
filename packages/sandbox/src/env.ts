/**
 * Environment sanitisation for sandbox provisioning.
 *
 * Credential-supplied variables reach a driver from an `env_vars` credential,
 * whose contents any workspace member with credential access controls. Ordering
 * the spread so platform variables win is most of the fix; this removes the
 * keys that would be dangerous even without an override, because an interpreter
 * inside the sandbox reads them before any of our code runs.
 */

/**
 * Names a credential may never set.
 *
 * `MA_*` is ours. The rest change how a process loads code — `LD_PRELOAD` and
 * `NODE_OPTIONS` are executed by the loader itself, so they are code execution
 * dressed as configuration.
 */
const RESERVED = [
  /^MA_/,
  /^PATH$/,
  /^HOME$/,
  /^LD_/,
  /^DYLD_/,
  /^NODE_OPTIONS$/,
  /^PYTHONSTARTUP$/,
  /^PYTHONPATH$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^IFS$/,
  // Proxy variables are the platform's egress control, not a credential's to
  // set. A credential-supplied HTTP_PROXY could redirect a "filtered" sandbox's
  // traffic to an attacker's proxy, and an empty NO_PROXY could punch a hole in
  // the allowlist. Both casings, since clients read either.
  /^(HTTP|HTTPS|NO|ALL)_PROXY$/i,
];

/** Drop reserved keys from a credential-supplied environment. */
export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (RESERVED.some((pattern) => pattern.test(key))) continue;
    safe[key] = value;
  }
  return safe;
}

/** Reserved keys present in an environment, for reporting to an operator. */
export function reservedKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => RESERVED.some((pattern) => pattern.test(key)));
}
