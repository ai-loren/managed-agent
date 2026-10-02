/**
 * One `ModelProvider` over several.
 *
 * The bridge knows models only by catalogue id, and the catalogue is where the
 * allowlist, the prices and the failover order live — so a fallback on another
 * vendor is just another id in the version's list. This maps each id to the
 * provider that serves it and to that provider's own name for the model (a
 * deployment, an inference profile), so retry, the circuit breaker, failover
 * and cost metering work across vendors without knowing there is more than one.
 */

import { MaError } from '@ma/core';
import type { ModelProvider } from '@ma/gateway';

import type { CompletionRequest, CompletionResult } from './shared.ts';

export interface ModelRoute {
  provider: ModelProvider;
  /** Which provider, for messages. */
  providerName: string;
  /** The provider's own name for the model. */
  nativeModel: string;
}

export interface RoutingProviderOptions {
  routes: ReadonlyMap<string, ModelRoute>;
  /**
   * Serves any id with no route: OpenRouter, whose models are also registered
   * at runtime through model discovery, not only from configuration.
   */
  fallback?: ModelProvider;
}

export class RoutingProvider implements ModelProvider {
  readonly #routes: ReadonlyMap<string, ModelRoute>;
  readonly #fallback: ModelProvider | undefined;

  constructor(options: RoutingProviderOptions) {
    this.#routes = options.routes;
    this.#fallback = options.fallback;
  }

  complete(request: CompletionRequest): Promise<CompletionResult> {
    const route = this.#routes.get(request.modelId);
    if (route) return route.provider.complete({ ...request, modelId: route.nativeModel });
    if (this.#fallback) return this.#fallback.complete(request);
    return Promise.reject(
      new MaError({
        code: 'MODEL_NOT_ROUTED',
        category: 'not_found',
        message:
          `No configured provider serves model ${request.modelId}; this deployment routes ${[...this.#routes.keys()].join(', ') || 'no models'}. ` +
          'Add it to a provider’s model list (e.g. MA_ANTHROPIC_MODELS) and restart, or pin a routed model.',
      }),
    );
  }
}
