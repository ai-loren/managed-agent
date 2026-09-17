/**
 * Environment trust helpers shared across the platform.
 *
 * A credential-supplied environment (an `env_vars` credential) is authored by
 * any workspace member with credential access, so its keys are untrusted: they
 * must not shadow platform variables, set reserved names an interpreter reads
 * before our code runs, or pollute the map's prototype. These pure helpers
 * enforce that boundary and live in `@ma/core` so every place that materialises
 * such an environment — the sandbox drivers at provision time, the server's
 * provisioner, and agent-core on rebind — applies exactly the same rules rather
 * than each carrying its own copy.
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
  // the allowlist. Match the proxy *class* (any `*_PROXY`), not an enumeration,
  // so FTP_PROXY and any future variant are covered too. Both casings.
  /_PROXY$/i,
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

/**
 * Merge an env_vars credential's parsed contents into an env map.
 *
 * Deliberately per-key via `defineProperty` rather than `Object.assign(env,
 * parsed)`. The credential JSON is attacker-controlled — any workspace member
 * with credential-create access authors it — and `Object.assign` uses `[[Set]]`,
 * so an object-valued `__proto__` key would reparent `env` (prototype pollution
 * from parsed input). `defineProperty` always creates an ordinary own data
 * property, so a `__proto__`/`constructor`/`prototype` key stays inert data and
 * cannot poison the object's prototype chain. `sanitizeEnv` downstream already
 * reads only own-enumerable keys, so this is defense in depth against a future
 * consumer that does a dynamic lookup on `env`.
 */
export function mergeEnvVars(env: Record<string, string>, parsed: Record<string, string>): void {
  for (const [key, value] of Object.entries(parsed)) {
    Object.defineProperty(env, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
