# Managed-Agent

A self-hosted **control plane for hosting, governing and observing autonomous AI
agents**. Teams bring the prompt, the skills and the permission policy; Managed-Agent
runs the agent harness inside an isolated sandbox, owns its session and context
lifecycle, brokers models and credentials, connects it to external triggers, and keeps
a replayable, tamper-evident record of everything it did — from "an event happened" to
"the agent finished, and here is exactly what happened".

It is a from-scratch, dependency-audit re-implementation built to functional and
product parity with a mature commercial managed-agent platform, then taken past it on
robustness and depth. The engineering goal is not a demo; it is a platform whose every
security and lifecycle edge has been adversarially tested.

- **Zero external services to start** — Node runs the TypeScript directly; the database
  is the built-in embedded SQLite.
- **Near-zero dependencies by design** — the control plane brokers credentials, so its
  dependency tree must be small enough to review.
- **One language end to end** — engine, sandbox layer, agent harness, CLI, SDK and
  console are all strict TypeScript.

---

## Table of contents

- [Product positioning](#product-positioning)
- [Features](#features)
- [Design tenets](#design-tenets)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Documentation](#documentation)
- [Project status](#project-status)
- [Development](#development)
- [Deliberately not included](#deliberately-not-included)
- [License](#license)

---

## Product positioning

**The problem.** Teams building on an agent harness keep rebuilding the same
infrastructure: containers and images, session state that survives a laptop closing,
an audit trail of what the agent actually did, safe credential handling, model failover
and cost control, and one bespoke integration per trigger source. That work is common
to every agent and specific to none of them — and it is where production agents
actually fail (lost contexts, leaked secrets, unreviewed actions, runaway spend).

**What Managed-Agent is.** The reusable layer underneath the agent. It does not try to
be a chat product or a domain workbench; it is the multi-tenant control plane that
turns a prompt plus a sandboxed runtime into a governed, observable, resumable service.

**Who it is for.**

- Platform/infra teams who want to host many agents for many workspaces without
  handing data and credentials to a third party.
- Security/compliance-minded operators who need per-action authorization, write-only
  secrets, network isolation and a tamper-evident audit trail.
- Builders integrating agents into their own systems through webhooks, chat bots,
  scheduled jobs, an event subscription feed, a typed SDK or a REST/OpenAPI surface.

**Where it goes further than the reference platform it was measured against.**
Sequence-based (not timestamp-based) stream resume; a connector restore/lifecycle the
reference blocked; resource-scoped fine-grained grants on top of workspace roles;
SCIM-driven offboarding that revokes live tokens immediately; per-session sandbox cloud
identity (`runAs`); model resilience (retry + circuit breaker + failover) with an
atomically-reserved hard budget; a pluggable runtime that can drive an agent written in
any language over a stable bridge protocol. See [Project status](#project-status).

---

## Features

### Triggers & integrations

- **Webhook** — HMAC-signed inbound deliveries; the signature binds the timestamp and
  body, the timestamp must be an integer (a fractional one enables a
  delimiter-shift forgery) and is bounded by a tolerance window.
- **Chat bot** — inbound messages wake an agent; the pipeline opens the event
  subscription *before* submitting, waits for the turn to complete (bounded), and posts
  the answer back best-effort.
- **Generic outbound hook** and an **event-subscription feed** — signed CloudEvents,
  prefix-wildcard filters (`order.*`), a prompt template, and normalization that drops
  events the subscription did not declare.
- **Cron schedules** — a five-field parser that is correct across DST in both
  directions, run-now, and next-fire computation.
- **Uniform delivery pipeline** — every inbound request gets an idempotent **receipt**
  (`pending → working → succeeded | failed | zombie`), a bounded lease with renewal, a
  dead-letter reaper, and retries with full fate tracking.
- **Connector lifecycle** — `draft → active ⇄ disabled → archived`, plus restore and
  hard delete; validation is polymorphic per connector type.

### Agent management

- **Workspace / Agent / Session** model with a full REST API.
- **Immutable, numbered versions** — a running session pins a resolved version and is
  thereafter immune to edits; patch-merge publishing returns a diff so a capability
  cannot be silently dropped.
- **Skills, plugins and MCP servers** — pinned by content digest; single-file skills,
  archive skills, stdio and HTTP MCP servers, plugin subprocesses, and namespaced
  auto-allowed tools.
- **Sub-agents** — scoped delegation where a child's tool set is the *intersection* of
  what it declares and what its parent holds; deny rules are inherited wholesale.
- **Typed setup/dependency commands**, ordered, per-command timeouted.
- **Parameterised agent templates** with a built-in catalogue.
- **Workspace- and agent-scoped memory**, sandboxed so agent-written notes can never
  reach the system prompt.

### Sessions & runtime

- **Exact resume** over a gap-free, append-only event sequence; SSE frames carry the
  sequence as the frame `id`, so a native browser reconnect resumes with no gap and no
  duplicate, even across two events in the same millisecond.
- **Persistence and recovery** — each context snapshot is stored content-addressed and
  digest-verified; a lost sandbox re-provisions inside its TTL and *resumes* the
  conversation **and its turn counter**, rather than restarting.
- **Context compaction** with multiple strategies, task-pinning so the original request
  survives summarization, and a summarize step raced against the turn deadline.
- **Two runtimes** — the built-in TypeScript harness (`runtime: builtin`, default) and
  a pluggable external process (`runtime: command`) that drives turns in any language
  over the public `/runtime/v1/*` bridge protocol, under the same bounded turn
  deadline (a hung process is killed, not allowed to pin a sandbox).
- **Hot upgrade** — publishing a new production version rolls idle sessions onto it
  without a restart, never mid-turn. The same in-place rebind backs the per-session
  model switch, so changing a session's model takes effect on a running sandbox rather
  than only for the next one.
- **Bounded, explainable permissions** — per-tool and per-command policy; compound
  shell commands and re-exec wrappers are refused rather than parsed; every denial names
  the rule so the model can choose a permitted route.
- **Interruption, bounded iterations, backpressure-aware streaming.**

### Sandboxes

- Three drivers: **local** (dev), **container** (Docker/Podman/nerdctl with enforced
  limits), and **Kubernetes** (one non-root pod per sandbox, no service-account token,
  secrets via `secretKeyRef`, per-pod egress NetworkPolicy).
- **Warm reuse with a visible pool key** — the key is a hash of image, resources,
  network policy, mounts, setup commands and the *credential set + credential
  fingerprint*, so a warm sandbox can never serve a different agent or a rotated secret.
- **Prewarming**, independently renewable **session vs sandbox leases**, and a terminal
  state guarantee driven by reapers.
- **Platform-managed volume mounts** — workspace-scoped named volumes, validated
  canonical targets, no host-path binds, archive-grade traversal refusal.
- **Egress isolation** — `--network none` for deny, an allowlist enforced through a
  filtering proxy or a NetworkPolicy; an unenforceable policy is refused, never
  silently widened.
- **Sandbox cloud identity (`runAs`)** — a workspace-confined Kubernetes
  ServiceAccount mapped to a cloud IAM role (AWS IRSA / GKE Workload Identity), so an
  agent reaches cloud resources as itself while the Kubernetes API stays unreachable.

### Credentials & models

- Seven credential shapes — `api_key`, `oauth_token`, `bearer_token`, `env_vars`,
  `file`, `ssh_key`, `basic_auth` — **envelope-encrypted (AES-256-GCM, AAD-bound to the
  row)**, write-only through the API, with key-version rotation.
- Secrets are delivered to sandboxes by reference; file/ssh-key secrets are written
  owner-only to disk (never placed in spawn `argv`/inspectable env).
- A **model gateway** with a per-workspace allowlist, usage/cost metering, and
  three-layer resilience in order: bounded retry with jitter, a per-model **circuit
  breaker**, then declared **failover** models (re-attributing usage to the model that
  answered).
- **The platform holds the model credential** — it lives in the server process and
  never reaches a sandbox, so a compromised agent has no key to steal. Which model an
  agent calls comes from its pinned version, not from anything the sandbox sends.
- **Free-model discovery.** Rather than baking one model id into a deployment, the
  platform asks the provider what it currently offers, classifies a model free only
  when both prompt and completion price are exactly zero (a blank or missing price
  counts as *paid* — the conservative direction), and serves the list tools-capable
  first: `GET /v1/models/free`. An operator registers one with `POST /v1/models/free`
  (admin-only), which re-checks the id against the live catalogue so a paid model can
  never be registered by naming it. The console's **Models** view is this, with an Add
  button per model.
- **Per-session model choice.** A session's model is frozen on its version — that is
  what makes a run reproducible — so "try another model on this conversation" needs its
  own lever rather than a version edit that would silently change every other session.
  `PUT /v1/sessions/:id/model` (null clears it) switches one session; it re-binds an
  idle sandbox so the change takes effect immediately (a session mid-turn answers 409 —
  change it between turns), and is re-validated at call time, so a model later
  un-catalogued or de-allow-listed falls back to the version's model instead of being
  used anyway. Choosing a model is a `developer` action — the same bar as pinning one on
  a version.
- A **hard budget ceiling** — output tokens are clamped at the sink and the worst-case
  spend is atomically *reserved* before each upstream call, so concurrent completions
  cannot race past the daily cap.

### Knowledge, artifacts & content

- **Datasets / knowledge base** with durable BM25 retrieval (the index rebuilds from
  content-addressed storage on restart) and a `search_knowledge` tool scoped to the
  session's pinned datasets.
- **Artifacts** — content-addressed, deduplicated, quota-charged and retention-swept;
  **artifact preview** rendered on a separate sandboxed origin behind a signed,
  expiring token.

### Identity, access control & compliance

- Bearer-token auth: tokens are 256-bit random secrets stored only as SHA-256
  hashes (never plaintext), plus scoped API keys.
- **Workspace RBAC** plus **resource-scoped grants** (a contractor can be "developer on
  this one agent"), purely additive.
- **Third-party SSO** via provider-agnostic **OIDC** (authorization-code + PKCE,
  asymmetric-algorithm-only JWT verification, JWKS, full claim checks).
- **SCIM 2.0** provisioning; setting a user `active:false` (or DELETE) disables the
  principal **and revokes every live token**, so offboarding takes effect on the next
  request.
- A **tamper-evident audit chain** — each entry stores the prior hash and
  `sha256(prevHash ‖ canonical(entry))`; any edit, insert, delete or reorder is detected
  and located by `verifyChain()`, even with direct database access, and retention
  pruning re-anchors the chain at a checkpoint.

### Surfaces

- A typed **TypeScript SDK** (browser + node) with self-resuming streams.
- A full **CLI** (`ma`) covering every resource, with a plan → confirm → readback
  discipline on every mutation; secrets are read from files, never argv.
- A dependency-free **web console** served as static assets by the gateway. It shows
  what a session is actually doing rather than only that it is running: the model in use
  (tagged free/paid, and marked when a session has overridden the agent's default), each
  model call's latency and tokens, and a **failover** labelled with the model it fell
  back from — so a slower or different answer is explained in the log rather than
  looking like a mystery.
- **OpenAPI** generated from the same schemas the handlers parse, with path and
  request-body coverage enforced by tests.

---

## Design tenets

These are load-bearing — every module traces back to one.

1. **The control plane is a broker, never a proxy.** It resolves a session to a runtime
   endpoint and mints a scoped token. Tool output and model tokens never transit it.
2. **Configuration is immutable and versioned; running work pins a version.** A session
   resolves its agent version once and is thereafter immune to edits.
3. **The event log is the source of truth.** Session state is a fold over an append-only,
   gap-free sequence. Resume, audit and time-travel debugging are one mechanism.
4. **Every write is a plan, a confirmation, one attempt, and a readback.** No mutation
   is silently replayed; an ambiguous outcome is reported as ambiguous.
5. **Every inbound trigger produces a receipt and is idempotent.** External systems
   retry; we deduplicate and expose the delivery's full fate.
6. **Secrets are write-only.** A credential value can be created and referenced, never
   read back through the API. Every access is audited.
7. **Failure is data.** Quota exhaustion and sandbox scheduling failures are structured
   fields on the resource, not log lines.
8. **Leases, not lifetimes.** Sandboxes and sessions hold independently renewable
   leases. Nothing is immortal by accident.
9. **Fail closed at security boundaries.** An unenforceable network policy, an
   unsigned connector, or a credential that cannot be validated refuses rather than
   silently degrades to open.
10. **Durations run on monotonic time; deadlines use a single shared clock.** NTP steps
    and DST cannot extend a cooldown, a lease or a signature window.

---

## Architecture

```
                 Console · CLI · SDK
        webhook · chat · hook · eventbus · cron   (Connectors)
                              │
                       ┌──────▼──────┐
                       │   Gateway   │  HTTP router · authn/authz · quota
                       │             │  idempotency · rate limits · resumable SSE · OpenAPI
                       └──────┬──────┘
                              │  (mints a scoped token; never proxies model/tool traffic)
                       ┌──────▼──────┐
                       │   Engine    │  resource services · state machines · RBAC
                       │             │  credential & model services · event bus · OIDC/SCIM
                       └──┬─────┬────┘
              Append-only │     │ Leases · cron · retries · reaping (scheduler loops)
              event store │     │
                  ┌───────▼─┐ ┌─▼──────────┐
                  │  Store  │ │   Sandbox   │         local · container · k8s drivers
                  │ SQLite  │ │   Broker    │  pool/reuse · prewarm · volumes · egress · runAs
                  └─────────┘ └──────┬──────┘
                                     │  /runtime/v1 bridge (bootstrap · completions · events)
                              ┌──────▼──────────────────────┐
                              │  Sandbox → Agent Core        │
                              │  harness: main loop, tools,  │
                              │  MCP/skills, compaction,     │
                              │  knowledge retrieval         │
                              └──────────────────────────────┘
```

### Layers

| Package | Responsibility |
|---|---|
| `@ma/contracts` | schemas, domain types, the event protocol, lifecycle state machines — the shared truth |
| `@ma/core` | ids (ULID), errors, clock, logging, retry, circuit breaker, crypto primitives, env trust |
| `@ma/store` | repository interfaces, migrations, the embedded SQLite driver |
| `@ma/engine` | resource services, authorization, quota, version resolution, event bus, OIDC/SCIM |
| `@ma/sandbox` | the broker, leases, warm pool, volumes, and the local/container/k8s drivers |
| `@ma/runtime` | the agent harness: main loop, tool dispatch, context/compaction, MCP/skills |
| `@ma/gateway` | HTTP routing, middleware, the runtime bridge, resumable SSE, OpenAPI |
| `@ma/connectors` | trigger adapters, the delivery pipeline, cron scheduling |
| `@ma/sdk` · `@ma/cli` · `@ma/console` | the developer/operator surfaces |
| `apps/server` | composition root that wires the packages into one deployable process |
| `apps/agent-core` | the harness process that runs inside a sandbox |

### A request's life, end to end

1. An inbound trigger (or API call) reaches the **Gateway**, which authenticates,
   authorizes against a named action, applies rate limits and idempotency, and admits
   against quota — all before any irreversible work.
2. The **Engine** validates the request against a schema, drives the relevant state
   machine in a transaction, and appends events to the log as part of the same commit.
3. The **Sandbox Broker** acquires (or reuses/warms) an isolated sandbox and mints a
   scoped, short-lived token; model and tool traffic flows directly between Agent Core
   and its dependencies, never back through the control plane.
4. **Agent Core** boots from the pinned, content-addressed version, exchanges
   credentials by reference, runs the bounded turn loop with permission checks on every
   action, and emits a gap-free event stream.
5. Events persist to the Store and fan out to live SSE subscribers best-effort; a slow
   consumer falls back to re-reading the durable log instead of unbounded buffering.
6. Every authorization decision, credential access and destructive operation is appended
   to the tamper-evident audit chain.

### Consistency & data model

- One embedded **SQLite** database (via `node:sqlite`) holds resources, the event log
  and the audit chain; the repository interfaces keep the driver swappable, and dev /
  self-host needs zero external services.
- State changes and their events commit together; sequence numbers, sandbox claims,
  leases and reapers use compare-and-set so concurrent workers cannot double-act or
  clobber each other.
- Background loops (scheduler, expiry, lease and retention sweeps) are leased,
  idempotent, and bounded so they cannot scan an ever-growing table or starve the rest
  of the system.

### Security model (summary)

Authenticated, scoped tokens; deny-default RBAC with additive resource grants;
envelope-encrypted, write-only secrets with per-row AAD; network and volume isolation
at the sandbox layer; signed, expiring preview tokens; constant-time signature
comparison; integer-only signed timestamps; fail-closed handling of missing credentials,
unsigned ingress and unenforceable network policies; and a hash-chained audit log. The
control plane itself is dependency-audit, so this surface is small enough to reason
about. Read [`docs/architecture.md`](docs/architecture.md) for the full model.

### Observability

Replayable per-session events; structured logs with an end-to-end request id; a
Prometheus `/metrics` endpoint (off unless configured) with bounded-cardinality RED
metrics, live session/sandbox/receipt gauges, scheduler ticks, and model collectors
(requests, retries, circuit-breaker state, failover, tokens, cost and latency); and the
separate, longer-retention tamper-evident audit log.

---

## Getting started

Requires **Node 24+** and **pnpm 9**. There is no build step — Node runs the
TypeScript directly.

```bash
pnpm install
pnpm check          # lint, typecheck, and the full test suite
pnpm start          # demo mode: console + API + model, http://127.0.0.1:8080
```

`pnpm start` runs [`scripts/start.sh`](scripts/start.sh), the recommended way to launch
locally. **Demo mode (the default)** serves the console and API in one process, injects
an offline **echo** model (or OpenRouter if you give it a key), seeds a ready-to-run
**Demo** workspace, fixes the admin token to `demo-admin-token` when it loads
`.env.demo`, and opens your browser. It defaults to an in-memory database so a run leaves
nothing behind.

```bash
pnpm start                                    # demo, echo model, opens the browser
pnpm start -- --openrouter-key sk_...         # demo against a real model
pnpm start -- --model vendor/model:free
pnpm start -- --port 9090 --host 0.0.0.0      # custom bind (note the `--` after pnpm)
pnpm start -- --memory                        # ephemeral DB (demo default)
pnpm start -- --database ./data/local.db      # durable file DB
pnpm start -- --prod --token s3cret           # the real server, fixed admin token
pnpm start -- --no-open                       # don't open a browser
```

> pnpm forwards flags after `--`; call `./scripts/start.sh --help` directly (or
> `pnpm start -- --help`) for the full option list: mode, host, port, database,
> log level, sandbox driver, OpenRouter key/model, fixed token, and more.
>
> For a real OpenRouter key without flags, copy `.env.demo.example` to `.env.demo`
> (gitignored), fill it in, and run `pnpm start` (or `pnpm demo`, the older
> wait-then-open wrapper).

### Production-shaped server

The demo adds an echo fallback and seed data on top of the real server. The plain
server entry is the same thing without those two conveniences — give it a key and it
wires the model provider too, so an agent can run a real turn:

```bash
export MA_OPENROUTER_API_KEY=sk-or-v1-…
export MA_OPENROUTER_MODELS=vendor/model:free     # optional; see "picking a model"
pnpm start -- --prod          # via the launcher (fixed token with --token)
pnpm dev                      # == node apps/server/src/main.ts
```

With a key but no model yet, the provider is still wired — that is deliberate, because
"show me which free models exist, then pick one" is the natural first step. A session
cannot run until a model is registered and pinned, so nothing is widened meanwhile.

`pnpm dev` uses the durable file database `./data/managed-agent.db` (its parent
directory is created automatically on first run). With an empty database a bootstrap
admin is created and its token is printed **once**:

```
  A bootstrap admin was created because the store was empty.
  Token:   <shown once>
```

#### Picking a model

Models are catalogued per platform; an agent version pins one by id, and a session may
override it. **Free-only by default**: a model id without a zero price is dropped with a
warning unless you set `MA_OPENROUTER_ALLOW_PAID=true`. A paid model is then catalogued
at the price OpenRouter lists for it, so the daily cost cap sees what it spends; one
that charges per request, image or web search — spend the platform cannot meter — is
left out with a warning instead. The demo entry applies the same rules to its model.

```bash
# See what the provider offers for free, tools-capable first:
ma model free                  # or: curl -H "Authorization: Bearer $MA_TOKEN" $MA_URL/v1/models/free
ma model free --all            # include models that cannot call tools

# Register one into this platform's catalogue:
ma model free-add --model nvidia/nemotron-3.5-lightning:free --yes
ma model list                  # what is registered
```

The console's **Models** view does the same with an Add button per model. Then name it
where you want it used:

- **For an agent**: `{"model": {"modelId": "…"}}` in its version spec. New sessions on
  that version use it.
- **For one session**: the **Change** control on the session page (or
  `ma session model --session sn_… --model …`, or
  `PUT /v1/sessions/:id/model`). This affects that conversation only — the agent's
  version is untouched, and other sessions keep using it. `--clear` / `null` goes back
  to the version's model.

A model without function-calling can still answer, but it cannot drive the agent's
tools; the picker labels those (`— no tool support`).

Then open the console at <http://127.0.0.1:8080>, or use the CLI:

```bash
export MA_URL=http://127.0.0.1:8080
export MA_TOKEN=<the token>

ma workspace create --name "Platform" --slug slug            # prints a plan
ma workspace create --name "Platform" --slug slug --yes      # applies it

ma agent create --workspace ws_… --name Reviewer --spec ./agent.json --yes
ma session create --agent ag_… --yes
ma session watch --session sn_…
```

`--spec` takes an agent version spec. The smallest one that runs:

```json
{
  "systemPrompt": "You review code and report concrete defects.",
  "model": { "modelId": "claude-sonnet-5" }
}
```

Creating an agent with a spec publishes version 1. Without one you get an agent with no
versions; publish a version later with `ma agent version create`. Everything else —
tools, skills, sandbox size, sub-agents, credentials — has a default and is described in
[`docs/architecture.md`](docs/architecture.md).

Mutations print a plan and change nothing without `--yes`. That is not a prompt to click
through; it is the whole discipline. Operational configuration (sandbox driver, egress,
OIDC/SCIM, keys, ports) is documented in [`docs/operations.md`](docs/operations.md).

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the full architecture: resource
  model, state machines, runtime protocol, sandboxes, security, observability.
- [`docs/runtime-protocol.md`](docs/runtime-protocol.md) — the `/runtime/v1/*` bridge
  contract for plugging in a foreign-language runtime, with a reference implementation.
- [`docs/operations.md`](docs/operations.md) — deployment and configuration.
- [`docs/user-guide.md`](docs/user-guide.md) — using the platform screen by screen.
- [`docs/parity.md`](docs/parity.md) — an honest, row-by-row capability accounting
  against the reference platform, including every adversarial hardening round.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — standards and commit conventions.

---

## Project status

- **Capability parity: complete.** Every capability in the reference platform's matrix
  is delivered (44/44), plus eight capabilities the reference does not list at all —
  52 rows in [`docs/parity.md`](docs/parity.md), all ✅.
- **Current phase: adversarial hardening.** With feature parity reached, the work is a
  repeating security/correctness audit — pick a surface that has never been reviewed,
  fan out adversarial finders, refute every report by default against the code, and fix
  each confirmed defect test-first. Findings and fixes are chronicled round by round in
  [`docs/parity.md`](docs/parity.md).
- **Test posture:** ~1,550 tests run against the *real* embedded SQLite driver and a
  *real* HTTP server rather than mocks — the behaviour worth testing is exactly what a
  mock would agree with and get wrong.
- **The only things genuinely unbuilt are deployment integrations, not application
  code:** a managed egress-proxy image and a CNI that enforces Kubernetes
  `NetworkPolicy`. The platform already *enforces* its allowlist and refuses an
  unenforceable one; it integrates with rather than ships those infrastructure pieces.

---

## Development

```bash
pnpm test           # tests only (node:test, no config)
pnpm lint           # project-specific invariants
pnpm typecheck      # strict TypeScript across the monorepo
```

Tests run against the real SQLite driver and a real HTTP server. Tamper-evidence and
isolation tests reach past the repository to the raw database / sandbox boundary the way
an attacker would, then assert detection.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for standards and the commit convention
(AI-assisted commits are credited with an `Assisted-By:` trailer, never a fake
`Co-authored-by`).

---

## Deliberately not included

No vertical chat workbench, no opinionated artifact/ML pipeline, no heavy knowledge-base
product, and no bundled egress proxy/CNI. The platform does the common, stable, reusable
governance layer well; domain knowledge, scenario design and the last mile of network
infrastructure belong to whoever builds on it.

## License

Apache-2.0
