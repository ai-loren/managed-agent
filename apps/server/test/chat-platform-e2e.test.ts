/**
 * Slack and Feishu chat connectors on a real server: the platform's signed
 * event arrives at the ingress URL, a real agent-core answers, and the answer
 * goes back through the platform's API — fake APIs standing in for Slack's and
 * Feishu's, reached through MA_SLACK_API_URL and MA_FEISHU_API_URL.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import { EchoModel, LiveServer, MODEL, waitFor } from './support/live-server.ts';

const SLACK_SIGNING = 'slack-signing-secret-e2e';
const ENCRYPT_KEY = 'feishu-encrypt-key-e2e';

class FakeApi {
  readonly calls: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  answer: (url: string, body: Record<string, unknown>) => unknown = () => ({});
  origin = '';
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        this.calls.push({ url: request.url ?? '', headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.answer(request.url ?? '', body)));
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as { port: number }).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }
}

let model: EchoModel;
let server: LiveServer;
let slack: FakeApi;
let feishu: FakeApi;
let workspaceId = '';
let agentId = '';

async function chatConnector(name: string, config: Record<string, unknown>, secrets: Record<string, string>): Promise<{ id: string; externalKey: string }> {
  const { credential } = await server.client.createCredential(workspaceId, {
    ownerType: 'workspace',
    type: 'api_key',
    name: `${name} secrets`,
    value: JSON.stringify(secrets),
  });
  const connector = await server.client.createConnector(workspaceId, { type: 'chat', name, externalKey: name, agentId, secretCredentialId: credential.id, config });
  await server.client.activateConnector(connector.id);
  return connector;
}

function ingress(externalKey: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${server.baseUrl}/ingress/v1/${workspaceId}/${externalKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function slackHeaders(body: string, secret = SLACK_SIGNING): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`,
  };
}

const slackEvent = (ts: string, text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'event_callback', event_id: `Ev${ts}`, event: { type: 'app_mention', channel: 'C1', user: 'U1', ts, text: `<@U0BOT> ${text}`, ...extra } });

function feishuEncrypted(payload: unknown): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(ENCRYPT_KEY).digest(), iv);
  return JSON.stringify({ encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64') });
}

function feishuHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  return {
    'x-lark-request-timestamp': timestamp,
    'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(timestamp + nonce + ENCRYPT_KEY + body).digest('hex'),
  };
}

describe('Slack and Feishu chat connectors on a real server', () => {
  before(async () => {
    slack = new FakeApi();
    feishu = new FakeApi();
    await slack.start();
    await feishu.start();
    model = new EchoModel();
    await model.start();
    server = new LiveServer(model, { MA_SLACK_API_URL: `${slack.origin}/api`, MA_FEISHU_API_URL: feishu.origin });
    await server.start();
    const { workspace } = await server.client.createWorkspace({ name: 'Chat', slug: 'chat-e2e' });
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
    await slack?.stop();
    await feishu?.stop();
  });

  test("Slack: the URL check, then a mention answered in its thread, once however often Slack retries it", async () => {
    slack.answer = () => ({ ok: true });
    const connector = await chatConnector('slack-bot', { platform: 'slack' }, { signingSecret: SLACK_SIGNING, botToken: 'xoxb-e2e' });

    const check = JSON.stringify({ type: 'url_verification', challenge: 'challenge-e2e', token: 'legacy' });
    const answered = await ingress(connector.externalKey, check, slackHeaders(check));
    assert.equal(answered.status, 200);
    assert.deepEqual(await answered.json(), { challenge: 'challenge-e2e' });
    const forged = await ingress(connector.externalKey, check, slackHeaders(check, 'not-the-signing-secret'));
    await forged.body?.cancel();
    assert.equal(forged.status, 401);

    const event = slackEvent('1700000000.000300', 'hello from slack', { thread_ts: '1700000000.000100' });
    const accepted = await ingress(connector.externalKey, event, slackHeaders(event));
    await accepted.body?.cancel();
    assert.equal(accepted.status, 202);
    const retried = await ingress(connector.externalKey, event, { ...slackHeaders(event), 'x-slack-retry-num': '1' });
    await retried.body?.cancel();
    assert.equal(retried.status, 200, 'a retry is the delivery already received');

    await waitFor('the answer to reach Slack', () => slack.calls.some((call) => call.url === '/api/chat.postMessage'), 90_000, () => server.log);
    const post = slack.calls.find((call) => call.url === '/api/chat.postMessage')!;
    assert.equal(post.headers.authorization, 'Bearer xoxb-e2e');
    assert.deepEqual(post.body, { channel: 'C1', text: 'echo: hello from slack', thread_ts: '1700000000.000100' });
    assert.deepEqual(model.prompts().filter((prompt) => prompt === 'hello from slack'), ['hello from slack'], 'one run');
  });

  test('Slack: a refused reply shows on the connector until the next one is sent', async () => {
    slack.answer = () => ({ ok: false, error: 'not_in_channel' });
    const connector = await chatConnector('slack-uninvited', { platform: 'slack' }, { signingSecret: SLACK_SIGNING, botToken: 'xoxb-e2e' });
    const first = slackEvent('1700000001.000100', 'are you there?');
    await (await ingress(connector.externalKey, first, slackHeaders(first))).body?.cancel();
    await waitFor('the refusal to show on the connector', async () => (await server.client.getConnector(connector.id)).connector.error?.code === 'CHAT_SEND_FAILED', 90_000, () => server.log);
    const { connector: failing } = await server.client.getConnector(connector.id);
    assert.match(failing.error!.message, /Slack refused the reply \(not_in_channel\)\. Invite the app to the channel/);
    assert.equal(failing.status, 'active');

    slack.answer = () => ({ ok: true });
    const second = slackEvent('1700000002.000100', 'how about now?');
    await (await ingress(connector.externalKey, second, slackHeaders(second))).body?.cancel();
    await waitFor('the error to clear', async () => (await server.client.getConnector(connector.id)).connector.error === undefined, 90_000, () => server.log);
  });

  test('Feishu: the URL check, then an encrypted message answered as a reply to it', async () => {
    feishu.answer = (url) =>
      url.startsWith('/open-apis/auth/') ? { code: 0, msg: 'ok', tenant_access_token: 't-e2e', expire: 7200 } : { code: 0, msg: 'success' };
    const connector = await chatConnector('feishu-bot', { platform: 'feishu', appId: 'cli_e2e' }, { appSecret: 'feishu-app-secret', encryptKey: ENCRYPT_KEY });

    const check = feishuEncrypted({ type: 'url_verification', challenge: 'feishu-challenge', token: 'vt' });
    const answered = await ingress(connector.externalKey, check, {});
    assert.equal(answered.status, 200);
    assert.deepEqual(await answered.json(), { challenge: 'feishu-challenge' });

    const event = feishuEncrypted({
      schema: '2.0',
      header: { event_id: 'ev-e2e', event_type: 'im.message.receive_v1', app_id: 'cli_e2e' },
      event: {
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_e2e' } },
        message: { message_id: 'om_e2e', chat_id: 'oc_e2e', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@_user_1 hello from feishu' }) },
      },
    });
    const unsigned = await ingress(connector.externalKey, event, {});
    await unsigned.body?.cancel();
    assert.equal(unsigned.status, 401, 'with an Encrypt Key, an unsigned event is refused');
    const accepted = await ingress(connector.externalKey, event, feishuHeaders(event));
    await accepted.body?.cancel();
    assert.equal(accepted.status, 202);

    await waitFor('the answer to reach Feishu', () => feishu.calls.some((call) => call.url === '/open-apis/im/v1/messages/om_e2e/reply'), 90_000, () => server.log);
    assert.deepEqual(feishu.calls[0]!.body, { app_id: 'cli_e2e', app_secret: 'feishu-app-secret' });
    const reply = feishu.calls.find((call) => call.url === '/open-apis/im/v1/messages/om_e2e/reply')!;
    assert.equal(reply.headers.authorization, 'Bearer t-e2e');
    assert.deepEqual(reply.body, { msg_type: 'text', content: JSON.stringify({ text: 'echo: hello from feishu' }) });
  });
});
