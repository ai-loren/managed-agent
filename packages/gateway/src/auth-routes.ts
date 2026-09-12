/**
 * SSO login routes.
 *
 * Two public endpoints implement the OIDC authorization-code flow:
 *
 *   GET /auth/v1/:provider/login    → 302 to the IdP, sets a sealed state cookie
 *   GET /auth/v1/:provider/callback → verifies, mints a session token, returns it
 *
 * They are public (no bearer) because a browser navigation and an IdP redirect
 * carry no API token — that is the whole reason SSO exists. The security is in
 * the `OidcService`: the state cookie is sealed, the ID token is signature- and
 * claim-verified, and the endpoints here only marshal HTTP to and from it.
 *
 * The callback deliberately does *not* set the session token as a cookie itself.
 * The platform authenticates with a bearer token, not a cookie, so the token is
 * returned to the caller (as JSON, or handed to a same-site console via a
 * short-lived fragment redirect) and the browser stores it the same way it would
 * a token from any other login. This keeps one auth model, and avoids minting an
 * ambient credential the CSRF surface would then have to defend.
 */

import type { OidcService } from '@ma/engine';

import type { Router, RequestContext, HandlerResult } from './router.ts';

const PREFIX = '/auth/v1';

/** The cookie the sealed OIDC state round-trips in. */
const STATE_COOKIE = 'ma_oidc_state';

export interface AuthRoutesDeps {
  oidc: OidcService;
  /**
   * When set, the callback 302-redirects the browser to `<consoleLoginOrigin>/#
   * token=...&expires=...` (or the login's safe `returnTo`) instead of returning
   * JSON, so a browser flow lands back in the console with its token. Absent
   * means the callback returns the token as JSON — correct for a CLI or a custom
   * front end driving the flow itself.
   */
  consoleLoginRedirect?: string;
}

export function registerAuthRoutes(router: Router, deps: AuthRoutesDeps): void {
  const { oidc } = deps;

  /** List configured providers, so a login page can render its buttons. */
  router.get(`${PREFIX}/providers`, () =>
    Promise.resolve({ status: 200, body: { providers: oidc.listProviders() } }),
  );

  /** Start a login: redirect to the IdP with a sealed state cookie. */
  router.get(`${PREFIX}/:provider/login`, async (context) => {
    const provider = context.params.provider!;
    const returnTo = context.query.get('returnTo') ?? undefined;
    const redirect = await oidc.beginAsync(provider, returnTo);
    return {
      status: 302,
      headers: {
        location: redirect.url,
        // HttpOnly so script cannot read it; SameSite=Lax so it survives the IdP
        // redirect back (a cross-site top-level GET) but not a silent cross-site
        // POST; Secure because the whole flow is https. Scoped to the callback
        // path so it is sent only where it is needed.
        'set-cookie': cookie(STATE_COOKIE, redirect.state, {
          path: `${PREFIX}/${provider}/callback`,
          maxAgeSeconds: 600,
        }),
      },
    };
  });

  /** Complete a login from the IdP's redirect. */
  router.get(`${PREFIX}/:provider/callback`, async (context): Promise<HandlerResult> => {
    const provider = context.params.provider!;
    const result = await oidc.complete({
      providerId: provider,
      code: context.query.get('code') ?? undefined,
      stateParam: context.query.get('state') ?? undefined,
      stateCookie: readCookie(context, STATE_COOKIE),
      error: context.query.get('error') ?? undefined,
      sourceIp: clientAddress(context),
    });

    // Clear the state cookie either way — it is single-use.
    const clear = cookie(STATE_COOKIE, '', {
      path: `${PREFIX}/${provider}/callback`,
      maxAgeSeconds: 0,
    });

    if (deps.consoleLoginRedirect) {
      // Hand the token back to the console via a URL fragment: a fragment is
      // never sent to a server or logged in an access log, and the safe
      // `returnTo` (a same-site path) is preserved as a query param the console
      // reads after it captures the token.
      const base = deps.consoleLoginRedirect.replace(/\/+$/, '');
      const target = result.returnTo ? `${base}${result.returnTo}` : base;
      const fragment = new URLSearchParams({
        token: result.token,
        expires: String(result.expiresAt),
      });
      return {
        status: 302,
        headers: { location: `${target}#${fragment.toString()}`, 'set-cookie': clear },
      };
    }

    return {
      status: 200,
      headers: { 'set-cookie': clear, 'cache-control': 'no-store' },
      body: {
        token: result.token,
        expiresAt: result.expiresAt,
        principal: {
          id: result.principal.id,
          subject: result.principal.subject,
          email: result.principal.email,
          displayName: result.principal.displayName,
        },
        ...(result.returnTo ? { returnTo: result.returnTo } : {}),
      },
    };
  });
}

/** Build a hardened Set-Cookie value. */
function cookie(
  name: string,
  value: string,
  options: { path: string; maxAgeSeconds: number },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  return parts.join('; ');
}

/** Read one cookie value from the request's Cookie header. */
function readCookie(context: RequestContext, name: string): string | undefined {
  const header = context.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/** The caller's socket address, for the login audit entry. */
function clientAddress(context: RequestContext): string {
  return context.raw.req.socket.remoteAddress ?? '';
}

/** Re-exported so the server can whitelist these paths as public. */
export function isAuthPath(path: string): boolean {
  return path.startsWith(`${PREFIX}/`);
}
