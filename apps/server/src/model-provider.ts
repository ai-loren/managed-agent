/**
 * Build the production model provider and its catalogue from server config.
 *
 * The platform owns the upstream credential: this runs in the server process and
 * the key never crosses the runtime bridge into a sandbox. When no provider is
 * configured this returns `undefined`, and the gateway answers a completion with
 * MODEL_GATEWAY_UNAVAILABLE rather than guessing.
 */

import type { Logger } from '@ma/core';
import type { Model } from '@ma/contracts';
import type { ModelProvider } from '@ma/gateway';

import type { ServerConfig } from './config.ts';
import { OpenRouterProvider } from './providers/openrouter.ts';

/** Conservative catalogue metadata for an id we did not otherwise configure. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;

export interface ModelWiring {
  models: ModelProvider;
  catalogue: Model[];
}

export function buildModelWiring(config: ServerConfig, logger?: Logger): ModelWiring | undefined {
  const { model } = config;
  // `model` is optional at runtime: callers that build a partial config (tests,
  // embedders) may omit it, which simply means "no provider".
  if (model?.provider !== 'openrouter' || !model.apiKey) {
    return undefined;
  }
  // Models may be empty (nothing catalogued yet) — the provider is still wired so
  // discovery works and a model can be registered later. The provider needs a
  // *default* id only as a fallback for a request that names none, which the
  // bridge never does (it always passes the version's modelId), so an empty list
  // is safe here.
  const [defaultModel] = model.models;

  const provider = new OpenRouterProvider({
    apiKey: model.apiKey,
    model: defaultModel ?? '',
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    toolsEnabled: model.tools,
  });

  // Every catalogued id is offered (a session may pin any of them and declare
  // others as fallbacks). Pricing is 0: the deployment records token usage but,
  // for a free-only model list, no cost. An operator pointing at paid models
  // should catalogue them with real prices rather than rely on these defaults.
  const catalogue: Model[] = model.models.map((id) => ({
    id,
    provider: 'openrouter',
    model: id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id,
    displayName: id,
    enabled: true,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    compactThresholdTokens: Math.floor(DEFAULT_CONTEXT_WINDOW * 0.75),
    // OpenRouter routes the model's real capabilities; advertising tool support
    // matches the provider forwarding function-calling when model.tools is on.
    capabilities: { tools: model.tools, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: {
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0,
      cacheWriteMicrosPerMillion: 0,
    },
    securityLevel: '',
    allowedWorkspaceIds: [],
  }));

  logger?.info('model provider wired', {
    provider: 'openrouter',
    defaultModel: defaultModel ?? '(none catalogued yet)',
    catalogued: model.models.length,
    tools: model.tools,
  });

  return { models: provider, catalogue };
}
