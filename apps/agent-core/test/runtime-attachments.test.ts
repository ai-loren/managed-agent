/**
 * A turn's attached files, as both runtimes handle them: in the working
 * directory before the turn starts, named in its prompt, and the runtime busy
 * the whole time they are fetched.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId, nullLogger } from '@ma/core';
import { agentVersionSchema, parseOrThrow } from '@ma/contracts';

import type { AttachedFile } from '../src/attachments.ts';
import { buildCommandRuntime, buildSession, type ControlPlane, type Runtime } from '../src/main.ts';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 };
const CONFIG = { sandboxId: 'sb_test', workspaceId: 'ws_test', controlPlaneUrl: 'http://127.0.0.1:1', token: 'tok', port: 0, host: '127.0.0.1' };

function file(name: string, content: string): { file: AttachedFile; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(content);
  return {
    file: {
      artifactId: newId('artifact'),
      name,
      digest: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      contentType: 'text/plain; charset=utf-8',
    },
    bytes,
  };
}

function bootstrap(overrides: Record<string, unknown>): Record<string, unknown> {
  const version = parseOrThrow(agentVersionSchema, {
    agentId: newId('agent'),
    version: 1,
    model: { modelId: 'test/model' },
    tools: { mode: 'strict', allow: ['read_file'] },
    createdAt: 0,
    createdBy: 'test',
  });
  return {
    sessionId: newId('session'),
    systemPrompt: 'You work on files.',
    model: version.model,
    tools: version.tools,
    context: version.context,
    runtime: version.runtime,
    subAgents: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    maxTurnsPerSession: 10,
    turnTimeoutSeconds: 30,
    setupCommands: [],
    fileCredentials: [],
    envCredentials: [],
    datasetIds: [],
    attachments: [],
    ...overrides,
  };
}

type Message = { role: string; content: string };

/** The control plane, as a sandbox sees it, serving `files` and answering model calls with `answers`. */
function controlPlane(
  boot: Record<string, unknown>,
  files: Map<string, Uint8Array>,
  answers: { text: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
): { control: ControlPlane; fetched: string[]; requests: Message[][]; gate: { hold(): () => void } } {
  const fetched: string[] = [];
  const requests: Message[][] = [];
  let held: Promise<void> | undefined;
  return {
    fetched,
    requests,
    gate: {
      hold() {
        let release = (): void => {};
        held = new Promise((resolve) => {
          release = resolve;
        });
        return () => {
          held = undefined;
          release();
        };
      },
    },
    control: {
      bootstrap: () => Promise.resolve(boot),
      fetchAttachment: async (artifactId: string) => {
        fetched.push(artifactId);
        await held;
        const bytes = files.get(artifactId);
        if (!bytes) throw new Error(`no attachment ${artifactId}`);
        return bytes;
      },
      appendEvents: () => Promise.resolve({ accepted: 0, lastSeq: 0 }),
      saveSnapshot: () => Promise.resolve({ stored: true }),
      complete: (request: { messages: Message[] }) => {
        requests.push(request.messages.map(({ role, content }) => ({ role, content })));
        const answer = answers.shift() ?? { text: 'done' };
        return Promise.resolve({
          text: answer.text,
          ...(answer.toolCalls ? { toolCalls: answer.toolCalls } : {}),
          stopReason: answer.toolCalls ? 'tool_use' : 'end_turn',
          usage: USAGE,
        });
      },
    } as unknown as ControlPlane,
  };
}

const runtimes: Runtime[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the built-in runtime', () => {
  test('a turn runs after its files are in place, told where they are, and is busy meanwhile', async () => {
    const earlier = file('earlier.txt', 'attached two turns ago');
    const sales = file('sales.csv', 'region,total\nnorth,10\n');
    const boot = bootstrap({ attachments: [earlier.file] });
    const plane = controlPlane(
      boot,
      new Map([
        [earlier.file.artifactId, earlier.bytes],
        [sales.file.artifactId, sales.bytes],
      ]),
      [{ text: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'attachments/sales.csv' } }] }, { text: 'north sold 10' }],
    );

    const runtime = (await buildSession(plane.control, CONFIG as never, nullLogger))!;
    runtimes.push(runtime);
    assert.deepEqual(plane.fetched, [earlier.file.artifactId], 'files attached before are put back when it is built');

    const release = plane.gate.hold();
    const turn = runtime.runTurn('Total the sales.', { attachments: [sales.file] });
    assert.equal(runtime.running, true, 'busy from the moment the turn is accepted');
    await Promise.resolve();
    assert.equal(runtime.running, true, 'and while its files are fetched');
    assert.equal(plane.requests.length, 0, 'the model is not asked before the files are in place');
    release();
    await turn;
    assert.equal(runtime.running, false);

    const prompt = plane.requests[0]!.at(-1)!;
    assert.equal(prompt.role, 'user');
    assert.equal(
      prompt.content,
      'Total the sales.\n\nFiles attached to this message, relative to the working directory:\n' +
        '- attachments/sales.csv (text/plain; charset=utf-8, 22 bytes)',
    );
    assert.match(plane.requests[1]!.at(-1)!.content, /region,total\nnorth,10/, 'the agent read the file where it was told');
  });

  test('a turn stopped while its files are fetched does not start', async () => {
    const big = file('big.txt', 'never needed');
    const plane = controlPlane(bootstrap({}), new Map([[big.file.artifactId, big.bytes]]), []);
    const runtime = (await buildSession(plane.control, CONFIG as never, nullLogger))!;
    runtimes.push(runtime);

    const release = plane.gate.hold();
    const turn = runtime.runTurn('Read it.', { attachments: [big.file] });
    runtime.interrupt();
    release();
    await assert.rejects(turn);
    assert.equal(runtime.running, false);
    assert.equal(plane.requests.length, 0);
  });
});

describe('the command runtime', () => {
  test('the process starts with its files in place and the prompt saying where, busy until then', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ma-command-out-'));
    dirs.push(out);
    const earlier = file('agenda.txt', 'attached last week');
    const notes = file('notes.txt', 'meeting at noon');
    const script = [
      "const fs = require('node:fs');",
      "let prompt = '';",
      "process.stdin.on('data', (chunk) => (prompt += chunk));",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.OUT + '/prompt.txt', prompt);",
      "  fs.copyFileSync('attachments/notes.txt', process.env.OUT + '/notes.txt');",
      "  fs.copyFileSync('attachments/agenda.txt', process.env.OUT + '/agenda.txt');",
      '});',
    ].join('\n');
    const boot = bootstrap({
      runtime: { type: 'command', command: process.execPath, args: ['-e', script], env: { OUT: out } },
      attachments: [earlier.file],
    });
    const plane = controlPlane(
      boot,
      new Map([
        [earlier.file.artifactId, earlier.bytes],
        [notes.file.artifactId, notes.bytes],
      ]),
      [],
    );
    const runtime = await buildCommandRuntime(boot as never, CONFIG as never, nullLogger, plane.control);
    runtimes.push(runtime);
    assert.deepEqual(plane.fetched, [earlier.file.artifactId], 'files attached before are put back when it is built');

    const release = plane.gate.hold();
    const turn = runtime.runTurn('Summarise the notes.', { attachments: [notes.file] });
    assert.equal(runtime.running, true, 'busy while its files are fetched');
    await Promise.resolve();
    assert.equal(runtime.running, true);
    release();
    await turn;
    assert.equal(runtime.running, false);

    assert.equal(
      await readFile(join(out, 'prompt.txt'), 'utf8'),
      'Summarise the notes.\n\nFiles attached to this message, relative to the working directory:\n' +
        '- attachments/notes.txt (text/plain; charset=utf-8, 15 bytes)',
    );
    assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), 'meeting at noon');
    assert.equal(await readFile(join(out, 'agenda.txt'), 'utf8'), 'attached last week');
  });
});
