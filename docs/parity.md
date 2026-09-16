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
| Persistence and recovery | delivered | ✅ | A lost sandbox re-provisions inside its TTL, and now *resumes* rather than restarting: the harness persists each context snapshot's bytes (content-addressed, digest-verified) through the runtime bridge; the reference is recorded on the session; a recovering sandbox fetches it at bootstrap and restores the conversation *and its turn counter*, emitting `session.resumed`. Restoring the turn number keeps `maxTurnsPerSession` enforced across a recovery and turn numbers monotonic in the event log. A corrupt or missing snapshot falls back to a fresh start |
| Sandbox reuse | planned | ✅ | Warm-across-sessions, delivered end to end. Opt-in per agent (`allowReuse`, default off). A finished session's sandbox is kept warm (holderless, `idleSince`), and the next session of the same pool key (workspace + spec + credential set + credential fingerprint) claims it and rebinds its agent-core process: `POST /rebind` tears down the previous session's context, workdir and subprocesses and re-bootstraps as the new session. Isolation is enforced by a full reset (a live end-to-end test asserts no context leak and correct attribution) plus stale-cache invalidation on the bridge. The pool key folds a **credential fingerprint** (a digest of each credential's `keyVersion`/`updatedAt`, never its value) so a rotated secret cold-starts with the fresh value instead of reusing a sandbox that baked in the old one. A warm sandbox is reaped past `idleTimeoutSeconds`/`maxLifetimeSeconds` — and lifetime is enforced on the held path too: a held sandbox's heartbeat is refused once past `maxLifetimeSeconds`, and the lease reaper collects an aged-out sandbox before its health probe. The idle reaper's teardown is a compare-and-set on `idle_since`, so a sandbox claimed by a live session mid-reap is left alone, never destroyed under its new holder. Rebind failure falls back to a cold sandbox |
| Terminal-state guarantee | planned | ✅ | Expiry reaper drives every session to a terminal state, including one stuck mid-shutdown |

## Runtime

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Agent harness | delivered | ✅ | Main loop, tool dispatch, interruption, bounded iterations — run by `apps/agent-core` |
| SSE resume | delivered | ✅ | Sequence-based rather than timestamp-based |
| Startup scripts | delivered | ✅ | Typed, ordered, with a per-command timeout and an optional flag |
| Multiple runtimes | planned | ✅ | The agent loop is pluggable. `runtime: builtin` (default) runs the platform's TypeScript harness; `runtime: command` runs an operator-declared process that drives its turns over the public `/runtime/v1/*` bridge protocol (bootstrap/completions/events) — an agent in any language, bounded by the same `turnTimeoutSeconds` turn deadline as the built-in harness (a hung process is SIGKILLed rather than pinning its sandbox). Proven end to end by a live test where a foreign Node process runs a full turn; documented in `docs/runtime-protocol.md` with a reference runtime in `examples/runtimes/` |
| Context compaction | planned | ✅ | Two strategies, cheapest first |
| Hot upgrade | planned | ✅ | Publishing a new production version rolls idle sessions onto it without a restart: the scheduler sweep re-pins an idle/ready session's `resolvedVersion` and rebinds its sandbox in place via `/rebind` (or, if the new version's sandbox spec changed the pool key, releases and cold re-provisions). Never mid-turn — a running session upgrades when it next goes idle. Emits `session.upgraded` |

## Sandbox

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Image and dependency install | delivered | ✅ | Via the spec and setup commands |
| Volume mounts | delivered | ✅ | Platform-managed, workspace-scoped named volumes. A version declares `sandbox.mounts` — a named volume mounted at a validated absolute target, read-only by default. The platform owns every source path (no host-path binds): a `VolumeManager` maps `(workspace, name)` to a confined `<root>/<workspaceId>/<name>` directory, ULID- and segment-validated with archive-extractor-grade escape refusal, so a workspace can only ever reach its own data. Each mount enters the pool key, so a warm reused sandbox never leaks its filesystem to a differently-mounted session. Realized per driver — `--mount type=bind` (container, `readonly` enforced), `hostPath` + `volumeMount` (k8s), a workdir symlink + `MA_VOLUME_<NAME>` env (local, read-only advisory). Fail-closed: a declared mount with no `MA_VOLUME_ROOT` is refused, not silently dropped. A live test proves cross-session persistence and cross-workspace isolation |
| Renewal, recovery, state sync | delivered | ✅ | Lease heartbeats; the reaper confirms before writing off; and a reaped sandbox's ids now flow back through the scheduler to recover the sessions that held them (`onSandboxReap` returns them), so a lost sandbox re-provisions its still-in-TTL session |
| Prewarming | planned | ⚠️ | Reactive: when a session in an `allowReuse` pool releases, the pool is topped back up to `MA_SANDBOX_PREWARM` warm sandboxes (default 0 = off). A prewarmed sandbox boots its agent-core **idle** — session-less, against a synthetic holder — and binds to its first real session via `/rebind` on claim. Unclaimed warm sandboxes are collected by the idle reaper. Proactive per-agent warming is deliberately not done. **Known limitation**: a prewarmed sandbox is provisioned with an empty environment (no real session yet) and a rebind re-materialises only *file* credentials, so an agent that relies on an `env_vars` / `api_key` / `bearer_token` credential runs without it on a prewarmed sandbox. Keep prewarming off (the default) for such agents until prewarm resolves non-file credentials on bind — tracked as a follow-up |
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

## A later round: sandbox recovery that missed a busy workspace

Sandbox-loss recovery — twice-fixed already (it never re-provisioned; then it was
racy) — had a third defect one layer down. `recoverLostSandboxes` found the
session holding a reaped sandbox by listing active sessions with `limit: 50` and
filtering client-side for the matching `sandboxId`. In a workspace with more than
50 active sessions, the holder could sit beyond that first page and was never
found: it stayed `ready`, pointing at a sandbox that no longer existed, until its
TTL — exactly the leak recovery exists to close, silently reintroduced above a
scan cap. It was also O(reaped × 50) per tick, re-listing on each sandbox id.

Closed with a direct lookup: a sandbox is held by at most one non-terminal
session, so `SessionRepository.getBySandboxId` fetches that holder by id — backed
by a partial index on `sandbox_id` (non-terminal rows only, matching the query's
own status filter, so `EXPLAIN` confirms the index is used). Recovery is now an
indexed point-lookup per reaped sandbox, correct no matter how many sessions are
active. A store unit test seeds 60 sessions and finds a holder created last (past
any page window); a scheduler test drives the full recover path with 60 active
sessions and asserts the deep holder re-queues. Both fail against the capped list.

## A later round: the cron 7 that ate the week

Day-of-week normalisation mapped `7 → 0` (both name Sunday) with a raw
`String.replace(/7/g, '0')` on the field text. That rewrites *every* 7, not just a
standalone Sunday: `0-7` — a legitimate way to write "every day" — became `0-0`,
so a daily schedule silently fired only on Sundays; and `*/7` became `*/0`, an
invalid step that threw and rejected a valid expression outright. A scheduling bug
that runs a job one-seventh as often, without erroring, is the kind that is
noticed only when someone asks why the daily report is weekly.

Fixed at the value level, not the text level: day-of-week is parsed against the
extended range `0-7`, and any resulting `7` is folded to `0` in the value set. So
`0-7` and `1-7` expand to the whole week, `6-7` is Saturday-plus-Sunday, `*/7` is
a legal step, and a bare `7` is still Sunday. A parser test pins each shape, and
an end-to-end `nextFireTime` test asserts `0 9 * * 0-7` fires on a Thursday rather
than skipping to the next Sunday — both fail against the raw replace.

## A later round: the api_key credential that never arrived

Two safe-looking pieces combined into a silent failure. The provisioner resolved
a non-`env_vars` credential (an `api_key`, `bearer_token`, …) into
`env['MA_CRED_<NAME>'] = <secret>`, merged into the *same* map as an `env_vars`
credential's member-supplied contents. The drivers then ran that whole map through
`sanitizeEnv`, whose `/^MA_/` rule exists to stop a supplied credential from
spoofing a platform variable — and which therefore also stripped the platform's
own `MA_CRED_*`. So every `api_key`/`bearer_token`/`oauth_token`/`basic_auth`
credential was dropped before it reached the agent, silently: the agent simply ran
as if it had no credential, no error anywhere. Only `env_vars` and `file`
credentials (different delivery paths) worked.

Fixed by splitting the one env map into two by *trust*, not by prefix. Supplied
`env_vars` contents stay in the untrusted `env` and are still sanitised — a
credential still cannot set any `MA_*`. Platform-generated `MA_CRED_*` secrets
travel in a separate trusted `credentialEnv` that skips the sanitiser, layered
after the supplied env and before the reserved platform vars, so it can neither be
shadowed nor override the runtime token or the egress proxy; on k8s it joins the
per-pod Secret, never inline pod env. A carve-out in `sanitizeEnv` would have been
the wrong fix — it would let a supplied `env_vars` key named `MA_CRED_…` forge a
platform-delivered secret. Splitting by trust keeps the sanitiser an absolute
`/^MA_/` block on the untrusted path. Fail-first tests across all three drivers
(container, k8s, and the local/dev driver) assert the trusted value is delivered
while a supplied `MA_CRED_*` is still stripped and the runtime token still wins;
they fail against the single-map version. (Reviewing the fix caught the local
driver, which the first pass missed — the same bug lived on a third code path.)

## A later round: the per-principal rate limit that ran before auth

The rate-limit middleware buckets by `auth?.principal.id ?? clientIp(...)`, but it
was registered *before* the auth middleware — and the router runs middleware in
registration order, outside-in — so `context.auth` was always undefined when the
limiter read it. The per-principal branch was dead code: every authenticated caller
was bucketed by IP, so all tenants behind one NAT / egress gateway / CI address
shared a single bucket, and one noisy tenant could exhaust the limit for everyone
else on that IP.

Fixed as two tiers straddling auth rather than one limiter in the wrong place: a
coarse per-IP tier stays *before* auth (an anonymous-flood shield that keeps a
flood from ever reaching the DB-backed key lookup), and a finer per-principal tier
runs *after* auth, where `context.auth` is finally set, giving each tenant its own
budget. The limiter body already preferred principal-then-IP, so the fix was mostly
composition. Reviewing it then surfaced three follow-ups, all fixed: the
per-principal tier had to *skip* unauthenticated requests (public and runtime paths
carry no principal and were being re-limited by IP at the lower per-principal
budget — which would have 429'd high-volume sandbox→control-plane traffic); the
legacy flat-limit config had to raise the IP shield to at least the flat value so a
caller who set a high limit is not silently capped at the new IP default; and the
counter map needed a hard size bound, not only expiry-based cleanup, so a flood of
distinct keys within one window cannot grow it without limit. Fail-first tests pin
each: two principals on one IP get independent budgets, a public path rides the IP
headroom, an anonymous flood is refused without a key lookup, and the legacy shape
is not capped.

## A later round: the command runtime with no turn deadline

The built-in harness bounds every turn with a wall-clock deadline
(`turnTimeoutSeconds`), and both the bash tool and the setup-command runner
SIGKILL a process that overruns. The *command runtime* — the pluggable path where
an operator-declared process (an agent in any language) drives its turns over the
bridge protocol — had none. `runTurn` spawned the process and resolved only on its
`close` or `error`, so a process that hung (an infinite loop, a stuck network
read, a wait on stdin that never comes) left the promise unresolved forever: the
session sat `running`, its sandbox occupied, until the lease reaper eventually
reclaimed it — the one runtime that runs *foreign* code was the one with no
deadline.

Fixed by giving the command runtime the same deadline the harness already
receives: `runTurn` now arms `boot.turnTimeoutSeconds` (the value bootstrap
already sends), SIGKILLs the process on overrun, and resolves the turn so the
session frees immediately — the process-kill-and-resolve shape the bash tool and
setup runner use. A fail-first test spawns a deliberately hanging process with a
1-second deadline and asserts the turn ends near it with the runtime no longer
`running`; without the fix the test never returns.

## A later round: the reaper that clobbered a finished delivery

Every receipt transition in the delivery pipeline is a compare-and-set on the
expected status — because a worker and the reaper race the same row — except one:
`reapZombies` read `working` receipts via `findExpiredLeases` and then wrote
`zombie` with a **raw, unguarded update**. A worker that settles its receipt
(`succeeded`/`failed`) in the window between that read and the write had its
terminal state overwritten with `zombie`: a state-machine violation (`succeeded`
has no outgoing transitions) and a lie — a delivery that actually ran, recorded as
abandoned. Agent turns routinely outlive the lease, so the reaper and a
finishing-late worker genuinely collide.

Fixed by making the reaper use the same guard as the rest of the pipeline:
`compareAndSetStatus(receipt.id, 'working', { status: 'zombie', … })`, and only
counting a receipt as reaped when the CAS wins. If the worker won, its outcome is
left untouched. A fail-first test flips a receipt to `succeeded` exactly in the
read-then-write window and asserts the reaper leaves it `succeeded`; it recorded
`zombie` before the fix. The existing zombie tests — a genuinely abandoned receipt
still becomes `zombie`, and a reaped receipt cannot be resurrected — stay green.

## A later round: compaction that split a parallel tool call from its results

Context compaction protects a "recent" window of messages from summarization,
computed as a fixed message-*count* offset from the end (`len - INTRA_TURN_KEEP`).
That is safe only when tool use is strictly one-call-one-result — an even,
two-message rhythm the offset never bisects. But a model that batches tool calls
emits *one* assistant message with N `toolCalls` followed by N `tool` results: an
(N+1)-message group. The count offset could land between that assistant message
and some of its results, so the assistant `tool_calls` message was summarized away
while its results survived in the recent window — orphan `tool` messages whose call
no longer exists, which most providers reject with a 400 rather than a context
error (harder to diagnose). The existing "never orphans a tool call" test used
one-call-one-result pairs, so it never exercised the split; the bug needed
parallel calls.

Fixed by snapping the boundary to a group edge: `#alignToGroup` walks the split
index back over any leading `tool` messages, so the recent window never *begins*
with a result — its owning assistant message travels with it, or the whole group is
summarized together. A fail-first test drives 20 steps of three parallel calls
each and asserts no result survives without its call; it orphaned two results per
split before the fix. An adversarial review confirmed both edges are safe (the
mirror case — `older` ending on an assistant whose results are in `recent` — cannot
occur, because that boundary is always a `tool` and is always walked back), resting
on the harness invariant that call/result groups are contiguous; that dependency is
now recorded at the fix site so a future mid-group insertion cannot silently
reintroduce the orphan.

## A later round: the resumed session that forgot how many turns it had run

Sandbox-loss recovery restores a session's *context* from a snapshot but reset its
*turn counter* to zero: the harness constructor rebuilt the `ContextWindow` from
the snapshot and left `#turn = 0`. So a session that had run five turns before
losing its sandbox came back at turn one. Three consequences: `maxTurnsPerSession`
was re-enforced from scratch, so an agent could loop indefinitely across repeated
recoveries (a budget that refills on every crash is no budget); `turn.started` and
`turn.completed` re-emitted turn numbers already in the event log, colliding with
the fold and with the gateway's `(session, turn)` billing-dedup key; and the
snapshot cadence (`turn % every`) restarted. Recovery restored *what the agent
knew* but not *how far along it was*.

Fixed by resuming the counter with the context: bootstrap already sends
`snapshotTurn`, so the harness constructor now takes it and initializes `#turn`
from it, guarded to apply only when a snapshot actually restored (a corrupt or
missing snapshot still degrades to a fresh start at turn zero). Fail-first tests
cover both halves: a session snapshotted at turn five continues at turn six rather
than re-emitting turn one, and a session resumed at its `maxTurnsPerSession` cap
stays refused instead of getting a fresh budget. Both fail against the reset.

## An epic: the safe default that couldn't boot

The isolation drivers — `container` and `k8s`, the whole reason the egress
machinery exists — could not start a sandbox under the shipped safe defaults. The
default network policy is `egress: allowlist` with no hosts, and nothing ever added
the control plane to it. On the container driver that resolved to `--network none`;
on k8s to an empty-egress NetworkPolicy (deny-all, not even DNS). But agent-core's
very first action is `GET /runtime/v1/bootstrap` — and every model call is proxied
through the control plane too — so a sandbox that cannot reach the control plane
cannot become an agent at all. Only the `local` driver worked, because it does not
enforce egress; every e2e test used it, so CI never saw the gap. The safe default
was safe and non-functional: the drivers you would reach for to actually isolate an
agent were exactly the ones that couldn't run one.

The fix reframes the control channel as *infrastructure, not egress*. `deny` and
`allowlist` govern where the *agent* may reach; the control plane is how the
sandbox exists as an agent, so it is always permitted, and the egress policy
applies to everything else — "deny-all **except the control channel**". On k8s a
restricted NetworkPolicy now always carries a control-plane-CIDR rule plus DNS
(scoped to that CIDR, never a wildcard, `to`-less rules still dropped); on the
container driver a restricted sandbox joins the egress-less internal network with
the control plane attached. Reachability that the drivers cannot provide is
*refused loudly* rather than started dead: a restricted pod with no
`MA_CONTROL_PLANE_CIDR`, a restricted sandbox with a loopback `MA_CONTROL_PLANE_URL`
(127.0.0.1 inside a container/pod is the sandbox itself), or a container allowlist
with no proxy infra all fail at provision with an actionable error. `allow` egress
is untouched (and keeps the loopback default for local dev).

An adversarial review confirmed the carve-out keeps egress fail-closed for every
non-control-plane destination — no path downgrades a restricted spec to open
networking, and every emitted rule is CIDR/namespace-scoped — and surfaced the
follow-ups now folded in: the egress rule dropped the sandbox's own inbound port,
the loopback guard was tightened to catch IPv4-mapped and trailing-dot forms, and
the two operator footguns (a too-broad control-plane CIDR; a container internal
network that is not actually `--internal`) are documented as hard warnings, since
on the container driver that network *is* the boundary. Tests updated across all
three drivers: `deny`/`allowlist` now reach exactly the control plane + DNS and
nothing else, and every reachability misconfiguration is refused; the escape-
regression suite still proves egress cannot widen to a wildcard.

## A later round: the k8s pod name Kubernetes would reject

The k8s driver named every pod, Secret and NetworkPolicy `ma-${sandboxId}` — and a
sandbox id is `sb_<ULID>`, so the name carried an underscore. Kubernetes metadata
names must be DNS-1123 labels (`[a-z0-9-]`, start/end alphanumeric); an underscore
is invalid, so the real API server would 422 `createPod`/`createSecret`/
`createNetworkPolicy`. Every sandbox on the k8s driver would fail to provision. It
was invisible because `FakeKube` accepted any string — the driver already knew the
rule for *volume* names (a DNS-1123 slug) but applied it nowhere else, and the
tests, using the fake, never saw what a cluster would reject.

Fixed by coercing the derived base name to a DNS-1123 label (`toDns1123Label`,
reusing the volume slug pattern: lowercase, non-alphanumerics to `-`, trimmed,
≤63 chars); the `-env`/`-egress` suffixes hang off that valid base. Label *values*
keep the raw id (labels permit `_`, and the pod's selector reads the same value),
so reaping and the NetworkPolicy `podSelector` stay consistent. The fix's teeth
are in the fake: `FakeKube` now rejects a non-DNS-1123 name exactly as the API
server does, so this whole class of naming bug fails a test rather than only a
real cluster. Nineteen existing tests failed against the underscore name before
the fix; all pass after.

## A later round: SSE that buffered the whole log for a slow client

The SSE bridge replays a session's event log then goes live, and every write
called `res.write()` and **discarded the return value** — the `false` that means
"the socket buffer is full, stop writing". So a client reading slowly made Node
buffer on the server's behalf without limit: the replay loop pulled the entire log
from the store as fast as it could and wrote it straight into a stalled socket, and
the live feed piled unacked frames the same way. Server memory scaled with events ×
concurrent slow clients — the exact "buffering without limit on its behalf" the
file's own header said it avoided.

Fixed by pacing writes to the client's `drain`: `res.write()` returning `false`
now awaits the socket's `drain` event before continuing, so the replay loop stops
pulling from the store and memory stays bounded to about one batch beyond the
socket buffer. A client that stops reading past a bounded timeout is disconnected
and resumes from its `Last-Event-ID` — safe because the log is the source of truth.
The live path, whose `onEvent` callback cannot await, enqueues to a bounded queue
drained by a backpressure-aware pump (overflow → one `stream.lagged`, the bus's own
contract).

Adversarial review then caught a HIGH bug the fix *introduced*: the live pump and
the pending-flush share the monotonic `lastSent` cursor, and opening the live path
before the flush finished let a live event (higher seq) advance `lastSent` past
un-flushed lower-seq pending events during a drain pause — dropping them
permanently, with no lagged signal, under exactly the slow-client case this change
targets. Fixed by gating the pump on a `handedOver` flag set only after the flush
completes: live events still enqueue during the flush, but none is emitted until
every pending event has been written. A fail-first test single-steps the socket to
park the flush mid-sequence, injects a live event, and asserts no gap — it drops
`E6` (`1,2,3,4,5,7`) against the intermediate fix and delivers `1..7` after the
gate. Review also fixed a smaller write-after-end on the handover notice and a
drain-wait that dangled until timeout when a client disconnected mid-backpressure.

## A later round: billing dedup that leaned on an optional turn number

A turn whose model calls go through `/completions` is billed there, per call; its
`turn.completed` report carries the turn's aggregate usage and must be dropped, or
the workspace pays twice. The dedup keyed on the *envelope* `turn` field — which is
optional — even though the `turn.completed` *payload* turn is schema-required. So a
sandbox that set the payload turn but omitted the redundant envelope copy missed
the dedup and double-billed; and a `/completions` call that omitted its own turn
had no key to match at all. Both bill the same usage twice, exhausting a daily
budget at half the real spend.

Fixed by reading the reliable payload turn (`payload.turn ?? event.turn`) for the
precise per-turn dedup, plus a per-session fallback for a completion that genuinely
carried no turn. The first cut made that fallback a *count* — and adversarial
review caught that it under-bills: a turn-less runtime doing a tool loop makes many
`/completions` per turn but ends once, so a count adds N and subtracts 1, leaking
N−1 stale units that silently suppress *later* billable turns (money dropped). It
became a per-session *flag* instead — set idempotently by any turn-less completion,
cleared once at the turn's end (`turn.completed` or `turn.failed`) — so it cannot
leak across turns. Fail-first tests cover each: an omitted envelope turn still
dedups; a turn-less completion dedups; a keyed multi-completion turn does not
over-suppress; and turn-less tool-loop completions do not suppress a later billable
turn (the leak — 300 vs the correct 350 against the count design). A residual is
documented, not defended: dedup trusts the sandbox's own turn numbering, so a
sandbox that misreports its turn can bill twice — a broader trust question than
this dedup.

## A later round: two ways one crafted request killed the control plane

A comprehensive gap-audit (eight adversarial finders, each finding independently
verified) surfaced an unauthenticated denial of service hiding in the router. A
path parameter or wildcard segment was decoded with `decodeURIComponent`, which
throws `URIError` on a malformed percent-escape — and `Router.match` runs during
request routing, *before* the middleware error handler is in play. The server
invokes the request as `void this.handle(req, res)`, so the throw became an
unhandled rejection and, on Node's default policy, took the whole process down.
`GET /v1/agents/%zz`, no credentials required, crash-loops the control plane —
a denial of service against every tenant from a single crafted URL.

Fixed at two levels. The router now decodes through a `safeDecode` helper that
translates `URIError` into a structured `validationError` (category `validation`
→ 400), and the server moved the `match()` call *inside* the per-request
try/catch so any structured throw routes through `#sendError` instead of
escaping — which also made `#sendError` category-aware, so a validation error
thrown outside the middleware chain (this one, or the pre-existing
`PAYLOAD_TOO_LARGE` from body reading) now reports its real status instead of a
blanket 500. As defense in depth, the process entry point logs an
`unhandledRejection` and keeps serving rather than crash-looping, and drains
cleanly on an `uncaughtException`.

Adversarial review of that fix caught it was *incomplete*: the same crash class
lived one line up. `new URL(req.url, base)` built its base from the
attacker-controlled `Host` header, and a malformed host (`Host: foo bar`,
`Host: [`) makes `new URL` throw `ERR_INVALID_URL` — outside any try, the twin of
the `%zz` bug, and with `requestTimeout = 0` the downgraded symptom was a hung
socket rather than a clean answer. The router only ever reads the URL's pathname
and query, never its authority, so the fix drops the Host from the base entirely:
a fixed `http://localhost` base removes the attacker input from URL parsing, and a
try/catch around it fails any residual malformed request target closed as a 400.
Fail-first tests drive both vectors — a raw socket sends `Host: foo bar` and
asserts a bounded 4xx with the server still alive (it hangs against the unfixed
base), and the `%zz` path is a clean 400 — the recurring lesson that one fix
rarely closes the whole class ([[fix-every-sibling-implementation]]).

## A later round: the isolation drivers that could never take a prompt — and the fix that opened a hole

The gap-audit found the container and k8s drivers were non-functional end to end:
agent-core bound its HTTP server to `127.0.0.1`, but on those drivers the control
plane dials the container's published port / the pod IP across the namespace
boundary, which a loopback bind never receives. A session came up `ready` and then
silently took no work — `/submit` and `/rebind` were unreachable. On k8s a second
bug compounded it: the readiness probe hit `/healthz`, which agent-core never
served, so `pod.ready` stayed false forever, `health()` reported the pod
`unreachable`, and every lease hiccup reaped a *live, in-progress* pod instead of
extending it.

The first fix bound a configurable host (`MA_AGENT_HOST`, loopback by default for
local, `0.0.0.0` on container/k8s) and served `/healthz`. Adversarial review then
caught that this **traded an availability bug for a security hole**: `/submit` and
`/rebind` were completely unauthenticated — the control plane sent no credential
and agent-core checked none, relying entirely on the loopback bind as the fence.
Binding `0.0.0.0` removed that fence. On the container default bridge, on the
shared restricted-egress network, and on a k8s cluster whose sandbox NetworkPolicy
named only `Egress`, any co-located workload could now `POST /submit` and run a
prompt with the victim session's tools, credentials and cloud identity — or
`/rebind` it out from under its session. Network isolation alone could not close
the container case: the egress proxy filters outbound HTTP, not lateral TCP to a
peer's agent port.

So the endpoints are now authenticated, with an ingress fence behind that as
defense in depth. The control plane presents the sandbox's runtime-token *hash* as
a bearer credential; agent-core compares it in constant time against the hash of
its own token. The hash — not the raw token — is the shared secret: it is already
persisted on the sandbox record so any control-plane replica can read it, and the
asymmetry is deliberate (the raw token authenticates the sandbox *to* the control
plane; the hash authenticates the control plane *to* the sandbox, and neither
grants the other). On k8s, a restricted pod's NetworkPolicy now also carries an
`ingress` rule permitting the agent port only from the control-plane CIDR — the
kubelet's readiness probe originates from the node, which standard CNIs exempt from
NetworkPolicy, so `/healthz` keeps working. `/healthz` itself stays unauthenticated
by design: a static liveness beacon the kubelet reaches without a credential.

Fail-first tests drive each layer: agent-core returns 401 to `/submit` and
`/rebind` without (or with a wrong) credential and authenticates with the correct
hash; the k8s policy carries an ingress rule scoped to the control-plane CIDR on
the agent port, and the rendered manifest names `Ingress` in `policyTypes`. The
lesson is the session's recurring one twice over — a fix is unreviewed code
([[review-the-fix-not-just-the-bug]]), and closing an availability gap can open a
security one, so the review has to attack the *fix's* new reachability, not just
the original bug.

## A later round: the search regex that could wedge the whole process

The `search` built-in compiled a *model-controlled* regular expression and ran it
synchronously, line by line, on the main thread. A catastrophic pattern — the
classic `(a+)+$` against a long non-matching line — backtracks for effectively
unbounded time, and a synchronous `RegExp.test` blocks the event loop while it
does. Nothing could recover: the turn-deadline timer (added an earlier round) and
the abort signal both need the event loop to fire, and a blocked loop fires
neither. One search request from the model — which is not the user — wedged the
entire agent-core process, and every later turn rejected `TURN_IN_PROGRESS`. The
fail-first test proved it starkly: against the old code the *test runner itself*
hung so hard that Node's own `--test-timeout` could not fire, and the process had
to be killed.

The cure matches the shape the codebase already uses for untrusted work — the
shell tool runs a command in a child process it can SIGKILL. The regex now runs
in a `worker_threads` worker that does the whole walk-read-match, and the tool
races it against a timeout and the interrupt signal, calling `worker.terminate()`
on either. A synchronous regex cannot be interrupted *in* its thread, so the fix
kills the *thread*: the event loop stays responsive, the turn deadline still
fires, and the ReDoS is contained to a worker that gets terminated. Fail-first
tests drive each edge — a catastrophic pattern returns a timeout instead of
hanging; a concurrent timer keeps ticking during the search (zero ticks on the
old main-thread version); the timeout is deterministic under an injected clock;
and an interrupt aborts a running search. The lesson is an old one made concrete:
input from the model is hostile, and "run it and hope it's cheap" is a denial of
service waiting for the pattern that isn't.

## A later round: the per-tick sweeps that scanned an ever-growing table

Four queries run on every scheduler or retention tick — expired sessions, queued
sessions, upgradable sessions, and sessions with expired events — against tables
that only grow (there is no hard-delete). Each full-scanned. Some had no matching
index at all; `findExpired` had one but couldn't use it — its predicate was
`status NOT IN ('terminated','failed')`, and the planner cannot prove that implies
the partial index's `ended_at IS NULL`, so it scanned the whole sessions table.
The events sweep was worst: `GROUP BY session_id` over one row per event, on the
largest table, every tick.

Adding indexes was necessary but — the surprising part — not sufficient. SQLite's
planner will not prefer an index without table statistics, and those come from
`ANALYZE`, which this deployment never runs: the store's `maintenance()` (which
would `PRAGMA optimize`) has no production caller. So even with `idx_events_ts`
present, the planner kept full-scanning the events table via its primary-key
autoindex; only a full `ANALYZE` changed its mind. Rather than take on a stats-
refresh schedule (and its staleness), the fix forces each hot query onto its index
with an explicit `INDEXED BY`. That removes the dependence on statistics entirely
and has a second virtue: a query whose index is ever dropped fails loudly instead
of silently regressing to a scan. `findExpired` keeps both `ended_at IS NULL` (to
satisfy the partial index) and the original status filter (belt-and-suspenders, so
a terminal row that never recorded an `ended_at` is still excluded).

Fail-first tests assert each query is index-driven via `EXPLAIN QUERY PLAN`, that
the *un-hinted* events query still regresses to a scan (proving the hint is load-
bearing, not decoration), and that the real repository methods resolve their hints
to indexes that actually exist — a test that fails with "no such index" the moment
a hint and a migration drift apart. The deeper lesson: an index is only half a
fix; a query plan the planner won't choose is no better than no index, and on a
system that never runs `ANALYZE`, "the planner will figure it out" is not a plan.

## A later round: the `__proto__` key that fell out of the hash

Two builders assembled an output object by assigning attacker-controlled keys —
`sorted[key] = …` in `canonicalize` (the audit-chain hash material) and
`out[key] = …` in the schema validator's `record()` and object-passthrough. When
that key is literally `__proto__` — which `JSON.parse` produces as a real own
property, unlike an object literal — the assignment hits `Object.prototype`'s
setter instead of creating an own property. For a non-object value it silently
drops the field; for an object value it replaces the target's prototype.

The audit-chain case was the sharp one. An audit entry's `details` round-trips
through `JSON.parse`, so a `__proto__` key in it is a real own key — and
`canonicalize` dropped it from the canonical JSON, which is the hash material for
the tamper-evident chain. So content nested under a `__proto__` key was **not
committed to the hash**: a DB-write attacker could add or alter it and
`verifyChain` would still pass, silently. The schema case was prototype pollution
from validated request bodies: a `record(unknown())` field (`details`, `spec`,
`config`) with an object-valued `__proto__` replaced the parsed object's
prototype.

The fixes match the value's role. `canonicalize` builds on `Object.create(null)`,
so a `__proto__` key becomes an ordinary own property that serializes into the
hash — and, importantly, the output changes *only* for values that contain a
`__proto__` key, so every already-hashed audit row without one still verifies
byte-for-byte. The schema validator routes untrusted-key assignment through a
`safeAssign` helper (`Object.defineProperty` with a plain data descriptor), which
keeps the normal prototype intact for the many downstream consumers of `metadata`
/ `env` / `spec` while preserving a legitimately-named `__proto__` key as data and
never touching a prototype. Adversarial review of the fix then found the same bug
class in two more spots — `Object.assign(env, JSON.parse(env_vars credential))` in
the composition root (the textbook pollution gadget on attacker-controlled parsed
input) and the logger's redactor building its output with `out[key] =` — so both
were folded in: the env merge became a per-key `defineProperty`, the redactor a
null-prototype build. Fail-first tests: differing `__proto__` content now changes
the hash; neither builder pollutes `Object.prototype`; the validator and env merge
keep the key as inert own data; a logged `__proto__` value is never inherited;
strict mode still rejects the key as unknown. The lesson is the specific one every
dynamic-key assignment carries — `obj[k] = v` (or `Object.assign`) where `k` comes
from parsed input is a prototype-pollution site, and "it's just building a plain
object" is exactly when it bites; one grep for the pattern turned four sites into
five.

## A later round: the dataset you could pin but never owned

Version creation validated every newly-pinned *credential* — it must exist, belong
to the workspace, and cost `credential.read` — but had no equivalent for
*datasets*. A version's `datasetIds` flow into the retrieval tool, and the keyword
index is process-wide with no workspace stamped on its chunks, so the only thing
keeping one tenant's search from returning another's documents is that a version
cannot name a foreign dataset. Nothing enforced that: a developer could pin any
`ds_` id — including one from another workspace — into a version, start a session,
and read that tenant's ingested documents through the running agent. The ownership
check *existed*, but on the vestigial `PUT /agents/:id/datasets` route, which
validated and then persisted nothing — the check sat exactly where it did no work,
and was absent on `createVersion`, the path that actually writes `datasetIds`.

The fix mirrors the credential loop precisely: for each newly-added dataset id,
load it, reject unless it belongs to the workspace (`not found`, never confirming a
foreign id exists), and charge `dataset.read`. Only newly-added ids are checked, so
inheriting a base-pinned dataset does not re-fail an unrelated edit. This closes
the boundary at the only write path — `agentVersions` is immutable (no `update`)
and `createVersion` is the sole caller of `agentVersions.create`, so a validated
version's datasets are all in-workspace, and the index's strict
`allowed.has(chunk.datasetId)` filter then can only ever match the tenant's own
chunks. Fail-first tests: a foreign-workspace dataset is `not found`; pinning costs
`dataset.read` (a scope-narrowed key is refused, the owner succeeds); a malformed
id is a 400. The lesson repeats the credential-attach round almost verbatim — a
check is only worth as much as its placement, and "it validates ownership" means
nothing if it runs on the path that doesn't persist.

## A later round: the schedule that fired every minute because it could never fire

`nextFireTime` returns `undefined` when a well-formed cron has no upcoming
occurrence — `0 0 30 2 *` for a day February never has. The fire loop's claim
advanced the next fire time to `next ?? now + 60_000`, so an `undefined` next fire
was read as "retry in 60 seconds": it fired a real run and re-armed the schedule
one minute later, every minute, forever. Its twin lived on the activation path,
where `scheduleNext` wrote the `undefined` straight through, silently disarming the
schedule while leaving the connector `active` — no run, no signal.

The first fix disabled a schedule whose next fire was `undefined`, matching the
malformed-cron path. But adversarial review caught that this was *too aggressive*:
the search only looked two years ahead, and `0 0 29 2 *` — every leap-day, a
perfectly valid recurring schedule — is usually more than two years from its next
occurrence, so it returned `undefined` and disabled itself after its first fire.
Simply widening the minute-by-minute search was too slow (a full impossible-cron
scan already cost ~2.6 seconds, and the century non-leap gap needs a nine-year
lookahead). So the search was rewritten day-first: skip a whole non-matching day
by one date check, minute-scan only a day whose date fields match. That makes a
ten-year horizon affordable (~65 ms worst case, a 40× speedup at 5× the range), so
`0 0 29 2 *` resolves — even across the 2096→2104 century gap — while a genuinely
impossible date (Feb 30) is still `undefined` and disabled.

The rewrite carried its own subtle bug, found by hammering the review's DST
question: the inner scan capped at 24 hours of minutes, but a fall-back day is a
25-hour civil day, so local 23:59 sits ~1499 minutes past midnight — a nightly
`59 23 * * *` was skipped to the next day on every fall-back. The cap is now 26
hours; the day-rollover break still stops a normal day at its true boundary, so
only the long day scans further. Fail-first tests cover each turn: `0 0 30 2 *`
fires zero runs and disables; the activation path disables it rather than silently
disarming; `0 0 29 2 *` resolves from 2026 and across the 2096 century gap and
stays active; the fall-back late fire lands on the right day. The lesson stacked
three deep — distinguish "no answer" from "answer is now"; then distinguish
"impossible" from "merely sparse"; then remember a civil day is not always 24
hours.

## A later round: the connector that reused someone else's conversation

A session recorded *what kind* of source created it (`origin`: api, connector,
schedule, …) but not *which* one. Three places needed the finer distinction and
did not have it, so all three reached across to unrelated sessions for the same
agent:

- `reuse_connector` picked the most recent live session for the agent — which
  could be a human's chat or another connector's conversation — and injected the
  connector's inbound event into it, then posted the reply out to the connector's
  own external destination. A cross-conversation and cross-destination leak.
- `skipIfRunning` counted every live session for the agent, so a human chat or
  another connector's lingering session made a schedule silently skip its run —
  potentially forever, on a busy agent.
- Reply correlation on a reused session could arm onto a concurrent producer's
  turn and post that turn's answer to this connector's chat.

The fix gives a session a `connectorId` — set when a connector or schedule creates
it, NULL for a human/API session — plus a `SessionFilter` field and a partial
index on `(connector_id, status)`. The reuse lookup and the running-run check both
scope to the connector's own sessions, so a foreign session is never reused or
counted; a connector that has no session of its own simply starts a fresh one.
That closes the reply leak too for the cross-connector and human cases (those
sessions are no longer reused at all); the residual — two concurrent deliveries of
the *same* connector racing on one reused session — is documented as needing a
per-submission turn token, a change to the sandbox protocol rather than this
schema. An attempt to close it with an "arm the reply only after submit returns"
gate was backed out: it relied on submit-return ordering relative to turn events,
which the synchronous test provisioner (and, more subtly, production event-loop
scheduling) does not guarantee — a reminder that a correlation must key on
identity, not on timing. Fail-first tests: a `reuse_connector` delivery runs on its
own session, never a human's or another connector's; a `skipIfRunning` schedule
fires despite unrelated live sessions on the same agent.

## A later round: four ways the warm pool mismanaged a sandbox's life

Sandbox reuse and prewarming had shipped, but a gap-audit of the broker's
lifecycle — the code that decides when a warm sandbox is claimed, kept, or torn
down — surfaced four independent bugs, each confirmed against the code and fixed
with a fail-first test:

- **Immortal after first reuse.** A prewarmed sandbox carries a synthetic holder
  `prewarm-<poolKey>-<index>`. On claim the repo *appended* the real session id
  instead of replacing, so the holder set became `['prewarm-…','sn_real']`. The
  synthetic id never named a live session, but it was never empty either — so on
  release the "holders remaining" branch fired, the sandbox was never marked idle,
  and it escaped both the idle and the max-lifetime reapers: immortal after its
  first reuse. The claim already runs only when no existing holder is live, so the
  fix replaces the whole set with `[sessionId]`, discarding the phantom.
- **The reaper could destroy a sandbox a live session just claimed.** The idle
  reaper read the idle list, then for each one did an *unguarded* flip to
  `draining` and destroyed it. A `claimFromPool` landing in that window (an atomic
  claim that clears `idle_since` and adds the real holder) would lose its
  environment mid-session. The drain is now a compare-and-set on the observed
  `idle_since` — `UPDATE … SET status='draining' WHERE status='ready' AND
  idle_since=?` — so a claim that raced in (which set `idle_since` NULL) leaves the
  CAS with nothing to update and the reaper skips it.
- **A held sandbox outlived its lifetime ceiling forever.** `maxLifetimeSeconds`
  is a hard bound, but it was only checked on the release path. A *held* sandbox
  heartbeats for as long as its process runs, so its lease never lapses and the
  idle reaper (holderless-only) never sees it — a long-lived held session renewed
  past the ceiling indefinitely. Now the heartbeat itself refuses renewal once
  past the ceiling (the falsey reply stops the runtime and the lease then lapses),
  and the lease reaper reaps an aged-out sandbox *before* its health probe, so a
  still-healthy but aged sandbox is collected rather than renewed. A session idle
  between turns recovers from its snapshot; one interrupted mid-turn fails — the
  ceiling is a hard bound and the turn cannot continue in that environment anyway
  (the session state machine has no `running → queued` edge, and forcing one would
  just restart a too-long turn in a fresh full window).
- **A rotated credential kept running on the stale secret.** The pool key hashed
  the credential *id set* but not the values behind it, so a rotated credential —
  same id, new sealed value — kept the same key and reused a warm sandbox that had
  baked the pre-rotation secret into its environment. The key now folds a
  credential *fingerprint*: a digest of each credential's `keyVersion`/`updatedAt`
  (never the value, which the `Credential` type deliberately hides), threaded to
  every pool-key site — acquire, the rebind-failure cold fallback, rebind, and
  prewarm — so all of them agree. A rotation changes the fingerprint and forces a
  cold start with the fresh value. `updatedAt` is the signal because
  `credentials.update` always bumps it and `markUsed` (the per-exchange touch) does
  not, so ordinary use never fragments the pool; it is not a *pure* rotation signal
  — a metadata edit or the automatic expiry-status sweep also bumps it — so the
  fingerprint can over-fragment (a one-time cold start as the pool re-coheres), but
  it only ever over-fragments and never reuses a stale secret, the safe direction.

Adversarial review of the fixes confirmed the four are sound and the
security-critical directions clean, and surfaced two pre-existing issues the audit
had not (both logged, neither introduced by this round): a prewarmed sandbox is
provisioned with an empty environment and a rebind re-materialises only *file*
credentials, so an agent relying on an `env_vars` / `api_key` / `bearer_token`
credential would run without it on a prewarmed sandbox — prewarming stays off by
default, and the limitation is now recorded on the Prewarming row above; and the
`running → queued` gap that makes a mid-turn interruption fail rather than resume,
which needs mid-turn snapshot-resumability, a design change, not a patch.

## A later round: eight smaller correctness and authorization gaps

A re-verification sweep over a batch of medium/low findings (adversarially checked
against the *current* code, since earlier rounds had moved much of it) confirmed
eight real defects and discarded five that were stale, already fixed, or mistaken —
the verification itself was the point, not just the fixing. Each survivor landed
with a fail-first test:

- **A wrong-kind id passed where a specific kind was required.** `id('agent')`
  validated only the *structural* id shape, never the kind prefix — so a `ws_…`
  workspace id was accepted in a field typed for an agent, and nothing downstream
  re-checked it. A cross-entity id flowing into a resource-typed field is an
  authorization hazard; the validator now requires the prefix to match the declared
  kind (`isId(value, kind)`), closing it for every `id()` field across the API.
- **A hot upgrade could rebind a session mid-turn.** `upgrade` validated the
  session was idle, then `await`ed the version lookup — and a `turn.started` landing
  in that window left the row re-pinned and rebound *during* a live turn. The re-pin
  became a compare-and-set on the unchanged status. Adversarial review then found
  the CAS only *narrowed* the window: the control-plane row lags agent-core's
  synchronous `running=true`, so a `/rebind` could still return 409 (busy) on a row
  the CAS saw as idle — and the old code misread that 409 as "spec changed" and
  *released the sandbox out from under the turn*. The rebind result is now
  three-valued (`ok` / `changed` / `busy`); on `busy` the upgrade rolls the re-pin
  back and leaves the turn alone for the level-triggered sweep to retry.
- **The audit search ignored its own filters.** The audit route threaded only
  `action`, silently dropping `principalId`, `resourceId`, and the time range — so
  "what did Alice do?" returned the whole workspace trail. All advertised filters
  are now threaded, and a malformed time bound is a 400 rather than a silently
  widened search.
- **Binding a dataset to an agent did nothing.** The `PUT /agents/:id/datasets`
  route validated ownership and returned 200 — having persisted nothing, so the
  bound dataset never reached the retrieval tool. It now cuts a new immutable
  version (through the authorized `createVersion`, which enforces dataset ownership),
  so a bind actually takes effect.
- **A rotated control-plane port broke k8s egress.** The NetworkPolicy hard-coded
  the control-plane egress ports to `{8080, 443}`, so a control plane fronted by a
  cluster Service on :80 (or any non-8080 port) had its callback dropped and the pod
  could never bootstrap. The port is now derived from the control-plane URL.
- **A cron typo became a wrong schedule instead of an error.** `Number('')` is 0 and
  `Number('0x1f')` is 31, so a trailing/doubled comma or a hex token was silently
  accepted — a schedule firing at times its author never wrote. Numeric cron tokens
  must now be canonical decimal digits.
- **Resource-scoped grants were inert for four of five kinds.** The grant table can
  confer a role on a specific agent, dataset, connector, credential, or template —
  but only `agent` consulted the grant, so a grant on the other four was stored and
  silently ignored (the admin believed access was conferred; it was not). Every
  grantable kind now resolves the grant: credential and template through the shared
  `requireOnResource`, connector and dataset through a new grant-aware
  `authorizeResource` at the gateway layer.
- **Datasets could never be deleted.** `datasets.delete` existed in the store but had
  no route, no admin action reached it, and there was no retention sweep, so datasets
  and their documents (and their in-memory search chunks) grew without bound. A
  `DELETE /v1/datasets/:datasetId` now deletes the row (documents cascade via the FK)
  and — the load-bearing half — evicts the dataset's chunks from the keyword index,
  which has no database FK to cascade through, so retrieval stops returning them.

The five findings the sweep *rejected* mattered as much as the eight it kept: the
agent-version schema already rejects unknown keys, the model provider is a real
injected client rather than a stub, volume paths are workspace-scoped and cannot
collide, the SSE stream is already GET-only, and the idempotency store never
persists a credential value in the clear. Fixing any of those would have been
motion without correction.

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
