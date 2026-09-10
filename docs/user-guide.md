# Managed-Agent — User Guide

A complete, hands-on guide to running the Managed-Agent platform, driving it through
the web console, the HTTP API, and the `ma` CLI, and understanding what every screen
and lifecycle state means.

Every screenshot in this guide was captured from a live instance of the platform.

---

## Table of contents

1. [What Managed-Agent is](#1-what-managed-agent-is)
2. [Architecture in one page](#2-architecture-in-one-page)
3. [Quick start — one command](#3-quick-start--one-command)
4. [Signing in to the console](#4-signing-in-to-the-console)
5. [The console, screen by screen](#5-the-console-screen-by-screen)
   - [Workspaces](#51-workspaces)
   - [Agents & quota](#52-agents--quota)
   - [Templates](#53-templates)
   - [Sessions](#54-sessions)
   - [A live session](#55-a-live-session)
   - [A finished session](#56-a-finished-session)
6. [End-to-end walkthrough: your first conversation](#6-end-to-end-walkthrough-your-first-conversation)
7. [Using the HTTP API](#7-using-the-http-api)
8. [Using the `ma` CLI](#8-using-the-ma-cli)
9. [Concepts reference](#9-concepts-reference)
   - [Session lifecycle](#91-session-lifecycle)
   - [Agent versions & production pin](#92-agent-versions--production-pin)
   - [The event log](#93-the-event-log)
   - [Sandboxes & reuse](#94-sandboxes--reuse)
   - [Credentials & models](#95-credentials--models)
   - [Memories](#96-memories)
   - [Templates](#97-templates)
   - [Quotas](#98-quotas)
10. [Configuration reference](#10-configuration-reference)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. What Managed-Agent is

Managed-Agent is a control plane for hosting autonomous agents. You supply a prompt,
a model, and a policy; the platform handles everything between *"start a session"* and
*"here is exactly what the agent did, turn by turn"*:

- **Isolated execution** — each session runs an agent harness in its own sandbox.
- **Durable sessions** — a session survives a disconnect; you can resume its event
  stream from any sequence number.
- **A replayable audit trail** — every action (a model call, a message, a turn
  boundary, a termination) is a durable, ordered event.
- **Governance** — per-workspace quotas, write-only credentials, and an authorization
  model that gates operations by role.
- **A broker, never a proxy** — model credentials live in the control plane. The
  sandbox calls back to the control plane for completions, so a compromised sandbox
  never holds a model key.

The platform is pure TypeScript, runs on Node 24+ with no build step, and ships a
zero-dependency web console served directly by the control plane.

---

## 2. Architecture in one page

```
   Browser (console)            CLI / SDK / your app
          │                              │
          └──────────────┬───────────────┘
                         │  HTTPS  /v1/*
                 ┌───────▼────────┐
                 │  Control plane │   apps/server
                 │  (gateway +    │   - REST API + SSE event stream
                 │   engine)      │   - session lifecycle & quotas
                 │                │   - model gateway (holds credentials)
                 └───┬────────┬───┘
      provisions     │        │   /runtime/v1/* callbacks
      a sandbox      │        │   (bootstrap, completions, events)
                 ┌───▼───┐    │
                 │ Sandbox│◄──┘
                 │ agent- │        one process per session:
                 │ core   │        the harness, tools, context window
                 └────────┘
```

- **The console and the API are the same process.** The server serves the console at
  `GET /` and the API at `/v1/*`.
- **The model call happens in the control plane.** The sandbox never sees a model key;
  it calls `/runtime/v1/completions` and the control plane's model gateway makes the
  upstream call.
- **One sandbox process serves one session** for its lifetime.

---

## 3. Quick start — one command

The repository ships a demo launcher that starts the server with a working model and
seeds a ready-to-use workspace and agent.

### Prerequisites

- Node.js 24+
- pnpm 9
- (Optional) an [OpenRouter](https://openrouter.ai) API key to use a real model. A
  free model works fine. Without a key, the demo falls back to an offline echo model
  so the whole flow is still exercisable.

### Configure

Copy the example env file and fill in your key:

```bash
cp .env.demo.example .env.demo
# edit .env.demo:
#   MA_OPENROUTER_API_KEY=sk-or-v1-...
#   MA_OPENROUTER_MODEL=nex-agi/nex-n2.5-mini:free
#   MA_BOOTSTRAP_TOKEN=demo-admin-token
#   MA_PORT=8080
```

`.env.demo` is gitignored — your key never enters version control.

### Launch

```bash
pnpm demo
```

This installs dependencies if needed, starts the server, waits for readiness, and
opens the console in your browser. The banner prints everything you need:

```
  ┌─────────────────────────────────────────────────────────────┐
  │  Managed-Agent demo is running                                │
  └─────────────────────────────────────────────────────────────┘

  Console:   http://127.0.0.1:8080/
  API:       http://127.0.0.1:8080/v1
  Model:     OpenRouter · nex-agi/nex-n2.5-mini:free
  Token:     demo-admin-token   (paste into the console)
  Workspace: ws_...   (seeded "Demo")
```

> **Note:** the demo uses an in-memory database by default (`MA_DATABASE=:memory:`), so
> each run starts clean. Set `MA_DATABASE=./data/ma.db` for persistence.

To run the full control plane without the demo seeding, use `pnpm dev` (starts
`apps/server/src/main.ts`); the first run prints a one-time bootstrap admin token to
stderr.

---

## 4. Signing in to the console

Open `http://127.0.0.1:8080/`. On first load the console asks for an **API token** —
paste the `Token` value from the launch banner (`demo-admin-token`) and it is stored in
your browser's `localStorage`. You can change it any time with the **Token** button in
the top-right.

> The token authenticates every API call the console makes. Treat it like a password.

---

## 5. The console, screen by screen

The console has one job: let an operator see what agents are doing and intervene. The
top navigation moves between five views — **Workspaces**, **Agents**, **Templates**,
**Sessions**, and a single **Session** detail.

### 5.1 Workspaces

A workspace is the top-level container: it owns agents, sessions, credentials,
templates, memories, and a quota. The Workspaces view lists the ones you can see.

![Workspaces view](images/console-workspaces.png)

Click **Open** to drop into a workspace's agents.

### 5.2 Agents & quota

An agent is a named, versioned configuration (prompt, model, tools, sandbox spec). The
Agents view shows the workspace's live quota as cards across the top, then each agent
with its latest version, production pin, and status.

![Agents view with quota cards](images/console-agents.png)

- **Quota cards** — concurrent sessions, sandboxes, agents, tokens/day, and storage,
  each shown as *used of limit* with a meter.
- **Start session** — provisions a sandbox and opens the new session's detail view.
- **Sessions** — lists just this agent's sessions.

### 5.3 Templates

Templates are parameterized agent blueprints. The platform ships four built-ins; you
can add your own per workspace. Each row shows its category, whether it is built-in or
workspace-defined, and the variables it takes.

![Templates view](images/console-templates.png)

Click **Use** to instantiate a template into a new agent — the console prompts for each
variable the template declares.

### 5.4 Sessions

A session is one run of an agent. The Sessions view lists them with status, resolved
version, turn count, token usage, and last activity.

![Sessions list](images/console-sessions.png)

Click **Watch** to open a session's live detail.

### 5.5 A live session

The Session detail is where an operator actually sits. It shows the session's identity
and running totals, live controls, a message composer, and the full event log — which
updates live over a server-sent-events stream.

![A live session with its event log](images/console-session-detail.png)

- **Header** — `id`, `status` (here `idle`), the resolved `agent @ version`, `turns`,
  and `tokens`. These update as turns complete.
- **`live` indicator** — green when the event stream is connected.
- **Interrupt** — signals the agent to stop the current turn.
- **Terminate** — ends the session and releases its sandbox (irreversible; the console
  asks for confirmation first).
- **Composer** — type a message and **Send**; the agent's reply streams into the event
  log below.
- **Event log** — every event in order: `session.created → sandbox.provisioning →
  session.ready`, then per turn `turn.started → model.requested → model.completed →
  message.delta → message.completed → turn.completed`.

### 5.6 A finished session

Once a session is terminated (or has failed), it is shown **read-only**: the badge
reads `ended`, the controls and composer are gone, and the event log is preserved for
audit. There is nothing to resume, so the console does not offer controls that would
only be rejected.

![A finished, read-only session](images/console-session-finished.png)

The log ends with `session.terminated`, and the header still shows the final
`turns`/`tokens` totals.

---

## 6. End-to-end walkthrough: your first conversation

1. **Open the workspace.** Workspaces → **Open** on *Demo*.
2. **Start a session.** Agents → **Start session** on *Assistant*. The console
   navigates to the new session; watch it move `queued → provisioning → ready` (the
   local sandbox spawns in a few seconds).
3. **Send a message.** Type into the composer and **Send**. You will see, live:
   - `turn.started`
   - `model.requested` → `model.completed`
   - `message.delta` (streaming) → `message.completed`
   - `turn.completed`
   and the header's `turns` and `tokens` tick up.
4. **Keep chatting.** Each message is a new turn appended to the same session.
5. **Intervene if needed.** Use **Interrupt** to stop a runaway turn, or **Terminate**
   to end the session and free its sandbox.

That single flow exercises the whole chain: provisioning → agent-core → the control
plane's model gateway → the upstream model → the event log.

---

## 7. Using the HTTP API

The API is under `/v1`. Authenticate with a bearer token:

```bash
export MA=http://127.0.0.1:8080
export TOK=demo-admin-token
```

### Discover a workspace and its agent

```bash
curl -s -H "authorization: Bearer $TOK" "$MA/v1/workspaces"
curl -s -H "authorization: Bearer $TOK" "$MA/v1/workspaces/$WS/agents"
```

### Start a session, send a message, read the log

```bash
# Create a session
SID=$(curl -s -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d "{\"agentId\":\"$AGENT\"}" "$MA/v1/sessions" | jq -r .session.id)

# Wait a few seconds for it to reach 'ready', then send a message
curl -s -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","text":"Hello!"}]}' \
  "$MA/v1/sessions/$SID/events"

# Read the event log
curl -s -H "authorization: Bearer $TOK" "$MA/v1/sessions/$SID/events?limit=100"
```

### Live event stream (SSE)

```bash
curl -N -H "authorization: Bearer $TOK" -H 'accept: text/event-stream' \
  "$MA/v1/sessions/$SID/events/stream?fromSeq=0"
```

### Interrupt / terminate / renew

```bash
curl -s -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"reason":"stop"}' "$MA/v1/sessions/$SID/interrupt"

curl -s -X POST -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"reason":"done"}' "$MA/v1/sessions/$SID/terminate"
```

### Selected endpoints

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness (`{"status":"ok","version":"..."}`) |
| `GET /v1/workspaces` | List workspaces |
| `POST /v1/workspaces` | Create a workspace |
| `GET /v1/workspaces/:id/agents` | List agents |
| `POST /v1/workspaces/:id/agents` | Create an agent |
| `GET /v1/workspaces/:id/quota` | Quota limits & usage |
| `GET /v1/workspaces/:id/templates` | List templates |
| `POST /v1/workspaces/:id/templates/:tid/instantiate` | Create an agent from a template |
| `POST /v1/agents/:id/versions` | Publish a new agent version |
| `POST /v1/agents/:id/archive` | Archive an agent |
| `POST /v1/sessions` | Start a session |
| `GET /v1/sessions` | List sessions (`?workspaceId=` or `?agentId=`) |
| `GET /v1/sessions/:id` | Session detail |
| `POST /v1/sessions/:id/events` | Submit user events |
| `GET /v1/sessions/:id/events` | Read the event log |
| `GET /v1/sessions/:id/events/stream` | Live SSE stream |
| `POST /v1/sessions/:id/interrupt` | Interrupt the current turn |
| `POST /v1/sessions/:id/terminate` | Terminate the session |
| `POST /v1/sessions/:id/renew` | Extend the session lease |
| `GET /v1/workspaces/:id/credentials` | List credentials (metadata only) |
| `POST /v1/workspaces/:id/credentials` | Create a credential (write-only value) |
| `GET /v1/workspaces/:id/memories` | List memories |
| `GET /v1/workspaces/:id/audit` | Audit log |
| `GET /v1/models` | Available models |

---

## 8. Using the `ma` CLI

The CLI wraps the same API. Point it at your server and token via environment:

```bash
export MA_URL=http://127.0.0.1:8080
export MA_TOKEN=demo-admin-token
```

The token is only ever read from the environment or `--token` — never as a positional
argument, so it does not leak into your shell history or the process table.

### Common commands

```bash
# Workspaces
ma workspace list
ma workspace create --name "My Team" --slug my-team
ma workspace quota --workspace ws_...

# Agents
ma agent list --workspace ws_...
ma agent create --workspace ws_... --name Assistant --spec spec.json
ma agent version create --agent ag_... --spec spec.json
ma agent update --agent ag_... --production-version 2

# Sessions
ma session create --agent ag_... --title "Support chat"
ma session send --session sn_... --prompt-file prompt.txt
ma session watch --session sn_... --types turn.,message.
ma session events --session sn_... --limit 100
ma session terminate --session sn_... --reason "done"
ma session renew --session sn_... --ttl 3600

# Templates
ma template list --workspace ws_...
ma template instantiate --workspace ws_... --template tpl_... --name NewAgent --variables vars.json

# Credentials (value is read from a file, never argv)
ma credential create --workspace ws_... --name OPENAI --type env_vars --value-file secret.json

# Memories
ma memory add --workspace ws_... --content "Deploys need a change ticket"
ma memory list --workspace ws_... --injectable-only

# Artifacts
ma artifact list --workspace ws_...
ma artifact get --artifact art_... --out report.pdf
```

Add `--json` to most read commands for machine-readable output, and `--yes` to skip
confirmation on mutating commands.

---

## 9. Concepts reference

### 9.1 Session lifecycle

A session moves through a small state machine:

```
queued ─► provisioning ─► ready ─► running ─► idle
   │            │           │  ▲       │  │      │
   │            │           │  └───────┘  │      │  (idle ⇄ running per turn)
   │            │           └─────────────┴──────┴──► terminating ─► terminated
   └────────────┴──────────────────────────────────────────────────► failed
```

- **queued** — admitted, waiting for a sandbox (this is where quota backpressure waits
  visibly).
- **provisioning** — a sandbox is being acquired.
- **ready** — holds a sandbox, has not yet run a turn.
- **running** — a turn is in progress.
- **idle** — has served at least one turn and is waiting for the next. (The distinction
  from `ready` is what lets the platform tell a productive sandbox from an untouched
  one.)
- **terminating** — shutting down and releasing its sandbox.
- **terminated / failed** — terminal. A terminal session is read-only; it cannot be
  interrupted, messaged, or resumed.

### 9.2 Agent versions & production pin

Agents are versioned. A session **resolves its version once, at creation**, and is then
immune to later edits of the agent — publishing v2 never changes what an already-running
session executes. An agent can have a **production pin**; new sessions use the pin,
else the latest version. Version 0 means the agent has no versions yet and cannot run.

### 9.3 The event log

Every session has an append-only, gap-free, sequence-numbered event log. It is the
audit trail and the resume mechanism: a client reconnects by asking for events
`fromSeq = last_seen + 1`. Key event types:

- `session.created`, `sandbox.provisioning`, `session.ready`
- `turn.started`, `turn.completed`, `turn.failed`
- `model.requested`, `model.completed`
- `message.delta` (streaming chunks), `message.completed`
- `tool.*` (tool calls, when the agent uses tools)
- `session.interrupted`, `session.terminated`, `session.failed`, `sandbox.lost`

A state change and its event are always written together, so replaying the log always
reproduces the session row.

### 9.4 Sandboxes & reuse

Each session runs in a sandbox — with the local driver, a child process; with the
container/k8s drivers, a container. A sandbox is created for a session, holds a short
heartbeat-renewed lease, and is released (and destroyed) when the session ends.

Sandbox **reuse** across sessions is gated to genuinely idle sandboxes (one whose holder
sessions have all finished), because one agent-core process is bound to one session for
its life. Concurrent sessions of the same agent each get their own sandbox.

### 9.5 Credentials & models

- **Credentials** are write-only: you supply a value, and thereafter only metadata is
  readable. Values are resolved into a sandbox's environment at provision time; the
  driver never sees a credential id, and the sandbox never sees a raw model key.
- **Models** are declared in a catalogue with pricing and per-workspace allow-lists.
  The model gateway refuses an uncatalogued model. Usage is metered per turn and drives
  the tokens/day quota.

### 9.6 Memories

An agent can accumulate **memories**. Human-approved (*injectable*) memories are
prepended to the system prompt on bootstrap; agent-authored memories are reachable only
as tool output via recall, never silently injected — a boundary that prevents a hostile
web page an agent read from dictating its future instructions.

### 9.7 Templates

Templates turn a blueprint plus variables into an agent. The four built-ins cover common
shapes:

| Template | Category | Variables |
|---|---|---|
| Scheduled reporter | automation | model, task |
| Coding agent | coding | model, language, maxTurns |
| General assistant | general | model, persona |
| Research assistant | research | model, tone |

### 9.8 Quotas

Each workspace has a quota enforced by the platform: max concurrent sessions, max
sandboxes, max agents, tokens/day, storage, and event retention. The Agents view shows
current usage against each limit; exceeding one returns a `429` with a retry hint.

---

## 10. Configuration reference

The server reads configuration from `MA_*` environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `MA_PORT` | `8080` | Listen port |
| `MA_HOST` | `127.0.0.1` | Listen host |
| `MA_DATABASE` | `./data/managed-agent.db` | SQLite path, or `:memory:` for an ephemeral DB (the demo sets `:memory:`) |
| `MA_BOOTSTRAP_TOKEN` | — | Pins the first admin token (else one is generated and printed once) |
| `MA_BOOTSTRAP_SUBJECT` | — | Subject for the bootstrap principal |
| `MA_SANDBOX_DRIVER` | `local` | `local` \| `container` \| `k8s` |
| `MA_SANDBOX_LEASE_SECONDS` | `120` | Sandbox lease length |
| `MA_SANDBOX_PREWARM` | `0` | Warm sandboxes per pool (idle cost) |
| `MA_AGENT_COMMAND` / `MA_AGENT_ARGS` | node / agent-core | Override how the local driver spawns agent-core |
| `MA_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MA_SCHEDULER` | on | Enable the background scheduler/reaper |
| `MA_SCHEDULER_TICK_MS` / `MA_SCHEDULER_BATCH` | — | Scheduler cadence and batch size |
| `MA_RATE_LIMIT` / `MA_RATE_WINDOW_MS` | — | API rate limiting |
| `MA_CORS_ORIGINS` / `MA_CONSOLE_ORIGIN` / `MA_PREVIEW_ORIGIN` | — | Cross-origin policy |
| `MA_ENCRYPTION_KEYS` / `MA_ENCRYPTION_KEY_VERSION` | — | Credential encryption keys |
| `MA_ARTIFACT_ROOT` / `MA_ARTIFACT_MAX_MB` / `MA_ARTIFACT_RETENTION_DAYS` | — | Artifact storage |
| `MA_EGRESS_PROXY` / `MA_DNS_CIDR` / `MA_INTERNAL_NETWORK` | — | Sandbox network policy |

The demo launcher additionally reads `MA_OPENROUTER_API_KEY` and `MA_OPENROUTER_MODEL`
to wire a real model; without a key it uses an offline echo model.

---

## 11. Troubleshooting

**The console asks for a token and nothing loads.**
Paste the token from the launch banner (`demo-admin-token` for the demo). Use the
**Token** button to re-enter it.

**A session sits at `provisioning` for a while.**
With the local driver the sandbox is a child process that takes a few seconds to spawn
on first use. If it never reaches `ready`, check the server logs for a provisioning
error; the failure is also recorded on the session (`session.failed` with an error).

**"Start session" is rejected.**
The agent has no runnable version (version 0). Publish a version first (Templates →
Use, or `ma agent version create`).

**A message send is rejected with a state error.**
The session is not accepting input — it may still be provisioning, or already
terminated. A terminated session is read-only by design; start a new one.

**The agent replies but `tokens` shows 0 / turns don't advance.**
Confirm a real model is wired (the banner shows the model; the offline echo model
reports minimal usage). The `turns` and `tokens` in the header update as each turn
completes.

**Two concurrent sessions on the same agent — do they interfere?**
No. Each gets its own sandbox; their event logs are independent.

**Stopping the demo.**
`Ctrl-C` in the `pnpm demo` terminal, or kill the `apps/server/src/demo.ts` process.
With `:memory:` the data is discarded on exit.

---

*Generated against a live instance. Screens may differ slightly as the console
evolves; the concepts and lifecycle are stable.*
