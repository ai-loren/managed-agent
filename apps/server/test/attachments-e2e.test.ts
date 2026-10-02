/**
 * Files handed to an agent, through a real server process.
 *
 * Each session runs a real agent-core on the local driver, against a stand-in
 * Anthropic that makes the tool call it is asked for and quotes what came back.
 * A person uploads a CSV and a binary file and attaches both to one message:
 * the agent reads the CSV where its prompt says it is, the binary arrives byte
 * for byte, a rebuilt sandbox has both again, and a file from another workspace
 * cannot be attached at all.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError } from '@ma/core';
import type { SessionEvent } from '@ma/contracts';

import { EchoModel, LiveServer, waitFor } from './support/live-server.ts';
import { ProviderFakes } from './support/provider-fakes.ts';

const MODEL = 'anthropic/claude-sonnet-4-5';
const OTHER_MODEL = 'anthropic/claude-haiku-4-5';
const CSV = 'region,total\nnorth,10\nsouth,7\n';

let fakes: ProviderFakes;
let echo: EchoModel;
let server: LiveServer;
let dir: string;
let workspaceId = '';
let agentId = '';

function serverLog(): string {
  return server.log
    .split('\n')
    .filter((line) => !/"method":"GET","path":"\/v1\/(sessions|workspaces)\//.test(line))
    .join('\n');
}

async function events(sessionId: string, types?: string[]): Promise<SessionEvent[]> {
  return (await server.client.readEvents(sessionId, { limit: 500, ...(types ? { types } : {}) })).events;
}

async function readySession(agent = agentId): Promise<string> {
  const { session } = await server.client.createSession({ agentId: agent });
  await waitFor('the session to be ready', async () => (await server.client.getSession(session.id)).session.status === 'ready', 90_000, serverLog);
  return session.id;
}

/** The agent's answer to the latest prompt: the first `RESULT:` after `afterSeq`. */
async function answer(sessionId: string, afterSeq: number): Promise<string> {
  let text = '';
  await waitFor(
    'the agent to answer',
    async () => {
      const completed = (await events(sessionId, ['message.completed'])).filter((event) => event.seq > afterSeq);
      text = String(completed.map((event) => (event.payload as { text?: string }).text ?? '').find((said) => said.startsWith('RESULT:')) ?? '');
      return text.length > 0;
    },
    90_000,
    serverLog,
  );
  return text;
}

async function lastSeq(sessionId: string): Promise<number> {
  return (await server.client.readEvents(sessionId, { limit: 1, order: 'desc' })).events[0]?.seq ?? 0;
}

const call = (tool: string, args: Record<string, unknown>): string => `CALL ${tool} ${JSON.stringify(args)}`;

describe('handing an agent files on a real server', () => {
  let sessionId = '';
  let binary: Uint8Array;
  let csvId = '';
  let binaryId = '';

  before(async () => {
    fakes = new ProviderFakes();
    await fakes.start();
    fakes.models.anthropic.add('claude-sonnet-4-5');
    fakes.models.anthropic.add('claude-haiku-4-5');
    echo = new EchoModel();
    await echo.start();
    dir = mkdtempSync(join(tmpdir(), 'ma-attachments-e2e-'));
    server = new LiveServer(echo, {
      ...fakes.env(dir, { anthropic: 'claude-sonnet-4-5@3/15/0.3/3.75,claude-haiku-4-5@1/5/0.1/1.25' }),
      MA_SANDBOX_LEASE_SECONDS: '120',
      MA_ARTIFACT_MAX_MB: '1',
    });
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'Files', slug: 'attachments-e2e' });
    workspaceId = workspace.id;
    const { agent } = await server.client.createAgent(workspaceId, {
      name: 'Analyst',
      spec: { systemPrompt: 'Work on the files you are given.', model: { modelId: MODEL }, tools: { mode: 'auto' } },
    });
    agentId = agent.id;
    sessionId = await readySession();
  });

  after(async () => {
    await server?.dispose();
    await echo?.stop();
    await fakes?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('an attached CSV is in the working directory, and the agent reads it where its prompt says', async () => {
    const csv = (await server.client.uploadFile(sessionId, 'sales.csv', new TextEncoder().encode(CSV))).artifact;
    binary = new Uint8Array(randomBytes(4096));
    binary[0] = 0;
    const bin = (await server.client.uploadFile(sessionId, 'blob.bin', binary)).artifact;
    csvId = csv.id;
    binaryId = bin.id;
    assert.deepEqual([csv.path, csv.contentType, bin.path, bin.contentType], ['sales.csv', 'text/plain; charset=utf-8', 'blob.bin', 'application/octet-stream']);

    const before = await lastSeq(sessionId);
    await server.client.prompt(sessionId, call('read_file', { path: 'attachments/sales.csv' }), { attachments: [csv.id, bin.id] });
    const said = await answer(sessionId, before);
    assert.ok(said.includes('region,total') && said.includes('north,10') && said.includes('south,7'), said);

    const asked = fakes.calls.find((made) => made.turns.some((turn) => turn.role === 'user' && turn.text.includes('Files attached to this message')));
    assert.ok(asked, 'the model was told about the files');
    const prompt = asked.turns.filter((turn) => turn.role === 'user').at(-1)!.text;
    assert.match(prompt, /- attachments\/sales\.csv \(text\/plain; charset=utf-8, 30 bytes\)/);
    assert.match(prompt, /- attachments\/blob\.bin \(application\/octet-stream, 4\.0 KB\)/);

    const logged = (await events(sessionId, ['message.completed'])).find((event) => (event.payload as { role?: string }).role === 'user');
    assert.deepEqual((logged!.payload as { attachments?: unknown }).attachments, [
      { artifactId: csv.id, name: 'sales.csv', sizeBytes: 30, contentType: 'text/plain; charset=utf-8' },
      { artifactId: bin.id, name: 'blob.bin', sizeBytes: 4096, contentType: 'application/octet-stream' },
    ]);
  });

  /** What the agent's shell says the binary's SHA-256 is. */
  async function binaryDigestInSandbox(): Promise<string> {
    const before = await lastSeq(sessionId);
    await server.client.prompt(sessionId, call('bash', { command: 'shasum -a 256 attachments/blob.bin' }));
    return answer(sessionId, before);
  }

  test('a binary file arrives byte for byte', async () => {
    const said = await binaryDigestInSandbox();
    assert.ok(said.includes(createHash('sha256').update(binary).digest('hex')), said);
  });

  test('a rebuilt sandbox has the files again, where the conversation says they are', async () => {
    const { session } = await server.client.setSessionModel(sessionId, OTHER_MODEL);
    assert.equal(session.modelOverride, OTHER_MODEL);
    const changed = (await events(sessionId, ['session.model_changed'])).at(-1)!.payload as { rebound: boolean };
    assert.equal(changed.rebound, true, 'the sandbox was rebuilt in place');

    const before = await lastSeq(sessionId);
    await server.client.prompt(sessionId, call('read_file', { path: 'attachments/sales.csv' }));
    const said = await answer(sessionId, before);
    assert.ok(said.includes('north,10'), said);
    assert.ok((await binaryDigestInSandbox()).includes(createHash('sha256').update(binary).digest('hex')));
  });

  test('a file from another workspace cannot be attached', async () => {
    const { workspace } = await server.client.createWorkspace({ name: 'Elsewhere', slug: 'attachments-e2e-other' });
    const { agent } = await server.client.createAgent(workspace.id, { name: 'Other', spec: { model: { modelId: MODEL } } });
    const { session: theirs } = await server.client.createSession({ agentId: agent.id });
    const foreign = (await server.client.uploadFile(theirs.id, 'secret.txt', new TextEncoder().encode('not for you'))).artifact;

    await assert.rejects(
      server.client.prompt(sessionId, 'read their file', { attachments: [foreign.id] }),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.status, 400);
        assert.match(error.message, /is not an artifact in this session's workspace/);
        return true;
      },
    );
    await assert.rejects(
      server.client.prompt(sessionId, 'read one that was never uploaded', { attachments: ['ar_00000000000000000000000000'] }),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('an upload over the file limit is refused before it is stored', async () => {
    await assert.rejects(server.client.uploadFile(sessionId, 'huge.bin', new Uint8Array(1024 * 1024 + 1)), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
      assert.match(error.message, /exceeds the 1048576 bytes this endpoint accepts/);
      return true;
    });
    const page = await server.client.listArtifacts(workspaceId, { sessionId });
    assert.deepEqual(page.items.map((artifact) => artifact.id).sort(), [csvId, binaryId].sort());
  });
});
