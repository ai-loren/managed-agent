/**
 * Concrete adapters.
 *
 * Four shipped: a generic signed webhook, a chat bot, an outbound hook, and a
 * cron schedule. Between them they cover the shapes real integrations take, and
 * each one is small enough that adding a fifth is obvious work rather than
 * archaeology.
 */

import { newId, validationError, verifySignature, type Clock } from '@ma/core';
import { parseOrThrow, scheduleConfigSchema, type Connector } from '@ma/contracts';

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
      if (!signature || !Number.isFinite(timestamp)) {
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

      // Prefer the sender's event id so its retries deduplicate. Falling back
      // to a generated one means an unidentified event is treated as new, which
      // is the safer error: a duplicate run beats a dropped alert.
      const externalEventId =
        (typeof body.eventId === 'string' && body.eventId) ||
        header(request, 'x-ma-event-id') ||
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
  /** Posts a reply back to the platform. Absent means fire-and-forget. */
  send?(chatId: string, text: string, secret?: string): Promise<void>;
}

/**
 * A chat bot.
 *
 * Modelled on the shape every chat platform shares — a challenge handshake, a
 * signed event envelope, a chat id as the conversation scope — so Slack,
 * Discord or an internal IM differ only in `send` and the field names, not in
 * how the pipeline treats them.
 */
export function chatAdapter(options: ChatAdapterOptions): ConnectorAdapter {
  return {
    type: 'chat',

    verify(request, connector, secret): Promise<VerifyResult> {
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
      if (!signature || !Number.isFinite(timestamp)) {
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

      const externalEventId =
        (typeof event.messageId === 'string' && event.messageId) ||
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
        responseContext: { chatId },
      });
    },

    async respond(trigger, outcome, _connector, secret): Promise<void> {
      if (!options.send || !outcome.reply) return;
      const chatId = trigger.responseContext?.chatId;
      if (typeof chatId !== 'string') return;
      await options.send(chatId, outcome.reply, secret);
    },

    validateConfig(connector): void {
      if (!connector.secretCredentialId) {
        throw validationError('A chat connector needs a verification secret', {
          connectorId: connector.id,
        });
      }
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
  return {
    type: 'hook',

    verify(request, connector, secret): Promise<VerifyResult> {
      if (!secret) return Promise.resolve({ ok: false, reason: 'no signing secret configured' });
      const signature = header(request, 'x-ma-signature');
      const timestamp = Number(header(request, 'x-ma-timestamp') ?? '');
      if (!signature || !Number.isFinite(timestamp)) {
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

      return Promise.resolve({
        externalEventId:
          (typeof body.eventId === 'string' && body.eventId) || newId('receipt', request.receivedAt),
        scopeType: 'hook',
        scopeKey: callbackUrl,
        scopeLabel: connector.name,
        events: [{ type: 'user.message', text: prompt, attachments: [] }],
        summary: prompt.slice(0, 4000),
        responseContext: { callbackUrl },
      });
    },

    async respond(trigger, outcome, _connector, secret): Promise<void> {
      if (!options.post) return;
      const url = trigger.responseContext?.callbackUrl;
      if (typeof url !== 'string' || url.length === 0) return;
      await options.post(
        url,
        { sessionId: outcome.sessionId, reply: outcome.reply, error: outcome.error },
        secret,
      );
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
      // rather than at 3am when the job silently fails to fire.
      parseOrThrow(scheduleConfigSchema, connector.config);
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
