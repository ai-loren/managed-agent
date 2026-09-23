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

import type { Logger } from '@ma/core';
import type { FreeModelInfo, Model } from '@ma/contracts';

/** The subset of OpenRouter's `/models` entry we read. */
interface OpenRouterModelEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
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
 * A model is free when OpenRouter prices it at exactly zero for both prompt and
 * completion. The `:free` suffix is the published convention, but pricing is the
 * authority: a model with any non-zero price is NEVER classified free, so the
 * worst case is offering a free model too conservatively — never offering a paid
 * one. (An id carrying `:free` whose pricing field is missing is treated as paid,
 * for the same reason.)
 */
export function isFreeModel(entry: OpenRouterModelEntry): boolean {
  const pricing = entry.pricing ?? {};
  const zero = (value: unknown): boolean => {
    // OpenRouter sends prices as decimal strings ("0", "0.0000015"). Reject a
    // blank/missing value explicitly: `Number('')` is 0, so a naive coercion
    // would read an empty price field as "free" and let an unpriced model
    // through the guard.
    if (typeof value === 'string' && value.trim() === '') return false;
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n === 0;
  };
  return zero(pricing.prompt) && zero(pricing.completion);
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
export function projectFreeModels(entries: readonly OpenRouterModelEntry[]): FreeModel[] {
  const out: FreeModel[] = [];
  for (const entry of entries) {
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

    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter model catalogue returned ${response.status}`);
    }
    const body = (await response.json()) as { data?: OpenRouterModelEntry[] };
    const models = projectFreeModels(body.data ?? []);
    this.#cache = { at: this.#clock.now(), models };
    this.#logger?.info('discovered free models', { count: models.length });
    return models;
  }

  /**
   * Resolve one id against the live free catalogue.
   *
   * Registration goes through this rather than trusting the caller's id: an
   * operator (or a compromised client) must not be able to catalogue a paid
   * model by asking nicely. Returning `undefined` for an id the provider does
   * not currently offer free is the enforcement point for the free-only guard at
   * the *registration* boundary, complementing config-time filtering.
   */
  async findFreeModel(id: string): Promise<FreeModel | undefined> {
    const models = await this.listFreeModels();
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
