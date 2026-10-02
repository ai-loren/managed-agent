/**
 * Anthropic's Messages API.
 *
 * The conversation shape differs from chat completions in ways that each fail a
 * request outright when ignored: the system prompt is a top-level field, not a
 * message; a tool call is a `tool_use` block in the assistant's content and its
 * result a `tool_result` block in the *next user* turn; consecutive results
 * share that one user turn; and `max_tokens` is required.
 */

import { MaError } from '@ma/core';
import type { ModelProvider } from '@ma/gateway';

import {
  callName,
  classifyStatus,
  conversationIds,
  exchange,
  field,
  objectArguments,
  parseRetryAfter,
  systemText,
  tokens,
  toolSpecs,
  uniqueCallId,
  withoutToolBlocks,
  type CompletionRequest,
  type CompletionResult,
  type ProviderMessage,
  type ToolCall,
} from './shared.ts';

const CODE = 'ANTHROPIC';
const LABEL = 'Anthropic';
/** Required by the API; a request that names no ceiling still needs one. */
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicOptions {
  apiKey: string;
  /** Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  /** The `anthropic-version` header; defaults to 2023-06-01. */
  version?: string;
  fetch?: typeof fetch;
}

type Block = Record<string, unknown>;
interface Turn {
  role: 'user' | 'assistant';
  content: Block[];
}

/**
 * The bridge's messages as Anthropic turns. Same-role neighbours are merged into
 * one turn, so a run of tool results — and a user message after them — land in
 * the single user turn that must follow the assistant's `tool_use` blocks, with
 * the results first. Blank text is dropped: the API refuses an empty text block.
 */
export function toAnthropicMessages(messages: readonly ProviderMessage[]): Turn[] {
  const turns: Turn[] = [];
  const push = (role: Turn['role'], blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      // Results first: they answer the previous turn's tool_use blocks.
      const results = blocks.filter((block) => block.type === 'tool_result');
      const rest = blocks.filter((block) => block.type !== 'tool_result');
      last.content = [...last.content.filter((b) => b.type === 'tool_result'), ...results, ...last.content.filter((b) => b.type !== 'tool_result'), ...rest];
      return;
    }
    turns.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = message.content.trim().length > 0 ? [{ type: 'text', text: message.content }] : [];
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content }]);
    } else if (message.role === 'assistant') {
      push('assistant', [
        ...text,
        ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} })),
      ]);
    } else {
      push('user', text);
    }
  }
  return turns;
}

function mapStopReason(raw: unknown): string {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #version: string;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.#version = options.version ?? '2023-06-01';
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const tools = toolSpecs(request.tools).map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      input_schema: tool.parameters,
    }));
    const offered = request.messages as ProviderMessage[];
    const messages = tools.length > 0 ? offered : withoutToolBlocks(offered);
    const system = systemText(messages);
    const { response, body } = await exchange(CODE, LABEL, this.#fetch, `${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.#apiKey,
        'anthropic-version': this.#version,
        'content-type': 'application/json',
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.modelId,
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: toAnthropicMessages(messages),
        ...(tools.length > 0 ? { tools } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      }),
    });

    const error = field(body, 'error');
    if (!response.ok || field(body, 'type') === 'error') {
      const kind = String(field(error, 'type') ?? '');
      const message = `Anthropic error ${response.status}${kind ? ` (${kind})` : ''}: ${String(field(error, 'message') ?? 'no detail given')}`;
      // An overload can arrive as a 200-less error body with any status; its type says what it is.
      const status = kind === 'overloaded_error' ? 529 : kind === 'rate_limit_error' ? 429 : response.ok ? 502 : response.status;
      throw classifyStatus(CODE, status, message, parseRetryAfter(response));
    }

    const content = field(body, 'content');
    if (!Array.isArray(content)) {
      throw classifyStatus(CODE, 502, 'Anthropic answered without a content list, so there is no answer to use');
    }
    if (field(body, 'stop_reason') === 'refusal') {
      throw new MaError({
        code: 'ANTHROPIC_REFUSED',
        category: 'validation',
        message: 'The model declined to answer this request, so nothing it produced is used. Rephrase the request, or choose another model.',
      });
    }
    const seen = conversationIds(offered);
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of content) {
      if (field(block, 'type') === 'text') text += String(field(block, 'text') ?? '');
      if (field(block, 'type') === 'tool_use') {
        toolCalls.push({
          id: uniqueCallId(field(block, 'id'), seen),
          name: callName(field(block, 'name')),
          arguments: objectArguments(field(block, 'input')),
        });
      }
    }
    const usage = field(body, 'usage');
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: mapStopReason(field(body, 'stop_reason')),
      usage: {
        // Anthropic counts cached input apart from `input_tokens`, which is how the gateway prices it.
        inputTokens: tokens(field(usage, 'input_tokens')),
        outputTokens: tokens(field(usage, 'output_tokens')),
        cacheReadTokens: tokens(field(usage, 'cache_read_input_tokens')),
        cacheWriteTokens: tokens(field(usage, 'cache_creation_input_tokens')),
      },
    };
  }
}
