/**
 * Pulled messages, as the agent sees them.
 *
 * A queue or a log carries whatever its producers put on it. The common shapes
 * are recognised so that a pull connector's filter and template mean what they
 * mean for a pushed `eventbus` subscription: a CloudEvent (structured, or in
 * Kafka's binary mode with `ce_*` headers), an EventBridge event, and an SNS
 * notification carrying either. Anything else is an opaque body: a filter on
 * types drops it, and `{{body}}` passes it through.
 */

import { sha256Hex } from '@ma/core';
import type { Connector } from '@ma/contracts';

import type { TriggerEvent } from '../adapter.ts';
import { fillTemplate, matchesEventType, safeJsonStringify } from '../adapters.ts';

export interface PulledMessage {
  /**
   * The message's identity on its queue or topic, stable across redeliveries:
   * an SQS message id, a Kafka topic/partition/offset.
   */
  transportId: string;
  /** The payload as received; `undefined` for a Kafka tombstone. */
  body: Buffer | undefined;
  /** Its ordering key: a Kafka record key, an SQS FIFO message group. */
  key?: string;
  /** Transport headers (Kafka record headers), where CloudEvents' binary mode keeps its attributes. */
  headers?: Readonly<Record<string, string>>;
}

/** The filter and template every pull connector's config carries. */
export interface PulledEventConfig {
  eventTypes: readonly string[];
  sources: readonly string[];
  promptTemplate?: string | undefined;
}

interface Envelope {
  id?: string;
  type?: string;
  source?: string;
  subject?: string;
  /** Present only when the event carries data, so `null` data is told apart from none. */
  data?: { value: unknown };
}

/** The longest `externalEventId` a receipt holds. */
const MAX_EVENT_ID = 256;

/**
 * Turn a pulled message into a delivery, or `undefined` to drop it.
 *
 * Dropped: a tombstone, an event the filter excludes, a message that renders to
 * an empty prompt. The caller acknowledges a dropped message like a delivered
 * one; left on the queue it would come back forever.
 *
 * The delivery is keyed by the event's own id when it has one (scoped by its
 * source, as CloudEvents scopes ids), so a producer's retry or a bus delivering
 * twice is one delivery; otherwise by the transport id. Never throws: the
 * content is the producer's, and a message that breaks the consumer would
 * stall its queue behind it.
 */
export function normalizePulled(
  message: PulledMessage,
  connector: Connector,
  config: PulledEventConfig,
): TriggerEvent | undefined {
  if (message.body === undefined) return undefined;
  const { text, envelope, sns } = readMessage(message);

  const type = envelope?.type ?? '';
  if (type.length === 0 && config.eventTypes.length > 0) return undefined;
  if (!matchesEventType(type, config.eventTypes)) return undefined;
  if (config.sources.length > 0 && !config.sources.includes(envelope?.source ?? '')) return undefined;

  const dataJson = envelope?.data ? safeJsonStringify(envelope.data.value) : '';
  const prompt = config.promptTemplate
    ? fillTemplate(config.promptTemplate, {
        body: text,
        data: envelope ? dataJson : text,
        type,
        source: envelope?.source ?? '',
        subject: envelope?.subject ?? '',
        key: message.key ?? '',
      })
    : envelope?.data
      ? dataJson
      : text;
  if (prompt.trim().length === 0) return undefined;

  // A scope exists to send one conversation's events to one session. Under any
  // other policy it would only leave a binding row behind per distinct key, and
  // a topic keyed by user or order id has as many keys as it has users or orders.
  const scopeKey = connector.sessionPolicy === 'reuse_per_scope' ? (message.key ?? envelope?.source ?? '') : '';
  return {
    externalEventId: eventId(connector.type, message, envelope, sns),
    scopeType: connector.type,
    scopeKey,
    // The key can identify a person (a user id, an email); the label is shown to
    // operators, so it names the kind of scope rather than the value.
    scopeLabel: message.key !== undefined
      ? `${connector.name} (by message key)`
      : envelope?.source
        ? `events from ${envelope.source}`
        : connector.name,
    events: [{ type: 'user.message', text: prompt, attachments: [] }],
    summary: prompt.slice(0, 4000),
  };
}

function readMessage(message: PulledMessage): {
  text: string;
  envelope?: Envelope;
  sns?: { topicArn: string; messageId: string };
} {
  let text = message.body!.toString('utf8');
  const headers = message.headers ?? {};

  // Binary content mode: the attributes are headers and the body is the data.
  if (typeof headers.ce_type === 'string' && headers.ce_type.length > 0) {
    return {
      text,
      envelope: {
        type: headers.ce_type,
        ...(headers.ce_id ? { id: headers.ce_id } : {}),
        ...(headers.ce_source ? { source: headers.ce_source } : {}),
        ...(headers.ce_subject ? { subject: headers.ce_subject } : {}),
        data: { value: parseJson(text) ?? text },
      },
    };
  }

  let parsed = parseJson(text);
  let sns: { topicArn: string; messageId: string } | undefined;
  if (isRecord(parsed) && parsed.Type === 'Notification' && typeof parsed.Message === 'string') {
    // SNS delivering to SQS without raw delivery wraps the published message.
    if (typeof parsed.TopicArn === 'string' && typeof parsed.MessageId === 'string') {
      sns = { topicArn: parsed.TopicArn, messageId: parsed.MessageId };
    }
    text = parsed.Message;
    parsed = parseJson(text);
  }

  const envelope = isRecord(parsed) ? readEnvelope(parsed) : undefined;
  return { text, ...(envelope ? { envelope } : {}), ...(sns ? { sns } : {}) };
}

function readEnvelope(event: Record<string, unknown>): Envelope | undefined {
  // EventBridge: `detail-type` and `detail` where a CloudEvent has `type` and `data`.
  if (typeof event['detail-type'] === 'string') {
    return {
      type: event['detail-type'],
      ...(typeof event.id === 'string' ? { id: event.id } : {}),
      ...(typeof event.source === 'string' ? { source: event.source } : {}),
      ...('detail' in event ? { data: { value: event.detail } } : {}),
    };
  }
  // A CloudEvent, read as leniently as the pushed subscription reads one.
  if (typeof event.type === 'string') {
    return {
      type: event.type,
      ...(typeof event.id === 'string' ? { id: event.id } : {}),
      ...(typeof event.source === 'string' ? { source: event.source } : {}),
      ...(typeof event.subject === 'string' ? { subject: event.subject } : {}),
      ...('data' in event ? { data: { value: event.data } } : {}),
    };
  }
  return undefined;
}

function eventId(
  kind: string,
  message: PulledMessage,
  envelope: Envelope | undefined,
  sns: { topicArn: string; messageId: string } | undefined,
): string {
  if (envelope?.id) return bounded(`event:${part(envelope.source ?? '')}/${part(envelope.id)}`);
  if (sns) return bounded(`sns:${part(sns.topicArn)}/${part(sns.messageId)}`);
  return bounded(`${kind}:${message.transportId}`);
}

/**
 * One side of a two-part id, with its separator escaped: unescaped, source
 * `/shop/eu` with id `1` and source `/shop` with id `eu/1` were one event, and
 * the second was dropped as a duplicate of the first.
 */
function part(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('/', '%2F');
}

/** Keep an id readable when it fits; hash it when it would not. */
function bounded(id: string): string {
  return id.length <= MAX_EVENT_ID ? id : `${id.slice(0, id.indexOf(':') + 1)}sha256:${sha256Hex(id)}`;
}

function parseJson(text: string): unknown {
  const start = text.trimStart()[0];
  if (start !== '{' && start !== '[' && start !== '"') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
