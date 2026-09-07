#!/usr/bin/env node
/**
 * Server entry point.
 *
 * Loads configuration, bootstraps a first admin if the store is empty, starts
 * the platform, and shuts down cleanly on a signal.
 */

import { createLogger, hashToken, newId, randomToken, systemClock } from '@ma/core';

import { loadConfig } from './config.ts';
import { buildPlatform } from './platform.ts';

async function main(): Promise<void> {
  const { config, warnings } = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  for (const warning of warnings) logger.warn(warning);

  const clock = systemClock;
  const platform = buildPlatform({ config, logger, clock });

  // A fresh deployment has no way in. Rather than shipping a default password,
  // the first principal is created only when the store is genuinely empty, and
  // the token is printed once.
  const existing = await platform.store.principals.list({ limit: 1 });
  if (existing.items.length === 0) {
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

    // Written to stderr, deliberately: it is an operator notice, not part of
    // any machine-readable output the process produces.
    process.stderr.write(
      [
        '',
        '  A bootstrap admin was created because the store was empty.',
        `  Subject: ${principal.subject}`,
        `  Token:   ${token}`,
        '',
        '  This is shown once. Store it somewhere safe.',
        '',
      ].join('\n'),
    );
  }

  const address = await platform.start();
  process.stderr.write(`\n  Managed-Agent listening on http://${address.host}:${address.port}\n\n`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    platform
      .stop()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        logger.error('shutdown failed', { error });
        process.exitCode = 1;
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
