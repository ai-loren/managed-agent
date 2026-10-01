/**
 * A real server process for end-to-end tests, with a stand-in model.
 *
 * The server runs as its own process on the local sandbox driver, so every
 * session gets a real agent-core; the model is an OpenRouter-shaped server that
 * answers `echo: <prompt>` and records each call. Restartable on the same
 * database, for tests about what survives a restart.
 */

import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomToken, systemClock } from '@ma/core';
import { ManagedAgentClient } from '@ma/sdk';

const SERVER = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
export const MODEL = 'e2e/echo:free';

export interface ModelCall {
  prompt: string;
  startedAt: number;
  endedAt?: number;
}

export class EchoModel {
  readonly calls: ModelCall[] = [];
  delayMs = 0;
  #server: Server | undefined;
  origin = '';

  async start(): Promise<void> {
    this.#server = createServer(async (request, response) => {
      const payload = JSON.parse(await readBody(request)) as { messages: { role: string; content: unknown }[] };
      const user = [...payload.messages].reverse().find((message) => message.role === 'user');
      const call: ModelCall = { prompt: String(user?.content ?? ''), startedAt: Date.now() };
      this.calls.push(call);
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      call.endedAt = Date.now();
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'gen-e2e',
          choices: [{ index: 0, message: { role: 'assistant', content: `echo: ${call.prompt}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }),
      );
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as { port: number }).port}`;
  }

  prompts(): string[] {
    return this.calls.map((call) => call.prompt);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

export class LiveServer {
  readonly dir = mkdtempSync(join(tmpdir(), 'ma-live-'));
  readonly token = randomToken(32);
  readonly metricsToken = randomToken(32);
  log = '';
  baseUrl = '';
  client!: ManagedAgentClient;
  #process: ChildProcess | undefined;
  #port = 0;
  readonly #env: Record<string, string>;

  constructor(model: EchoModel, env: Record<string, string>) {
    this.#env = {
      MA_OPENROUTER_API_KEY: 'e2e-key',
      MA_OPENROUTER_BASE_URL: `${model.origin}/api/v1`,
      MA_OPENROUTER_MODELS: MODEL,
      ...env,
    };
  }

  async start(): Promise<void> {
    this.#port ||= await freePort();
    this.log = '';
    const child = spawn(process.execPath, [SERVER], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: this.dir,
        MA_DATABASE: join(this.dir, 'ma.db'),
        MA_HOST: '127.0.0.1',
        MA_PORT: String(this.#port),
        MA_CONTROL_PLANE_URL: `http://127.0.0.1:${this.#port}`,
        MA_ARTIFACT_ROOT: join(this.dir, 'artifacts'),
        MA_LOG_LEVEL: 'info',
        MA_BOOTSTRAP_TOKEN: this.token,
        MA_METRICS_TOKEN: this.metricsToken,
        MA_SANDBOX_DRIVER: 'local',
        MA_SCHEDULER_TICK_MS: '200',
        MA_RATE_LIMIT: '100000',
        MA_RATE_LIMIT_IP: '100000',
        ...this.#env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#process = child;
    child.stdout!.on('data', (chunk: Buffer) => (this.log += chunk.toString()));
    this.baseUrl = await new Promise<string>((resolve, reject) => {
      child.stderr!.on('data', (chunk: Buffer) => {
        this.log += chunk.toString();
        const match = /listening on (http:\/\/[^\s]+)/.exec(this.log);
        if (match) resolve(match[1]!);
      });
      child.once('exit', (code) => reject(new Error(`the server exited (${code}) before listening:\n${this.log}`)));
    });
    this.client = new ManagedAgentClient({ baseUrl: this.baseUrl, token: this.token, clock: systemClock });
  }

  /** SIGTERM, and wait for the process to finish shutting down. */
  async stop(): Promise<void> {
    const child = this.#process;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    await exited;
    clearTimeout(timer);
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** A counter from /metrics, summed over series whose labels include `labels`. */
  async metric(name: string, labels: Record<string, string> = {}): Promise<number> {
    const response = await fetch(`${this.baseUrl}/metrics`, { headers: { authorization: `Bearer ${this.metricsToken}` } });
    const text = await response.text();
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`))) {
        total += Number(line.slice(line.lastIndexOf(' ') + 1));
      }
    }
    return total;
  }
}

export async function waitFor(what: string, done: () => boolean | Promise<boolean>, timeoutMs = 90_000, log?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}${log ? `; server log:\n${log().slice(-6000)}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export function run(command: string, args: string[], input?: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

export async function must(command: string, args: string[], input?: string, timeoutMs?: number): Promise<string> {
  const result = await run(command, args, input, timeoutMs);
  if (result.code !== 0) assert.fail(`${command} ${args.join(' ')} failed (${result.code}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
  });
}
