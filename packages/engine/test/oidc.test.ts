/**
 * OIDC identity-federation tests.
 *
 * A fake IdP stands in for a real one: a generated RSA (and EC) key signs ID
 * tokens, and an injected `fetch` serves the discovery, JWKS and token
 * endpoints. That lets the tests exercise the exact security checks — signature,
 * claims, nonce, state, algorithm allowlist — against tokens we craft to fail
 * each one, which is the whole point: a green happy-path proves nothing about
 * the refusals, and the refusals are the feature.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  createSign,
  type KeyObject,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

import { InMemoryKeyProvider, MaError, TestClock, newId, nullLogger } from '@ma/core';
import type { IdpConfig } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import { OidcService, type FetchLike } from '../src/oidc.ts';

const START = 1_700_000_000_000;
const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-abc';
const CLIENT_SECRET = 'super-secret';
const REDIRECT = 'https://console.example.com/auth/v1/okta/callback';

// --- a fake IdP -------------------------------------------------------------

interface FakeIdpOptions {
  /** Override the kid advertised in the JWKS (to force rotation/mismatch). */
  jwksKid?: string;
}

/**
 * Holds the signing key and produces the three documents a real IdP serves,
 * plus a `fetch` that routes to them. `nextCode` records the last code issued so
 * a test can assert the token exchange used it.
 */
class FakeIdp {
  readonly privateKey: KeyObject;
  readonly publicJwk: Record<string, unknown>;
  readonly kid = 'test-key-1';
  /** The id_token the token endpoint will return next. Set per test. */
  idTokenToReturn: string | undefined;
  /** Force the token endpoint to fail. */
  tokenEndpointStatus = 200;
  jwksKidOverride: string | undefined;
  tokenExchanges = 0;
  jwksFetches = 0;

  constructor(options: FakeIdpOptions = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    this.jwksKidOverride = options.jwksKid;
  }

  discovery(): Record<string, unknown> {
    return {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    };
  }

  jwks(): Record<string, unknown> {
    return {
      keys: [{ ...this.publicJwk, kid: this.jwksKidOverride ?? this.kid, use: 'sig', alg: 'RS256' }],
    };
  }

  /** Sign a JWT with this IdP's key (RS256 by default). */
  signToken(claims: Record<string, unknown>, options: { alg?: string; kid?: string } = {}): string {
    const header = { alg: options.alg ?? 'RS256', typ: 'JWT', kid: options.kid ?? this.kid };
    const headerB64 = b64url(JSON.stringify(header));
    const payloadB64 = b64url(JSON.stringify(claims));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(this.privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  /** A well-formed set of ID-token claims for this IdP; override any field. */
  claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const nowSeconds = Math.floor(START / 1000);
    return {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'user-123',
      email: 'alice@corp.example',
      name: 'Alice',
      iat: nowSeconds,
      exp: nowSeconds + 3600,
      ...overrides,
    };
  }

  fetch(): FetchLike {
    return async (url: string, init) => {
      if (url.includes('/.well-known/openid-configuration')) return jsonResponse(this.discovery());
      if (url.endsWith('/jwks')) {
        this.jwksFetches++;
        return jsonResponse(this.jwks());
      }
      if (url.endsWith('/token')) {
        this.tokenExchanges++;
        if (this.tokenEndpointStatus !== 200) {
          return { ok: false, status: this.tokenEndpointStatus, json: () => Promise.resolve({}), text: () => Promise.resolve('error') };
        }
        void init;
        return jsonResponse({ id_token: this.idTokenToReturn ?? '', token_type: 'Bearer' });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
  }
}

function jsonResponse(body: unknown): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

// --- fixtures ---------------------------------------------------------------

function makeProvider(overrides: Partial<IdpConfig> = {}): IdpConfig {
  return {
    providerId: 'okta',
    displayName: 'Okta',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    scopes: ['openid', 'profile', 'email'],
    subjectClaim: 'sub',
    emailClaim: 'email',
    nameClaim: 'name',
    groupsClaim: 'groups',
    groupRoleMappings: [],
    allowedEmailDomains: [],
    autoCreatePrincipals: true,
    sessionTtlSeconds: 28_800,
    ...overrides,
  };
}

let store: SqliteStore;
let clock: TestClock;
let idp: FakeIdp;

function makeService(provider: IdpConfig, options: { secret?: string } = {}): OidcService {
  return new OidcService({
    clock,
    keys: InMemoryKeyProvider.generate('v1'),
    store,
    logger: nullLogger,
    providers: [provider],
    clientSecrets: options.secret === undefined ? { [provider.providerId]: CLIENT_SECRET } : { [provider.providerId]: options.secret },
    fetch: idp.fetch(),
  });
}

/**
 * Drive a full login and return the callback result. `state` is minted by the
 * service's own `begin`, so the nonce and PKCE verifier are consistent, and the
 * id_token is signed to carry that same nonce.
 */
async function login(
  service: OidcService,
  provider: IdpConfig,
  claimOverrides: (nonce: string) => Record<string, unknown>,
  options: { tokenAlg?: string; tokenKid?: string; returnTo?: string } = {},
): ReturnType<OidcService['complete']> {
  const redirect = await service.beginAsync(provider.providerId, options.returnTo);
  const nonce = extractNonce(redirect.url);
  idp.idTokenToReturn = idp.signToken(idp.claims(claimOverrides(nonce)), {
    ...(options.tokenAlg ? { alg: options.tokenAlg } : {}),
    ...(options.tokenKid ? { kid: options.tokenKid } : {}),
  });
  return service.complete({
    providerId: provider.providerId,
    code: 'auth-code',
    stateParam: redirect.state,
    stateCookie: redirect.state,
  });
}

function extractNonce(url: string): string {
  const nonce = new URL(url).searchParams.get('nonce');
  assert.ok(nonce, 'the authorization URL must carry a nonce');
  return nonce;
}

beforeEach(() => {
  store = createMemoryStore();
  clock = new TestClock(START);
  idp = new FakeIdp();
});

// --- happy path -------------------------------------------------------------

describe('OIDC login — happy path', () => {
  test('federates a first-seen user into a new principal and a session token', async () => {
    const provider = makeProvider();
    const service = makeService(provider);

    const result = await login(service, provider, (nonce) => ({ nonce }));

    // A principal was created, namespaced by provider+subject.
    assert.equal(result.principal.subject, 'oidc:okta:user-123');
    assert.equal(result.principal.email, 'alice@corp.example');
    assert.equal(result.principal.displayName, 'Alice');
    assert.equal(result.principal.isAdmin, false, 'a federated login is never admin by default');

    // The token authenticates: it resolves to an api key for this principal via
    // the same hash lookup the bearer middleware uses.
    const { hashToken } = await import('@ma/core');
    const key = await store.apiKeys.getByHash(hashToken(result.token));
    assert.ok(key, 'the minted token must be a stored api key');
    assert.equal(key.principalId, result.principal.id);
    assert.equal(key.expiresAt, START + provider.sessionTtlSeconds * 1000);
  });

  test('a returning user reuses the same principal and refreshes profile', async () => {
    const provider = makeProvider();
    const service = makeService(provider);

    const first = await login(service, provider, (nonce) => ({ nonce }));
    const second = await login(service, provider, (nonce) => ({ nonce, name: 'Alice Renamed' }));

    assert.equal(second.principal.id, first.principal.id, 'the same subject is one principal');
    assert.equal(second.principal.displayName, 'Alice Renamed', 'profile fields refresh on login');

    const all = await store.principals.list({ limit: 100 });
    assert.equal(all.items.length, 1, 'no duplicate principal was created');
  });

  test('an audit entry records the login', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    await login(service, provider, (nonce) => ({ nonce }));

    const audit = await store.audit.list({ limit: 10 });
    const entry = audit.items.find((item) => item.action === 'sso.login');
    assert.ok(entry, 'a login must be audited');
    assert.equal(entry.outcome, 'allowed');
  });
});

// --- signature and algorithm attacks ---------------------------------------

describe('OIDC login — signature and algorithm', () => {
  test('rejects a token signed by the wrong key', async () => {
    const provider = makeProvider();
    const service = makeService(provider);

    const redirect = await service.beginAsync(provider.providerId);
    const nonce = extractNonce(redirect.url);
    // Sign with a *different* IdP's key — a valid-looking token from an attacker.
    const attacker = new FakeIdp();
    idp.idTokenToReturn = attacker.signToken({ ...idp.claims({ nonce }) });

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: redirect.state, stateCookie: redirect.state }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_BAD_SIGNATURE',
    );
  });

  test('rejects alg=none (an unsigned token)', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const redirect = await service.beginAsync(provider.providerId);
    const nonce = extractNonce(redirect.url);
    // Hand-craft a none-alg token: header alg none, empty signature.
    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = b64url(JSON.stringify(idp.claims({ nonce })));
    idp.idTokenToReturn = `${header}.${payload}.`;

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: redirect.state, stateCookie: redirect.state }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_ALG_UNSUPPORTED',
    );
  });

  test('rejects an HS256 token forged with the public key (algorithm confusion)', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const redirect = await service.beginAsync(provider.providerId);
    const nonce = extractNonce(redirect.url);
    // The classic attack: sign with HMAC using the JWKS public key as the secret.
    // Our allowlist has no HS* entry, so it is refused before any verification.
    const { createHmac } = await import('node:crypto');
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: idp.kid }));
    const payload = b64url(JSON.stringify(idp.claims({ nonce })));
    const pubPem = Buffer.from(JSON.stringify(idp.publicJwk));
    const sig = createHmac('sha256', pubPem).update(`${header}.${payload}`).digest('base64url');
    idp.idTokenToReturn = `${header}.${payload}.${sig}`;

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: redirect.state, stateCookie: redirect.state }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_ALG_UNSUPPORTED',
    );
  });

  test('rejects a token whose kid matches no JWKS key', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const redirect = await service.beginAsync(provider.providerId);
    const nonce = extractNonce(redirect.url);
    idp.idTokenToReturn = idp.signToken(idp.claims({ nonce }), { kid: 'nonexistent-kid' });

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: redirect.state, stateCookie: redirect.state }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_NO_MATCHING_KEY',
    );
  });
});

// --- claim validation -------------------------------------------------------

describe('OIDC login — claims', () => {
  test('rejects a wrong issuer', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce, iss: 'https://evil.example.com' })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_ISS_MISMATCH',
    );
  });

  test('rejects a token minted for a different client (aud)', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce, aud: 'some-other-client' })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_AUD_MISMATCH',
    );
  });

  test('rejects an expired token', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const past = Math.floor(START / 1000) - 7200;
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce, iat: past, exp: past + 60 })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_TOKEN_EXPIRED',
    );
  });

  test('rejects a nonce that does not match this login', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    // Sign a token with a nonce unrelated to the one begin() minted.
    await assert.rejects(
      login(service, provider, () => ({ nonce: 'a-nonce-we-never-issued' })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_NONCE_MISMATCH',
    );
  });

  test('rejects a token with no subject claim', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce, sub: undefined })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_NO_SUBJECT',
    );
  });

  test('accepts our client in a single-element aud array', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const ok = await login(service, provider, (nonce) => ({ nonce, aud: ['client-abc'] }));
    assert.equal(ok.principal.subject, 'oidc:okta:user-123');
  });

  test('requires azp to equal our client when the token has multiple audiences', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    // Multiple audiences and no azp: per OIDC, azp is required here. A missing or
    // wrong azp on a multi-audience token could be one minted for a sibling
    // client, so it must be refused.
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce, aud: ['client-abc', 'another-client'] })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_AZP_MISMATCH',
    );
    // Multiple audiences *with* the right azp is accepted.
    const ok = await login(service, provider, (nonce) => ({
      nonce,
      aud: ['client-abc', 'another-client'],
      azp: 'client-abc',
    }));
    assert.equal(ok.principal.subject, 'oidc:okta:user-123');
  });

  test('a malformed token segment is a clean refusal, not a 500', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const redirect = await service.beginAsync(provider.providerId);
    // A well-formed three-part shape, but the payload is not valid base64url JSON.
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: idp.kid }));
    idp.idTokenToReturn = `${header}.!!!not-json!!!.sig`;

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: redirect.state, stateCookie: redirect.state }),
      (error: unknown) => {
        // A validation-category MaError → 400, never an internal 500.
        assert.ok(MaError.is(error));
        assert.equal(error.category, 'validation');
        return true;
      },
    );
  });
});

// --- state / CSRF -----------------------------------------------------------

describe('OIDC login — state and CSRF', () => {
  test('rejects a callback whose state param and cookie differ', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const a = await service.beginAsync(provider.providerId);
    const b = await service.beginAsync(provider.providerId);

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: a.state, stateCookie: b.state }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_STATE_MISMATCH',
    );
  });

  test('rejects a forged state that was not sealed by us', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const forged = Buffer.from(JSON.stringify({ ciphertext: 'AAAA', keyVersion: 'v1', algorithm: 'aes-256-gcm' }), 'utf8').toString('base64url');

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: forged, stateCookie: forged }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_STATE_INVALID',
    );
  });

  test('rejects a state minted for another provider', async () => {
    const provider = makeProvider();
    const other = makeProvider({ providerId: 'auth0' });
    const service = new OidcService({
      clock,
      keys: InMemoryKeyProvider.generate('v1'),
      store,
      logger: nullLogger,
      providers: [provider, other],
      clientSecrets: { okta: CLIENT_SECRET, auth0: CLIENT_SECRET },
      fetch: idp.fetch(),
    });
    const oktaState = (await service.beginAsync('okta')).state;
    // Present okta's state on auth0's callback: the AAD binding must reject it.
    await assert.rejects(
      service.complete({ providerId: 'auth0', code: 'c', stateParam: oktaState, stateCookie: oktaState }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_STATE_INVALID',
    );
  });

  test('rejects a login that took too long (expired state)', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const redirect = await service.beginAsync(provider.providerId);
    await clock.advance(11 * 60 * 1000); // past the 10-minute window

    await assert.rejects(
      service.complete({ providerId: provider.providerId, code: 'c', stateParam: redirect.state, stateCookie: redirect.state }),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_STATE_EXPIRED',
    );
  });
});

// --- access control layered on federation ----------------------------------

describe('OIDC login — access policy', () => {
  test('enforces the email-domain allowlist', async () => {
    const provider = makeProvider({ allowedEmailDomains: ['corp.example'] });
    const service = makeService(provider);

    // In-domain with a *verified* email succeeds.
    const ok = await login(service, provider, (nonce) => ({
      nonce,
      email: 'bob@corp.example',
      email_verified: true,
    }));
    assert.equal(ok.principal.email, 'bob@corp.example');

    // Out-of-domain is refused even when verified.
    await assert.rejects(
      login(service, provider, (nonce) => ({
        nonce,
        sub: 'user-999',
        email: 'mallory@evil.example',
        email_verified: true,
      })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_EMAIL_DOMAIN_DENIED',
    );
  });

  test('an unverified in-domain email cannot satisfy the allowlist (spoofing defence)', async () => {
    // The shared-IdP attack: register at a shared IdP, set the profile email to a
    // victim's corporate address. Without email_verified the claim is not an
    // identity, so a domain gate that trusts it would be no gate at all.
    const provider = makeProvider({ allowedEmailDomains: ['corp.example'] });
    const service = makeService(provider);

    await assert.rejects(
      login(service, provider, (nonce) => ({
        nonce,
        sub: 'attacker-1',
        email: 'ceo@corp.example',
        email_verified: false,
      })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_EMAIL_DOMAIN_DENIED',
    );

    // A missing email_verified claim is treated as unverified, not as a pass.
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce, sub: 'attacker-2', email: 'ceo@corp.example' })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_EMAIL_DOMAIN_DENIED',
    );
  });

  test('accepts the string "true" for email_verified, as some IdPs emit it', async () => {
    const provider = makeProvider({ allowedEmailDomains: ['corp.example'] });
    const service = makeService(provider);
    const ok = await login(service, provider, (nonce) => ({
      nonce,
      email: 'sam@corp.example',
      email_verified: 'true',
    }));
    assert.equal(ok.principal.email, 'sam@corp.example');
  });

  test('does not provision a principal when auto-create is off and the user is unknown', async () => {
    const provider = makeProvider({ autoCreatePrincipals: false });
    const service = makeService(provider);
    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_PRINCIPAL_UNKNOWN',
    );
    const all = await store.principals.list({ limit: 10 });
    assert.equal(all.items.length, 0, 'no principal may be created when provisioning is off');
  });

  test('refuses a disabled principal', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const first = await login(service, provider, (nonce) => ({ nonce }));
    await store.principals.update(first.principal.id, { disabled: true });

    await assert.rejects(
      login(service, provider, (nonce) => ({ nonce })),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_PRINCIPAL_DISABLED',
    );
  });

  test('never sets isAdmin from a claim', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    // Even if the IdP asserts isAdmin/admin, it must not be honoured.
    const result = await login(service, provider, (nonce) => ({ nonce, isAdmin: true, admin: true }));
    assert.equal(result.principal.isAdmin, false);
  });
});

// --- group → workspace membership ------------------------------------------

describe('OIDC login — group membership federation', () => {
  async function seedWorkspace(id: string, slug: string): Promise<void> {
    await store.workspaces.create({
      id,
      name: slug,
      description: '',
      slug,
      status: 'active',
      members: [],
      quota: {
        maxConcurrentSessions: 20,
        maxSandboxes: 20,
        maxTokensPerDay: 50_000_000,
        maxCostMicrosPerDay: 0,
        maxStorageMb: 10_240,
        maxAgents: 200,
        eventRetentionDays: 90,
      },
      systemPrompt: '',
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'test',
    });
  }

  test('grants workspace membership from a mapped group', async () => {
    const workspaceId = newId('workspace', START);
    await seedWorkspace(workspaceId, 'engineering');
    const provider = makeProvider({
      groupRoleMappings: [{ group: 'eng-team', workspaceId, role: 'developer' }],
    });
    const service = makeService(provider);

    const result = await login(service, provider, (nonce) => ({ nonce, groups: ['eng-team', 'other'] }));

    const workspace = await store.workspaces.get(workspaceId);
    const member = workspace!.members.find((m) => m.principalId === result.principal.id);
    assert.ok(member, 'the mapped group must grant membership');
    assert.equal(member.role, 'developer');
  });

  test('upgrades but never downgrades an existing membership', async () => {
    const workspaceId = newId('workspace', START);
    await seedWorkspace(workspaceId, 'engineering');
    const provider = makeProvider({
      groupRoleMappings: [
        { group: 'eng', workspaceId, role: 'developer' },
        { group: 'leads', workspaceId, role: 'admin' },
      ],
    });
    const service = makeService(provider);

    // First login as a lead → admin.
    const result = await login(service, provider, (nonce) => ({ nonce, groups: ['eng', 'leads'] }));
    let workspace = await store.workspaces.get(workspaceId);
    assert.equal(workspace!.members.find((m) => m.principalId === result.principal.id)!.role, 'admin');

    // Second login with only the lower group must NOT downgrade the admin.
    await login(service, provider, (nonce) => ({ nonce, groups: ['eng'] }));
    workspace = await store.workspaces.get(workspaceId);
    assert.equal(
      workspace!.members.find((m) => m.principalId === result.principal.id)!.role,
      'admin',
      'a federated login never strips a role',
    );
  });

  test('a concurrent membership write is not lost when a login adds a member', async () => {
    // The lost-update race: #reconcileMembership rewrote the whole members array
    // from a value read OUTSIDE a transaction, so a concurrent member-add landing
    // between that read and the write was clobbered. The fix re-reads inside a
    // transaction. Simulate the concurrent write by injecting a member during the
    // outer read (before the reconcile transaction re-reads), then assert BOTH
    // survive — the transaction's fresh read must see the injected member.
    const workspaceId = newId('workspace', START);
    await seedWorkspace(workspaceId, 'engineering');
    const provider = makeProvider({
      groupRoleMappings: [{ group: 'eng', workspaceId, role: 'developer' }],
    });
    const service = makeService(provider);

    const realGet = store.workspaces.get.bind(store.workspaces);
    let injected = false;
    store.workspaces.get = async (id: string) => {
      const row = await realGet(id);
      if (!injected && id === workspaceId && row) {
        injected = true;
        // A concurrent path commits its own member add AFTER this read returns its
        // (now stale) snapshot. Return the pre-injection row so the caller holds a
        // stale members array; the correct code re-reads inside its transaction and
        // sees the injected member, the buggy code clobbers it.
        const members = [
          ...row.members,
          { principalId: 'pr_concurrent', role: 'viewer' as const, addedAt: START },
        ];
        await store.workspaces.update(id, { members, updatedAt: START });
        return row; // the stale snapshot, without pr_concurrent
      }
      return realGet(id);
    };
    try {
      const result = await login(service, provider, (nonce) => ({ nonce, groups: ['eng'] }));
      const workspace = await realGet(workspaceId);
      const ids = workspace!.members.map((m) => m.principalId);
      assert.ok(ids.includes('pr_concurrent'), 'the concurrent member must not be clobbered');
      assert.ok(ids.includes(result.principal.id), 'the login’s member is also present');
    } finally {
      store.workspaces.get = realGet;
    }
  });

  test('a membership added by hand survives a login that no longer maps it', async () => {
    const workspaceId = newId('workspace', START);
    await seedWorkspace(workspaceId, 'engineering');
    const provider = makeProvider(); // no group mappings
    const service = makeService(provider);

    const result = await login(service, provider, (nonce) => ({ nonce }));
    // Admin adds this principal by hand.
    const workspace = await store.workspaces.get(workspaceId);
    await store.workspaces.update(workspaceId, {
      members: [...workspace!.members, { principalId: result.principal.id, role: 'operator', addedAt: START }],
    });

    // A later login with no mappings must leave the hand-added membership intact.
    await login(service, provider, (nonce) => ({ nonce }));
    const after = await store.workspaces.get(workspaceId);
    const member = after!.members.find((m) => m.principalId === result.principal.id);
    assert.ok(member, 'a hand-added membership must survive an unrelated login');
    assert.equal(member.role, 'operator');
  });
});

// --- configuration / fail-closed -------------------------------------------

describe('OIDC service — configuration', () => {
  test('is disabled with no providers', () => {
    const service = new OidcService({
      clock,
      keys: InMemoryKeyProvider.generate('v1'),
      store,
      providers: [],
      clientSecrets: {},
      fetch: idp.fetch(),
    });
    assert.equal(service.enabled, false);
  });

  test('refuses a provider with no client secret', async () => {
    const provider = makeProvider();
    const service = makeService(provider, { secret: '' });
    await assert.rejects(
      service.beginAsync(provider.providerId),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_NO_CLIENT_SECRET',
    );
  });

  test('rejects an unknown provider id', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    await assert.rejects(
      service.beginAsync('nonexistent'),
      (error: unknown) => MaError.is(error) && error.code === 'OIDC_UNKNOWN_PROVIDER',
    );
  });

  test('the authorization URL carries PKCE, nonce, state and the right client', async () => {
    const provider = makeProvider();
    const service = makeService(provider);
    const redirect = await service.beginAsync(provider.providerId, '/dashboard');
    const url = new URL(redirect.url);
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'), 'a PKCE challenge is required');
    assert.ok(url.searchParams.get('nonce'), 'a nonce is required');
    assert.ok(url.searchParams.get('state'), 'state is required');
    assert.ok(url.searchParams.get('scope')!.includes('openid'), 'openid scope is always present');
  });

  test('honours a safe returnTo and drops an unsafe one', async () => {
    const provider = makeProvider();
    const service = makeService(provider);

    const safe = await login(service, provider, (nonce) => ({ nonce }), { returnTo: '/dashboard' });
    assert.equal(safe.returnTo, '/dashboard');

    const unsafe = await login(service, provider, (nonce) => ({ nonce, sub: 'user-2' }), {
      returnTo: 'https://evil.example.com/steal',
    });
    assert.equal(unsafe.returnTo, undefined, 'an absolute returnTo is an open redirect and must be dropped');
  });
});
