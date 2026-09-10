# Managed-Agent — Architecture

> Managed-Agent (**MA**) is a general-purpose cloud platform for hosting, governing and observing
> autonomous agents. It runs agent harnesses (Claude Agent SDK-style main loops) in isolated sandboxes,
> manages their session lifecycle and context, brokers credentials and models, exposes every action as
> a replayable audit event, and integrates with the outside world through uniform Connectors.

This document is the contract the implementation follows. It is derived from a reverse-engineering
study of a mature production managed-agent platform, plus deliberate improvements where that
platform's own documentation discloses gaps. See
[`research/design-deltas.md`](./research/design-deltas.md) for the divergences and their reasons.

---

## 1. Design tenets

These are load-bearing. Every module below is justified by one of them.

1. **The control plane is a broker, never a proxy.** The Engine resolves a session to a Runtime
   endpoint and mints a scoped, short-lived token. Bulk traffic (tool output, model tokens) never
   transits the control plane.
2. **Configuration is immutable and versioned; running work pins a version.** An `AgentVersion` is
   content-addressed and append-only. A Session resolves a version at creation and is thereafter
   immune to edits of its Agent.
3. **The event log is the source of truth.** Session state is a fold over an append-only, monotonically
   sequenced event log. Anything the UI shows can be reconstructed by replaying events. This makes
   resume, audit, and time-travel debugging the same mechanism.
4. **Every write is a plan, a confirmation, one attempt, and a readback.** No mutation is ever
   silently replayed. Ambiguous writes fail closed and surface a receipt.
5. **Every inbound trigger produces a receipt and is idempotent.** External systems retry; we
   deduplicate on `(connector_id, external_event_id)` and expose the delivery's full fate.
6. **Secrets are write-only.** A credential value can be created and referenced but never read back
   through the API. Values are envelope-encrypted; every access is audited.
7. **Failure is data.** Quota exhaustion, sandbox scheduling failure, and tool crashes are structured
   fields on the resource, not log lines.
8. **Leases, not lifetimes.** Sandboxes and sessions hold independently renewable leases. A reaper
   reclaims anything whose lease lapsed; nothing is immortal by accident.

---

## 2. Layering

```
                        ┌──────────────────────────────────────────┐
   Console (web SPA) ───┤                                          │
   CLI (`ma`)        ───┤            API Gateway                   │
   SDK (TS)          ───┤   authn · authz · quota · idempotency    │
   Connectors        ───┤   rate limit · audit · request tracing   │
     chat/webhook/      └───────────────────┬──────────────────────┘
     hook/schedule/                         │
     eventbus                               ▼
                        ┌──────────────────────────────────────────┐
                        │              Engine  (control plane)     │
                        │                                          │
                        │  Workspace · Agent · AgentVersion        │
                        │  Session · Credential · Connector        │
                        │  Schedule · Dataset · Skill · Plugin     │
                        │  Model catalogue · Quota · Audit         │
                        └───┬──────────────┬───────────────┬───────┘
                            │              │               │
              ┌─────────────▼───┐  ┌───────▼────────┐  ┌───▼─────────────┐
              │ Sandbox Broker  │  │  Event Store   │  │  Scheduler      │
              │ lease · placement│ │ append-only    │  │ cron · leases   │
              │ provider drivers │ │ seq-ordered    │  │ retries · reaper│
              └─────────┬───────┘  └───────┬────────┘  └─────────────────┘
                        │                  │
                        ▼                  ▼
              ┌──────────────────┐   SSE / WebSocket bridge
              │   Sandbox        │   (resumable from seq)
              │  ┌────────────┐  │
              │  │ Agent Core │◄─┼── controlled runtime protocol
              │  │  harness   │  │
              │  │  main loop │  │
              │  │  tools     │  │
              │  └────────────┘  │
              └──────────────────┘
```

### Component responsibilities

| Component | Owns | Explicitly does not own |
|---|---|---|
| **Gateway** | authn, authz decisions, quota admission, idempotency keys, rate limiting, audit emission | business rules, storage |
| **Engine** | the resource graph, state machines, version resolution, credential brokering | executing agent turns |
| **Sandbox Broker** | sandbox lifecycle, placement, leases, provider abstraction | what runs inside |
| **Runtime / Agent Core** | the agent main loop, tool dispatch, model calls, event emission | persistence, authz |
| **Event Store** | durable ordered event log, cursors, retention, replay | interpretation |
| **Scheduler** | cron evaluation, lease renewal, retry backoff, reaping zombies | delivery semantics |

---

## 3. Resource model

```
Workspace ──┬── Agent ──── AgentVersion (immutable, N)
            │      │            ├── skills[]     (content-addressed)
            │      │            ├── plugins[]    (content-addressed)
            │      │            ├── mcpServers{}
            │      │            ├── subAgents[]
            │      │            ├── modelConfig
            │      │            └── runtimeConfig (compaction, permissions, startup hooks)
            │      │
            │      └── Session (pins resolvedVersion)
            │             ├── Sandbox (leased)
            │             ├── Event[] (append-only, seq)
            │             └── Usage (tokens, cost)
            │
            ├── Credential  (owner: workspace|agent|session|principal)
            ├── Dataset ──── Document (file | external-doc, sync rule)
            ├── Connector ──┬── Binding (external scope → agent)
            │               └── Receipt (one per inbound delivery)
            └── Schedule (a Connector specialization)
```

### 3.1 Identifiers

All ids are prefixed, URL-safe, and sortable: `<kind>_<26-char Crockford base32 ULID>`.
Prefixes: `ws_`, `ag_`, `sn_`, `cr_`, `cn_`, `sc_`, `ds_`, `dc_`, `sk_`, `pg_`, `rc_`, `bd_`, `sb_`.
ULIDs give us lexicographic time ordering and collision-free client-side generation (needed for
idempotent creates). Versions are plain monotonic integers scoped to their Agent.

### 3.2 State machines

**Session** — the most important one. Illegal transitions are rejected by the Engine, not by convention.

```
                   ┌───────────────── interrupt / error ─────────────┐
                   │                                                 ▼
 queued ──► provisioning ──► ready ──► running ──► idle ──► terminating ──► terminated
    │            │             │         │  ▲        │           ▲
    │            │             │         └──┘        │           │
    │            │             │      (turn loop)    └───────────┘
    │            ▼             ▼                      (expire / user stop)
    └────────► failed ◄────────┴──────────────────────────────────┘
```

- `queued` → admitted, awaiting sandbox capacity (quota backpressure lives here).
- `provisioning` → broker is placing a sandbox; `provisioning → failed` carries a structured
  `SandboxError` (e.g. `QUOTA_EXCEEDED`, `PLACEMENT_FAILED`, `IMAGE_PULL_FAILED`).
- `ready` → sandbox bound and Agent Core reachable; `boundAt` stamped.
- `running` → a turn is in flight. `idle` → bound, no turn in flight, lease still held.
- `terminating` → graceful drain (flush events, snapshot context, release sandbox).
- Terminal states `terminated` / `failed` are absorbing; a new session may *resume from* a terminated
  one via context snapshot, but the row itself never re-opens.

**Connector / Schedule**: `draft → active ⇄ disabled → archived → (deleted)`.
Activation validation is **polymorphic per connector type** — deliberately avoiding the defect,
observed in the reference platform, where one integration's validation rules leaked into generic
activation and permanently blocked schedule transitions for every other type.

**Receipt**: `pending → working → succeeded | failed | zombie`.
`zombie` is assigned by the reaper when a `working` receipt exceeds its lease with no heartbeat.

**Document**: `pending → processing → ready | failed` (with `retry` returning to `pending`).

### 3.3 Versioning & resolution

`AgentVersion` is immutable. `agent.latestVersion` is a pointer. A Session may resolve:
- an explicit integer (pinned), or
- `@latest` at creation time — resolved **once**, then frozen into `session.resolvedVersion`.

Optimistic concurrency: `agent update` accepts `expectedLatestVersion`; a mismatch is a `409`.

---

## 4. Runtime protocol

### 4.1 Event envelope

Every event, from every source, uses one envelope. This is what makes replay, audit, and the SSE
bridge a single mechanism.

```ts
interface Event {
  seq: number;            // monotonic per session, gap-free, assigned by the store
  id: string;             // ULID, globally unique
  sessionId: string;
  ts: number;             // epoch ms, wall clock (informational)
  type: EventType;        // dotted namespace, see below
  turn?: number;          // which agent turn produced it
  itemId?: string;        // groups deltas belonging to one item
  payload: unknown;       // type-discriminated, validated per type
  redactions?: string[];  // JSON pointers redacted before egress
}
```

`seq` is authoritative for ordering and resume; `ts` is never trusted for ordering (clock skew).

**Event namespaces**

| Namespace | Events | Meaning |
|---|---|---|
| `session.*` | `created`, `ready`, `resumed`, `interrupted`, `expired`, `terminated`, `failed` | lifecycle |
| `turn.*` | `started`, `completed`, `failed` | one prompt→response cycle |
| `message.*` | `delta`, `completed` | assistant text streaming |
| `thinking.*` | `delta`, `completed` | reasoning stream (redactable) |
| `tool.*` | `requested`, `approved`, `denied`, `started`, `output`, `completed`, `failed` | tool calls |
| `model.*` | `requested`, `completed`, `failed` | upstream model calls + usage |
| `context.*` | `compacted`, `snapshot` | context window management |
| `sandbox.*` | `provisioning`, `bound`, `renewed`, `released`, `lost` | sandbox lifecycle |
| `artifact.*` | `created`, `updated` | files the agent produced |
| `audit.*` | `credential.accessed`, `permission.decided` | security-relevant actions |

### 4.2 Ingress: `UniversalEvent`

Clients drive a session by submitting `UniversalEvent[]` — a closed, validated union:
`user.message`, `user.interrupt`, `tool.result` (for out-of-band approvals), `control.compact`,
`control.terminate`. One submission = one idempotency key = one receipt.

### 4.3 Streaming & resume

`GET /v1/sessions/:id/events/stream?fromSeq=N` — SSE. The `id:` field of each SSE frame carries `seq`,
so a browser's native `Last-Event-ID` reconnect resumes exactly. The server replays persisted events
from `fromSeq`, then switches to live tailing with no gap and no duplicate (the store hands out a
watermark under the same lock that assigns `seq`).

Backpressure: slow consumers are dropped with a `stream.lagged` frame telling them the earliest
available `seq`, rather than being allowed to balloon server memory.

### 4.4 Runtime ↔ Engine contract

The sandbox's Agent Core is **not** trusted. It authenticates with a session-scoped, short-TTL token
minted by the broker, and may only:
- `POST /runtime/v1/events` — append events for its own session (validated against a schema allowlist)
- `POST /runtime/v1/lease/renew` — heartbeat
- `GET  /runtime/v1/credentials/:ref` — exchange a credential *reference* for a value, audited,
  only for refs on its pinned `AgentVersion`
- `POST /runtime/v1/model/completions` — model access through the gateway (never a raw provider key)

It can never read other sessions, mutate control-plane resources, or enumerate credentials.

---

## 5. Sandbox model

A **Sandbox** is a leased, isolated execution environment.

```ts
interface Sandbox {
  id: string; provider: string;          // "local" | "docker" | "k8s" | custom driver
  status: 'pending'|'ready'|'draining'|'released'|'lost';
  image: string; resources: { cpu: number; memoryMb: number; diskMb: number };
  endpoint: string;                       // Agent Core base URL
  leaseExpiresAt: number;                 // renewed by heartbeat
  sessionIds: string[];                   // >1 when reuse is enabled
  network: NetworkPolicy;                 // egress allowlist
  mounts: Mount[];                        // workspace volume, dataset cache
}
```

- **Provider drivers** behind one interface (`provision`, `bind`, `renew`, `release`, `inspect`), so
  `local` (child process, for dev/self-host), `docker`, and `k8s` are swappable. We ship `local` and
  `docker` working; `k8s` as a driver contract.
- **Reuse**: a warm sandbox may serve sequential sessions of the same `AgentVersion` + credential set
  (the hash of that tuple is the pool key), cutting cold-start. Isolation boundary is the tuple, never
  across workspaces. Reuse is gated to *genuinely idle* sandboxes — one whose holder sessions have all
  finished — because agent-core binds a single session for its process life (it fetches its identity
  from `/bootstrap` once and has no rebind). Handing a still-held sandbox to a second session would
  report the second's turns under the first, so that is refused; the full warm-keep-across-sessions
  path awaits a rebind-capable core, and until then reuse degrades to a fresh cold sandbox per session.
- **Two clocks**: `sandbox.leaseExpiresAt` (heartbeat-renewed, short) and `session.expiresAt` (logical,
  long). The reaper reclaims sandboxes whose lease lapsed and marks affected sessions `sandbox.lost`,
  which is recoverable — the session re-provisions and replays context from its snapshot.
- **Prewarm pool**: N idle sandboxes per hot image, refilled asynchronously (the machinery exists but
  is deliberately unwired pending a warming policy).

---

## 6. Trigger plane (Connectors)

One uniform pipeline for every inbound integration:

```
external system
   │  (signed request / poll / cron tick)
   ▼
Connector adapter ── verify signature ── normalize to TriggerEvent
   │
   ▼
dedupe on (connectorId, externalEventId)   ──► already seen? return prior receipt
   │
   ▼
Receipt(pending) ──► resolve Binding (external scope → agent + session policy)
   │
   ▼
sessionPolicy:  new_per_event | reuse_per_scope | reuse_connector
   │
   ▼
Session ──► submit UniversalEvent ──► Receipt(working ⋯ succeeded|failed)
   │
   ▼
optional response callback (reply into the chat / POST back / no-op)
```

Adapters shipped: **webhook** (HMAC-signed generic), **chat** (a bot adapter interface that
Slack, Discord or an internal IM implement), **hook** (outbound-registered callback),
**schedule** (cron), **eventbus** (subscription to an event topic). Each implements
`verify() → normalize() → respond()`; the pipeline in between is shared and adapter-agnostic.

Retry: exponential backoff with jitter, capped attempts, then `failed` with the full error chain on
the receipt. A `failed` receipt is explicitly retryable by an operator.

---

## 7. Credentials & models

**Credential** rows store `{ id, ownerType, ownerId, type, name, ciphertext, keyVersion, expiresAt }`.
- Envelope encryption: a per-row data key wrapped by a KEK from a pluggable `KeyProvider`
  (`local-file` for dev, interface for KMS). `keyVersion` enables rotation without downtime.
- **Write-only**: no API path returns plaintext to a human client. Only the Runtime credential-exchange
  endpoint decrypts, and only for refs on the caller's pinned version — every exchange emits
  `audit.credential.accessed`.
- **OOB authorization** (device-code style) for third-party systems: `authChallenge` issues a
  `displayCode` + `verificationUrl` written to a protected file, and a poll endpoint completes it.
- **Expiry sweeps** proactively mark credentials `expiring`/`expired` and emit warnings on dependent agents.

**Model gateway**: a catalogue of `<provider>/<model>` entries with `contextWindowTokens`,
`compactThresholdTokens`, `securityLevel`, capability flags (`reasoningEffort` options, vision, tools),
and per-workspace routing + quota pools. The runtime never holds a provider key; it calls the gateway,
which attaches credentials, enforces quota, records usage, and emits `model.*` events.

---

## 8. Capabilities: Skills, Plugins, MCP, SubAgents

All four are **content-addressed by sha256** and resolvable from three sources: `registry` (the
built-in marketplace), `upload` (a tarball we store), and `git` (`repoPath` + `branch` + pinned `commit`).
A version records the resolved digest, so a rebuild is byte-identical.

- **Skill** — a prompt-and-scripts bundle (`SKILL.md` + resources), installed into the sandbox at
  a known path and advertised to the harness.
- **Plugin** — code extending the harness (tools, hooks).
- **MCP server** — a `{ command, args, env, transport }` spec; the harness spawns/connects it.
- **SubAgent** — a named, scoped child agent with its own prompt/model/tool allowlist.

A/B fields (`abGroup`, `abVersion`) on installed capabilities allow rolling a skill change to a slice
of sessions — carried over from the reference platform because it answers a real operational need.

---

## 9. Datasets (knowledge)

`Dataset → Document{ source: file|external, syncRule: manual|daily|realtime }`. Ingestion is an async
pipeline: `upload → extract → chunk → embed → index`, with per-document status and retry. Retrieval is
exposed to the agent as a tool (`dataset.search`), not stuffed into the prompt, so the harness decides
when to consult it. The index is pluggable (in-process vector store shipped; interface for external).

---

## 10. Multi-tenancy, authz, quota

- **Workspace** is the tenancy boundary and the unit of membership, quota, and billing.
- **Roles**: `owner > admin > developer > operator > viewer`, checked as
  `(principal, workspace, action, resource)` in one authorization module — never scattered `if` checks.
- **Principals**: human users, service accounts, and connectors, all first-class with API keys/tokens.
- **Quota** dimensions: concurrent sessions, sandbox CPU-minutes, tokens/day, storage, event retention.
  Admission control at the gateway returns `429` with a `Retry-After` and a machine-readable reason,
  and quota exhaustion is recorded as a structured session error rather than an opaque 500.

---

## 11. Observability

- **Events** are the primary telemetry, persisted and replayable per session.
- **Structured logs** with a request id propagated end-to-end.
- **Metrics**: RED per endpoint, session state gauges, sandbox pool utilization, queue depth,
  model latency/tokens, connector delivery success rate.
- **Traces** across gateway → engine → broker → runtime, joined on session id.
- **Audit log** (separate, tamper-evident, longer retention) for authz decisions, credential access,
  and destructive operations, each carrying an operator-supplied reason.

---

## 12. Technology choices

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), Node 22+ | one language across engine/runtime/CLI/SDK/console; the agent-harness ecosystem is TS-native |
| Monorepo | pnpm workspaces | native, fast, strict about phantom deps |
| HTTP | hand-rolled router on `node:http` | zero framework lock-in, full control over streaming/backpressure, no dependency drift |
| Storage | repository interfaces + `node:sqlite` driver (built-in) and Postgres driver | runs with zero external services for dev/self-host; scales out unchanged |
| Validation | hand-rolled schema combinators in `@ma/contracts` | one schema drives types, runtime validation, and OpenAPI generation |
| Tests | `node:test` | built-in, no config, fast |
| Console | dependency-free SPA served by the gateway | no build toolchain to rot; ships as static assets |

The dependency budget is deliberate and near-zero: the platform must be auditable, and a security-
sensitive control plane should not carry a transitive dependency tree it cannot review.

---

## 13. Repository layout

```
packages/
  contracts/    schemas, types, error codes, event definitions — the shared truth
  core/         ids, result types, clock, logger, errors, retry, crypto primitives
  store/        repository interfaces + sqlite & postgres drivers + migrations
  engine/       resource services, state machines, authz, quota, version resolution
  runtime/      agent harness: main loop, tool dispatch, context management, event emission
  sandbox/      broker + provider drivers (local, docker, k8s contract)
  connectors/   adapters + the shared delivery pipeline
  gateway/      HTTP router, SSE, authn, idempotency, OpenAPI
  scheduler/    cron, leases, retries, reaper
  cli/          `ma` — full control-plane coverage, plan/confirm/readback discipline
  sdk/          typed client (browser + node)
  console/      web UI
apps/
  server/       composition root: wires everything, one process or split by role
docs/           architecture, guides, API reference, operations
```

---

## 14. Delivery plan

| Milestone | Content |
|---|---|
| **M1** foundations | contracts, core, store (sqlite), migrations, test harness |
| **M2** control plane | engine resources + state machines + authz + gateway CRUD + event store |
| **M3** execution | sandbox broker (local driver), runtime harness, streaming, resume |
| **M4** triggers | connectors, receipts, scheduler, retries, reaper |
| **M5** capabilities | credentials + model gateway, skills/plugins/MCP, datasets |
| **M6** surfaces | CLI, SDK, console |
| **M7** hardening | quota, observability, docker driver, postgres driver, ops docs, load tests |
