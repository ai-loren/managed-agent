#!/usr/bin/env node
/**
 * Server entry point.
 *
 * Loads configuration, bootstraps a first admin if the store is empty, starts
 * the platform, and shuts down cleanly on a signal.
 */

import { createLogger, systemClock } from '@ma/core';

import { ensureBootstrapAdmin } from './bootstrap.ts';
import { loadConfig } from './config.ts';
import { buildPlatform } from './platform.ts';

async function main(): Promise<void> {
  const { config, warnings } = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  for (const warning of warnings) logger.warn(warning);

  const clock = systemClock;
  const platform = buildPlatform({ config, logger, clock });

  // A fresh deployment has no way in. The first principal is created only when
  // the store is genuinely empty, and the token is printed once.
  const bootstrapped = await ensureBootstrapAdmin(platform, config, clock);
  if (bootstrapped) {
    // Written to stderr, deliberately: it is an operator notice, not part of
    // any machine-readable output the process produces.
    process.stderr.write(
      [
        '',
        '  A bootstrap admin was created because the store was empty.',
        `  Subject: ${bootstrapped.principal.subject}`,
        `  Token:   ${bootstrapped.token}`,
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
