/**
 * Slack and Feishu in the chat connector: their signatures, their events and
 * their send APIs, against fake API servers.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

import { MaError, TestClock, systemClock, type Clock } from '@ma/core';
import type { Connector } from '@ma/contracts';

import type { InboundRequest } from '../src/index.ts';
import {
  FeishuTokens,
  feishuSecret,
  normalizeFeishu,
  normalizeSlack,
  sendFeishu,
  sendSlack,
  slackSecret,
  splitText,
  verifyFeishu,
  verifySlack,
} from '../src/chat-platforms.ts';

const START = 1_700_000_000_000;
const connector = { id: 'cn_1', name: 'bot' } as Connector;

function inbound(body: unknown, headers: Record<string, string> = {}): InboundRequest {
  const rawBody = Buffer.from(JSON.stringify(body));
  return { headers, rawBody, body, query: new URLSearchParams(), sourceIp: '10.0.0.1', receivedAt: START };
}

function slackRequest(body: unknown, signingSecret = 'slack-signing', at = START): InboundRequest {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(at / 1000);
  const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return inbound(body, { 'x-slack-signature': signature, 'x-slack-request-timestamp': String(timestamp) });
}

function feishuEncrypt(payload: unknown, encryptKey: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64');
}

function feishuRequest(payload: unknown, encryptKey = 'feishu-encrypt', signed = true): InboundRequest {
  const body = { encrypt: feishuEncrypt(payload, encryptKey) };
  const raw = JSON.stringify(body);
  const timestamp = '1700000000';
  const nonce = 'n-1';
  const signature = createHash('sha256').update(timestamp + nonce + encryptKey + raw).digest('hex');
  return inbound(body, signed ? { 'x-lark-signature': signature, 'x-lark-request-timestamp': timestamp, 'x-lark-request-nonce': nonce } : {});
}

const slackMessage = (event: Record<string, unknown>) => ({
  type: 'event_callback',
  event_id: 'Ev1',
  event: { type: 'message', channel: 'C1', user: 'U1', ts: '1700000000.000100', text: 'hello', ...event },
});

const feishuMessage = (message: Record<string, unknown> = {}, sender: Record<string, unknown> = { sender_type: 'user' }, token = 'vt') => ({
  schema: '2.0',
  header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', token, app_id: 'cli_x' },
  event: {
    sender,
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@_user_1 hello' }), ...message },
  },
});

describe("a chat connector's credential", () => {
  test('a Slack credential holds the signing secret and the bot token, and an error never quotes it', () => {
    assert.deepEqual(slackSecret('{"signingSecret":"s","botToken":"xoxb-1"}'), { signingSecret: 's', botToken: 'xoxb-1' });
    const cases: [string | undefined, RegExp][] = [
      [undefined, /could not be read: it is unbound, revoked or expired/],
      ['xoxb-not-json-secret', /its value is not JSON/],
      ['"xoxb-a-json-string"', /JSON but not an object/],
      ['{"signingSecret":"s"}', /has no botToken; it must hold \{"signingSecret": "…", "botToken": "xoxb-…"\}.*OAuth & Permissions/],
      ['{"botToken":"xoxb-1","signingSecret":""}', /has no signingSecret/],
    ];
    for (const [secret, pattern] of cases) {
      assert.throws(() => slackSecret(secret), (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.category, 'validation');
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /xoxb-not-json|xoxb-a-json|xoxb-1/);
        return true;
      }, String(secret));
    }
  });

  test('a Feishu credential holds the app secret and something to check events with', () => {
    assert.deepEqual(feishuSecret('{"appSecret":"a","encryptKey":"e"}'), { appSecret: 'a', encryptKey: 'e' });
    assert.deepEqual(feishuSecret('{"appSecret":"a","verificationToken":"v"}'), { appSecret: 'a', verificationToken: 'v' });
    assert.throws(() => feishuSecret('{"encryptKey":"e"}'), /has no appSecret/);
    assert.throws(() => feishuSecret('{"appSecret":"a"}'), /neither encryptKey nor verificationToken, so nothing it receives could be checked/);
  });
});

describe('Slack events', () => {
  const secret = { signingSecret: 'slack-signing', botToken: 'xoxb-1' };

  test('a request signed with the signing secret, within five minutes, is accepted', () => {
    assert.deepEqual(verifySlack(slackRequest(slackMessage({})), secret, START), { ok: true });
    assert.equal(verifySlack(slackRequest(slackMessage({}), 'slack-signing', START - 299_000), secret, START).ok, true);
  });

  test('a wrong signature, a stale or future timestamp, or none at all is refused', () => {
    const cases: [InboundRequest, RegExp][] = [
      [slackRequest(slackMessage({}), 'another-secret'), /signature does not match; check signingSecret/],
      [slackRequest(slackMessage({}), 'slack-signing', START - 301_000), /more than five minutes/],
      [slackRequest(slackMessage({}), 'slack-signing', START + 301_000), /more than five minutes/],
      [inbound(slackMessage({})), /missing X-Slack-Signature/],
    ];
    for (const [request, pattern] of cases) {
      const verdict = verifySlack(request, secret, START);
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason ?? '', pattern);
    }
    const tampered = slackRequest(slackMessage({}));
    tampered.rawBody = Buffer.from(tampered.rawBody.toString().replace('hello', 'HELLO'));
    assert.equal(verifySlack(tampered, secret, START).ok, false, 'the signature covers the body');
  });

  test("Slack's URL check is answered, but only once its signature holds", () => {
    const check = { type: 'url_verification', challenge: 'c-123', token: 'legacy' };
    assert.deepEqual(verifySlack(slackRequest(check), secret, START).immediateResponse, { status: 200, body: { challenge: 'c-123' } });
    const forged = verifySlack(slackRequest(check, 'wrong'), secret, START);
    assert.equal(forged.ok, false);
    assert.equal(forged.immediateResponse, undefined);
  });

  test("a person's message becomes a delivery to the channel, a thread's to the thread", () => {
    const top = normalizeSlack(slackMessage({}), connector)!;
    assert.equal(top.externalEventId, 'slack:C1:1700000000.000100');
    assert.equal(top.scopeKey, 'C1');
    assert.deepEqual(top.responseContext, { channel: 'C1' });
    assert.deepEqual(top.events, [{ type: 'user.message', text: 'hello', attachments: [] }]);

    const threaded = normalizeSlack(slackMessage({ thread_ts: '1699999999.000001' }), connector)!;
    assert.equal(threaded.scopeKey, 'C1:1699999999.000001');
    assert.deepEqual(threaded.responseContext, { channel: 'C1', threadTs: '1699999999.000001' });
  });

  test('a mention loses the leading mention, and is one event with the message it also arrives as', () => {
    const mention = normalizeSlack({ ...slackMessage({ type: 'app_mention', text: '<@U0BOT> <@U0BOT|bot>  what is 6x7?' }), event_id: 'EvMention' }, connector)!;
    assert.deepEqual(mention.events, [{ type: 'user.message', text: 'what is 6x7?', attachments: [] }]);
    const message = normalizeSlack({ ...slackMessage({ text: '<@U0BOT> what is 6x7?' }), event_id: 'EvMessage' }, connector)!;
    assert.equal(mention.externalEventId, message.externalEventId);
    assert.deepEqual(normalizeSlack(slackMessage({ text: 'ask <@U2> about it' }), connector)!.events, [{ type: 'user.message', text: 'ask <@U2> about it', attachments: [] }]);
  });

  test("bots' posts, edits and other subtypes, other event types and empty text start nothing", () => {
    for (const body of [
      slackMessage({ bot_id: 'B1', text: 'my own reply' }),
      slackMessage({ subtype: 'message_changed' }),
      slackMessage({ subtype: 'channel_join' }),
      slackMessage({ type: 'reaction_added' }),
      slackMessage({ text: '<@U0BOT>' }),
      { type: 'app_rate_limited' },
      { ...slackMessage({}), type: 'url_verification' },
    ]) {
      assert.equal(normalizeSlack(body, connector), undefined, JSON.stringify(body));
    }
  });
});

describe('Feishu events', () => {
  const secret = { appSecret: 'app-secret', encryptKey: 'feishu-encrypt' };

  test('an encrypted, signed event is decrypted and passed on', () => {
    const verdict = verifyFeishu(feishuRequest(feishuMessage()), secret);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.body, feishuMessage());
  });

  test('a wrong signature, a missing one, or a wrong Encrypt Key is refused', () => {
    const tampered = feishuRequest(feishuMessage());
    tampered.headers['x-lark-signature'] = '0'.repeat(64);
    const cases: [InboundRequest, RegExp][] = [
      [tampered, /signature does not match; check encryptKey/],
      [feishuRequest(feishuMessage(), 'feishu-encrypt', false), /missing X-Lark-Signature/],
      [feishuRequest(feishuMessage(), 'another-key'), /did not decrypt|signature does not match/],
      [inbound(feishuMessage()), /missing X-Lark-Signature/],
    ];
    for (const [request, pattern] of cases) {
      const verdict = verifyFeishu(request, secret);
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason ?? '', pattern);
    }
    assert.match(verifyFeishu(feishuRequest(feishuMessage()), { appSecret: 'a', verificationToken: 'vt' }).reason ?? '', /encrypted event and the connector credential has no encryptKey/);
  });

  test("Feishu's URL check is answered, encrypted or not, unless its token is wrong", () => {
    const check = { type: 'url_verification', challenge: 'c-9', token: 'vt' };
    assert.deepEqual(verifyFeishu(feishuRequest(check, 'feishu-encrypt', false), secret).immediateResponse, { status: 200, body: { challenge: 'c-9' } });
    assert.deepEqual(verifyFeishu(inbound(check), { appSecret: 'a', verificationToken: 'vt' }).immediateResponse, { status: 200, body: { challenge: 'c-9' } });
    const wrong = verifyFeishu(inbound({ ...check, token: 'other' }), { appSecret: 'a', verificationToken: 'vt' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.immediateResponse, undefined);
  });

  test('without an Encrypt Key the verification token is checked, and with both, both are', () => {
    const tokenOnly = { appSecret: 'a', verificationToken: 'vt' };
    assert.equal(verifyFeishu(inbound(feishuMessage()), tokenOnly).ok, true);
    assert.match(verifyFeishu(inbound(feishuMessage({}, { sender_type: 'user' }, 'forged')), tokenOnly).reason ?? '', /verification token does not match/);
    const both = { ...secret, verificationToken: 'vt' };
    assert.equal(verifyFeishu(feishuRequest(feishuMessage()), both).ok, true);
    assert.equal(verifyFeishu(feishuRequest(feishuMessage({}, { sender_type: 'user' }, 'forged')), both).ok, false);
  });

  test("a person's text message becomes a delivery that replies to it, in its thread if it has one", () => {
    const trigger = normalizeFeishu(feishuMessage(), connector)!;
    assert.equal(trigger.externalEventId, 'feishu:om_1');
    assert.equal(trigger.scopeKey, 'oc_1');
    assert.deepEqual(trigger.events, [{ type: 'user.message', text: 'hello', attachments: [] }]);
    assert.deepEqual(trigger.responseContext, { messageId: 'om_1' });
    const threaded = normalizeFeishu(feishuMessage({ thread_id: 'omt_1' }), connector)!;
    assert.equal(threaded.scopeKey, 'oc_1:omt_1');
    assert.deepEqual(threaded.responseContext, { messageId: 'om_1', inThread: true });
  });

  test("an app's messages, other message types and other events start nothing", () => {
    for (const body of [
      feishuMessage({}, { sender_type: 'app' }),
      feishuMessage({ message_type: 'image', content: '{"image_key":"img"}' }),
      feishuMessage({ content: JSON.stringify({ text: '@_user_1' }) }),
      feishuMessage({ content: 'not json' }),
      { ...feishuMessage(), header: { event_type: 'im.chat.member.bot.added_v1' } },
      { ...feishuMessage(), schema: '1.0' },
    ]) {
      assert.equal(normalizeFeishu(body, connector), undefined, JSON.stringify(body));
    }
  });
});

describe('sending replies', () => {
  let server: Server;
  let origin = '';
  let seen: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  let answer: (url: string, body: Record<string, unknown>) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { ok: true } });
  const slept: number[] = [];
  const clock: Clock = { ...systemClock, sleep: (ms: number) => (slept.push(ms), Promise.resolve()) };

  beforeEach(async () => {
    seen = [];
    slept.length = 0;
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        seen.push({ url: request.url ?? '', headers: request.headers, body });
        const reply = answer(request.url ?? '', body);
        response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers }).end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('Slack: posted with the bot token, in the thread it came from', async () => {
    await sendSlack({ api: origin, clock, token: 'xoxb-1', channel: 'C1', threadTs: '1.2', text: 'the answer' });
    assert.equal(seen[0]!.url, '/chat.postMessage');
    assert.equal(seen[0]!.headers.authorization, 'Bearer xoxb-1');
    assert.match(String(seen[0]!.headers['content-type']), /^application\/json; charset=utf-8/);
    assert.deepEqual(seen[0]!.body, { channel: 'C1', text: 'the answer', thread_ts: '1.2' });
  });

  test('Slack: a long reply goes as several messages, in order, each under the limit', async () => {
    const reply = `${'a'.repeat(3_000)}\n${'b'.repeat(3_000)}\n${'c'.repeat(100)}`;
    await sendSlack({ api: origin, clock, token: 'xoxb-1', channel: 'C1', text: reply });
    assert.deepEqual(seen.map((s) => s.body.text), ['a'.repeat(3_000), `${'b'.repeat(3_000)}\n${'c'.repeat(100)}`]);
  });

  test('Slack: a rate limit is waited out once, as long as Slack asks', async () => {
    let calls = 0;
    answer = () => (++calls === 1 ? { status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '3' } } : { status: 200, body: { ok: true } });
    await sendSlack({ api: origin, clock, token: 'xoxb-1', channel: 'C1', text: 'x' });
    assert.deepEqual(slept, [3_000]);
    assert.equal(seen.length, 2);
  });

  test("Slack: a refusal says what to fix, and never shows the token", async () => {
    for (const [error, pattern] of [
      ['not_in_channel', /Slack refused the reply \(not_in_channel\)\. Invite the app to the channel/],
      ['invalid_auth', /botToken in the connector credential is not a valid token/],
      ['missing_scope', /lacks chat:write/],
      ['some_new_error', /some_new_error.*Check the app is installed/],
    ] as const) {
      answer = () => ({ status: 200, body: { ok: false, error } });
      await assert.rejects(sendSlack({ api: origin, clock, token: 'xoxb-secret-token', channel: 'C1', text: 'x' }), (failure: unknown) => {
        assert.ok(MaError.is(failure));
        assert.equal(failure.code, 'CHAT_SEND_FAILED');
        assert.match(failure.message, pattern);
        assert.doesNotMatch(failure.message, /xoxb-secret-token/);
        return true;
      });
    }
  });

  test('Feishu: replies to the message with a tenant token got from the app id and secret', async () => {
    answer = (url) =>
      url.startsWith('/open-apis/auth/') ? { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 } } : { status: 200, body: { code: 0, msg: 'success' } };
    const tokens = new FeishuTokens(clock);
    await sendFeishu({ base: origin, clock, tokens, appId: 'cli_1', appSecret: 'as-1', messageId: 'om_1', inThread: true, text: 'the answer' });
    assert.deepEqual(seen[0]!.body, { app_id: 'cli_1', app_secret: 'as-1' });
    assert.equal(seen[0]!.url, '/open-apis/auth/v3/tenant_access_token/internal');
    assert.equal(seen[1]!.url, '/open-apis/im/v1/messages/om_1/reply');
    assert.equal(seen[1]!.headers.authorization, 'Bearer t-1');
    assert.deepEqual(seen[1]!.body, { msg_type: 'text', content: JSON.stringify({ text: 'the answer' }), reply_in_thread: true });
    await sendFeishu({ base: origin, clock, tokens, appId: 'cli_1', appSecret: 'as-1', messageId: 'om_2', inThread: false, text: 'again' });
    assert.equal(seen.length, 3, 'the token is reused');
    assert.ok(!('reply_in_thread' in seen[2]!.body));
  });

  test('Feishu: a token is never shared between connectors that give the same app id with different secrets', async () => {
    let issued = 0;
    answer = (url, body) =>
      url.startsWith('/open-apis/auth/')
        ? body.app_secret === 'right' ? { status: 200, body: { code: 0, tenant_access_token: `t-${++issued}`, expire: 7200 } } : { status: 200, body: { code: 10014, msg: 'app secret invalid' } }
        : { status: 200, body: { code: 0 } };
    const tokens = new FeishuTokens(clock);
    await sendFeishu({ base: origin, clock, tokens, appId: 'cli_shared', appSecret: 'right', messageId: 'om_1', inThread: false, text: 'x' });
    await assert.rejects(
      sendFeishu({ base: origin, clock, tokens, appId: 'cli_shared', appSecret: 'wrong', messageId: 'om_2', inThread: false, text: 'x' }),
      (error: unknown) => MaError.is(error) && /would not issue a token for app cli_shared \(code 10014: app secret invalid\)\. Check appId.*appSecret/.test(error.message),
    );
    assert.ok(!seen.some((s) => s.url.includes('om_2')), 'nothing was sent with the other connector’s token');
  });

  test('Feishu: the token is renewed before it expires, and at once when Feishu rejects it', async () => {
    const at = new TestClock(START);
    let issued = 0;
    let rejectNext = false;
    answer = (url) => {
      if (url.startsWith('/open-apis/auth/')) return { status: 200, body: { code: 0, tenant_access_token: `t-${++issued}`, expire: 7200 } };
      if (rejectNext) {
        rejectNext = false;
        return { status: 400, body: { code: 99991663, msg: 'Invalid access token for authorization.' } };
      }
      return { status: 200, body: { code: 0 } };
    };
    const tokens = new FeishuTokens(at);
    const send = () => sendFeishu({ base: origin, clock: at, tokens, appId: 'cli_1', appSecret: 's', messageId: 'om_1', inThread: false, text: 'x' });
    await send();
    await at.advance(7_200_000 - 6 * 60_000);
    await send();
    assert.equal(issued, 1);
    await at.advance(2 * 60_000);
    await send();
    assert.equal(issued, 2, 'renewed within five minutes of expiry');
    rejectNext = true;
    await send();
    assert.equal(issued, 3, 'a rejected token is replaced and the reply sent again');
    assert.equal(seen.at(-1)!.headers.authorization, 'Bearer t-3');
  });

  test('Feishu: a refusal says what Feishu said and what to check', async () => {
    answer = (url) =>
      url.startsWith('/open-apis/auth/') ? { status: 200, body: { code: 0, tenant_access_token: 't', expire: 7200 } } : { status: 400, body: { code: 230002, msg: 'Bot/User can NOT be out of the chat.' } };
    await assert.rejects(
      sendFeishu({ base: origin, clock, tokens: new FeishuTokens(clock), appId: 'cli_1', appSecret: 's', messageId: 'om_1', inThread: false, text: 'x' }),
      (error: unknown) => MaError.is(error) && error.code === 'CHAT_SEND_FAILED' && /code 230002: Bot\/User can NOT be out of the chat\.\). Check the bot is in the chat/.test(error.message),
    );
  });
});

describe('splitting a long reply', () => {
  test('at a line break in the second half of the limit, else at the limit', () => {
    assert.deepEqual(splitText('short', 10), ['short']);
    assert.deepEqual(splitText('aaaaaaa\nbbbbbbb', 10), ['aaaaaaa', 'bbbbbbb']);
    assert.deepEqual(splitText('aa\nbbbbbbbbbbbb', 10), ['aa\nbbbbbbb', 'bbbbb'], 'a break in the first half would leave a tiny part');
    assert.deepEqual(splitText('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });

  test('never between the halves of a surrogate pair', () => {
    const parts = splitText(`${'a'.repeat(9)}😀b`, 10);
    assert.deepEqual(parts, ['a'.repeat(9), '😀b']);
    assert.equal(parts.join(''), `${'a'.repeat(9)}😀b`);
  });
});
