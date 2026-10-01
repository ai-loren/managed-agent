/**
 * Build the production model provider and its catalogue from server config.
 *
 * The platform owns the upstream credential: this runs in the server process and
 * the key never crosses the runtime bridge into a sandbox. When no provider is
 * configured this returns `undefined`, and the gateway answers a completion with
 * MODEL_GATEWAY_UNAVAILABLE rather than guessing.
 */

import { systemClock, type Logger } from '@ma/core';
import type { Model } from '@ma/contracts';
import type { ModelProvider } from '@ma/gateway';

import type { ServerConfig } from './config.ts';
import { ModelDiscovery } from './model-discovery.ts';
import { OpenRouterProvider } from './providers/openrouter.ts';

/** Conservative catalogue metadata for an id we did not otherwise configure. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;

export interface ModelWiring {
  models: ModelProvider;
  catalogue: Model[];
}

/** Prices paid models from the provider's catalogue; `ModelDiscovery` is the real one. */
export interface ModelPricer {
  pricedModelsFor(ids: readonly string[]): Promise<Map<string, Model | { refused: string }>>;
}

/** OpenRouter's convention for a zero-priced variant; free-only mode keys off it. */
function isFreeId(id: string): boolean {
  return id.endsWith(':free');
}

export async function buildModelWiring(
  config: ServerConfig,
  logger?: Logger,
  pricer?: ModelPricer,
): Promise<ModelWiring | undefined> {
  const { model } = config;
  // `model` is optional: callers that build a partial config (tests, embedders)
  // may omit it, which simply means "no provider".
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

  // A paid model is catalogued only at the price the provider lists for it: the
  // daily cost cap reads catalogue prices and nothing else, so a paid model
  // catalogued at zero is spend the cap cannot see. Free models need no lookup,
  // so free-only startup makes no network call.
  const paid = model.models.filter((id) => !isFreeId(id));
  const priced = new Map<string, Model | { refused: string }>();
  if (paid.length > 0) {
    if (!model.allowPaid) {
      for (const id of paid) priced.set(id, { refused: 'paid models are not allowed (set MA_OPENROUTER_ALLOW_PAID=true)' });
    } else {
      const lookup =
        pricer ??
        new ModelDiscovery({
          apiKey: model.apiKey,
          ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
          ...(logger ? { logger } : {}),
          clock: systemClock,
        });
      try {
        for (const [id, row] of await lookup.pricedModelsFor(paid)) priced.set(id, row);
      } catch (error) {
        const reason = `its price could not be fetched (${error instanceof Error ? error.message : String(error)})`;
        for (const id of paid) priced.set(id, { refused: reason });
      }
    }
  }

  // Every catalogued id is offered (a session may pin any of them and declare
  // others as fallbacks), in the configured order.
  const catalogue: Model[] = [];
  for (const id of model.models) {
    if (isFreeId(id)) {
      catalogue.push(freeRow(id, model.tools));
      continue;
    }
    const row = priced.get(id);
    if (row && !('refused' in row)) {
      catalogue.push({ ...row, capabilities: { ...row.capabilities, tools: row.capabilities.tools && model.tools } });
      continue;
    }
    logger?.warn('paid model left out of the catalogue', {
      modelId: id,
      reason: row && 'refused' in row ? row.refused : 'its price is unknown',
      next: 'pick a model whose price the provider lists in tokens, or a free one (GET /v1/models/free)',
    });
  }

  logger?.info('model provider wired', {
    provider: 'openrouter',
    defaultModel: defaultModel ?? '(none catalogued yet)',
    catalogued: catalogue.length,
    tools: model.tools,
  });

  return { models: provider, catalogue };
}

function freeRow(id: string, tools: boolean): Model {
  return {
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
    capabilities: { tools, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: {
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0,
      cacheWriteMicrosPerMillion: 0,
    },
    securityLevel: '',
    allowedWorkspaceIds: [],
  };
}
