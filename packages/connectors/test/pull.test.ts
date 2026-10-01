/**
 * Pull connectors, offline: how a pulled message becomes a delivery, which
 * brokers may be reached, the SQS client and its signature, and the supervisor
 * that runs the consumers — the last against the real store and pipeline, with
 * a scripted source in place of a broker.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash } from 'node:crypto';

import { InMemoryKeyProvider, MaError, TestClock, newId, nullLogger, systemClock } from '@ma/core';
import type { Connector, Principal } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import {
  AgentService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type AuthContext,
  type SessionProvisioner,
} from '@ma/engine';

import {
  AdapterRegistry,
  DeliveryPipeline,
  PullSupervisor,
  SqsClient,
  brokerAllowed,
  eventBusAdapter,
  kafkaAdapter,
  normalizePulled,
  parseKafkaBrokers,
  parseSqsEndpoints,
  signV4,
  sqsAdapter,
  sqsRegion,
  sqsSourceFactory,
  type PullBatch,
  type PullOutcome,
  type PullSource,
  type PullSourceFactory,
  type PulledMessage,
} from '../src/index.ts';

const START = 1_700_000_000_000;

function connectorOf(overrides: Partial<Connector> = {}): Connector {
  return {
    id: 'cn_test',
    workspaceId: 'ws_test',
    type: 'kafka',
    name: 'orders',
    description: '',
    status: 'active',
    externalKey: 'orders',
    sessionPolicy: 'new_per_event',
    config: {},
    ownerPrincipalId: 'pr_test',
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'test',
    ...overrides,
  } as Connector;
}

const message = (body: string | undefined, extra: Partial<PulledMessage> = {}): PulledMessage => ({
  transportId: 'orders/0/7/1000',
  body: body === undefined ? undefined : Buffer.from(body),
  ...extra,
});

const NO_FILTER = { eventTypes: [], sources: [] };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

describe('a pulled message as a delivery', () => {
  test('a CloudEvent is filtered and phrased as a pushed subscription would', () => {
    const event = JSON.stringify({ specversion: '1.0', type: 'order.created', source: 'shop', id: 'o-1', subject: 's', data: { n: 1 } });
    const trigger = normalizePulled(message(event), connectorOf(), {
      eventTypes: ['order.*'],
      sources: ['shop'],
      promptTemplate: '{{type}}|{{source}}|{{subject}}|{{data}}|{{key}}',
    });
    assert.equal(trigger?.events[0]?.type === 'user.message' && trigger.events[0].text, 'order.created|shop|s|{"n":1}|');
    assert.equal(trigger?.externalEventId, 'event:shop/o-1');
    assert.equal(normalizePulled(message(event), connectorOf(), { eventTypes: ['user.*'], sources: [] }), undefined);
    assert.equal(normalizePulled(message(event), connectorOf(), { eventTypes: [], sources: ['elsewhere'] }), undefined);
  });

  test('without a template, an event becomes its data and anything else its body', () => {
    const prompt = (body: string): string | undefined => {
      const event = normalizePulled(message(body), connectorOf(), NO_FILTER)?.events[0];
      return event?.type === 'user.message' ? event.text : undefined;
    };
    assert.equal(prompt(JSON.stringify({ type: 't', data: { a: 1 } })), '{"a":1}');
    assert.equal(prompt('just text'), 'just text');
    assert.equal(prompt(JSON.stringify({ amount: 3 })), '{"amount":3}');
  });

  test('a message with no type is dropped by a filter on types, kept by none', () => {
    assert.equal(normalizePulled(message('just text'), connectorOf(), { eventTypes: ['order.*'], sources: [] }), undefined);
    assert.ok(normalizePulled(message('just text'), connectorOf(), NO_FILTER));
  });

  test('EventBridge events, SNS notifications and binary-mode headers are read as events', () => {
    const eventBridge = JSON.stringify({ 'detail-type': 'order.shipped', source: 'warehouse', id: 'eb-1', detail: { n: 2 } });
    const sns = JSON.stringify({ Type: 'Notification', MessageId: 'm-1', TopicArn: 'arn:t', Message: eventBridge });
    const config = { eventTypes: ['order.shipped'], sources: ['warehouse'], promptTemplate: '{{type}} {{data}} [{{body}}]' };
    for (const body of [eventBridge, sns]) {
      const trigger = normalizePulled(message(body), connectorOf(), config);
      assert.equal(trigger?.events[0]?.type === 'user.message' && trigger.events[0].text, `order.shipped {"n":2} [${eventBridge}]`);
      assert.equal(trigger?.externalEventId, 'event:warehouse/eb-1');
    }
    const plainSns = JSON.stringify({ Type: 'Notification', MessageId: 'm-2', TopicArn: 'arn:t', Message: 'hello' });
    assert.equal(normalizePulled(message(plainSns), connectorOf(), NO_FILTER)?.externalEventId, 'sns:arn:t/m-2');

    const binary = normalizePulled(message('{"n":3}', { headers: { ce_type: 'order.paid', ce_source: 'billing', ce_id: 'p-1' } }), connectorOf(), {
      eventTypes: ['order.paid'],
      sources: [],
      promptTemplate: '{{source}} {{data}}',
    });
    assert.equal(binary?.events[0]?.type === 'user.message' && binary.events[0].text, 'billing {"n":3}');
    assert.equal(binary?.externalEventId, 'event:billing/p-1');
  });

  test("the template is filled in one pass, so an event's own text cannot rewrite it", () => {
    const event = JSON.stringify({ type: 't', source: 'real', data: 'says {{source}} and {{type}}' });
    const trigger = normalizePulled(message(event), connectorOf(), { eventTypes: [], sources: [], promptTemplate: '{{data}} / {{source}}' });
    assert.equal(trigger?.events[0]?.type === 'user.message' && trigger.events[0].text, '"says {{source}} and {{type}}" / real');
  });

  test('without an event id the transport id keys the delivery; an overlong one is hashed', () => {
    assert.equal(normalizePulled(message('x'), connectorOf(), NO_FILTER)?.externalEventId, 'kafka:orders/0/7/1000');
    assert.equal(normalizePulled(message('x', { transportId: 'm' }), connectorOf({ type: 'sqs' }), NO_FILTER)?.externalEventId, 'sqs:m');
    const long = normalizePulled(message('x', { transportId: 't'.repeat(300) }), connectorOf(), NO_FILTER)!.externalEventId;
    assert.match(long, /^kafka:sha256:[0-9a-f]{64}$/);
  });

  test('the conversation is the message key, else the event source; the label never shows the key', () => {
    const keyed = normalizePulled(message('{"type":"t","source":"shop"}', { key: 'alice@example.com' }), connectorOf(), NO_FILTER)!;
    assert.equal(keyed.scopeKey, 'alice@example.com');
    assert.doesNotMatch(keyed.scopeLabel, /alice/);
    const sourced = normalizePulled(message('{"type":"t","source":"shop"}'), connectorOf(), NO_FILTER)!;
    assert.equal(sourced.scopeKey, 'shop');
    assert.equal(sourced.scopeType, 'kafka');
  });

  test('a tombstone, or a message that renders to nothing, is dropped', () => {
    assert.equal(normalizePulled(message(undefined), connectorOf(), NO_FILTER), undefined);
    assert.equal(normalizePulled(message('   '), connectorOf(), NO_FILTER), undefined);
    assert.equal(normalizePulled(message('{"type":"t"}'), connectorOf(), { eventTypes: [], sources: [], promptTemplate: '{{data}}' }), undefined);
  });
});

// ---------------------------------------------------------------------------
// Where a pull connector may reach
// ---------------------------------------------------------------------------

describe('which brokers a pull connector may reach', () => {
  const sqs = (queueUrl: string, extra: Record<string, unknown> = {}, secret: string | null = 'cr_1') =>
    connectorOf({ type: 'sqs', config: { queueUrl, accessKeyId: 'AKIDEXAMPLE', ...extra }, ...(secret ? { secretCredentialId: secret } : {}) });

  test("`aws` admits AWS's SQS endpoints and nothing that merely resembles one", async () => {
    const adapter = sqsAdapter({ endpoints: parseSqsEndpoints('aws') });
    for (const url of [
      'https://sqs.eu-west-1.amazonaws.com/123456789012/orders',
      'https://sqs.cn-north-1.amazonaws.com.cn/123456789012/orders',
      'https://queue.amazonaws.com/123456789012/orders',
    ]) {
      await assert.doesNotReject(Promise.resolve(adapter.validateConfig!(sqs(url))), url);
    }
    for (const url of [
      'http://sqs.eu-west-1.amazonaws.com/123456789012/orders',
      'https://sqs.eu-west-1.amazonaws.com:8443/123456789012/orders',
      'https://sqs.eu-west-1.amazonaws.com.evil.example/123/orders',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      assert.throws(() => adapter.validateConfig!(sqs(url)), (error: unknown) => MaError.is(error) && error.code === 'PULL_ENDPOINT_NOT_ALLOWED' && /MA_SQS_ENDPOINTS/.test(error.message), url);
    }
  });

  test('a listed origin is admitted exactly; with nothing listed, nothing is', () => {
    const listed = sqsAdapter({ endpoints: parseSqsEndpoints('http://elasticmq:9324') });
    assert.doesNotThrow(() => listed.validateConfig!(sqs('http://elasticmq:9324/000000000000/orders', { region: 'elasticmq' })));
    assert.throws(() => listed.validateConfig!(sqs('http://elasticmq:9325/000000000000/orders', { region: 'x' })), /PULL_ENDPOINT_NOT_ALLOWED|does not allow/);
    const unset = sqsAdapter({ endpoints: parseSqsEndpoints(undefined) });
    assert.throws(() => unset.validateConfig!(sqs('https://sqs.eu-west-1.amazonaws.com/1/q')), /nothing — it is unset/);
  });

  test('a custom endpoint needs a region, and every SQS connector needs its secret', () => {
    const adapter = sqsAdapter({ endpoints: parseSqsEndpoints('aws,http://elasticmq:9324') });
    assert.throws(() => adapter.validateConfig!(sqs('http://elasticmq:9324/0/orders')), /Set config\.region/);
    assert.throws(() => adapter.validateConfig!(sqs('https://sqs.eu-west-1.amazonaws.com/1/q', {}, null)), /secret access key for AKIDEXAMPLE.*secretCredentialId/);
    assert.equal(sqsRegion(new URL('https://sqs.ap-south-2.amazonaws.com/1/q'), undefined), 'ap-south-2');
    assert.equal(sqsRegion(new URL('https://us-west-2.queue.amazonaws.com/1/q'), undefined), 'us-west-2');
    assert.equal(sqsRegion(new URL('https://queue.amazonaws.com/1/q'), undefined), 'us-east-1');
    assert.equal(sqsRegion(new URL('https://sqs.eu-west-1.amazonaws.com/1/q'), 'override'), 'override');
  });

  test('Kafka brokers match exactly or by a domain wildcard on the same port', () => {
    const allowed = parseKafkaBrokers('kafka-1.internal:9092, *.msk.example.com:9096, [::1]:9092');
    assert.ok(brokerAllowed(allowed, 'KAFKA-1.internal:9092'));
    assert.ok(brokerAllowed(allowed, 'b-2.msk.example.com:9096'));
    assert.ok(brokerAllowed(allowed, '[::1]:9092'));
    assert.ok(!brokerAllowed(allowed, 'msk.example.com:9096'), 'the wildcard names subdomains, not the domain');
    assert.ok(!brokerAllowed(allowed, 'b-2.msk.example.com:9092'), 'the port is part of the entry');
    assert.ok(!brokerAllowed(allowed, 'kafka-1.internal.evil:9092'));
    assert.ok(!brokerAllowed(allowed, 'evilmsk.example.com:9096'));
  });

  test('a Kafka connector is refused for an unlisted broker, or SASL without its password', () => {
    const adapter = kafkaAdapter({ brokers: parseKafkaBrokers('kafka-1.internal:9092') });
    const kafka = (config: Record<string, unknown>, secret?: string) =>
      connectorOf({ config: { topic: 'orders', groupId: 'g', ...config }, ...(secret ? { secretCredentialId: secret } : {}) });
    assert.doesNotThrow(() => adapter.validateConfig!(kafka({ brokers: ['kafka-1.internal:9092'] })));
    assert.throws(() => adapter.validateConfig!(kafka({ brokers: ['kafka-1.internal:9092', '10.0.0.5:9092'] })), /10\.0\.0\.5:9092 \(a bootstrap broker\) is not in MA_KAFKA_BROKERS/);
    assert.throws(
      () => adapter.validateConfig!(kafka({ brokers: ['kafka-1.internal:9092'], sasl: { mechanism: 'plain', username: 'bob' } })),
      /SASL plain needs bob's password.*secretCredentialId/,
    );
  });

  test('a pull connector refuses inbound requests: the broker is its only way in', async () => {
    for (const adapter of [sqsAdapter({ endpoints: parseSqsEndpoints('aws') }), kafkaAdapter({ brokers: [] })]) {
      const verdict = await adapter.verify({ headers: {}, rawBody: Buffer.alloc(0), body: {}, query: new URLSearchParams(), sourceIp: '1.2.3.4', receivedAt: START }, connectorOf(), 'secret');
      assert.equal(verdict.ok, false);
    }
  });
});

// ---------------------------------------------------------------------------
// SigV4 and the SQS client
// ---------------------------------------------------------------------------

describe('SigV4', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const now = Date.UTC(2015, 7, 30, 12, 36, 0);

  test("reproduces AWS's published examples", () => {
    const iam = signV4({
      method: 'GET',
      url: new URL('https://iam.amazonaws.com/?Version=2010-05-08&Action=ListUsers'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: '',
      region: 'us-east-1',
      service: 'iam',
      credentials,
      now,
    });
    assert.equal(
      iam.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    const vanilla = signV4({ method: 'GET', url: new URL('https://example.amazonaws.com/'), headers: {}, body: '', region: 'us-east-1', service: 'service', credentials, now });
    assert.equal(
      vanilla.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    assert.equal(vanilla['x-amz-date'], '20150830T123600Z');
  });

  test('a session token is sent and signed', () => {
    const signed = signV4({ method: 'POST', url: new URL('https://sqs.eu-west-1.amazonaws.com/'), headers: {}, body: '{}', region: 'eu-west-1', service: 'sqs', credentials: { ...credentials, sessionToken: 'token' }, now });
    assert.equal(signed['x-amz-security-token'], 'token');
    assert.match(signed.authorization!, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
  });
});

describe('the SQS client', () => {
  let server: Server;
  let origin = '';
  let requests: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
  let answer: (target: string, body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

  beforeEach(async () => {
    requests = [];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push({ headers: request.headers, body });
        const reply = answer(String(request.headers['x-amz-target']), body);
        response.writeHead(reply.status, { 'content-type': 'application/x-amz-json-1.0' }).end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const SECRET_VALUE = 'wJalr-secret-value-7f3a';
  const client = (): SqsClient =>
    new SqsClient({ queueUrl: `${origin}/1/orders`, region: 'eu-west-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET_VALUE }, clock: systemClock });

  test('receives with a signed JSON-protocol call, capped at ten and at what it may take', async () => {
    answer = () => ({ status: 200, body: { Messages: [] } });
    await client().receive(25, 20, 60);
    await client().receive(3, 5, undefined);
    const [first, second] = requests;
    assert.equal(first!.headers['x-amz-target'], 'AmazonSQS.ReceiveMessage');
    assert.equal(first!.headers['content-type'], 'application/x-amz-json-1.0');
    assert.match(String(first!.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/sqs\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
    assert.deepEqual(first!.body, { QueueUrl: `${origin}/1/orders`, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60, AttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'] });
    assert.equal(second!.body.MaxNumberOfMessages, 3);
    assert.ok(!('VisibilityTimeout' in second!.body), "absent, so the queue's own setting applies");
  });

  test('deletes in batches of ten and reports what SQS could not delete', async () => {
    answer = (_target, body) => {
      const entries = body.Entries as { Id: string }[];
      return { status: 200, body: { Successful: entries.slice(1).map(({ Id }) => ({ Id })), Failed: [{ Id: entries[0]!.Id, Code: 'ReceiptHandleIsInvalid', Message: 'stale' }] } };
    };
    const handles = Array.from({ length: 12 }, (_, index) => `h${index}`);
    const failed = await client().deleteBatch(handles);
    assert.deepEqual(requests.map((request) => (request.body.Entries as unknown[]).length), [10, 2]);
    assert.deepEqual(failed.map(({ handle, code }) => [handle, code]), [['h0', 'ReceiptHandleIsInvalid'], ['h10', 'ReceiptHandleIsInvalid']]);
  });

  test("SQS's errors become errors that say what to fix", async () => {
    const cases: [number, unknown, string, string, RegExp][] = [
      [400, { __type: 'com.amazonaws.sqs#QueueDoesNotExist', message: 'The specified queue does not exist.' }, 'SQS_QUEUE_NOT_FOUND', 'not_found', /Check config\.queueUrl/],
      [400, { __type: 'com.amazon.coral.service#UnrecognizedClientException', message: 'The security token included in the request is invalid.' }, 'SQS_ACCESS_DENIED', 'permission', /access key AKIDEXAMPLE.*sqs:ReceiveMessage/],
      [403, { __type: 'com.amazon.coral.service#AccessDeniedException', message: 'no' }, 'SQS_ACCESS_DENIED', 'permission', /AccessDeniedException: no/],
      [400, { __type: 'com.amazonaws.sqs#RequestThrottled', message: 'slow down' }, 'SQS_UNAVAILABLE', 'unavailable', /retrying/],
      [500, { message: 'boom' }, 'SQS_UNAVAILABLE', 'unavailable', /500/],
      [400, { __type: 'com.amazonaws.sqs#InvalidAttributeName', message: 'bad' }, 'SQS_REQUEST_FAILED', 'validation', /InvalidAttributeName: bad/],
    ];
    for (const [status, body, code, category, pattern] of cases) {
      answer = () => ({ status, body });
      await assert.rejects(client().receive(1, 1, undefined), (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, code);
        assert.equal(error.category, category);
        assert.match(error.message, pattern);
        assert.ok(!JSON.stringify({ message: error.message, details: error.details }).includes(SECRET_VALUE), 'the secret is not echoed');
        return true;
      });
    }
  });

  test('a message that fails its MD5 check is neither delivered nor deleted', async () => {
    const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
    answer = (target) =>
      target === 'AmazonSQS.ReceiveMessage'
        ? {
            status: 200,
            body: {
              Messages: [
                { MessageId: 'good', ReceiptHandle: 'h-good', Body: 'intact', MD5OfBody: md5('intact'), Attributes: { MessageGroupId: 'g-1' } },
                { MessageId: 'bad', ReceiptHandle: 'h-bad', Body: 'tampered', MD5OfBody: md5('original') },
              ],
            },
          }
        : { status: 200, body: { Successful: [{ Id: '0' }] } };
    const factory = sqsSourceFactory({ clock: systemClock, endpoints: { aws: false, origins: [origin] }, logger: nullLogger });
    const source = await factory.open(
      connectorOf({ type: 'sqs', secretCredentialId: 'cr_1', config: { queueUrl: `${origin}/1/orders`, region: 'eu-west-1', accessKeyId: 'AKIDEXAMPLE' } }),
      'secret',
      new AbortController().signal,
    );
    const batch = await source.receive(10, new AbortController().signal);
    assert.deepEqual(batch.messages.map((m) => [m.transportId, m.key]), [['good', 'g-1']]);
    await batch.ack();
    const deletion = requests.find((request) => request.headers['x-amz-target'] === 'AmazonSQS.DeleteMessageBatch')!;
    assert.deepEqual(deletion.body.Entries, [{ Id: '0', ReceiptHandle: 'h-good' }]);
  });

  test('an unusable credential is refused before any call', async () => {
    const factory = sqsSourceFactory({ clock: systemClock, endpoints: { aws: false, origins: [origin] } });
    await assert.rejects(
      factory.open(connectorOf({ type: 'sqs', secretCredentialId: 'cr_1', config: { queueUrl: `${origin}/1/q`, region: 'r', accessKeyId: 'AKID' } }), undefined, new AbortController().signal),
      (error: unknown) => MaError.is(error) && error.code === 'PULL_CREDENTIAL_UNUSABLE' && /secret access key for AKID/.test(error.message),
    );
    assert.equal(requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

interface ScriptedSource {
  config: Record<string, unknown>;
  receives: number[];
  acks: number;
  closed: boolean;
}

/**
 * A broker stand-in: each connector id has a queue of batches, delivered in
 * order; `failOpen` makes opening throw. Records what the supervisor did.
 */
class ScriptedBroker implements PullSourceFactory {
  readonly queues = new Map<string, PulledMessage[][]>();
  readonly sources: ScriptedSource[] = [];
  readonly failOpen = new Map<string, MaError>();
  /** Called when a batch is acknowledged, with the connector id. */
  onAck: (connectorId: string, batch: readonly PulledMessage[]) => void | Promise<void> = () => {};

  settings(connector: Connector) {
    const config = connector.config as { maxInFlight?: number; eventTypes?: string[] };
    return { maxInFlight: config.maxInFlight ?? 10, filter: { eventTypes: config.eventTypes ?? [], sources: [] } };
  }

  open(connector: Connector, _secret: string | undefined, signal: AbortSignal): Promise<PullSource> {
    const failure = this.failOpen.get(connector.id);
    if (failure) return Promise.reject(failure);
    const record: ScriptedSource = { config: connector.config, receives: [], acks: 0, closed: false };
    this.sources.push(record);
    return Promise.resolve({
      receive: async (limit: number): Promise<PullBatch> => {
        record.receives.push(limit);
        const queue = this.queues.get(connector.id) ?? [];
        const next = queue.shift();
        if (!next) {
          // An empty long poll: wait to be stopped, as a broker would hold the call.
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          throw new Error('aborted');
        }
        const batch = next.slice(0, limit);
        if (next.length > limit) queue.unshift(next.slice(limit));
        return {
          messages: batch,
          ack: async () => {
            await this.onAck(connector.id, batch);
            record.acks++;
          },
        };
      },
      close: () => {
        record.closed = true;
        return Promise.resolve();
      },
    });
  }

  push(connectorId: string, ...batch: PulledMessage[]): void {
    this.queues.set(connectorId, [...(this.queues.get(connectorId) ?? []), batch]);
  }
}

describe('the pull supervisor', () => {
  let store: SqliteStore;
  let clock: TestClock;
  let bus: EventBus;
  let pipeline: DeliveryPipeline;
  let credentials: CredentialService;
  let context: AuthContext;
  let workspaceId: string;
  let agentId: string;
  let broker: ScriptedBroker;
  let supervisor: PullSupervisor;
  let outcomes: PullOutcome[];

  const provisioner: SessionProvisioner = {
    provision: () => Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 1 }),
    release: () => Promise.resolve(),
    submit: () => Promise.resolve(),
    rebind: () => Promise.resolve('ok' as const),
  };

  beforeEach(async () => {
    store = createMemoryStore();
    clock = new TestClock(START);
    bus = new EventBus(store, clock, nullLogger);
    const principal: Principal = await store.principals.create({
      id: newId('principal'),
      type: 'user',
      subject: 'operator',
      displayName: 'Operator',
      email: '',
      isAdmin: false,
      disabled: false,
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'system',
    });
    context = { principal };
    const quota = new QuotaService(store, clock);
    const deps = { store, clock, quota, logger: nullLogger, authorizer: new RoleAuthorizer() };
    const workspace = await new WorkspaceService(deps).create(context, { name: 'Ops', slug: 'ops' });
    workspaceId = workspace.id;
    agentId = (await new AgentService(deps).create(context, { workspaceId, name: 'Responder', spec: { model: { modelId: 'test/model' } } })).id;
    credentials = new CredentialService({ ...deps, keys: InMemoryKeyProvider.generate() });
    const sessions = new SessionService({ ...deps, bus, provisioner });
    pipeline = new DeliveryPipeline({
      store,
      clock,
      adapters: new AdapterRegistry().register(eventBusAdapter({ clock })),
      sessions,
      credentials,
      logger: nullLogger,
    });
    broker = new ScriptedBroker();
    outcomes = [];
    supervisor = new PullSupervisor({ store, clock, pipeline, sources: { kafka: broker }, logger: nullLogger, onMessage: (_type, outcome) => outcomes.push(outcome) });
  });

  afterEach(async () => {
    await supervisor.stop();
    bus.closeAll();
    await store.close();
  });

  async function makeConnector(config: Record<string, unknown> = {}, status: 'active' | 'draft' = 'active'): Promise<Connector> {
    return store.connectors.create({
      id: newId('connector'),
      workspaceId,
      type: 'kafka',
      name: 'orders',
      description: '',
      status,
      agentId,
      externalKey: `orders-${newId('receipt')}`,
      sessionPolicy: 'new_per_event',
      config: { brokers: ['k:9092'], topic: 'orders', groupId: 'g', ...config },
      ownerPrincipalId: context.principal.id,
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'test',
    } as Connector);
  }

  /** Let the loops run: yield to I/O, then move the clock, until `done` or the budget runs out. */
  async function settle(done: () => boolean | Promise<boolean>, stepMs = 1_000, rounds = 200): Promise<void> {
    for (let round = 0; round < rounds; round++) {
      if (await done()) return;
      await new Promise((resolve) => setImmediate(resolve));
      await clock.advance(stepMs);
    }
    assert.fail('the supervisor did not get there');
  }

  const receipts = async (connectorId: string): Promise<string[]> =>
    (await store.receipts.list({ connectorId, limit: 100 })).items.map((receipt) => receipt.externalEventId).sort();

  test('acknowledges a batch only once every message in it has a receipt', async () => {
    const connector = await makeConnector();
    const seen: string[][] = [];
    broker.onAck = async (connectorId) => {
      seen.push(await receipts(connectorId));
    };
    broker.push(connector.id, message('one', { transportId: 'orders/0/1/1' }), message('two', { transportId: 'orders/0/2/1' }));
    await supervisor.scan();
    await settle(() => broker.sources[0]?.acks === 1);
    assert.deepEqual(seen, [['kafka:orders/0/1/1', 'kafka:orders/0/2/1']]);
  });

  test('a receipt that cannot be written leaves the batch unacknowledged, and the next read delivers it once', async () => {
    const connector = await makeConnector();
    const original = store.receipts.createIfAbsent.bind(store.receipts);
    let failures = 1;
    store.receipts.createIfAbsent = (receipt) => (failures-- > 0 ? Promise.reject(new Error('SQLITE_BUSY')) : original(receipt));
    const batch = [message('one', { transportId: 'orders/0/1/1' }), message('two', { transportId: 'orders/0/2/1' })];
    broker.push(connector.id, ...batch);
    broker.push(connector.id, ...batch);
    await supervisor.scan();
    await settle(() => broker.sources.length === 2 && broker.sources[1]!.acks === 1);
    assert.equal(broker.sources[0]!.acks, 0, 'the failed batch was not acknowledged');
    assert.ok(broker.sources[0]!.closed, 'its source was closed for a fresh one');
    assert.deepEqual(await receipts(connector.id), ['kafka:orders/0/1/1', 'kafka:orders/0/2/1']);
  });

  test('reads nothing while maxInFlight deliveries are waiting, then only as much as there is room for', async () => {
    const connector = await makeConnector({ maxInFlight: 2 });
    const pending = [];
    for (const id of ['old-1', 'old-2']) {
      pending.push(
        (await pipeline.enqueue(connector, { externalEventId: id, scopeType: 'kafka', scopeKey: '', scopeLabel: '', events: [{ type: 'user.message', text: id, attachments: [] }], summary: id })).receipt,
      );
    }
    broker.push(connector.id, message('a', { transportId: 'a' }), message('b', { transportId: 'b' }));
    await supervisor.scan();
    await settle(() => broker.sources.length === 1, 1_000, 20);
    for (let round = 0; round < 5; round++) {
      await new Promise((resolve) => setImmediate(resolve));
      await clock.advance(1_000);
    }
    assert.deepEqual(broker.sources[0]!.receives, [], 'no read while two deliveries are in flight');

    await store.receipts.update(pending[0]!.id, { status: 'succeeded', updatedAt: clock.now() });
    await settle(() => broker.sources[0]!.receives.length >= 1);
    assert.equal(broker.sources[0]!.receives[0], 1, 'room for one');
    await settle(async () => (await receipts(connector.id)).includes('kafka:a'));
    assert.ok(!(await receipts(connector.id)).includes('kafka:b'), 'the second waits for room');
  });

  test('a broker failure is recorded on the connector once, and cleared when reading resumes', async () => {
    const connector = await makeConnector();
    broker.failOpen.set(connector.id, new MaError({ code: 'KAFKA_UNAVAILABLE', category: 'unavailable', message: 'broker down' }));
    const writes: unknown[] = [];
    const update = store.connectors.update.bind(store.connectors);
    store.connectors.update = (id, patch) => {
      if ('error' in patch) writes.push(patch.error);
      return update(id, patch);
    };
    await supervisor.scan();
    await settle(async () => (await store.connectors.get(connector.id))?.error?.code === 'KAFKA_UNAVAILABLE');
    for (let round = 0; round < 10; round++) {
      await new Promise((resolve) => setImmediate(resolve));
      await clock.advance(60_000);
    }
    assert.equal(writes.length, 1, 'one record for one ongoing failure, however many retries');
    const recorded = await store.connectors.get(connector.id);
    assert.equal(recorded?.status, 'active');
    assert.equal(recorded?.error?.retryable, true);

    broker.failOpen.delete(connector.id);
    broker.push(connector.id, message('back', { transportId: 'back' }));
    await settle(async () => (await store.connectors.get(connector.id))?.error === undefined, 60_000);
    assert.deepEqual(await receipts(connector.id), ['kafka:back']);
  });

  test('deactivating a connector stops its consumer; editing it restarts it with the new config', async () => {
    const connector = await makeConnector();
    await supervisor.scan();
    await settle(() => broker.sources.length === 1);
    assert.deepEqual(supervisor.consuming, [connector.id]);

    await store.connectors.update(connector.id, { config: { ...connector.config, topic: 'renamed' }, updatedAt: START });
    await supervisor.scan();
    await settle(() => broker.sources.length === 2);
    assert.ok(broker.sources[0]!.closed);
    assert.equal(broker.sources[1]!.config.topic, 'renamed');

    await store.connectors.update(connector.id, { error: { code: 'X', message: 'm', details: {}, occurredAt: START, retryable: true }, updatedAt: START + 5 });
    await supervisor.scan();
    assert.equal(broker.sources.length, 2, 'a change that is not to what it reads does not restart it');

    await store.connectors.update(connector.id, { status: 'disabled', updatedAt: START });
    await supervisor.scan();
    assert.deepEqual(supervisor.consuming, []);
    assert.ok(broker.sources[1]!.closed);
  });

  test('two connectors are consumed independently: one failing does not hold up the other', async () => {
    const failing = await makeConnector();
    const healthy = await makeConnector();
    broker.failOpen.set(failing.id, new MaError({ code: 'KAFKA_ACCESS_DENIED', category: 'permission', message: 'nope' }));
    broker.push(healthy.id, message('for healthy', { transportId: 'h' }));
    await supervisor.scan();
    await settle(async () => (await receipts(healthy.id)).length === 1);
    assert.deepEqual(await receipts(failing.id), []);
    assert.equal((await store.connectors.get(healthy.id))?.error, undefined);
    await settle(async () => (await store.connectors.get(failing.id))?.error?.code === 'KAFKA_ACCESS_DENIED');
  });

  test('every message is accounted for: delivered, a duplicate, or dropped by the filter', async () => {
    const connector = await makeConnector({ eventTypes: ['order.*'] });
    const event = JSON.stringify({ type: 'order.created', source: 'shop', id: 'o-1' });
    broker.push(
      connector.id,
      message(event, { transportId: 'a' }),
      message(event, { transportId: 'b' }),
      message(JSON.stringify({ type: 'user.signup', id: 'u-1' }), { transportId: 'c' }),
    );
    await supervisor.scan();
    await settle(() => broker.sources[0]?.acks === 1);
    assert.deepEqual(outcomes, ['enqueued', 'duplicate', 'ignored']);
    assert.deepEqual(await receipts(connector.id), ['event:shop/o-1']);
  });

  test('stop closes every consumer and leaves nothing sleeping', async () => {
    await makeConnector();
    await makeConnector({}, 'draft');
    supervisor.start();
    await settle(() => broker.sources.length === 1);
    await supervisor.stop();
    assert.ok(broker.sources.every((source) => source.closed));
    assert.deepEqual(supervisor.consuming, []);
    assert.equal(clock.pendingCount, 0);
  });
});
