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

import { randomUUID } from 'node:crypto';

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
  if (status >= 500 || status === 408) {
    return new MaError({
      code: 'OPENROUTER_UNAVAILABLE',
      category: status === 504 || status === 408 ? 'timeout' : 'unavailable',
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

/**
 * Classify a failure that happened before a complete response arrived — the
 * connection was refused or reset, DNS failed, or the body was cut off.
 *
 * Such a failure is transient by nature, so it is retryable `unavailable`: left
 * as a plain Error it would coerce to a non-retryable `internal` and defeat
 * retry and failover exactly when the network blips. An abort the *caller*
 * asked for (its deadline, a disconnected sandbox) is not a provider failure:
 * its reason is rethrown unchanged so the caller's own classification stands.
 */
function transportFailure(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason ?? error;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const detail = typeof cause?.code === 'string' ? cause.code : error instanceof Error ? error.message : String(error);
  return new MaError({
    code: 'OPENROUTER_UNREACHABLE',
    category: 'unavailable',
    message:
      `OpenRouter did not return a complete response (${detail}). The call is retried, then ` +
      `fails over to the version's fallback models; if it persists, check this host's network path to OpenRouter.`,
    cause: error,
  });
}

/** Parse a `Retry-After` header (delta-seconds form) into seconds, if present. */
function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

type OpenRouterToolCall = {
  id?: string | null;
  type?: string | null;
  function?: { name?: string | null; arguments?: string | null };
};

/** OpenRouter's chat-completions response, the parts we read. */
interface OpenRouterResponse {
  choices?: {
    message?: {
      content?: string | null;
      // OpenAI-shaped function calls the model requested.
      tool_calls?: OpenRouterToolCall[];
    };
    finish_reason?: string | null;
    /** Set when the upstream failed after generation started. */
    error?: { message?: string; code?: number };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; code?: number };
}

/** The bridge's wire shape for one message (mirrors completionSchema). */
interface ProviderMessage {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** A tool as the harness advertises it: { name, description, parameters }. */
interface ProviderTool {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
}

export interface OpenRouterOptions {
  apiKey: string;
  /** Default model id, e.g. `nex-agi/nex-n2.5-mini:free`. */
  model: string;
  /** Override for tests; defaults to the real endpoint. */
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Advertise tools as OpenAI function-calling. Defaults to true. Turn off for a
   * model/endpoint that rejects a `tools` field (some plain-chat free models).
   */
  toolsEnabled?: boolean;
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
 * Convert the harness's conversation into OpenAI's chat messages.
 *
 * The tool-use round trip has two shapes that differ from plain chat:
 *  - an `assistant` message that called tools carries `tool_calls` (and may have
 *    empty content);
 *  - each tool's result is a separate `tool` message carrying `tool_call_id`.
 * Without these the API rejects the request or the model cannot see what it is
 * answering.
 */
function toOpenRouterMessages(messages: ProviderMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    // Tool result: OpenAI wants role "tool" + the matching call id.
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content ?? '',
      };
    }
    // Assistant message that previously requested one or more tools.
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      };
    }
    return { role: message.role, content: message.content ?? '' };
  });
}

/**
 * The longest tool-call name or id the bridge accepts back. The harness keeps
 * every call in its context and replays it on the next request, so one value
 * over this limit would fail every later request of the session.
 */
const MAX_TOOL_FIELD = 128;

/**
 * Parse one OpenAI function call into the harness's shape. Model-emitted
 * arguments are a JSON *string*; a free model occasionally returns invalid or
 * empty JSON, in which case we surface `{}` rather than dropping the call (the
 * tool runs with defaults and the loop continues) — a parse throw here would
 * fail the whole turn on a cosmetic formatting slip.
 *
 * Ids must be unique across the whole conversation, because a tool result is
 * matched to its call by id: a missing, empty, over-long or repeated id is
 * replaced by a fresh random one. An over-long name is cut to the limit, which
 * names no real tool, so the harness answers "unknown tool" and carries on.
 */
function parseToolCall(
  raw: OpenRouterToolCall | undefined,
  seenIds: Set<string>,
): { id: string; name: string; arguments: Record<string, unknown> } {
  const name = String(raw?.function?.name ?? '').slice(0, MAX_TOOL_FIELD);
  const rawArgs = raw?.function?.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string' && rawArgs.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  }
  const offered = typeof raw?.id === 'string' ? raw.id : '';
  const id =
    offered.length > 0 && offered.length <= MAX_TOOL_FIELD && !seenIds.has(offered)
      ? offered
      : `call_${randomUUID().replaceAll('-', '')}`;
  seenIds.add(id);
  return { id, name, arguments: args };
}

/**
 * A `ModelProvider` backed by OpenRouter's OpenAI-compatible chat API.
 *
 * It maps the bridge's request to one HTTP call and maps the response back,
 * including OpenAI function-calling: the harness's tools are advertised, an
 * assistant's prior calls and tool results are represented correctly, and any
 * tool calls the model requests are returned so the agent-core tool-dispatch
 * loop runs.
 */
export class OpenRouterProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #toolsEnabled: boolean;

  constructor(options: OpenRouterOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#toolsEnabled = options.toolsEnabled ?? true;
  }

  async complete(request: {
    modelId: string;
    messages: ProviderMessage[];
    tools: unknown[];
    maxOutputTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }> {
    // Only advertise tools when the harness supplied any and function-calling
    // is enabled. OpenAI requires parameters to be a JSON Schema object; pass
    // the harness's {name, description, parameters} through verbatim.
    const tools =
      this.#toolsEnabled && Array.isArray(request.tools) && request.tools.length > 0
        ? (request.tools as ProviderTool[]).map((tool) => ({
            type: 'function',
            function: {
              name: String(tool.name),
              ...(tool.description === undefined ? {} : { description: String(tool.description) }),
              parameters:
                tool.parameters && typeof tool.parameters === 'object'
                  ? tool.parameters
                  : { type: 'object', properties: {} },
            },
          }))
        : undefined;

    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        ...(request.signal ? { signal: request.signal } : {}),
        body: JSON.stringify({
          // The catalogued id may carry a provider prefix; honour whichever the
          // bridge passes (it has already authorized it against the pinned model).
          model: request.modelId || this.#model,
          messages: toOpenRouterMessages(request.messages),
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        }),
      });
      text = await response.text();
    } catch (error) {
      throw transportFailure(error, request.signal);
    }
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

    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

    // OpenRouter reports a failure after generation started as HTTP 200 with
    // `error.code`; that code, not the 200, says what happened. An error with no
    // usable code is treated as transient, so it is retried and failed over.
    if (body.error) {
      const code = typeof body.error.code === 'number' && body.error.code >= 400 ? body.error.code : undefined;
      throw classifyOpenRouterError(
        code ?? (response.ok ? 502 : response.status),
        `OpenRouter error ${code ?? response.status}: ${body.error.message ?? text.slice(0, 200)}`,
        parseRetryAfter(response),
      );
    }
    if (!response.ok) {
      throw classifyOpenRouterError(
        response.status,
        `OpenRouter error ${response.status}: ${text.slice(0, 200)}`,
        parseRetryAfter(response),
      );
    }

    // A 200 without an answer is a failure, not a finished turn: taking it as one
    // would end the turn on empty or cut-off text and record a success.
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!choice) {
      throw classifyOpenRouterError(502, 'OpenRouter answered with no choices, so there is no answer to use');
    }
    if (choice.error || choice.finish_reason === 'error') {
      const code = typeof choice.error?.code === 'number' && choice.error.code >= 400 ? choice.error.code : 502;
      throw classifyOpenRouterError(
        code,
        `OpenRouter's answer ended in an error (${code}): ${choice.error?.message ?? 'no detail given'}`,
      );
    }
    if (choice.finish_reason === 'content_filter') {
      throw new MaError({
        code: 'OPENROUTER_CONTENT_FILTERED',
        category: 'validation',
        message:
          "The provider's content filter stopped this answer, so what was produced so far is not used. " +
          'Rephrase the request, or choose a model with a different provider.',
      });
    }

    const message = choice.message;
    const rawToolCalls = message?.tool_calls;
    // Ids already in this conversation, so a model that numbers its calls from
    // `call_0` on every response cannot collide with an earlier call.
    const seenIds = new Set<string>();
    for (const prior of request.messages) {
      for (const call of prior.toolCalls ?? []) seenIds.add(call.id);
      if (prior.toolCallId) seenIds.add(prior.toolCallId);
    }
    const toolCalls =
      Array.isArray(rawToolCalls) && rawToolCalls.length > 0
        ? rawToolCalls.map((call) => parseToolCall(call, seenIds))
        : undefined;

    return {
      text: message?.content ?? '',
      ...(toolCalls ? { toolCalls } : {}),
      stopReason: mapStopReason(choice.finish_reason),
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
