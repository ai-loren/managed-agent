/**
 * AWS Bedrock, through the Converse API.
 *
 * Converse is one request shape for every model Bedrock hosts, so one provider
 * covers Claude, Llama, Mistral, Nova and the rest. Requests are signed with
 * SigV4 using the platform's own AWS identity — the same credential chain the
 * SQS connectors use (environment keys, IRSA, the container endpoint, then the
 * instance role) — so a deployment on AWS needs no model key at all.
 */

import { MaError, type Clock } from '@ma/core';
import { signV4, type AwsCredentialProvider } from '@ma/connectors';
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

const CODE = 'BEDROCK';
const LABEL = 'Bedrock';

/** What an `x-amzn-errortype` names, as the HTTP status it behaves like. */
const ERROR_STATUS: Record<string, number> = {
  ThrottlingException: 429,
  ServiceQuotaExceededException: 429,
  ModelNotReadyException: 503,
  ServiceUnavailableException: 503,
  InternalServerException: 500,
  ModelTimeoutException: 408,
  ModelErrorException: 424,
  ValidationException: 400,
  AccessDeniedException: 403,
  ResourceNotFoundException: 404,
};

/** Refusals that mean the signing credentials went stale, not that access is denied. */
const STALE_CREDENTIALS = new Set(['ExpiredTokenException', 'UnrecognizedClientException', 'InvalidSignatureException']);

export interface BedrockOptions {
  region: string;
  credentials: AwsCredentialProvider;
  clock: Clock;
  /** Defaults to `https://bedrock-runtime.{region}.amazonaws.com`. */
  endpoint?: string;
  fetch?: typeof fetch;
}

type Block = Record<string, unknown>;
interface Turn {
  role: 'user' | 'assistant';
  content: Block[];
}

/**
 * The bridge's messages as Converse turns. Converse refuses two turns of the
 * same role in a row and a blank text block, so neighbours are merged — tool
 * results first, since they answer the turn before — and blank text dropped.
 */
export function toConverseMessages(messages: readonly ProviderMessage[]): Turn[] {
  const turns: Turn[] = [];
  const push = (role: Turn['role'], blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      const isResult = (block: Block): boolean => 'toolResult' in block;
      last.content = [
        ...last.content.filter(isResult),
        ...blocks.filter(isResult),
        ...last.content.filter((block) => !isResult(block)),
        ...blocks.filter((block) => !isResult(block)),
      ];
      return;
    }
    turns.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = message.content.trim().length > 0 ? [{ text: message.content }] : [];
    if (message.role === 'tool') {
      push('user', [
        {
          toolResult: {
            toolUseId: message.toolCallId ?? '',
            content: [{ text: message.content.trim().length > 0 ? message.content : '(no output)' }],
          },
        },
      ]);
    } else if (message.role === 'assistant') {
      push('assistant', [
        ...text,
        ...(message.toolCalls ?? []).map((call) => ({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments ?? {} } })),
      ]);
    } else {
      push('user', text);
    }
  }
  return turns;
}

export class BedrockProvider implements ModelProvider {
  readonly #region: string;
  readonly #credentials: AwsCredentialProvider;
  readonly #clock: Clock;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: BedrockOptions) {
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#endpoint = (options.endpoint ?? `https://bedrock-runtime.${options.region}.amazonaws.com`).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  /** `request.modelId` is the Bedrock model or inference-profile id; the router has mapped the catalogue id to it. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const tools = toolSpecs(request.tools);
    const offered = request.messages as ProviderMessage[];
    const messages = tools.length > 0 ? offered : withoutToolBlocks(offered);
    const system = systemText(messages);
    const body = JSON.stringify({
      messages: toConverseMessages(messages),
      ...(system ? { system: [{ text: system }] } : {}),
      inferenceConfig: {
        ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
      ...(tools.length > 0
        ? {
            toolConfig: {
              tools: tools.map((tool) => ({
                toolSpec: {
                  name: tool.name,
                  ...(tool.description === undefined ? {} : { description: tool.description }),
                  inputSchema: { json: tool.parameters },
                },
              })),
            },
          }
        : {}),
    });
    const url = `${this.#endpoint}/model/${encodeURIComponent(request.modelId)}/converse`;

    // Credentials renewed elsewhere (a rotated key, a lapsed session token) are
    // refused once; the cache is dropped and the call signed again with fresh ones.
    for (let attempt = 0; ; attempt++) {
      const credentials = await this.#credentials.get();
      const headers = signV4({
        method: 'POST',
        url: new URL(url),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        region: this.#region,
        service: 'bedrock',
        credentials,
        now: this.#clock.now(),
      });
      const { response, body: answer } = await exchange(CODE, LABEL, this.#fetch, url, {
        method: 'POST',
        headers,
        body,
        signal: request.signal,
      });
      if (response.ok) return this.#result(answer, offered);

      const errorType = (response.headers.get('x-amzn-errortype') ?? String(field(answer, '__type') ?? '')).split(':')[0]!.split('#').pop()!;
      if (attempt === 0 && STALE_CREDENTIALS.has(errorType)) {
        this.#credentials.invalidate();
        continue;
      }
      const message =
        `Bedrock error ${response.status}${errorType ? ` (${errorType})` : ''}: ` +
        `${String(field(answer, 'message') ?? field(answer, 'Message') ?? 'no detail given')}`;
      throw classifyStatus(CODE, ERROR_STATUS[errorType] ?? response.status, message, parseRetryAfter(response));
    }
  }

  #result(answer: unknown, offered: readonly ProviderMessage[]): CompletionResult {
    const stopReason = field(answer, 'stopReason');
    if (stopReason === 'guardrail_intervened' || stopReason === 'content_filtered') {
      throw new MaError({
        code: 'BEDROCK_CONTENT_FILTERED',
        category: 'validation',
        message:
          `A Bedrock ${stopReason === 'guardrail_intervened' ? 'guardrail' : 'content filter'} stopped this answer, so nothing it produced is used. ` +
          'Rephrase the request, or review the guardrail attached to the model.',
      });
    }
    const content = field(field(field(answer, 'output'), 'message'), 'content');
    if (!Array.isArray(content)) {
      throw classifyStatus(CODE, 502, 'Bedrock answered without an output message, so there is no answer to use');
    }
    const seen = conversationIds(offered);
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of content) {
      const blockText = field(block, 'text');
      if (typeof blockText === 'string') text += blockText;
      const use = field(block, 'toolUse');
      if (use) {
        toolCalls.push({
          id: uniqueCallId(field(use, 'toolUseId'), seen),
          name: callName(field(use, 'name')),
          arguments: objectArguments(field(use, 'input')),
        });
      }
    }
    const usage = field(answer, 'usage');
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: stopReason === 'tool_use' ? 'tool_use' : stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
      usage: {
        inputTokens: tokens(field(usage, 'inputTokens')),
        outputTokens: tokens(field(usage, 'outputTokens')),
        cacheReadTokens: tokens(field(usage, 'cacheReadInputTokens')),
        cacheWriteTokens: tokens(field(usage, 'cacheWriteInputTokens')),
      },
    };
  }
}
