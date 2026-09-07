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
    '<td><button class="action" data-sessions="' + escapeHtml(agent.id) + '">Sessions</button></td>' +
    '</tr>',
  );

  main.innerHTML = html;
  main.querySelectorAll('[data-sessions]').forEach((button) => {
    button.addEventListener('click', () => {
      state.agentId = button.dataset.sessions;
      navigate('sessions');
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

  main.innerHTML =
    '<h2>Session</h2>' +
    '<dl class="detail">' +
    '<dt>id</dt><dd>' + escapeHtml(session.id) + '</dd>' +
    '<dt>status</dt><dd>' + statusCell(session.status) + '</dd>' +
    '<dt>agent</dt><dd>' + escapeHtml(session.agentId) + ' @ v' + session.resolvedVersion + '</dd>' +
    '<dt>turns</dt><dd>' + session.turnCount + '</dd>' +
    '<dt>tokens</dt><dd>' +
      (session.usage.inputTokens + session.usage.outputTokens).toLocaleString() + '</dd>' +
    (session.error
      ? '<dt>error</dt><dd class="status failed">' +
        escapeHtml(session.error.code + ': ' + session.error.message) + '</dd>'
      : '') +
    '</dl>' +
    '<div class="row" style="margin-top:16px">' +
    '<span class="live off" id="live">disconnected</span>' +
    '<span style="flex:1"></span>' +
    '<button class="action" id="interrupt">Interrupt</button>' +
    '<button class="action danger" id="terminate">Terminate</button>' +
    '</div>' +
    '<div class="events" id="events"></div>';

  const events = main.querySelector('#events');
  const live = main.querySelector('#live');

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

  function append(event) {
    const kind = event.type.startsWith('tool.')
      ? 'tool'
      : event.type.startsWith('turn.')
        ? 'turn'
        : /fail|error|denied|lost/.test(event.type)
          ? 'error'
          : '';
    const payload = event.payload || {};
    const body =
      payload.text ?? payload.chunk ?? payload.toolName ?? payload.reason ??
      (payload.error && payload.error.message) ?? '';

    // Stay pinned to the bottom only if the operator already was: yanking the
    // view while they are reading history is worse than a stale scroll.
    const pinned = events.scrollHeight - events.scrollTop - events.clientHeight < 40;
    events.appendChild(
      el(
        '<div class="event ' + kind + '">' +
        '<span class="seq">' + event.seq + '</span>' +
        '<span class="type">' + escapeHtml(event.type) + '</span>' +
        '<span class="body">' + escapeHtml(String(body).slice(0, 500)) + '</span>' +
        '</div>',
      ),
    );
    if (pinned) events.scrollTop = events.scrollHeight;
  }

  const history = await api('/v1/sessions/' + state.sessionId + '/events?limit=500');
  history.events.forEach(append);

  // EventSource cannot send an Authorization header, so the stream is opened
  // through fetch and parsed by hand. The upside is that resume is explicit:
  // we know exactly which sequence to reconnect from.
  if (state.stream) state.stream.abort();
  const controller = new AbortController();
  state.stream = controller;

  let cursor = history.lastSeq + 1;
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

      live.classList.add('off');
      live.textContent = 'reconnecting…';
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  })();
}

// --- shell -----------------------------------------------------------------

const VIEWS = {
  workspaces: renderWorkspaces,
  agents: renderAgents,
  sessions: renderSessions,
  session: renderSession,
};

async function navigate(view) {
  // Leaving a session must close its stream, or every visit leaks a connection.
  if (state.stream && view !== 'session') {
    state.stream.abort();
    state.stream = null;
  }

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
    <button data-view="sessions">Sessions</button>
    <button data-view="session">Session</button>
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
