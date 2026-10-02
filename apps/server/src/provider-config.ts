/**
 * Configuration of the native model providers: Anthropic, Azure OpenAI, AWS
 * Bedrock and Google Vertex AI.
 *
 * Each serves the models listed in its `MA_<PROVIDER>_MODELS`, one entry per
 * model, comma-separated:
 *
 *     [catalogueId=]model@input/output[/cacheRead/cacheWrite][@contextTokens/maxOutputTokens]
 *
 * Prices are USD per million tokens and are required: the daily cost cap reads
 * catalogue prices and nothing else, so a paid model catalogued without one is
 * spend the cap cannot see. Write `@0/0` for a model that really costs nothing
 * per token. The catalogue id defaults to `<provider>/<model>` and must be
 * unique across every provider, OpenRouter's included — the gateway knows a
 * model only by that id.
 */

import { readFileSync } from 'node:fs';

import { validationError } from '@ma/core';

export type NativeProviderName = 'anthropic' | 'azure-openai' | 'bedrock' | 'vertex';

/** One model a native provider serves. */
export interface NativeModelConfig {
  /** The catalogue id agents pin. */
  id: string;
  /** The provider's own name for it: a model id, a deployment, an inference profile. */
  model: string;
  /** USD per million tokens. */
  pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface NativeProvidersConfig {
  anthropic?: { apiKey: string; baseUrl?: string; version?: string; models: NativeModelConfig[] };
  azureOpenai?: { endpoint: string; apiKey: string; apiVersion: string; models: NativeModelConfig[] };
  /** Signed with the platform's AWS identity (the standard AWS_* chain); no key of its own. */
  bedrock?: { region: string; endpoint?: string; models: NativeModelConfig[] };
  /** Authenticated as the platform's Google identity (a credentials file, ADC, or the metadata server). */
  vertex?: { project: string; location: string; endpoint?: string; credentialsFile?: string; models: NativeModelConfig[] };
}

type Env = (name: string) => string | undefined;

const DEFAULT_WINDOWS: Record<NativeProviderName, { contextWindowTokens: number; maxOutputTokens: number }> = {
  anthropic: { contextWindowTokens: 200_000, maxOutputTokens: 8_192 },
  'azure-openai': { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
  bedrock: { contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
  vertex: { contextWindowTokens: 1_048_576, maxOutputTokens: 8_192 },
};

const PREFIX: Record<NativeProviderName, string> = {
  anthropic: 'anthropic',
  'azure-openai': 'azure',
  bedrock: 'bedrock',
  vertex: 'vertex',
};

function number(raw: string, what: string, variable: string, entry: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) {
    throw validationError(`${variable}: ${what} in "${entry}" must be a non-negative number; got "${raw}".`);
  }
  return value;
}

/** Parse one `MA_<PROVIDER>_MODELS` value. */
export function parseNativeModels(provider: NativeProviderName, variable: string, raw: string): NativeModelConfig[] {
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.map((entry) => {
    const [head = '', prices, windows, ...extra] = entry.split('@');
    if (prices === undefined || extra.length > 0) {
      throw validationError(
        `${variable}: "${entry}" has no price. Write it as [id=]model@input/output[/cacheRead/cacheWrite][@contextTokens/maxOutputTokens], ` +
          'in USD per million tokens — a model catalogued without its price is spend the daily cost cap cannot see.',
      );
    }
    const equals = head.indexOf('=');
    const model = (equals >= 0 ? head.slice(equals + 1) : head).trim();
    const id = (equals >= 0 ? head.slice(0, equals) : `${PREFIX[provider]}/${model}`).trim();
    if (model.length === 0 || model.length > 128) {
      throw validationError(`${variable}: "${entry}" must name the provider's model (1–128 characters) before the "@".`);
    }
    if (id.length < 3 || id.length > 256) {
      throw validationError(`${variable}: the catalogue id "${id}" in "${entry}" must be 3–256 characters.`);
    }
    const parts = prices.split('/');
    if (parts.length !== 2 && parts.length !== 4) {
      throw validationError(`${variable}: the price "${prices}" in "${entry}" must be input/output or input/output/cacheRead/cacheWrite (USD per million tokens).`);
    }
    const [input, output, cacheRead = '0', cacheWrite = '0'] = parts as [string, string, string?, string?];
    let window = DEFAULT_WINDOWS[provider];
    if (windows !== undefined) {
      const [context = '', maxOutput = ''] = windows.split('/');
      const contextWindowTokens = Number(context);
      const maxOutputTokens = Number(maxOutput);
      if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 1000 || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
        throw validationError(`${variable}: "${windows}" in "${entry}" must be contextTokens/maxOutputTokens, integers with a context of at least 1000.`);
      }
      window = { contextWindowTokens, maxOutputTokens };
    }
    return {
      id,
      model,
      pricing: {
        input: number(input, 'the input price', variable, entry),
        output: number(output, 'the output price', variable, entry),
        cacheRead: number(cacheRead, 'the cache-read price', variable, entry),
        cacheWrite: number(cacheWrite, 'the cache-write price', variable, entry),
      },
      ...window,
    };
  });
}

/** A secret from `<NAME>_FILE` (preferred) or `<NAME>`. */
function secret(env: Env, name: string): string | undefined {
  const file = env(`${name}_FILE`);
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch (error) {
      throw validationError(
        `${name}_FILE (${file}) could not be read: ${error instanceof Error ? error.message : String(error)}. Point it at a readable file holding the key.`,
      );
    }
  }
  return env(name)?.trim() || undefined;
}

function required(env: Env, name: string, why: string): string {
  const value = env(name)?.trim();
  if (!value) throw validationError(`${name} is required when ${why}; set it, or unset the model list to turn the provider off.`);
  return value;
}

/**
 * The native providers the environment configures. A provider is on when its
 * model list is set; what it then needs and lacks is a startup error, not a
 * provider that fails its first call.
 */
export function loadNativeProviders(env: Env, otherIds: readonly string[], warnings: string[]): NativeProvidersConfig {
  const config: NativeProvidersConfig = {};

  const anthropicModels = env('MA_ANTHROPIC_MODELS');
  if (anthropicModels) {
    const apiKey = secret(env, 'MA_ANTHROPIC_API_KEY');
    if (!apiKey) throw validationError('MA_ANTHROPIC_API_KEY (or MA_ANTHROPIC_API_KEY_FILE) is required when MA_ANTHROPIC_MODELS is set.');
    const baseUrl = env('MA_ANTHROPIC_BASE_URL');
    const version = env('MA_ANTHROPIC_VERSION');
    config.anthropic = {
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(version ? { version } : {}),
      models: parseNativeModels('anthropic', 'MA_ANTHROPIC_MODELS', anthropicModels),
    };
  } else if (env('MA_ANTHROPIC_API_KEY') || env('MA_ANTHROPIC_API_KEY_FILE')) {
    warnings.push('MA_ANTHROPIC_API_KEY is set but MA_ANTHROPIC_MODELS is not, so no Anthropic model is catalogued.');
  }

  const azureModels = env('MA_AZURE_OPENAI_MODELS');
  if (azureModels) {
    const apiKey = secret(env, 'MA_AZURE_OPENAI_API_KEY');
    if (!apiKey) throw validationError('MA_AZURE_OPENAI_API_KEY (or MA_AZURE_OPENAI_API_KEY_FILE) is required when MA_AZURE_OPENAI_MODELS is set.');
    config.azureOpenai = {
      endpoint: required(env, 'MA_AZURE_OPENAI_ENDPOINT', 'MA_AZURE_OPENAI_MODELS is set (the resource URL, e.g. https://my-resource.openai.azure.com)'),
      apiKey,
      apiVersion: env('MA_AZURE_OPENAI_API_VERSION') ?? '2024-10-21',
      models: parseNativeModels('azure-openai', 'MA_AZURE_OPENAI_MODELS', azureModels),
    };
  }

  const bedrockModels = env('MA_BEDROCK_MODELS');
  if (bedrockModels) {
    const region = env('MA_BEDROCK_REGION') ?? env('AWS_REGION') ?? env('AWS_DEFAULT_REGION');
    if (!region) throw validationError('MA_BEDROCK_REGION (or AWS_REGION) is required when MA_BEDROCK_MODELS is set: Bedrock is regional.');
    const endpoint = env('MA_BEDROCK_ENDPOINT');
    config.bedrock = {
      region,
      ...(endpoint ? { endpoint } : {}),
      models: parseNativeModels('bedrock', 'MA_BEDROCK_MODELS', bedrockModels),
    };
  }

  const vertexModels = env('MA_VERTEX_MODELS');
  if (vertexModels) {
    const endpoint = env('MA_VERTEX_ENDPOINT');
    const credentialsFile = env('MA_VERTEX_CREDENTIALS_FILE');
    config.vertex = {
      project: required(env, 'MA_VERTEX_PROJECT', 'MA_VERTEX_MODELS is set (the Google Cloud project that is billed)'),
      location: env('MA_VERTEX_LOCATION') ?? 'us-central1',
      ...(endpoint ? { endpoint } : {}),
      ...(credentialsFile ? { credentialsFile } : {}),
      models: parseNativeModels('vertex', 'MA_VERTEX_MODELS', vertexModels),
    };
  }

  // One catalogue, one id per model: a repeated id would route one provider's
  // calls to another and bill them at the wrong price.
  const owners = new Map<string, string>(otherIds.map((id) => [id, 'MA_OPENROUTER_MODELS']));
  const lists: [string, NativeModelConfig[] | undefined][] = [
    ['MA_ANTHROPIC_MODELS', config.anthropic?.models],
    ['MA_AZURE_OPENAI_MODELS', config.azureOpenai?.models],
    ['MA_BEDROCK_MODELS', config.bedrock?.models],
    ['MA_VERTEX_MODELS', config.vertex?.models],
  ];
  for (const [variable, models] of lists) {
    for (const model of models ?? []) {
      const owner = owners.get(model.id);
      if (owner) {
        throw validationError(
          `The catalogue id "${model.id}" is listed in both ${owner} and ${variable}; each model needs its own id. ` +
            `Name one explicitly, e.g. ${variable}="other-id=${model.model}@…".`,
        );
      }
      owners.set(model.id, variable);
    }
  }
  return config;
}
