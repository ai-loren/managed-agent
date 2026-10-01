/**
 * The control plane on Postgres: real server processes on
 * MA_DATABASE=postgres://, two replicas sharing one database and a restart;
 * then the whole unit suite once more, with every in-memory store a schema on
 * that server. Needs Docker; runs when MA_E2E_DOCKER=1 (CI's docker-e2e job).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { systemClock } from '@ma/core';
import type { SessionEvent } from '@ma/contracts';
import { ManagedAgentClient } from '@ma/sdk';

import { EchoModel, LiveServer, MODEL, freePort, must, run, waitFor } from './support/live-server.ts';

const enabled = process.env.MA_E2E_DOCKER === '1';
const IMAGE = 'postgres:17-alpine';
const CONTAINER = `ma-e2e-postgres-${process.pid}`;
const PASSWORD = 'pg-e2e-password-7c1d';
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

let port = 0;
let dir = '';
let model: EchoModel;
let first: LiveServer | undefined;
let second: LiveServer | undefined;

async function ready(client: ManagedAgentClient, sessionId: string, log: () => string): Promise<void> {
  await waitFor('the session to be ready', async () => (await client.getSession(sessionId)).session.status === 'ready', 90_000, log);
}

/** The assistant's replies in a session's log. */
const turns = async (client: ManagedAgentClient, sessionId: string): Promise<string[]> =>
  (await client.readEvents(sessionId, { limit: 1000 })).events
    .filter((event) => event.type === 'message.completed' && (event.payload as { role?: unknown }).role === 'assistant')
    .map((event) => String((event.payload as { text?: unknown }).text));

describe('the control plane on Postgres', { skip: enabled ? false : 'set MA_E2E_DOCKER=1 to run against Docker' }, () => {
  before(async () => {
    await must('docker', ['pull', '-q', IMAGE], undefined, 300_000);
    port = await freePort();
    await run('docker', ['rm', '-f', CONTAINER]);
    // Every in-memory store in the suite is a schema of its own, tens of
    // thousands of relations in all: past Docker's default 64 MB of /dev/shm,
    // Postgres cannot grow its shared memory and fails.
    await must('docker', [
      'run', '-d', '--name', CONTAINER, '--shm-size=1g', '-p', `127.0.0.1:${port}:5432`,
      '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_USER=ma', '-e', 'POSTGRES_DB=ma',
      IMAGE, '-c', 'max_connections=300',
    ]);
    // The image restarts the server once its init script is done, so a ready
    // probe can answer before the server that stays.
    await waitFor('Postgres to answer over TCP', async () => (await run('docker', ['exec', CONTAINER, 'psql', '-U', 'ma', '-h', '127.0.0.1', '-c', 'SELECT 1'])).code === 0, 120_000);
    dir = mkdtempSync(join(tmpdir(), 'ma-pg-e2e-'));
    writeFileSync(join(dir, 'pg-password'), `${PASSWORD}\n`);
    model = new EchoModel();
    await model.start();
  });

  after(async () => {
    await first?.dispose();
    await second?.dispose();
    await model?.stop();
    await run('docker', ['rm', '-f', CONTAINER]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('two replicas on one database each see what the other wrote, and it all survives a restart', async () => {
    const env = {
      MA_DATABASE: `postgres://ma@127.0.0.1:${port}/ma?sslmode=disable&schema=replicas`,
      MA_DATABASE_PASSWORD_FILE: join(dir, 'pg-password'),
    };
    first = new LiveServer(model, env);
    await first.start();
    const one = first.client;
    const { workspace } = await one.createWorkspace({ name: 'Postgres', slug: 'pg-e2e' });
    const { agent } = await one.createAgent(workspace.id, { name: 'Echo', spec: { systemPrompt: 'Echo the request.', model: { modelId: MODEL } } });
    const { session: started } = await one.createSession({ agentId: agent.id, title: 'replica one' });
    await ready(one, started.id, () => first!.log);
    await one.prompt(started.id, 'hello from replica one');
    await waitFor('replica one’s turn', async () => (await turns(one, started.id)).includes('echo: hello from replica one'), 90_000, () => first!.log);

    // The admin key was minted when the store was empty, by the first replica.
    second = new LiveServer(model, env);
    await second.start();
    const two = new ManagedAgentClient({ baseUrl: second.baseUrl, token: first.token, clock: systemClock });
    assert.deepEqual(await turns(two, started.id), ['echo: hello from replica one'], 'replica two reads replica one’s log');
    const { session: other } = await two.createSession({ agentId: agent.id, title: 'replica two' });
    await ready(two, other.id, () => second!.log);
    await two.prompt(other.id, 'hello from replica two');
    await waitFor('replica two’s turn', async () => (await turns(two, other.id)).includes('echo: hello from replica two'), 90_000, () => second!.log);
    assert.deepEqual(await turns(one, other.id), ['echo: hello from replica two'], 'replica one reads replica two’s log');

    await first.stop();
    await second.stop();
    await first.start();
    assert.deepEqual(await turns(first.client, started.id), ['echo: hello from replica one']);
    assert.deepEqual(await turns(first.client, other.id), ['echo: hello from replica two']);
    assert.equal((await first.client.getSession(other.id)).session.title, 'replica two');

    for (const log of [first.log, second.log]) {
      assert.match(log, /postgres:\/\/ma@127\.0\.0\.1/, 'the log says where the database is');
      assert.ok(!log.includes(PASSWORD), 'and never its password');
    }
  });

  test("a live event stream on one replica follows a turn the other replica runs, in order and without gaps", async () => {
    const env = {
      MA_DATABASE: `postgres://ma@127.0.0.1:${port}/ma?sslmode=disable&schema=live`,
      MA_DATABASE_PASSWORD_FILE: join(dir, 'pg-password'),
    };
    const runner = new LiveServer(model, env);
    const watcher = new LiveServer(model, env);
    const controller = new AbortController();
    try {
      await runner.start();
      await watcher.start();
      const { workspace } = await runner.client.createWorkspace({ name: 'Live', slug: 'pg-live' });
      const { agent } = await runner.client.createAgent(workspace.id, { name: 'Echo', spec: { systemPrompt: 'Echo the request.', model: { modelId: MODEL } } });
      const { session } = await runner.client.createSession({ agentId: agent.id, title: 'watched from the other replica' });
      await ready(runner.client, session.id, () => runner.log);
      const fromSeq = (await runner.client.readEvents(session.id, { limit: 1000 })).events.at(-1)!.seq + 1;

      // The runner's sandbox reports to the runner; the watcher learns of the turn only from the log.
      const viewer = new ManagedAgentClient({ baseUrl: watcher.baseUrl, token: runner.token, clock: systemClock });
      const seen: SessionEvent[] = [];
      const following = (async () => {
        for await (const event of viewer.streamEvents(session.id, { fromSeq, signal: controller.signal })) seen.push(event);
      })().catch(() => {});
      // Open before the turn, so nothing reaches the viewer by replay.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await runner.client.prompt(session.id, 'hello across replicas');
      await waitFor(
        'the watcher to stream the turn live',
        () => seen.some((event) => event.type === 'message.completed' && (event.payload as { text?: string }).text === 'echo: hello across replicas'),
        30_000,
        () => watcher.log,
      );
      const seqs = seen.map((event) => event.seq);
      assert.deepEqual(seqs, seqs.map((_, index) => fromSeq + index), `one gap-free stream in order: ${seqs.join(',')}`);
      controller.abort();
      await following;
    } finally {
      controller.abort();
      await runner.dispose();
      await watcher.dispose();
    }
  });

  test('the unit suite passes with every in-memory store a schema on Postgres', async () => {
    // Without its marker, or node:test takes the run for a recursion and runs nothing.
    const { NODE_TEST_CONTEXT: _marker, ...inherited } = process.env;
    const outcome = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--test', '--test-timeout=120000', 'packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
        {
          cwd: REPO,
          env: { ...inherited, MA_E2E_DOCKER: '', MA_TEST_POSTGRES_URL: `postgres://ma:${PASSWORD}@127.0.0.1:${port}/ma?sslmode=disable` },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('exit', (code) => resolve({ code, output }));
    });
    const failed = outcome.output.split('\n').filter((line) => /^\s*✖/.test(line)).slice(0, 40).join('\n');
    assert.equal(outcome.code, 0, `the suite failed on Postgres:\n${failed}\n${outcome.output.slice(-6000)}`);
    assert.match(outcome.output, /ℹ fail 0/);
    const ran = Number(/ℹ pass (\d+)/.exec(outcome.output)?.[1] ?? 0);
    assert.ok(ran > 1000, `the suite ran ${ran} tests; a run that ran next to none proves nothing`);
  });
});
