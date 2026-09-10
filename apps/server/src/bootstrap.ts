/**
 * First-run bootstrap.
 *
 * A fresh deployment has no way in. Rather than shipping a default password, the
 * first principal is created only when the store is genuinely empty, and its
 * token is returned so the caller can print it once. Shared by the production
 * entry point and the demo entry so the security-sensitive path exists once.
 */

import { hashToken, newId, randomToken, type Clock } from '@ma/core';
import type { Principal } from '@ma/contracts';

import type { ServerConfig } from './config.ts';
import type { Platform } from './platform.ts';

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
 */
export async function ensureBootstrapAdmin(
  platform: Platform,
  config: ServerConfig,
  clock: Clock,
): Promise<BootstrapResult | undefined> {
  const existing = await platform.store.principals.list({ limit: 1 });
  if (existing.items.length > 0) return undefined;

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
