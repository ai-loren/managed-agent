/**
 * OIDC identity federation ("third-party SSO").
 *
 * This is the one code path that turns an *external* identity into a platform
 * principal. It deliberately changes nothing about how the platform then makes
 * decisions: the login flow ends by minting an ordinary API-key-shaped session
 * token, so the existing bearer middleware, the `RoleAuthorizer`, scopes and
 * workspace membership all apply unchanged. SSO is an additional way to obtain a
 * token, not a second authorization model.
 *
 * Every IdP-specific value is data (an `IdpConfig`), so Okta, Auth0, Google,
 * Azure AD and Keycloak are reachable without provider-specific code. The client
 * secret is the one thing that is not config data — it is injected like an
 * encryption key, never persisted in a config row.
 *
 * The security of the whole feature is three checks, and the file is organised
 * around making them impossible to skip:
 *   1. The ID token's signature verifies against the IdP's published JWKS, using
 *      an algorithm from a strict allowlist (never `none`, never a symmetric alg
 *      an attacker could forge with the public key).
 *   2. Its `iss`/`aud`/`exp`/`iat`/`nonce` claims match what we expect.
 *   3. The `state` we issued round-trips intact (CSRF), carrying the `nonce` and
 *      PKCE `code_verifier` we generated — sealed, so the browser cannot forge
 *      or read it.
 * A failure at any step refuses the login rather than degrading it.
 */

import {
  MaError,
  hashToken,
  hmacSha256Hex,
  newId,
  randomToken,
  safeEqual,
  seal,
  sha256Hex,
  unseal,
  type Clock,
  type KeyProvider,
  type Logger,
} from '@ma/core';
import type { IdpConfig, Principal, Workspace } from '@ma/contracts';
import { isSecureOrLoopbackUrl } from '@ma/contracts';
import { createHash, createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { Buffer } from 'node:buffer';

import type { Store } from '@ma/store';

import { federatedSubject } from './federation.ts';

/**
 * The minimal fetch surface the service needs, injected so tests drive the IdP
 * without a network. Matches the global `fetch` signature closely enough that
 * the real one is assignable.
 */
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface OidcServiceDeps {
  clock: Clock;
  keys: KeyProvider;
  store: Store;
  logger?: Logger;
  /** IdP bindings, keyed by `providerId`. Empty means SSO is off. */
  providers: readonly IdpConfig[];
  /**
   * Client secrets by `providerId`. A provider with no secret here is
   * confidential-client misconfigured and refused at login, never run as a
   * public client by accident.
   */
  clientSecrets: Readonly<Record<string, string>>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** How long a discovery/JWKS document is cached. */
  metadataTtlSeconds?: number;
}

/** The result of a completed login: a token to give the browser, and who it is. */
export interface LoginResult {
  /** The plaintext session token — shown once, then only its hash is stored. */
  token: string;
  principal: Principal;
  expiresAt: number;
  /** Where the caller asked to return to, if it passed a safe `returnTo`. */
  returnTo?: string;
}

/** What `begin` produces: the URL to send the browser to, and the state cookie. */
export interface AuthorizationRedirect {
  /** The IdP authorization URL, fully formed. */
  url: string;
  /** The sealed state to set as a cookie and require back on the callback. */
  state: string;
}

/** OIDC provider metadata, the subset the flow uses. */
interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

/** A JSON Web Key, the fields used to import a verification key. */
interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

interface CachedMetadata {
  metadata: ProviderMetadata;
  fetchedAt: number;
}

interface CachedJwks {
  keys: Jwk[];
  fetchedAt: number;
  /** Monotonic time of the last forced refetch, to rate-limit unknown-kid refetches. */
  lastRefetchAt: number;
}

/**
 * The signature algorithms we accept, mapped to how `node:crypto` verifies them.
 *
 * Asymmetric only. `HS256` and friends are absent on purpose: an HMAC alg would
 * be verified with the JWKS *public* key as its secret, which an attacker also
 * has — the classic algorithm-confusion forgery. `none` is absent for the
 * obvious reason. An IdP that signs with anything outside this set is refused
 * rather than trusted.
 */
const ALG_VERIFY: Readonly<Record<string, { nodeAlg: string; dsaEncoding?: 'ieee-p1363' }>> = {
  RS256: { nodeAlg: 'RSA-SHA256' },
  RS384: { nodeAlg: 'RSA-SHA384' },
  RS512: { nodeAlg: 'RSA-SHA512' },
  ES256: { nodeAlg: 'SHA256', dsaEncoding: 'ieee-p1363' },
  ES384: { nodeAlg: 'SHA384', dsaEncoding: 'ieee-p1363' },
  ES512: { nodeAlg: 'SHA512', dsaEncoding: 'ieee-p1363' },
};

const DEFAULT_METADATA_TTL_SECONDS = 3600;
/** A stale JWKS is refetched at most this often when a token names an unknown kid. */
const MIN_REFETCH_INTERVAL_MS = 60_000;
/** Small leeway for clock skew between us and the IdP, in seconds. */
const CLOCK_SKEW_SECONDS = 60;
const FETCH_TIMEOUT_MS = 10_000;

export class OidcService {
  readonly #clock: Clock;
  readonly #keys: KeyProvider;
  readonly #store: Store;
  readonly #logger: Logger | undefined;
  readonly #providers: Map<string, IdpConfig>;
  readonly #secrets: Readonly<Record<string, string>>;
  readonly #fetch: FetchLike;
  readonly #metadataTtlMs: number;

  readonly #metadataCache = new Map<string, CachedMetadata>();
  readonly #jwksCache = new Map<string, CachedJwks>();

  constructor(deps: OidcServiceDeps) {
    this.#clock = deps.clock;
    this.#keys = deps.keys;
    this.#store = deps.store;
    this.#logger = deps.logger;
    this.#providers = new Map(deps.providers.map((provider) => [provider.providerId, provider]));
    this.#secrets = deps.clientSecrets;
    this.#fetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#metadataTtlMs = (deps.metadataTtlSeconds ?? DEFAULT_METADATA_TTL_SECONDS) * 1000;
  }

  /** Whether any IdP is configured. */
  get enabled(): boolean {
    return this.#providers.size > 0;
  }

  /** The configured providers, for a login-page listing. Never exposes secrets. */
  listProviders(): { providerId: string; displayName: string }[] {
    return [...this.#providers.values()].map((provider) => ({
      providerId: provider.providerId,
      displayName: provider.displayName || provider.providerId,
    }));
  }

  /**
   * Begin a login: build the IdP authorization URL and the sealed state.
   *
   * The state is a sealed blob — the browser gets it as an opaque cookie and
   * echoes it back, but cannot read or forge it. It carries the CSRF token, the
   * OIDC `nonce`, and the PKCE `code_verifier`, all bound to this provider and an
   * expiry, so a callback can only complete a login this same service started.
   */
  begin(providerId: string, returnTo?: string): AuthorizationRedirect {
    const provider = this.#requireProvider(providerId);
    const secret = this.#requireSecret(providerId);
    void secret; // presence is required now; the value is used at token exchange.

    const now = this.#clock.now();
    const nonce = randomToken(16);
    const codeVerifier = randomToken(32);
    const safeReturn = safeReturnTo(returnTo);

    // Sealed with the platform KEK and AAD-bound to the provider, so a state
    // minted for one provider cannot be replayed against another. The sealed
    // blob is itself the CSRF token: it is high-entropy and unforgeable (a random
    // GCM IV plus the random nonce/verifier within), and the callback's
    // double-submit check — the state query param must equal the state cookie —
    // is what defeats login-CSRF. No separate CSRF field is needed or kept.
    const statePayload = JSON.stringify({
      v: 1,
      p: providerId,
      nonce,
      cv: codeVerifier,
      exp: now + 10 * 60 * 1000, // a login must complete within ten minutes
      ...(safeReturn ? { rt: safeReturn } : {}),
    });
    const sealed = seal(statePayload, this.#keys, `oidc-state:${providerId}`);
    const state = Buffer.from(JSON.stringify(sealed), 'utf8').toString('base64url');

    const metadata = this.#metadataCache.get(providerId)?.metadata;
    // The authorization endpoint is needed synchronously to build the redirect;
    // if metadata is not yet cached, the caller awaits `beginAsync` instead.
    if (!metadata) {
      throw new MaError({
        code: 'OIDC_METADATA_NOT_READY',
        category: 'internal',
        message: 'Provider metadata is not cached yet; call beginAsync',
      });
    }
    return { url: this.#buildAuthUrl(provider, metadata, { nonce, codeVerifier, state }), state };
  }

  /**
   * Begin a login, fetching provider metadata first if it is not cached. This is
   * the entry point a route calls; `begin` is the synchronous core once metadata
   * is warm.
   */
  async beginAsync(providerId: string, returnTo?: string): Promise<AuthorizationRedirect> {
    const provider = this.#requireProvider(providerId);
    this.#requireSecret(providerId);
    await this.#metadata(provider); // warm the cache
    return this.begin(providerId, returnTo);
  }

  /**
   * Complete a login from the IdP's redirect back to us.
   *
   * `params` are the callback query parameters; `stateCookie` is the sealed
   * state we set at `begin` and the browser returned. Every check that can fail
   * a login lives here, in order, and any failure throws rather than returning a
   * partial identity.
   */
  async complete(input: {
    providerId: string;
    code: string | undefined;
    stateParam: string | undefined;
    stateCookie: string | undefined;
    error?: string | undefined;
    sourceIp?: string;
  }): Promise<LoginResult> {
    const provider = this.#requireProvider(input.providerId);
    const secret = this.#requireSecret(input.providerId);

    // The IdP can hand back an OAuth error instead of a code (user denied,
    // consent required). Surface it as a clean refusal.
    if (input.error) {
      throw this.#loginError('OIDC_PROVIDER_ERROR', `The identity provider returned an error: ${input.error}`);
    }
    if (!input.code) throw this.#loginError('OIDC_NO_CODE', 'The callback carried no authorization code');

    // CSRF: the state in the query must equal the state cookie, and both must be
    // the sealed blob we minted. Comparing the two guards against a login-CSRF
    // where an attacker fixes a victim's `state`.
    if (!input.stateParam || !input.stateCookie) {
      throw this.#loginError('OIDC_STATE_MISSING', 'The login state is missing; restart the login');
    }
    if (!safeEqual(input.stateParam, input.stateCookie)) {
      throw this.#loginError('OIDC_STATE_MISMATCH', 'The login state did not match; restart the login');
    }
    const state = this.#openState(input.providerId, input.stateCookie);

    // Exchange the code for tokens at the IdP, authenticating as our client with
    // the PKCE verifier and client secret. A confidential client presents both.
    const metadata = await this.#metadata(provider);
    const tokenResponse = await this.#exchangeCode(provider, metadata, secret, input.code, state.cv);

    const idToken = tokenResponse.id_token;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw this.#loginError('OIDC_NO_ID_TOKEN', 'The token response carried no id_token');
    }

    // The heart of it: verify the ID token's signature against the JWKS and its
    // claims against what we expect, including the nonce we sealed into state.
    const claims = await this.#verifyIdToken(provider, metadata, idToken, state.nonce);

    // Federate the verified claims to a platform principal and (additively)
    // reconcile workspace membership from group claims.
    const principal = await this.#federate(provider, claims, input.sourceIp);
    const membershipChanges = await this.#reconcileMembership(provider, principal, claims);

    // Mint the session token last, once the identity is fully established.
    const { token, expiresAt } = await this.#mintSession(provider, principal);

    await this.#audit('sso.login', principal, 'allowed', input.sourceIp, {
      providerId: provider.providerId,
      subject: String(claims[provider.subjectClaim] ?? ''),
      membershipChanges,
    });

    return {
      token,
      principal,
      expiresAt,
      ...(state.rt ? { returnTo: state.rt } : {}),
    };
  }

  // --- provider / secret resolution -----------------------------------------

  #requireProvider(providerId: string): IdpConfig {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new MaError({
        code: 'OIDC_UNKNOWN_PROVIDER',
        category: 'not_found',
        message: `No identity provider is configured with id '${providerId}'`,
      });
    }
    return provider;
  }

  #requireSecret(providerId: string): string {
    const secret = this.#secrets[providerId];
    if (!secret) {
      // A confidential client with no secret must not silently fall back to a
      // public client — refuse, the same fail-closed rule as a missing egress
      // proxy or volume root.
      throw new MaError({
        code: 'OIDC_NO_CLIENT_SECRET',
        category: 'precondition',
        message: `Provider '${providerId}' has no client secret configured (set MA_OIDC_${providerId.toUpperCase()}_SECRET)`,
      });
    }
    return secret;
  }

  // --- state sealing --------------------------------------------------------

  #openState(providerId: string, stateCookie: string): {
    nonce: string;
    cv: string;
    rt?: string;
  } {
    let sealed: unknown;
    try {
      sealed = JSON.parse(Buffer.from(stateCookie, 'base64url').toString('utf8'));
    } catch {
      throw this.#loginError('OIDC_STATE_CORRUPT', 'The login state was unreadable; restart the login');
    }
    let payload: {
      v?: number;
      p?: string;
      nonce?: string;
      cv?: string;
      exp?: number;
      rt?: string;
    };
    try {
      payload = JSON.parse(
        unseal(sealed as Parameters<typeof unseal>[0], this.#keys, `oidc-state:${providerId}`),
      );
    } catch {
      // A state that does not unseal under this provider's AAD was forged, tampered
      // with, or minted for another provider. All are a refused login.
      throw this.#loginError('OIDC_STATE_INVALID', 'The login state failed verification; restart the login');
    }
    if (payload.v !== 1 || payload.p !== providerId || !payload.nonce || !payload.cv) {
      throw this.#loginError('OIDC_STATE_INVALID', 'The login state was malformed; restart the login');
    }
    if (typeof payload.exp !== 'number' || payload.exp < this.#clock.now()) {
      throw this.#loginError('OIDC_STATE_EXPIRED', 'The login took too long; restart the login');
    }
    return {
      nonce: payload.nonce,
      cv: payload.cv,
      ...(payload.rt ? { rt: payload.rt } : {}),
    };
  }

  // --- metadata / JWKS ------------------------------------------------------

  async #metadata(provider: IdpConfig): Promise<ProviderMetadata> {
    const cached = this.#metadataCache.get(provider.providerId);
    if (cached && this.#clock.now() - cached.fetchedAt < this.#metadataTtlMs) {
      return cached.metadata;
    }
    const url =
      provider.discoveryUrl ??
      `${provider.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    // Defence in depth beyond the schema refinement: never fetch a discovery
    // document over a non-secure URL, since it is the document that supplies
    // every other endpoint we trust.
    if (!isSecureOrLoopbackUrl(url)) {
      throw this.#loginError('OIDC_INSECURE_ENDPOINT', 'The discovery URL must be https');
    }
    const doc = await this.#fetchJson(url, 'discovery');
    const metadata = this.#parseMetadata(provider, doc);
    this.#metadataCache.set(provider.providerId, { metadata, fetchedAt: this.#clock.now() });
    return metadata;
  }

  #parseMetadata(provider: IdpConfig, doc: unknown): ProviderMetadata {
    const d = doc as Record<string, unknown>;
    const issuer = String(d.issuer ?? '');
    // The discovery document's issuer must equal the configured one exactly —
    // otherwise a compromised discovery URL could point us at another IdP's
    // endpoints while we believe we are talking to the configured one.
    if (issuer !== provider.issuer) {
      throw this.#loginError(
        'OIDC_ISSUER_MISMATCH',
        `The provider's discovery issuer '${issuer}' does not match the configured issuer`,
      );
    }
    const authorizationEndpoint = String(d.authorization_endpoint ?? '');
    const tokenEndpoint = String(d.token_endpoint ?? '');
    const jwksUri = String(d.jwks_uri ?? '');
    if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
      throw this.#loginError('OIDC_METADATA_INCOMPLETE', 'The provider metadata is missing required endpoints');
    }
    // Every endpoint we will call must live under https, for the same reason the
    // issuer must: an http endpoint is forgeable by anyone on the network. The
    // one exception is a loopback URL, for a local development IdP.
    for (const endpoint of [authorizationEndpoint, tokenEndpoint, jwksUri]) {
      if (!isSecureOrLoopbackUrl(endpoint)) {
        throw this.#loginError('OIDC_INSECURE_ENDPOINT', 'Provider endpoints must be https');
      }
    }
    return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
  }

  async #jwks(provider: IdpConfig, metadata: ProviderMetadata, kid: string | undefined): Promise<Jwk[]> {
    const cached = this.#jwksCache.get(provider.providerId);
    const now = this.#clock.now();
    const monotonic = this.#clock.monotonic();

    // Serve from cache when fresh and the kid is present (or no kid was named).
    if (cached && now - cached.fetchedAt < this.#metadataTtlMs) {
      if (!kid || cached.keys.some((key) => key.kid === kid)) return cached.keys;
      // Unknown kid on a fresh cache means the IdP rotated keys. Refetch, but at
      // most once a minute, so a token naming a bogus kid cannot make us hammer
      // the JWKS endpoint.
      if (monotonic - cached.lastRefetchAt < MIN_REFETCH_INTERVAL_MS) return cached.keys;
    }

    const doc = await this.#fetchJson(metadata.jwksUri, 'jwks');
    const keys = Array.isArray((doc as { keys?: unknown }).keys)
      ? ((doc as { keys: Jwk[] }).keys)
      : [];
    this.#jwksCache.set(provider.providerId, { keys, fetchedAt: now, lastRefetchAt: monotonic });
    return keys;
  }

  // --- token exchange -------------------------------------------------------

  async #exchangeCode(
    provider: IdpConfig,
    metadata: ProviderMetadata,
    secret: string,
    code: string,
    codeVerifier: string,
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: provider.redirectUri,
      client_id: provider.clientId,
      client_secret: secret,
      code_verifier: codeVerifier,
    });
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(metadata.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MaError({
        code: 'OIDC_TOKEN_ENDPOINT_UNREACHABLE',
        category: 'unavailable',
        message: 'Could not reach the identity provider token endpoint',
        cause: error,
      });
    }
    if (!response.ok) {
      // Log the IdP's error detail server-side, but do not reflect it to the
      // browser: a hostile or misconfigured token endpoint could echo attacker
      // content, and the raw body may leak IdP-internal information.
      const detail = await response.text().then((t) => t.slice(0, 500)).catch(() => '');
      this.#logger?.warn('oidc token exchange failed', {
        providerId: provider.providerId,
        status: response.status,
        detail,
      });
      throw this.#loginError(
        'OIDC_TOKEN_EXCHANGE_FAILED',
        `The token exchange with the identity provider failed (${response.status})`,
      );
    }
    let token: Record<string, unknown>;
    try {
      // Same as #fetchJson: a 200 can carry a non-JSON body (maintenance proxy),
      // and the raw SyntaxError would otherwise escape as a 500. A token exchange
      // that returns no parseable token is a failed login, a 400-class refusal.
      token = (await response.json()) as Record<string, unknown>;
    } catch {
      throw this.#loginError(
        'OIDC_TOKEN_EXCHANGE_FAILED',
        'The identity provider token endpoint did not return a JSON token response',
      );
    }
    return token;
  }

  // --- ID token verification ------------------------------------------------

  async #verifyIdToken(
    provider: IdpConfig,
    metadata: ProviderMetadata,
    idToken: string,
    expectedNonce: string,
  ): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw this.#loginError('OIDC_TOKEN_MALFORMED', 'The id_token is not a well-formed JWT');
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    const header = this.#decodeSegment(headerB64) as { alg?: string; kid?: string; typ?: string };
    const alg = header.alg ?? '';
    const verifier = ALG_VERIFY[alg];
    if (!verifier) {
      // The strict allowlist: `none`, HMAC and unknown algs all land here and are
      // refused, closing the algorithm-confusion and unsigned-token attacks.
      throw this.#loginError('OIDC_ALG_UNSUPPORTED', `The id_token algorithm '${alg}' is not accepted`);
    }

    const jwks = await this.#jwks(provider, metadata, header.kid);
    const jwk = selectKey(jwks, header.kid, alg);
    if (!jwk) {
      throw this.#loginError('OIDC_NO_MATCHING_KEY', 'No JWKS key matched the id_token');
    }

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = Buffer.from(signatureB64, 'base64url');
    if (!verifySignature(verifier, jwk, signingInput, signature)) {
      throw this.#loginError('OIDC_BAD_SIGNATURE', 'The id_token signature did not verify');
    }

    const claims = this.#decodeSegment(payloadB64) as Record<string, unknown>;
    this.#verifyClaims(provider, claims, expectedNonce);
    return claims;
  }

  /**
   * Decode one base64url JWT segment to JSON, as a clean login refusal on
   * failure. A crafted token with a well-formed three-part shape but non-JSON in
   * a segment must be a 400-class `OIDC_TOKEN_MALFORMED`, never an unguarded
   * `SyntaxError` that the error middleware would surface as a 500 — the callback
   * is unauthenticated and attacker-reachable, so a decode throw is a trivial way
   * to spray 500s otherwise.
   */
  #decodeSegment(segment: string): unknown {
    try {
      return decodeJsonSegment(segment);
    } catch {
      throw this.#loginError('OIDC_TOKEN_MALFORMED', 'The id_token could not be decoded');
    }
  }

  #verifyClaims(provider: IdpConfig, claims: Record<string, unknown>, expectedNonce: string): void {
    const nowSeconds = Math.floor(this.#clock.now() / 1000);

    if (claims.iss !== provider.issuer) {
      throw this.#loginError('OIDC_ISS_MISMATCH', 'The id_token issuer did not match');
    }

    // `aud` is a string or array; our client id must be present. Per OIDC core,
    // when the token has *multiple* audiences the `azp` (authorized party) claim
    // must be present and must equal our client — otherwise a token minted for a
    // sibling client in a shared-audience app family could be replayed here.
    const aud = claims.aud;
    const audienceOk = Array.isArray(aud)
      ? aud.includes(provider.clientId)
      : aud === provider.clientId;
    if (!audienceOk) {
      throw this.#loginError('OIDC_AUD_MISMATCH', 'The id_token audience did not include this client');
    }
    if (Array.isArray(aud) && aud.length > 1) {
      // Multiple audiences: azp is required and must be us.
      if (claims.azp !== provider.clientId) {
        throw this.#loginError('OIDC_AZP_MISMATCH', 'The id_token authorized party is not this client');
      }
    } else if (claims.azp !== undefined && claims.azp !== provider.clientId) {
      // Single audience: azp is optional, but if present it must still match.
      throw this.#loginError('OIDC_AZP_MISMATCH', 'The id_token authorized party is another client');
    }

    const exp = typeof claims.exp === 'number' ? claims.exp : Number.NaN;
    if (!Number.isFinite(exp) || exp + CLOCK_SKEW_SECONDS < nowSeconds) {
      throw this.#loginError('OIDC_TOKEN_EXPIRED', 'The id_token has expired');
    }
    const iat = typeof claims.iat === 'number' ? claims.iat : Number.NaN;
    if (!Number.isFinite(iat) || iat - CLOCK_SKEW_SECONDS > nowSeconds) {
      throw this.#loginError('OIDC_TOKEN_FUTURE', 'The id_token was issued in the future');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
      throw this.#loginError('OIDC_TOKEN_NOT_YET_VALID', 'The id_token is not valid yet');
    }

    // The nonce binds this token to the login *we* started, defeating replay of
    // a token captured from another flow. It must equal the one we sealed into
    // state, compared constant-time.
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expectedNonce)) {
      throw this.#loginError('OIDC_NONCE_MISMATCH', 'The id_token nonce did not match this login');
    }
  }

  // --- federation -----------------------------------------------------------

  async #federate(
    provider: IdpConfig,
    claims: Record<string, unknown>,
    sourceIp: string | undefined,
  ): Promise<Principal> {
    const rawSubject = claims[provider.subjectClaim];
    if (typeof rawSubject !== 'string' || rawSubject.length === 0) {
      throw this.#loginError('OIDC_NO_SUBJECT', `The id_token has no '${provider.subjectClaim}' claim`);
    }
    // The federated subject is namespaced by provider, so two IdPs that happen to
    // use the same `sub` never collapse into one principal, and a provider cannot
    // assert an identity belonging to another. SCIM provisions into this same
    // string, so a provisioned user and their later login are one principal.
    const subject = federatedSubject(provider.providerId, rawSubject);

    const email = typeof claims[provider.emailClaim] === 'string' ? (claims[provider.emailClaim] as string) : '';
    const displayName =
      typeof claims[provider.nameClaim] === 'string' ? (claims[provider.nameClaim] as string) : '';

    // Is the email claim trustworthy? The standard `email_verified` claim is the
    // only thing that makes an email an identity rather than a self-asserted
    // string. Many IdPs (self-service Auth0/Keycloak tenants, Azure AD guests)
    // will happily mint a token whose `email` the user typed themselves — so a
    // domain gate that trusts an *unverified* email is no gate at all: an
    // attacker sets their profile email to `victim@yourcorp.com` and walks in.
    // OIDC allows `email_verified` as a boolean or the string "true".
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';

    // Email-domain gate: for a shared IdP (e.g. Google) this is what stops any
    // account in the world from logging in. It requires a *verified* email —
    // an unverified one is treated as no email at all, so a spoofed corporate
    // address cannot satisfy the allowlist.
    if (provider.allowedEmailDomains.length > 0) {
      const domain =
        emailVerified && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1).toLowerCase() : '';
      const allowed = domain.length > 0 && provider.allowedEmailDomains.some((d) => d.toLowerCase() === domain);
      if (!allowed) {
        await this.#audit('sso.login', undefined, 'denied', sourceIp, {
          providerId: provider.providerId,
          reason: emailVerified ? 'email domain not allowed' : 'email not verified',
          subject,
        });
        throw this.#loginError(
          'OIDC_EMAIL_DOMAIN_DENIED',
          emailVerified
            ? 'Your email domain is not permitted for this provider'
            : 'A verified email is required for this provider',
        );
      }
    }

    const existing = await this.#store.principals.getBySubject(subject);
    const now = this.#clock.now();
    if (existing) {
      if (existing.disabled) {
        throw this.#loginError('OIDC_PRINCIPAL_DISABLED', 'This account is disabled');
      }
      // Refresh mutable profile fields, but never touch `isAdmin` from a claim —
      // platform-admin is granted deliberately, never asserted by an IdP.
      const patch: Partial<Principal> = { lastSeenAt: now, updatedAt: now };
      if (email && email !== existing.email) patch.email = email;
      if (displayName && displayName !== existing.displayName) patch.displayName = displayName;
      return this.#store.principals.update(existing.id, patch);
    }

    if (!provider.autoCreatePrincipals) {
      await this.#audit('sso.login', undefined, 'denied', sourceIp, {
        providerId: provider.providerId,
        reason: 'auto-create disabled and principal unknown',
        subject,
      });
      throw this.#loginError(
        'OIDC_PRINCIPAL_UNKNOWN',
        'No account exists for this identity and automatic provisioning is disabled',
      );
    }

    try {
      return await this.#store.principals.create({
        id: newId('principal', now),
        type: 'user',
        subject,
        displayName,
        email,
        // Federated principals are never platform admins by default. Admin is a
        // deliberate later grant, never something a first login confers.
        isAdmin: false,
        disabled: false,
        lastSeenAt: now,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        createdBy: 'sso',
      });
    } catch (error) {
      // Two concurrent first-time logins for the same brand-new subject both saw
      // getBySubject === undefined above and both reached create; the loser hits
      // the subject UNIQUE constraint. Converge on the winner rather than
      // surfacing a raw 409 login failure — mirrors the SCIM create path. The
      // winner is a freshly-created SSO principal (not disabled), so return it
      // after the same profile refresh the `existing` branch applies.
      const raced = await this.#store.principals.getBySubject(subject);
      if (raced) {
        if (raced.disabled) {
          throw this.#loginError('OIDC_PRINCIPAL_DISABLED', 'This account is disabled');
        }
        const patch: Partial<Principal> = { lastSeenAt: now, updatedAt: now };
        if (email && email !== raced.email) patch.email = email;
        if (displayName && displayName !== raced.displayName) patch.displayName = displayName;
        return this.#store.principals.update(raced.id, patch);
      }
      throw error;
    }
  }

  /**
   * Reconcile workspace membership from the token's group claim, additively.
   *
   * A grant present in the mapping and the token adds (or upgrades) a membership;
   * nothing here ever *removes* a membership. The reason is blast radius: a
   * misconfigured groups claim, or an IdP that drops a group during an outage,
   * must not silently strip an operator of a workspace — least surprise beats
   * exact mirroring for an additive-trust federation. De-provisioning is a
   * deliberate admin action, not a side effect of a login.
   */
  async #reconcileMembership(
    provider: IdpConfig,
    principal: Principal,
    claims: Record<string, unknown>,
  ): Promise<{ workspaceId: string; role: string }[]> {
    if (provider.groupRoleMappings.length === 0) return [];
    const groups = extractGroups(claims[provider.groupsClaim]);
    if (groups.length === 0) return [];
    const groupSet = new Set(groups);

    const changes: { workspaceId: string; role: string }[] = [];
    // Group mappings for groups the user is actually in.
    const applicable = provider.groupRoleMappings.filter((mapping) => groupSet.has(mapping.group));
    // Resolve to the *highest* role granted per workspace, so two groups mapping
    // the same workspace to different roles grant the stronger one.
    const bestByWorkspace = new Map<string, { role: Workspace['members'][number]['role'] }>();
    for (const mapping of applicable) {
      const current = bestByWorkspace.get(mapping.workspaceId);
      if (!current || rankRole(mapping.role) > rankRole(current.role)) {
        bestByWorkspace.set(mapping.workspaceId, { role: mapping.role });
      }
    }

    for (const [workspaceId, { role }] of bestByWorkspace) {
      const workspace = await this.#store.workspaces.get(workspaceId);
      if (!workspace) {
        this.#logger?.warn('sso group mapping names a missing workspace', {
          providerId: provider.providerId,
          workspaceId,
        });
        continue;
      }
      // Read-modify-write the member list inside a transaction, re-reading on the
      // same connection. Rewriting `workspace.members` wholesale from a value read
      // outside a transaction was lost-update-prone: two concurrent SSO logins to
      // the same workspace each read the pre-image, each added their own member,
      // and the second write clobbered the first — one membership silently gone.
      // Re-reading under the transaction's write lock makes the add/upgrade atomic.
      const applied = await this.#store.transaction((tx) => {
        const fresh = tx.workspaces.findById(workspaceId);
        if (!fresh) return false;
        const members = [...fresh.members];
        const index = members.findIndex((member) => member.principalId === principal.id);
        if (index === -1) {
          members.push({ principalId: principal.id, role, addedAt: this.#clock.now() });
        } else if (rankRole(members[index]!.role) < rankRole(role)) {
          // Upgrade only. A federated login never *downgrades* a membership a human
          // may have deliberately raised.
          members[index] = { ...members[index]!, role };
        } else {
          return false; // already at or above the granted role
        }
        void tx.workspaces.update(workspaceId, { members, updatedAt: this.#clock.now() });
        return true;
      });
      if (applied) changes.push({ workspaceId, role });
    }
    return changes;
  }

  // --- session token --------------------------------------------------------

  async #mintSession(provider: IdpConfig, principal: Principal): Promise<{ token: string; expiresAt: number }> {
    const now = this.#clock.now();
    const token = randomToken(32);
    const expiresAt = now + provider.sessionTtlSeconds * 1000;
    await this.#store.apiKeys.create({
      id: newId('apiKey', now),
      principalId: principal.id,
      name: `sso:${provider.providerId}`,
      prefix: token.slice(0, 8),
      tokenHash: hashToken(token),
      // A federated session gets the full principal scope; the principal's
      // workspace roles are what actually bound it. A deployment that wants
      // narrower SSO tokens can revoke and re-mint with scopes — the same knob
      // an API key has.
      scopes: ['ma:*'],
      expiresAt,
      createdAt: now,
      updatedAt: now,
      createdBy: 'sso',
    });
    return { token, expiresAt };
  }

  // --- helpers --------------------------------------------------------------

  #buildAuthUrl(
    provider: IdpConfig,
    metadata: ProviderMetadata,
    input: { nonce: string; codeVerifier: string; state: string },
  ): string {
    const scopes = new Set(provider.scopes);
    scopes.add('openid'); // required by OIDC, always present
    const challenge = sha256Base64Url(input.codeVerifier);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      scope: [...scopes].join(' '),
      state: input.state,
      nonce: input.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${metadata.authorizationEndpoint}?${query.toString()}`;
  }

  async #fetchJson(url: string, what: string): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MaError({
        code: 'OIDC_METADATA_UNREACHABLE',
        category: 'unavailable',
        message: `Could not fetch the provider ${what} document`,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new MaError({
        code: 'OIDC_METADATA_UNAVAILABLE',
        category: 'unavailable',
        message: `The provider ${what} document returned ${response.status}`,
      });
    }
    let doc: unknown;
    try {
      // A 200 can still carry a non-JSON body (a captive portal or maintenance
      // proxy answers 200 with HTML). Without this guard response.json() rejects
      // with a raw SyntaxError that escapes the MaError boundary and surfaces as
      // a 500; it is the same upstream-unavailable condition as a network error.
      doc = await response.json();
    } catch (error) {
      throw new MaError({
        code: 'OIDC_METADATA_UNAVAILABLE',
        category: 'unavailable',
        message: `The provider ${what} document was not valid JSON`,
        cause: error,
      });
    }
    if (doc === null || typeof doc !== 'object') {
      // A JSON body of literal `null` is valid JSON but dereferences into a
      // TypeError downstream; refuse it as an unusable provider document.
      throw new MaError({
        code: 'OIDC_METADATA_UNAVAILABLE',
        category: 'unavailable',
        message: `The provider ${what} document was not a JSON object`,
      });
    }
    return doc;
  }

  #loginError(code: string, message: string): MaError {
    // A failed login is a 400-class refusal to the browser, never a 500 — the
    // request was well-formed, the identity just did not check out.
    return new MaError({ code, category: 'validation', message });
  }

  async #audit(
    action: string,
    principal: Principal | undefined,
    outcome: 'allowed' | 'denied' | 'error',
    sourceIp: string | undefined,
    details: Record<string, unknown>,
  ): Promise<void> {
    const now = this.#clock.now();
    try {
      await this.#store.audit.append({
        id: newId('auditEntry', now),
        principalId: principal ? principal.id : 'anonymous',
        action,
        resourceKind: 'principal',
        resourceId: principal ? principal.id : '',
        outcome,
        reason: '',
        requestId: '',
        sourceIp: sourceIp ?? '',
        details,
        at: now,
      });
    } catch (error) {
      // An audit write must never fail a login that otherwise succeeded, but a
      // dropped security record is worth a loud log.
      this.#logger?.error('failed to write an SSO audit entry', { action, error });
    }
  }
}

// --- module-level pure helpers ----------------------------------------------

/** Decode a base64url JWT segment to a parsed JSON object. */
function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** SHA-256 of a string, base64url — the PKCE S256 challenge and misc digests. */
function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/**
 * Choose the JWKS key for a token: by `kid` when the header names one, else by
 * key type compatible with the algorithm when a JWKS has exactly one usable key.
 */
function selectKey(keys: readonly Jwk[], kid: string | undefined, alg: string): Jwk | undefined {
  const wantKty = alg.startsWith('RS') ? 'RSA' : alg.startsWith('ES') ? 'EC' : '';
  const usable = keys.filter(
    (key) => key.kty === wantKty && (key.use === undefined || key.use === 'sig'),
  );
  if (kid) return usable.find((key) => key.kid === kid);
  // No kid: only safe when the set is unambiguous.
  return usable.length === 1 ? usable[0] : undefined;
}

/** Verify a JWT signature with a JWK, under a vetted algorithm. */
function verifySignature(
  verifier: { nodeAlg: string; dsaEncoding?: 'ieee-p1363' },
  jwk: Jwk,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
  } catch {
    return false;
  }
  try {
    const verify = createVerify(verifier.nodeAlg);
    verify.update(signingInput);
    verify.end();
    return verify.verify(
      verifier.dsaEncoding ? { key, dsaEncoding: verifier.dsaEncoding } : key,
      signature,
    );
  } catch {
    return false;
  }
}

/** A groups claim may be an array of strings or a single string. */
function extractGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

const ROLE_RANK: Readonly<Record<string, number>> = {
  viewer: 0,
  operator: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};
function rankRole(role: string): number {
  return ROLE_RANK[role] ?? -1;
}

/**
 * Only permit a `returnTo` that is a same-site path, never an absolute URL.
 *
 * An open redirect after login is a phishing primitive — a login link that
 * bounces the browser to an attacker's origin carrying a fresh session. So a
 * `returnTo` must be a root-relative path (`/...`) and not a protocol-relative
 * `//host` one; anything else is dropped rather than honoured.
 */
function safeReturnTo(returnTo: string | undefined): string | undefined {
  if (!returnTo) return undefined;
  if (!returnTo.startsWith('/')) return undefined;
  if (returnTo.startsWith('//')) return undefined;
  if (returnTo.includes('\\')) return undefined;
  return returnTo;
}
