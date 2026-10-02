/**
 * The console application.
 *
 * Plain DOM, no framework. The console has one job — let an operator see what
 * agents are doing and intervene — and that job does not need a virtual DOM or
 * a build pipeline. Shipping it as a single module means the gateway serves it
 * directly, and it cannot rot when an unrelated toolchain moves on.
 *
 * The script is emitted as a string because it runs in the browser, not in
 * Node. Written this way it stays one reviewable artifact rather than a
 * separate asset tree with its own resolution rules.
 */

import { STYLES } from './styles.ts';

/**
 * The browser-side application.
 *
 * Escaping deserves a note: every value that reaches the DOM goes through
 * `text()` or `escapeHtml()`. An agent's own output ends up on this page, and
 * an agent that has read a hostile file is an untrusted source of HTML.
 */
const APP_SCRIPT = String.raw`
const state = {
  token: localStorage.getItem('ma.token') || '',
  view: 'workspaces',
  workspaceId: null,
  agentId: null,
  sessionId: null,
  stream: null,
  approvalsTimer: null,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + state.token,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = new Error((body && body.error && body.error.message) || response.statusText);
    error.code = body && body.error && body.error.code;
    throw error;
  }
  return body;
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function showError(message) {
  const main = document.querySelector('main');
  const existing = main.querySelector('.error-banner');
  if (existing) existing.remove();
  main.prepend(el('<div class="error-banner">' + escapeHtml(message) + '</div>'));
}

function relative(ms) {
  if (!ms) return '-';
  const delta = Date.now() - ms;
  if (delta < 60000) return Math.round(delta / 1000) + 's ago';
  if (delta < 3600000) return Math.round(delta / 60000) + 'm ago';
  if (delta < 86400000) return Math.round(delta / 3600000) + 'h ago';
  return new Date(ms).toISOString().slice(0, 10);
}

function statusCell(status) {
  return '<span class="status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
}

function table(columns, rows, renderRow) {
  if (rows.length === 0) return '<div class="empty">Nothing here yet.</div>';
  return (
    '<table><thead><tr>' +
    columns.map((c) => '<th>' + escapeHtml(c) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map(renderRow).join('') +
    '</tbody></table>'
  );
}

// --- approvals -------------------------------------------------------------

// A tool call waiting on a person, with what it would run. The arguments are
// the point of the card — approving the call approves them — so they are shown
// whole up to a limit, escaped like every other value an agent produced.
function approvalCard(approval, options = {}) {
  const input = JSON.stringify(approval.input, null, 2);
  const shown = input.length > 2000 ? input.slice(0, 2000) + '\n… (' + input.length + ' characters)' : input;
  const minutes = Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 60000));
  return (
    '<div class="approval" data-approval="' + escapeHtml(approval.id) + '" data-session="' + escapeHtml(approval.sessionId) + '">' +
    '<div class="approval-head">' +
    '<span class="tag waiting">waiting for approval</span>' +
    '<strong>' + escapeHtml(approval.toolName) + '</strong>' +
    (options.showSession ? '<span class="id">' + escapeHtml(approval.sessionId) + '</span>' : '') +
    '<span class="muted expires">denied in ' + minutes + ' min if no one decides</span>' +
    '</div>' +
    (approval.reason ? '<div class="muted">' + escapeHtml(approval.reason) + '</div>' : '') +
    '<pre class="approval-input">' + escapeHtml(shown) + '</pre>' +
    '<div class="row">' +
    (options.showSession
      ? '<button class="action" data-watch-approval="' + escapeHtml(approval.sessionId) + '">Watch session</button>'
      : '') +
    '<span style="flex:1"></span>' +
    '<button class="action danger" data-decide="deny">Deny</button>' +
    '<button class="action primary" data-decide="approve">Approve</button>' +
    '</div>' +
    '</div>'
  );
}

// Approve or deny from a card. A denial asks why, because the agent reads the
// answer as the call's result; leaving it empty is allowed but tells it less.
function wireApprovals(container, onDecided) {
  container.querySelectorAll('[data-decide]').forEach((button) => {
    button.addEventListener('click', async () => {
      const card = button.closest('[data-approval]');
      const decision = button.dataset.decide;
      let reason = '';
      if (decision === 'deny') {
        const answer = prompt('Why not? The agent reads this as the result of the call.', '');
        if (answer === null) return;
        reason = answer;
      }
      card.querySelectorAll('button').forEach((each) => {
        each.disabled = true;
      });
      try {
        await api(
          '/v1/sessions/' + encodeURIComponent(card.dataset.session) +
            '/approvals/' + encodeURIComponent(card.dataset.approval) + '/decision',
          { method: 'POST', body: JSON.stringify({ decision, reason }) },
        );
      } catch (error) {
        showError(error.message || 'Could not record the decision');
      }
      onDecided();
    });
  });
  container.querySelectorAll('[data-watch-approval]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sessionId = button.dataset.watchApproval;
      navigate('session');
    });
  });
}

// --- views -----------------------------------------------------------------

async function renderWorkspaces(main) {
  const page = await api('/v1/workspaces');
  main.innerHTML =
    '<h2>Workspaces</h2>' +
    table(['Name', 'Slug', 'Status', 'Created', ''], page.items, (workspace) =>
      '<tr>' +
      '<td>' + escapeHtml(workspace.name) + '</td>' +
      '<td class="id">' + escapeHtml(workspace.slug) + '</td>' +
      '<td>' + statusCell(workspace.status) + '</td>' +
      '<td>' + relative(workspace.createdAt) + '</td>' +
      '<td><button class="action" data-open="' + escapeHtml(workspace.id) + '">Open</button></td>' +
      '</tr>',
    );

  main.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', () => {
      state.workspaceId = button.dataset.open;
      navigate('agents');
    });
  });
}

async function renderAgents(main) {
  if (!state.workspaceId) {
    main.innerHTML = '<div class="empty">Choose a workspace first.</div>';
    return;
  }

  const [page, quota] = await Promise.all([
    api('/v1/workspaces/' + state.workspaceId + '/agents'),
    api('/v1/workspaces/' + state.workspaceId + '/quota').catch(() => null),
  ]);

  let html = '<h2>Agents</h2>';

  if (quota) {
    html += '<div class="cards">' + quota.usage.map((entry) => {
      const ratio = entry.limit > 0 ? entry.observed / entry.limit : 0;
      const level = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : '';
      return (
        '<div class="card">' +
        '<div class="label">' + escapeHtml(entry.dimension) + '</div>' +
        '<div class="value">' + entry.observed.toLocaleString() + '</div>' +
        '<div class="sub">of ' + entry.limit.toLocaleString() + '</div>' +
        '<div class="meter ' + level + '"><div style="width:' +
        Math.min(100, Math.round(ratio * 100)) + '%"></div></div>' +
        '</div>'
      );
    }).join('') + '</div>';
  }

  html += table(['Name', 'Version', 'Production', 'Status', ''], page.items, (agent) =>
    '<tr>' +
    '<td>' + escapeHtml(agent.name) + '</td>' +
    '<td class="id">v' + agent.latestVersion + '</td>' +
    '<td class="id">' + (agent.productionVersion ? 'v' + agent.productionVersion : '-') + '</td>' +
    '<td>' + statusCell(agent.status) + '</td>' +
    '<td>' +
    '<button class="action" data-start="' + escapeHtml(agent.id) + '">Start session</button> ' +
    '<button class="action" data-sessions="' + escapeHtml(agent.id) + '">Sessions</button>' +
    '</td>' +
    '</tr>',
  );

  main.innerHTML = html;

  main.querySelectorAll('[data-start]').forEach((button) => {
    button.addEventListener('click', async () => {
      // A version-0 agent has nothing to run; the API would reject it, so say so
      // plainly rather than surface a raw error.
      button.disabled = true;
      try {
        const { session } = await api('/v1/sessions', {
          method: 'POST',
          body: JSON.stringify({ agentId: button.dataset.start }),
        });
        state.sessionId = session.id;
        navigate('session');
      } catch (error) {
        button.disabled = false;
        showError(error.message || 'Could not start a session');
      }
    });
  });

  main.querySelectorAll('[data-sessions]').forEach((button) => {
    button.addEventListener('click', () => {
      state.agentId = button.dataset.sessions;
      navigate('sessions');
    });
  });
}

async function renderTemplates(main) {
  if (!state.workspaceId) {
    main.innerHTML = '<div class="empty">Choose a workspace first.</div>';
    return;
  }

  const page = await api('/v1/workspaces/' + state.workspaceId + '/templates');
  let html = '<h2>Templates</h2>';
  if (page.items.length === 0) {
    html += '<div class="empty">No templates yet.</div>';
  } else {
    html += table(
      ['Name', 'Category', 'Source', 'Variables', ''],
      page.items,
      (template) =>
        '<tr>' +
        '<td>' + escapeHtml(template.name) + '</td>' +
        '<td class="id">' + escapeHtml(template.category) + '</td>' +
        '<td>' + (template.builtin ? 'built-in' : 'workspace') + '</td>' +
        '<td class="id">' +
        escapeHtml(template.variables.map((variable) => variable.key).join(', ') || '—') +
        '</td>' +
        '<td><button class="action" data-instantiate="' + escapeHtml(template.id) + '">Use</button></td>' +
        '</tr>',
    );
  }

  main.innerHTML = html;
  main.querySelectorAll('[data-instantiate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const template = page.items.find((entry) => entry.id === button.dataset.instantiate);
      // Collect required variables through a prompt each — enough for the console,
      // which is a read-mostly operator surface; the CLI and SDK take a file.
      const variables = {};
      for (const variable of template.variables) {
        const supplied = prompt(
          'Value for "' + variable.key + '"' + (variable.required ? ' (required)' : '') +
          (variable.options.length ? ' [' + variable.options.join(', ') + ']' : ''),
          variable.default != null ? String(variable.default) : '',
        );
        if (supplied === null) return;
        if (supplied !== '') variables[variable.key] = supplied;
      }
      try {
        await api(
          '/v1/workspaces/' + state.workspaceId + '/templates/' + template.id + '/instantiate',
          { method: 'POST', body: JSON.stringify({ variables }) },
        );
        navigate('agents');
      } catch (error) {
        showError(error.message || 'Could not create the agent');
      }
    });
  });
}

async function renderSessions(main) {
  const query = state.agentId
    ? '?agentId=' + encodeURIComponent(state.agentId)
    : '?workspaceId=' + encodeURIComponent(state.workspaceId || '');
  const page = await api('/v1/sessions' + query);

  main.innerHTML =
    '<h2>Sessions</h2>' +
    table(['Session', 'Status', 'Version', 'Turns', 'Tokens', 'Activity', ''], page.items, (session) =>
      '<tr>' +
      '<td class="id">' + escapeHtml(session.id.slice(0, 14)) + '…</td>' +
      '<td>' + statusCell(session.status) + '</td>' +
      '<td class="id">v' + session.resolvedVersion + '</td>' +
      '<td>' + session.turnCount + '</td>' +
      '<td>' + (session.usage.inputTokens + session.usage.outputTokens).toLocaleString() + '</td>' +
      '<td>' + relative(session.lastActivityAt || session.createdAt) + '</td>' +
      '<td><button class="action" data-watch="' + escapeHtml(session.id) + '">Watch</button></td>' +
      '</tr>',
    );

  main.querySelectorAll('[data-watch]').forEach((button) => {
    button.addEventListener('click', () => {
      state.sessionId = button.dataset.watch;
      navigate('session');
    });
  });
}

/**
 * A single session: its details, its live event stream, and the controls to
 * intervene. This is the page an operator actually sits on.
 */
async function renderSession(main) {
  if (!state.sessionId) {
    main.innerHTML = '<div class="empty">Choose a session first.</div>';
    return;
  }

  const { session } = await api('/v1/sessions/' + state.sessionId);

  // The model a session actually calls is a core fact about the run — it decides
  // speed, capability and (for a metered provider) cost — yet it lives on the
  // pinned version, not the session row. Fetch it so the operator does not have
  // to dig through the event log to answer "what is this using?". A failure here
  // is non-fatal: the rest of the page is still useful.
  let model;
  try {
    const { version } = await api(
      '/v1/agents/' + encodeURIComponent(session.agentId) +
        '/versions/' + session.resolvedVersion,
    );
    model = version && version.model;
  } catch {
    model = undefined;
  }
  const modelId = model && typeof model.modelId === 'string' ? model.modelId : '';
  const fallbacks = model && Array.isArray(model.fallbackModelIds)
    ? model.fallbackModelIds.filter((id) => typeof id === 'string')
    : [];
  // A model is free only as a :free variant (the server also requires a zero
  // price), so the tag is the visible half of the free-only deployment guard: an
  // operator can confirm at a glance the platform is not spending money.
  const tagFor = (id) =>
    id.endsWith(':free')
      ? '<span class="tag free">free</span>'
      : id
        ? '<span class="tag paid">paid</span>'
        : '';

  // A finished session accepts no interrupt, terminate or message — the server
  // rejects all three — so it is shown read-only rather than offering controls
  // whose only outcome is an error banner. 'terminated' and 'failed' are the
  // terminal states of the session machine (contracts/lifecycle.ts). ended turns
  // true when the session finishes while it is being watched (see endLive).
  const terminal = session.status === 'terminated' || session.status === 'failed';
  let ended = false;

  // Say plainly which model is in use and, when they differ, which one the agent
  // would use without this session's override. The tag and the fallbacks belong
  // to the session either way: failover still walks the version's fallbacks.
  // Re-rendered when the override changes under the operator (see refreshHeader).
  function modelCell(override) {
    if (!modelId) return '<span class="muted">unknown</span>';
    const inUse = override || modelId;
    return (
      'Using ' + escapeHtml(inUse) + ' ' + tagFor(inUse) +
      (override ? '<span class="tag changed">changed for this session</span>' : '') +
      (fallbacks.length > 0
        ? '<span class="muted"> · fallbacks: ' + escapeHtml(fallbacks.join(', ')) + '</span>'
        : '') +
      (override
        ? '<div class="muted">Agent default: ' + escapeHtml(modelId) +
          ' (this session only \u2014 the agent is unchanged)</div>'
        : '') +
      // A finished session runs nothing, so there is nothing to change; the
      // control is omitted rather than offered and then rejected.
      (terminal || ended ? '' : ' <button class="action" id="change-model">Change</button>')
    );
  }
  let shownOverride = session.modelOverride || '';

  main.innerHTML =
    '<h2>Session</h2>' +
    '<dl class="detail">' +
    '<dt>id</dt><dd>' + escapeHtml(session.id) + '</dd>' +
    '<dt>status</dt><dd id="s-status">' + statusCell(session.status) + '</dd>' +
    '<dt>agent</dt><dd>' + escapeHtml(session.agentId) + ' @ v' + session.resolvedVersion + '</dd>' +
    '<dt>model</dt><dd id="s-model">' + modelCell(shownOverride) + '</dd>' +
    '<dt>turns</dt><dd id="s-turns">' + session.turnCount + '</dd>' +
    '<dt>tokens</dt><dd id="s-tokens">' +
      (session.usage.inputTokens + session.usage.outputTokens).toLocaleString() + '</dd>' +
    (session.error
      ? '<dt>error</dt><dd class="status failed">' +
        escapeHtml(session.error.code + ': ' + session.error.message) + '</dd>'
      : '') +
    '</dl>' +
    (terminal
      ? '<div class="row" style="margin-top:16px">' +
        '<span class="live off" id="live">ended</span>' +
        '<span style="flex:1"></span>' +
        '<span class="muted">This session has ended and cannot be resumed.</span>' +
        '</div>'
      : '<div class="row" style="margin-top:16px">' +
        '<span class="live off" id="live">disconnected</span>' +
        '<span style="flex:1"></span>' +
        '<button class="action" id="interrupt">Interrupt</button>' +
        '<button class="action danger" id="terminate">Terminate</button>' +
        '</div>' +
        '<form class="row composer" id="composer" style="margin-top:12px">' +
        '<input id="msg" type="text" placeholder="Send a message to the agent…" ' +
        'autocomplete="off" style="flex:1;padding:8px 10px;font:inherit" />' +
        '<button class="action" id="send" type="submit">Send</button>' +
        '</form>') +
    // Tool calls this session's turn is paused on, above the log: an operator
    // watching the session is who the agent is waiting for.
    '<div id="approvals" style="margin-top:12px"></div>' +
    // Log search, emitted unconditionally (outside the terminal ternary) so a
    // finished session's log is searchable too. Static search: it re-fetches the
    // history filtered by the query and shows only matches read-only; Clear returns
    // to the live view. Placeholder carries no apostrophe (would close the string).
    '<form class="row" id="search-form" style="margin-top:12px">' +
    '<input id="log-search" type="search" placeholder="Search the event log…" autocomplete="off" />' +
    '<button class="action" id="log-search-go" type="submit">Search</button>' +
    '<button class="action" id="log-search-clear" type="button">Clear</button>' +
    '</form>' +
    '<div class="muted" id="search-status" style="margin-bottom:12px"></div>' +
    '<div class="events" id="events"></div>';

  const events = main.querySelector('#events');
  const live = main.querySelector('#live');

  // The calls still waiting, re-read whenever an approval event arrives rather
  // than patched from the event: a decision made elsewhere (another console,
  // the CLI, the expiry sweep) must clear the card here too. One read at a
  // time; an event arriving during a read asks for one more.
  const approvalsEl = main.querySelector('#approvals');
  const approvalsSession = state.sessionId;
  let approvalsReading = false;
  let approvalsStale = false;
  async function refreshApprovals() {
    if (approvalsReading) {
      approvalsStale = true;
      return;
    }
    approvalsReading = true;
    try {
      do {
        approvalsStale = false;
        const page = await api(
          '/v1/sessions/' + encodeURIComponent(approvalsSession) + '/approvals?statuses=pending',
        );
        if (state.view !== 'session' || state.sessionId !== approvalsSession) return;
        approvalsEl.innerHTML = page.items.length === 0
          ? ''
          : '<h3>Waiting for you</h3>' + page.items.map((approval) => approvalCard(approval)).join('');
        wireApprovals(approvalsEl, () => void refreshApprovals());
      } while (approvalsStale);
    } catch {
      // A failed read leaves the last cards up; the next approval event reads again.
    } finally {
      approvalsReading = false;
    }
  }

  // Change this session's model. Lists the models this workspace may use (its
  // own catalogue view), plus a way back to the version's model. The server
  // re-validates the id, so a stale list cannot select something unauthorized.
  // Wired again whenever the model cell is re-rendered.
  function wireChangeModel() {
    const changeModel = main.querySelector('#change-model');
    if (!changeModel) return;
    changeModel.addEventListener('click', async () => {
      // The session this click is about, fixed now: the dialog outlives a
      // navigation, and the change must not land on whichever session is open by
      // the time Apply is pressed.
      const sessionId = state.sessionId;
      changeModel.disabled = true;
      try {
        // The catalogue, not free text: an operator picks from what this
        // workspace may actually use. And the current choice is read now, not the
        // one rendered with the page: someone else (or the CLI) may have changed
        // it since, and Apply on an untouched picker must not put the old one back.
        const [{ models }, { session: fresh }] = await Promise.all([
          api('/v1/models?workspaceId=' + encodeURIComponent(session.workspaceId)),
          api('/v1/sessions/' + encodeURIComponent(sessionId)),
        ]);
        const current = fresh.modelOverride || '';
        // "Use the version's model" is the first option, so the default state
        // is expressible and clearing is a choice rather than an empty box.
        const options = [
          '<option value=""' + (current === '' ? ' selected' : '') + '>' +
            'Version default \u2014 ' + escapeHtml(modelId) + '</option>',
          ...models.map((m) =>
            '<option value="' + escapeHtml(m.id) + '"' + (m.id === current ? ' selected' : '') + '>' +
            escapeHtml(m.id) +
            (m.capabilities && m.capabilities.tools ? '' : ' \u2014 no tool support') +
            '</option>'),
        ].join('');

        const picker = el(
          '<dialog>' +
          '<form method="dialog">' +
          '<h3>Model for this session</h3>' +
          '<div class="muted">Affects this conversation only; the agent\u2019s version is unchanged.</div>' +
          '<select id="model-choice">' + options + '</select>' +
          '<div class="dialog-actions">' +
          '<button class="action" value="cancel">Cancel</button>' +
          '<button class="action" id="model-apply" value="apply">Apply</button>' +
          '</div>' +
          '</form>' +
          '</dialog>',
        );
        document.body.appendChild(picker);
        const applied = await new Promise((resolve) => {
          picker.addEventListener('close', () => resolve(picker.returnValue === 'apply'));
          picker.showModal();
        });
        const selected = picker.querySelector('#model-choice').value;
        picker.remove();
        if (!applied || selected === current) return;

        await api('/v1/sessions/' + encodeURIComponent(sessionId) + '/model', {
          method: 'PUT',
          body: JSON.stringify({ modelId: selected === '' ? null : selected }),
        });
        if (state.view === 'session' && state.sessionId === sessionId) navigate('session');
      } catch (error) {
        showError(error.message || 'Could not change the model');
      } finally {
        changeModel.disabled = false;
      }
    });
  }

  // --- log search ----------------------------------------------------------
  // A static, reversible search: pause the live stream, re-fetch the history
  // filtered by the query, and show only the matches read-only. Distinct from
  // endLive() (which retires the composer/controls for a session that has truly
  // ended) — this pause is undone by Clear, which re-renders back to live. The
  // live SSE feed takes no query, so filtering the live tail client-side would
  // diverge from the server's match semantics; hence a point-in-time query.
  const searchForm = main.querySelector('#search-form');
  const searchInput = main.querySelector('#log-search');
  const searchGo = main.querySelector('#log-search-go');
  const searchStatus = main.querySelector('#search-status');
  let searching = false;
  const SEARCH_PAGE = 500;

  // Newest matches first, shown oldest-first like the live log. One request
  // examines a bounded number of events, so the status says how far it got and
  // Search older carries on below the oldest event it reached.
  async function performSearch(beforeSeq) {
    const query = searchInput.value.trim();
    if (query.length === 0) {
      clearSearch();
      return;
    }
    // Stop the live stream: its reader returns at the abort guard, so it neither
    // appends nor reconnects while we show the filtered, read-only result.
    if (state.stream) {
      state.stream.abort();
      state.stream = null;
    }
    searching = true;
    searchGo.disabled = true;
    try {
      const results = await api(
        '/v1/sessions/' + state.sessionId + '/events?order=desc&limit=' + SEARCH_PAGE +
          '&q=' + encodeURIComponent(query) + (beforeSeq ? '&toSeq=' + beforeSeq : ''),
      );
      // Clear AFTER the await so any frame that landed mid-flight is wiped too.
      events.innerHTML = '';
      if (live) {
        live.classList.add('off');
        live.textContent = 'search';
      }
      const coverage = results.search || { scanned: 0, truncated: false };
      // Older matches may remain when the page filled up (the scan stopped at
      // the last match) or when the scan stopped at its per-request cap.
      const older = results.events.length === SEARCH_PAGE
        ? results.events[results.events.length - 1].seq
        : coverage.truncated ? coverage.resumeSeq : null;
      searchStatus.innerHTML =
        results.events.length + ' matching event(s) for &quot;' + escapeHtml(query) + '&quot;' +
        (beforeSeq ? ' before #' + beforeSeq : '') +
        ' · searched ' + coverage.scanned + ' event(s)' +
        (older
          ? ' · older events not searched yet <button class="action" id="search-older" type="button">Search older</button>'
          : ' · back to the start of the log');
      const olderButton = searchStatus.querySelector('#search-older');
      if (olderButton) olderButton.addEventListener('click', () => performSearch(older));
      if (results.events.length === 0) {
        events.appendChild(el('<div class="empty">No matching events.</div>'));
      } else {
        results.events.slice().reverse().forEach(append);
      }
    } catch (error) {
      showError(error.message || 'Search failed');
    } finally {
      searchGo.disabled = false;
    }
  }

  // Return to live. A full re-render is the cleanest reset: renderSession
  // re-fetches history (no q), builds a fresh closure (ended=false, new
  // AbortController) and reopens the stream. performSearch already aborted the old
  // stream, so nothing leaks. A no-op when nothing was searched.
  function clearSearch() {
    if (!searching && searchInput.value.trim().length === 0) return;
    navigate('session');
  }

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void performSearch();
  });
  main.querySelector('#log-search-clear').addEventListener('click', () => clearSearch());

  if (!terminal) {
    // Send a user message. The agent's reply arrives over the same SSE stream
    // opened below, so there is nothing to render here beyond clearing the box —
    // the message.completed / turn.* events flow into #events like any other.
    const composer = main.querySelector('#composer');
    const msg = main.querySelector('#msg');
    const send = main.querySelector('#send');
    composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = msg.value.trim();
      if (text.length === 0) return;
      send.disabled = true;
      msg.disabled = true;
      try {
        await api('/v1/sessions/' + state.sessionId + '/events', {
          method: 'POST',
          body: JSON.stringify({ events: [{ type: 'user.message', text }] }),
        });
        msg.value = '';
      } catch (error) {
        // A session that is not ready yet (still provisioning) rejects a submit;
        // say so rather than swallow it.
        showError(error.message || 'Could not send — is the session ready?');
      } finally {
        send.disabled = false;
        msg.disabled = false;
        msg.focus();
      }
    });

    main.querySelector('#interrupt').addEventListener('click', async () => {
      try {
        await api('/v1/sessions/' + state.sessionId + '/interrupt', {
          method: 'POST',
          body: JSON.stringify({ reason: 'interrupted from the console' }),
        });
      } catch (error) {
        showError(error.message);
      }
    });

    wireChangeModel();

    main.querySelector('#terminate').addEventListener('click', async () => {
      // Irreversible, so it is confirmed rather than one click away.
      if (!confirm('Terminate this session? Its sandbox is released and it cannot resume.')) return;
      try {
        await api('/v1/sessions/' + state.sessionId + '/terminate', {
          method: 'POST',
          body: JSON.stringify({ reason: 'terminated from the console' }),
        });
        navigate('session');
      } catch (error) {
        showError(error.message);
      }
    });
  }

  // The status/turns/tokens header is a snapshot taken at load. Turns complete
  // and usage accrues while the operator watches, so the header would otherwise
  // read stale (queued / 0 / 0) even as the event log fills in. When an event
  // that changes those numbers arrives, re-read the session and repaint just
  // those cells — cheaper than re-rendering the page, and it never disturbs the
  // event log or the composer focus.
  let refreshing = false;
  async function refreshHeader() {
    if (refreshing) return;
    refreshing = true;
    try {
      const { session: fresh } = await api('/v1/sessions/' + state.sessionId);
      const statusCellEl = main.querySelector('#s-status');
      const turnsEl = main.querySelector('#s-turns');
      const tokensEl = main.querySelector('#s-tokens');
      if (statusCellEl) statusCellEl.innerHTML = statusCell(fresh.status);
      if (turnsEl) turnsEl.textContent = String(fresh.turnCount);
      if (tokensEl) {
        tokensEl.textContent =
          (fresh.usage.inputTokens + fresh.usage.outputTokens).toLocaleString();
      }
      // The model can change under the operator (another console, the CLI); a
      // session.model_changed brings us here, and the cell must not keep claiming
      // the old one.
      const override = fresh.modelOverride || '';
      const modelEl = main.querySelector('#s-model');
      if (modelEl && override !== shownOverride) {
        shownOverride = override;
        modelEl.innerHTML = modelCell(override);
        wireChangeModel();
      }
    } catch {
      // A transient read failure just leaves the last good numbers up; the next
      // settling event refreshes again.
    } finally {
      refreshing = false;
    }
  }

  // A watched session can reach a terminal state (terminated / failed / expired)
  // while its live stream is open. The SSE bridge holds the connection open until
  // the client leaves, so without an explicit teardown the console would keep the
  // socket — and a misleading "live" badge — open forever for a session that will
  // never emit another event. On the terminal event, stop the stream, mark the
  // badge ended, and retire the live controls whose only outcome now is a server
  // rejection. Idempotent: several terminal-ish events (a fail then an expire) or
  // a re-entrant call must collapse to one teardown.
  function endLive() {
    if (ended) return;
    ended = true;
    if (state.stream) {
      state.stream.abort();
      state.stream = null;
    }
    if (live) {
      live.classList.add('off');
      live.textContent = 'ended';
    }
    const composer = main.querySelector('#composer');
    if (composer) composer.remove();
    main.querySelectorAll('#interrupt, #terminate, #change-model').forEach((button) => {
      button.disabled = true;
    });
  }

  // The terminal session events (contracts/events.ts). Any one means the session
  // machine has reached a state with no successors, so the live stream is done.
  const TERMINAL_EVENTS = ['session.terminated', 'session.failed', 'session.expired'];

  // One log line. Building it has no side effects, so an earlier page can be
  // rendered without re-running what a newly arrived event triggers.
  function eventElement(event) {
    const kind = event.type.startsWith('tool.')
      ? 'tool'
      : event.type.startsWith('turn.')
        ? 'turn'
        : event.type.startsWith('approval.')
          ? 'approval-event'
          : /fail|error|denied|lost/.test(event.type)
            ? 'error'
            : '';
    const payload = event.payload || {};
    const body =
      payload.text ?? payload.chunk ?? payload.toolName ?? payload.reason ??
      (payload.error && payload.error.message) ?? '';

    // Who decided and why is the record an approval leaves, so the line says it.
    const approvalNote =
      event.type === 'approval.requested'
        ? String(payload.toolName || '') + ' is waiting for approval' +
          (payload.reason ? ' \u2014 ' + payload.reason : '')
        : event.type === 'approval.decided'
          ? String(payload.decision || '') + (payload.by ? ' by ' + payload.by : '') +
            (payload.reason ? ' \u2014 ' + payload.reason : '')
          : '';

    // Make the model in play visible in the log itself. On model.completed the
    // answering model is the fact worth showing; a fallbackFrom means the
    // primary the session pinned was unavailable and a fallback answered, which
    // explains a slower or different reply and must not be silent.
    // On model.failed the reason is the point: after a failover it is the only
    // record of why the primary was passed over.
    const modelNote =
      event.type.startsWith('model.') && typeof payload.modelId === 'string'
        ? payload.modelId +
          (payload.durationMs !== undefined ? ' · ' + payload.durationMs + 'ms' : '') +
          (payload.usage && typeof payload.usage.outputTokens === 'number'
            ? ' · ' + payload.usage.outputTokens + ' out'
            : '') +
          (typeof payload.fallbackFrom === 'string'
            ? ' · failover from ' + payload.fallbackFrom
            : '') +
          (payload.error && typeof payload.error.message === 'string'
            ? ' · ' + payload.error.message
            : '')
        : '';

    return el(
      '<div class="event ' + kind + '">' +
      '<span class="seq">' + event.seq + '</span>' +
      '<span class="type">' + escapeHtml(event.type) + '</span>' +
      '<span class="body">' + escapeHtml(String(modelNote || approvalNote || body).slice(0, 500)) + '</span>' +
      '</div>',
    );
  }

  function append(event) {
    // Stay pinned to the bottom only if the operator already was: yanking the
    // view while they are reading history is worse than a stale scroll.
    const pinned = events.scrollHeight - events.scrollTop - events.clientHeight < 40;
    events.appendChild(eventElement(event));
    if (pinned) events.scrollTop = events.scrollHeight;

    // A turn ending changes turns and tokens; a session.* event changes status.
    // Refresh the header off those, not off every delta.
    if (event.type.startsWith('turn.') || event.type.startsWith('session.')) {
      void refreshHeader();
    }
    // A call starting or stopping its wait changes the cards above the log.
    if (event.type.startsWith('approval.')) void refreshApprovals();

    // A terminal session event is the last one this session will ever produce.
    // Tear the live stream down (after appending it and refreshing the header, so
    // the operator still sees the terminal event and its final status) rather than
    // holding an idle connection open behind a "live" badge that will never update.
    if (TERMINAL_EVENTS.includes(event.type)) endLive();
  }

  // The newest events first: a long session is opened for its latest activity —
  // the answer it ended on — so that is what loads, and earlier pages load on
  // request. Loading the oldest page instead left a finished session's tail
  // unreachable outside search.
  const HISTORY_PAGE = 500;
  const history = await api(
    '/v1/sessions/' + state.sessionId + '/events?order=desc&limit=' + HISTORY_PAGE,
  );
  const shown = history.events.slice().reverse();
  shown.forEach(append);
  events.scrollTop = events.scrollHeight;
  // Also when the loaded history holds no approval event: a call can have been
  // waiting since before the newest page of the log.
  void refreshApprovals();

  let oldestShown = shown.length > 0 ? shown[0].seq : null;
  if (history.events.length === HISTORY_PAGE) {
    const earlier = el(
      '<button class="action" id="log-earlier" type="button">Show earlier events</button>',
    );
    events.insertBefore(earlier, events.firstChild);
    earlier.addEventListener('click', async () => {
      earlier.disabled = true;
      try {
        const page = await api(
          '/v1/sessions/' + state.sessionId + '/events?order=desc&limit=' + HISTORY_PAGE +
            '&toSeq=' + oldestShown,
        );
        const older = page.events.slice().reverse();
        const fragment = document.createDocumentFragment();
        older.forEach((event) => fragment.appendChild(eventElement(event)));
        // Keep the operator on the lines they were reading while the page above grows.
        const before = events.scrollHeight;
        events.insertBefore(fragment, earlier.nextSibling);
        events.scrollTop += events.scrollHeight - before;
        if (older.length > 0) oldestShown = older[0].seq;
        if (page.events.length < HISTORY_PAGE) earlier.remove();
      } catch (error) {
        showError(error.message || 'Could not load earlier events');
      } finally {
        earlier.disabled = false;
      }
    });
  }

  // A finished session produces no more events, so there is nothing to stream:
  // opening a reconnecting stream would only flip the badge to "reconnecting…"
  // forever. Show its history and stop. \`ended\` covers the race where the status
  // snapshot (read earlier, up top) still said non-terminal but the history just
  // fetched already contains the terminal event — \`append\` called \`endLive()\`
  // during replay, so streaming now would reopen a live feed on a dead session.
  if (terminal || ended) {
    if (state.stream) {
      state.stream.abort();
      state.stream = null;
    }
    return;
  }

  // EventSource cannot send an Authorization header, so the stream is opened
  // through fetch and parsed by hand. The upside is that resume is explicit:
  // we know exactly which sequence to reconnect from.
  if (state.stream) state.stream.abort();
  const controller = new AbortController();
  state.stream = controller;

  // Resume the live stream from the newest event RENDERED, not the session tail
  // (\`lastSeq + 1\`): an event logged between the history fetch and this point
  // is past the newest rendered one but at or before the tail. The SSE bridge
  // replays persisted history from \`fromSeq\` before going live, so resuming here
  // backfills it with no duplicate. Empty history (a brand-new session): fall
  // back to the tail (nothing rendered).
  const lastRendered = shown.length > 0 ? shown[shown.length - 1].seq : history.lastSeq;
  let cursor = lastRendered + 1;
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(
          '/v1/sessions/' + state.sessionId + '/events/stream?fromSeq=' + cursor,
          {
            headers: { authorization: 'Bearer ' + state.token, accept: 'text/event-stream' },
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) return;

        live.classList.remove('off');
        live.textContent = 'live';

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');

            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            try {
              const event = JSON.parse(line.slice(6));
              // Not every frame is a session event. \`stream.lagged\` is a
              // notice about the stream itself and carries no sequence, so it
              // must not move the cursor or reach append(), which reads
              // event.type straight away.
              if (!Number.isInteger(event.seq) || typeof event.type !== 'string') continue;
              if (event.seq + 1 > cursor) cursor = event.seq + 1;
              append(event);
            } catch {
              // A malformed frame should not end the stream.
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }

      // An abort (leaving the view, or a terminal-event teardown via endLive)
      // must not fall through to the reconnect path: that would overwrite the
      // "ended" badge with "reconnecting…" and sleep before the outer loop next
      // checks the signal. Only a genuine drop reconnects.
      if (controller.signal.aborted) return;
      live.classList.add('off');
      live.textContent = 'reconnecting…';
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  })();
}

// --- approvals queue -------------------------------------------------------

/**
 * Every tool call in the workspace waiting on a person. There is no workspace
 * event stream, so the queue re-reads itself on a short interval while it is
 * the view on screen; a decision made here re-reads at once.
 */
async function renderApprovals(main) {
  if (!state.workspaceId) {
    main.innerHTML = '<div class="empty">Choose a workspace first.</div>';
    return;
  }
  const workspaceId = state.workspaceId;
  const page = await api('/v1/workspaces/' + encodeURIComponent(workspaceId) + '/approvals?statuses=pending');
  if (state.view !== 'approvals' || state.workspaceId !== workspaceId) return;
  // Redrawn only when what it shows changed — the calls, or a countdown's
  // minute — so a refresh does not take the keyboard focus or a text selection
  // from someone reading a call's arguments.
  const shown = workspaceId + ':' + page.items
    .map((approval) => approval.id + '@' + Math.ceil((approval.expiresAt - Date.now()) / 60000))
    .join(',');
  const current = main.querySelector('[data-queue]');
  if (!current || current.dataset.queue !== shown) {
    main.innerHTML =
      '<div data-queue="' + escapeHtml(shown) + '">' +
      '<h2>Approvals</h2>' +
      '<div class="muted" style="margin-bottom:12px">' +
      'Tool calls waiting for a person, across this workspace. Each one holds its turn until someone decides.' +
      '</div>' +
      (page.items.length === 0
        ? '<div class="empty">Nothing is waiting for approval.</div>'
        : page.items.map((approval) => approvalCard(approval, { showSession: true })).join('')) +
      '</div>';
    wireApprovals(main, () => {
      if (state.view === 'approvals') void renderApprovals(main);
    });
  }

  clearTimeout(state.approvalsTimer);
  state.approvalsTimer = setTimeout(() => {
    if (state.view === 'approvals' && state.workspaceId === workspaceId) {
      renderApprovals(main).catch((error) => showError(error.message || 'Could not refresh the approvals'));
    }
  }, 5000);
}

// --- models ----------------------------------------------------------------

/**
 * Models: what this platform may call, and which free models the provider
 * offers that could still be added.
 *
 * The platform holds the upstream credential and defaults to free-only, so this
 * view is where that policy becomes a choice instead of a baked-in id: the free
 * models are discovered live, tools-capable first (a model without
 * function-calling cannot drive an agent's tools), and one can be registered
 * with a click. Registration is admin-only server-side; a non-admin sees the
 * list and a note.
 */
async function renderModels(main) {
  const { models } = await api('/v1/models');

  let free = [];
  let freeError = '';
  try {
    free = (await api('/v1/models/free')).models;
  } catch (error) {
    // No provider wired, or the provider is unreachable: say so rather than
    // showing an empty list, which would read as "no free models exist".
    freeError = error.message || 'Could not reach the model provider.';
  }

  const registered = new Set(models.map((m) => m.id));
  // Hide what is already registered: this list is for choosing something new.
  const addable = free.filter((m) => !registered.has(m.id));

  let html = '<h2>Models</h2>';
  html +=
    '<div class="muted" style="margin-bottom:12px">' +
    'The platform calls these on your behalf and holds the provider credential; ' +
    'free models cost nothing.' +
    '</div>';
  html += table(['id', 'context', 'tools'], models, (model) =>
    '<tr>' +
    '<td class="id">' + escapeHtml(model.id) +
      (model.id.endsWith(':free')
        ? ' <span class="tag free">free</span>'
        : ' <span class="tag paid">paid</span>') +
    '</td>' +
    '<td>' + (model.contextWindowTokens || '-') + '</td>' +
    '<td>' + (model.capabilities && model.capabilities.tools ? 'yes' : 'no') + '</td>' +
    '</tr>',
  );

  html += '<h3 style="margin-top:24px">Free models available to add</h3>';
  if (freeError) {
    // No provider wired, or the provider is unreachable. Say so rather than
    // render an empty list, which would read as "no free models exist".
    html += '<div class="empty">' + escapeHtml(freeError) + '</div>';
  } else {
    html +=
      '<div class="muted" style="margin-bottom:12px">' +
      'Discovered live from the provider, tools-capable first. Only free models can be registered.' +
      '</div>';
    html += table(['id', 'context', 'tools', ''], addable, (model) =>
      '<tr>' +
      '<td class="id">' + escapeHtml(model.id) +
        (model.tools ? '' : ' <span class="muted">(no tools)</span>') +
      '</td>' +
      '<td>' + (model.contextLength || '-') + '</td>' +
      '<td>' + (model.tools ? 'yes' : 'no') + '</td>' +
      '<td><button class="action" data-add-model="' + escapeHtml(model.id) + '">Add</button></td>' +
      '</tr>',
    );
  }

  main.innerHTML = html;

  main.querySelectorAll('button[data-add-model]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api('/v1/models/free', {
          method: 'POST',
          body: JSON.stringify({ modelId: button.dataset.addModel }),
        });
        await renderModels(main);
      } catch (error) {
        button.disabled = false;
        showError(error.message || 'Could not register the model');
      }
    });
  });
}

// --- shell -----------------------------------------------------------------

const VIEWS = {
  workspaces: renderWorkspaces,
  agents: renderAgents,
  templates: renderTemplates,
  sessions: renderSessions,
  session: renderSession,
  approvals: renderApprovals,
  models: renderModels,
};

async function navigate(view) {
  // Leaving a session must close its stream, or every visit leaks a connection.
  if (state.stream && view !== 'session') {
    state.stream.abort();
    state.stream = null;
  }
  clearTimeout(state.approvalsTimer);

  state.view = view;
  document.querySelectorAll('nav button').forEach((button) => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  const main = document.querySelector('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await VIEWS[view](main);
  } catch (error) {
    main.innerHTML = '';
    showError(error.message || 'Request failed');
  }
}

function promptForToken() {
  const token = prompt('API token');
  if (!token) return;
  state.token = token;
  localStorage.setItem('ma.token', token);
  navigate(state.view);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('nav button').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.view));
  });
  document.querySelector('#token').addEventListener('click', promptForToken);

  if (!state.token) promptForToken();
  else navigate('workspaces');
});
`;

/** The console as one HTML document. */
export function renderConsole(options: { version: string } = { version: '0.1.0' }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Managed-Agent</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>Managed-Agent</h1>
  <nav>
    <button data-view="workspaces">Workspaces</button>
    <button data-view="agents">Agents</button>
    <button data-view="templates">Templates</button>
    <button data-view="models">Models</button>
    <button data-view="sessions">Sessions</button>
    <button data-view="session">Session</button>
    <button data-view="approvals">Approvals</button>
  </nav>
  <span class="spacer"></span>
  <button class="action" id="token">Token</button>
  <span class="id">v${escapeAttribute(options.version)}</span>
</header>
<main></main>
<script>${APP_SCRIPT}</script>
</body>
</html>`;
}

/** Escape a value destined for an HTML attribute or text node. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
