/**
 * The console's stylesheet.
 *
 * Kept as a template string rather than a separate file so the whole console
 * ships as one module the gateway can serve without a build step or a static
 * file resolver.
 *
 * The design brief is narrow: an operator looking at this is usually trying to
 * answer "what is this agent doing right now" or "why did that fail". So
 * status is the most prominent thing on every row, failures are legible
 * without clicking, and the event stream reads like a log rather than a chat.
 */

export const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --surface: #f7f8fa;
  --border: #dfe3e8;
  --text: #1a1d21;
  --muted: #5c6570;
  --accent: #2a5bd7;
  --ok: #1a7f4b;
  --warn: #9a6700;
  --error: #c02626;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --surface: #1c1f24;
    --border: #2c3138;
    --text: #e6e8ea;
    --muted: #9aa4b0;
    --accent: #6a9bff;
    --ok: #4ec98a;
    --warn: #e0b341;
    --error: #ff7b72;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg);
}

header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 10;
}

header h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
header .spacer { flex: 1; }

nav { display: flex; gap: 4px; }
nav button {
  border: 0;
  background: transparent;
  color: var(--muted);
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
nav button:hover { background: var(--bg); color: var(--text); }
nav button[aria-current="page"] { background: var(--bg); color: var(--text); font-weight: 500; }

main { padding: 20px; max-width: 1200px; margin: 0 auto; }

h2 { font-size: 16px; margin: 0 0 12px; font-weight: 600; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
tbody tr:hover { background: var(--surface); }

.id { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.muted { color: var(--muted); font-size: 13px; }

/* A small pill next to a model id, so "is this costing money?" is answerable at
   a glance — the visible half of a free-only deployment. */
.tag {
  display: inline-block; margin-left: 6px; padding: 0 6px;
  border-radius: 10px; font-size: 11px; line-height: 17px; vertical-align: 1px;
  border: 1px solid transparent;
}
.tag.free { color: var(--ok); border-color: var(--ok); }
.tag.paid { color: var(--warn); border-color: var(--warn); }
/* Neutral: says "this was changed here", not good/bad — green would read as
   "free" and yellow as "warning". */
.tag.changed { color: var(--accent); border-color: var(--accent); }

/* Status is what an operator scans for, so it carries colour and weight. */
.status { font-weight: 500; font-size: 12px; }
.status.running, .status.ready, .status.active, .status.succeeded { color: var(--ok); }
.status.queued, .status.provisioning, .status.pending, .status.working, .status.idle { color: var(--warn); }
.status.failed, .status.zombie, .status.lost { color: var(--error); }
.status.terminated, .status.archived, .status.released { color: var(--muted); }

button.action {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
button.action:hover { border-color: var(--accent); color: var(--accent); }
button.action.danger:hover { border-color: var(--error); color: var(--error); }

.empty { color: var(--muted); padding: 32px; text-align: center; }
.error-banner {
  background: color-mix(in srgb, var(--error) 12%, transparent);
  border: 1px solid var(--error);
  color: var(--error);
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
}

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--surface); }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
.card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }

.meter { height: 4px; background: var(--border); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.meter > div { height: 100%; background: var(--accent); }
.meter.warn > div { background: var(--warn); }
.meter.over > div { background: var(--error); }

/* The event stream reads as a log: fixed-width, dense, newest at the bottom. */
.events {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  max-height: 60vh;
  overflow-y: auto;
}
.event { display: flex; gap: 10px; padding: 1px 0; }
.event .seq { color: var(--muted); min-width: 44px; text-align: right; }
.event .type { min-width: 190px; }
.event .body { flex: 1; white-space: pre-wrap; word-break: break-word; }
.event.tool .type { color: var(--accent); }
.event.error .type, .event.error .body { color: var(--error); }
.event.turn .type { color: var(--ok); }

.detail { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; }
.detail dt { color: var(--muted); }
.detail dd { margin: 0; font-family: var(--mono); font-size: 12px; }

.row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.row input, .row select {
  font: inherit;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
.row input { flex: 1; }

.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.live::before {
  content: "";
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--ok);
}
.live.off::before { background: var(--muted); }

/* A modal dialog for choices that need to be picked, not typed. Native
   <dialog> gives focus trapping, Escape-to-close and the top layer for free,
   which a hand-rolled overlay would have to reimplement (badly). */
dialog {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0;
  min-width: 380px;
  max-width: 90vw;
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
dialog form { padding: 18px 20px; margin: 0; }
dialog h3 { margin: 0 0 4px; font-size: 15px; }
dialog .muted { margin-bottom: 12px; }
dialog select {
  width: 100%;
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}
dialog .dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
`;
