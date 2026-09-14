# Capability parity

An honest accounting against the reference platform's own capability matrix.
"Delivered" there is what its documentation lists as shipped; "planned" is what
it lists as roadmap. A **beyond reference** row is a capability this platform
ships that the reference matrix does not list at all — where the goal has moved
from matching to surpassing.

---

## Triggers

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Chat bot | delivered | ✅ | Round trip: inbound delivery works, and the pipeline now replies. It opens a subscription to the session's event stream *before* submitting, waits for the assistant `message.completed` / `turn.completed` (bounded by a timeout), and posts the answer back through the adapter's `respond`. Best-effort and out of band — a reply that fails or times out does not fail the already-succeeded delivery |
| Webhook | delivered | ✅ | HMAC over `timestamp.body`, replay-bounded |
| Cron schedule | delivered | ✅ | Five-field parser, DST-correct in both directions, run-now and next-fire |
| Event subscription | delivered | ✅ | A filtered push feed. `eventbus` connectors verify an HMAC-signed CloudEvents envelope, then `normalize` drops any event whose `type` or `source` the subscription did not declare — so an agent wakes only for the events it asked for, not every delivery. Prefix wildcards (`order.*`), a prompt template (`{{type}}`/`{{source}}`/`{{data}}`), and envelope-or-wrapper parsing. A pull consumer (Kafka/SQS) is deliberately out of scope: it needs a broker client the zero-dep design does not own |
| Connector lifecycle | delivered | ✅ | Full draft → active → disabled/failed → archived state machine, with `archived → draft` **restore** (the reference blocked restore, forcing a recreate that lost delivery history). Plus hard **delete** (`DELETE /v1/connectors/:id`, admin-only): removes the connector and — via `ON DELETE CASCADE` foreign keys — its bindings and receipts atomically, and frees its external key so ingress to it stops immediately (`404`). Archive is the reversible default; delete is the deliberate, irreversible one for a mistaken connector or a tenant offboarding. This also retired two built-but-uncalled `deleteForConnector` helpers the FK cascade made redundant |
| SDK | planned | ✅ | Typed TS client, self-resuming streams |
| CLI | planned | ✅ | Workspace, agent, session (incl. renew), credential, artifact, memory, template, connector (create/list/get/update/activate/status/run/next-fire/receipts), receipt retry, dataset (create/list/add-document/documents/bind), and audit. Every mutation follows plan → confirm → readback; secrets and document content are read from files, never argv |
| OpenAPI | planned | ✅ | Generated from the gateway's own schemas: entity/response shapes from the contracts, and request bodies from the shared `request-schemas.ts` the handlers parse with (`.toJsonSchema()` on the same constant, never a re-typed literal). Path coverage is enforced both directions and a test deep-equals every documented request body against its parse schema, so neither a path nor a body can drift |

## Agent management

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Workspace / Agent / Session | delivered | ✅ | |
| Version control | delivered | ✅ | Plus patch-merge with a returned diff |
| Skills and MCP install | delivered | ✅ | End to end. Versions pin skills/plugins to a content digest (git/registry/upload resolvers, all wired); agent-core downloads them by digest, injects single-file skill instructions, unpacks archive skills, registers skill-declared tools, launches MCP stdio/http servers and plugin subprocesses, and proxies their tools (namespaced `mcp__`/`skill__`/`plugin__`, auto-allowed under strict policy). Artifacts persist on disk |
| Permission management | delivered | ✅ | Roles, scopes, per-tool and per-command policy; every route names its action |
| Resource-scoped grants (fine-grained authz) | **beyond reference** | ✅ | Beyond workspace-wide roles, a principal can be granted a role on *one specific resource* (this agent, this dataset) via `POST /v1/workspaces/:id/grants`. The effective role is `max(workspaceRole, grant)` — a grant only ever **raises** access on the resource it names, never lowers it and never leaks to a sibling, so it is purely additive: absent a grant, authorization is exactly the prior workspace-role decision (regression-guarded). API-key scopes still bind (a grant raises the role, not the key's reach), the ownership rule is untouched, and it all stays in the one `RoleAuthorizer` — no scattered checks. Granting/revoking is gated at the same bar as changing membership and audited. Enables least-privilege delegation (give one contractor developer on one agent) the workspace-role model alone cannot express. See `authz.ts` (`resourceGrantRole`), `agents.ts` (`requireOnResource`) |
| Dependency configuration | delivered | ✅ | Typed `setupCommands`, run by the agent core before the first turn |
| Knowledge base | delivered | ✅ | BM25 retrieval, ingested and reachable *and durable across restarts*: agent-core registers a `search_knowledge` tool backed by `/runtime/v1/search`, which scopes the query to the session's pinned datasets. A running agent can recall an ingested document. Document content is persisted to a workspace-scoped blob store (the same content-addressed machinery artifacts and snapshots use), so the in-memory BM25 index is rebuilt from durable storage at startup rather than living only in the process that ingested it — previously a restart left the index empty and `search_knowledge` silently returned nothing for every prior document. See `knowledge.ts` (`IngestionPipeline` blob persistence + `rebuild`), `platform.ts` (documents blob root + startup rebuild) |
| SubAgent management | planned | ✅ | Scoped delegation; a child's tools are a subset of its parent's |
| Memory | planned | ✅ | Workspace and agent scope; agent-written memories cannot reach the system prompt |
| Artifact storage | planned | ✅ | Content-addressed, deduplicated, quota-charged, retention-swept |
| Artifact preview | delivered | ✅ | Rendered on a separate origin under a sandbox CSP, gated by a signed token; disabled unless a preview origin is configured |
| Agent templates | delivered | ✅ | Parameterised blueprint catalogue with built-ins; instantiation goes through the ordinary agent-create path |

## Sessions

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Resume | delivered | ✅ | Exact, via gap-free sequences |
| Renewal | delivered | ✅ | Independent session and sandbox leases; `POST /v1/sessions/:id/renew` |
| Persistence and recovery | delivered | ✅ | A lost sandbox re-provisions inside its TTL, and now *resumes* rather than restarting: the harness persists each context snapshot's bytes (content-addressed, digest-verified) through the runtime bridge; the reference is recorded on the session; a recovering sandbox fetches it at bootstrap and restores the conversation, emitting `session.resumed`. A corrupt or missing snapshot falls back to a fresh start |
| Sandbox reuse | planned | ✅ | Warm-across-sessions, delivered end to end. Opt-in per agent (`allowReuse`, default off). A finished session's sandbox is kept warm (holderless, `idleSince`), and the next session of the same pool key (workspace + spec + credential set) claims it and rebinds its agent-core process: `POST /rebind` tears down the previous session's context, workdir and subprocesses and re-bootstraps as the new session. Isolation is enforced by a full reset (a live end-to-end test asserts no context leak and correct attribution) plus stale-cache invalidation on the bridge; a warm sandbox is reaped past `idleTimeoutSeconds`/`maxLifetimeSeconds`; rebind failure falls back to a cold sandbox |
| Terminal-state guarantee | planned | ✅ | Expiry reaper drives every session to a terminal state, including one stuck mid-shutdown |

## Runtime

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Agent harness | delivered | ✅ | Main loop, tool dispatch, interruption, bounded iterations — run by `apps/agent-core` |
| SSE resume | delivered | ✅ | Sequence-based rather than timestamp-based |
| Startup scripts | delivered | ✅ | Typed, ordered, with a per-command timeout and an optional flag |
| Multiple runtimes | planned | ✅ | The agent loop is pluggable. `runtime: builtin` (default) runs the platform's TypeScript harness; `runtime: command` runs an operator-declared process that drives its turns over the public `/runtime/v1/*` bridge protocol (bootstrap/completions/events) — an agent in any language. Proven end to end by a live test where a foreign Node process runs a full turn; documented in `docs/runtime-protocol.md` with a reference runtime in `examples/runtimes/` |
| Context compaction | planned | ✅ | Two strategies, cheapest first |
| Hot upgrade | planned | ✅ | Publishing a new production version rolls idle sessions onto it without a restart: the scheduler sweep re-pins an idle/ready session's `resolvedVersion` and rebinds its sandbox in place via `/rebind` (or, if the new version's sandbox spec changed the pool key, releases and cold re-provisions). Never mid-turn — a running session upgrades when it next goes idle. Emits `session.upgraded` |

## Sandbox

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Image and dependency install | delivered | ✅ | Via the spec and setup commands |
| Volume mounts | delivered | ✅ | Platform-managed, workspace-scoped named volumes. A version declares `sandbox.mounts` — a named volume mounted at a validated absolute target, read-only by default. The platform owns every source path (no host-path binds): a `VolumeManager` maps `(workspace, name)` to a confined `<root>/<workspaceId>/<name>` directory, ULID- and segment-validated with archive-extractor-grade escape refusal, so a workspace can only ever reach its own data. Each mount enters the pool key, so a warm reused sandbox never leaks its filesystem to a differently-mounted session. Realized per driver — `--mount type=bind` (container, `readonly` enforced), `hostPath` + `volumeMount` (k8s), a workdir symlink + `MA_VOLUME_<NAME>` env (local, read-only advisory). Fail-closed: a declared mount with no `MA_VOLUME_ROOT` is refused, not silently dropped. A live test proves cross-session persistence and cross-workspace isolation |
| Renewal, recovery, state sync | delivered | ✅ | Lease heartbeats; the reaper confirms before writing off; and a reaped sandbox's ids now flow back through the scheduler to recover the sessions that held them (`onSandboxReap` returns them), so a lost sandbox re-provisions its still-in-TTL session |
| Prewarming | planned | ✅ | Reactive: when a session in an `allowReuse` pool releases, the pool is topped back up to `MA_SANDBOX_PREWARM` warm sandboxes (default 0 = off). A prewarmed sandbox boots its agent-core **idle** — session-less, against a synthetic holder — and binds to its first real session via `/rebind` on claim. Unclaimed warm sandboxes are collected by the idle reaper. Proactive per-agent warming is deliberately not done |
| Container isolation | delivered | ✅ | Container driver (Docker/Podman/nerdctl) with enforced limits |
| Cluster scheduling | delivered | ✅ | Kubernetes driver: one Pod per sandbox, same isolation plus non-root, no service-account token, secrets via secretKeyRef, and a per-pod egress NetworkPolicy |
| Per-host egress | delivered | ✅ | An allowlist is enforced through a filtering proxy when configured, refused otherwise — never silently widened |
| Sandbox cloud identity (`runAs`) | **beyond reference** | ✅ | An agent version can run its sandbox under a scoped cloud identity: `sandbox.runAs` (a single DNS-1123 label) becomes the k8s pod's `serviceAccountName`, which AWS IRSA / GKE Workload Identity map to a cloud IAM role — so the agent reaches S3/DBs/secrets as *itself*, not the platform. The name is **workspace-confined** by construction (`confineServiceAccount` prefixes the workspace ULID), so a workspace can only ever name an account provisioned for it — never `default`, never another workspace's, the same defence as the volume store. Crucially `automountServiceAccountToken` stays **false**, so it grants a *cloud* identity while a compromised sandbox still cannot reach the Kubernetes API — strictly better than mounting the API token. In the pool key, so a warm reused sandbox never leaks its identity to a differently-scoped session. The container and local drivers have no ServiceAccount mechanism and **refuse** a non-empty `runAs` (`SANDBOX_IDENTITY_UNSUPPORTED`) rather than silently run as the wrong identity. This retires the last inert security field in the version spec (declared but wired to nothing). See `identity.ts`, `k8s-driver.ts`, `kube-http-client.ts` |

## Credentials

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Model, env var and file credentials | delivered | ✅ | Envelope-encrypted, AAD-bound, write-only for every type. `env_vars`/`api_key` are injected as environment; a `file`/`ssh_key` credential is materialised by the sandbox as an owner-only file (fetched through the audited exchange, written under `.credentials/`, path exposed as `MA_CRED_<NAME>_FILE`) — the value never sits in spawn env where `docker inspect` would show it |
| Model gateway | delivered | ✅ | Catalogue, per-workspace allowlist, usage and cost; provider injected at build. **Three-layer resilience**, composed in order. *Retry*: a retryable provider blip on the requested model is retried in place with bounded exponential backoff + full jitter before anything escalates (reuses `withRetry` from `@ma/core`). *Circuit breaker*: once a model records N retryable failures in a window it is skipped **instantly** — no retry, no provider call — for a cooldown, then a single half-open probe closes or re-opens it; per-model, in-process, fail-safe (only ever skips a model it has evidence is down, always re-probes). *Failover*: the version's declared `fallbackModelIds` are walked when a model exhausts its retries or is skipped by an open breaker, re-checking each model's enablement + workspace allowlist and attributing usage/metrics/events to the model that answered (`fallbackFrom` records the original). A non-retryable error surfaces at once and never trips the breaker; a broken fallback is skipped. All three are observable (`ma_model_retries_total`, `ma_model_breaker_state`/`_skips_total`, `ma_model_failover_total`) and tunable/disable-able per deployment (`MA_MODEL_RETRY_*`, `MA_MODEL_BREAKER_*`). The reference platform's model calls are single-shot. See `RuntimeBridge.complete` / `#completeWith`, `CircuitBreaker` in `@ma/core` |
| Expiry sweep | delivered | ✅ | Runs on the scheduler tick, per workspace |
| Daily-budget enforcement | **beyond reference** | ✅ | Two independent daily spend ceilings — `maxTokensPerDay` and `maxCostMicrosPerDay` (money, in micro-dollars) — that are real caps, not just admission gates. Both are checked **at session start *and* on every model completion**, so a long-running session cannot burn past either — a completion is refused (`429`, dimension `tokensPerDay`/`costPerDay`, retry-after the UTC-day reset) the moment either is exhausted. The cost cap matters because tokens do not bound money: with failover across a differently-priced catalogue a run can stay under its token cap while ringing up dollars. Both are backed by an exact per-`(workspace, UTC-day)` counter (`usage_daily`) incremented in the **same transaction** as each usage record (the session-usage update is an atomic read-modify-write, so concurrent recordings never lose an increment), making the totals exact and O(1) on the hot path and removing the prior per-request session scan. `maxCostMicrosPerDay: 0` = unlimited (opt-in, backward-compatible), distinct from `maxTokensPerDay: 0` = block-all. Soft by at most one in-flight completion. See `UsageRepository`, `SessionService.recordUsage`/`addUsage`, `QuotaService`, and the check in `RuntimeBridge.complete` |
| Usage history report | **beyond reference** | ✅ | `GET /v1/workspaces/:id/usage?from=&to=` returns the per-day token+cost series and a summed total — the operator spend record / cost dashboard behind the daily budgets. It reads the same exact `usage_daily` counter the budgets enforce, so the report and the enforcement can never disagree. Admin-gated (`usage.read`, like the audit trail — spend is billing data, not a viewer read); the range is bounded (≤ 366 days, reversed/malformed → 400) so it can never become an unbounded scan or a cross-tenant read; defaults to the last 30 days. Pure reporting — read-only, never touches enforcement. See `UsageRepository.usageBetween`, `QuotaService.usageHistory`, the route in `routes.ts` |
| Third-party SSO integrations | delivered | ✅ | OIDC identity federation, provider-agnostic. A deployment declares one or more IdP bindings as data (`MA_OIDC_*`) — issuer, client, claim mappings, group→role grants — so Okta, Auth0, Google, Azure AD and Keycloak work without provider-specific code. The `/auth/v1/:provider/login` → `/callback` flow runs authorization-code + PKCE with a sealed CSRF/nonce state; the ID token is verified against the IdP's JWKS with a strict asymmetric-algorithm allowlist (rejects `none` and HMAC-confusion), full `iss`/`aud`/`exp`/`iat`/`nonce` claim checks, and a get-or-create principal keyed on `oidc:<provider>:<sub>`. Group claims reconcile workspace membership *additively* (never strips a hand-granted role). Login ends by minting an ordinary session token, so the existing bearer middleware, `RoleAuthorizer`, scopes and audit apply unchanged — SSO is a second way to obtain a token, not a second authz model. Fail-closed when unconfigured; a live e2e drives the whole flow against a real signing IdP. See `oidc.ts`, `auth-routes.ts` |
| SCIM 2.0 provisioning | **beyond reference** | ✅ | Automated user lifecycle an IdP drives over `/scim/v2/Users` (create/get/list/PUT/PATCH/DELETE). Provisions *ahead of* first login into the **same** `oidc:<provider>:<externalId>` subject OIDC login matches (one shared `federatedSubject`, so they can't drift) — a user can be granted workspace roles before they ever sign in. The security payoff is offboarding: an IdP `active:false` (or DELETE) disables the principal **and revokes every live API key it holds**, so a removed employee's session dies on the next request rather than living to token expiry — the gap login-only SSO cannot close. Authenticated by a dedicated `MA_SCIM_TOKEN` (constant-time), a separate surface like runtime/ingress; never grants admin; scoped to its own provider (another provider's principals are 404, not touched). Live e2e proves convergence and immediate token death. See `scim.ts`, `scim-routes.ts` |

## Observability

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Live results | delivered | ✅ | |
| Metrics endpoint (Prometheus) | **beyond reference** | ✅ | `GET /metrics` in Prometheus text exposition, delivering the RED metrics the architecture long promised: `http_requests_total` and `http_request_errors_total` counters and an `http_request_duration_seconds` histogram, labelled by method, status and — critically — the route *template* (`/v1/agents/:id`), reconstructed from the matched params so a concrete id never becomes its own series (unbounded-cardinality is the classic metrics footgun; unmatched paths collapse to `<unmatched>`). Scrape-time gauges (`ma_sessions`, `ma_sandboxes` by status) query the store live via new `countByStatus` aggregates, so the exposition is always current rather than tied to a tick. Zero-dependency in-process registry (counters/gauges/histograms, correct cumulative buckets, label-value escaping). Its own scrape-token surface (`MA_METRICS_TOKEN`), so a scraper never touches the principal DB; disabled (404) when unset. Beyond HTTP RED, it also carries **model** observability (`ma_model_requests_total`, `ma_model_tokens_total` by kind, `ma_model_cost_micros_total`, `ma_model_duration_seconds` — labelled by model id, bounded), **connector delivery** (`ma_receipts` by status), **scheduler** throughput (`ma_scheduler_ticks_total` by kind), and session/sandbox gauges — the model-latency/token and connector-delivery collectors the architecture named as next. See `metrics.ts` in core, `metricsMiddleware` and `RuntimeBridge` in the gateway |
| Persisted run logs | planned | ✅ | The event log. Not searchable: filters are sequence, type and turn |
| Full event production and replay | planned | ✅ | Replay is exact; all 38 typed event types are produced. The two audit types (`audit.credential.accessed`, `audit.permission.decided`) are emitted by the control plane — the latter derived from the trusted tool-decision events, since a sandbox may not assert an audit claim |
| Audit trail | — | ✅ | Separate, with reasons. Retention is a global window (`MA_AUDIT_RETENTION_DAYS`, default keep-forever) swept by the scheduler on its periodic loop — audit rows outlive event logs and are pruned only when an operator sets a window |
| Tamper-evident audit log | **beyond reference** | ✅ | The audit log is a hash chain: each entry stores the previous entry's hash and its own `entryHash = sha256(prevHash ‖ canonical(entry))`, so any edit, insert, deletion or reordering of a historical row breaks the chain and `verifyChain()` reports exactly where — even against an attacker with direct database access. The chain head lives in its own row (not derived from `MAX(seq)`), and retention pruning records a checkpoint so a legitimate prune re-anchors the chain instead of reading as tampering, while a tail-truncation of recent rows is still caught. Appends serialize under `BEGIN IMMEDIATE` so the chain never forks. Exposed to platform admins at `GET /v1/audit/verify` (200 with `ok:false` + break location, so a monitor can poll it). Canonical, key-sorted hash material is round-trip stable through SQLite. This makes good on the architecture's long-standing "tamper-evident" claim. See `resources.ts` (`SqliteAuditRepository`), `canonicalJson` in `crypto.ts` |

---

## The harness gap (closed)

The single most important thing to know about this codebase, and the reason
several rows above changed from ✅ to ◐.

**There was no agent-core process.** `AgentHarness` — the main loop that calls a
model, dispatches tools, enforces the permission policy, compacts context and
spawns sub-agents — was built, thoroughly tested, and constructed only by tests.
The local driver spawned a bare `process.execPath` with no arguments, and
nothing implemented the `/runtime/v1/bootstrap` client the runtime bridge
serves. Every capability above that depends on the harness was therefore real,
tested, and unreachable.

`apps/agent-core` closes it: the process a sandbox actually runs. It reads its
identity from the environment the driver sets, fetches its pinned configuration
from the bridge, builds a harness over it, and reports every event back. The
driver now defaults to launching it.

Five defects surfaced the moment something exercised that path, none of which
any unit test could have found:

- `bootstrap` never sent `turnTimeoutSeconds`, so the harness computed
  `undefined * 1000` and aborted every turn instantly — "exceeded its
  undefineds budget".
- `MaError.toJSON()` omits `occurredAt`, which the event schema requires, so
  every failure event was rejected and took its whole batch with it. The first
  turn to fail reported nothing at all.
- `turn.*` and `context.snapshot` payloads need `turn` inside the payload, not
  just the envelope.
- The model catalogue was never populated, so every completion 404'd.
  `models.upsert` had no caller and no route; a deployment now declares its
  catalogue at build time.
- The provisioner's `submit` wrote a prompt to the event log and stopped, with
  a comment claiming "the runtime consumes these over its own transport" —
  there was no such transport. The session looked healthy and the agent never
  heard from anyone.

A sixth was found by the fix rather than the gap: usage was billed twice for
one call, once by the gateway at the completion and again from the sandbox's
`turn.completed`. A workspace would have exhausted its daily budget at half its
real spend.

So the platform divides cleanly in two:

**The control plane works.** Sessions provision and reach `ready` with a
sandbox; connectors accept signed deliveries and create receipts; schedules
fire; artifacts round-trip from a sandbox to an operator's disk; memory is
written, recalled and promoted; quota binds; leases renew and the reaper
reclaims. All of that was driven by hand against a running server, not just
unit-tested.

**The agent-execution half now runs too.** `apps/agent-core/test` drives the
real platform: a session created through the API provisions a sandbox, a
submitted prompt runs a turn, the model is called through the gateway, and
`turn.started → model.requested → message.delta → model.completed →
message.completed → turn.completed` reaches the log. Reverting the driver to
its old bare-`node` spawn fails all three tests, so they cover the gap rather
than describing it.

This was the same defect class the document celebrates finding elsewhere:
`RuntimeBridge.bind()` and `SessionService.start()` were both fully implemented
with no production caller. The harness was the largest instance, and it was
found last — by an adversarial audit of this very table, after it had spent the
whole project claiming those capabilities as delivered.

## What is genuinely missing

The BMA-parity gaps this doc long listed as deferred have since been built —
per-host egress filtering, agent templates, artifact preview, a Kubernetes
driver, workspace-scoped volume mounts, and third-party SSO, each covered below
and in the tests. What remains genuinely unbuilt is not application code at all:
it is deployment infrastructure the platform *integrates with* rather than ships.

**A managed egress proxy image, and a CNI that enforces NetworkPolicy.** Both
drivers *enforce* an `network.egress` allowlist rather than declaring it. The
container driver joins an egress-less internal network and forces traffic through
a configured proxy (`MA_EGRESS_PROXY`). The Kubernetes driver creates a
NetworkPolicy per pod — deny-all-egress (DNS excepted) for `deny` and an empty
allowlist, proxy-only egress for an allowlist — so a raw socket or a `--noproxy`
client is fenced at the network layer, not merely un-hinted; and it *refuses* to
run a restricted pod whose NetworkPolicy cannot be created rather than leaving it
on the open network. What the platform integrates with rather than ships is the
proxy itself (Squid, tinyproxy, a CNI egress gateway) and a CNI plugin that
actually enforces NetworkPolicy — both deployment infrastructure, not code. The
safe default holds either way: an unenforceable allowlist is refused, never
silently widened.

Both are deployment-specific infrastructure the platform integrates with rather
than owns. The formerly-deferred features themselves are done:

**Volume mounts** — delivered. Platform-managed, workspace-scoped named volumes:
a version declares `sandbox.mounts` (a named volume at a validated absolute
target, read-only by default) and never a host path. A `VolumeManager` confines
each to `<root>/<workspaceId>/<name>` with ULID/segment validation and
archive-extractor-grade escape refusal, so a workspace can only reach its own
data. Each mount enters the pool key (a warm reused sandbox never leaks its
filesystem to a differently-mounted session), and every driver realizes it —
bind mount (container), `hostPath` (k8s), workdir symlink + env (local).
Fail-closed when `MA_VOLUME_ROOT` is unset. See `volumes.ts` and the per-driver
mount handling; a live test proves cross-session persistence and cross-workspace
isolation.

**Per-host egress filtering** — delivered. `deny` and an empty allowlist get
`--network none` (kernel-enforced); `allow` gets bridge networking; an allowlist
naming hosts is enforced through a filtering proxy when one is configured, and
refused otherwise. See `container-driver.ts` `#networkArgs`/`#proxyEnv`.

**Artifact preview** — delivered. Rendered on a *separate* origin
(`MA_PREVIEW_ORIGIN`) under a `default-src 'none'; sandbox; frame-ancestors
<console>` CSP, gated by a short-lived signed token so the endpoint needs no
bearer yet cannot be pointed at an arbitrary artifact. Disabled entirely when no
separate origin is configured — there is no safe same-origin preview of
agent-authored content, so the safe default is off. See `preview.ts` and
`previewContentType` in `artifacts.ts` (the one function permitted to name a
renderable type, safe only because of the origin and CSP).

**Agent templates** — delivered. A parameterised blueprint catalogue with
built-ins; instantiation substitutes variables and goes through the ordinary
agent-create path, so the immutable `AgentVersion` contract is untouched — the
concern the original design review raised is resolved by construction rather than
by cutting the feature.

**A Kubernetes driver** — delivered, testable against an injected Kube client,
mirroring the container driver's isolation (limits, dropped caps, read-only root)
plus `runAsNonRoot` and no service-account token — unmounted even when a version
opts into a cloud identity via `runAs`, so a scoped cloud role never comes with
cluster-API reach. See `k8s-driver.ts`.

**Third-party SSO** — delivered as provider-agnostic OIDC identity federation.
Every IdP-specific value is data (`MA_OIDC_*` → an `IdpConfig`), so Okta, Auth0,
Google, Azure AD and Keycloak need no code. The authorization-code + PKCE flow
seals its CSRF/nonce state with the platform KEK; the ID token is verified
against the IdP's JWKS with an asymmetric-only algorithm allowlist — `none` and
HMAC-confusion forgeries are refused before any verification — and full
`iss`/`aud`/`exp`/`iat`/`nonce` checks. A verified identity get-or-creates a
principal keyed on `oidc:<provider>:<sub>` (never admin from a claim), group
claims reconcile workspace membership additively, and login mints an ordinary
session token so the existing bearer middleware and `RoleAuthorizer` apply
unchanged. Fail-closed when unconfigured; a live e2e drives the whole HTTP flow
against a real signing IdP. See `oidc.ts` and `auth-routes.ts`.

## What adversarial review found

Worth recording, because "671 tests pass" is not the same claim as "this is
correct", and the gap between them was large.

With ~525 tests green, adversarial review and hands-on use found **twenty-five**
real defects, in three rounds.

Thirteen were security: a privilege escalation across fourteen routes, an
unchecked `audit.read`, cross-workspace model disclosure, a credential leaking
through a `JSON.parse` SyntaxError, a symlink escape from the sandbox
workspace, a shell allowlist bypassed by type confusion and again by quoting,
unbounded sub-agent recursion, credential-supplied environment overriding the
control-plane URL and `PATH`, an egress allowlist that silently granted
unrestricted networking while being the schema default, three quota limits that
did not bind, and a rate limiter any caller could evade with a header it set
itself.

Twelve were correctness: a scheduler that double-fired a tick and then
suppressed the next one, a transaction that destroyed unrelated writes, a
nested transaction that deadlocked with no timeout, a TTL sweep that leaked
every sandbox it expired, a sandbox orphaned by a concurrent terminate, a
non-shareable sandbox shared and then destroyed under a live session, a reaped
receipt resurrected and delivered twice, a turn that could hang forever and
permanently wedge its session, event sequences reused after a retention prune,
a shutdown path that livelocked, an assistant message duplicated into context
and every replay, and a runtime bridge that could not authenticate at all.

Every one is fixed, and every one has a regression test that was **checked
against the unfixed code**. That check mattered more than expected: three tests
passed against the broken version on the first attempt and had to be rewritten
before they were worth keeping. Two others did not merely fail without the fix
— the test process hung and had to be killed, which is the bug reproducing
exactly as reported.

One further defect was introduced *during* this work: the fix for the quoting
bypass normalized whitespace before the metacharacter check, which turned a
newline into a space and reopened the bypass for `git status\nrm -rf /`. It was
caught by the next review pass, before it left the branch. Worth recording,
because a security fix is also a code change and gets no exemption from
review.

A third round, driving the running server and CLI by hand rather than reading
code, found seven more — and these are the ones that argue hardest for the
technique, because every one of them looked correct in the source:

- **Every quota limit was bypassable.** Session and agent admission were
  check-then-act, so `maxConcurrentSessions: 3` admitted 10 parallel creates.
  `maxSandboxes` was worse: consulted only at session admission and never where
  sandboxes are created, so it did not bind even serially. Quota is the
  per-workspace blast radius, so a tenant that can exceed every limit does not
  have one.
- **Compaction was a no-op inside a single long turn** — the one shape most
  likely to exhaust a context. It only ever helped a session that had already
  completed seven turns.
- **Rate limiting could be evaded by rotating a header the client sets.** The
  same header wrote an arbitrary source address into the audit trail.
- **An `Idempotency-Key` reused with a different body replayed the first
  response**, so a caller received a 200 describing a resource it never asked
  for.
- **A captured webhook replayed byte-for-byte started a second agent run**,
  because the fallback event id was random per delivery.
- **The SSE hand-over buffer was unbounded**, bypassing the event bus's careful
  memory bound; and its lag notice re-emitted an already-delivered sequence as
  an `id:`, rewinding a resuming browser onto an event it had already seen.
- **An empty `Last-Event-ID` skipped the first event of a session** — `Number('')`
  is 0 — losing `session.created` on exactly the connection that had seen
  nothing yet.
- **The CLI silently discarded unknown flags**, so `agent create --prompt ...
  --model ...` reported success and produced an agent with no version that could
  never start a session.

The pattern across all three rounds: the code reads correctly, the tests pass,
and the behaviour is wrong in a way only observable by running it.

A fourth round — an adversarial audit of this table against the code — found
that the table itself was the biggest offender. See "the harness gap" above.

A fifth round, after the harness gap closed, put the newly-reachable code — the
agent core, the runtime bridge, the schedulers it now drives — under the same
adversarial finder-and-verifier treatment. Eight more, every one behind the
paths that only existed once an agent could actually run:

- **One malformed schedule halted all periodic work.** A cron whose fields parse
  as shape but not as values (`60 0 * * *`) or an unknown timezone passed
  activation, then threw inside `nextFireTime` on every tick — *before* the claim
  that advances the fire time, so the same row re-threw forever, taking
  provisioning, deliveries and every other schedule down with it. The loop had
  no per-connector try/catch, and `validateCron` existed but had no caller.
- **A lost sandbox never actually re-provisioned.** Recovery moved an in-TTL
  session back to `provisioning` and cleared its sandbox — the documented edge,
  two tests asserting it — but nothing acquired a new sandbox: the provisioning
  sweep read only `queued`. "A lost sandbox re-provisions" was true up to the
  half that mattered.
- **Recall leaked memory provenance to the sandbox.** The return type was narrow,
  but the rows were returned verbatim, serialising `promotedBy`, `sourceSessionId`
  and more to untrusted code. A type that says one thing while the value carries
  another.
- **Re-publishing a purged artifact never restored it.** The dedupe key matched a
  purged tombstone, so the byte write was skipped and every later download 404'd
  as purged — a success the caller could not tell from a real one.
- **An overlapping /submit was acknowledged, then dropped.** The 202 was sent
  before the busy check, so a second turn was accepted and lost to a swallowed
  `TURN_IN_PROGRESS`.
- **A negative recall limit read the whole scope.** `LIMIT -1` is unbounded in
  SQLite, and nothing clamped the low end — `limit=-1` from a sandbox dumped
  every memory in one call.
- **Update's duplicate check compared a workspace memory against every agent's**,
  rejecting an edit as a clash with a fact in a scope it could never collide with.
- **Billed-turn markers leaked on a crashed turn**, since only a `turn.completed`
  that never arrives would have cleared them — an unbounded set over a long-lived
  process, now swept when the session is released.

Each has a regression test checked against the unfixed code, and two of them
reproduce a whole-platform outage: the malformed-schedule throw and the
strand-in-provisioning both leave real work permanently undone, not merely
mis-served.

A sixth round reviewed the fifth round's own fixes — a fix is a code change and
gets no exemption — and found four regressions the fixes had introduced, three
of them in the two changes that touched the most concurrency:

- The malformed-schedule guard's try/catch was too broad: it wrapped the store
  writes as well as the config evaluation, so a transient `SQLITE_BUSY` was
  misdiagnosed as a bad config and *permanently* disabled a valid connector.
- The sandbox-recovery fix was racy by construction — recovery to `provisioning`
  had no claim before the expensive `provision()`, so two replicas could
  double-provision one session (and destroy a shared warm sandbox under a live
  session), and a cold start slower than the 30s grace window was misread as
  abandoned and provisioned twice. The redesign recovers through the *queue*
  instead, reusing the one atomic `queued → provisioning` claim the start path
  already has, and deletes the guessing entirely.
- The overlapping-`/submit` 409 was flattened by the driver into a non-retryable
  internal error, so a busy session failed a connector receipt permanently
  instead of retrying seconds later.

The lesson generalises: a security or correctness fix changes behaviour under
exactly the conditions the original code got wrong, which is precisely where a
too-broad `catch` or a missing claim hides. Reviewing the diff of the fix, not
just the bug it closed, is what caught these.

A seventh round then reviewed the sixth round's fixes, because the same
reasoning applies recursively. The recover-through-the-queue redesign came back
clean — replacing a racy custom path with the one atomic claim that already
existed left nothing new to find. But two of the smaller fixes had a residue:

- The narrowed scheduler `catch` fixed the transient-error misclassification on
  the *store-write* path but left the *unparseable-config* disable call without
  the same `.catch()` its sibling had, so a locked database there could still
  abort the tick. The guard now covers both.
- Making the `/submit` 409 retryable fixed the dropped-message bug but exposed a
  second-order one: the durable log write happened *before* the sandbox POST, so
  a retried submit appended the user's message to the conversation history once
  per attempt. Delivering to the sandbox first and logging only on acceptance
  makes the whole submit idempotent under retry. (The 409 also became a
  `conflict`/503→409 so a busy session no longer reads as a platform outage.)

Two review rounds spent entirely on the fixes rather than the original code, and
each found real defects, is the clearest evidence for the practice: the change
that closes a bug is itself unreviewed code until someone attacks it.

An eighth round reviewed the four parity features built to close the gaps above —
and found the most instructive defect of all: the Kubernetes driver's egress
"enforcement" was advisory-only. It set `HTTP_PROXY` env but created no
NetworkPolicy and left the pod on the open cluster network, so `deny` and the
default empty allowlist silently granted full egress, and an allowlist was one
`curl --noproxy` away from reaching the cloud metadata endpoint. It read as
enforced and was not — the exact anti-pattern this codebase names and refuses.
The fix makes the driver emit a real NetworkPolicy per pod and *refuse* to run a
restricted pod whose policy cannot be created. The same round also found the
runtime token and credential values inlined as plaintext pod env (now a Secret
via `secretKeyRef`), `listPods` scanning cluster-wide so least-privilege RBAC
silently disabled orphan reap (now namespaced), and the preview-origin guard
comparing against the internal callback URL instead of the console origin (now
the console origin, the one that matters). Every finding was in newly-reachable
feature code, none in the older core — consistent with the pattern below.

A ninth round reviewed the eighth's own fix — because the fix was itself
substantial new code — and found the NetworkPolicy fix had reintroduced the very
bug it closed, one layer down: the allowlist egress rule opened ports 443/3128/
8080 with no `to` destination, which in NetworkPolicy v1 permits those ports to
*every* host. The allowlist was advisory again at the network layer, and the
docstring claimed the opposite. The fix now scopes egress to the proxy's CIDR
(`MA_EGRESS_PROXY_CIDR`, required — a policy cannot fence to a hostname) and
refuses an allowlist without it. The round also found deny-egress pods still
granted a DNS channel (a `deny` pod now gets a genuinely empty egress list), and
`destroy` deleting the egress fence before confirming the pod was gone (fail-open,
now ordered pod-first) with orphaned secrets and policies never reclaimed (reap
now sweeps them by label). That a NetworkPolicy fix could recreate a
to-any-destination hole is the sharpest case yet for reviewing the fix, not just
the bug: the second version read as more secure and was, at the crucial line, not.

The ninth round's own report carried two findings the mid-flight fixes had not
covered, caught on reading the final tally rather than the streamed results: the
preview-origin guard was inert when `MA_CONSOLE_ORIGIN` was unset (its only
strong comparison needs that origin; the fallback compared against the internal
loopback callback URL and so never fired) — now the console origin is *required*
whenever preview is enabled, so the check cannot be silently skipped. And the
proxy-reserved rule enumerated `HTTP/HTTPS/NO/ALL_PROXY` rather than matching the
proxy class, leaving `FTP_PROXY` credential-settable — now `/_PROXY$/i`. The
lesson within the lesson: read a review's final report in full, not only the
results that stream in while you are already fixing.

The pattern is consistent enough to state plainly. Tests written by whoever
wrote the code encode the same assumptions as the code, so they confirm the
intended path and are blind to everything else. The runtime bridge is the
clearest case — fully unit-tested, and completely unreachable in production,
because nothing ever called `bind()`. Adversarial review and hands-on use find
what a suite structurally cannot.

## A tenth round: the console, live use, and a parity re-audit

Hands-on use of the running console surfaced three more, each fixed with a
fail-first regression test:

- **Interrupt had no terminal-state guard.** Unlike `terminate`/`renew`, it
  published `session.interrupted` unconditionally, so a late interrupt on a
  terminated session appended an event with no backing transition — visible in
  the console as an `interrupted` event after `terminated`.
- **`turnCount` was never incremented.** It was set to 0 at creation and written
  nowhere, so the field the API, CLI and console all display was permanently
  zero. It now increments on the `running → idle` transition.
- **The console offered live controls on a finished session**, and its detail
  header was a load-time snapshot that never refreshed. A terminal session is
  now read-only, and the header updates from settling events.

The same round found and closed the largest remaining correctness bug: **sandbox
reuse misrouted a second session's turns to the first.** One agent-core process
binds one session for its life, but `claimFromPool` handed a warm sandbox to a
second session while the first still held it, so the second's turns reported
under the first. Reuse is now gated to genuinely idle sandboxes. Wiring
`turn.started/completed` through the bridge also made the `running` and `idle`
states reachable for the first time, so the reaper's ready-vs-idle "was this
sandbox productive?" signal now works.

An eleventh round re-audited *this table itself* against the code — five
independent readers, one per domain, verifying each ✅/◐/✗ against a reachable
code path rather than a tested-but-uncalled function. Of 45 capabilities, 40
were honest, five optimistic, none pessimistic. The five optimistic rows were
all the same failure mode this document keeps naming — built and tested, no
production caller — and have been downgraded above: skills/MCP install, the
knowledge base's *retrieval* half, sandbox-loss *recovery*, `file`-typed
credential *delivery*, and two never-produced audit event types. Strict
capability-weighted completion came out at roughly three-quarters; excluding the
deliberate out-of-scope items (event-subscription adapter, third-party SSO,
volume mounts, hot upgrade, a prewarm policy), around four-fifths. The audit's
own summary lives in `docs/reports/maturity-audit.html`.

The pattern held to the last round: the biggest overclaim was, again, in this
table.

## Twelfth round: building the skills/plugins/MCP feature, then attacking it

The eleventh round's headline gap — skills/plugins/MCP install unreachable in
production — was then built end to end, in nine dependency-ordered slices, each
with fail-first tests: pin capabilities at version creation; a pull-by-digest
download endpoint authorized against the pinned version; single-file skill
instruction injection; archive unpacking with path-escape and symlink refusal;
skill-declared tools; MCP stdio launch and tool proxy; MCP http/sse with egress
derivation; a git resolver; a persistent artifact store; and plugins as local
tool-servers on the MCP substrate. The retrieval, sandbox-recovery and audit-event
gaps were closed alongside.

Then the whole new surface — reachable, but exercised only by its own tests —
went under an adversarial finder-and-verifier review. It found fourteen confirmed
defects, none refuted, every one in the new code:

- **A credential leak.** The MCP/plugin launcher spread the full `process.env`
  into the subprocess, handing untrusted third-party code `MA_RUNTIME_TOKEN` —
  enough to exchange every credential the session held. The shell tool and skill
  entrypoints already withheld the token with a minimal env; the MCP path had
  re-exposed it. Now spawns with `{PATH,HOME}` plus the server's own env only.
- **A gzip bomb.** Unbounded `gunzipSync` let a ~1MB bundle expand to ~1GB and
  OOM-kill the core (uncatchable, so the per-skill try/catch did not save it).
  Now bounded, with total-size and entry-count caps.
- **A feature that never worked.** Extracted skill entrypoints were written mode
  644 and failed `EACCES` on spawn — the skill-as-tool slice was broken in
  production while its test (which chmod'd its own file) passed. The tar entry's
  executable bit is now preserved.
- MCP lifecycle: an orphaned subprocess on handshake failure, an unbounded stdout
  buffer, an unhandled stdin `EPIPE` that could crash the core, and an HTTP
  transport with no timeout and an unbounded body — all fixed.
- An auto-allow that bypassed prompt/plan approval for third-party tools (now
  strict-mode only), and a missing integrity re-check on the artifact download
  path (now re-verifies the digest before serving to the sandbox).

Two of these — the credential leak and the mode-644 break — are the sharpest
evidence yet for reviewing newly-reachable code by attacking it: one was a real
privilege escalation, the other a feature that shipped green and did nothing.

## A later round: the knowledge base that forgot on restart

A fresh unwired-capability sweep found the retrieval gap the twelfth round
believed it had closed was only half-closed. `IngestionPipeline.rebuild()` — the
method whose whole job is to repopulate the in-memory BM25 index at startup — had
**no production caller** (`platform.ts` built a fresh `KeywordIndex` and never
called it), and would not have worked if called: it read document content from an
in-memory map that a restart empties, and listed documents with `list({ datasetId:
'' })`, which compiles to `WHERE dataset_id = ''` and matches nothing. Document
content was never persisted anywhere durable — the code's own comment admitted "a
real deployment uses object storage." So an operator uploaded documents, the
server restarted, and `search_knowledge` silently returned nothing for every one
of them, permanently. The parity row above claimed ✅; it was false across any
restart — the exact "shipped green and did nothing" failure this document keeps
naming, one layer deeper than the round that first claimed the fix.

Closed by leaning on machinery the platform already trusts: document content now
persists to a workspace-scoped blob store (the same content-addressed store
artifacts and snapshots use), `rebuild()` sources every `ready` document across
all datasets via a new keyset-paged `findReady` and loads each one's bytes from
that store, and `platform.start()` calls it before accepting traffic. Fail-first
tests pin both halves of the bug (no durable content; the `datasetId: ''` query),
and a live e2e uploads a document, restarts the platform on the same database and
blob root, and asserts the document is still retrievable.

## A later round: attaching a credential you may not read

A gap-audit sweep found a privilege escalation hiding in the seam between two
services. A session's `credentialIds` are exchangeable for plaintext by the
running agent (`CredentialService.exchange`), and that method's only membership
check was `session.credentialIds.includes(id)` plus a same-workspace guard — a
list it *trusted*. But `SessionService.create()` unioned caller-supplied
`input.credentialIds` into that list with **no authorization at all**. Because
`session.create` is an *operator* action while `credential.read` is a *developer*
one, an operator — permitted to run agents, explicitly not to read secrets —
could name any workspace credential id at session creation, drive one turn, and
have the agent exchange it for plaintext. The per-credential owner model was
decorative; a lower-privileged principal read secrets it could never have listed.

Closed where the untrusted input enters: `create()` now authorizes every
caller-supplied credential id against `credential.read` (and confirms it belongs
to the workspace, else `not found`) before attaching it. Ids inherited from the
pinned agent version are exempt — a developer set those at `agent.version.create`,
and an operator must still run such an agent without holding read itself. This is
the principle that *attaching a credential costs exactly as much as reading it*,
and it is what finally makes `exchange`'s membership check sound: the list it
trusts is now authorized by construction. A fail-first test drives the operator
escalation (it succeeds before the fix, is refused after); guard tests prove the
developer ad-hoc-attach and operator-runs-a-pinned-agent paths still work, and
that a foreign-workspace or non-existent id is `not found`.

Reviewing *the fix* then found the second write path the exemption depends on.
`session.create` trusts version-pinned ids without re-checking read — but
`agent.version.create` pinned them with **no `credential.read` check of its own**.
Its safety rested on a coincidence (that action being gated at workspace-level
`developer`, who holds read workspace-wide), and that coincidence broke under API
keys: a key scoped `ma:agent:write` may author versions yet `scopeAllows` denies
it `credential.read`. So a scope-narrowed principal could pin any workspace secret
into a version, start a session that inherits it, and have the runtime exchange it
for plaintext — defeating the scope-narrowing the platform tests as "not merely
advisory". Closed the same way at the source: `createVersion` now charges
`credential.read` for each *newly pinned* id (diffed against the base version, so
inheriting an existing id in an unrelated edit never refuses). Now both writers of
an exchangeable list — ad-hoc attach and version pin — cost exactly `credential.read`.

## A later round: delegation that never ran in production

A gap sweep found sub-agent delegation — a ✅ row above — was **100% broken the
moment it ran outside its own tests**. `SubAgentRunner.#labelled` wrapped the
parent event sink to re-tag a child's events, and did so with `{ ...parent }`.
That copies only *own-enumerable* properties. In every test the sink was a
plain-object stub, so its methods copied and delegation worked. In production the
sink is agent-core's `EventReporter` — a **class instance**, whose methods live on
the prototype — so the spread copied *none* of them, the wrapper kept only the
four methods it explicitly overrode, and the child harness's very first call,
`events.turnStarted(...)`, threw `is not a function`. Delegation could not
complete a single turn; the whole feature was inert, and its test suite was green.
The exact failure this document keeps naming — built, tested, and shaped so the
test could never exercise the real path — one layer subtler than an unwired
method, because here the wiring existed and the *data shape* differed between test
and production.

Closed by forwarding instead of copying: `#labelled` now returns a `Proxy` over
the parent sink that re-tags the four id-bearing events and forwards every other
member to the parent instance (binding `this`, so prototype methods resolve), with
`Object.hasOwn` guarding the override set so inherited names like `toString` are
never shadowed. The regression test now drives a child under a **class-based**
sink, exactly as agent-core does, and asserts both that a non-overridden event
reaches the parent (proving forwarding, not dropping) and that child event ids are
still tagged. It fails against the old spread and passes against the Proxy.

## A later round: the default connector delivery that always failed

The same sweep found the connector delivery pipeline's **default** session
policy, `new_per_event`, failed 100% of deliveries in production. `#resolveSession`
created a fresh session — which `create` leaves `queued` — and returned it, and
`#deliver` then submitted the prompt immediately. But `session.submit` refuses any
status that is not `ready`/`running`/`idle` and throws `INVALID_STATE_TRANSITION`,
a *non-retryable* precondition error, so `reportFailure` marked the receipt
`failed` on the first attempt. Every webhook, schedule, and event-subscription
delivery on the default policy died before the agent ran. Only the two *reuse*
policies worked, because they return an already-live session; the safe default
that most connectors use did not. The scheduler does provision queued sessions on
its tick — but a delivery submits synchronously, in the same call, long before any
tick.

The test suite was green because the one delivery test asserted only that a
`sessionId` was recorded (written *before* the failing submit) and that
`processNext` returned `true` (it does even when the delivery throws and is routed
to `reportFailure`). It never asserted the receipt reached `succeeded` — the
silent-success shape this document keeps cataloguing.

Closed by provisioning before submitting: `#resolveSession`'s new-session branch
now brings the session to `ready` via `sessions.start` before returning, through a
`#ready` helper. Concurrency stays bounded: `create` still enforces
`maxConcurrentSessions`, so a delivery burst back-pressures on the quota rather
than exhausting the pool. The regression test drives a real `new_per_event`
webhook end to end and asserts the receipt reaches `succeeded`, the prompt was
submitted, and the session is live — it fails against the old create-and-submit
and passes against provision-then-submit.

Reviewing *that fix* found two more defects in it — the "review the fix, not just
the bug" pattern paying out again. First, the **lost provisioning race**: `start`
compare-and-sets `queued → provisioning`, and on another replica a scheduler tick
can win it for the session the delivery just created, then sit inside the slow
`provision()`. The delivery's `start` loses and, on re-read, sees the session
still `provisioning` — and the first `#ready` rethrew that as a *non-retryable*
`conflict`, permanently failing the delivery while the peer's session was left
holding a sandbox until its 24h TTL. That is the original bug again, now under a
race. `#ready` now *waits* (bounded, then retryable) for whoever won to bring the
session live, distinguishing a still-provisioning peer from a genuinely terminal
failure. Second, a **sandbox leak on submit failure**: the fix newly provisions a
sandbox before submitting, so a submit that throws now orphans that sandbox until
the reaper. `#deliver` now releases a session it *created* (never a reused one,
which is shared) when the submit fails. Both defects are single-process-invisible
— the first needs two replicas, the second a mid-delivery submit failure — so both
got their own regression tests: one wraps `start` to reproduce a lost CAS and
asserts the delivery still succeeds; the other fails the submit and asserts the
sandbox is released, not leaked. Both were verified to fail against the
intermediate fix before the second fix landed.

## Where this goes further

Not a longer list than the one above, but a different kind of difference: these
are places where the reference platform's own documentation records a gap or a
defect, and the design here avoids it rather than reproducing it.

- **Sequence-based resume.** Timestamp cursors cannot distinguish two events in
  the same millisecond; a resume either replays or skips.
- **The event log as the source of truth**, not a three-type export with
  best-effort delivery and dedupe pushed onto consumers.
- **Polymorphic connector activation.** One integration's validation rules
  cannot block another's, which is what left schedule transitions permanently
  disabled there.
- **Connector restore, schedule run-now, next-fire.** All blocked or absent
  there; all present here.
- **Typed configuration.** No JSON-encoded arrays inside a `map<string,string>`,
  so a malformed startup command is caught at publish rather than at boot.
- **Request-bound signatures.** The reference AK/SK scheme signs only the key and
  timestamps, so a captured header authorizes any request until it expires.
- **One session model.** No cloud/local fork, which there means every feature is
  built twice or declared unavailable on one side.
