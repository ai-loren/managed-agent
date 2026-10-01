/**
 * Kafka connectors against real brokers, read by a real server process whose
 * sessions run real agent-core. Needs Docker; runs when MA_E2E_DOCKER=1 (CI's
 * docker-e2e job sets it).
 *
 * Two brokers, the two ends of what the consumer claims: Kafka 4.1 over
 * plaintext, and Kafka 3.9 behind SASL (SCRAM-SHA-512 and PLAIN). Records are
 * written by Kafka's own console producer, with each compression codec, so the
 * decoding is checked against the Java client's actual bytes.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { EchoModel, LiveServer, MODEL, freePort, must, run, waitFor } from './support/live-server.ts';

const enabled = process.env.MA_E2E_DOCKER === '1';
const KAFKA_4 = 'apache/kafka:4.1.0';
const KAFKA_3 = 'apache/kafka:3.9.1';
const PLAIN_BROKER = `ma-e2e-kafka4-${process.pid}`;
const SASL_BROKER = `ma-e2e-kafka3-${process.pid}`;
const BIN = '/opt/kafka/bin';
/** How long the SASL broker lets an authenticated session live. */
const SESSION_LIFETIME_MS = 15_000;

let plainPort = 0;
let saslPort = 0;
let model: EchoModel;
let server: LiveServer;
let workspaceId = '';
let agentId = '';

function brokerEnv(port: number, sasl: boolean): string[] {
  const external = sasl ? 'SASL' : 'PLAINTEXT';
  const env: Record<string, string> = {
    KAFKA_NODE_ID: '1',
    KAFKA_PROCESS_ROLES: 'broker,controller',
    KAFKA_LISTENERS: `${external}://:9092,INTERNAL://:29092,CONTROLLER://:9093`,
    KAFKA_ADVERTISED_LISTENERS: `${external}://127.0.0.1:${port},INTERNAL://localhost:29092`,
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: `CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT,${external}:${sasl ? 'SASL_PLAINTEXT' : 'PLAINTEXT'}`,
    KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
    KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
    KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    ...(sasl
      ? {
          KAFKA_SASL_ENABLED_MECHANISMS: 'SCRAM-SHA-512,PLAIN',
          // Sessions expire as on managed clusters that require re-authentication;
          // a client that does not renew is disconnected on its next request.
          KAFKA_CONNECTIONS_MAX_REAUTH_MS: String(SESSION_LIFETIME_MS),
          KAFKA_LISTENER_NAME_SASL_SCRAM___SHA___512_SASL_JAAS_CONFIG:
            'org.apache.kafka.common.security.scram.ScramLoginModule required;',
          KAFKA_LISTENER_NAME_SASL_PLAIN_SASL_JAAS_CONFIG:
            'org.apache.kafka.common.security.plain.PlainLoginModule required user_bob="bob-secret";',
        }
      : {}),
  };
  return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

async function startBroker(name: string, image: string, port: number, sasl: boolean): Promise<void> {
  await run('docker', ['rm', '-f', name]);
  await must('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:9092`, ...brokerEnv(port, sasl), image]);
  await waitFor(`${name} to start`, async () => (await kafka(name, 'kafka-topics.sh', ['--list'])).code === 0, 120_000);
}

function kafka(container: string, tool: string, args: string[], input?: string): ReturnType<typeof run> {
  return run('docker', ['exec', '-i', container, `${BIN}/${tool}`, '--bootstrap-server', 'localhost:29092', ...args], input);
}

async function createTopic(container: string, topic: string, partitions: number): Promise<void> {
  const result = await kafka(container, 'kafka-topics.sh', ['--create', '--topic', topic, '--partitions', String(partitions)]);
  assert.equal(result.code, 0, result.stderr);
}

/** Produce `key:value` lines with Kafka's console producer; `NULL` is a tombstone. */
async function produce(container: string, topic: string, lines: string[], codec = 'none'): Promise<void> {
  const result = await kafka(
    container,
    'kafka-console-producer.sh',
    ['--topic', topic, '--compression-codec', codec, '--property', 'parse.key=true', '--property', 'key.separator=:', '--property', 'null.marker=NULL'],
    `${lines.join('\n')}\n`,
  );
  assert.equal(result.code, 0, result.stderr);
}

/** Committed offset and log end per partition, from Kafka's own group tool. */
async function groupOffsets(container: string, group: string): Promise<{ partition: number; current: number; end: number }[]> {
  const result = await kafka(container, 'kafka-consumer-groups.sh', ['--describe', '--group', group]);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[0] === group && /^\d+$/.test(cols[2] ?? ''))
    .map((cols) => ({ partition: Number(cols[2]), current: Number(cols[3]), end: Number(cols[4]) }));
}

/** How many members a group has, from Kafka's own group tool. */
async function groupMembers(container: string, group: string): Promise<number> {
  const result = await kafka(container, 'kafka-consumer-groups.sh', ['--describe', '--group', group, '--members']);
  if (result.code !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim().split(/\s+/)[0] === group).length;
}

async function credential(name: string, value: string): Promise<string> {
  const { credential: created } = await server.client.createCredential(workspaceId, { ownerType: 'workspace', type: 'api_key', name, value });
  return created.id;
}

async function connector(
  name: string,
  config: Record<string, unknown>,
  options: { sessionPolicy?: 'new_per_event' | 'reuse_per_scope'; secretCredentialId?: string } = {},
): Promise<string> {
  const created = await server.client.createConnector(workspaceId, {
    type: 'kafka',
    name,
    externalKey: name,
    agentId,
    sessionPolicy: options.sessionPolicy ?? 'new_per_event',
    ...(options.secretCredentialId ? { secretCredentialId: options.secretCredentialId } : {}),
    config,
  });
  await server.client.activateConnector(created.id);
  return created.id;
}

const count = (text: string): number => model.prompts().filter((prompt) => prompt === text).length;

describe('Kafka connectors against real brokers', { skip: enabled ? false : 'set MA_E2E_DOCKER=1 to run against Docker' }, () => {
  before(async () => {
    await Promise.all([must('docker', ['pull', '-q', KAFKA_4], undefined, 600_000), must('docker', ['pull', '-q', KAFKA_3], undefined, 600_000)]);
    plainPort = await freePort();
    saslPort = await freePort();
    await Promise.all([startBroker(PLAIN_BROKER, KAFKA_4, plainPort, false), startBroker(SASL_BROKER, KAFKA_3, saslPort, true)]);
    const scram = await kafka(SASL_BROKER, 'kafka-configs.sh', [
      '--alter', '--add-config', 'SCRAM-SHA-512=[iterations=8192,password=alice-secret]', '--entity-type', 'users', '--entity-name', 'alice',
    ]);
    assert.equal(scram.code, 0, scram.stderr);

    model = new EchoModel();
    await model.start();
    server = new LiveServer(model, { MA_KAFKA_BROKERS: `127.0.0.1:${plainPort},127.0.0.1:${saslPort}` });
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'Kafka', slug: 'kafka-e2e' });
    workspaceId = workspace.id;
    const { agent } = await server.client.createAgent(workspaceId, {
      name: 'Echo',
      spec: { systemPrompt: 'Echo the request.', model: { modelId: MODEL } },
    });
    agentId = agent.id;
  });

  after(async () => {
    await server?.dispose();
    await model?.stop();
    await run('docker', ['rm', '-f', PLAIN_BROKER, SASL_BROKER]);
  });

  test('reads every partition from the start, each record once, whatever its codec', async () => {
    await createTopic(PLAIN_BROKER, 'orders', 3);
    await produce(PLAIN_BROKER, 'orders', ['customer-1:first order of one'], 'gzip');
    await produce(PLAIN_BROKER, 'orders', ['customer-2:only order of two'], 'snappy');
    await produce(PLAIN_BROKER, 'orders', ['customer-1:second order of one'], 'lz4');
    await produce(PLAIN_BROKER, 'orders', ['customer-4:{"specversion":"1.0","type":"order.created","source":"shop","id":"o-42","data":{"n":42}}'], 'zstd');
    await produce(PLAIN_BROKER, 'orders', ['customer-3:NULL']);

    const id = await connector(
      'orders',
      { brokers: [`127.0.0.1:${plainPort}`], topic: 'orders', groupId: 'ma-orders', startFrom: 'earliest' },
      { sessionPolicy: 'reuse_per_scope' },
    );
    const expected = ['first order of one', 'second order of one', 'only order of two', '{"n":42}'];
    await waitFor('every record', () => expected.every((prompt) => count(prompt) === 1), 120_000, () => server.log);
    const prompts = model.prompts();
    assert.ok(prompts.indexOf('first order of one') < prompts.indexOf('second order of one'), "one key's records arrive in order");

    await waitFor('the group to commit to the end of every partition', async () => {
      const offsets = await groupOffsets(PLAIN_BROKER, 'ma-orders');
      return offsets.length === 3 && offsets.every((entry) => entry.current === entry.end);
    });
    await waitFor('each record handed to a session', async () => {
      const receipts = await server.client.listReceipts(id);
      return receipts.items.length === 4 && receipts.items.every((receipt) => receipt.sessionId);
    });
    const receipts = (await server.client.listReceipts(id)).items;
    const session = new Map(receipts.map((receipt) => [receipt.payloadSummary, receipt.sessionId]));
    assert.equal(session.get('first order of one'), session.get('second order of one'), "a key's records share a session");
    assert.notEqual(session.get('first order of one'), session.get('only order of two'));
    assert.ok(receipts.some((receipt) => receipt.externalEventId === 'event:shop/o-42'), 'a CloudEvent is keyed by its own id');
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'kafka', outcome: 'ignored' }), 1, 'the tombstone is dropped');
  });

  test('a new group starting from latest skips the history', async () => {
    const id = await connector('latest', { brokers: [`127.0.0.1:${plainPort}`], topic: 'orders', groupId: 'ma-latest' });
    await waitFor('the new group to commit its starting position', async () => {
      const offsets = await groupOffsets(PLAIN_BROKER, 'ma-latest');
      return offsets.length === 3 && offsets.every((entry) => entry.current === entry.end);
    }, 60_000, () => server.log);
    await produce(PLAIN_BROKER, 'orders', ['customer-5:fresh order']);
    await waitFor('the fresh order on both connectors', () => count('fresh order') === 2, 90_000, () => server.log);
    const receipts = await server.client.listReceipts(id);
    assert.deepEqual(receipts.items.map((receipt) => receipt.payloadSummary), ['fresh order']);
  });

  test('picks up from its committed position after a restart, re-reading nothing', async () => {
    await server.stop();
    await produce(PLAIN_BROKER, 'orders', ['customer-6:made while down']);
    await server.start();
    await waitFor('the record made while the server was down, on both connectors', () => count('made while down') === 2, 120_000, () => server.log);
    for (const prompt of ['first order of one', 'only order of two', 'fresh order']) {
      assert.equal(count(prompt), prompt === 'fresh order' ? 2 : 1, `${prompt} was not delivered again`);
    }
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'kafka', outcome: 'duplicate' }), 0, 'nothing was read twice');
  });

  test('authenticates with SCRAM-SHA-512 and PLAIN; a wrong password shows on the connector until it is fixed', async () => {
    await createTopic(SASL_BROKER, 'secure', 1);
    await produce(SASL_BROKER, 'secure', ['k:secured message']);
    const brokers = [`127.0.0.1:${saslPort}`];
    await connector(
      'scram',
      { brokers, topic: 'secure', groupId: 'ma-scram', startFrom: 'earliest', sasl: { mechanism: 'scram-sha-512', username: 'alice' } },
      { secretCredentialId: await credential('alice', 'alice-secret') },
    );
    await connector(
      'plain',
      // The test broker speaks SASL without TLS, so PLAIN has to be told the network is trusted.
      { brokers, topic: 'secure', groupId: 'ma-plain', startFrom: 'earliest', sasl: { mechanism: 'plain', username: 'bob', allowCleartextPassword: true } },
      { secretCredentialId: await credential('bob', 'bob-secret') },
    );
    await waitFor('the message through both mechanisms', () => count('secured message') === 2, 120_000, () => server.log);

    const wrong = await connector(
      'wrong',
      { brokers, topic: 'secure', groupId: 'ma-wrong', startFrom: 'earliest', sasl: { mechanism: 'scram-sha-512', username: 'alice' } },
      { secretCredentialId: await credential('alice typo', 'not-the-password') },
    );
    await waitFor('the refused login on the connector', async () => (await server.client.getConnector(wrong)).connector.error?.code === 'KAFKA_ACCESS_DENIED', 60_000, () => server.log);
    const { connector: failing } = await server.client.getConnector(wrong);
    assert.match(failing.error!.message, /rejected SASL SCRAM-SHA-512 for alice/);
    assert.doesNotMatch(JSON.stringify(failing.error), /not-the-password/, 'the password is not echoed');
    assert.doesNotMatch(server.log, /not-the-password/, 'nor logged');

    await server.client.updateConnector(wrong, { secretCredentialId: await credential('alice fixed', 'alice-secret') });
    await waitFor('the fixed connector to read', () => count('secured message') === 3, 90_000, () => server.log);
    await waitFor('its error to clear', async () => (await server.client.getConnector(wrong)).connector.error === undefined);
  });

  test('renews its SASL session before the broker expires it, so reading never fails over it', async () => {
    await createTopic(SASL_BROKER, 'renewed', 1);
    const id = await connector(
      'renewed',
      { brokers: [`127.0.0.1:${saslPort}`], topic: 'renewed', groupId: 'ma-renewed', startFrom: 'earliest', sasl: { mechanism: 'scram-sha-512', username: 'alice' } },
      { secretCredentialId: await credential('alice for renewal', 'alice-secret') },
    );
    const before = await server.metric('ma_connector_pulled_total', { type: 'kafka', outcome: 'enqueued' });
    const errors = new Set<string>();
    const started = Date.now();
    let produced = 0;
    // Past three session lifetimes, a message every few seconds and the connector watched throughout.
    while (Date.now() - started < SESSION_LIFETIME_MS * 3) {
      if (Date.now() - started >= produced * 6_000) {
        await produce(SASL_BROKER, 'renewed', [`k:renewed ${produced}`]);
        produced++;
      }
      const { connector: current } = await server.client.getConnector(id);
      if (current.error) errors.add(`${current.error.code}: ${current.error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const expected = Array.from({ length: produced }, (_, index) => `renewed ${index}`);
    await waitFor('every message produced across the renewals', () => expected.every((prompt) => count(prompt) === 1), 60_000, () => server.log);
    assert.deepEqual([...errors], [], 'the connector never showed an error');
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'kafka', outcome: 'enqueued' }) - before, produced);
    assert.doesNotMatch(server.log, /closed the connection/, 'no consumer lost its connection to an expired session');
  });

  test('a topic that does not exist shows on the connector, and clears once it does', async () => {
    const id = await connector('later', { brokers: [`127.0.0.1:${plainPort}`], topic: 'later', groupId: 'ma-later', startFrom: 'earliest' });
    await waitFor('the missing topic on the connector', async () => (await server.client.getConnector(id)).connector.error?.code === 'KAFKA_TOPIC_NOT_FOUND', 60_000, () => server.log);
    await createTopic(PLAIN_BROKER, 'later', 1);
    await produce(PLAIN_BROKER, 'later', ['k:on the later topic']);
    await waitFor('the record on the new topic', () => count('on the later topic') === 1, 120_000, () => server.log);
    await waitFor('the error to clear', async () => (await server.client.getConnector(id)).connector.error === undefined);
  });

  test('connectors on one group split its partitions, each record reaching one of them; when one stops, the other reads its share', async () => {
    await createTopic(PLAIN_BROKER, 'shared', 4);
    const config = { brokers: [`127.0.0.1:${plainPort}`], topic: 'shared', groupId: 'ma-shared', startFrom: 'earliest' };
    const one = await connector('shared-one', config);
    const two = await connector('shared-two', config);
    await waitFor('both connectors in the group', async () => (await groupMembers(PLAIN_BROKER, 'ma-shared')) === 2, 60_000, () => server.log);

    // Receipts, not prompts: what each connector read, whatever the agents' quota lets run.
    const read = async (id: string): Promise<string[]> => (await server.client.listReceipts(id, { limit: 100 })).items.map((receipt) => receipt.payloadSummary);
    const first = Array.from({ length: 12 }, (_, index) => `shared ${index}`);
    await produce(PLAIN_BROKER, 'shared', first.map((text, index) => `key-${index}:${text}`));
    await waitFor('every record read', async () => (await read(one)).length + (await read(two)).length >= first.length, 90_000, () => server.log);
    const [byOne, byTwo] = [await read(one), await read(two)];
    assert.deepEqual([...byOne, ...byTwo].sort(), [...first].sort(), 'each record read once, by one of them');
    assert.ok(byOne.length > 0 && byTwo.length > 0, `both read a share (${byOne.length} and ${byTwo.length})`);

    await server.client.setConnectorStatus(two, 'disabled');
    await waitFor('the group down to one member', async () => (await groupMembers(PLAIN_BROKER, 'ma-shared')) === 1, 60_000, () => server.log);
    const later = Array.from({ length: 12 }, (_, index) => `later ${index}`);
    await produce(PLAIN_BROKER, 'shared', later.map((text, index) => `key-${index}:${text}`));
    await waitFor('every later record, through the one left', async () => (await read(one)).length >= byOne.length + later.length, 90_000, () => server.log);
    assert.deepEqual((await read(one)).filter((text) => text.startsWith('later')).sort(), [...later].sort());
    assert.deepEqual(await read(two), byTwo, 'the stopped one read nothing more');
    assert.equal(await server.metric('ma_connector_pulled_total', { type: 'kafka', outcome: 'duplicate' }), 0, 'nothing read twice across the handover');
  });

  test("a group another client's consumers are in is refused, and the connector says so", async () => {
    await createTopic(PLAIN_BROKER, 'theirs', 1);
    // Kafka's own console consumer, in the group and still running.
    await must('docker', [
      'exec', '-d', PLAIN_BROKER, `${BIN}/kafka-console-consumer.sh`, '--bootstrap-server', 'localhost:29092',
      '--topic', 'theirs', '--group', 'their-app', '--consumer-property', 'group.protocol=classic',
    ]);
    await waitFor('their consumer in the group', async () => (await groupMembers(PLAIN_BROKER, 'their-app')) === 1, 60_000);
    const id = await connector('theirs', { brokers: [`127.0.0.1:${plainPort}`], topic: 'theirs', groupId: 'their-app' });
    await waitFor('the refusal on the connector', async () => (await server.client.getConnector(id)).connector.error?.code === 'KAFKA_GROUP_IN_USE', 60_000, () => server.log);
    assert.match((await server.client.getConnector(id)).connector.error!.message, /groupId of its own/);
    assert.equal(await groupMembers(PLAIN_BROKER, 'their-app'), 1, 'their consumer keeps the group to itself');
  });

  test('a broker outside MA_KAFKA_BROKERS cannot be activated', async () => {
    const created = await server.client.createConnector(workspaceId, {
      type: 'kafka',
      name: 'elsewhere',
      externalKey: 'elsewhere',
      agentId,
      config: { brokers: ['10.255.255.1:9092'], topic: 'orders', groupId: 'ma-elsewhere' },
    });
    await assert.rejects(server.client.activateConnector(created.id), (error: unknown) => {
      const failure = error as { category?: string; code?: string; message: string };
      assert.equal(failure.code, 'PULL_ENDPOINT_NOT_ALLOWED');
      assert.equal(failure.category, 'permission');
      assert.match(failure.message, /10\.255\.255\.1:9092.*MA_KAFKA_BROKERS/);
      return true;
    });
  });
});
