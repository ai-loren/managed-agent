/**
 * Build the production model provider and its catalogue from server config.
 *
 * The platform owns the upstream credential: this runs in the server process and
 * the key never crosses the runtime bridge into a sandbox. When no provider is
 * configured this returns `undefined`, and the gateway answers a completion with
 * MODEL_GATEWAY_UNAVAILABLE rather than guessing.
 */

import { systemClock, type Clock, type Logger } from '@ma/core';
import { awsIdentity } from '@ma/connectors';
import type { Model } from '@ma/contracts';
import type { ModelProvider } from '@ma/gateway';

import type { ServerConfig } from './config.ts';
import { ModelDiscovery } from './model-discovery.ts';
import type { NativeModelConfig, NativeProviderName, NativeProvidersConfig } from './provider-config.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { AzureOpenAIProvider } from './providers/azure-openai.ts';
import { BedrockProvider } from './providers/bedrock.ts';
import { OpenRouterProvider } from './providers/openrouter.ts';
import { RoutingProvider, type ModelRoute } from './providers/router.ts';
import { googleCredentials, VertexProvider } from './providers/vertex.ts';

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

/** Where a native provider finds its platform identity and its clock; tests inject these. */
export interface ModelWiringDeps {
  env?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  fetch?: typeof fetch;
}

/**
 * The provider the gateway calls and the catalogue it serves: OpenRouter and the
 * native providers side by side, one id per model, so a version can fail over
 * from one vendor to another and every call is priced from its own row.
 */
export async function buildModelWiring(
  config: ServerConfig,
  logger?: Logger,
  pricer?: ModelPricer,
  deps: ModelWiringDeps = {},
): Promise<ModelWiring | undefined> {
  const openRouter = await openRouterWiring(config, logger, pricer);
  const native = await nativeWiring(config.providers ?? {}, config.model?.tools ?? true, deps, logger);
  if (!openRouter && native.routes.size === 0) return undefined;
  const models =
    native.routes.size === 0
      ? openRouter!.models
      : new RoutingProvider({ routes: native.routes, ...(openRouter ? { fallback: openRouter.models } : {}) });
  return { models, catalogue: [...(openRouter?.catalogue ?? []), ...native.catalogue] };
}

async function nativeWiring(
  providers: NativeProvidersConfig,
  tools: boolean,
  deps: ModelWiringDeps,
  logger: Logger | undefined,
): Promise<{ routes: Map<string, ModelRoute>; catalogue: Model[] }> {
  const routes = new Map<string, ModelRoute>();
  const catalogue: Model[] = [];
  const clock = deps.clock ?? systemClock;
  const env = deps.env ?? process.env;
  const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};
  const add = (name: NativeProviderName, provider: ModelProvider, models: readonly NativeModelConfig[]): void => {
    for (const spec of models) {
      routes.set(spec.id, { provider, providerName: name, nativeModel: spec.model });
      catalogue.push(nativeRow(name, spec, tools));
    }
    logger?.info('model provider wired', { provider: name, catalogued: models.map((spec) => spec.id), tools });
  };

  if (providers.anthropic) {
    const { apiKey, baseUrl, version, models } = providers.anthropic;
    add('anthropic', new AnthropicProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(version ? { version } : {}), ...fetchOption }), models);
  }
  if (providers.azureOpenai) {
    const { endpoint, apiKey, apiVersion, models } = providers.azureOpenai;
    add('azure-openai', new AzureOpenAIProvider({ endpoint, apiKey, apiVersion, ...fetchOption }), models);
  }
  if (providers.bedrock) {
    const { region, endpoint, models } = providers.bedrock;
    // The platform's own AWS identity, found where the SQS connectors find it.
    const credentials = awsIdentity({ env, clock });
    add('bedrock', new BedrockProvider({ region, credentials, clock, ...(endpoint ? { endpoint } : {}), ...fetchOption }), models);
    logger?.info('Bedrock signs with the platform AWS identity', { identity: credentials.describe, region });
  }
  if (providers.vertex) {
    const { project, location, endpoint, credentialsFile, models } = providers.vertex;
    const tokens = await googleCredentials({ env, clock, ...(credentialsFile ? { credentialsFile } : {}), ...fetchOption });
    add('vertex', new VertexProvider({ project, location, tokens, ...(endpoint ? { endpoint } : {}), ...fetchOption }), models);
    logger?.info('Vertex AI authenticates as the platform Google identity', { identity: tokens.describe, project, location });
  }
  return { routes, catalogue };
}

/** USD per million tokens as the catalogue's micro-dollars per million. */
function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function nativeRow(provider: NativeProviderName, spec: NativeModelConfig, tools: boolean): Model {
  return {
    id: spec.id,
    provider,
    model: spec.model,
    displayName: spec.id,
    enabled: true,
    contextWindowTokens: spec.contextWindowTokens,
    maxOutputTokens: spec.maxOutputTokens,
    compactThresholdTokens: Math.max(1000, Math.floor(spec.contextWindowTokens * 0.75)),
    capabilities: { tools, vision: false, reasoningEffort: [], promptCaching: false },
    pricing: {
      inputMicrosPerMillion: micros(spec.pricing.input),
      outputMicrosPerMillion: micros(spec.pricing.output),
      cacheReadMicrosPerMillion: micros(spec.pricing.cacheRead),
      cacheWriteMicrosPerMillion: micros(spec.pricing.cacheWrite),
    },
    securityLevel: '',
    allowedWorkspaceIds: [],
  };
}

async function openRouterWiring(
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

const NATIVE_PROVIDERS: ReadonlySet<string> = new Set<NativeProviderName>(['anthropic', 'azure-openai', 'bedrock', 'vertex']);

/**
 * Why a catalogue row must not serve calls, or `undefined` when nothing needs
 * guarding: the free-only rule below for OpenRouter rows, and — for a native
 * provider's rows — that configuration no longer lists them. The catalogue
 * persists across restarts; a row whose model was taken out of
 * `MA_<PROVIDER>_MODELS` would otherwise keep its price and serve on, routed to
 * whichever provider takes unrouted ids.
 */
export function catalogueGuard(config: ServerConfig): ((model: Model) => string | undefined) | undefined {
  const paid = paidModelGuard(config);
  const configured = new Set(
    [config.providers?.anthropic, config.providers?.azureOpenai, config.providers?.bedrock, config.providers?.vertex].flatMap(
      (provider) => provider?.models.map((spec) => spec.id) ?? [],
    ),
  );
  return (model) => {
    if (NATIVE_PROVIDERS.has(model.provider)) {
      return configured.has(model.id) ? undefined : `its provider's model list (MA_${model.provider.toUpperCase().replace('-', '_')}_MODELS) no longer includes it`;
    }
    return paid?.(model);
  };
}

/**
 * In free-only mode, why a catalogue row must not serve calls — or `undefined`
 * when there is nothing to guard (paid models allowed, or no provider wired).
 *
 * Config only adds rows; a file database keeps every row a previous run
 * catalogued. Without this, a deployment that once allowed paid models and then
 * turned that off would keep calling the paid rows it had catalogued, so the
 * server retires them at startup. Only OpenRouter rows are judged: another
 * provider's rows were put there by whoever embeds the platform.
 */
export function paidModelGuard(config: ServerConfig): ((model: Model) => string | undefined) | undefined {
  if (config.model?.provider !== 'openrouter' || config.model.allowPaid) return undefined;
  return (model) => {
    if (model.provider !== 'openrouter') return undefined;
    const { pricing } = model;
    const free =
      isFreeId(model.id) &&
      pricing.inputMicrosPerMillion === 0 &&
      pricing.outputMicrosPerMillion === 0 &&
      pricing.cacheReadMicrosPerMillion === 0 &&
      pricing.cacheWriteMicrosPerMillion === 0;
    return free ? undefined : 'paid models are not allowed (MA_OPENROUTER_ALLOW_PAID is not "true")';
  };
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
