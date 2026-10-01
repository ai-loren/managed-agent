/**
 * Slack and Feishu (Lark), built into the chat connector: how each signs what
 * it sends, the shape of a message event, and the API a reply goes out by.
 *
 * Each needs one secret to check what arrives and another to send, so a
 * connector on either platform keeps both in its one credential, as a JSON
 * object: `{"signingSecret", "botToken"}` for Slack; `{"appSecret"}` with
 * `"encryptKey"` and/or `"verificationToken"` for Feishu.
 */

import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { MaError, validationError, type Clock } from '@ma/core';
import type { Connector } from '@ma/contracts';

import type { InboundRequest, TriggerEvent, VerifyResult } from './adapter.ts';
import { redactCredentials } from './origin.ts';

export interface SlackSecret {
  signingSecret: string;
  botToken: string;
}

export interface FeishuSecret {
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

/** How far a Slack request's timestamp may be from now; Slack's own guidance. */
const SLACK_TOLERANCE_SECONDS = 300;
/** Slack renders long messages poorly past this; a longer reply goes as several. */
const SLACK_MAX_TEXT = 4_000;
/** Well inside Feishu's 150 KB request body, three bytes a character and JSON escaping included. */
const FEISHU_MAX_TEXT = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
/** Renewed this long before it expires; Feishu hands back the same token while half an hour remains. */
const FEISHU_TOKEN_RENEW_BEFORE_MS = 5 * 60_000;

function header(request: InboundRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

function secretObject(platform: string, secret: string | undefined, expected: string): Record<string, unknown> {
  if (secret === undefined) {
    throw validationError(
      `The ${platform} connector's credential could not be read: it is unbound, revoked or expired. Bind a live credential holding ${expected}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    // The parse error is dropped, not wrapped: it quotes the start of the value.
    throw validationError(`The ${platform} connector's credential must hold ${expected}; its value is not JSON. Replace the value.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw validationError(`The ${platform} connector's credential must hold ${expected}; its value is JSON but not an object. Replace the value.`);
  }
  return parsed as Record<string, unknown>;
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A Slack connector's secrets, or an error that says what the credential lacks. Never quotes it. */
export function slackSecret(secret: string | undefined): SlackSecret {
  const expected = '{"signingSecret": "…", "botToken": "xoxb-…"}';
  const value = secretObject('slack', secret, expected);
  const missing = ['signingSecret', 'botToken'].filter((key) => !filled(value[key]));
  if (missing.length > 0) {
    throw validationError(
      `The slack connector's credential has no ${missing.join(' or ')}; it must hold ${expected}. The signing secret is under ` +
        "the app's Basic Information, the bot token (xoxb-…) under OAuth & Permissions.",
    );
  }
  return { signingSecret: value.signingSecret as string, botToken: value.botToken as string };
}

/** A Feishu connector's secrets, or an error that says what the credential lacks. Never quotes it. */
export function feishuSecret(secret: string | undefined): FeishuSecret {
  const expected = '{"appSecret": "…", "encryptKey": "…"} (or "verificationToken" in place of, or beside, encryptKey)';
  const value = secretObject('feishu', secret, expected);
  if (!filled(value.appSecret)) {
    throw validationError(`The feishu connector's credential has no appSecret; it must hold ${expected}. The app secret is under Credentials & Basic Info.`);
  }
  if (!filled(value.encryptKey) && !filled(value.verificationToken)) {
    throw validationError(
      `The feishu connector's credential has neither encryptKey nor verificationToken, so nothing it receives could be checked; ` +
        `it must hold ${expected}. Both are under Events & Callbacks > Encryption Strategy; prefer encryptKey, which signs every request.`,
    );
  }
  return {
    appSecret: value.appSecret,
    ...(filled(value.encryptKey) ? { encryptKey: value.encryptKey } : {}),
    ...(filled(value.verificationToken) ? { verificationToken: value.verificationToken } : {}),
  };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/** Check Slack's v0 signature over the timestamp and the raw body, then answer its URL check. */
export function verifySlack(request: InboundRequest, secret: SlackSecret, now: number): VerifyResult {
  const signature = header(request, 'x-slack-signature');
  const timestamp = Number(header(request, 'x-slack-request-timestamp') ?? '');
  if (!signature || !Number.isInteger(timestamp)) {
    return { ok: false, reason: 'missing X-Slack-Signature or X-Slack-Request-Timestamp' };
  }
  if (Math.abs(now / 1000 - timestamp) > SLACK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'the Slack request timestamp is more than five minutes from now' };
  }
  const expected = `v0=${createHmac('sha256', secret.signingSecret).update(`v0:${timestamp}:`).update(request.rawBody).digest('hex')}`;
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: 'the Slack signature does not match; check signingSecret in the connector credential' };
  }
  const body = request.body as { type?: unknown; challenge?: unknown } | undefined;
  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    return { ok: true, immediateResponse: { status: 200, body: { challenge: body.challenge } } };
  }
  return { ok: true };
}

/** A person's message to the bot, from a Slack Events API callback; anything else is ignored. */
export function normalizeSlack(body: unknown, connector: Connector): TriggerEvent | undefined {
  const envelope = body as { type?: unknown; event?: Record<string, unknown> } | undefined;
  const event = envelope?.type === 'event_callback' ? envelope.event : undefined;
  if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return undefined;
  // Edits, deletions, joins, and every bot's posts — this connector's replies
  // among them, which would otherwise be answered in turn, forever.
  if (event.subtype !== undefined || event.bot_id !== undefined) return undefined;
  const channel = text(event.channel);
  const ts = text(event.ts);
  const said = text(event.text).replace(/^(?:\s*<@[A-Z0-9]+(?:\|[^>]*)?>)+/, '').trim();
  if (!channel || !ts || !said) return undefined;
  const threadTs = text(event.thread_ts);
  return {
    // Channel and ts, not the event id: an app that subscribes to messages and
    // to mentions is sent one mention twice, as two events with one ts.
    externalEventId: `slack:${channel}:${ts}`,
    scopeType: 'chat',
    scopeKey: threadTs ? `${channel}:${threadTs}` : channel,
    scopeLabel: `chat in ${connector.name}`,
    events: [{ type: 'user.message', text: said, attachments: [] }],
    summary: said.slice(0, 4000),
    responseContext: { channel, ...(threadTs ? { threadTs } : {}) },
  };
}

const SLACK_HINTS: Record<string, string> = {
  not_in_channel: 'Invite the app to the channel (/invite @app); the next reply will arrive.',
  channel_not_found: 'The bot token cannot see the channel: invite the app, or check the token is for the workspace the events come from.',
  invalid_auth: 'botToken in the connector credential is not a valid token; replace it with the Bot User OAuth Token (xoxb-…).',
  not_authed: 'botToken in the connector credential is not a valid token; replace it with the Bot User OAuth Token (xoxb-…).',
  token_revoked: 'botToken was revoked; reinstall the app and put its new token in the credential.',
  account_inactive: 'botToken belongs to a deactivated app or user; reinstall the app and put its new token in the credential.',
  missing_scope: 'The bot token lacks chat:write; add the scope under OAuth & Permissions and reinstall the app.',
  is_archived: 'The channel is archived; unarchive it or talk to the bot elsewhere.',
  ratelimited: 'Slack is rate-limiting this app; later replies go through once it allows.',
};

/** Post a reply to a Slack channel (in its thread, if it came from one), in parts if it is long. */
export async function sendSlack(options: {
  api: string;
  clock: Clock;
  token: string;
  channel: string;
  threadTs?: string;
  text: string;
}): Promise<void> {
  for (const part of splitText(options.text, SLACK_MAX_TEXT)) {
    const body = JSON.stringify({ channel: options.channel, text: part, ...(options.threadTs ? { thread_ts: options.threadTs } : {}) });
    const response = await post(`${options.api}/chat.postMessage`, { authorization: `Bearer ${options.token}` }, body, 'Slack', options.clock);
    const answer = (await response.json().catch(() => ({}))) as { ok?: unknown; error?: unknown };
    if (response.ok && answer.ok === true) continue;
    const code = typeof answer.error === 'string' ? answer.error : `HTTP ${response.status}`;
    throw new MaError({
      code: 'CHAT_SEND_FAILED',
      category: code === 'ratelimited' || response.status >= 500 ? 'unavailable' : 'permission',
      retryable: code === 'ratelimited' || response.status >= 500,
      message: `Slack refused the reply (${code}). ${SLACK_HINTS[code] ?? 'Check the app is installed, has chat:write and is in the channel.'}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Feishu
// ---------------------------------------------------------------------------

/** Feishu's encrypted events: AES-256-CBC under the SHA-256 of the Encrypt Key, the IV in front. */
export function feishuDecrypt(encrypted: string, encryptKey: string): string {
  const data = Buffer.from(encrypted, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), data.subarray(0, 16));
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
}

/**
 * Decrypt a Feishu event if it is encrypted, answer the URL check, and check
 * the rest: the signature over timestamp, nonce, Encrypt Key and raw body when
 * there is an Encrypt Key, the verification token when there is one. The
 * decrypted body goes on to `normalize`.
 */
export function verifyFeishu(request: InboundRequest, secret: FeishuSecret): VerifyResult {
  const received = request.body as Record<string, unknown> | undefined;
  let payload: unknown = received;
  if (typeof received?.encrypt === 'string') {
    if (!secret.encryptKey) return { ok: false, reason: 'Feishu sent an encrypted event and the connector credential has no encryptKey' };
    try {
      payload = JSON.parse(feishuDecrypt(received.encrypt, secret.encryptKey));
    } catch {
      return { ok: false, reason: "a Feishu event did not decrypt; check encryptKey matches the app's Encrypt Key" };
    }
  }
  const body = payload as Record<string, unknown> | undefined;
  // Feishu does not sign the URL check it runs when the address is saved.
  // Answering it echoes the challenge and nothing else.
  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    if (secret.verificationToken && !safeEqual(text(body.token), secret.verificationToken)) {
      return { ok: false, reason: 'the Feishu URL check carried a different verification token' };
    }
    return { ok: true, immediateResponse: { status: 200, body: { challenge: body.challenge } } };
  }
  if (secret.encryptKey) {
    const signature = header(request, 'x-lark-signature');
    const timestamp = header(request, 'x-lark-request-timestamp');
    const nonce = header(request, 'x-lark-request-nonce');
    if (!signature || !timestamp || !nonce) {
      return { ok: false, reason: 'missing X-Lark-Signature headers, which Feishu sends with every event once an Encrypt Key is set' };
    }
    const expected = createHash('sha256').update(timestamp + nonce + secret.encryptKey).update(request.rawBody).digest('hex');
    if (!safeEqual(signature, expected)) {
      return { ok: false, reason: 'the Feishu signature does not match; check encryptKey in the connector credential' };
    }
  }
  if (secret.verificationToken) {
    const token = text((body?.header as Record<string, unknown> | undefined)?.token);
    if (!safeEqual(token, secret.verificationToken)) {
      return { ok: false, reason: 'the Feishu verification token does not match; check verificationToken in the connector credential' };
    }
  }
  return { ok: true, body: payload };
}

/** A person's text message to the bot, from a Feishu `im.message.receive_v1` event; anything else is ignored. */
export function normalizeFeishu(body: unknown, connector: Connector): TriggerEvent | undefined {
  const envelope = body as { schema?: unknown; header?: Record<string, unknown>; event?: Record<string, unknown> } | undefined;
  if (envelope?.schema !== '2.0' || envelope.header?.event_type !== 'im.message.receive_v1') return undefined;
  const sender = envelope.event?.sender as Record<string, unknown> | undefined;
  const message = envelope.event?.message as Record<string, unknown> | undefined;
  // People only: an app's messages, this connector's replies among them, would
  // otherwise be answered in turn, forever.
  if (sender?.sender_type !== 'user' || message?.message_type !== 'text') return undefined;
  let said: string;
  try {
    said = text((JSON.parse(text(message.content)) as { text?: unknown }).text);
  } catch {
    return undefined;
  }
  said = said.replace(/@_user_\d+/g, '').trim();
  const chatId = text(message.chat_id);
  const messageId = text(message.message_id);
  const threadId = text(message.thread_id);
  if (!said || !chatId || !messageId) return undefined;
  return {
    externalEventId: `feishu:${messageId}`,
    scopeType: 'chat',
    scopeKey: threadId ? `${chatId}:${threadId}` : chatId,
    scopeLabel: `chat in ${connector.name}`,
    events: [{ type: 'user.message', text: said, attachments: [] }],
    summary: said.slice(0, 4000),
    responseContext: { messageId, ...(threadId ? { inThread: true } : {}) },
  };
}

/** Feishu's open platform, in China or as Lark. */
export const FEISHU_API = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const;

/**
 * Parse an operator's API base for a built-in platform (`MA_SLACK_API_URL`,
 * `MA_FEISHU_API_URL`, `MA_LARK_API_URL`) — GovSlack, a private Feishu
 * deployment. Unset keeps the public one.
 */
export function parseChatApiUrl(name: string, raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    throw validationError(
      `${name} expects an absolute http(s) URL with no credentials, query or fragment, such as https://slack-gov.com/api; ` +
        `got ${JSON.stringify(redactCredentials(value))}. Give the API's base URL alone.`,
    );
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Tenant access tokens, cached per app *and* secret. Keyed by the app id alone,
 * another workspace naming the same app with a wrong secret would be handed
 * this one's token, and could have its agent post as this app.
 */
export class FeishuTokens {
  readonly #clock: Clock;
  readonly #cache = new Map<string, { token: string; renewAt: number }>();
  readonly #loading = new Map<string, Promise<string>>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async get(base: string, appId: string, appSecret: string): Promise<string> {
    const key = createHash('sha256').update(`${base}\n${appId}\n${appSecret}`).digest('hex');
    const cached = this.#cache.get(key);
    if (cached && this.#clock.now() < cached.renewAt) return cached.token;
    let loading = this.#loading.get(key);
    if (!loading) {
      loading = this.#fetch(base, appId, appSecret, key).finally(() => this.#loading.delete(key));
      this.#loading.set(key, loading);
    }
    return loading;
  }

  invalidate(base: string, appId: string, appSecret: string): void {
    this.#cache.delete(createHash('sha256').update(`${base}\n${appId}\n${appSecret}`).digest('hex'));
  }

  async #fetch(base: string, appId: string, appSecret: string, key: string): Promise<string> {
    const body = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const response = await post(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {}, body, 'Feishu', this.#clock);
    const answer = (await response.json().catch(() => ({}))) as { code?: unknown; msg?: unknown; tenant_access_token?: unknown; expire?: unknown };
    if (answer.code !== 0 || typeof answer.tenant_access_token !== 'string') {
      throw new MaError({
        code: 'CHAT_SEND_FAILED',
        category: response.status >= 500 ? 'unavailable' : 'permission',
        retryable: response.status >= 500,
        message:
          `Feishu would not issue a token for app ${appId} (code ${String(answer.code ?? response.status)}: ${text(answer.msg)}). ` +
          'Check appId in the connector config and appSecret in its credential, and that the app is published.',
      });
    }
    const now = this.#clock.now();
    for (const [stale, entry] of this.#cache) if (entry.renewAt <= now) this.#cache.delete(stale);
    const lifetimeMs = (typeof answer.expire === 'number' ? answer.expire : 7200) * 1000;
    this.#cache.set(key, { token: answer.tenant_access_token, renewAt: now + Math.max(0, lifetimeMs - FEISHU_TOKEN_RENEW_BEFORE_MS) });
    return answer.tenant_access_token;
  }
}

/** Codes Feishu answers with when the access token itself is the problem. */
const FEISHU_TOKEN_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991668]);

/** Reply to a Feishu message (in its thread, if it came from one), in parts if it is long. */
export async function sendFeishu(options: {
  base: string;
  clock: Clock;
  tokens: FeishuTokens;
  appId: string;
  appSecret: string;
  messageId: string;
  inThread: boolean;
  text: string;
}): Promise<void> {
  for (const part of splitText(options.text, FEISHU_MAX_TEXT)) {
    const body = JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text: part }), ...(options.inThread ? { reply_in_thread: true } : {}) });
    const url = `${options.base}/open-apis/im/v1/messages/${encodeURIComponent(options.messageId)}/reply`;
    for (let attempt = 0; ; attempt++) {
      const token = await options.tokens.get(options.base, options.appId, options.appSecret);
      const response = await post(url, { authorization: `Bearer ${token}` }, body, 'Feishu', options.clock);
      const answer = (await response.json().catch(() => ({}))) as { code?: unknown; msg?: unknown };
      if (answer.code === 0) break;
      if (typeof answer.code === 'number' && FEISHU_TOKEN_CODES.has(answer.code) && attempt === 0) {
        options.tokens.invalidate(options.base, options.appId, options.appSecret);
        continue;
      }
      throw new MaError({
        code: 'CHAT_SEND_FAILED',
        category: response.status >= 500 ? 'unavailable' : 'permission',
        retryable: response.status >= 500,
        message:
          `Feishu refused the reply (code ${String(answer.code ?? response.status)}: ${text(answer.msg)}). ` +
          'Check the bot is in the chat and the app has the im:message:send_as_bot permission in a published version.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** POST JSON, waiting once for a 429's Retry-After (capped) before trying again. */
async function post(url: string, headers: Record<string, string>, body: string, platform: string, clock: Clock): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MaError({ code: 'CHAT_SEND_UNAVAILABLE', category: 'unavailable', retryable: true, message: `Could not reach ${platform} to send the reply.`, cause: error });
    }
    if (response.status !== 429 || attempt > 0) return response;
    const seconds = Number(response.headers.get('retry-after'));
    await response.body?.cancel();
    await clock.sleep(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, MAX_RATE_LIMIT_WAIT_MS));
  }
}

/** Cut text into parts of at most `limit` characters, at a line break where there is one. */
export function splitText(value: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit);
    let at = cut > limit / 2 ? cut : limit;
    // Not between the two halves of a surrogate pair, which would arrive as two broken characters.
    if (/[\uD800-\uDBFF]/.test(rest[at - 1] ?? '')) at -= 1;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
