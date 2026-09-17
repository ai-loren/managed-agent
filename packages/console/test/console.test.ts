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

  test('does not offer live controls on a finished session', () => {
    // A terminated or failed session rejects interrupt, terminate and send, so
    // the console must render it read-only rather than present controls whose
    // only outcome is a server rejection banner. The script is inlined, so the
    // guard is asserted on the shipped document.
    const html = renderConsole();
    assert.match(
      html,
      /session\.status === 'terminated' \|\| session\.status === 'failed'/,
      'the session view must detect a terminal status',
    );
    // The composer, interrupt and terminate wiring all live behind the guard.
    assert.match(html, /if \(!terminal\)/, 'live controls must be gated on a non-terminal status');
  });

  test('refreshes the session header as turns complete', () => {
    // The status/turns/tokens header is a load-time snapshot; without a live
    // refresh it reads stale (queued / 0 / 0) while the event log fills in. The
    // header cells carry stable ids and a settling event repaints them.
    const html = renderConsole();
    assert.ok(html.includes('id="s-turns"'), 'the turns cell must be addressable for refresh');
    assert.ok(html.includes('id="s-tokens"'), 'the tokens cell must be addressable for refresh');
    assert.ok(html.includes('id="s-status"'), 'the status cell must be addressable for refresh');
    assert.ok(html.includes('function refreshHeader'), 'the header must refresh from fresh session data');
  });

  test('reconnects its event stream from the last sequence seen', () => {
    const html = renderConsole();
    assert.ok(html.includes('fromSeq='));
    assert.ok(
      html.includes('event.seq + 1 > cursor'),
      'the cursor must advance past the event just rendered',
    );
    // The initial resume cursor must come from the last RENDERED event, not the
    // session tail (lastSeq + 1): history is capped at 500, so for a longer
    // session lastSeq is past what was rendered and starting there would skip the
    // 501..lastSeq range (the SSE replay from fromSeq backfills it otherwise).
    assert.ok(
      html.includes('const lastRendered = history.events.length'),
      'the resume cursor must derive from the last rendered event',
    );
    assert.ok(
      !html.includes('let cursor = history.lastSeq + 1'),
      'the cursor must not start at the session tail, which would skip un-fetched history',
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
