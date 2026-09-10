#!/usr/bin/env node
/**
 * The demo entry point.
 *
 * `main.ts` is the production server: it wires no model provider, so an agent
 * cannot actually run a turn. This entry makes the platform *experienceable* in
 * one command — it injects a working model (OpenRouter with a free model, or an
 * offline echo fallback), catalogues it, bootstraps an admin, and seeds a demo
 * workspace and agent so the console has something to click on the first load.
 *
 * It defaults to an in-memory store, so a run leaves nothing behind. Everything
 * else — ports, keys, encryption — still comes from the ordinary config, so the
 * demo is the real server with two additions, not a fork of it.
 */

import { createLogger, systemClock } from '@ma/core';
import type { Model, Principal } from '@ma/contracts';

import { ensureBootstrapAdmin } from './bootstrap.ts';
import { loadConfig } from './config.ts';
import { buildPlatform } from './platform.ts';
import { OpenRouterProvider, echoProvider } from './providers/openrouter.ts';

const DEFAULT_OPENROUTER_MODEL = 'nex-agi/nex-n2.5-mini:free';

async function main(): Promise<void> {
  const { config } = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const clock = systemClock;

  // Pick the model backend. A real key routes to OpenRouter; without one the
  // echo provider keeps the demo runnable offline.
  const apiKey = process.env.MA_OPENROUTER_API_KEY?.trim();
  const modelName = process.env.MA_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const usingOpenRouter = Boolean(apiKey);

  const modelId = usingOpenRouter ? modelName : 'stub/echo';
  const models = usingOpenRouter
    ? new OpenRouterProvider({ apiKey: apiKey!, model: modelName })
    : echoProvider;

  const catalogue: Model[] = [
    {
      id: modelId,
      provider: usingOpenRouter ? 'openrouter' : 'stub',
      model: usingOpenRouter ? modelName : 'echo',
      displayName: usingOpenRouter ? modelName : 'Echo (offline)',
      enabled: true,
      contextWindowTokens: 32_000,
      maxOutputTokens: 2048,
      compactThresholdTokens: 24_000,
      capabilities: { tools: false, vision: false, reasoningEffort: [], promptCaching: false },
      pricing: {
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        cacheReadMicrosPerMillion: 0,
        cacheWriteMicrosPerMillion: 0,
      },
      securityLevel: '',
      allowedWorkspaceIds: [],
    },
  ];

  const platform = buildPlatform({ config, logger, clock, models, modelCatalogue: catalogue });

  const bootstrapped = await ensureBootstrapAdmin(platform, config, clock);
  await platform.start();

  // Seed a demo workspace + agent so the console is not empty on first open.
  // Requires a principal to act as; the bootstrap one (admin) is used when the
  // store was fresh. If the store already had principals (a re-run against a
  // file DB), seeding is skipped — there is nothing to authorize it as here.
  let seededWorkspaceId: string | undefined;
  if (bootstrapped) {
    seededWorkspaceId = await seedDemo(platform, bootstrapped.principal, modelId);
  }

  const address = { host: config.host, port: config.port };
  process.stderr.write(
    [
      '',
      '  ┌─────────────────────────────────────────────────────────────┐',
      '  │  Managed-Agent demo is running                                │',
      '  └─────────────────────────────────────────────────────────────┘',
      '',
      `  Console:   http://${address.host}:${address.port}/`,
      `  API:       http://${address.host}:${address.port}/v1`,
      `  Model:     ${usingOpenRouter ? `OpenRouter · ${modelName}` : 'echo (offline — set MA_OPENROUTER_API_KEY for a real model)'}`,
      ...(bootstrapped ? [`  Token:     ${bootstrapped.token}   (paste into the console)`] : []),
      ...(seededWorkspaceId ? [`  Workspace: ${seededWorkspaceId}   (seeded "Demo")`] : []),
      '',
      '  Open the console, paste the token, and open the Demo workspace.',
      '  Ctrl-C to stop.',
      '',
    ].join('\n'),
  );

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

/**
 * Create a "Demo" workspace with one ready-to-run agent, unless one already
 * exists. Returns the workspace id.
 */
async function seedDemo(
  platform: ReturnType<typeof buildPlatform>,
  principal: Principal,
  modelId: string,
): Promise<string> {
  const context = { principal };

  const existing = await platform.services.workspaces.list(context, { limit: 50 });
  const already = existing.items.find((workspace) => workspace.slug === 'demo');
  if (already) return already.id;

  const workspace = await platform.services.workspaces.create(context, {
    name: 'Demo',
    slug: 'demo',
    description: 'A ready-made workspace to try the platform.',
  });

  await platform.services.agents.create(context, {
    workspaceId: workspace.id,
    name: 'Assistant',
    description: 'A general assistant you can chat with.',
    spec: {
      systemPrompt:
        'You are a helpful assistant running on the Managed-Agent demo platform. ' +
        'Answer clearly and concisely.',
      model: { modelId },
    },
  });

  return workspace.id;
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start demo: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
