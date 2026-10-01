/**
 * Resubmitting an interrupted turn, against a real server process.
 *
 * The server runs with the local driver and a short sandbox lease, so a killed
 * agent-core is noticed within a couple of ticks. The stand-in model never
 * answers the first call, which holds the turn open; the test then kills the
 * sandbox's agent-core process outright, as an eviction or an OOM kill would.
 * With `resubmitInterruptedTurn` the session must come back on a new sandbox,
 * send the same prompt again and finish the turn — with the interruption and
 * the resubmission both on the record.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomToken, systemClock } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';
import type { SessionEvent } from '@ma/contracts';

const SERVER = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const MODEL = 'e2e/echo:free';

let dir: string;
let server: ChildProcess;
let serverLog = '';
let model: Server;
let client: ManagedAgentClient;
let workspaceId: string;
let modelCalls = 0;
const held: ServerResponse[] = [];

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

/** The agent-core processes the server has spawned, by pid. */
function agentCores(): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(server.pid), '-f', 'agent-core'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ma-resubmit-e2e-'));

  model = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      modelCalls++;
      // The first call is the turn that gets cut off: never answer it.
      if (modelCalls === 1) {
        held.push(response);
        return;
      }
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
      MA_DATABASE: join(dir, 'ma.db'),
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
      MA_SANDBOX_LEASE_SECONDS: '2',
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
  workspaceId = (await client.createWorkspace({ name: 'Resubmit', slug: 'resubmit-e2e' })).workspace.id;
});

after(async () => {
  for (const response of held) response.destroy();
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  server?.kill('SIGKILL');
  await new Promise<void>((resolve) => model?.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('resubmitting an interrupted turn on a real server', () => {
  test('a turn whose sandbox is killed mid-turn is sent again on a new sandbox and finishes', async () => {
    const { agent } = await client.createAgent(workspaceId, {
      name: 'Resubmitter',
      spec: { systemPrompt: 'Echo.', model: { modelId: MODEL }, resubmitInterruptedTurn: true },
    });
    const { session } = await client.createSession({ agentId: agent.id });
    const ready = await waitFor(
      'the session to be ready',
      async () => (await client.getSession(session.id)).session,
      (value) => value.status === 'ready' || value.status === 'failed',
    );
    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

    const { submissionId: first } = await client.prompt(session.id, 'do the thing');
    await waitFor('the first model call to be in flight', () => modelCalls, (calls) => calls >= 1);
    const victims = agentCores();
    assert.equal(victims.length, 1, `expected one agent-core child, found ${victims.join(', ')}`);
    process.kill(victims[0]!, 'SIGKILL');

    const events = await waitFor(
      'the resubmitted turn to complete',
      async () => (await client.readEvents(session.id, { limit: 1000 })).events,
      (all) => all.some((event) => event.type === 'turn.completed'),
    ).catch(async (error: unknown) => {
      const { events: log } = await client.readEvents(session.id, { limit: 1000 });
      const now = (await client.getSession(session.id)).session;
      throw new Error(
        `${String(error)}\nmodel calls: ${modelCalls}\nsession: ${JSON.stringify({ status: now.status, sandboxId: now.sandboxId, pendingResubmit: now.pendingResubmit })}\n` +
          log.map((event) => `${event.seq} ${event.type} ${JSON.stringify(event.payload).slice(0, 200)}`).join('\n'),
      );
    });

    const byType = (type: string): SessionEvent[] => events.filter((event) => event.type === type);
    const failure = byType('turn.failed')[0]?.payload as { error: { code: string; details: { resubmit?: boolean } } } | undefined;
    assert.equal(failure?.error.code, 'SANDBOX_LOST');
    assert.equal(failure?.error.details.resubmit, true);
    // The killed process may not have reported its turn.started before it died;
    // the resubmitted turn's is always there, under a submission of its own.
    const starts = byType('turn.started').map((event) => (event.payload as { submissionId?: string }).submissionId);
    const resubmitted = starts.at(-1);
    assert.match(resubmitted ?? '', /^su_/);
    assert.notEqual(resubmitted, first, 'the resubmission is a submission of its own');
    assert.ok(starts.length === 1 || (starts.length === 2 && starts[0] === first), `turn.started ids: ${starts.join(', ')}`);
    const prompts = byType('message.completed').filter((event) => (event.payload as { role?: string }).role === 'user');
    assert.deepEqual(prompts.map((event) => (event.payload as { text: string }).text), ['do the thing', 'do the thing']);
    assert.ok(
      byType('message.completed').some((event) => (event.payload as { text?: string }).text === 'echo: do the thing'),
      'the resubmitted turn answered',
    );
    assert.equal(modelCalls, 2);
    assert.notEqual((await client.getSession(session.id)).session.sandboxId, ready.sandboxId, 'on a new sandbox');
  });
});
