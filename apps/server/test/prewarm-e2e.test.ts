/**
 * Proactive per-agent prewarm against a real server process.
 *
 * The server runs with the local driver, so every sandbox is a real agent-core
 * process. An agent that declares `sandbox.prewarm` gets warm sandboxes before
 * anyone asks; a session lands on one and runs a turn on it; the pool fills
 * back up; an agent that declares nothing gets none. Sandbox rows are read
 * straight from the server's database file, which is the record the reaper
 * and the pool work from.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { randomToken, systemClock } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';

const SERVER = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const MODEL = 'e2e/echo:free';

let dir: string;
let dbPath: string;
let server: ChildProcess;
let serverLog = '';
let model: Server;
let client: ManagedAgentClient;
let workspaceId: string;

type Row = { id: string; pool_key: string; idle_since: number | null; session_ids: string };

function sandboxes(where: string): Row[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT id, pool_key, idle_since, session_ids FROM sandboxes WHERE ${where}`).all() as Row[];
  } finally {
    db.close();
  }
}
const warm = (): Row[] => sandboxes("status = 'ready' AND idle_since IS NOT NULL");

async function waitFor<T>(what: string, probe: () => T | Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; server log:\n${serverLog.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ma-prewarm-e2e-'));
  dbPath = join(dir, 'ma.db');

  model = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
      const user = [...payload.messages].reverse().find((message) => message.role === 'user');
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'gen-e2e',
          choices: [{ index: 0, message: { role: 'assistant', content: `echo: ${String(user?.content ?? '')}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));

  const port = await freePort();
  const token = randomToken(32);
  server = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      MA_DATABASE: dbPath,
      MA_HOST: '127.0.0.1',
      MA_PORT: String(port),
      MA_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      MA_ARTIFACT_ROOT: join(dir, 'artifacts'),
      MA_LOG_LEVEL: 'warn',
      MA_BOOTSTRAP_TOKEN: token,
      MA_OPENROUTER_API_KEY: 'e2e-key',
      MA_OPENROUTER_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/api/v1`,
      MA_OPENROUTER_MODELS: MODEL,
      MA_SANDBOX_DRIVER: 'local',
      MA_SCHEDULER_TICK_MS: '200',
      MA_RATE_LIMIT: '100000',
      MA_RATE_LIMIT_IP: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.stderr!.on('data', (chunk: Buffer) => {
      serverLog += chunk.toString();
      const match = /listening on (http:\/\/[^\s]+)/.exec(serverLog);
      if (match) resolve(match[1]!);
    });
    server.once('exit', (code) => reject(new Error(`the server exited (${code}) before listening:\n${serverLog}`)));
  });

  client = new ManagedAgentClient({ baseUrl, token, clock: systemClock });
  workspaceId = (await client.createWorkspace({ name: 'Prewarm', slug: 'prewarm-e2e' })).workspace.id;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  server?.kill('SIGKILL');
  await new Promise<void>((resolve) => model?.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('proactive prewarm on a real server', () => {
  test('an agent that declares prewarm has warm sandboxes before any session, and a session runs on one', async () => {
    await client.createAgent(workspaceId, {
      name: 'Cold',
      spec: { model: { modelId: MODEL }, sandbox: { allowReuse: true } },
    });
    const { agent } = await client.createAgent(workspaceId, {
      name: 'Warm',
      spec: { systemPrompt: 'Echo.', model: { modelId: MODEL }, sandbox: { allowReuse: true, prewarm: 2 } },
    });

    const before = await waitFor('two warm sandboxes', warm, (rows) => rows.length >= 2);
    assert.equal(before.length, 2, 'exactly the declared depth, and none for the agent that declared nothing');
    assert.equal(new Set(before.map((row) => row.pool_key)).size, 1);
    const warmIds = new Set(before.map((row) => row.id));

    const startedAt = Date.now();
    const { session } = await client.createSession({ agentId: agent.id });
    const ready = await waitFor(
      'the session to be ready',
      async () => (await client.getSession(session.id)).session,
      (value) => value.status === 'ready' || value.status === 'failed',
    );
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));
    assert.ok(warmIds.has(ready.sandboxId!), 'the session landed on a sandbox that was already warm');
    const readyMs = Date.now() - startedAt;

    await client.prompt(session.id, 'hello warm sandbox');
    const events = await waitFor(
      'the turn to complete',
      async () => (await client.readEvents(session.id, {})).events,
      (all) => all.some((event) => event.type === 'turn.completed'),
    );
    assert.ok(
      events.some((event) => event.type === 'message.completed' && (event.payload as { text?: string }).text === 'echo: hello warm sandbox'),
      'the turn ran on the adopted sandbox',
    );

    const refilled = await waitFor('the pool to fill back up', warm, (rows) => rows.length >= 2);
    assert.equal(refilled.length, 2);
    assert.ok(!refilled.some((row) => row.id === ready.sandboxId), 'the held sandbox is no longer counted as warm');
    assert.ok(readyMs < 10_000, `ready in ${readyMs} ms`);
  });
});
