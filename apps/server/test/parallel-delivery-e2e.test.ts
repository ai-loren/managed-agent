/**
 * Parallel connector delivery against a real server process.
 *
 * Everything is real except the far ends: the server runs as its own process
 * with the local sandbox driver, so every session gets a real agent-core
 * process; the model is a stand-in for OpenRouter that takes a while to answer
 * and echoes the prompt; the hook callbacks land on a local receiver. That is
 * enough to see the three things this feature promises: deliveries to
 * different conversations overlap, each reply reaches the conversation that
 * asked, and one conversation still gets its events one at a time, in order.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hmacSha256Hex, randomToken, systemClock } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';

const SERVER = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const MODEL = 'e2e/echo:free';
/** Long enough that three answers taken one at a time could not overlap by accident. */
const MODEL_DELAY_MS = 3_000;
const SECRET = 'hook-signing-secret-for-e2e';

type ModelCall = { prompt: string; startedAt: number; endedAt?: number };
type Callback = { path: string; reply: string; sessionId: string };

let dir: string;
let server: ChildProcess;
let serverLog = '';
let model: Server;
let receiver: Server;
let baseUrl: string;
let callbackOrigin: string;
let client: ManagedAgentClient;
let workspaceId: string;
let inFlight = 0;
let peak = 0;
const calls: ModelCall[] = [];
const callbacks: Callback[] = [];

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
  });
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
  const created = createServer(handler);
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  return { server: created, origin: `http://127.0.0.1:${(created.address() as { port: number }).port}` };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitFor(what: string, done: () => boolean, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}; server log:\n${serverLog.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function hook(externalKey: string, prompt: string, callbackPath: string, eventId: string): Promise<void> {
  const body = JSON.stringify({ prompt, callbackUrl: `${callbackOrigin}${callbackPath}`, eventId });
  const timestamp = Date.now();
  const response = await fetch(`${baseUrl}/ingress/v1/${workspaceId}/${externalKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ma-timestamp': String(timestamp),
      'x-ma-signature': hmacSha256Hex(SECRET, `${timestamp}.${body}`),
    },
    body,
  });
  const text = await response.text();
  assert.ok(response.ok, `ingress answered ${response.status}: ${text}`);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ma-parallel-e2e-'));

  ({ server: model } = await listen(async (request, response) => {
    const payload = JSON.parse(await readBody(request)) as { messages: { role: string; content: unknown }[] };
    const user = [...payload.messages].reverse().find((message) => message.role === 'user');
    const call: ModelCall = { prompt: String(user?.content ?? ''), startedAt: Date.now() };
    calls.push(call);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, MODEL_DELAY_MS));
    inFlight--;
    call.endedAt = Date.now();
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'gen-e2e',
        choices: [{ index: 0, message: { role: 'assistant', content: `echo: ${call.prompt}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    );
  }));
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`;

  const received = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { reply?: string; sessionId: string };
    callbacks.push({ path: request.url ?? '', reply: body.reply ?? '', sessionId: body.sessionId });
    response.writeHead(204).end();
  });
  receiver = received.server;
  callbackOrigin = received.origin;

  const port = await freePort();
  const token = randomToken(32);
  server = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      MA_DATABASE: join(dir, 'ma.db'),
      MA_HOST: '127.0.0.1',
      MA_PORT: String(port),
      MA_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
      MA_ARTIFACT_ROOT: join(dir, 'artifacts'),
      MA_LOG_LEVEL: 'warn',
      MA_BOOTSTRAP_TOKEN: token,
      MA_OPENROUTER_API_KEY: 'e2e-key',
      MA_OPENROUTER_BASE_URL: `${modelOrigin}/api/v1`,
      MA_OPENROUTER_MODELS: MODEL,
      MA_SANDBOX_DRIVER: 'local',
      MA_SCHEDULER_TICK_MS: '100',
      MA_DELIVERY_CONCURRENCY: '3',
      MA_HOOK_CALLBACK_ORIGINS: callbackOrigin,
      MA_RATE_LIMIT: '100000',
      MA_RATE_LIMIT_IP: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  baseUrl = await new Promise<string>((resolve, reject) => {
    server.stderr!.on('data', (chunk: Buffer) => {
      serverLog += chunk.toString();
      const match = /listening on (http:\/\/[^\s]+)/.exec(serverLog);
      if (match) resolve(match[1]!);
    });
    server.once('exit', (code) => reject(new Error(`the server exited (${code}) before listening:\n${serverLog}`)));
  });

  client = new ManagedAgentClient({ baseUrl, token, clock: systemClock });
  const { workspace } = await client.createWorkspace({ name: 'Parallel', slug: 'parallel-e2e' });
  workspaceId = workspace.id;
  const { agent } = await client.createAgent(workspaceId, {
    name: 'Echo',
    spec: { systemPrompt: 'Echo the request.', model: { modelId: MODEL } },
  });
  const { credential } = await client.createCredential(workspaceId, {
    ownerType: 'workspace',
    type: 'api_key',
    name: 'hook secret',
    value: SECRET,
  });
  for (const [externalKey, sessionPolicy] of [
    ['parallel', 'new_per_event'],
    ['ordered', 'reuse_per_scope'],
  ] as const) {
    const connector = await client.createConnector(workspaceId, {
      type: 'hook',
      name: externalKey,
      externalKey,
      agentId: agent.id,
      sessionPolicy,
      secretCredentialId: credential.id,
    });
    await client.activateConnector(connector.id);
  }
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  server?.kill('SIGKILL');
  await new Promise<void>((resolve) => model?.close(() => resolve()));
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('connector delivery on a real server', () => {
  test('deliveries to three conversations are answered side by side, each to its own caller', async () => {
    const names = ['alpha', 'bravo', 'charlie'];
    await Promise.all(names.map((name) => hook('parallel', `say ${name}`, `/cb/${name}`, `evt-${name}`)));
    await waitFor('three callbacks', () => callbacks.filter((c) => c.path.startsWith('/cb/') && c.path !== '/cb/thread').length === 3);

    assert.equal(peak, 3, `the model had at most ${peak} of the three calls in flight at once`);
    for (const name of names) {
      const callback = callbacks.find((c) => c.path === `/cb/${name}`);
      assert.equal(callback?.reply, `echo: say ${name}`, `the reply for ${name} reached ${name}'s callback`);
    }
    assert.equal(new Set(names.map((name) => callbacks.find((c) => c.path === `/cb/${name}`)?.sessionId)).size, 3);
  });

  test('one conversation still gets its events one at a time, in order, on one session', async () => {
    await hook('ordered', 'first in thread', '/cb/thread', 'evt-thread-1');
    await hook('ordered', 'second in thread', '/cb/thread', 'evt-thread-2');
    await waitFor('both thread callbacks', () => callbacks.filter((c) => c.path === '/cb/thread').length === 2);

    const thread = callbacks.filter((c) => c.path === '/cb/thread');
    assert.deepEqual(thread.map((c) => c.reply), ['echo: first in thread', 'echo: second in thread']);
    assert.equal(thread[0]!.sessionId, thread[1]!.sessionId, 'one conversation, one session');

    const first = calls.find((call) => call.prompt === 'first in thread')!;
    const second = calls.find((call) => call.prompt === 'second in thread')!;
    assert.ok(second.startedAt >= first.endedAt!, 'the second turn did not start until the first was answered');

    const { events } = await client.readEvents(thread[0]!.sessionId, { types: ['turn.started'] });
    const submissions = events.map((event) => (event.payload as { submissionId?: string }).submissionId);
    assert.equal(submissions.length, 2);
    assert.ok(submissions.every((id) => /^su_/.test(id ?? '')), `each turn names its submission: ${submissions.join(', ')}`);
    assert.notEqual(submissions[0], submissions[1]);
  });
});
