# The runtime protocol

Managed-Agent runs an **agent runtime** inside each sandbox. The platform ships
one — the built-in TypeScript harness — but an agent version can declare a
*command runtime* instead:

```jsonc
// agent version spec
"runtime": {
  "type": "command",
  "command": "python3",
  "args": ["agent.py"],
  "env": { "MY_FLAG": "1" }        // optional, on top of the bridge env below
}
```

When a session for that version starts, its sandbox runs your command **once per
turn** instead of the built-in loop. Your process drives the turn by speaking the
same `/runtime/v1/*` HTTP protocol the built-in harness uses. This document is
that contract. A complete, dependency-free reference is
[`examples/runtimes/echo-runtime.mjs`](../examples/runtimes/echo-runtime.mjs).

## What your process receives

Per turn, the sandbox spawns your command with:

- **stdin** — the user prompt for this turn (UTF-8).
- **env**:
  - `MA_RUNTIME_URL` — the bridge base, e.g. `http://127.0.0.1:8080/runtime/v1`.
  - `MA_RUNTIME_TOKEN` — the bearer token for every bridge call. Session-scoped:
    the bridge resolves which session you are from this token, so you can only
    ever act on your own session. Never sent anywhere but the bridge.
  - `MA_SESSION_ID`, `MA_WORKSPACE_ID` — informational.
  - `MA_SUBMISSION_ID` — the submission this turn runs; echo it on `turn.started`
    (below).
  - your declared `env`, plus a minimal `PATH`/`HOME` (the working directory).
- **working directory** — a private scratch dir; declared `setupCommands` have
  already run in it.

The process should run one turn and exit `0`. A non-zero exit is logged. To
interrupt a turn the sandbox sends `SIGTERM`, then `SIGKILL`.

## The endpoints

Every call carries `Authorization: Bearer ${MA_RUNTIME_TOKEN}`.

| Method & path | Purpose |
|---|---|
| `GET /bootstrap` | Your pinned config: `model.modelId`, `systemPrompt`, `tools`, `datasetIds`, … (or `{ "unbound": true }` for an unclaimed prewarmed sandbox — a command runtime is never spawned in that state). |
| `POST /completions` | Model access. The gateway attaches the provider key, enforces quota, bills usage. Body: `{ modelId, turn?, messages: [{role, content, toolCallId?, toolCalls?}], tools: [], maxOutputTokens?, temperature? }`. Returns `{ text, toolCalls?, stopReason, usage }`. |
| `POST /events` | Report your turn's events (see below). Body: `{ events: [{ type, turn?, itemId?, payload }] }`. |
| `POST /heartbeat` | Optional for a short per-turn process; the built-in loop uses it for long turns. |
| `POST /credentials/:id` | Exchange a granted credential *reference* for its value (audited). |
| `POST /search` | Query the session's knowledge-base datasets. |
| `POST /artifacts`, `POST /snapshots`, `GET /snapshots/:digest` | Persist files / context snapshots. |

## Events you may emit

`POST /events` accepts only the sandbox-writable event types (the control plane
owns `session.*`). The turn lifecycle a runtime is expected to report:

1. `turn.started` — `{ turn, promptPreview, submissionId }`. `submissionId` is
   the value of `MA_SUBMISSION_ID` in your environment for this turn: it names
   the submission you are running, and is how a submitter — a connector
   waiting to post your answer back to a chat, say — tells your turn from
   others on the same session. Leave it out and such a submitter takes the
   first turn that starts as its own, which is only safe while nothing else
   submits to the session.
2. `message.completed` — `{ role: "assistant", text }` (and/or `message.delta`
   for streaming; `thinking.*`, `tool.*`, `model.*` are also permitted)
3. `turn.completed` — `{ turn, reason: "completed", durationMs, usage }`
   (or `turn.failed` — `{ turn, error }`)

Attributing events is automatic: the bridge files them under the session your
token resolves to, using the `turn` you supply. You cannot write to another
session — the token is the only identity, and the request body's session is never
trusted.

## Isolation

A command runtime holds the same session-scoped token the built-in harness holds,
inside the same sandbox trust boundary, and calls the same audited endpoints. It
replaces the *loop*, not the *isolation*: no provider keys, no cross-session
writes, no cross-workspace reach. The pool key includes the credential set, so a
reused warm sandbox never crosses credential boundaries into your runtime either.
