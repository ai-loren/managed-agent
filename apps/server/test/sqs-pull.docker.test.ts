/**
 * SQS connectors against a real queue: ElasticMQ in Docker, read by a real
 * server process whose sessions run real agent-core. Needs Docker; runs when
 * MA_E2E_DOCKER=1 (CI's docker-e2e job sets it).
 *
 * ElasticMQ speaks SQS's JSON protocol but does not check signatures, so this
 * proves the consumer's behaviour; the signature is pinned to AWS's published
 * examples in the connectors package's tests.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { systemClock } from '@ma/core';
import { SqsClient } from '@ma/connectors';

import { EchoModel, LiveServer, MODEL, freePort, must, run, waitFor } from './support/live-server.ts';

const enabled = process.env.MA_E2E_DOCKER === '1';
const IMAGE = 'softwaremill/elasticmq-native:1.6.11';
const CONTAINER = `ma-e2e-elasticmq-${process.pid}`;
const SECRET = 'elasticmq-does-not-check-this-secret';

let base = '';
let admin: SqsClient;
let model: EchoModel;
let server: LiveServer;
let workspaceId = '';
let agentId = '';
let credentialId = '';

const queueUrl = (name: string): string => `${base}/000000000000/${name}`;

async function createQueue(name: string, attributes: Record<string, string> = {}): Promise<string> {
  await admin.call('CreateQueue', { QueueName: name, Attributes: attributes });
  return queueUrl(name);
}

async function send(url: string, body: string, extra: Record<string, unknown> = {}): Promise<void> {
  await admin.call('SendMessage', { QueueUrl: url, MessageBody: body, ...extra });
}

async function depth(url: string): Promise<{ visible: number; hidden: number }> {
  const { Attributes } = await admin.call<{ Attributes: Record<string, string> }>('GetQueueAttributes', {
    QueueUrl: url,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  });
  return { visible: Number(Attributes.ApproximateNumberOfMessages), hidden: Number(Attributes.ApproximateNumberOfMessagesNotVisible) };
}

async function connector(name: string, config: Record<string, unknown>, sessionPolicy: 'new_per_event' | 'reuse_per_scope' = 'new_per_event'): Promise<string> {
  const created = await server.client.createConnector(workspaceId, {
    type: 'sqs',
    name,
    externalKey: name,
    agentId,
    sessionPolicy,
    secretCredentialId: credentialId,
    config: { region: 'elasticmq', accessKeyId: 'AKIDEXAMPLE', waitTimeSeconds: 1, ...config },
  });
  await server.client.activateConnector(created.id);
  return created.id;
}

const prompted = (text: string): boolean => model.prompts().includes(text);

describe('SQS connectors against ElasticMQ', { skip: enabled ? false : 'set MA_E2E_DOCKER=1 to run against Docker' }, () => {
  before(async () => {
    await must('docker', ['pull', '-q', IMAGE], undefined, 300_000);
    const port = await freePort();
    await run('docker', ['rm', '-f', CONTAINER]);
    await must('docker', ['run', '-d', '--name', CONTAINER, '-p', `127.0.0.1:${port}:9324`, IMAGE]);
    base = `http://127.0.0.1:${port}`;
    admin = new SqsClient({
      queueUrl: queueUrl('bootstrap'),
      region: 'elasticmq',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET },
      clock: systemClock,
    });
    await waitFor('ElasticMQ to answer', async () => {
      try {
        await admin.call('ListQueues', {});
        return true;
      } catch {
        return false;
      }
    }, 60_000);

    model = new EchoModel();
    await model.start();
    server = new LiveServer(model, { MA_SQS_ENDPOINTS: base });
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'SQS', slug: 'sqs-e2e' });
    workspaceId = workspace.id;
    const { agent } = await server.client.createAgent(workspaceId, {
      name: 'Echo',
      spec: { systemPrompt: 'Echo the request.', model: { modelId: MODEL } },
    });
    agentId = agent.id;
    const { credential } = await server.client.createCredential(workspaceId, {
      ownerType: 'workspace',
      type: 'api_key',
      name: 'sqs secret access key',
      value: SECRET,
    });
    credentialId = credential.id;
  });

  after(async () => {
    await server?.dispose();
    await model?.stop();
    await run('docker', ['rm', '-f', CONTAINER]);
  });

  test('delivers each matching event once, drops the rest, and leaves the queue empty', async () => {
    const url = await createQueue('orders');
    const id = await connector('orders', {
      queueUrl: url,
      eventTypes: ['order.*'],
      promptTemplate: 'Order {{type}} from {{source}}: {{data}}',
    });

    const created = JSON.stringify({ specversion: '1.0', type: 'order.created', source: 'shop', id: 'o-1', data: { n: 1 } });
    await send(url, created);
    await send(url, created);
    await send(url, JSON.stringify({ specversion: '1.0', type: 'user.signup', source: 'shop', id: 'u-1', data: {} }));
    await send(url, 'a message with no type at all');
    await send(
      url,
      JSON.stringify({
        Type: 'Notification',
        MessageId: 'sns-1',
        TopicArn: 'arn:aws:sns:eu-west-1:000000000000:orders',
        Message: JSON.stringify({ 'detail-type': 'order.shipped', source: 'warehouse', id: 'eb-1', detail: { n: 2 } }),
      }),
    );

    await waitFor('both orders to reach the agent', () => prompted('Order order.created from shop: {"n":1}') && prompted('Order order.shipped from warehouse: {"n":2}'), 90_000, () => server.log);
    await waitFor('the queue to drain', async () => {
      const left = await depth(url);
      return left.visible === 0 && left.hidden === 0;
    });
    assert.equal(model.prompts().filter((prompt) => prompt.startsWith('Order ')).length, 2, model.prompts().join('\n'));

    const receipts = await server.client.listReceipts(id);
    assert.deepEqual(receipts.items.map((receipt) => receipt.externalEventId).sort(), ['event:shop/o-1', 'event:warehouse/eb-1']);
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'sqs', outcome: 'enqueued' }), 2);
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'sqs', outcome: 'duplicate' }), 1);
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'sqs', outcome: 'ignored' }), 2);
    const { connector: after } = await server.client.getConnector(id);
    assert.ok(after.lastDeliveryAt, 'the connector records its last delivery');
  });

  test("a FIFO queue's message group is one conversation, in order", async () => {
    const url = await createQueue('tickets.fifo', { FifoQueue: 'true', ContentBasedDeduplication: 'true' });
    const id = await connector('tickets', { queueUrl: url }, 'reuse_per_scope');

    await send(url, 'first for seven', { MessageGroupId: 'customer-7' });
    await send(url, 'second for seven', { MessageGroupId: 'customer-7' });
    await send(url, 'only for nine', { MessageGroupId: 'customer-9' });
    await waitFor('all three tickets', () => ['first for seven', 'second for seven', 'only for nine'].every(prompted), 90_000, () => server.log);

    const prompts = model.prompts();
    assert.ok(prompts.indexOf('first for seven') < prompts.indexOf('second for seven'), 'a group is delivered in order');
    await waitFor('every ticket to be handed to a session', async () => {
      const receipts = await server.client.listReceipts(id);
      return receipts.items.length === 3 && receipts.items.every((receipt) => receipt.sessionId);
    });
    const receipts = (await server.client.listReceipts(id)).items;
    const bySummary = new Map(receipts.map((receipt) => [receipt.payloadSummary, receipt.sessionId]));
    assert.equal(bySummary.get('first for seven'), bySummary.get('second for seven'), "one group's messages share a session");
    assert.notEqual(bySummary.get('first for seven'), bySummary.get('only for nine'), 'another group gets its own');
  });

  test('reads no further ahead than maxInFlight', async () => {
    const url = await createQueue('backlog');
    for (const n of [1, 2, 3, 4]) await send(url, `backlog item ${n}`);
    const id = await connector('backlog', { queueUrl: url, maxInFlight: 1 });

    let peak = 0;
    let waitedInQueue = false;
    await waitFor('the whole backlog', async () => {
      const receipts = await server.client.listReceipts(id);
      const inFlight = receipts.items.filter((receipt) => receipt.status === 'pending' || receipt.status === 'working').length;
      peak = Math.max(peak, inFlight);
      if (inFlight === 1 && (await depth(url)).visible > 0) waitedInQueue = true;
      return [1, 2, 3, 4].every((n) => prompted(`backlog item ${n}`));
    }, 120_000, () => server.log);

    assert.equal(peak, 1, `at most one delivery in flight at a time; saw ${peak}`);
    assert.ok(waitedInQueue, 'while one was in flight the rest stayed in the queue');
  });

  test('a queue that does not exist shows on the connector, and clears once it does', async () => {
    const url = queueUrl('later');
    const id = await connector('later', { queueUrl: url });
    await waitFor('the connector to report the missing queue', async () => {
      const { connector: current } = await server.client.getConnector(id);
      return current.error?.code === 'SQS_QUEUE_NOT_FOUND';
    }, 30_000, () => server.log);
    const { connector: failing } = await server.client.getConnector(id);
    assert.equal(failing.status, 'active', 'a broker problem does not deactivate the connector');
    assert.match(failing.error!.message, /does not exist.*Check config\.queueUrl/);

    await createQueue('later');
    await send(url, 'now it exists');
    await waitFor('the message on the new queue', () => prompted('now it exists'), 90_000, () => server.log);
    await waitFor('the error to clear', async () => (await server.client.getConnector(id)).connector.error === undefined);
  });

  test('a queue outside MA_SQS_ENDPOINTS cannot be activated', async () => {
    const created = await server.client.createConnector(workspaceId, {
      type: 'sqs',
      name: 'metadata',
      externalKey: 'metadata',
      agentId,
      secretCredentialId: credentialId,
      config: { queueUrl: 'http://169.254.169.254/latest/meta-data', region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE' },
    });
    await assert.rejects(server.client.activateConnector(created.id), (error: unknown) => {
      const failure = error as { category?: string; code?: string; message: string };
      assert.equal(failure.code, 'PULL_ENDPOINT_NOT_ALLOWED');
      assert.equal(failure.category, 'permission');
      assert.match(failure.message, /MA_SQS_ENDPOINTS/);
      return true;
    });
  });

  test('a pull connector accepts no inbound deliveries', async () => {
    const response = await fetch(`${server.baseUrl}/ingress/v1/${workspaceId}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'order.created', source: 'shop', id: 'forged', data: {} }),
    });
    await response.body?.cancel();
    assert.ok(!response.ok, `ingress answered ${response.status}`);
    const { items } = await server.client.listConnectors(workspaceId, { type: 'sqs' });
    const orders = items.find((item) => item.externalKey === 'orders')!;
    const receipts = await server.client.listReceipts(orders.id);
    assert.ok(!receipts.items.some((receipt) => receipt.externalEventId.includes('forged')));
  });
});
