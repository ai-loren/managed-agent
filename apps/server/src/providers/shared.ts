/**
 * What the native providers share: the bridge's message and tool shapes, how a
 * failure is classified for retry and failover, and tool-call ids that stay
 * unique for a whole conversation.
 *
 * The classification is the load-bearing part. The bridge retries in place and
 * fails over only on a *retryable* error, so a transient failure (a rate limit,
 * an overload, a dropped connection) must say so, and a request the provider
 * will refuse identically every time (a bad key, a malformed request) must not
 * — or one wrong key would fan out across every fallback, and one blip would
 * end a turn the fallbacks could have answered.
 */

import { randomUUID } from 'node:crypto';

import { MaError } from '@ma/core';
import type { ModelProvider } from '@ma/gateway';

export type CompletionRequest = Parameters<ModelProvider['complete']>[0];
export type CompletionResult = Awaited<ReturnType<ModelProvider['complete']>>;
export type ToolCall = NonNullable<CompletionResult['toolCalls']>[number];

/** One message as the bridge passes it (mirrors its completion schema). */
export interface ProviderMessage {
  role: string;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

/** A tool as the harness advertises it, normalised. */
export interface ToolSpec {
  name: string;
  description?: string;
  /** A JSON Schema object. */
  parameters: Record<string, unknown>;
}

/**
 * The longest tool-call name or id the bridge accepts back. The harness keeps
 * every call in its context and replays it, so one over-long value would fail
 * every later request of the session.
 */
export const MAX_TOOL_FIELD = 128;

/** The harness's `{ name, description, parameters }` list, with a schema object always present. */
export function toolSpecs(tools: readonly unknown[]): ToolSpec[] {
  return tools.flatMap((raw) => {
    const tool = raw as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof tool?.name !== 'string' || tool.name.length === 0) return [];
    const parameters =
      tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
        ? (tool.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} };
    return [{ name: tool.name, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), parameters }];
  });
}

/** Every tool-call id already in the conversation. */
export function conversationIds(messages: readonly ProviderMessage[]): Set<string> {
  const seen = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) seen.add(call.id);
    if (message.toolCallId) seen.add(message.toolCallId);
  }
  return seen;
}

/**
 * The provider's id for a call when it is usable, else a fresh one. A result is
 * matched to its call by id, so a missing, over-long or repeated id (a model
 * that numbers its calls from zero on every response) is replaced.
 */
export function uniqueCallId(offered: unknown, seen: Set<string>): string {
  const id =
    typeof offered === 'string' && offered.length > 0 && offered.length <= MAX_TOOL_FIELD && !seen.has(offered)
      ? offered
      : `call_${randomUUID().replaceAll('-', '')}`;
  seen.add(id);
  return id;
}

/** A tool name as the harness will see it: cut to the limit, which names no real tool if it was longer. */
export function callName(name: unknown): string {
  return String(name ?? '').slice(0, MAX_TOOL_FIELD);
}

/** Arguments as an object: a model that returns a non-object gets `{}` and the tool runs with defaults. */
export function objectArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    if (value.trim().length === 0) return {};
    try {
      return objectArguments(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The conversation with its tool calls and results written out as text, for a
 * request that offers no tools. Anthropic and Bedrock refuse tool blocks in a
 * request that defines none, and a fallback without tool support can still
 * answer from what the calls returned.
 */
export function withoutToolBlocks(messages: readonly ProviderMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'user', content: `Result of tool call ${message.toolCallId ?? ''}:\n${message.content}` };
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const calls = message.toolCalls
        .map((call) => `Called ${call.name} (${call.id}) with ${JSON.stringify(call.arguments ?? {})}`)
        .join('\n');
      return { role: 'assistant', content: message.content ? `${message.content}\n${calls}` : calls };
    }
    return message;
  });
}

/** The system prompt: every system message, in order. Providers that take it apart from the turns use this. */
export function systemText(messages: readonly ProviderMessage[]): string {
  return messages
    .filter((message) => message.role === 'system' && message.content.length > 0)
    .map((message) => message.content)
    .join('\n\n');
}

/** Parse a `Retry-After` header (delta-seconds form), if present. */
export function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * A provider's HTTP failure as a classified error. `code` is the provider's
 * prefix (`ANTHROPIC`, `BEDROCK`, …), so a log line names who refused.
 */
export function classifyStatus(
  code: string,
  status: number,
  message: string,
  retryAfterSeconds?: number,
): MaError {
  if (status === 429) {
    return new MaError({
      code: `${code}_RATE_LIMITED`,
      category: 'quota',
      message,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  // 529 is Anthropic's "overloaded"; 424 is Bedrock's model error, a failure of
  // the hosted model rather than of the request.
  if (status >= 500 || status === 408 || status === 424) {
    return new MaError({
      code: `${code}_UNAVAILABLE`,
      category: status === 504 || status === 408 ? 'timeout' : 'unavailable',
      message,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (status === 401) return new MaError({ code: `${code}_UNAUTHENTICATED`, category: 'unauthenticated', message });
  if (status === 403) return new MaError({ code: `${code}_FORBIDDEN`, category: 'permission', message });
  if (status === 404) return new MaError({ code: `${code}_MODEL_NOT_FOUND`, category: 'not_found', message });
  return new MaError({ code: `${code}_REQUEST_REJECTED`, category: 'validation', message });
}

/**
 * A failure before a complete response arrived — refused, reset, DNS, a body
 * cut off. Transient by nature, so retryable. An abort the caller asked for is
 * not a provider failure: its reason passes through unchanged.
 */
export function transportFailure(code: string, label: string, error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted) return signal.reason ?? error;
  if (MaError.is(error)) return error;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const detail = typeof cause?.code === 'string' ? cause.code : error instanceof Error ? error.message : String(error);
  return new MaError({
    code: `${code}_UNREACHABLE`,
    category: 'unavailable',
    retryable: true,
    message:
      `${label} did not return a complete response (${detail}). The call is retried, then fails over to the ` +
      `version's fallback models; if it persists, check this host's network path to ${label}.`,
    cause: error,
  });
}

/**
 * Send one request and read the whole body as JSON.
 *
 * A body that is not JSON still yields a classified error from its status: a
 * proxy's HTML 502 page is retryable, not an unclassified internal error.
 */
export async function exchange(
  code: string,
  label: string,
  doFetch: typeof fetch,
  url: string,
  init: RequestInit & { signal?: AbortSignal | undefined },
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  let text: string;
  try {
    response = await doFetch(url, init);
    text = await response.text();
  } catch (error) {
    throw transportFailure(code, label, error, init.signal ?? undefined);
  }
  if (text.length === 0) return { response, body: {} };
  try {
    return { response, body: JSON.parse(text) as unknown };
  } catch {
    throw classifyStatus(
      code,
      response.ok ? 502 : response.status,
      `${label} returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
      parseRetryAfter(response),
    );
  }
}

/** A field of an untyped JSON value, or undefined. */
export function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

/** A non-negative integer token count, else 0: a provider's usage block is not trusted to be well-formed. */
export function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
