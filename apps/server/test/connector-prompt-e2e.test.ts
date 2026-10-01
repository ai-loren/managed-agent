/**
 * A connector's prompt reaches the agent whole, through a real server process.
 *
 * A receipt keeps a 4,000-character summary for listings, and deliveries used to
 * send that summary as the prompt, so anything longer reached the agent cut off
 * with no sign of it. Here a schedule run on demand and a signed hook each
 * carry a longer prompt to a real agent-core, and the stand-in model must see
 * every character.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { hmacSha256Hex } from '@ma/core';

import { EchoModel, LiveServer, MODEL, waitFor } from './support/live-server.ts';

const SECRET = 'hook-secret-for-the-prompt-e2e';

let model: EchoModel;
let server: LiveServer;
let workspaceId = '';
let agentId = '';

const longPrompt = (label: string, words: number): string =>
  `${label}: ${Array.from({ length: words }, (_, index) => `item-${index}`).join(' ')} — end of ${label}`;

describe('connector prompts on a real server', () => {
  before(async () => {
    model = new EchoModel();
    await model.start();
    server = new LiveServer(model, {});
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'Prompts', slug: 'prompts-e2e' });
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
  });

  test('a schedule run on demand sends its whole prompt', async () => {
    const prompt = longPrompt('nightly report', 2500);
    assert.ok(prompt.length > 15_000);
    const connector = await server.client.createConnector(workspaceId, {
      type: 'schedule',
      name: 'nightly',
      externalKey: 'nightly',
      agentId,
      config: { cron: '0 0 1 1 *', timezone: 'UTC', prompt },
    });
    await server.client.activateConnector(connector.id);
    await server.client.runConnector(connector.id);

    await waitFor('the run to reach the model', () => model.prompts().some((sent) => sent.startsWith('nightly report:')), 90_000, () => server.log);
    assert.equal(model.prompts().find((sent) => sent.startsWith('nightly report:')), prompt);
    const receipts = await server.client.listReceipts(connector.id);
    assert.equal(receipts.items[0]?.payloadSummary.length, 4000, 'the receipt still lists a summary');
  });

  test('a signed hook sends its whole prompt', async () => {
    const { credential } = await server.client.createCredential(workspaceId, {
      ownerType: 'workspace',
      type: 'api_key',
      name: 'hook secret',
      value: SECRET,
    });
    const connector = await server.client.createConnector(workspaceId, {
      type: 'hook',
      name: 'incoming',
      externalKey: 'incoming',
      agentId,
      secretCredentialId: credential.id,
    });
    await server.client.activateConnector(connector.id);

    const prompt = longPrompt('incident', 2000);
    const body = JSON.stringify({ prompt, eventId: 'incident-1' });
    const timestamp = Date.now();
    const response = await fetch(`${server.baseUrl}/ingress/v1/${workspaceId}/incoming`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ma-timestamp': String(timestamp),
        'x-ma-signature': hmacSha256Hex(SECRET, `${timestamp}.${body}`),
      },
      body,
    });
    assert.ok(response.ok, `ingress answered ${response.status}: ${await response.text()}`);

    await waitFor('the hook to reach the model', () => model.prompts().some((sent) => sent.startsWith('incident:')), 90_000, () => server.log);
    assert.equal(model.prompts().find((sent) => sent.startsWith('incident:')), prompt);
  });
});
