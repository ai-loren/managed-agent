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

  test('tears down the live stream when the session reaches a terminal event', () => {
    // A session watched live can terminate, fail or expire while the stream is
    // open. The bridge keeps the SSE connection open until the client leaves, so
    // if the watcher only breaks on reader-done/abort it holds the connection
    // open forever with a misleading "live" badge for a session that will never
    // emit again. The watcher must detect a terminal event and stop the stream.
    // The script is inlined, so the teardown is asserted on the shipped document.
    const html = renderConsole();
    assert.match(html, /function endLive|const endLive/, 'the watcher must have a live-teardown path');
    // All three terminal event types must trigger it — a session can end by
    // termination, failure, or expiry (contracts/events.ts).
    assert.match(html, /session\.terminated/, 'termination must end the live stream');
    assert.match(html, /session\.failed/, 'failure must end the live stream');
    assert.match(html, /session\.expired/, 'expiry must end the live stream');
  });

  test('does not reopen a live stream when the terminal event is in the fetched history', () => {
    // A race: the session-status snapshot (read first) can still say non-terminal
    // while the history fetched a moment later already contains the terminal event.
    // append() then calls endLive() during replay, but the terminal guard checked
    // only the stale snapshot — so the watcher would open a fresh stream on a dead
    // session, flipping the badge back to "live". The stream-open guard must also
    // respect the teardown that happened during replay.
    const html = renderConsole();
    assert.match(
      html,
      /if \(terminal \|\| ended\)/,
      'the stream-open guard must also stop when a terminal event was seen during history replay',
    );
  });

  test('an aborted stream does not fall through to the reconnect path', () => {
    // endLive() aborts the controller mid-read. When the reader loop unwinds it
    // must not overwrite the "ended" badge with "reconnecting…" and sleep — that
    // path is only for a genuine drop. The reconnect tail is gated on the abort.
    const html = renderConsole();
    assert.match(
      html,
      /if \(controller\.signal\.aborted\) return;\s*\n\s*live\.classList\.add\('off'\);\s*\n\s*live\.textContent = 'reconnecting…';/,
      'the reconnect tail must return early when the stream was aborted',
    );
  });

  test('adapts to a dark colour scheme', () => {
    const html = renderConsole();
    assert.ok(html.includes('prefers-color-scheme: dark'));
  });

  test('offers a log-search box on the session view', () => {
    // The searchable-run-logs backend accepts `q`; the console must surface it or
    // the capability is invisible to the operator. A search input plus the two
    // functions that drive it must be present in the shipped script.
    const html = renderConsole();
    assert.ok(html.includes('id="log-search"'), 'a search input must exist');
    assert.match(html, /function performSearch/, 'a performSearch driver must exist');
    assert.match(html, /function clearSearch/, 'a clearSearch driver must exist');
  });

  test('search fetches history filtered by an URL-encoded q and clears the log first', () => {
    const html = renderConsole();
    assert.ok(
      html.includes("&q=' + encodeURIComponent("),
      'the query must be URL-encoded into the events fetch',
    );
    assert.ok(
      html.includes("events.innerHTML = ''"),
      'the live log must be cleared before rendering the (read-only) matches',
    );
    assert.ok(html.includes('escapeHtml(query)'), 'the echoed query must be escaped, not raw');
  });

  test('log search is available on a finished session, not gated behind terminal state', () => {
    // A terminated/failed session's log is exactly what an operator wants to
    // search, so the search row must be emitted unconditionally — after both the
    // terminal branch and the non-terminal composer, before the event log, and its
    // wiring outside the `if (!terminal)` gate.
    const html = renderConsole();
    const searchAt = html.indexOf('id="log-search"');
    assert.ok(searchAt > -1, 'the search input must be present');
    assert.ok(html.indexOf('cannot be resumed.') < searchAt, 'after the terminal branch');
    assert.ok(html.indexOf('id="msg"') < searchAt, 'after the non-terminal composer');
    assert.ok(searchAt < html.indexOf('id="events"'), 'before the event log');
    assert.ok(searchAt < html.indexOf('if (!terminal)'), 'wiring is not gated on terminal state');
  });

  test('its inlined script still parses (no stray backtick or apostrophe)', () => {
    // The whole app is a String.raw template; a literal backtick or an apostrophe
    // inside a single-quoted string would terminate it. Parse the shipped script
    // (body not run) to catch that class of mistake.
    const html = renderConsole();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.ok(script.length > 0, 'the document must carry an inline script');
    assert.doesNotThrow(() => new Function(script));
  });

  test('shows the model a session uses, with a free/paid tag', () => {
    // The model decides speed, capability and cost, but it lives on the pinned
    // version, not the session row — so the view must fetch it rather than make
    // the operator read the event log. The `:free` suffix is the visible half of
    // the free-only deployment guard.
    const html = renderConsole();
    assert.ok(html.includes('id="s-model"'), 'the model cell must be present');
    assert.match(html, /\/versions\/' \+ session\.resolvedVersion/, 'it must read the pinned version');
    assert.match(html, /endsWith\(':free'\)/, 'a free model must be tagged from its id');
    assert.ok(html.includes('tag free') && html.includes('tag paid'));
    // A failure to read the version must not break the page.
    assert.match(html, /catch \{\s*model = undefined;/, 'a version fetch failure is non-fatal');
  });

  test('surfaces failover in the event log instead of hiding it', () => {
    // A fallback answering means the pinned model was unavailable; that explains
    // a slower or different reply and must be visible. Model events also carry no
    // free-text body, so their facts (id, latency, tokens) are shown explicitly.
    const html = renderConsole();
    assert.match(html, /event\.type\.startsWith\('model\.'\)/, 'model events get their own summary');
    assert.ok(html.includes('failover from '), 'a failover must be labelled');
    assert.ok(html.includes('modelNote || body'), 'the model summary must be shown when present');
  });

  test('lets an operator change a session\'s model in place', () => {
    // The session's model comes from its pinned version, which is immutable, so
    // switching it for one conversation needs its own control.
    const html = renderConsole();
    assert.ok(html.includes('id="change-model"'), 'the session view must offer a Change control');
    assert.match(html, /\/v1\/sessions\/.*\/model/, 'it must PUT the session model endpoint');
    assert.ok(html.includes('session.modelOverride'), 'an override must be shown as such');
    assert.ok(html.includes('session choice'), 'an override must be labelled, not silently swapped');
    // A terminal session runs nothing, so the control is not offered there.
    assert.match(html, /terminal \? '' : ' <button class="action" id="change-model"/);
    // The choice is picked from a list, not typed: a prompt() asking for a model
    // id made operators copy a string out of the message and hope.
    assert.ok(html.includes('<dialog>'), 'the picker must be a real dialog');
    assert.ok(html.includes('id="model-choice"'), 'the picker must offer a select');
    // The old free-text flow asked the operator to type an id; assert that
    // specific affordance is gone (the login token and template variables
    // legitimately still prompt).
    assert.equal(
      html.includes('Type a model id'),
      false,
      'the model picker must not ask for a typed id',
    );
    // Clearing is a first-class option, not an empty box to type into.
    assert.ok(html.includes('Version default'), 'going back to the version model is an option');
    assert.ok(html.includes('selected === \'\' ? null : selected'), 'clearing must send null');
  });

  test('offers a Models view for choosing a free model', () => {
    // The free-only default is only a choice if the operator can see what is
    // available; the view discovers the free models live and registers one.
    const html = renderConsole();
    assert.ok(html.includes('data-view="models"'), 'Models must be reachable from the nav');
    assert.match(html, /VIEWS = \{[\s\S]*models: renderModels/, 'the view must be routed');
    assert.ok(html.includes('data-add-model'), 'a free model must be addable from the view');
    // A provider that is unreachable must be reported, not rendered as empty.
    assert.ok(html.includes('freeError'), 'a discovery failure must be surfaced');
    // The tag distinguishes free from paid at a glance.
    assert.ok(html.includes('tag free') && html.includes('tag paid'));
  });
});
