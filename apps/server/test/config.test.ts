/**
 * Config validation tests.
 *
 * `loadConfig` reads `process.env`, so these set and restore it around each
 * case. The focus is the security-relevant refusals — a config that reads as
 * safe but is not should fail to start, not warn.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError } from '@ma/core';

import { loadConfig } from '../src/config.ts';

/** Keys this suite touches, restored after each test. */
const KEYS = [
  'MA_PREVIEW_ORIGIN',
  'MA_CONSOLE_ORIGIN',
  'MA_CONTROL_PLANE_URL',
  'MA_ENCRYPTION_KEYS',
  'NODE_ENV',
  'MA_OPENROUTER_API_KEY',
  'MA_OPENROUTER_API_KEY_FILE',
  'MA_BOOTSTRAP_TOKEN',
  'MA_BOOTSTRAP_TOKEN_FILE',
  'MA_DELIVERY_CONCURRENCY',
  'MA_HOOK_CALLBACK_ORIGINS',
  'MA_LOCAL_EGRESS',
  'MA_EGRESS_PROXY_SECRET',
  'MA_EGRESS_PROXY_SECRET_FILE',
  'MA_K8S_NETWORK_POLICY_CHECK',
  'MA_K8S_PROBE_IMAGE',
  'MA_SQS_ENDPOINTS',
  'MA_KAFKA_BROKERS',
  'MA_SQS_AWS_IDENTITY',
  'MA_DATABASE',
  'MA_DATABASE_PASSWORD_FILE',
  'MA_SLACK_API_URL',
  'MA_FEISHU_API_URL',
  'MA_LARK_API_URL',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_REGION',
];

const saved = new Map<string, string | undefined>();
for (const key of KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('preview origin isolation', () => {
  test('refuses a preview origin equal to the console origin', () => {
    process.env.MA_PREVIEW_ORIGIN = 'https://console.example.com';
    process.env.MA_CONSOLE_ORIGIN = 'https://console.example.com';
    assert.throws(
      () => loadConfig(),
      (error: unknown) => MaError.is(error) && /MA_CONSOLE_ORIGIN/.test(error.message),
      'agent content on the console origin would run with the operator’s session',
    );
  });

  test('requires MA_CONSOLE_ORIGIN when preview is enabled', () => {
    // Without the console origin the isolation check is inert: it is the origin
    // preview content must be isolated *from*, so preview cannot be enabled
    // without it.
    process.env.MA_PREVIEW_ORIGIN = 'https://artifacts.example.com';
    delete process.env.MA_CONSOLE_ORIGIN;
    process.env.MA_CONTROL_PLANE_URL = 'http://127.0.0.1:8080';
    assert.throws(
      () => loadConfig(),
      (error: unknown) => MaError.is(error) && /MA_CONSOLE_ORIGIN must be set/.test(error.message),
    );
  });

  test('refuses a preview origin equal to a non-loopback API origin', () => {
    process.env.MA_CONTROL_PLANE_URL = 'https://api.example.com';
    process.env.MA_PREVIEW_ORIGIN = 'https://api.example.com';
    // A distinct console origin, so the guard reaches the API-origin check
    // rather than stopping at the console-origin requirement.
    process.env.MA_CONSOLE_ORIGIN = 'https://console.example.com';
    assert.throws(
      () => loadConfig(),
      (error: unknown) => MaError.is(error) && /API origin/.test(error.message),
    );
  });

  test('allows a genuinely separate preview origin', () => {
    process.env.MA_PREVIEW_ORIGIN = 'https://artifacts.example.com';
    process.env.MA_CONSOLE_ORIGIN = 'https://console.example.com';
    process.env.MA_CONTROL_PLANE_URL = 'https://api.example.com';
    const { config } = loadConfig();
    assert.equal(config.artifacts.previewOrigin, 'https://artifacts.example.com');
  });

  test('a preview origin equal to the loopback control-plane URL is allowed with a distinct console origin', () => {
    // The default control-plane URL is internal loopback, not the public origin,
    // so a same-value preview origin there is not the real same-origin risk —
    // provided a distinct public console origin is configured.
    process.env.MA_CONTROL_PLANE_URL = 'http://127.0.0.1:8080';
    process.env.MA_PREVIEW_ORIGIN = 'http://127.0.0.1:8080';
    process.env.MA_CONSOLE_ORIGIN = 'https://console.example.com';
    const { config } = loadConfig();
    assert.equal(config.artifacts.previewOrigin, 'http://127.0.0.1:8080');
  });
});

describe('secrets', () => {
  test('the model key can come from a file, so it never has to sit on a command line', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'ma-config-'));
    try {
      await writeFile(join(dir, 'key'), 'sk-or-from-file\n');
      delete process.env.MA_OPENROUTER_API_KEY;
      process.env.MA_OPENROUTER_API_KEY_FILE = join(dir, 'key');
      const { config } = loadConfig();
      assert.equal(config.model?.provider, 'openrouter');
      assert.equal(config.model?.apiKey, 'sk-or-from-file', 'read and trimmed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a short bootstrap token is called out: it becomes a permanent platform-admin key', () => {
    process.env.MA_BOOTSTRAP_TOKEN = 's3cret';
    const { warnings } = loadConfig();
    assert.ok(warnings.some((w) => /MA_BOOTSTRAP_TOKEN/.test(w) && /short/.test(w)));
  });
});

describe('connector delivery settings', () => {
  test('deliveries run one at a time unless MA_DELIVERY_CONCURRENCY says otherwise', () => {
    delete process.env.MA_DELIVERY_CONCURRENCY;
    assert.equal(loadConfig().config.scheduler.deliveryConcurrency, 1);
    process.env.MA_DELIVERY_CONCURRENCY = '8';
    assert.equal(loadConfig().config.scheduler.deliveryConcurrency, 8);
  });

  test('a concurrency of zero, a negative one, or an unbounded one is refused with the range', () => {
    for (const value of ['0', '-2', '65', '2.5']) {
      process.env.MA_DELIVERY_CONCURRENCY = value;
      assert.throws(
        () => loadConfig(),
        (error: unknown) => MaError.is(error) && /MA_DELIVERY_CONCURRENCY/.test(error.message),
        value,
      );
    }
  });

  test('hook callbacks are off unless origins are listed, and each must be a bare origin', () => {
    delete process.env.MA_HOOK_CALLBACK_ORIGINS;
    assert.deepEqual(loadConfig().config.hookCallbackOrigins, []);
    process.env.MA_HOOK_CALLBACK_ORIGINS = 'https://hooks.example.com, http://127.0.0.1:9999/';
    assert.deepEqual(loadConfig().config.hookCallbackOrigins, ['https://hooks.example.com', 'http://127.0.0.1:9999']);
    for (const bad of ['https://hooks.example.com/cb', 'ftp://files.example.com', 'https://user:pw@hooks.example.com', 'hooks']) {
      process.env.MA_HOOK_CALLBACK_ORIGINS = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) => MaError.is(error) && /MA_HOOK_CALLBACK_ORIGINS expects http\(s\) origins/.test(error.message),
        bad,
      );
    }
  });

  test('MA_DATABASE may be a postgres:// URL, its password in MA_DATABASE_PASSWORD_FILE, checked at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-config-'));
    try {
      const file = join(dir, 'pg-password');
      writeFileSync(file, 'pg-secret\n');
      process.env.MA_DATABASE = 'postgres://ma@db.internal/agents?sslmode=verify-full&schema=tenant_a';
      process.env.MA_DATABASE_PASSWORD_FILE = file;
      const { config } = loadConfig();
      assert.equal(config.databaseUrl, 'postgres://ma@db.internal/agents?sslmode=verify-full&schema=tenant_a');
      assert.equal(config.databasePassword, 'pg-secret');

      const refused = (pattern: RegExp) => (error: unknown) => MaError.is(error) && pattern.test(error.message) && !error.message.includes('pg-secret') && !error.message.includes('inline-secret');
      process.env.MA_DATABASE = 'postgres://ma:inline-secret@db/agents';
      assert.throws(() => loadConfig(), refused(/given twice/));
      process.env.MA_DATABASE_PASSWORD_FILE = join(dir, 'missing');
      process.env.MA_DATABASE = 'postgres://ma@db/agents';
      assert.throws(() => loadConfig(), refused(/MA_DATABASE_PASSWORD_FILE .* could not be read/));
      delete process.env.MA_DATABASE_PASSWORD_FILE;
      process.env.MA_DATABASE = 'postgres://ma@db/agents?sslmode=sometimes';
      assert.throws(() => loadConfig(), refused(/sslmode is "sometimes"/));
      process.env.MA_DATABASE = './data/agents.db';
      process.env.MA_DATABASE_PASSWORD_FILE = file;
      assert.throws(() => loadConfig(), refused(/MA_DATABASE_PASSWORD_FILE is set, but MA_DATABASE is not a postgres:\/\/ URL/));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('chat platforms are their public clouds unless an operator names another API base', () => {
    delete process.env.MA_SLACK_API_URL;
    delete process.env.MA_FEISHU_API_URL;
    delete process.env.MA_LARK_API_URL;
    assert.deepEqual(loadConfig().config.chatApis, {});

    process.env.MA_SLACK_API_URL = 'https://slack-gov.com/api/';
    process.env.MA_FEISHU_API_URL = ' https://feishu.internal.example ';
    assert.deepEqual(loadConfig().config.chatApis, { slack: 'https://slack-gov.com/api', feishu: 'https://feishu.internal.example' });

    for (const bad of ['slack-gov.com/api', 'ftp://slack.example/api', 'https://bot:hunter2@slack.example/api', 'https://slack.example/api?token=x']) {
      process.env.MA_SLACK_API_URL = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) => MaError.is(error) && /MA_SLACK_API_URL expects an absolute http\(s\) URL with no credentials, query or fragment/.test(error.message) && !error.message.includes('hunter2'),
        bad,
      );
    }
  });

  test("SQS connectors get the platform's AWS identity only where an operator allows it", () => {
    delete process.env.MA_SQS_AWS_IDENTITY;
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::123456789012:role/platform';
    let { config } = loadConfig();
    assert.equal(config.sqsAwsIdentity, undefined);
    assert.equal(config.awsEnvironment, undefined, 'unread when nothing may use it');

    process.env.MA_SQS_AWS_IDENTITY = 'assume-role';
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = '/var/run/secrets/eks.amazonaws.com/serviceaccount/token';
    process.env.AWS_REGION = '';
    ({ config } = loadConfig());
    assert.equal(config.sqsAwsIdentity, 'assume-role');
    assert.equal(config.awsEnvironment?.AWS_ROLE_ARN, 'arn:aws:iam::123456789012:role/platform');
    assert.equal(config.awsEnvironment?.AWS_WEB_IDENTITY_TOKEN_FILE, '/var/run/secrets/eks.amazonaws.com/serviceaccount/token');
    assert.equal(config.awsEnvironment?.AWS_REGION, undefined, 'empty is unset, as everywhere else in the config');

    process.env.MA_SQS_AWS_IDENTITY = 'yes';
    assert.throws(() => loadConfig(), (error: unknown) => MaError.is(error) && /MA_SQS_AWS_IDENTITY expects off, assume-role or direct/.test(error.message));
  });

  test('pull connectors reach nothing unless an operator lists where they may read', () => {
    delete process.env.MA_SQS_ENDPOINTS;
    delete process.env.MA_KAFKA_BROKERS;
    assert.deepEqual(loadConfig().config.sqsEndpoints, { aws: false, origins: [] });
    assert.deepEqual(loadConfig().config.kafkaBrokers, []);

    process.env.MA_SQS_ENDPOINTS = 'aws, http://elasticmq:9324/';
    process.env.MA_KAFKA_BROKERS = 'Kafka-1.internal:9092, *.msk.example.com:9096';
    const { config } = loadConfig();
    assert.deepEqual(config.sqsEndpoints, { aws: true, origins: ['http://elasticmq:9324'] });
    assert.deepEqual(config.kafkaBrokers, ['kafka-1.internal:9092', '*.msk.example.com:9096']);

    for (const bad of ['http://elasticmq:9324/000000000000/orders', 'sqs.eu-west-1.amazonaws.com', 'amazon']) {
      process.env.MA_SQS_ENDPOINTS = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) => MaError.is(error) && /MA_SQS_ENDPOINTS expects `aws` and\/or http\(s\) origins/.test(error.message),
        bad,
      );
    }
    delete process.env.MA_SQS_ENDPOINTS;
    for (const bad of ['kafka-1.internal', 'kafka:port', '*:9092', 'kafka-1.internal:9092/x']) {
      process.env.MA_KAFKA_BROKERS = bad;
      assert.throws(
        () => loadConfig(),
        (error: unknown) => MaError.is(error) && /MA_KAFKA_BROKERS expects host:port entries/.test(error.message),
        bad,
      );
    }
  });
});

describe('local-driver egress', () => {
  test('warns by default, enforces on request, and refuses anything else naming both choices', () => {
    delete process.env.MA_LOCAL_EGRESS;
    assert.equal(loadConfig().config.sandbox.localEgress, 'warn');
    process.env.MA_LOCAL_EGRESS = 'enforce';
    assert.equal(loadConfig().config.sandbox.localEgress, 'enforce');
    process.env.MA_LOCAL_EGRESS = 'strict';
    assert.throws(
      () => loadConfig(),
      (error: unknown) => MaError.is(error) && /MA_LOCAL_EGRESS must be 'warn' or 'enforce', got 'strict'/.test(error.message),
    );
  });
});

describe('the managed egress proxy secret', () => {
  test('is optional, and when set must be long enough to sign grants with', () => {
    delete process.env.MA_EGRESS_PROXY_SECRET;
    assert.equal(loadConfig().config.sandbox.egressProxySecret, undefined);
    process.env.MA_EGRESS_PROXY_SECRET = 'x'.repeat(40);
    assert.equal(loadConfig().config.sandbox.egressProxySecret, 'x'.repeat(40));
    process.env.MA_EGRESS_PROXY_SECRET = 'too-short';
    assert.throws(
      () => loadConfig(),
      (error: unknown) => MaError.is(error) && /at least 32 characters.*got 9.*same value/.test(error.message),
    );
  });
});

describe('the NetworkPolicy enforcement check', () => {
  test('is on by default with busybox, takes another image, and can be turned off', () => {
    delete process.env.MA_K8S_NETWORK_POLICY_CHECK;
    delete process.env.MA_K8S_PROBE_IMAGE;
    assert.equal(loadConfig().config.sandbox.k8sNetworkPolicyProbeImage, 'busybox:1.36');
    process.env.MA_K8S_PROBE_IMAGE = 'registry.internal/busybox:1.36';
    assert.equal(loadConfig().config.sandbox.k8sNetworkPolicyProbeImage, 'registry.internal/busybox:1.36');
    process.env.MA_K8S_NETWORK_POLICY_CHECK = 'off';
    assert.equal(loadConfig().config.sandbox.k8sNetworkPolicyProbeImage, undefined);
    process.env.MA_K8S_NETWORK_POLICY_CHECK = 'maybe';
    assert.throws(() => loadConfig(), (error: unknown) => MaError.is(error) && /MA_K8S_NETWORK_POLICY_CHECK must be 'on' or 'off'/.test(error.message));
  });
});
