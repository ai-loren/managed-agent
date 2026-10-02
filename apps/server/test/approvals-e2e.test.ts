/**
 * Human approval of tool calls, through a real server process.
 *
 * Each session runs in a real agent-core on the local driver, against a
 * stand-in Anthropic that asks for `write_file` and then quotes what the call
 * returned. The agent's policy is `prompt`, so the call waits for a person:
 * approved it runs, denied the agent reads the reason, unanswered it is denied
 * when its time is up — and a control plane that crashes while the call waits
 * comes back to find it still waiting, with the sandbox reconnected to it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Approval, SessionEvent } from '@ma/contracts';

import { EchoModel, LiveServer, waitFor } from './support/live-server.ts';
import { ProviderFakes } from './support/provider-fakes.ts';

const MODEL = 'anthropic/claude-sonnet-4-5';

let fakes: ProviderFakes;
let echo: EchoModel;
let server: LiveServer;
let dir: string;
let workspaceId = '';
let agentId = '';
const strays: number[] = [];

/** The server's log without this test's own polling, which would bury everything else. */
function serverLog(): string {
  return server.log
    .split('\n')
    .filter((line) => !/"method":"GET","path":"\/v1\/(sessions|workspaces)\//.test(line))
    .join('\n');
}

async function events(sessionId: string, types?: string[]): Promise<SessionEvent[]> {
  return (await server.client.readEvents(sessionId, { limit: 500, ...(types ? { types } : {}) })).events;
}

async function readySession(): Promise<string> {
  const { session } = await server.client.createSession({ agentId });
  await waitFor('the session to be ready', async () => (await server.client.getSession(session.id)).session.status === 'ready', 90_000, serverLog);
  return session.id;
}

async function pendingApproval(sessionId: string): Promise<Approval> {
  let found: Approval | undefined;
  await waitFor(
    'the call to wait for approval',
    async () => {
      found = (await server.client.listApprovals(sessionId, { statuses: ['pending'] })).items[0];
      return found !== undefined;
    },
    60_000,
    serverLog,
  );
  return found!;
}

async function answer(sessionId: string): Promise<string> {
  let text = '';
  await waitFor(
    'the agent to answer',
    async () => {
      const completed = await events(sessionId, ['message.completed']);
      text = String((completed.at(-1)?.payload as { text?: string } | undefined)?.text ?? '');
      return text.startsWith('RESULT:');
    },
    90_000,
    serverLog,
  );
  return text;
}

const ASK = (file: string): string => `CALL write_file {"path":"${file}","content":"approved content"}`;

describe('approving tool calls on a real server', () => {
  before(async () => {
    fakes = new ProviderFakes();
    await fakes.start();
    fakes.models.anthropic.add('claude-sonnet-4-5');
    echo = new EchoModel();
    await echo.start();
    dir = mkdtempSync(join(tmpdir(), 'ma-approvals-e2e-'));
    server = new LiveServer(echo, { ...fakes.env(dir, { anthropic: 'claude-sonnet-4-5@3/15/0.3/3.75' }), MA_SANDBOX_LEASE_SECONDS: '120' });
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'Approvals', slug: 'approvals-e2e' });
    workspaceId = workspace.id;
    const { agent } = await server.client.createAgent(workspaceId, {
      name: 'Careful',
      spec: { systemPrompt: 'Ask before writing.', model: { modelId: MODEL }, tools: { mode: 'prompt', approvalTimeoutSeconds: 10 } },
    });
    agentId = agent.id;
  });

  after(async () => {
    for (const pid of strays) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await server?.dispose();
    await echo?.stop();
    await fakes?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('approved, the call runs; the request and the decision are on the session log and in the audit trail', async () => {
    const sessionId = await readySession();
    await server.client.prompt(sessionId, ASK('approved.txt'));
    const approval = await pendingApproval(sessionId);
    assert.equal(approval.toolName, 'write_file');
    assert.deepEqual(approval.input, { path: 'approved.txt', content: 'approved content' });
    assert.equal(approval.reason, 'write_file needs approval');
    assert.equal((await server.client.getSession(sessionId)).session.status, 'running', 'the turn is paused, not ended');

    const { approval: decided } = await server.client.approve(sessionId, approval.id, 'checked the path');
    assert.equal(decided.status, 'approved');
    assert.equal(await answer(sessionId), 'RESULT: Wrote 16 bytes to approved.txt');

    const log = await events(sessionId, ['approval.', 'tool.']);
    assert.deepEqual(
      log.map((event) => event.type),
      ['tool.requested', 'approval.requested', 'approval.decided', 'tool.approved', 'tool.started', 'tool.completed'].filter((type) => log.some((event) => event.type === type)),
    );
    const decision = log.find((event) => event.type === 'approval.decided')!.payload as { decision: string; by: string; reason: string };
    assert.equal(decision.decision, 'approved');
    assert.equal(decision.reason, 'checked the path');
    assert.ok(decision.by.startsWith('pr_'), 'who decided is recorded');
    assert.ok(log.some((event) => event.type === 'tool.completed'), 'the call ran');

    const audit = (await server.client.listAudit(workspaceId, { limit: 200 })).items
      .filter((entry) => entry.resourceId === sessionId)
      .map((entry) => entry.action);
    assert.ok(audit.includes('session.approval.request'));
    assert.ok(audit.includes('session.approve'));
  });

  test("denied, the call does not run and the agent reads the person's reason", async () => {
    const sessionId = await readySession();
    await server.client.prompt(sessionId, ASK('denied.txt'));
    const approval = await pendingApproval(sessionId);
    await server.client.deny(sessionId, approval.id, 'not on production');
    assert.equal(await answer(sessionId), 'RESULT: Permission denied: not on production');
    const log = await events(sessionId, ['tool.']);
    assert.ok(log.some((event) => event.type === 'tool.denied'));
    assert.ok(!log.some((event) => event.type === 'tool.completed'), 'the call did not run');
    assert.equal((await server.client.getApproval(sessionId, approval.id)).approval.status, 'denied');
  });

  test('unanswered, the call is denied when its time is up, and says why', async () => {
    const sessionId = await readySession();
    await server.client.prompt(sessionId, ASK('expired.txt'));
    const approval = await pendingApproval(sessionId);
    assert.ok(approval.expiresAt - approval.requestedAt === 10_000);
    assert.equal(await answer(sessionId), 'RESULT: Permission denied: No one approved or denied the call within 10 s, so it was denied.');
    assert.equal((await server.client.getApproval(sessionId, approval.id)).approval.status, 'expired');
    await assert.rejects(server.client.approve(sessionId, approval.id), (error: unknown) => (error as { status?: number }).status === 409);
  });

  test('a control plane that crashes while a call waits comes back to find it waiting, and the sandbox reconnects', async () => {
    const { agent } = await server.client.createAgent(workspaceId, {
      name: 'Patient',
      spec: { systemPrompt: 'Ask before writing.', model: { modelId: MODEL }, tools: { mode: 'prompt', approvalTimeoutSeconds: 600 } },
    });
    const { session } = await server.client.createSession({ agentId: agent.id });
    await waitFor('the session to be ready', async () => (await server.client.getSession(session.id)).session.status === 'ready', 90_000, serverLog);
    await server.client.prompt(session.id, ASK('after-restart.txt'));
    const approval = await pendingApproval(session.id);

    strays.push(...(await server.kill()));
    assert.ok(strays.length > 0, 'the sandbox outlived the control plane');
    await server.start();

    const still = (await server.client.listApprovals(session.id, { statuses: ['pending'] })).items;
    assert.deepEqual(still.map((entry) => entry.id), [approval.id], 'the call is still waiting after the restart');
    await server.client.approve(session.id, approval.id);
    assert.equal(await answer(session.id), 'RESULT: Wrote 16 bytes to after-restart.txt');
  });

  test('a session started by a schedule has no one to ask, so the call is denied at once', async () => {
    const connector = await server.client.createConnector(workspaceId, {
      type: 'schedule',
      name: 'nightly',
      externalKey: 'nightly-approvals',
      agentId,
      config: { cron: '0 0 1 1 *', timezone: 'UTC', prompt: ASK('unattended.txt') },
    });
    await server.client.activateConnector(connector.id);
    await server.client.runConnector(connector.id);

    let denied: Approval | undefined;
    await waitFor(
      'the unattended call to be decided',
      async () => {
        denied = (await server.client.listWorkspaceApprovals(workspaceId, { statuses: ['denied'] })).items.find((entry) => (entry.input as { path?: string }).path === 'unattended.txt');
        return denied !== undefined;
      },
      90_000,
      serverLog,
    );
    assert.match(denied!.decisionReason, /started by a schedule, so no one is there to approve the call/);
    assert.equal(denied!.decidedBy, undefined);
    assert.equal(
      await answer(denied!.sessionId),
      `RESULT: Permission denied: ${denied!.decisionReason}`,
    );
  });
});
