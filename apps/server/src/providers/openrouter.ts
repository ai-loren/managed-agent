/**
 * Model providers for the demo entry.
 *
 * A `ModelProvider` is what the runtime bridge calls to reach a model
 * (`@ma/gateway`). It runs in the *server* process, so the provider credential
 * lives here and never reaches the sandbox — the sandbox calls the control
 * plane's `/runtime/v1/completions`, and the bridge calls this.
 *
 * Two are shipped for the demo: a real OpenRouter provider, and an echo
 * provider so the demo runs with no key at all.
 */

import { MaError } from '@ma/core';
import type { ModelProvider } from '@ma/gateway';

/**
 * Map an OpenRouter HTTP status onto a classified, retry-aware MaError.
 *
 * A plain Error coerces to category `internal`, which is NOT retryable — so the
 * bridge's `withRetry` gives up on the first attempt and the failover loop
 * (`if (i === 0 && !failure.retryable) throw failure`) skips every authorised
 * fallback model. A transient 429/503 from the primary model would then fail the
 * turn immediately, exactly the case the retry+failover machinery exists for.
 * Classifying by status makes a transient failure retryable (so it backs off and
 * fails over) while keeping a genuine client/auth error non-retryable.
 */
function classifyOpenRouterError(status: number, message: string, retryAfterSeconds?: number): MaError {
  if (status === 429) {
    return new MaError({
      code: 'OPENROUTER_RATE_LIMITED',
      category: 'quota',
      message,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status >= 500) {
    return new MaError({
      code: 'OPENROUTER_UNAVAILABLE',
      category: status === 504 ? 'timeout' : 'unavailable',
      message,
      retryable: true,
    });
  }
  if (status === 401) return new MaError({ code: 'OPENROUTER_UNAUTHENTICATED', category: 'unauthenticated', message });
  if (status === 403) return new MaError({ code: 'OPENROUTER_FORBIDDEN', category: 'permission', message });
  // 400/422 and any other 4xx: a request the model will reject identically on
  // retry — non-retryable so the turn fails fast rather than spinning.
  return new MaError({ code: 'OPENROUTER_REQUEST_REJECTED', category: 'validation', message });
}

/** Parse a `Retry-After` header (delta-seconds form) into seconds, if present. */
function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** OpenRouter's chat-completions response, the parts we read. */
interface OpenRouterResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

export interface OpenRouterOptions {
  apiKey: string;
  /** Model id, e.g. `nex-agi/nex-n2.5-mini:free`. */
  model: string;
  /** Override for tests; defaults to the real endpoint. */
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Map OpenRouter's `finish_reason` onto the reasons the runtime understands.
 * Agent-core normalises further, but a sensible mapping keeps the event log
 * honest about *why* a turn ended.
 */
function mapStopReason(raw: string | null | undefined): string {
  switch (raw) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

/**
 * A `ModelProvider` backed by OpenRouter's OpenAI-compatible chat API.
 *
 * Deliberately thin: it maps the bridge's request to one HTTP call and maps the
 * response back. Tool calls are not forwarded — the demo's free models are used
 * for plain chat — so `toolCalls` is left absent, which the contract allows.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenRouterOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(request: {
    modelId: string;
    messages: { role: string; content: string }[];
    tools: unknown[];
    maxOutputTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }> {
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      ...(request.signal ? { signal: request.signal } : {}),
      body: JSON.stringify({
        // The catalogued id may carry a provider prefix; the demo sets id === the
        // OpenRouter model, but honour whichever the bridge passes.
        model: request.modelId || this.#model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }),
    });

    const text = await response.text();
    let body: OpenRouterResponse;
    try {
      body = text ? (JSON.parse(text) as OpenRouterResponse) : {};
    } catch {
      // Non-JSON: still classify by status, so a 5xx HTML error page from a proxy
      // is retryable rather than a non-retryable `internal`.
      throw classifyOpenRouterError(
        response.status,
        `OpenRouter returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
        parseRetryAfter(response),
      );
    }

    if (!response.ok || body.error) {
      throw classifyOpenRouterError(
        response.status,
        `OpenRouter error ${response.status}: ${body.error?.message ?? text.slice(0, 200)}`,
        parseRetryAfter(response),
      );
    }

    const choice = body.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      stopReason: mapStopReason(choice?.finish_reason),
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

/**
 * A provider that echoes the last user message.
 *
 * The no-key fallback, so `pnpm demo` works offline: a turn still completes
 * deterministically and the whole provision→turn→events chain is exercisable
 * without a model account.
 */
export const echoProvider: ModelProvider = {
  complete(request) {
    const last = request.messages[request.messages.length - 1];
    return Promise.resolve({
      text: `echo: ${String(last?.content ?? '').slice(0, 200)}`,
      stopReason: 'end_turn',
      usage: { inputTokens: 8, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  },
};
