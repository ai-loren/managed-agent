/**
 * Local-driver egress enforcement against a real server process.
 *
 * The server runs with `MA_LOCAL_EGRESS=enforce`. The stand-in model has the
 * agent run one shell command — fetch a service listening on this host — and
 * then report what came back. An agent with the default (restricted) egress
 * policy must not get through, while its turn still completes, which proves
 * agent-core kept its own line to the control plane; an agent that allows
 * egress gets through. On a Linux host that cannot make unprivileged network
 * namespaces, the restricted agent must be refused rather than run open.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomToken, systemClock } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';

const SERVER = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const MODEL = 'e2e/tool-runner:free';
const confinable =
  process.platform === 'darwin' ||
  (process.platform === 'linux' && spawnSync('unshare', ['--net', '--map-root-user', 'true']).status === 0);

let dir: string;
let server: ChildProcess;
let serverLog = '';
let model: Server;
let hostService: Server;
let hostPort: number;
let client: ManagedAgentClient;
let workspaceId: string;

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
  dir = mkdtempSync(join(tmpdir(), 'ma-egress-e2e-'));

  hostService = createServer((_request, response) => response.end('host-service-says-hello'));
  await new Promise<void>((resolve) => hostService.listen(0, '127.0.0.1', resolve));
  hostPort = (hostService.address() as { port: number }).port;

  // First answer: run the command. Once a tool result is in the conversation,
  // report it verbatim, so the event log shows what the command got.
  model = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
      const toolResult = payload.messages.find((message) => message.role === 'tool');
      const message = toolResult
        ? { role: 'assistant', content: `tool said: ${String(toolResult.content)}` }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_fetch',
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: `curl -s -m 5 http://127.0.0.1:${hostPort}/` }) },
              },
            ],
          };
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'gen-e2e',
          choices: [{ index: 0, message, finish_reason: toolResult ? 'stop' : 'tool_calls' }],
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
      MA_LOCAL_EGRESS: 'enforce',
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
  workspaceId = (await client.createWorkspace({ name: 'Egress', slug: 'egress-e2e' })).workspace.id;
});

after(async () => {
  server?.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  server?.kill('SIGKILL');
  await new Promise<void>((resolve) => model?.close(() => resolve()));
  await new Promise<void>((resolve) => hostService?.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

/** Run one turn for a new agent with this network policy; the answer, or the reason the session failed. */
async function runTurn(name: string, network: Record<string, unknown> | undefined): Promise<{ answer?: string; failure?: string }> {
  const { agent } = await client.createAgent(workspaceId, {
    name,
    spec: { model: { modelId: MODEL }, tools: { mode: 'auto' }, ...(network ? { sandbox: { network } } : {}) },
  });
  const { session } = await client.createSession({ agentId: agent.id });
  const settled = await waitFor(
    `${name}'s session to start`,
    async () => (await client.getSession(session.id)).session,
    (value) => value.status === 'ready' || value.status === 'failed',
  );
  if (settled.status === 'failed') return { failure: `${settled.error?.code}: ${settled.error?.message}` };

  await client.prompt(session.id, 'fetch the host service');
  const events = await waitFor(
    `${name}'s turn to complete`,
    async () => (await client.readEvents(session.id, { limit: 1000 })).events,
    (all) => all.some((event) => event.type === 'turn.completed' || event.type === 'turn.failed'),
  );
  const answer = events
    .filter((event) => event.type === 'message.completed' && (event.payload as { role?: string }).role === 'assistant')
    .map((event) => (event.payload as { text: string }).text)
    .at(-1);
  return answer === undefined ? {} : { answer };
}

describe('local-driver egress enforcement on a real server', () => {
  test('an agent that allows egress reaches the host service', async () => {
    const open = await runTurn('Open', { egress: 'allow', allowedHosts: [] });
    assert.match(open.answer ?? '', /tool said: .*host-service-says-hello/s);
  });

  test('an agent with the default restricted policy does not, and its turn still completes', async () => {
    const confined = await runTurn('Confined', undefined);
    if (!confinable) {
      assert.match(confined.failure ?? '', /SANDBOX_EGRESS_UNENFORCEABLE: .*unprivileged network namespaces/);
      return;
    }
    assert.equal(confined.failure, undefined);
    // curl's exit 7 is "could not connect": the command ran and the network refused it.
    assert.match(confined.answer ?? '', /^tool said: Exit code 7/, 'the turn reached the model a second time, over the control plane');
    assert.doesNotMatch(confined.answer ?? '', /host-service-says-hello/);
  });
});
