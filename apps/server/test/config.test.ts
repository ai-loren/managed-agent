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

  test('refuses a preview origin equal to a non-loopback API origin', () => {
    process.env.MA_CONTROL_PLANE_URL = 'https://api.example.com';
    process.env.MA_PREVIEW_ORIGIN = 'https://api.example.com';
    delete process.env.MA_CONSOLE_ORIGIN;
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

  test('a preview origin matching only the loopback control-plane URL is allowed', () => {
    // The default control-plane URL is internal loopback, not the public origin,
    // so a same-value preview origin there is not the real same-origin risk.
    process.env.MA_CONTROL_PLANE_URL = 'http://127.0.0.1:8080';
    process.env.MA_PREVIEW_ORIGIN = 'http://127.0.0.1:8080';
    delete process.env.MA_CONSOLE_ORIGIN;
    const { config } = loadConfig();
    assert.equal(config.artifacts.previewOrigin, 'http://127.0.0.1:8080');
  });
});
