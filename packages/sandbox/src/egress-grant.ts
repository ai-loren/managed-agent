/**
 * Proxy settings for a sandbox whose allowlist a filtering proxy enforces.
 *
 * With a proxy secret configured, the proxy is the managed one
 * (`apps/egress-proxy`), and the sandbox's proxy URL carries a signed grant as
 * its credentials — its id, its allowlist, an expiry — so that proxy applies
 * this sandbox's allowlist rather than one for everyone. The format must match
 * `verifyGrant` there; a test signs here and verifies there. Without a secret
 * the URL is passed as configured, for a proxy the operator runs and filters
 * themselves.
 */

import { createHmac } from 'node:crypto';

export interface EgressGrant {
  sid: string;
  hosts: readonly string[];
  /** Epoch milliseconds. */
  exp: number;
}

export function signEgressGrant(secret: string, grant: EgressGrant): string {
  const payload = Buffer.from(JSON.stringify({ sid: grant.sid, hosts: [...grant.hosts], exp: grant.exp }), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret).update(`v1.${payload}`).digest('base64url');
  return `v1.${payload}.${signature}`;
}

/**
 * The proxy variables for one sandbox, in both casings (many clients read only
 * one). The control plane is exempt, so the runtime token exchange goes
 * direct rather than through an allowlist it is not on.
 */
export function egressProxyEnv(options: {
  proxy: string;
  secret?: string;
  sandboxId: string;
  hosts: readonly string[];
  expiresAt: number;
  controlPlaneUrl: string;
}): Record<string, string> {
  let proxy = options.proxy;
  if (options.secret) {
    const url = new URL(options.proxy);
    url.username = encodeURIComponent(options.sandboxId);
    url.password = signEgressGrant(options.secret, { sid: options.sandboxId, hosts: options.hosts, exp: options.expiresAt });
    proxy = url.toString().replace(/\/$/, '');
  }
  let controlPlaneHost = '';
  try {
    controlPlaneHost = new URL(options.controlPlaneUrl).host;
  } catch {
    // A malformed URL is surfaced elsewhere; here it just means no exemption.
  }
  const noProxy = ['127.0.0.1', 'localhost', ...(controlPlaneHost ? [controlPlaneHost] : [])].join(',');
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: noProxy,
    http_proxy: proxy,
    https_proxy: proxy,
    no_proxy: noProxy,
  };
}
