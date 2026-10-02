/**
 * Azure OpenAI.
 *
 * The chat-completions wire format, addressed differently: the model is a
 * *deployment* named in the path, the API version is a query parameter, and the
 * key travels in an `api-key` header. A filtered answer is reported as a
 * `content_filter` finish (or a 400 whose code says so), never as a success.
 */

import { MaError } from '@ma/core';
import type { ModelProvider } from '@ma/gateway';

import { mapStopReason, parseToolCall, toOpenRouterMessages, type OpenRouterToolCall } from './openrouter.ts';
import {
  classifyStatus,
  conversationIds,
  exchange,
  field,
  parseRetryAfter,
  tokens,
  toolSpecs,
  type CompletionRequest,
  type CompletionResult,
  type ProviderMessage,
} from './shared.ts';

const CODE = 'AZURE_OPENAI';
const LABEL = 'Azure OpenAI';

export interface AzureOpenAIOptions {
  /** The resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  endpoint: string;
  apiKey: string;
  /** The `api-version` query parameter, e.g. `2024-10-21`. */
  apiVersion: string;
  fetch?: typeof fetch;
}

function filtered(): MaError {
  return new MaError({
    code: 'AZURE_OPENAI_CONTENT_FILTERED',
    category: 'validation',
    message:
      "Azure's content filter stopped this request or its answer, so nothing it produced is used. " +
      'Rephrase the request, or adjust the deployment’s content filter policy.',
  });
}

export class AzureOpenAIProvider implements ModelProvider {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: AzureOpenAIOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#apiVersion = options.apiVersion;
    this.#fetch = options.fetch ?? fetch;
  }

  /** `request.modelId` is the deployment name; the router has already mapped the catalogue id to it. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const messages = request.messages as ProviderMessage[];
    const tools = toolSpecs(request.tools).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters,
      },
    }));
    const url =
      `${this.#endpoint}/openai/deployments/${encodeURIComponent(request.modelId)}/chat/completions` +
      `?api-version=${encodeURIComponent(this.#apiVersion)}`;
    const { response, body } = await exchange(CODE, LABEL, this.#fetch, url, {
      method: 'POST',
      headers: { 'api-key': this.#apiKey, 'content-type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({
        messages: toOpenRouterMessages(messages),
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }),
    });

    if (!response.ok) {
      const error = field(body, 'error');
      if (field(error, 'code') === 'content_filter') throw filtered();
      throw classifyStatus(
        CODE,
        response.status,
        `Azure OpenAI error ${response.status}: ${String(field(error, 'message') ?? 'no detail given')}`,
        parseRetryAfter(response),
      );
    }

    const choices = field(body, 'choices');
    const choice = Array.isArray(choices) ? (choices[0] as unknown) : undefined;
    if (!choice) throw classifyStatus(CODE, 502, 'Azure OpenAI answered with no choices, so there is no answer to use');
    const finish = field(choice, 'finish_reason');
    if (finish === 'content_filter') throw filtered();

    const message = field(choice, 'message');
    const rawCalls = field(message, 'tool_calls');
    const seen = conversationIds(messages);
    const toolCalls = Array.isArray(rawCalls) && rawCalls.length > 0
      ? rawCalls.map((call) => parseToolCall(call as OpenRouterToolCall, seen))
      : undefined;
    const usage = field(body, 'usage');
    // `prompt_tokens` includes the cached part; the gateway prices that part apart.
    const cached = tokens(field(field(usage, 'prompt_tokens_details'), 'cached_tokens'));
    return {
      text: String(field(message, 'content') ?? ''),
      ...(toolCalls ? { toolCalls } : {}),
      stopReason: mapStopReason(typeof finish === 'string' ? finish : null),
      usage: {
        inputTokens: Math.max(0, tokens(field(usage, 'prompt_tokens')) - cached),
        outputTokens: tokens(field(usage, 'completion_tokens')),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }
}
