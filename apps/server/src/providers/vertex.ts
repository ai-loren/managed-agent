/**
 * Google Vertex AI: Gemini models through `generateContent`.
 *
 * Authenticated with OAuth access tokens the platform mints for itself, from
 * the first source that has one — the way Google's client libraries look:
 * a credentials file (a service account's key, signed into a JWT and exchanged
 * at its token endpoint, or a user's application-default refresh token), then
 * the GCE/GKE metadata server. No SDK: each is one HTTP call.
 *
 * Gemini's conversation differs from chat completions where it matters: the
 * model's turns are role `model`; a tool result is a `functionResponse` part
 * named by the *function*, not by a call id; and tool schemas are an OpenAPI
 * subset that refuses keys it does not know.
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MaError, type Clock } from '@ma/core';
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
  type CompletionRequest,
  type CompletionResult,
  type ProviderMessage,
  type ToolCall,
} from './shared.ts';

const CODE = 'VERTEX';
const LABEL = 'Vertex AI';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Renewed this long before expiry, so a call made near the end does not outlive its token. */
const RENEW_BEFORE_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 10_000;

/** OAuth access tokens for Google APIs. */
export interface GoogleAccessTokens {
  get(): Promise<string>;
  /** Drop the cached token, after a call was refused as unauthenticated. */
  invalidate(): void;
  /** Whose tokens these are, for messages. Never a secret. */
  readonly describe: string;
}

export interface GoogleCredentialOptions {
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  /** A credentials file named in configuration; else `GOOGLE_APPLICATION_CREDENTIALS`, else gcloud's ADC file. */
  credentialsFile?: string;
  fetch?: typeof fetch;
}

function unavailable(message: string, cause?: unknown): MaError {
  return new MaError({ code: 'GOOGLE_CREDENTIALS_UNAVAILABLE', category: 'unavailable', retryable: true, message, ...(cause ? { cause } : {}) });
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** One fetch at a time, none while the last token is good, and a good token kept through a failed renewal. */
function cachedTokens(clock: Clock, describe: string, load: () => Promise<{ token: string; expiresAt: number }>): GoogleAccessTokens {
  let current: { token: string; expiresAt: number } | undefined;
  let loading: Promise<{ token: string; expiresAt: number }> | undefined;
  return {
    describe,
    async get() {
      if (current && clock.now() < current.expiresAt - RENEW_BEFORE_MS) return current.token;
      loading ??= load().finally(() => {
        loading = undefined;
      });
      try {
        current = await loading;
      } catch (error) {
        if (current && clock.now() < current.expiresAt) return current.token;
        throw error;
      }
      return current.token;
    },
    invalidate() {
      current = undefined;
    },
  };
}

async function tokenResponse(
  doFetch: typeof fetch,
  clock: Clock,
  url: string,
  init: RequestInit,
  what: string,
): Promise<{ token: string; expiresAt: number }> {
  let response: Response;
  let text: string;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    throw unavailable(`Could not reach ${what} (${url}) for a Google access token.`, error);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  const token = field(body, 'access_token');
  if (!response.ok || typeof token !== 'string') {
    const detail = String(field(body, 'error_description') ?? field(body, 'error') ?? text.slice(0, 200));
    const message = `${what} refused to issue a Google access token (${response.status}: ${detail}).`;
    // A refused grant is a credentials problem a retry will not fix.
    if (response.status >= 400 && response.status < 500) {
      throw new MaError({ code: 'GOOGLE_CREDENTIALS_REFUSED', category: 'unauthenticated', message: `${message} Check the credentials file the platform uses for Vertex AI.` });
    }
    throw unavailable(message);
  }
  const expiresIn = Number(field(body, 'expires_in'));
  return { token, expiresAt: clock.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000 };
}

/** A service account's JSON key as the JWT bearer grant (RFC 7523) its token endpoint takes. */
export function serviceAccountAssertion(key: { client_email: string; private_key: string; private_key_id?: string; token_uri: string }, now: number): string {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat, exp: iat + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** The platform's Google identity, from the first place that has one. */
export async function googleCredentials(options: GoogleCredentialOptions): Promise<GoogleAccessTokens> {
  const { env, clock } = options;
  const doFetch = options.fetch ?? fetch;
  const named = options.credentialsFile ?? env.GOOGLE_APPLICATION_CREDENTIALS;
  const path = named ?? join(env.HOME ?? homedir(), '.config', 'gcloud', 'application_default_credentials.json');

  let raw: string | undefined;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (named) {
      throw new MaError({
        code: 'GOOGLE_CREDENTIALS_UNREADABLE',
        category: 'precondition',
        message: `The Google credentials file ${named} could not be read; mount a service account key or ADC file there, or unset it to use the metadata server.`,
        cause: error,
      });
    }
  }

  if (raw !== undefined) {
    let key: Record<string, unknown>;
    try {
      key = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new MaError({ code: 'GOOGLE_CREDENTIALS_INVALID', category: 'precondition', message: `${path} is not JSON; expected a service account key or an ADC file.`, cause: error });
    }
    if (key.type === 'service_account') {
      const account = {
        client_email: String(key.client_email ?? ''),
        private_key: String(key.private_key ?? ''),
        token_uri: String(key.token_uri ?? 'https://oauth2.googleapis.com/token'),
        ...(typeof key.private_key_id === 'string' ? { private_key_id: key.private_key_id } : {}),
      };
      if (!account.client_email || !account.private_key) {
        throw new MaError({ code: 'GOOGLE_CREDENTIALS_INVALID', category: 'precondition', message: `${path} is a service account key without client_email or private_key; download the key again.` });
      }
      return cachedTokens(clock, `service account ${account.client_email}`, () =>
        tokenResponse(doFetch, clock, account.token_uri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: serviceAccountAssertion(account, clock.now()),
          }).toString(),
        }, `the token endpoint of ${account.client_email}`),
      );
    }
    if (key.type === 'authorized_user') {
      const tokenUri = String(key.token_uri ?? 'https://oauth2.googleapis.com/token');
      return cachedTokens(clock, 'the application-default user credentials', () =>
        tokenResponse(doFetch, clock, tokenUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: String(key.client_id ?? ''),
            client_secret: String(key.client_secret ?? ''),
            refresh_token: String(key.refresh_token ?? ''),
          }).toString(),
        }, "Google's token endpoint"),
      );
    }
    throw new MaError({
      code: 'GOOGLE_CREDENTIALS_INVALID',
      category: 'precondition',
      message: `${path} has type ${JSON.stringify(key.type)}; expected "service_account" or "authorized_user".`,
    });
  }

  const host = env.GCE_METADATA_HOST ?? 'metadata.google.internal';
  return cachedTokens(clock, "the platform's GCE service account", () =>
    tokenResponse(
      doFetch,
      clock,
      `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
      { headers: { 'metadata-flavor': 'Google' } },
      'the GCE metadata server (no credentials file was found)',
    ),
  );
}

/** Keys Gemini's schema subset accepts; anything else fails the whole request. */
const SCALAR_SCHEMA_KEYS = ['description', 'title', 'minItems', 'maxItems', 'minimum', 'maximum'] as const;
const ALLOWED_FORMATS: Record<string, readonly string[]> = {
  STRING: ['enum', 'date-time'],
  NUMBER: ['float', 'double'],
  INTEGER: ['int32', 'int64'],
};

/** A JSON Schema reduced to the OpenAPI subset Gemini takes. */
export function geminiSchema(schema: unknown): Record<string, unknown> {
  const source = schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  let type = source.type;
  if (Array.isArray(type)) {
    if (type.includes('null')) out.nullable = true;
    type = type.find((each) => each !== 'null');
  }
  if (typeof type === 'string') out.type = type.toUpperCase();
  if (source.nullable === true) out.nullable = true;
  for (const key of SCALAR_SCHEMA_KEYS) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  if (typeof source.format === 'string' && ALLOWED_FORMATS[String(out.type)]?.includes(source.format)) out.format = source.format;
  if (Array.isArray(source.enum) && source.enum.every((value) => typeof value === 'string')) {
    out.enum = source.enum;
    out.type ??= 'STRING';
  }
  if (source.items !== undefined) out.items = geminiSchema(source.items);
  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const properties = Object.fromEntries(
      Object.entries(source.properties as Record<string, unknown>).map(([name, value]) => [name, geminiSchema(value)]),
    );
    if (Object.keys(properties).length > 0) {
      out.properties = properties;
      if (Array.isArray(source.required)) {
        const required = source.required.filter((name): name is string => typeof name === 'string' && name in properties);
        if (required.length > 0) out.required = required;
      }
    }
  }
  if (Array.isArray(source.anyOf) && source.anyOf.length > 0) out.anyOf = source.anyOf.map(geminiSchema);
  if (out.type === undefined && out.anyOf === undefined) out.type = out.properties ? 'OBJECT' : 'STRING';
  return out;
}

type Part = Record<string, unknown>;
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

/**
 * The bridge's messages as Gemini contents. A tool result names the function
 * it answers, looked up from the call it replies to; same-role neighbours are
 * merged, since a run of results is one turn; blank text is dropped.
 */
export function toGeminiContents(messages: readonly ProviderMessage[]): Content[] {
  const names = new Map<string, string>();
  for (const message of messages) for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  const contents: Content[] = [];
  const push = (role: Content['role'], parts: Part[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = message.content.trim().length > 0 ? [{ text: message.content }] : [];
    if (message.role === 'tool') {
      const name = names.get(message.toolCallId ?? '') ?? 'unknown_tool';
      push('user', [{ functionResponse: { name, response: { content: message.content } } }]);
    } else if (message.role === 'assistant') {
      push('model', [...text, ...(message.toolCalls ?? []).map((call) => ({ functionCall: { name: call.name, args: call.arguments ?? {} } }))]);
    } else {
      push('user', text);
    }
  }
  return contents;
}

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export interface VertexOptions {
  project: string;
  /** A region such as `us-central1`, or `global`. */
  location: string;
  tokens: GoogleAccessTokens;
  /** Defaults to the location's regional endpoint (`aiplatform.googleapis.com` for `global`). */
  endpoint?: string;
  fetch?: typeof fetch;
}

export class VertexProvider implements ModelProvider {
  readonly #project: string;
  readonly #location: string;
  readonly #tokens: GoogleAccessTokens;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;

  constructor(options: VertexOptions) {
    this.#project = options.project;
    this.#location = options.location;
    this.#tokens = options.tokens;
    const host = options.location === 'global' ? 'aiplatform.googleapis.com' : `${options.location}-aiplatform.googleapis.com`;
    this.#endpoint = (options.endpoint ?? `https://${host}`).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  /** `request.modelId` is the Gemini model name; the router has mapped the catalogue id to it. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const messages = request.messages as ProviderMessage[];
    const system = systemText(messages);
    const declarations = toolSpecs(request.tools).map((tool) => {
      const parameters = geminiSchema(tool.parameters);
      return {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        // An object schema with no properties is refused; a tool without arguments declares none.
        ...(parameters.properties ? { parameters } : {}),
      };
    });
    const body = JSON.stringify({
      contents: toGeminiContents(messages),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
      generationConfig: {
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      },
    });
    const url =
      `${this.#endpoint}/v1/projects/${encodeURIComponent(this.#project)}/locations/${encodeURIComponent(this.#location)}` +
      `/publishers/google/models/${encodeURIComponent(request.modelId)}:generateContent`;

    for (let attempt = 0; ; attempt++) {
      const token = await this.#tokens.get();
      const { response, body: answer } = await exchange(CODE, LABEL, this.#fetch, url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: request.signal,
      });
      if (response.ok) return this.#result(answer, messages);
      // A token revoked or rotated before its stated expiry: drop it and ask once more.
      if (response.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      const error = field(answer, 'error');
      const status = String(field(error, 'status') ?? '');
      throw classifyStatus(
        CODE,
        response.status,
        `Vertex AI error ${response.status}${status ? ` (${status})` : ''}: ${String(field(error, 'message') ?? 'no detail given')}`,
        parseRetryAfter(response),
      );
    }
  }

  #result(answer: unknown, messages: readonly ProviderMessage[]): CompletionResult {
    const candidates = field(answer, 'candidates');
    const candidate = Array.isArray(candidates) ? (candidates[0] as unknown) : undefined;
    const blocked = field(field(answer, 'promptFeedback'), 'blockReason');
    const finish = String(field(candidate, 'finishReason') ?? '');
    if (blocked || BLOCKED_FINISH.has(finish)) {
      throw new MaError({
        code: 'VERTEX_CONTENT_FILTERED',
        category: 'validation',
        message:
          `Vertex AI blocked this ${blocked ? 'request' : 'answer'} (${String(blocked ?? finish)}), so nothing it produced is used. ` +
          'Rephrase the request, or choose another model.',
      });
    }
    if (!candidate) throw classifyStatus(CODE, 502, 'Vertex AI answered with no candidates, so there is no answer to use');
    // A call the model garbled is a slip of the model, often fine on a second try.
    if (finish === 'MALFORMED_FUNCTION_CALL') {
      throw classifyStatus(CODE, 502, 'Vertex AI produced a malformed function call; the call is retried, then failed over');
    }
    const parts = field(field(candidate, 'content'), 'parts');
    const seen = conversationIds(messages);
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const part of Array.isArray(parts) ? parts : []) {
      // Thought summaries are the model's working, not its answer.
      if (field(part, 'thought') === true) continue;
      const partText = field(part, 'text');
      if (typeof partText === 'string') text += partText;
      const call = field(part, 'functionCall');
      if (call) {
        toolCalls.push({
          id: uniqueCallId(field(call, 'id'), seen),
          name: callName(field(call, 'name')),
          arguments: objectArguments(field(call, 'args')),
        });
      }
    }
    const usage = field(answer, 'usageMetadata');
    // `promptTokenCount` includes the cached part; the gateway prices that part apart.
    const cached = tokens(field(usage, 'cachedContentTokenCount'));
    return {
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toolCalls.length > 0 ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
      usage: {
        inputTokens: Math.max(0, tokens(field(usage, 'promptTokenCount')) - cached),
        // Thinking is billed as output.
        outputTokens: tokens(field(usage, 'candidatesTokenCount')) + tokens(field(usage, 'thoughtsTokenCount')),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  }
}
