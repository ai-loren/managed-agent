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
import { idpConfigSchema, parseOrThrow, type IdpConfig } from '@ma/contracts';

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
    /**
     * How long the control plane waits on a dial to a sandbox's agent-core
     * (`/submit`, `/rebind`) before aborting. A wedged sandbox that accepts the
     * socket but never answers must not block a caller indefinitely — the abort
     * becomes a retryable failure so the delivery requeues rather than pinning the
     * serial worker. Both dials share this ceiling.
     */
    dialTimeoutMs: number;
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
    /**
     * The control plane's cluster-routable CIDR (k8s). A restricted-egress pod's
     * NetworkPolicy always permits this so the sandbox can reach its control
     * channel; without it, a restricted pod is refused rather than started unable
     * to bootstrap.
     */
    controlPlaneCidr?: string;
    /**
     * Control-plane **pod** CIDR — the source range for the sandbox's ingress
     * fence on the agent port (distinct from `controlPlaneCidr`, the egress
     * destination Service ClusterIP). MA_CONTROL_PLANE_INGRESS_CIDR.
     */
    controlPlaneIngressCidr?: string;
    /**
     * Root for platform-managed volumes. Absent (or `:memory:`) disables volume
     * mounts — a version that declares mounts is refused. Each workspace's
     * volumes live under `<root>/<workspaceId>/`.
     */
    volumeRoot?: string;
  };
  scheduler: {
    enabled: boolean;
    tickMs: number;
    batchSize: number;
    /** Days before an audit row may be pruned. 0 keeps the trail forever. */
    auditRetentionDays: number;
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
  /**
   * Two rate-limit tiers. `ip` runs before auth (an anonymous-flood shield,
   * bucketed by address); `principal` runs after auth (per-tenant fair-share,
   * bucketed by principal). See the gateway middleware for why the split exists.
   */
  rateLimit: {
    ip: { limit: number; windowMs: number };
    principal: { limit: number; windowMs: number };
  };
  /**
   * How a single model call is retried before the gateway fails over to the next
   * declared model. A transient provider blip on the requested model is worth a
   * bounded, backed-off retry in place. `attempts: 1` disables retry. Bounded and
   * short by default so it never threatens the turn deadline.
   */
  modelRetry: { attempts: number; baseDelayMs: number; maxDelayMs: number };
  /**
   * Circuit breaker for a sustained model outage. Once a model fails `threshold`
   * times within `windowMs`, the gateway skips it (no retry, no provider call)
   * for `resetMs`, then admits one probe. `enabled: false` turns it off. Stops
   * every session paying the retry budget against a provider known to be down.
   */
  modelBreaker: { enabled: boolean; threshold: number; windowMs: number; resetMs: number };
  /**
   * The upstream model provider the gateway calls on a sandbox's behalf. The
   * platform holds the provider credential (it never reaches a sandbox/tenant);
   * absent means no model is wired and agent turns that need a completion get
   * MODEL_GATEWAY_UNAVAILABLE. OpenRouter's OpenAI-compatible endpoint is the
   * supported provider and can front many vendors.
   */
  model: {
    provider: 'none' | 'openrouter';
    apiKey?: string;
    /** OpenAI-compatible base URL (defaults to https://openrouter.ai/api/v1). */
    baseUrl?: string;
    /**
     * Catalogued model ids, in order. The first is the default agents pin when
     * they name no model; each is upserted into the model catalogue at startup.
     */
    models: string[];
    /** Whether to advertise OpenAI function-calling tools to the model. */
    tools: boolean;
  };
  /** True when a reverse proxy in front of this process rewrites X-Forwarded-For. */
  trustForwardedFor: boolean;
  /**
   * OIDC identity-federation ("SSO") configuration. Absent means SSO is off and
   * the `/auth/v1/*` routes report no providers. Provider bindings are data;
   * each client secret is loaded separately from the environment, never a
   * config row.
   */
  sso?: {
    providers: IdpConfig[];
    /** Client secrets by providerId, from `MA_OIDC_<PROVIDER>_SECRET[_FILE]`. */
    clientSecrets: Record<string, string>;
    /**
     * When set, the login callback redirects the browser here with the token in
     * a URL fragment instead of returning JSON — for a browser console flow.
     */
    consoleLoginRedirect?: string;
  };
  /**
   * SCIM 2.0 provisioning. Absent means SCIM is off and the `/scim/v2/*` routes
   * refuse. The token is the IdP's bearer credential; `providerId` names which
   * OIDC provider SCIM provisions under, so a provisioned user and a later login
   * of the same person converge on one principal.
   */
  scim?: { token: string; providerId: string };
  /**
   * Metrics scraping. Absent means `/metrics` is disabled (returns 404-style
   * refusal), so a deployment that does not scrape exposes nothing. The token is
   * the scraper's bearer credential — a static secret, not a principal — so the
   * scrape path never touches the principal database.
   */
  metrics?: { token: string };
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

/**
 * Load OIDC provider bindings and their client secrets from the environment.
 *
 * `MA_OIDC_PROVIDERS` is a comma-separated list of provider slugs; each slug
 * `<S>` is configured by `MA_OIDC_<S>_*` variables. The binding is data,
 * validated through the contract schema so a malformed one refuses startup; the
 * client secret is loaded separately (`MA_OIDC_<S>_SECRET` or `_SECRET_FILE`),
 * never persisted, and its absence is refused rather than run as a public client.
 *
 * Absent `MA_OIDC_PROVIDERS` means SSO is off — the safe default.
 */
function loadSso(warnings: string[]): ServerConfig['sso'] | undefined {
  const list = env('MA_OIDC_PROVIDERS');
  if (!list) return undefined;

  const slugs = list
    .split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => slug.length > 0);
  if (slugs.length === 0) return undefined;

  const providers: IdpConfig[] = [];
  const clientSecrets: Record<string, string> = {};

  for (const slug of slugs) {
    const key = slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const prefix = `MA_OIDC_${key}`;
    const issuer = env(`${prefix}_ISSUER`);
    const clientId = env(`${prefix}_CLIENT_ID`);
    const redirectUri = env(`${prefix}_REDIRECT_URI`);
    if (!issuer || !clientId || !redirectUri) {
      throw validationError(
        `SSO provider '${slug}' needs ${prefix}_ISSUER, ${prefix}_CLIENT_ID and ${prefix}_REDIRECT_URI`,
      );
    }

    // The secret is a credential: from a file (preferred) or the environment,
    // never a config row and never argv.
    const secretFile = env(`${prefix}_SECRET_FILE`);
    const secret = secretFile ? readFileSync(secretFile, 'utf8').trim() : env(`${prefix}_SECRET`);
    if (!secret) {
      throw validationError(
        `SSO provider '${slug}' has no client secret (set ${prefix}_SECRET or ${prefix}_SECRET_FILE)`,
      );
    }

    // Parse the binding through the contract schema, so an http issuer, a bad
    // slug or a malformed group mapping is a startup refusal, not a login-time
    // surprise.
    const raw: Record<string, unknown> = {
      providerId: slug,
      issuer,
      clientId,
      redirectUri,
      ...(env(`${prefix}_DISPLAY_NAME`) ? { displayName: env(`${prefix}_DISPLAY_NAME`)! } : {}),
      ...(env(`${prefix}_DISCOVERY_URL`) ? { discoveryUrl: env(`${prefix}_DISCOVERY_URL`)! } : {}),
      ...(env(`${prefix}_SCOPES`)
        ? { scopes: env(`${prefix}_SCOPES`)!.split(/[ ,]+/).filter((s) => s.length > 0) }
        : {}),
      ...(env(`${prefix}_SUBJECT_CLAIM`) ? { subjectClaim: env(`${prefix}_SUBJECT_CLAIM`)! } : {}),
      ...(env(`${prefix}_EMAIL_CLAIM`) ? { emailClaim: env(`${prefix}_EMAIL_CLAIM`)! } : {}),
      ...(env(`${prefix}_NAME_CLAIM`) ? { nameClaim: env(`${prefix}_NAME_CLAIM`)! } : {}),
      ...(env(`${prefix}_GROUPS_CLAIM`) ? { groupsClaim: env(`${prefix}_GROUPS_CLAIM`)! } : {}),
      ...(env(`${prefix}_ALLOWED_DOMAINS`)
        ? {
            allowedEmailDomains: env(`${prefix}_ALLOWED_DOMAINS`)!
              .split(/[ ,]+/)
              .filter((d) => d.length > 0),
          }
        : {}),
      ...(env(`${prefix}_GROUP_MAP`) ? { groupRoleMappings: parseGroupMap(env(`${prefix}_GROUP_MAP`)!, slug) } : {}),
      ...(env(`${prefix}_AUTO_CREATE`) !== undefined
        ? { autoCreatePrincipals: env(`${prefix}_AUTO_CREATE`) !== 'false' }
        : {}),
      ...(env(`${prefix}_SESSION_TTL`)
        ? { sessionTtlSeconds: intEnv(`${prefix}_SESSION_TTL`, 28_800) }
        : {}),
    };

    const provider = parseOrThrow(idpConfigSchema, raw);
    providers.push(provider);
    clientSecrets[slug] = secret;

    // A shared IdP with no domain gate lets any account there log in. That is
    // sometimes intended (a single-tenant Okta), so warn rather than refuse.
    if (provider.allowedEmailDomains.length === 0) {
      warnings.push(
        `SSO provider '${slug}' has no ${prefix}_ALLOWED_DOMAINS: any user the IdP authenticates may log in. ` +
          `Set it for a shared IdP (e.g. Google).`,
      );
    }
  }

  return {
    providers,
    clientSecrets,
    ...(env('MA_OIDC_CONSOLE_REDIRECT')
      ? { consoleLoginRedirect: env('MA_OIDC_CONSOLE_REDIRECT')! }
      : {}),
  };
}

/** Parse `group:workspaceId:role;group2:ws2:role2` into group→role mappings. */
function parseGroupMap(raw: string, slug: string): { group: string; workspaceId: string; role: string }[] {
  const mappings: { group: string; workspaceId: string; role: string }[] = [];
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [group, workspaceId, role] = trimmed.split(':');
    if (!group || !workspaceId || !role) {
      throw validationError(
        `MA_OIDC_${slug.toUpperCase()}_GROUP_MAP entry '${trimmed}' must be 'group:workspaceId:role'`,
      );
    }
    mappings.push({ group, workspaceId, role });
  }
  return mappings;
}

/**
 * Load SCIM provisioning config: a bearer token and the OIDC provider it
 * provisions under.
 *
 * `MA_SCIM_TOKEN` (or `_FILE`) enables SCIM; `MA_SCIM_PROVIDER` names the OIDC
 * provider slug SCIM shares a subject space with, so a provisioned user and a
 * later login converge on one principal. Both are required together, and the
 * provider must actually be a configured SSO provider — otherwise SCIM would
 * provision into a namespace no login can ever match, which is a silent
 * misconfiguration worth refusing at startup.
 */
function loadScim(config: ServerConfig, warnings: string[]): ServerConfig['scim'] | undefined {
  const tokenFile = env('MA_SCIM_TOKEN_FILE');
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : env('MA_SCIM_TOKEN');
  if (!token) return undefined;

  const providerId = env('MA_SCIM_PROVIDER');
  if (!providerId) {
    throw validationError(
      'MA_SCIM_PROVIDER is required when MA_SCIM_TOKEN is set: it names the OIDC provider SCIM ' +
        'provisions under, so a provisioned user and a later login resolve to one principal.',
    );
  }
  const known = (config.sso?.providers ?? []).some((provider) => provider.providerId === providerId);
  if (!known) {
    // Refuse rather than provision into a namespace no login can reach. If a
    // deployment genuinely wants SCIM without interactive login, that is a
    // deliberate choice to make explicit later; the safe default is to catch the
    // typo.
    throw validationError(
      `MA_SCIM_PROVIDER '${providerId}' is not a configured OIDC provider (MA_OIDC_PROVIDERS). ` +
        'SCIM must provision under a provider that login also uses, or provisioned users can never sign in.',
    );
  }
  // A short SCIM token is a weak shared secret on a powerful surface (it can
  // deactivate any provisioned user); warn if it looks low-entropy.
  if (token.length < 24) {
    warnings.push('MA_SCIM_TOKEN is short; use a long random value — it can deactivate any provisioned user.');
  }
  return { token, providerId };
}

/**
 * Load the metrics-scrape token. Enables `/metrics` when set. `_FILE` variant
 * preferred, like every other secret. No provider or cross-check — a scrape
 * token stands alone.
 */
function loadMetrics(warnings: string[]): ServerConfig['metrics'] | undefined {
  const tokenFile = env('MA_METRICS_TOKEN_FILE');
  const token = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : env('MA_METRICS_TOKEN');
  if (!token) return undefined;
  if (token.length < 24) {
    warnings.push('MA_METRICS_TOKEN is short; use a long random value — it authorizes reading platform metrics.');
  }
  return { token };
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
      dialTimeoutMs: intEnv('MA_SANDBOX_DIAL_TIMEOUT_MS', 30_000),
      ...(env('MA_AGENT_COMMAND') ? { agentCommand: env('MA_AGENT_COMMAND')! } : {}),
      ...(env('MA_AGENT_ARGS') ? { agentArgs: env('MA_AGENT_ARGS')!.split(' ') } : {}),
      ...(env('MA_EGRESS_PROXY') ? { egressProxy: env('MA_EGRESS_PROXY')! } : {}),
      ...(env('MA_INTERNAL_NETWORK') ? { internalNetwork: env('MA_INTERNAL_NETWORK')! } : {}),
      ...(env('MA_K8S_NAMESPACE') ? { k8sNamespace: env('MA_K8S_NAMESPACE')! } : {}),
      ...(env('MA_EGRESS_PROXY_CIDR') ? { egressProxyCidr: env('MA_EGRESS_PROXY_CIDR')! } : {}),
      ...(env('MA_DNS_CIDR') ? { dnsCidr: env('MA_DNS_CIDR')! } : {}),
      ...(env('MA_CONTROL_PLANE_CIDR') ? { controlPlaneCidr: env('MA_CONTROL_PLANE_CIDR')! } : {}),
      ...(env('MA_CONTROL_PLANE_INGRESS_CIDR')
        ? { controlPlaneIngressCidr: env('MA_CONTROL_PLANE_INGRESS_CIDR')! }
        : {}),
      ...(env('MA_VOLUME_ROOT') ? { volumeRoot: env('MA_VOLUME_ROOT')! } : {}),
    },
    scheduler: {
      enabled: env('MA_SCHEDULER') !== 'off',
      tickMs: intEnv('MA_SCHEDULER_TICK_MS', 5000),
      batchSize: intEnv('MA_SCHEDULER_BATCH', 10),
      auditRetentionDays: intEnv('MA_AUDIT_RETENTION_DAYS', 0),
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
      // Per-principal (post-auth) fair-share. MA_RATE_LIMIT keeps its meaning.
      principal: {
        limit: intEnv('MA_RATE_LIMIT', 600),
        windowMs: intEnv('MA_RATE_WINDOW_MS', 60_000),
      },
      // Per-IP (pre-auth) flood shield. Coarser: one address fronts many tenants.
      ip: {
        limit: intEnv('MA_RATE_LIMIT_IP', 3_000),
        windowMs: intEnv('MA_RATE_WINDOW_IP_MS', 60_000),
      },
    },
    modelRetry: {
      attempts: intEnv('MA_MODEL_RETRY_ATTEMPTS', 3),
      baseDelayMs: intEnv('MA_MODEL_RETRY_BASE_MS', 250),
      maxDelayMs: intEnv('MA_MODEL_RETRY_MAX_MS', 2000),
    },
    modelBreaker: {
      enabled: env('MA_MODEL_BREAKER_ENABLED') !== 'false',
      threshold: intEnv('MA_MODEL_BREAKER_THRESHOLD', 5),
      windowMs: intEnv('MA_MODEL_BREAKER_WINDOW_MS', 30_000),
      resetMs: intEnv('MA_MODEL_BREAKER_RESET_MS', 30_000),
    },
    model: (() => {
      const apiKey = env('MA_OPENROUTER_API_KEY')?.trim();
      // Comma-separated catalogued model ids. Free models end in `:free`.
      const requested = (env('MA_OPENROUTER_MODELS') ?? env('MA_OPENROUTER_MODEL') ?? '')
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      const baseUrl = env('MA_OPENROUTER_BASE_URL')?.trim() || undefined;
      const tools = env('MA_MODEL_TOOLS') !== 'false';
      // Default deployment is restricted to free models. An operator opts into
      // paid models explicitly; paid ids are otherwise dropped with a warning so
      // a misconfigured catalog cannot quietly spend money.
      const allowPaid = env('MA_OPENROUTER_ALLOW_PAID') === 'true';
      const models = allowPaid
        ? requested
        : requested.filter((m) => {
            if (m.endsWith(':free')) return true;
            warnings.push(`model '${m}' is not a free model; omitted (set MA_OPENROUTER_ALLOW_PAID=true to allow paid models)`);
            return false;
          });
      if (apiKey && requested.length > 0 && models.length === 0) {
        warnings.push('all catalogued models were paid and free-only mode is on; wire one via the model discovery API or set MA_OPENROUTER_ALLOW_PAID=true');
      }
      // With a key, the provider is wired even with no model catalogued yet: the
      // free-model discovery endpoints need it, and an operator's first step may
      // well be "show me what free models exist, then register one". A session
      // still cannot run a turn until a model is registered and pinned, so this
      // widens nothing — it only removes the chicken-and-egg between discovery
      // and the catalogue.
      if (apiKey) {
        return { provider: 'openrouter' as const, apiKey, ...(baseUrl ? { baseUrl } : {}), models, tools };
      }
      return { provider: 'none' as const, models, tools };
    })(),
    // Opt-in: only true when a proxy actually rewrites the header. Defaulting
    // this on would let any caller pick its own rate-limit bucket and forge the
    // source address recorded in the audit trail.
    trustForwardedFor: env('MA_TRUST_PROXY') === 'true',
    ...(bootstrapToken
      ? { bootstrap: { subject: env('MA_BOOTSTRAP_SUBJECT') ?? 'admin', token: bootstrapToken } }
      : {}),
  };

  const sso = loadSso(warnings);
  if (sso) config.sso = sso;

  const scim = loadScim(config, warnings);
  if (scim) config.scim = scim;

  const metrics = loadMetrics(warnings);
  if (metrics) config.metrics = metrics;

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
