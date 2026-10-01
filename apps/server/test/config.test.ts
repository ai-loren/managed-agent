/**
 * Config validation tests.
 *
 * `loadConfig` reads `process.env`, so these set and restore it around each
 * case. The focus is the security-relevant refusals — a config that reads as
 * safe but is not should fail to start, not warn.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

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
});
