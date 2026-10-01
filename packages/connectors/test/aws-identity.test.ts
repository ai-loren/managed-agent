import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, TestClock } from '@ma/core';

import { assumeRole, awsIdentity, stsEndpoint, type AwsCredentialProvider } from '../src/index.ts';

const START = 1_700_000_000_000;
const HOUR = 3_600_000;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let origin = '';
let seen: Seen[] = [];
let answer: (request: Seen) => { status: number; body: string } = () => ({ status: 404, body: '' });
let dir = '';

beforeEach(async () => {
  seen = [];
  dir = await mkdtemp(join(tmpdir(), 'ma-aws-'));
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body };
      seen.push(entry);
      const reply = answer(entry);
      response.writeHead(reply.status).end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function stsAnswer(kind: 'AssumeRole' | 'AssumeRoleWithWebIdentity', key: string, expiresAt: number): string {
  return (
    `<${kind}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${kind}Result><Credentials>` +
    `<AccessKeyId>${key}</AccessKeyId><SecretAccessKey>secret-of-${key}</SecretAccessKey>` +
    `<SessionToken>token&amp;of-${key}</SessionToken><Expiration>${new Date(expiresAt).toISOString()}</Expiration>` +
    `</Credentials></${kind}Result></${kind}Response>`
  );
}

const form = (body: string): Record<string, string> => Object.fromEntries(new URLSearchParams(body));

describe("the platform's AWS identity", () => {
  test('access keys in the environment, with their session token', async () => {
    const identity = awsIdentity({
      env: { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 'env-secret', AWS_SESSION_TOKEN: 'env-token' },
      clock: new TestClock(START),
    });
    assert.deepEqual(await identity.get(), { accessKeyId: 'AKIAENV', secretAccessKey: 'env-secret', sessionToken: 'env-token' });
    assert.equal(identity.describe, "the platform's access key AKIAENV");
    assert.deepEqual(seen, []);
  });

  test('an access key id without its secret is passed over for the next place', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ AccessKeyId: 'ASIAECS', SecretAccessKey: 'ecs-secret', Token: 'ecs-token' }) });
    const identity = awsIdentity({
      env: { AWS_ACCESS_KEY_ID: 'AKIAHALF', AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/creds' },
      clock: new TestClock(START),
      containerEndpoint: origin,
    });
    assert.equal((await identity.get()).accessKeyId, 'ASIAECS');
  });

  test('a web identity token is exchanged at STS, read afresh each time, and renewed only near expiry', async () => {
    const clock = new TestClock(START);
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, 'jwt-one\n');
    let issued = 0;
    answer = () => ({ status: 200, body: stsAnswer('AssumeRoleWithWebIdentity', `ASIAWEB${++issued}`, clock.now() + HOUR) });
    const identity = awsIdentity({
      env: { AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/platform', AWS_REGION: 'eu-west-1' },
      clock,
      stsEndpoint: (region) => `${origin}/sts/${region}`,
    });

    assert.deepEqual(await identity.get(), { accessKeyId: 'ASIAWEB1', secretAccessKey: 'secret-of-ASIAWEB1', sessionToken: 'token&of-ASIAWEB1' });
    assert.equal(seen[0]!.url, '/sts/eu-west-1');
    assert.deepEqual(form(seen[0]!.body), {
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: 'arn:aws:iam::123456789012:role/platform',
      RoleSessionName: 'managed-agent',
      WebIdentityToken: 'jwt-one',
    });
    assert.equal(seen[0]!.headers.authorization, undefined, 'the web identity call is not signed');

    await clock.advance(HOUR - 6 * 60_000);
    await identity.get();
    assert.equal(seen.length, 1, 'still good: no second call');

    await writeFile(tokenFile, 'jwt-two\n');
    await clock.advance(2 * 60_000);
    assert.equal((await identity.get()).accessKeyId, 'ASIAWEB2', 'within five minutes of expiry: renewed');
    assert.equal(form(seen[1]!.body).WebIdentityToken, 'jwt-two', 'the rotated token is the one used');
  });

  test('the container credentials endpoint, relative or full, with its authorization token', async () => {
    answer = () => ({ status: 200, body: JSON.stringify({ AccessKeyId: 'ASIAECS', SecretAccessKey: 'ecs-secret', Token: 'ecs-token', Expiration: new Date(START + HOUR).toISOString() }) });
    const relative = awsIdentity({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, clock: new TestClock(START), containerEndpoint: origin });
    assert.equal((await relative.get()).sessionToken, 'ecs-token');
    assert.equal(seen[0]!.url, '/v2/credentials/abc');

    const tokenFile = join(dir, 'pod-identity-token');
    await writeFile(tokenFile, 'pod-identity-secret\n');
    const full = awsIdentity({
      env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${origin}/v1/credentials`, AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile },
      clock: new TestClock(START),
    });
    assert.equal((await full.get()).accessKeyId, 'ASIAECS');
    assert.equal(seen[1]!.headers.authorization, 'pod-identity-secret');
  });

  test('the instance metadata service, with the session token IMDSv2 requires', async () => {
    answer = (request) => {
      if (request.method === 'PUT' && request.url === '/latest/api/token') return { status: 200, body: 'imds-session' };
      if (request.headers['x-aws-ec2-metadata-token'] !== 'imds-session') return { status: 401, body: '' };
      if (request.url === '/latest/meta-data/iam/security-credentials/') return { status: 200, body: 'instance-role\n' };
      return { status: 200, body: JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAEC2', SecretAccessKey: 'ec2-secret', Token: 'ec2-token', Expiration: new Date(START + HOUR).toISOString() }) };
    };
    const identity = awsIdentity({ env: {}, clock: new TestClock(START), imdsEndpoint: origin });
    assert.deepEqual(await identity.get(), { accessKeyId: 'ASIAEC2', secretAccessKey: 'ec2-secret', sessionToken: 'ec2-token' });
    assert.equal(seen[0]!.headers['x-aws-ec2-metadata-token-ttl-seconds'], '21600');
    assert.equal(seen[2]!.url, '/latest/meta-data/iam/security-credentials/instance-role');
  });

  test('with nowhere to find one, it says where it looked and what to do', async () => {
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const identity = awsIdentity({ env: {}, clock: new TestClock(START), imdsEndpoint: `http://127.0.0.1:${closed}` });
    await assert.rejects(identity.get(), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'AWS_IDENTITY_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.match(error.message, /no access key \(AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY\), no web identity token .* instance metadata service did not answer\. Give the control plane one/);
      return true;
    });
  });

  test('a failed renewal keeps credentials that have not yet expired; only expired ones make it an error', async () => {
    const clock = new TestClock(START);
    let healthy = true;
    answer = () =>
      healthy
        ? { status: 200, body: JSON.stringify({ AccessKeyId: 'ASIAOLD', SecretAccessKey: 's', Token: 't', Expiration: new Date(START + HOUR).toISOString() }) }
        : { status: 500, body: '' };
    const identity = awsIdentity({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/creds' }, clock, containerEndpoint: origin });
    await identity.get();
    healthy = false;
    await clock.advance(HOUR - 60_000);
    assert.equal((await identity.get()).accessKeyId, 'ASIAOLD');
    assert.equal(seen.length, 2, 'it did try to renew');
    await clock.advance(60_000);
    await assert.rejects(identity.get(), (error: unknown) => MaError.is(error) && error.code === 'AWS_IDENTITY_UNAVAILABLE' && /answered 500/.test(error.message));
  });

  test('a refused web identity says what the trust policy must allow', async () => {
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, 'jwt');
    answer = () => ({
      status: 403,
      body: '<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>',
    });
    const identity = awsIdentity({
      env: { AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/platform' },
      clock: new TestClock(START),
      stsEndpoint: () => `${origin}/`,
    });
    await assert.rejects(identity.get(), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'AWS_ASSUME_ROLE_FAILED');
      assert.match(error.message, /AccessDenied: Not authorized.*trust the cluster's OIDC provider for this pod's service account/);
      return true;
    });
  });

  test('callers at once share one fetch', async () => {
    let issued = 0;
    answer = () => ({ status: 200, body: JSON.stringify({ AccessKeyId: `ASIA${++issued}`, SecretAccessKey: 's', Token: 't', Expiration: new Date(START + HOUR).toISOString() }) });
    const identity = awsIdentity({ env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/creds' }, clock: new TestClock(START), containerEndpoint: origin });
    const keys = await Promise.all([identity.get(), identity.get(), identity.get()]);
    assert.deepEqual(keys.map((key) => key.accessKeyId), ['ASIA1', 'ASIA1', 'ASIA1']);
    assert.equal(seen.length, 1);
  });

  test("STS's endpoint is regional, under China's own domain there", () => {
    assert.equal(stsEndpoint('eu-west-1'), 'https://sts.eu-west-1.amazonaws.com/');
    assert.equal(stsEndpoint('cn-north-1'), 'https://sts.cn-north-1.amazonaws.com.cn/');
  });
});

describe('assuming a role', () => {
  const base: AwsCredentialProvider = {
    describe: "the platform's access key AKIABASE",
    get: () => Promise.resolve({ accessKeyId: 'AKIABASE', secretAccessKey: 'base-secret' }),
    invalidate: () => {},
  };

  test('signs AssumeRole with the platform identity, with the workspace as the external id', async () => {
    const clock = new TestClock(START);
    answer = () => ({ status: 200, body: stsAnswer('AssumeRole', 'ASIAROLE', clock.now() + HOUR) });
    const role = assumeRole({
      base,
      roleArn: 'arn:aws:iam::210987654321:role/customer-reader',
      externalId: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      sessionName: 'ma-cn_one',
      region: 'eu-west-1',
      clock,
      stsEndpoint: () => `${origin}/`,
    });
    assert.deepEqual(await role.get(), { accessKeyId: 'ASIAROLE', secretAccessKey: 'secret-of-ASIAROLE', sessionToken: 'token&of-ASIAROLE' });
    assert.equal(role.describe, 'role arn:aws:iam::210987654321:role/customer-reader');
    assert.deepEqual(form(seen[0]!.body), {
      Action: 'AssumeRole',
      Version: '2011-06-15',
      RoleArn: 'arn:aws:iam::210987654321:role/customer-reader',
      RoleSessionName: 'ma-cn_one',
      ExternalId: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      DurationSeconds: '3600',
    });
    assert.match(String(seen[0]!.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AKIABASE\/\d{8}\/eu-west-1\/sts\/aws4_request, /);
  });

  test('a refusal says what the trust policy must allow, and nothing secret', async () => {
    answer = () => ({
      status: 403,
      body: '<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRole</Message></Error></ErrorResponse>',
    });
    const role = assumeRole({ base, roleArn: 'arn:aws:iam::210987654321:role/r', externalId: 'ws_x', sessionName: 's1', region: 'eu-west-1', clock: new TestClock(START), stsEndpoint: () => `${origin}/` });
    await assert.rejects(role.get(), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'AWS_ASSUME_ROLE_FAILED');
      assert.equal(error.category, 'permission');
      assert.match(error.message, /AccessDenied: Not authorized.*sts:ExternalId "ws_x"/);
      assert.doesNotMatch(error.message, /base-secret/);
      return true;
    });
  });

  test("STS refusing the platform's own credentials as expired drops them, and is retried rather than blamed on the role", async () => {
    let invalidated = 0;
    const expiring: AwsCredentialProvider = { ...base, invalidate: () => void invalidated++ };
    answer = () => ({
      status: 400,
      body: '<ErrorResponse><Error><Code>ExpiredToken</Code><Message>The security token included in the request is expired</Message></Error></ErrorResponse>',
    });
    const role = assumeRole({ base: expiring, roleArn: 'arn:aws:iam::210987654321:role/r', externalId: 'ws_x', sessionName: 's1', region: 'eu-west-1', clock: new TestClock(START), stsEndpoint: () => `${origin}/` });
    await assert.rejects(role.get(), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'AWS_IDENTITY_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.match(error.message, /refused the platform's access key AKIABASE as expired/);
      return true;
    });
    assert.equal(invalidated, 1);
  });

  test('renews before the credentials expire, and at once after they were refused as expired', async () => {
    const clock = new TestClock(START);
    let issued = 0;
    answer = () => ({ status: 200, body: stsAnswer('AssumeRole', `ASIA${++issued}`, clock.now() + HOUR) });
    const role = assumeRole({ base, roleArn: 'arn:aws:iam::210987654321:role/r', externalId: 'ws_x', sessionName: 's1', region: 'eu-west-1', clock, stsEndpoint: () => `${origin}/` });
    assert.equal((await role.get()).accessKeyId, 'ASIA1');
    await clock.advance(HOUR - 4 * 60_000);
    assert.equal((await role.get()).accessKeyId, 'ASIA2');
    role.invalidate();
    assert.equal((await role.get()).accessKeyId, 'ASIA3');
  });
});
