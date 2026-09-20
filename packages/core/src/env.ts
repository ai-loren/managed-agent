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
 * dressed as configuration. The interpreter startup-load vars are enumerated per
 * language because each interpreter reads its own: Node (`NODE_OPTIONS`,
 * `NODE_PATH`), Python (`PYTHONPATH`, `PYTHONSTARTUP`), Ruby (`RUBYOPT`), Perl
 * (`PERL5OPT`) — all load arbitrary code before our code runs. Missing one is a
 * hole in exactly this control, so the set tracks the interpreters a polyglot
 * runtime image may ship.
 */
const RESERVED = [
  /^MA_/,
  /^PATH$/,
  /^HOME$/,
  /^LD_/,
  /^DYLD_/,
  /^NODE_OPTIONS$/,
  /^NODE_PATH$/,
  /^PYTHONSTARTUP$/,
  /^PYTHONPATH$/,
  /^RUBYOPT$/,
  /^PERL5OPT$/,
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
 * The environment-variable name a credential is materialised under.
 *
 * A credential named `github-token` becomes `MA_CRED_GITHUB_TOKEN` (and, for a
 * file/ssh_key credential, `MA_CRED_GITHUB_TOKEN_FILE` — the path form). The
 * normalisation is lossy (`[^A-Z0-9] -> _`), so distinct names can collide onto
 * one key; `credentialEnvKeys` returns both forms so a caller can reject a name
 * that would clash with another credential's key before either silently
 * overwrites the other at materialisation. Single source of truth: every place
 * that materialises a credential env (agent-core cold/rebind, the drivers) derives
 * the name from here rather than re-implementing the transform and risking drift.
 */
export function credentialEnvName(name: string): string {
  return `MA_CRED_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Both env-key forms a credential name can occupy: the value key and the `_FILE` path key. */
export function credentialEnvKeys(name: string): { value: string; file: string } {
  const base = credentialEnvName(name);
  return { value: base, file: `${base}_FILE` };
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
/**
 * Whether a `JSON.parse` result is a usable env_vars object: a non-null,
 * non-array object. `JSON.parse` succeeds on `null`, numbers, booleans, strings
 * and arrays — none of which are a `{key: value}` map — so callers that parse an
 * env_vars credential must check this before merging, or `Object.entries` will
 * throw on `null` and spread a string/array as numeric-keyed garbage.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeEnvVars(env: Record<string, string>, parsed: Record<string, string>): void {
  // Defense in depth: a non-object (null/array/scalar) has no entries to merge
  // and `Object.entries(null)` would throw — ignore it here so a caller that
  // forgot to shape-check cannot crash. Callers still shape-check to decide
  // whether a bad value is fatal (provision) or skippable (rebind).
  if (!isPlainObject(parsed)) return;
  for (const [key, value] of Object.entries(parsed)) {
    Object.defineProperty(env, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}
