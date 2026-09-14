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
| **Runtime / Agent Core** | the agent main loop, tool dispatch, model calls, event emission — the loop is pluggable (built-in harness or a command runtime; see `runtime-protocol.md`) | persistence, authz |
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
  mounts: Mount[];                         // managed named volumes: {name, target, readOnly}, workspace-scoped
  runAs: string;                           // optional cloud (service-account) identity; k8s-only, workspace-confined
}
```

- A **Mount** is a platform-managed named volume, never a host path: `{ name, target, readOnly=true }`.
  A `VolumeManager` maps `(workspace, name)` to a confined `<MA_VOLUME_ROOT>/<workspaceId>/<name>`
  directory — ULID- and segment-validated, with the archive extractor's escape refusal — so a workspace
  can only ever reach its own data, and "delete this workspace" is a directory removal. `readOnly` is the
  default; a mount is the one durable, potentially-writable surface beside the ephemeral `/workspace`.
  Realized per driver: a `--mount type=bind` (container, `readonly` enforced), a `hostPath` + `volumeMount`
  (k8s), a workdir symlink + `MA_VOLUME_<NAME>` env (local, read-only advisory). Fail-closed: a declared
  mount with no volume storage configured is refused, never silently dropped.

- **`runAs`** is an optional cloud identity a version's sandbox runs under — a single DNS-1123 label, empty
  by default (the sandbox has no identity beyond the platform's own). On the **k8s driver** it becomes a
  workspace-confined `serviceAccountName`: `confineServiceAccount(workspace, runAs)` prefixes the value with
  the workspace ULID, so a workspace can only ever name a ServiceAccount provisioned for it — the same
  defence-by-construction as the volume store. A cloud identity provider (AWS IRSA, GKE Workload Identity)
  keys off that name to grant a scoped cloud IAM role. Crucially, `automountServiceAccountToken` stays
  **false** regardless, so `runAs` grants a *cloud* identity without granting any reach into the Kubernetes
  API — a compromised sandbox still has no cluster credential. The **container and local drivers** have no
  service-account mechanism and **refuse** a non-empty `runAs` (`SANDBOX_IDENTITY_UNSUPPORTED`) rather than
  run without the identity it promises — the same fail-closed rule as an unenforceable egress allowlist.

- **Provider drivers** behind one interface (`provision`, `bind`, `renew`, `release`, `inspect`), so
  `local` (child process, for dev/self-host), `docker`, and `k8s` are swappable. We ship `local` and
  `docker` working; `k8s` as a driver contract.
- **Reuse**: a warm sandbox may serve sequential sessions of the same `AgentVersion` + credential set
  (the hash of that tuple is the pool key), cutting cold-start. Isolation boundary is the tuple, never
  across workspaces. The pool key hashes workspace + image/resources + network + setup + `allowReuse` +
  credentials + **mounts** + **`runAs`** — so a warm sandbox that carries a mounted volume, or a bound
  cloud identity, is never claimed by a session that mounts a different set (or none) or asked for a
  different identity: neither the reused filesystem nor the reused identity can leak across
  configurations. **Opt-in** per agent (`allowReuse`, default off): a finished session's sandbox is
  kept warm and holderless, and the next session of the same pool key claims it and **rebinds** —
  `POST /rebind` on the agent-core tears down the previous session's context, working directory and
  subprocesses and re-bootstraps as the new session (a full reset, because the pool key excludes the
  agent version, so the next session may be a different agent). Reuse still fires only once the prior
  session is terminal (a live holder is never displaced), and the bridge's token→session cache is
  invalidated on release so a reused token resolves to the session the sandbox now serves. A rebind
  failure falls back to a cold sandbox; a warm sandbox is reaped past `idleTimeoutSeconds` /
  `maxLifetimeSeconds`.
- **Two clocks**: `sandbox.leaseExpiresAt` (heartbeat-renewed, short) and `session.expiresAt` (logical,
  long). The reaper reclaims sandboxes whose lease lapsed and marks affected sessions `sandbox.lost`,
  which is recoverable — the session re-provisions and replays context from its snapshot.
- **Prewarm pool**: N idle sandboxes per pool key (`MA_SANDBOX_PREWARM`, default 0), refilled reactively
  when a session in an `allowReuse` pool releases. A prewarmed sandbox boots its agent-core idle
  (session-less, against a synthetic holder) and binds to its first real session via `/rebind`;
  unclaimed warm sandboxes are collected by the idle reaper. Warming is reactive — pools with recent
  traffic stay hot, idle pools cost nothing.

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
- **Attaching costs as much as reading.** A session's `credentialIds` are exchangeable for plaintext by
  its running agent, so naming a credential at `session.create` is exactly as powerful as reading it.
  `session.create` is an *operator* action but `credential.read` is a *developer* one, so `create()`
  authorizes each caller-supplied id with `credential.read` (and confirms same-workspace) before it is
  attached — otherwise an operator could name a credential it may not read and exfiltrate it in one turn.
  Ids inherited from the pinned version are exempt: a developer set them at `agent.version.create`, and an
  operator must still run such an agent without holding read itself. **The same check guards the second
  write path**: `agent.version.create` authorizes `credential.read` for each *newly pinned* credential id,
  so the version-inherited exemption above is sound by construction and cannot be used — even by an
  API key scoped to agents only — to launder an unreadable secret into an exchangeable list. This is what
  makes `exchange`'s membership check (`session.credentialIds.includes(id)`) sound — every id on the list
  passed `credential.read` at whichever write path put it there.
- **OOB authorization** (device-code style) for third-party systems: `authChallenge` issues a
  `displayCode` + `verificationUrl` written to a protected file, and a poll endpoint completes it.
- **Expiry sweeps** proactively mark credentials `expiring`/`expired` and emit warnings on dependent agents.

**Model gateway**: a catalogue of `<provider>/<model>` entries with `contextWindowTokens`,
`compactThresholdTokens`, `securityLevel`, capability flags (`reasoningEffort` options, vision, tools),
and per-workspace routing + quota pools. The runtime never holds a provider key; it calls the gateway,
which attaches credentials, enforces quota, records usage, and emits `model.*` events. Three layers of
resilience compose. First, **retry**: a *retryable* failure on the model the session asked for is retried
in place with bounded exponential backoff + full jitter (`MA_MODEL_RETRY_*`, `1` disables), so a
transient blip is absorbed on the *requested* model rather than escalating. Second, a **circuit breaker**:
once a model records `failureThreshold` retryable failures within a window (`MA_MODEL_BREAKER_*`), its
breaker opens and requests skip it *instantly* — no retry, no provider call — for a cooldown, then admit
one probe (success closes it, failure re-opens it), so a sustained outage stops costing every session its
retry budget and stops hammering a struggling provider; per-model and in-process. Third, **failover**: a
version may declare `fallbackModelIds`, and when a model exhausts its retries *or* is skipped by an open
breaker the gateway walks the remaining declared models in order until one answers — re-checking each
model's enablement and workspace allowlist, and billing/attributing to the model that actually ran. So a
transient blip stays on the requested model, a sustained outage is skipped and degrades to a fallback, and
only an exhausted chain fails the turn. A non-retryable error surfaces at once (and never trips the
breaker); a broken fallback is skipped. All three are exported as metrics (`ma_model_retries_total`,
`ma_model_breaker_state`/`ma_model_breaker_skips_total`, `ma_model_failover_total`).

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

The search index is in-memory, but its content is **durable**: each document's bytes are persisted to a
workspace-scoped blob store (the same content-addressed store artifacts and context snapshots use, under
`<MA_ARTIFACT_ROOT>/documents`), keyed by the digest already stored on the document row. At startup the
pipeline rebuilds the index from that store — paging every `ready` document across all datasets — before
the process accepts traffic. Without this the index lived only in the process that ingested a document,
so a restart left retrieval blind to everything already ingested; the blob store is what makes knowledge
survive a restart.

---

## 10. Multi-tenancy, authz, quota

- **Workspace** is the tenancy boundary and the unit of membership, quota, and billing.
- **Roles**: `owner > admin > developer > operator > viewer`, checked as
  `(principal, workspace, action, resource)` in one authorization module — never scattered `if` checks.
- **Resource-scoped grants** add fine grain without a second model: a principal may hold a role on one
  specific resource, and the effective role for an action on that resource is the *higher* of their
  workspace role and the grant. A grant only raises access, never lowers it, and never applies to any
  other resource — so it is purely additive and the default path is unchanged. Resolution stays in the
  one authorizer (the caller passes the resolved grant via `AuthorizeOptions.resourceGrantRole`);
  scopes and the ownership rule apply exactly as before. Granting is gated at the `workspace.members.update`
  bar and audited.
- **Principals**: human users, service accounts, and connectors, all first-class with API keys/tokens.
- **Identity federation (SSO)** is an *additional way to obtain a token*, not a second authz model. An
  OIDC login (`/auth/v1/:provider/*`, authorization-code + PKCE, sealed CSRF/nonce state) verifies the
  IdP's ID token against its JWKS with an asymmetric-only algorithm allowlist and full claim checks,
  get-or-creates a principal keyed on `oidc:<provider>:<sub>`, reconciles workspace membership from group
  claims *additively*, and ends by minting an ordinary session token — so the bearer middleware, the
  role checks above, scopes and audit all apply to a federated caller unchanged. Provider bindings are
  data (`IdpConfig`), so any OIDC IdP works without code; the client secret is injected like an
  encryption key, never persisted. Off unless configured.
- **SCIM 2.0 provisioning** (`/scim/v2/Users`) is the lifecycle layer around that login. An IdP
  provisions users *ahead of* first sign-in into the same `oidc:<provider>:<externalId>` subject the
  login matches (one shared `federatedSubject`, so the two never drift and converge on one principal),
  and — the offboarding guarantee — a deactivate (`active:false`/DELETE) disables the principal and
  revokes every live API key it holds, so a removed user's tokens die on the next request rather than at
  expiry. A dedicated SCIM bearer token (its own auth surface, constant-time), never grants admin,
  scoped to one provider. Off unless configured.
- **Quota** dimensions: concurrent sessions, sandboxes, tokens/day, cost/day (micro-dollars), storage
  (MB), agents, event retention. Admission control at the gateway returns `429` with a `Retry-After` and
  a machine-readable reason, and quota exhaustion is recorded as a structured session error rather than
  an opaque 500. Limits are per workspace and mutable by an owner (`PUT /v1/workspaces/:id/quota`,
  merge-semantics); the `GET /quota` snapshot reports live usage for every dimension, including summed
  artifact storage. The **daily token *and* cost budgets** are enforced both at admission *and* on every
  model completion, so a running session cannot burn past `maxTokensPerDay`/`maxCostMicrosPerDay` — not
  just admission gates. Both are backed by an exact per-`(workspace, UTC-day)` counter (`usage_daily`)
  bumped in the same transaction as each usage record, so the totals are O(1) to read on the hot path and
  the two gates agree by construction; each cap is soft by at most one in-flight completion. Cost and
  tokens are independent — a run is refused the moment either is exhausted — and a cost cap of `0` means
  unlimited (opt-in), distinct from a token cap of `0` which blocks all usage. The same daily counter
  doubles as a spend record: `GET /v1/workspaces/:id/usage?from=&to=` returns the per-day token+cost
  series and a total over a bounded range (admin-gated `usage.read`, since spend is billing data) —
  reporting only, never enforcement.

---

## 11. Observability

- **Events** are the primary telemetry, persisted and replayable per session.
- **Structured logs** with a request id propagated end-to-end.
- **Metrics**: a Prometheus `/metrics` endpoint (its own scrape-token surface, off unless configured).
  RED per endpoint — request/error counters and a latency histogram labelled by the route *template*,
  never a concrete id, so cardinality stays bounded — plus scrape-time session and sandbox gauges by
  status from live store aggregates. A zero-dependency in-process registry records into it from the
  gateway middleware. Model latency/tokens and connector delivery rate are the next collectors to add on
  the same registry.
- **Traces** across gateway → engine → broker → runtime, joined on session id.
- **Audit log** (separate, tamper-evident, longer retention) for authz decisions, credential access,
  and destructive operations, each carrying an operator-supplied reason. Tamper-evidence is a hash
  chain: every entry stores the prior entry's hash and its own `sha256(prevHash ‖ canonical(entry))`, so
  editing, inserting, deleting or reordering any historical row breaks the chain and `verifyChain()`
  (admin-only, `GET /v1/audit/verify`) reports where — even against direct database access. The chain
  head is a durable row and retention pruning records a checkpoint, so a legitimate prune re-anchors the
  chain rather than breaking it, while a tail-truncation is still detected. Appends serialize under the
  single-writer `BEGIN IMMEDIATE` lock, so the chain cannot fork.

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
