/**
 * Artifact preview tests.
 *
 * Preview is the one path that renders agent-authored bytes in a browser, so
 * these are almost entirely about the two things that make that safe: a signed,
 * expiring token gates every render, and the render only ever happens on a
 * separate origin under a locked-down CSP. The `previewContentType` cases pin
 * the one function permitted to name a renderable type.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryKeyProvider, MaError, TestClock } from '@ma/core';

import { PreviewService, previewContentType } from '../src/index.ts';

const START = 1_700_000_000_000;
const encoder = new TextEncoder();

let clock: TestClock;

function service(over: { previewOrigin?: string; consoleOrigin?: string } = {}) {
  return new PreviewService({
    clock,
    keys: InMemoryKeyProvider.generate(),
    previewOrigin: 'previewOrigin' in over ? over.previewOrigin : 'https://artifacts.test',
    ...(over.consoleOrigin ? { consoleOrigin: over.consoleOrigin } : {}),
    ttlSeconds: 300,
  });
}

beforeEach(() => {
  clock = new TestClock(START);
});

describe('token minting and verification', () => {
  test('a freshly minted token verifies', () => {
    const preview = service();
    const { url } = preview.mint('ar_1');
    const parsed = new URL(url);
    const exp = Number(parsed.searchParams.get('exp'));
    const nonce = parsed.searchParams.get('nonce')!;
    const sig = parsed.searchParams.get('sig')!;

    assert.ok(url.startsWith('https://artifacts.test/preview/v1/ar_1?'));
    assert.equal(preview.verify('ar_1', exp, nonce, sig), true);
  });

  test('a token for one artifact does not verify for another', () => {
    // The signature binds the artifact id, so a token cannot be pointed at a
    // different artifact than the one it was minted for.
    const preview = service();
    const { url } = preview.mint('ar_1');
    const parsed = new URL(url);
    assert.equal(
      preview.verify(
        'ar_2',
        Number(parsed.searchParams.get('exp')),
        parsed.searchParams.get('nonce')!,
        parsed.searchParams.get('sig')!,
      ),
      false,
    );
  });

  test('a tampered signature does not verify', () => {
    const preview = service();
    const { url } = preview.mint('ar_1');
    const parsed = new URL(url);
    assert.equal(
      preview.verify(
        'ar_1',
        Number(parsed.searchParams.get('exp')),
        parsed.searchParams.get('nonce')!,
        'deadbeef',
      ),
      false,
    );
  });

  test('an expired token does not verify', async () => {
    const preview = service();
    const { url } = preview.mint('ar_1');
    const parsed = new URL(url);
    await clock.advance(301_000); // past the 300s TTL
    assert.equal(
      preview.verify(
        'ar_1',
        Number(parsed.searchParams.get('exp')),
        parsed.searchParams.get('nonce')!,
        parsed.searchParams.get('sig')!,
      ),
      false,
    );
  });

  test('a token minted by a different key does not verify', () => {
    const a = service();
    const b = service(); // a fresh key
    const { url } = a.mint('ar_1');
    const parsed = new URL(url);
    assert.equal(
      b.verify(
        'ar_1',
        Number(parsed.searchParams.get('exp')),
        parsed.searchParams.get('nonce')!,
        parsed.searchParams.get('sig')!,
      ),
      false,
    );
  });
});

describe('the separate-origin requirement', () => {
  test('minting is disabled when no preview origin is configured', () => {
    // There is no safe same-origin preview: refusing is the honest answer.
    const preview = service({ previewOrigin: undefined });
    assert.equal(preview.enabled, false);
    assert.throws(
      () => preview.mint('ar_1'),
      (error: unknown) => MaError.is(error) && error.code === 'PREVIEW_DISABLED',
    );
  });
});

describe('render headers', () => {
  test('the CSP sandboxes the content and restricts who may frame it', () => {
    const preview = service({ consoleOrigin: 'https://console.test' });
    const headers = preview.headers('text/html; charset=utf-8', 42);
    const csp = headers['content-security-policy']!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /sandbox/);
    assert.match(csp, /frame-ancestors https:\/\/console\.test/);
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['referrer-policy'], 'no-referrer');
  });

  test('with no console origin, nothing may frame the preview', () => {
    const preview = service();
    const csp = preview.headers('text/plain', 1)['content-security-policy']!;
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

describe('previewContentType', () => {
  test('offers HTML-looking text as HTML so a report renders', () => {
    assert.match(previewContentType(encoder.encode('<!DOCTYPE html><html><body>hi')), /text\/html/);
    assert.match(previewContentType(encoder.encode('<html><head></head>')), /text\/html/);
  });

  test('offers SVG as an image', () => {
    assert.equal(previewContentType(encoder.encode('<svg xmlns="...">')), 'image/svg+xml');
  });

  test('keeps a real image as its sniffed type', () => {
    assert.equal(previewContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
    assert.equal(previewContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46])), 'application/pdf');
  });

  test('leaves ordinary text as text', () => {
    assert.match(previewContentType(encoder.encode('just some notes')), /^text\/plain/);
  });

  test('leaves non-text bytes as an octet-stream', () => {
    assert.equal(
      previewContentType(new Uint8Array([0x00, 0x01, 0x02, 0x03])),
      'application/octet-stream',
    );
  });
});
