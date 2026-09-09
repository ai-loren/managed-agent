/**
 * Configuration.
 *
 * Read once at startup and validated immediately, so a misconfiguration is a
 * refusal to start rather than a failure on the first request that happens to
 * need the missing value.
 *
 * Secrets come from the environment or a file, never from a command-line
 * argument — argv is readable by every process on the host.
 */

import { readFileSync } from 'node:fs';

import { InMemoryKeyProvider, validationError, type KeyProvider } from '@ma/core';

export interface ServerConfig {
  host: string;
  port: number;
  /** Where the SQLite database lives; `:memory:` for an ephemeral run. */
  databaseUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Base URL a sandbox uses to call back. */
  controlPlaneUrl: string;
  corsOrigins: string[];
  /** Master keys for credential encryption, by version. */
  encryptionKeys: KeyProvider;
  sandbox: {
    driver: 'local' | 'container' | 'k8s';
    /** Container CLI, when the driver is `container`. */
    containerBinary?: string;
    leaseSeconds: number;
    prewarmPerPool: number;
    /** Command the local driver runs as an agent core. */
    agentCommand?: string;
    agentArgs?: string[];
    /** Filtering egress proxy that enforces an allowlist, when the driver is `container`. */
    egressProxy?: string;
    /** Egress-less container network joined when proxy-filtered. */
    internalNetwork?: string;
    /** Namespace for sandbox pods, when the driver is `k8s`. */
    k8sNamespace?: string;
    /** The egress proxy's CIDR, for the k8s NetworkPolicy `to` scope. */
    egressProxyCidr?: string;
    /** The DNS resolver's CIDR, for a proxied k8s pod's name resolution. */
    dnsCidr?: string;
  };
  scheduler: {
    enabled: boolean;
    tickMs: number;
    batchSize: number;
  };
  artifacts: {
    /** Directory for artifact bytes. `:memory:` keeps them in the process. */
    root: string;
    /** Largest single artifact, in MB. */
    maxMb: number;
    /** Days before an artifact's bytes may be reclaimed. 0 keeps them. */
    retentionDays: number;
    /**
     * A distinct origin agent-authored content is rendered from, e.g.
     * `https://artifacts.example.com`. Absent disables preview — there is no
     * safe same-origin preview of untrusted content.
     */
    previewOrigin?: string;
    /** The console's origin, named in the preview CSP's `frame-ancestors`. */
    consoleOrigin?: string;
  };
  rateLimit: { limit: number; windowMs: number };
  /** True when a reverse proxy in front of this process rewrites X-Forwarded-For. */
  trustForwardedFor: boolean;
  /**
   * Bootstrap credentials for the first admin. Only used when the store has no
   * principals; a running deployment ignores them.
   */
  bootstrap?: { subject: string; token: string };
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw validationError(`${name} must be an integer, got '${raw}'`);
  }
  return parsed;
}

/**
 * Load the encryption keys.
 *
 * `MA_ENCRYPTION_KEYS` is `version=base64,version=base64`. In development a key
 * is generated if none is set, with a loud warning: a generated key means every
 * stored credential becomes unreadable on restart, which is fine for a laptop
 * and catastrophic in production.
 */
function loadKeys(): { keys: KeyProvider; generated: boolean } {
  const raw = env('MA_ENCRYPTION_KEYS');
  if (!raw) {
    if (env('NODE_ENV') === 'production') {
      throw validationError(
        'MA_ENCRYPTION_KEYS is required in production; without it credentials cannot survive a restart',
      );
    }
    return { keys: InMemoryKeyProvider.generate('dev'), generated: true };
  }

  const keys: Record<string, string> = {};
  let current = '';
  for (const entry of raw.split(',')) {
    const [version, material] = entry.split('=');
    if (!version || !material) {
      throw validationError("MA_ENCRYPTION_KEYS must be 'version=base64key' pairs");
    }
    keys[version.trim()] = material.trim();
    current = version.trim();
  }

  // The last entry is the current key, so rotating means appending a new one
  // while keeping the old ones readable.
  return { keys: new InMemoryKeyProvider(keys, env('MA_ENCRYPTION_KEY_VERSION') ?? current), generated: false };
}

export function loadConfig(): { config: ServerConfig; warnings: string[] } {
  const warnings: string[] = [];
  const { keys, generated } = loadKeys();

  if (generated) {
    warnings.push(
      'No MA_ENCRYPTION_KEYS set: generated an ephemeral key. Every stored credential will be unreadable after a restart.',
    );
  }

  const bootstrapTokenFile = env('MA_BOOTSTRAP_TOKEN_FILE');
  const bootstrapToken = bootstrapTokenFile
    ? readFileSync(bootstrapTokenFile, 'utf8').trim()
    : env('MA_BOOTSTRAP_TOKEN');

  const config: ServerConfig = {
    host: env('MA_HOST') ?? '127.0.0.1',
    port: intEnv('MA_PORT', 8080),
    databaseUrl: env('MA_DATABASE') ?? './data/managed-agent.db',
    logLevel: (env('MA_LOG_LEVEL') ?? 'info') as ServerConfig['logLevel'],
    controlPlaneUrl: env('MA_CONTROL_PLANE_URL') ?? `http://127.0.0.1:${intEnv('MA_PORT', 8080)}`,
    corsOrigins: (env('MA_CORS_ORIGINS') ?? '').split(',').filter((origin) => origin.length > 0),
    encryptionKeys: keys,
    sandbox: {
      driver: (env('MA_SANDBOX_DRIVER') ?? 'local') as 'local' | 'container' | 'k8s',
      ...(env('MA_CONTAINER_BINARY') ? { containerBinary: env('MA_CONTAINER_BINARY')! } : {}),
      leaseSeconds: intEnv('MA_SANDBOX_LEASE_SECONDS', 120),
      prewarmPerPool: intEnv('MA_SANDBOX_PREWARM', 0),
      ...(env('MA_AGENT_COMMAND') ? { agentCommand: env('MA_AGENT_COMMAND')! } : {}),
      ...(env('MA_AGENT_ARGS') ? { agentArgs: env('MA_AGENT_ARGS')!.split(' ') } : {}),
      ...(env('MA_EGRESS_PROXY') ? { egressProxy: env('MA_EGRESS_PROXY')! } : {}),
      ...(env('MA_INTERNAL_NETWORK') ? { internalNetwork: env('MA_INTERNAL_NETWORK')! } : {}),
      ...(env('MA_K8S_NAMESPACE') ? { k8sNamespace: env('MA_K8S_NAMESPACE')! } : {}),
      ...(env('MA_EGRESS_PROXY_CIDR') ? { egressProxyCidr: env('MA_EGRESS_PROXY_CIDR')! } : {}),
      ...(env('MA_DNS_CIDR') ? { dnsCidr: env('MA_DNS_CIDR')! } : {}),
    },
    scheduler: {
      enabled: env('MA_SCHEDULER') !== 'off',
      tickMs: intEnv('MA_SCHEDULER_TICK_MS', 5000),
      batchSize: intEnv('MA_SCHEDULER_BATCH', 10),
    },
    artifacts: {
      root: env('MA_ARTIFACT_ROOT') ?? './data/artifacts',
      maxMb: intEnv('MA_ARTIFACT_MAX_MB', 25),
      // Off by default: silently deleting a user's output after N days is the
      // kind of thing an operator should choose, not inherit.
      retentionDays: intEnv('MA_ARTIFACT_RETENTION_DAYS', 0),
      ...(env('MA_PREVIEW_ORIGIN') ? { previewOrigin: env('MA_PREVIEW_ORIGIN')! } : {}),
      ...(env('MA_CONSOLE_ORIGIN') ? { consoleOrigin: env('MA_CONSOLE_ORIGIN')! } : {}),
    },
    rateLimit: {
      limit: intEnv('MA_RATE_LIMIT', 600),
      windowMs: intEnv('MA_RATE_WINDOW_MS', 60_000),
    },
    // Opt-in: only true when a proxy actually rewrites the header. Defaulting
    // this on would let any caller pick its own rate-limit bucket and forge the
    // source address recorded in the audit trail.
    trustForwardedFor: env('MA_TRUST_PROXY') === 'true',
    ...(bootstrapToken
      ? { bootstrap: { subject: env('MA_BOOTSTRAP_SUBJECT') ?? 'admin', token: bootstrapToken } }
      : {}),
  };

  if (config.corsOrigins.includes('*') && env('NODE_ENV') === 'production') {
    warnings.push('MA_CORS_ORIGINS is "*" in production: any site can call this API from a browser.');
  }
  if (config.host === '0.0.0.0' && config.corsOrigins.length === 0) {
    warnings.push('Listening on all interfaces. Ensure something in front of this enforces TLS.');
  }
  // The whole point of a preview origin is that it is *not* the API/console
  // origin: if they coincide, agent-authored content renders with the operator's
  // session again. Refuse rather than warn — a preview that reads as isolated
  // and is not is worse than no preview.
  // The whole point of a preview origin is that it is *not* the origin the
  // operator's session lives on. If it coincides with the console origin, agent
  // content renders with that session again — exactly the risk preview
  // isolation exists to prevent. Refuse rather than warn: a preview that reads
  // as isolated and is not is worse than no preview.
  //
  // The console origin is the load-bearing comparison. `controlPlaneUrl` is the
  // *internal* sandbox-callback URL (default http://127.0.0.1:8080), not the
  // public API/console address, so comparing against it would miss the real
  // case; the console origin is where the operator's session actually is.
  if (config.artifacts.previewOrigin) {
    const previewOrigin = safeOrigin(config.artifacts.previewOrigin);
    const consoleOrigin = config.artifacts.consoleOrigin
      ? safeOrigin(config.artifacts.consoleOrigin)
      : undefined;

    // The console origin is required whenever preview is enabled. It is the
    // load-bearing comparison — the origin the operator's session actually lives
    // on — and without it the check below would be inert: `controlPlaneUrl` is
    // the *internal* callback URL (default loopback), never the public origin,
    // so a preview origin equal to the real public console/API origin would
    // slip through unnoticed. Requiring it means the isolation check always runs
    // against the origin that matters, rather than silently doing nothing.
    if (consoleOrigin === undefined) {
      throw validationError(
        'MA_CONSOLE_ORIGIN must be set when MA_PREVIEW_ORIGIN is: it is the origin preview ' +
          'content must be isolated from, and without it that isolation cannot be verified.',
      );
    }

    if (previewOrigin !== undefined && previewOrigin === consoleOrigin) {
      throw validationError(
        'MA_PREVIEW_ORIGIN must differ from MA_CONSOLE_ORIGIN, or agent-authored content ' +
          'would render with the console’s session — the exact risk preview isolation prevents.',
      );
    }
    // Also refuse coincidence with the control-plane origin when that origin is
    // a real network address rather than loopback: some deployments serve the
    // API and console from one host, and a preview there is unsafe too.
    const apiOrigin = safeOrigin(config.controlPlaneUrl);
    if (
      previewOrigin !== undefined &&
      previewOrigin === apiOrigin &&
      apiOrigin !== undefined &&
      !/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(apiOrigin)
    ) {
      throw validationError(
        'MA_PREVIEW_ORIGIN must differ from the API origin, or agent content would render ' +
          'with the console’s session — the exact risk preview isolation exists to prevent.',
      );
    }
  }

  return { config, warnings };
}

/** The origin of a URL, or undefined if it cannot be parsed. */
function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
