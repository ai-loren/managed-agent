/**
 * Console tests.
 *
 * The console renders agent output — including whatever an agent read from a
 * hostile file — so the escaping is the part worth testing. Everything else is
 * markup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderConsole } from '../src/index.ts';

describe('console document', () => {
  test('renders a complete HTML document', () => {
    const html = renderConsole({ version: '1.2.3' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<title>Managed-Agent</title>'));
    assert.ok(html.includes('v1.2.3'));
  });

  test('ships its styles and script inline, with no external references', () => {
    // A single self-contained document means the gateway serves it with no
    // static asset resolution, and a strict CSP costs nothing.
    const html = renderConsole();
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('<script>'));
    assert.equal(/<script[^>]+src=/.test(html), false, 'no external script');
    assert.equal(/<link[^>]+href=/.test(html), false, 'no external stylesheet');
  });

  test('its stream parser rejects frames that are not session events', () => {
    // The console, the SDK and the bridge each parse this wire format
    // separately, and all three assumed every `data:` frame was a session
    // event. `stream.lagged` is a notice about the stream — no sequence, and
    // no `type` in its body — so it reached `append()`, which calls
    // `event.type.startsWith(...)` immediately and threw into a catch that
    // swallowed it.
    //
    // The script is an inlined string, so the guard is asserted on the shipped
    // document rather than by calling it.
    const html = renderConsole();
    assert.match(
      html,
      /Number\.isInteger\(event\.seq\)/,
      'the console must check a frame carries a sequence before using it',
    );
    assert.match(html, /typeof event\.type !== 'string'/);
  });

  test('escapes the version rather than interpolating it raw', () => {
    const html = renderConsole({ version: '<img src=x onerror=alert(1)>' });
    assert.equal(html.includes('<img src=x'), false);
    assert.ok(html.includes('&lt;img'));
  });

  test('offers the views an operator needs', () => {
    const html = renderConsole();
    for (const view of ['workspaces', 'agents', 'sessions', 'session']) {
      assert.ok(html.includes(`data-view="${view}"`), `${view} must be reachable`);
    }
  });

  test('routes every rendered value through an escaper', () => {
    // Agent output reaches this page. The script must never build markup from
    // a raw value.
    const html = renderConsole();
    assert.ok(html.includes('function escapeHtml'));
    assert.ok(html.includes("replaceAll('<', '&lt;')"));
  });

  test('confirms before an irreversible action', () => {
    const html = renderConsole();
    assert.ok(html.includes('confirm('), 'terminating must not be one click away');
  });

  test('reconnects its event stream from the last sequence seen', () => {
    const html = renderConsole();
    assert.ok(html.includes('fromSeq='));
    assert.ok(
      html.includes('event.seq + 1 > cursor'),
      'the cursor must advance past the event just rendered',
    );
  });

  test('closes the stream when leaving the session view', () => {
    // Otherwise every visit leaks a connection.
    const html = renderConsole();
    assert.ok(html.includes("state.stream.abort()"));
  });

  test('adapts to a dark colour scheme', () => {
    const html = renderConsole();
    assert.ok(html.includes('prefers-color-scheme: dark'));
  });
});
