/**
 * Concrete adapters.
 *
 * Four shipped: a generic signed webhook, a chat bot, an outbound hook, and a
 * cron schedule. Between them they cover the shapes real integrations take, and
 * each one is small enough that adding a fifth is obvious work rather than
 * archaeology.
 */

import { MaError, newId, validationError, verifySignature, type Clock } from '@ma/core';
import { parse, parseOrThrow, chatConfigSchema, eventBusConfigSchema, scheduleConfigSchema, type Connector } from '@ma/contracts';

import {
  FEISHU_API,
  FeishuTokens,
  feishuSecret,
  normalizeFeishu,
  normalizeSlack,
  sendFeishu,
  sendSlack,
  slackSecret,
  verifyFeishu,
  verifySlack,
} from './chat-platforms.ts';
import { validateCron } from './cron.ts';

import type {
  ConnectorAdapter,
  DeliveryOutcome,
  InboundRequest,
  TriggerEvent,
  VerifyResult,
} from './adapter.ts';

function header(request: InboundRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// Webhook — a signed generic HTTP trigger
// ---------------------------------------------------------------------------

export interface WebhookAdapterOptions {
  clock: Clock;
  /** How much clock skew to tolerate on the signed timestamp. */
  toleranceSeconds?: number;
}

/**
 * The general-purpose inbound adapter.
 *
 * Signatures cover `timestamp.body`, and the timestamp is checked against a
 * tolerance window — so a captured request cannot be replayed indefinitely,
 * which signing the body alone would allow.
 */
export function webhookAdapter(options: WebhookAdapterOptions): ConnectorAdapter {
  const tolerance = options.toleranceSeconds ?? 300;

  return {
    type: 'webhook',

    verify(request, connector, secret): Promise<VerifyResult> {
      if (!secret) {
        // An unsigned webhook is an open endpoint that starts agent runs.
        return Promise.resolve({
          ok: false,
          reason: 'this connector has no signing secret configured',
        });
      }

      const signature = header(request, 'x-ma-signature');
      const timestamp = Number(header(request, 'x-ma-timestamp') ?? '');
      if (!signature || !Number.isInteger(timestamp)) {
        return Promise.resolve({ ok: false, reason: 'missing signature headers' });
      }

      const ok = verifySignature({
        secret,
        payload: request.rawBody,
        signature,
        timestamp,
        now: options.clock.now(),
        toleranceSeconds: tolerance,
      });
      return Promise.resolve(
        ok ? { ok: true } : { ok: false, reason: 'signature mismatch or stale timestamp' },
      );
    },

    normalize(request, connector): Promise<TriggerEvent | undefined> {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body);

      // Prefer the sender's event id — but only from the SIGNED body, never the
      // `x-ma-event-id` header. The header is outside the signed material
      // (`verifySignature` covers `timestamp.rawBody`), so trusting it for dedup
      // hands an attacker the dedup key: a captured, byte-identical signed request
      // whose body carried no id could be replayed within the tolerance window with
      // a *fresh header each time*, and each distinct header would mint a distinct
      // `externalEventId` — a new receipt, a new agent run per replay — while the
      // signature stayed valid because the body never changed. The header must
      // therefore rank BELOW the signature-derived key, so on a signed delivery it
      // can never be reached; it is only a best-effort producer id for an UNSIGNED
      // adapter that reaches this path (webhook always requires a secret, so there
      // the header never participates at all).
      //
      // The signature-derived id is what actually stops a replay: it covers
      // `timestamp.body`, so byte-identical deliveries share it and distinct events
      // never collide — a replayed capture, or a sender retrying after a timeout it
      // did not tag, lands on one receipt instead of starting a second run. This
      // used to fall back to a fresh random id, which meant an identical signed
      // request replayed inside the tolerance window ran twice: the signature is
      // valid because it *is* the same request, so deduplication is the only thing
      // that can stop it.
      //
      // A generated id remains the last resort, for an unsigned adapter that reaches
      // this path: treating an unidentifiable event as new risks a duplicate run,
      // and a duplicate beats a dropped alert.
      const signature = header(request, 'x-ma-signature');
      const externalEventId =
        (typeof body.eventId === 'string' && body.eventId) ||
        (signature ? `sig:${signature.slice(0, 32)}` : header(request, 'x-ma-event-id')) ||
        newId('receipt', request.receivedAt);

      const scopeKey = typeof body.scope === 'string' ? body.scope : '';

      return Promise.resolve({
        externalEventId,
        scopeType: 'webhook',
        scopeKey,
        scopeLabel: scopeKey || connector.name,
        events: [{ type: 'user.message', text: prompt, attachments: [] }],
        summary: prompt.slice(0, 4000),
      });
    },

    validateConfig(connector): void {
      if (!connector.secretCredentialId) {
        throw validationError(
          'A webhook connector needs a signing secret before it can be activated',
          { connectorId: connector.id },
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Chat — a bot in a messaging platform
// ---------------------------------------------------------------------------

export interface ChatAdapterOptions {
  clock: Clock;
  /** Posts a `generic` connector's reply. Absent, those connectors are fire-and-forget. */
  send?(chatId: string, text: string, secret?: string): Promise<void>;
  /** Where Slack's and Feishu's APIs are; for tests. */
  endpoints?: { slack?: string; feishu?: string; lark?: string };
}

/** A connector's chat config; an invalid one is reported where it is used. */
function chatConfigOf(connector: Connector) {
  const outcome = parse(chatConfigSchema, connector.config ?? {});
  return outcome.ok ? outcome.value : undefined;
}

/**
 * A chat bot.
 *
 * `config.platform` picks what it speaks. `generic` is the shape every chat
 * platform shares — a challenge handshake, a signed event envelope, a chat id
 * as the conversation scope — with replies through `send`. `slack` and
 * `feishu` take those platforms' own signed events and reply through their
 * APIs, with the secrets the connector's credential holds.
 */
export function chatAdapter(options: ChatAdapterOptions): ConnectorAdapter {
  const send = options.send;
  const { clock } = options;
  const api = {
    slack: options.endpoints?.slack ?? 'https://slack.com/api',
    feishu: options.endpoints?.feishu ?? FEISHU_API.feishu,
    lark: options.endpoints?.lark ?? FEISHU_API.lark,
  };
  const feishuTokens = new FeishuTokens(clock);
  return {
    type: 'chat',

    verify(request, connector, secret): Promise<VerifyResult> {
      const config = chatConfigOf(connector);
      if (!config) return Promise.resolve({ ok: false, reason: 'the connector config is invalid; re-activate it to see why' });
      if (config.platform !== 'generic') {
        try {
          return Promise.resolve(
            config.platform === 'slack' ? verifySlack(request, slackSecret(secret), clock.now()) : verifyFeishu(request, feishuSecret(secret)),
          );
        } catch (error) {
          return Promise.resolve({ ok: false, reason: MaError.from(error).message });
        }
      }

      const body = (request.body ?? {}) as Record<string, unknown>;

      // Platforms prove endpoint ownership by expecting an echo. This happens
      // before any receipt exists, so it short-circuits the pipeline.
      if (typeof body.challenge === 'string') {
        return Promise.resolve({
          ok: true,
          immediateResponse: { status: 200, body: { challenge: body.challenge } },
        });
      }

      if (!secret) {
        return Promise.resolve({ ok: false, reason: 'no verification secret configured' });
      }

      const signature = header(request, 'x-chat-signature');
      const timestamp = Number(header(request, 'x-chat-timestamp') ?? '');
      if (!signature || !Number.isInteger(timestamp)) {
        return Promise.resolve({ ok: false, reason: 'missing signature headers' });
      }

      const ok = verifySignature({
        secret,
        payload: request.rawBody,
        signature,
        timestamp,
        now: options.clock.now(),
      });
      return Promise.resolve(ok ? { ok: true } : { ok: false, reason: 'signature mismatch' });
    },

    normalize(request, connector): Promise<TriggerEvent | undefined> {
      const config = chatConfigOf(connector);
      if (config?.platform === 'slack') return Promise.resolve(normalizeSlack(request.body, connector));
      if (config?.platform === 'feishu') return Promise.resolve(normalizeFeishu(request.body, connector));

      const body = (request.body ?? {}) as Record<string, unknown>;
      const event = (body.event ?? body) as Record<string, unknown>;

      const text = typeof event.text === 'string' ? event.text.trim() : '';
      const chatId = typeof event.chatId === 'string' ? event.chatId : '';
      const senderId = typeof event.senderId === 'string' ? event.senderId : '';

      // The bot's own messages would otherwise start a session that replies to
      // itself, forever.
      if (typeof event.botId === 'string' && event.botId === senderId) {
        return Promise.resolve(undefined);
      }
      if (text.length === 0 || chatId.length === 0) return Promise.resolve(undefined);

      // Dedup id: the source's own message id, else the request signature (so a
      // replayed or untagged signed delivery lands on one receipt rather than
      // starting a second agent run), else a generated id as the last resort for
      // an unsigned path — matching the webhook/eventbus adapters, which were
      // already hardened this way. Without the signature fallback an untagged
      // retry of a signed chat delivery double-ran.
      const signature = header(request, 'x-chat-signature');
      const externalEventId =
        (typeof event.messageId === 'string' && event.messageId) ||
        (signature ? `sig:${signature.slice(0, 32)}` : undefined) ||
        newId('receipt', request.receivedAt);

      return Promise.resolve({
        externalEventId,
        scopeType: 'chat',
        scopeKey: chatId,
        // The chat id is the scope key and is hashed for storage; the label is
        // deliberately non-identifying.
        scopeLabel: `chat in ${connector.name}`,
        events: [{ type: 'user.message', text, attachments: [] }],
        summary: text.slice(0, 4000),
        // Only with somewhere to send it: a delivery that records where to reply
        // holds a worker for the whole turn, which is waste if the reply is dropped.
        ...(send ? { responseContext: { chatId } } : {}),
      });
    },

    async respond(trigger: TriggerEvent, outcome: DeliveryOutcome, connector: Connector, secret?: string) {
      if (!outcome.reply) return;
      const context = trigger.responseContext ?? {};
      const config = chatConfigOf(connector);
      if (config?.platform === 'slack') {
        if (typeof context.channel !== 'string') return;
        await sendSlack({
          api: api.slack,
          clock,
          token: slackSecret(secret).botToken,
          channel: context.channel,
          ...(typeof context.threadTs === 'string' ? { threadTs: context.threadTs } : {}),
          text: outcome.reply,
        });
        return;
      }
      if (config?.platform === 'feishu') {
        if (typeof context.messageId !== 'string') return;
        await sendFeishu({
          base: api[config.domain],
          clock,
          tokens: feishuTokens,
          appId: config.appId!,
          appSecret: feishuSecret(secret).appSecret,
          messageId: context.messageId,
          inThread: context.inThread === true,
          text: outcome.reply,
        });
        return;
      }
      if (send && typeof context.chatId === 'string') await send(context.chatId, outcome.reply, secret);
    },

    validateConfig(connector, secret): void {
      const config = parseOrThrow(chatConfigSchema, connector.config ?? {});
      if (!connector.secretCredentialId) {
        throw validationError(
          config.platform === 'generic'
            ? 'A chat connector needs a verification secret'
            : `A ${config.platform} chat connector needs a credential holding its secrets; create one and set secretCredentialId`,
          { connectorId: connector.id },
        );
      }
      if (config.platform === 'slack') slackSecret(secret);
      if (config.platform === 'feishu') feishuSecret(secret);
    },
  };
}

// ---------------------------------------------------------------------------
// Hook — an outbound callback registered by another system
// ---------------------------------------------------------------------------

export interface HookAdapterOptions {
  clock: Clock;
  /** Delivers the outcome to the registered URL. */
  post?(url: string, payload: unknown, secret?: string): Promise<void>;
}

/**
 * An inbound trigger that also calls back when the agent finishes.
 *
 * The distinction from `webhook` is the return path: a hook's caller wants the
 * result delivered rather than polling for it.
 */
export function hookAdapter(options: HookAdapterOptions): ConnectorAdapter {
  const post = options.post;
  return {
    type: 'hook',

    verify(request, connector, secret): Promise<VerifyResult> {
      if (!secret) return Promise.resolve({ ok: false, reason: 'no signing secret configured' });
      const signature = header(request, 'x-ma-signature');
      const timestamp = Number(header(request, 'x-ma-timestamp') ?? '');
      if (!signature || !Number.isInteger(timestamp)) {
        return Promise.resolve({ ok: false, reason: 'missing signature headers' });
      }
      const ok = verifySignature({
        secret,
        payload: request.rawBody,
        signature,
        timestamp,
        now: options.clock.now(),
      });
      return Promise.resolve(ok ? { ok: true } : { ok: false, reason: 'signature mismatch' });
    },

    normalize(request, connector): Promise<TriggerEvent | undefined> {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body);
      const callbackUrl = typeof body.callbackUrl === 'string' ? body.callbackUrl : '';

      // Dedup id: the source's own event id, else the request signature (so a
      // replayed or untagged signed hook lands on one receipt rather than
      // double-running), else a generated id as the last resort — same hardening
      // as the webhook/eventbus adapters.
      const signature = header(request, 'x-ma-signature');
      return Promise.resolve({
        externalEventId:
          (typeof body.eventId === 'string' && body.eventId) ||
          (signature ? `sig:${signature.slice(0, 32)}` : undefined) ||
          newId('receipt', request.receivedAt),
        scopeType: 'hook',
        scopeKey: callbackUrl,
        scopeLabel: connector.name,
        events: [{ type: 'user.message', text: prompt, attachments: [] }],
        summary: prompt.slice(0, 4000),
        responseContext: { callbackUrl },
      });
    },

    ...(post
      ? {
          async respond(trigger: TriggerEvent, outcome: DeliveryOutcome, _connector: Connector, secret?: string) {
            const url = trigger.responseContext?.callbackUrl;
            if (typeof url !== 'string' || url.length === 0) return;
            await post(url, { sessionId: outcome.sessionId, reply: outcome.reply, error: outcome.error }, secret);
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Event subscription — a filtered push feed from an event bus
// ---------------------------------------------------------------------------

export interface EventBusAdapterOptions {
  clock: Clock;
  toleranceSeconds?: number;
}

/**
 * A CloudEvents-style envelope, the shape every managed bus converges on.
 *
 * Only the routing fields are typed; `data` is whatever the producer sent. A
 * missing field is tolerated rather than rejected — a bus that omits `source`
 * should still deliver, and the filter treats absence as "matches any".
 */
interface CloudEvent {
  id?: string;
  type?: string;
  source?: string;
  time?: string;
  subject?: string;
  data?: unknown;
}

function readEnvelope(body: unknown): CloudEvent {
  const raw = (body ?? {}) as Record<string, unknown>;
  // Accept both a bare CloudEvent and one wrapped as `{ event: {...} }`, since
  // some buses nest the envelope under a delivery wrapper.
  const source = (typeof raw.event === 'object' && raw.event ? raw.event : raw) as Record<
    string,
    unknown
  >;
  return {
    ...(typeof source.id === 'string' ? { id: source.id } : {}),
    ...(typeof source.type === 'string' ? { type: source.type } : {}),
    ...(typeof source.source === 'string' ? { source: source.source } : {}),
    ...(typeof source.time === 'string' ? { time: source.time } : {}),
    ...(typeof source.subject === 'string' ? { subject: source.subject } : {}),
    ...('data' in source ? { data: source.data } : {}),
  };
}

/**
 * Does an event type match one of the configured patterns?
 *
 * Exact match, or a trailing `*` as a prefix wildcard (`order.*` matches
 * `order.created`). An empty pattern list means accept everything: the bus
 * already decided what to send here, and re-filtering to nothing would silently
 * drop every delivery — the failure mode this connector type exists to avoid.
 */
export function matchesEventType(type: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

/** Render the prompt for a matched event, expanding the template's fields. */
function renderPrompt(template: string | undefined, event: CloudEvent): string {
  const dataJson =
    event.data === undefined ? '' : safeJsonStringify(event.data);
  if (!template) {
    // No template: the event's data as JSON is the least-surprising prompt for
    // an event whose shape the operator did not pin.
    return dataJson || safeJsonStringify(event);
  }
  return fillTemplate(template, {
    data: dataJson,
    type: event.type ?? '',
    source: event.source ?? '',
    subject: event.subject ?? '',
  });
}

/**
 * Expand `{{name}}` placeholders in one pass.
 *
 * One pass, because the values are the event's own content: expanding one
 * placeholder after another would expand a `{{source}}` that appears inside the
 * already-inserted data, letting a producer rewrite the prompt around it.
 */
export function fillTemplate(template: string, fields: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(fields, name) ? fields[name]! : placeholder,
  );
}

/** JSON.stringify that never throws (a cyclic payload becomes a marker). */
export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable event data]';
  }
}

/**
 * An event-subscription connector.
 *
 * Signed like a webhook — the transport is the same, an HTTP POST from the bus —
 * but it filters. `normalize` drops an event whose type or source the
 * subscription did not ask for by returning `undefined`, so the pipeline treats
 * it as ignored rather than starting an agent. This is the whole point of the
 * type: a plain webhook wakes an agent for every delivery; a subscription wakes
 * one only for the events it declared interest in.
 *
 * A pull consumer (Kafka, SQS) is a different shape entirely — a long-running
 * client loop and a broker dependency the platform does not own. This is the
 * push shape (EventBridge API destinations, Pub/Sub push, Event Grid), which is
 * what fits an HTTP control plane.
 */
export function eventBusAdapter(options: EventBusAdapterOptions): ConnectorAdapter {
  const tolerance = options.toleranceSeconds ?? 300;

  return {
    type: 'eventbus',

    verify(request, _connector, secret): Promise<VerifyResult> {
      if (!secret) {
        // An unsigned subscription endpoint is an open door that starts agent
        // runs — the same reasoning as the webhook adapter.
        return Promise.resolve({
          ok: false,
          reason: 'this subscription has no signing secret configured',
        });
      }

      const signature = header(request, 'x-ma-signature');
      const timestamp = Number(header(request, 'x-ma-timestamp') ?? '');
      if (!signature || !Number.isInteger(timestamp)) {
        return Promise.resolve({ ok: false, reason: 'missing signature headers' });
      }

      const ok = verifySignature({
        secret,
        payload: request.rawBody,
        signature,
        timestamp,
        now: options.clock.now(),
        toleranceSeconds: tolerance,
      });
      return Promise.resolve(
        ok ? { ok: true } : { ok: false, reason: 'signature mismatch or stale timestamp' },
      );
    },

    normalize(request, connector): Promise<TriggerEvent | undefined> {
      const config = parseOrThrow(eventBusConfigSchema, connector.config);
      const event = readEnvelope(request.body);

      const type = event.type ?? '';
      // A typeless event cannot be filtered, and a subscription that declared
      // types did so to exclude exactly this. Drop it rather than guess.
      if (type.length === 0 && config.eventTypes.length > 0) return Promise.resolve(undefined);
      if (!matchesEventType(type, config.eventTypes)) return Promise.resolve(undefined);
      if (config.sources.length > 0 && !config.sources.includes(event.source ?? '')) {
        return Promise.resolve(undefined);
      }

      const prompt = renderPrompt(config.promptTemplate, event);
      if (prompt.length === 0) return Promise.resolve(undefined);

      // Prefer the envelope's own id so the producer's retries deduplicate;
      // fall back to a derived id from the signature, as the webhook does.
      const signature = header(request, 'x-ma-signature');
      const externalEventId =
        event.id ||
        (signature ? `sig:${signature.slice(0, 32)}` : undefined) ||
        newId('receipt', request.receivedAt);

      // The scope is the event source, so events from one producer can share a
      // session while another producer's stay separate.
      const scopeKey = event.source ?? '';

      return Promise.resolve({
        externalEventId,
        scopeType: 'eventbus',
        scopeKey,
        scopeLabel: scopeKey ? `events from ${scopeKey}` : connector.name,
        events: [{ type: 'user.message', text: prompt, attachments: [] }],
        summary: prompt.slice(0, 4000),
      });
    },

    validateConfig(connector): void {
      if (!connector.secretCredentialId) {
        throw validationError(
          'An event subscription needs a signing secret before it can be activated',
          { connectorId: connector.id },
        );
      }
      // Surface a malformed filter at activation, not at 3am on the first event.
      parseOrThrow(eventBusConfigSchema, connector.config);
    },
  };
}

// ---------------------------------------------------------------------------
// Schedule — a cron trigger
// ---------------------------------------------------------------------------

/**
 * Cron.
 *
 * There is no inbound request: the scheduler synthesizes deliveries. `verify`
 * therefore refuses everything — a schedule endpoint that accepted HTTP would
 * be an unauthenticated way to trigger someone's nightly job.
 */
export function scheduleAdapter(): ConnectorAdapter {
  return {
    type: 'schedule',

    verify(): Promise<VerifyResult> {
      return Promise.resolve({
        ok: false,
        reason: 'schedule connectors are fired by the scheduler, not by inbound requests',
      });
    },

    normalize(): Promise<TriggerEvent | undefined> {
      return Promise.resolve(undefined);
    },

    validateConfig(connector: Connector): void {
      // Parsing here means an invalid cron expression is caught at activation
      // rather than at 3am when the job silently fails to fire. The schema only
      // checks the shape (five space-separated fields); `validateCron` is what
      // actually rejects a field out of range (`60 0 * * *`) or an unknown
      // timezone (`Mars/Phobos`) — configs that satisfy the schema but make
      // `nextFireTime` throw on every scheduler tick if they reach the store.
      const config = parseOrThrow(scheduleConfigSchema, connector.config);
      validateCron(config.cron, config.timezone);
    },
  };
}

/** Build the delivery a scheduler tick represents. */
export function scheduleTrigger(connector: Connector, firedAt: number): TriggerEvent {
  const config = parseOrThrow(scheduleConfigSchema, connector.config);
  return {
    // The fire time is the dedupe key, so two scheduler replicas racing on the
    // same tick produce one delivery.
    externalEventId: `${connector.id}:${firedAt}`,
    scopeType: 'schedule',
    scopeKey: connector.externalKey,
    scopeLabel: connector.name,
    events: [{ type: 'user.message', text: config.prompt, attachments: [] }],
    summary: config.prompt.slice(0, 4000),
  };
}

/** Marker so `DeliveryOutcome` stays referenced for adapter authors. */
export type { DeliveryOutcome };
