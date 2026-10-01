/**
 * Free-model discovery.
 *
 * The platform holds the upstream model credential and (by default) only ever
 * calls free models. That guard is only useful if an operator can see *which*
 * free models exist and pick one, rather than having a single id baked into the
 * deployment. OpenRouter publishes the whole catalogue at `/api/v1/models` with
 * pricing and the parameters each model accepts, so we can ask it directly
 * instead of hard-coding a list that rots.
 *
 * This runs in the server process (it carries the key) and is deliberately
 * read-only: it lists candidates and can register one into the local catalogue,
 * but it never returns a credential and never turns off the free-only guard.
 */

import { MaError, type Logger } from '@ma/core';
import type { FreeModelInfo, Model } from '@ma/contracts';

/** The subset of OpenRouter's `/models` entry we read. */
interface OpenRouterModelEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  /**
   * Prices per unit, as decimal strings. Beyond `prompt`/`completion` (per
   * token) OpenRouter lists `request`, `image`, `web_search`,
   * `internal_reasoning`, `input_cache_read`, `input_cache_write` and adds more
   * over time.
   */
  pricing?: Record<string, unknown>;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
}

function catalogueUnavailable(detail: string, cause?: unknown): MaError {
  return new MaError({
    code: 'MODEL_DISCOVERY_UNAVAILABLE',
    category: 'unavailable',
    message:
      `The provider's model catalogue is unavailable right now (${detail}); listing and registering ` +
      `free models need it. Try again shortly.`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Re-exported for callers that only import from this module. */
export type FreeModel = FreeModelInfo;

export interface ModelDiscoveryOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  logger?: Logger;
  /** How long a fetched catalogue is reused. Default 10 minutes. */
  cacheMs?: number;
  /**
   * Time source for cache expiry. Required: a bare `Date.now()` is untestable
   * and the project forbids it, so the caller passes the platform clock.
   */
  clock: { now(): number };
}

const DEFAULT_CACHE_MS = 10 * 60 * 1000;

/**
 * A model is free when OpenRouter prices it at exactly zero in every dimension
 * it lists. The `:free` suffix is the published convention, but pricing is the
 * authority: a model with any non-zero price is NEVER classified free, so the
 * worst case is offering a free model too conservatively — never offering a paid
 * one. That is why every listed field counts, not just `prompt`/`completion`: a
 * per-request, image or web-search fee costs money just the same, and a field
 * added later is unknown, so it must be zero to pass. An id carrying `:free`
 * whose token prices are missing is treated as paid, for the same reason.
 */
export function isFreeModel(entry: OpenRouterModelEntry): boolean {
  const pricing = entry.pricing;
  if (!pricing || typeof pricing !== 'object') return false;
  const zero = (value: unknown): boolean => {
    // OpenRouter sends prices as decimal strings ("0", "0.0000015"). Reject a
    // blank/missing value explicitly: `Number('')` is 0, so a naive coercion
    // would read an empty price field as "free" and let an unpriced model
    // through the guard.
    if (typeof value === 'string' && value.trim() === '') return false;
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n === 0;
  };
  return zero(pricing.prompt) && zero(pricing.completion) && Object.values(pricing).every(zero);
}

/** Whether the model advertises OpenAI function-calling. */
export function supportsTools(entry: OpenRouterModelEntry): boolean {
  return Array.isArray(entry.supported_parameters)
    ? (entry.supported_parameters as unknown[]).includes('tools')
    : false;
}

/**
 * Project the upstream catalogue down to the free models, tools-capable first.
 *
 * Pure and exported so the projection is unit-tested against a fixture rather
 * than only against the live endpoint (which changes over time).
 */
export function projectFreeModels(entries: readonly unknown[]): FreeModel[] {
  const out: FreeModel[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as OpenRouterModelEntry;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    if (!isFreeModel(entry)) continue;
    const architecture = entry.architecture ?? {};
    out.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      contextLength:
        typeof entry.context_length === 'number' && entry.context_length > 0
          ? entry.context_length
          : 0,
      tools: supportsTools(entry),
      modalities: Array.isArray(architecture.input_modalities)
        ? (architecture.input_modalities as unknown[]).filter(
            (m): m is string => typeof m === 'string',
          )
        : [],
    });
  }
  // Tools-capable first, then largest context: the ordering an operator wants
  // when choosing a model that will drive an agent.
  out.sort((a, b) => (a.tools === b.tools ? b.contextLength - a.contextLength : a.tools ? -1 : 1));
  return out;
}

/** A per-token USD price as micro-dollars per million tokens; `undefined` if it is not a price. */
function microsPerMillion(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1_000_000_000_000);
}

/** The price fields the catalogue meters: tokens in, out, cache read, cache write. */
const METERED_PRICES = new Set(['prompt', 'completion', 'input_cache_read', 'input_cache_write']);

/**
 * A catalogue row for a model at the price the provider lists, or why it cannot
 * be catalogued.
 *
 * The platform meters spend from token counts and the catalogue's per-token
 * prices, and the daily cost cap sees nothing else. So a model is refused, not
 * catalogued at a guess, when any price is missing or not a number, or when it
 * charges in a way the catalogue cannot express (per request, per image, per web
 * search, or any field this code does not know): that spend would be invisible
 * to the cap. Reasoning tokens are counted as output tokens, so a reasoning
 * price no higher than the output price is covered.
 */
export function toPricedCatalogueModel(entry: OpenRouterModelEntry): Model | { refused: string } {
  const id = typeof entry.id === 'string' ? entry.id : '';
  const pricing = entry.pricing;
  if (!pricing || typeof pricing !== 'object') return { refused: 'the provider lists no pricing for it' };
  const input = microsPerMillion(pricing.prompt);
  const output = microsPerMillion(pricing.completion);
  if (input === undefined || output === undefined) {
    return { refused: 'its token prices are missing or not numbers' };
  }
  for (const [field, value] of Object.entries(pricing)) {
    if (METERED_PRICES.has(field)) {
      if (microsPerMillion(value) === undefined) return { refused: `its '${field}' price is not a number` };
      continue;
    }
    const price = microsPerMillion(value);
    if (field === 'internal_reasoning' && price !== undefined && price <= output) continue;
    if (price !== 0) {
      return { refused: `it charges by '${field}', which the platform cannot meter, so a spend cap would not see it` };
    }
  }
  const contextLength =
    typeof entry.context_length === 'number' && entry.context_length > 0 ? entry.context_length : 128_000;
  const inputModalities = entry.architecture?.input_modalities;
  const modalities = Array.isArray(inputModalities) ? (inputModalities as unknown[]) : [];
  return {
    id,
    provider: 'openrouter',
    model: id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id,
    displayName: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    enabled: true,
    contextWindowTokens: contextLength,
    maxOutputTokens: 8_192,
    compactThresholdTokens: Math.floor(contextLength * 0.75),
    capabilities: {
      tools: supportsTools(entry),
      vision: modalities.includes('image'),
      reasoningEffort: [],
      promptCaching: false,
    },
    pricing: {
      inputMicrosPerMillion: input,
      outputMicrosPerMillion: output,
      cacheReadMicrosPerMillion: microsPerMillion(pricing.input_cache_read) ?? 0,
      cacheWriteMicrosPerMillion: microsPerMillion(pricing.input_cache_write) ?? 0,
    },
    securityLevel: '',
    allowedWorkspaceIds: [],
  };
}

/** Build a `Model` catalogue row for a discovered free model. */
export function toCatalogueModel(free: FreeModel): Model {
  return {
    id: free.id,
    provider: 'openrouter',
    model: free.id.includes('/') ? free.id.slice(free.id.lastIndexOf('/') + 1) : free.id,
    displayName: free.name || free.id,
    enabled: true,
    contextWindowTokens: free.contextLength > 0 ? free.contextLength : 128_000,
    maxOutputTokens: 8_192,
    compactThresholdTokens: Math.floor((free.contextLength > 0 ? free.contextLength : 128_000) * 0.75),
    capabilities: {
      tools: free.tools,
      vision: free.modalities.includes('image'),
      reasoningEffort: [],
      promptCaching: false,
    },
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

export class ModelDiscovery {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger | undefined;
  readonly #cacheMs: number;
  readonly #clock: { now(): number };
  #cache: { at: number; models: FreeModel[] } | undefined;

  constructor(options: ModelDiscoveryOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#logger = options.logger;
    this.#cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
    this.#clock = options.clock;
  }

  /**
   * List the free models the provider currently offers, tools-capable first.
   *
   * Cached briefly: the catalogue changes on the order of days, and an operator
   * refreshing a picker should not hammer the provider. A fetch failure is
   * surfaced to the caller (a picker that silently shows nothing is worse than
   * one that says why) but never cached.
   */
  async listFreeModels(): Promise<FreeModel[]> {
    const cached = this.#cache;
    if (cached && this.#clock.now() - cached.at < this.#cacheMs) return cached.models;
    return this.#fetchFreeModels();
  }

  /** Ask the provider now, and refresh the cache with the answer. */
  async #fetchFreeModels(): Promise<FreeModel[]> {
    const models = projectFreeModels(await this.#fetchCatalogue());
    this.#cache = { at: this.#clock.now(), models };
    this.#logger?.info('discovered free models', { count: models.length });
    return models;
  }

  /**
   * Catalogue rows for these model ids at the prices the provider lists now, in
   * one fetch — or, per id, why it cannot be catalogued (not offered, or priced
   * in a way the platform cannot meter). For a paid model, this is the only
   * honest way onto the catalogue: at its real price, so the cost cap sees it.
   */
  async pricedModelsFor(ids: readonly string[]): Promise<Map<string, Model | { refused: string }>> {
    const entries = await this.#fetchCatalogue();
    const byId = new Map<string, OpenRouterModelEntry>();
    for (const raw of entries) {
      if (raw && typeof raw === 'object' && typeof (raw as OpenRouterModelEntry).id === 'string') {
        byId.set((raw as { id: string }).id, raw as OpenRouterModelEntry);
      }
    }
    const result = new Map<string, Model | { refused: string }>();
    for (const id of ids) {
      const entry = byId.get(id);
      result.set(id, entry ? toPricedCatalogueModel(entry) : { refused: 'the provider does not list it (not offered)' });
    }
    return result;
  }

  /** The provider's raw model list, or a 503-shaped refusal saying why it is unusable. */
  async #fetchCatalogue(): Promise<unknown[]> {
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(`${this.#baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
      const detail = typeof cause?.code === 'string' ? cause.code : error instanceof Error ? error.name : 'request failed';
      throw catalogueUnavailable(`the request failed: ${detail}`, error);
    }
    if (status < 200 || status >= 300) {
      throw catalogueUnavailable(`OpenRouter model catalogue returned ${status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw catalogueUnavailable('the answer was not JSON', error);
    }
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) {
      throw catalogueUnavailable('the answer had no model list');
    }
    return data;
  }

  /**
   * Resolve one id against the live free catalogue.
   *
   * Registration goes through this rather than trusting the caller's id: an
   * operator (or a compromised client) must not be able to catalogue a paid
   * model by asking nicely. Returning `undefined` for an id the provider does
   * not currently offer free is the enforcement point for the free-only guard at
   * the *registration* boundary, complementing config-time filtering. It asks
   * the provider afresh rather than trusting the cache: a model whose free
   * period ended inside the cache window must not be catalogued at zero.
   */
  async findFreeModel(id: string): Promise<FreeModel | undefined> {
    const models = await this.#fetchFreeModels();
    return models.find((model) => model.id === id);
  }

  /**
   * The catalogue row for a model the provider currently offers free, or
   * `undefined` if it does not. This is what the registration endpoint calls, so
   * the free-only refusal happens here against the live catalogue rather than
   * trusting whatever id a client sent.
   */
  async catalogueModelFor(id: string): Promise<Model | undefined> {
    const free = await this.findFreeModel(id);
    return free ? toCatalogueModel(free) : undefined;
  }
}
