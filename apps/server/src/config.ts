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
    driver: 'local' | 'container';
    /** Container CLI, when the driver is `container`. */
    containerBinary?: string;
    leaseSeconds: number;
    prewarmPerPool: number;
    /** Command the local driver runs as an agent core. */
    agentCommand?: string;
    agentArgs?: string[];
  };
  scheduler: {
    enabled: boolean;
    tickMs: number;
    batchSize: number;
  };
  rateLimit: { limit: number; windowMs: number };
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
      driver: (env('MA_SANDBOX_DRIVER') ?? 'local') as 'local' | 'container',
      ...(env('MA_CONTAINER_BINARY') ? { containerBinary: env('MA_CONTAINER_BINARY')! } : {}),
      leaseSeconds: intEnv('MA_SANDBOX_LEASE_SECONDS', 120),
      prewarmPerPool: intEnv('MA_SANDBOX_PREWARM', 0),
      ...(env('MA_AGENT_COMMAND') ? { agentCommand: env('MA_AGENT_COMMAND')! } : {}),
      ...(env('MA_AGENT_ARGS') ? { agentArgs: env('MA_AGENT_ARGS')!.split(' ') } : {}),
    },
    scheduler: {
      enabled: env('MA_SCHEDULER') !== 'off',
      tickMs: intEnv('MA_SCHEDULER_TICK_MS', 5000),
      batchSize: intEnv('MA_SCHEDULER_BATCH', 10),
    },
    rateLimit: {
      limit: intEnv('MA_RATE_LIMIT', 600),
      windowMs: intEnv('MA_RATE_WINDOW_MS', 60_000),
    },
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

  return { config, warnings };
}
