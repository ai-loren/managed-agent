/**
 * SSO end-to-end test.
 *
 * Boots the whole platform with an OIDC provider configured, and drives the real
 * public `/auth/v1/*` routes through HTTP — no service injection. A real local
 * HTTP server plays the IdP: it serves discovery, JWKS and a token endpoint, and
 * signs an ID token with a generated RSA key. The point is to prove the seam
 * works exactly as deployed: a browser hitting `/login` is redirected to the
 * IdP, the callback verifies a real signed token and mints a session token, and
 * that token then authenticates an ordinary API call through the same bearer
 * middleware every other caller uses.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { InMemoryKeyProvider, nullLogger, systemClock } from '@ma/core';

import { buildPlatform, type Platform } from '../src/platform.ts';
import type { ServerConfig } from '../src/config.ts';

// --- a real IdP over HTTP ---------------------------------------------------

let idpServer: Server;
let idpOrigin: string;
let idpPrivateKey: KeyObject;
let idpPublicJwk: Record<string, unknown>;
const KID = 'e2e-key';
/** The claims the token endpoint signs and returns next. Set per test. */
let pendingClaims: Record<string, unknown> | undefined;
/** The last authorization params the "browser" would have carried (nonce). */
let lastNonce = '';

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signIdToken(claims: Record<string, unknown>): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(idpPrivateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function startIdp(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  idpPrivateKey = privateKey;
  idpPublicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  idpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', idpOrigin);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, {
        issuer: idpOrigin,
        authorization_endpoint: `${idpOrigin}/authorize`,
        token_endpoint: `${idpOrigin}/token`,
        jwks_uri: `${idpOrigin}/jwks`,
      });
    }
    if (url.pathname === '/jwks') {
      return json(res, { keys: [{ ...idpPublicJwk, kid: KID, use: 'sig', alg: 'RS256' }] });
    }
    if (url.pathname === '/token') {
      // The token the callback will verify. Its nonce must match what /authorize
      // was asked for, which the test captured via the login redirect.
      const claims = pendingClaims ?? {};
      return json(res, { id_token: signIdToken(claims), token_type: 'Bearer' });
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => idpServer.listen(0, '127.0.0.1', resolve));
  const port = (idpServer.address() as AddressInfo).port;
  idpOrigin = `http://127.0.0.1:${port}`;
}

function json(res: import('node:http').ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json' }).end(text);
}

// --- platform boot ----------------------------------------------------------

let platform: Platform;
let baseUrl: string;

function testConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: ':memory:',
    logLevel: 'error',
    controlPlaneUrl: 'http://127.0.0.1:0',
    corsOrigins: [],
    encryptionKeys: InMemoryKeyProvider.generate(),
    sandbox: { driver: 'local', leaseSeconds: 60, prewarmPerPool: 0 },
    scheduler: { enabled: false, tickMs: 1000, batchSize: 5, auditRetentionDays: 0 },
    rateLimit: { limit: 10_000, windowMs: 60_000 },
    modelRetry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    modelBreaker: { enabled: false, threshold: 5, windowMs: 30_000, resetMs: 30_000 },
    artifacts: { root: ':memory:', maxMb: 25, retentionDays: 0 },
    trustForwardedFor: false,
    sso: {
      providers: [
        {
          providerId: 'e2e',
          displayName: 'E2E IdP',
          issuer: idpOrigin,
          clientId: 'e2e-client',
          redirectUri: 'https://console.example.com/auth/v1/e2e/callback',
          scopes: ['openid', 'profile', 'email'],
          subjectClaim: 'sub',
          emailClaim: 'email',
          nameClaim: 'name',
          groupsClaim: 'groups',
          groupRoleMappings: [],
          allowedEmailDomains: [],
          autoCreatePrincipals: true,
          sessionTtlSeconds: 3600,
        },
      ],
      clientSecrets: { e2e: 'e2e-secret' },
    },
  };
}

before(async () => {
  await startIdp();
  platform = buildPlatform({ config: testConfig(), logger: nullLogger, clock: systemClock });
  const address = await platform.start();
  baseUrl = `http://${address.host}:${address.port}`;
});

after(async () => {
  await platform.stop();
  await new Promise<void>((resolve) => idpServer.close(() => resolve()));
});

/**
 * Run the whole browser flow against the live routes: GET /login (302 + cookie),
 * capture the nonce, prime the IdP with a token carrying it, then GET /callback
 * with the state param and cookie. Returns the callback response.
 */
async function runLogin(claims: (nonce: string) => Record<string, unknown>): Promise<{
  status: number;
  body: any;
}> {
  const loginResponse = await fetch(`${baseUrl}/auth/v1/e2e/login`, { redirect: 'manual' });
  assert.equal(loginResponse.status, 302, 'login must redirect to the IdP');
  const location = loginResponse.headers.get('location')!;
  const setCookie = loginResponse.headers.get('set-cookie')!;
  assert.ok(location.startsWith(idpOrigin), 'the redirect must target the IdP');

  const authUrl = new URL(location);
  const nonce = authUrl.searchParams.get('nonce')!;
  const state = authUrl.searchParams.get('state')!;
  lastNonce = nonce;

  // Prime the IdP token endpoint with a token carrying this login's nonce.
  const nowSeconds = Math.floor(systemClock.now() / 1000);
  pendingClaims = {
    iss: idpOrigin,
    aud: 'e2e-client',
    sub: 'e2e-user',
    email: 'e2e@corp.example',
    name: 'E2E User',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    ...claims(nonce),
  };

  // The state cookie is scoped to the callback path; echo it back as the browser
  // would, along with the state query param the IdP would have preserved.
  const cookieValue = setCookie.split(';')[0]!;
  const callbackResponse = await fetch(
    `${baseUrl}/auth/v1/e2e/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookieValue }, redirect: 'manual' },
  );
  const text = await callbackResponse.text();
  return { status: callbackResponse.status, body: text ? JSON.parse(text) : null };
}

describe('SSO end to end', () => {
  test('lists the configured provider', async () => {
    const response = await fetch(`${baseUrl}/auth/v1/providers`);
    const body = (await response.json()) as { providers: { providerId: string }[] };
    assert.equal(response.status, 200);
    assert.ok(body.providers.some((p) => p.providerId === 'e2e'));
  });

  test('a full login mints a token that authenticates an API call', async () => {
    const result = await runLogin((nonce) => ({ nonce }));
    assert.equal(result.status, 200, 'the callback returns the session token');
    const token = result.body.token as string;
    assert.ok(token, 'a session token must be returned');
    assert.equal(result.body.principal.subject, 'oidc:e2e:e2e-user');

    // The federated token authenticates an ordinary API request through the same
    // bearer middleware every caller uses — the whole point of the design.
    const me = await fetch(`${baseUrl}/v1/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.status, 200, 'the SSO token is a first-class bearer token');
  });

  test('the /auth routes are public (reachable with no bearer)', async () => {
    // A 302 or 200, never a 401: the login flow must not require a token to start.
    const response = await fetch(`${baseUrl}/auth/v1/e2e/login`, { redirect: 'manual' });
    assert.notEqual(response.status, 401);
  });

  test('a tampered token is refused by the live callback', async () => {
    const result = await runLogin((nonce) => ({ nonce, iss: 'https://attacker.example.com' }));
    assert.equal(result.status, 400, 'a bad issuer is a 400-class refusal');
    assert.equal(result.body.error.code, 'OIDC_ISS_MISMATCH');
  });

  test('a callback with no state cookie is refused', async () => {
    // Simulate a login-CSRF: the attacker has a state param but the victim's
    // browser sends no matching cookie.
    const loginResponse = await fetch(`${baseUrl}/auth/v1/e2e/login`, { redirect: 'manual' });
    const state = new URL(loginResponse.headers.get('location')!).searchParams.get('state')!;
    const response = await fetch(
      `${baseUrl}/auth/v1/e2e/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'OIDC_STATE_MISSING');
  });
});
