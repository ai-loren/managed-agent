/**
 * First-run bootstrap.
 *
 * A fresh deployment has no way in. Rather than shipping a default password, the
 * first principal is created only when the store is genuinely empty, and its
 * token is returned so the caller can print it once. Shared by the production
 * entry point and the demo entry so the security-sensitive path exists once.
 */

import { hashToken, newId, randomToken, validationError, type Clock } from '@ma/core';
import type { Principal } from '@ma/contracts';

import type { ServerConfig } from './config.ts';
import type { Platform } from './platform.ts';

/**
 * The bootstrap token `.env.demo.example` ships for the demo. It is public — it
 * is in the repository — so it must never become a real deployment's admin key.
 */
export const PUBLISHED_DEMO_TOKEN = 'demo-admin-token';

export interface BootstrapResult {
  principal: Principal;
  /** The plaintext token, to show the operator once. */
  token: string;
}

/**
 * Create the first admin if the store is empty; otherwise do nothing.
 *
 * Returns the new principal and token when one was created, or `undefined` when
 * the store already had principals — so a caller only prints a token on a
 * genuinely fresh store.
 *
 * The created key is a permanent `ma:*` key of a platform admin, kept in the
 * database after the setting is gone, so the published demo token is refused
 * unless the caller is the demo entry (`allowPublishedToken`).
 */
export async function ensureBootstrapAdmin(
  platform: Platform,
  config: ServerConfig,
  clock: Clock,
  options: { allowPublishedToken?: boolean } = {},
): Promise<BootstrapResult | undefined> {
  const existing = await platform.store.principals.list({ limit: 1 });
  if (existing.items.length > 0) return undefined;

  if (config.bootstrap?.token === PUBLISHED_DEMO_TOKEN && !options.allowPublishedToken) {
    throw validationError(
      `MA_BOOTSTRAP_TOKEN is '${PUBLISHED_DEMO_TOKEN}', the token published in .env.demo.example; on this ` +
        `server it would become a permanent platform-admin key anyone can read in the repository. Set a long ` +
        `random token (MA_BOOTSTRAP_TOKEN_FILE, or scripts/start.sh --token-file), or leave it unset to have ` +
        `one generated and printed once.`,
    );
  }

  const token = config.bootstrap?.token ?? randomToken(32);
  const now = clock.now();
  const principal = await platform.store.principals.create({
    id: newId('principal', now),
    type: 'user',
    subject: config.bootstrap?.subject ?? 'admin',
    displayName: 'Bootstrap admin',
    email: '',
    isAdmin: true,
    disabled: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    createdBy: 'bootstrap',
  });

  await platform.store.apiKeys.create({
    id: newId('apiKey', now),
    principalId: principal.id,
    name: 'bootstrap',
    prefix: token.slice(0, 8),
    tokenHash: hashToken(token),
    scopes: ['ma:*'],
    createdAt: now,
    updatedAt: now,
    createdBy: principal.id,
  });

  return { principal, token };
}
