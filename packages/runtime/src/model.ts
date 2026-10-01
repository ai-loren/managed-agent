/**
 * The model client interface.
 *
 * The harness never talks to a provider directly. It calls this, and the
 * gateway attaches credentials, enforces quota, records usage and emits
 * `model.*` events. Two consequences worth stating:
 *
 *  - A sandbox never holds a provider API key. A compromised agent cannot
 *    exfiltrate one, because there is nothing to exfiltrate.
 *  - Swapping providers is a gateway concern, not a harness rewrite.
 */

import type { Usage } from '@ma/contracts';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on `tool` messages, matching the call being answered. */
  toolCallId?: string;
  /** Tool calls the assistant requested in this message. */
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A tool as advertised to the model. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  modelId: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'interrupted';

/**
 * A streamed piece of a response. `done.modelId` is the model that actually
 * answered, when the client knows it can differ from the one requested (a
 * gateway that failed over to a fallback).
 */
export type ModelChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ModelToolCall }
  | { type: 'done'; stopReason: StopReason; usage: Usage; modelId?: string };

export interface ModelResponse {
  text: string;
  thinking: string;
  toolCalls: ModelToolCall[];
  stopReason: StopReason;
  usage: Usage;
  /** The model that answered, when the client reported one. */
  modelId?: string;
}

export interface ModelClient {
  /**
   * Stream a completion.
   *
   * Streaming is the only mode: the harness needs deltas to emit
   * `message.delta` events, and a non-streaming path would be a second
   * code path that behaves subtly differently under interruption.
   */
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

/** Assemble streamed chunks into a whole response. */
export async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelResponse> {
  let text = '';
  let thinking = '';
  const toolCalls: ModelToolCall[] = [];
  let stopReason: StopReason = 'end_turn';
  let modelId: string | undefined;
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 0,
  };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        text += chunk.text;
        break;
      case 'thinking':
        thinking += chunk.text;
        break;
      case 'tool_call':
        toolCalls.push(chunk.call);
        break;
      case 'done':
        stopReason = chunk.stopReason;
        usage = chunk.usage;
        modelId = chunk.modelId;
        break;
    }
  }

  return { text, thinking, toolCalls, stopReason, usage, ...(modelId === undefined ? {} : { modelId }) };
}
