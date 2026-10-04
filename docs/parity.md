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
| Chat bot | delivered | ✅ | Round trip: inbound delivery works, and the pipeline replies. It names the submission, opens a subscription to the session's event stream *before* submitting, takes as its reply only the turn whose `turn.started` (and, from current runtimes, whose end) echoes that name — never a sub-agent's messages — bounded by a timeout, and hands the outcome to the adapter's `respond`: the answer, or `TURN_FAILED` / `REPLY_TIMEOUT`, never what the turn said so far. Best-effort and out of band — a reply that fails or times out does not fail the already-succeeded delivery. The transport is the deployment's: a `hook` connector's callback ships, off until `MA_HOOK_CALLBACK_ORIGINS` lists where it may go (signed with a callback-only prefix, never sent unsigned, redirects not followed); Slack and Feishu (Lark) are built into the chat connector — their signed events in at the ingress URL, the answer out through their APIs, in the thread it was asked in, a refused reply shown on the connector — while a `generic` chat connector replies only where a deployment supplies `send` (without one, no worker waits on the turn). `MA_DELIVERY_CONCURRENCY` long-lived workers deliver, so a delivery waiting on its reply holds up only its own; one conversation still gets its events one at a time, in arrival order, and waiting for it — or for its session's running turn — costs no attempt |
| Webhook | delivered | ✅ | HMAC over `timestamp.body`, replay-bounded |
| Cron schedule | delivered | ✅ | Five-field parser, DST-correct in both directions, run-now and next-fire |
| Event subscription | delivered | ✅ | A filtered push feed. `eventbus` connectors verify an HMAC-signed CloudEvents envelope, then `normalize` drops any event whose `type` or `source` the subscription did not declare — so an agent wakes only for the events it asked for, not every delivery. Prefix wildcards (`order.*`), a prompt template (`{{type}}`/`{{source}}`/`{{data}}`), and envelope-or-wrapper parsing. The pull shape too: `sqs` and `kafka` connectors read a queue or a topic with the same filters, acknowledge a message only once its receipt exists (one delivery per event across crashes and replicas), bound how far they read ahead, and show broker errors on the connector — clients written against the wire protocols (SigV4; Kafka 2.1–4.x, SASL/SCRAM, TLS, every codec, `read_committed`, consumer groups with rebalancing), checked against ElasticMQ and two real Kafka versions |
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
| Permission management | delivered | ✅ | Roles, scopes, per-tool and per-command policy; every route names its action. A policy's `prompt` decision now asks a person instead of denying — see the next row |
| Human approval of tool calls | **beyond reference** | ✅ | A version in `prompt` mode pauses its turn on a call the policy will not run on its own. The call waits as a durable approval on the session — tool, arguments, the policy's reason, a deadline (`tools.approvalTimeoutSeconds`, default 600) — until someone with `session.approve` (operator and up) approves or denies it through the REST API (`/v1/sessions/:id/approvals`, `/v1/workspaces/:id/approvals`), the SDK, the CLI (`ma approval list/show/approve/deny`, plan → confirm → readback) or the console (a panel above the session's log, live from its event stream, and a workspace queue). Approved, the call runs; denied, the agent reads "Permission denied: <reason>" as the result. The request and the decision are `approval.requested` / `approval.decided` on the session log — written by the control plane only — and `session.approval.request` / `session.approve` / `session.approval.settle` in the audit trail. Nobody to ask means no: a session a connector or schedule started is denied at once, one nobody decides in time is `expired`, and a call whose turn ended, whose session ended or whose sandbox was lost is `cancelled` — never left approvable with nothing waiting. The sandbox polls (each poll held at most 25 s), so a wait survives a control-plane restart and a dropped connection, proven by killing the control plane while a call waits |
| Resource-scoped grants (fine-grained authz) | **beyond reference** | ✅ | Beyond workspace-wide roles, a principal can be granted a role on *one specific resource* (this agent, this dataset) via `POST /v1/workspaces/:id/grants`. The effective role is `max(workspaceRole, grant)` — a grant only ever **raises** access on the resource it names, never lowers it and never leaks to a sibling, so it is purely additive: absent a grant, authorization is exactly the prior workspace-role decision (regression-guarded). API-key scopes still bind (a grant raises the role, not the key's reach), the ownership rule is untouched, and it all stays in the one `RoleAuthorizer` — no scattered checks. Granting/revoking is gated at the same bar as changing membership and audited. Enables least-privilege delegation (give one contractor developer on one agent) the workspace-role model alone cannot express. See `authz.ts` (`resourceGrantRole`), `agents.ts` (`requireOnResource`) |
| Dependency configuration | delivered | ✅ | Typed `setupCommands`, run by the agent core before the first turn |
| Knowledge base | delivered | ✅ | BM25 retrieval, ingested and reachable *and durable across restarts*: agent-core registers a `search_knowledge` tool backed by `/runtime/v1/search`, which scopes the query to the session's pinned datasets. A running agent can recall an ingested document. Document content is persisted to a workspace-scoped blob store (the same content-addressed machinery artifacts and snapshots use), so the in-memory BM25 index is rebuilt from durable storage at startup rather than living only in the process that ingested it — previously a restart left the index empty and `search_knowledge` silently returned nothing for every prior document. See `knowledge.ts` (`IngestionPipeline` blob persistence + `rebuild`), `platform.ts` (documents blob root + startup rebuild). Retrieval is keyword only: a dataset created with an `embeddingModel` is refused, saying so — the field used to be stored and ignored, which let a client believe it had semantic search |
| SubAgent management | planned | ✅ | Scoped delegation; a child's tools are a subset of its parent's |
| Memory | planned | ✅ | Workspace and agent scope; agent-written memories cannot reach the system prompt |
| Artifact storage | planned | ✅ | Content-addressed, deduplicated, quota-charged, retention-swept. The built-in agent's files reach it through `outputs/`: whatever it leaves there is stored before its turn is reported ended, each file announced as `artifact.created` with its id, or as `artifact.failed` with the reason it could not be kept. Before this, nothing the built-in runtime wrote was ever stored — only a command runtime could publish — though the docs and a tool's result type both said otherwise |
| Artifact preview | delivered | ✅ | Rendered on a separate origin under a sandbox CSP, gated by a signed token; disabled unless a preview origin is configured |
| Agent templates | delivered | ✅ | Parameterised blueprint catalogue with built-ins; instantiation goes through the ordinary agent-create path |

## Sessions

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Resume | delivered | ✅ | Exact, via gap-free sequences |
| Renewal | delivered | ✅ | Independent session and sandbox leases; `POST /v1/sessions/:id/renew` |
| Persistence and recovery | delivered | ✅ | A lost sandbox re-provisions inside its TTL, and now *resumes* rather than restarting: the harness persists each context snapshot's bytes (content-addressed, digest-verified) through the runtime bridge; the reference is recorded on the session; a recovering sandbox fetches it at bootstrap and restores the conversation *and its turn counter*, emitting `session.resumed`. Restoring the turn number keeps `maxTurnsPerSession` enforced across a recovery and turn numbers monotonic in the event log. A corrupt or missing snapshot falls back to a fresh start. A turn cut off by the loss is closed with `turn.failed` — recognised from the log too, since a killed sandbox can take its unsent `turn.started` with it — and, for a version that opts in with `resubmitInterruptedTurn`, its prompt is sent again once the session has a sandbox: once per prompt, claimed by compare-and-set, superseded by any submission made first. Proven against a real server by killing agent-core mid-turn |
| Sandbox reuse | planned | ✅ | Warm-across-sessions, delivered end to end. Opt-in per agent (`allowReuse`, default off). A finished session's sandbox is kept warm (holderless, `idleSince`), and the next session of the same pool key (workspace + **agent** + spec + credential set + credential fingerprint) claims it and rebinds its agent-core process: `POST /rebind` tears down the previous session's context, workdir and subprocesses and re-bootstraps as the new session. Isolation is enforced by a full reset (a live end-to-end test asserts no context leak and correct attribution) plus stale-cache invalidation on the bridge. The pool key is scoped **per agent**: a warm sandbox's runtime token is reused by whichever session next claims it and is exposed to the (untrusted) agent code inside, so confining reuse to one agent's own sessions keeps a retained token within its author's trust boundary — it can never resolve to a *different* agent's session and read that agent's datasets/models/skills. It also folds a **credential fingerprint** (a digest of each credential's `keyVersion`/`updatedAt`, never its value) so a rotated secret cold-starts with the fresh value instead of reusing a sandbox that baked in the old one. A warm sandbox is reaped past `idleTimeoutSeconds`/`maxLifetimeSeconds` — and lifetime is enforced on every path the sandbox survives on: a held sandbox's heartbeat is refused once past `maxLifetimeSeconds`, the lease reaper collects an aged-out sandbox before its health probe, and the reuse-admission path (`claimFromPool`) skips a candidate past its ceiling so a fresh session is never bound to a sandbox that is about to self-terminate — all through one shared `sandboxAgedOut` predicate so the ceiling cannot drift between them. The idle reaper's teardown is a compare-and-set on `idle_since`, so a sandbox claimed by a live session mid-reap is left alone, never destroyed under its new holder. Rebind failure falls back to a cold sandbox |
| Terminal-state guarantee | planned | ✅ | Expiry reaper drives every session to a terminal state, including one stuck mid-shutdown |
| Files for the agent | **beyond reference** | ✅ | A person uploads a file to a session (`POST /v1/sessions/:id/files`, the raw body, up to `MA_ARTIFACT_MAX_MB`; the SDK's `uploadFile`, `ma session send --attach`, the console's **Attach files**) and a message attaches it by artifact id — up to 10 per submission. Before the turn starts, the sandbox has each file at `attachments/<name>`, checked against its digest, and the prompt says where it is or why it is missing. The attachment is the only grant by which a sandbox reads artifact bytes (any other id is `not found`, even one its own session produced), and attaching costs `artifact.download`: attaching costs what reading costs, as with credentials. A sandbox built later for the session gets the files back under the same names, and an interrupted turn's automatic resubmission carries them. `user.message.attachments` was accepted and dropped before this |

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
| Prewarming | planned | ✅ | Reactive: when a session in an `allowReuse` pool releases, the pool is topped back up to `MA_SANDBOX_PREWARM` warm sandboxes (default 0 = off). A prewarmed sandbox boots its agent-core **idle** — session-less, against a synthetic holder — and binds to its first real session via `/rebind` on claim. Unclaimed warm sandboxes are collected by the idle reaper. **Proactive, per agent:** an agent version that declares `sandbox.prewarm` (1–10, requires `allowReuse`) gets that many warm sandboxes for its default version before any session asks — the scheduler tops the pool up each tick, beside the maintenance pass so a slow cold start cannot stall it, and the idle reaper reclaims only what is beyond the declared depth (within it, a sandbox is replaced at `maxLifetimeSeconds`). A session that lands on one, and the pool refilling behind it, are proven against a real server with real agent-core processes. Credentials of every type are delivered on bind: file/ssh_key are materialised as files, and `env_vars`/`api_key`/`bearer_token` are materialised into the process environment on `/rebind` (through the same audited exchange and the same trust split — untrusted `env_vars` sanitised, platform `MA_CRED_*` trusted — that cold provision uses), so a prewarmed sandbox is no longer missing an agent's non-file secrets |
| Container isolation | delivered | ✅ | Container driver (Docker/Podman/nerdctl) with enforced limits |
| Cluster scheduling | delivered | ✅ | Kubernetes driver: one Pod per sandbox, same isolation plus non-root, no service-account token, secrets via secretKeyRef, and a per-pod egress NetworkPolicy — which the driver first proves the cluster enforces (a probe against real k3s clusters with and without a policy controller), refusing restricted pods where it does not. Deployable from `deploy/k8s` with the images in `deploy/` |
| Per-host egress | delivered | ✅ | An allowlist is enforced through a filtering proxy when configured, refused otherwise — never silently widened. On the local driver, `MA_LOCAL_EGRESS=enforce` holds a restricted policy too, by confining the agent's subprocesses (Seatbelt on macOS, a network namespace on Linux) or refusing the sandbox; the default there still warns and runs open |
| Sandbox cloud identity (`runAs`) | **beyond reference** | ✅ | An agent version can run its sandbox under a scoped cloud identity: `sandbox.runAs` (a single DNS-1123 label) becomes the k8s pod's `serviceAccountName`, which AWS IRSA / GKE Workload Identity map to a cloud IAM role — so the agent reaches S3/DBs/secrets as *itself*, not the platform. The name is **workspace-confined** by construction (`confineServiceAccount` prefixes the workspace ULID), so a workspace can only ever name an account provisioned for it — never `default`, never another workspace's, the same defence as the volume store. Crucially `automountServiceAccountToken` stays **false**, so it grants a *cloud* identity while a compromised sandbox still cannot reach the Kubernetes API — strictly better than mounting the API token. In the pool key, so a warm reused sandbox never leaks its identity to a differently-scoped session. The container and local drivers have no ServiceAccount mechanism and **refuse** a non-empty `runAs` (`SANDBOX_IDENTITY_UNSUPPORTED`) rather than silently run as the wrong identity. This retires the last inert security field in the version spec (declared but wired to nothing). See `identity.ts`, `k8s-driver.ts`, `kube-http-client.ts` |

## Credentials

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Model, env var and file credentials | delivered | ✅ | Envelope-encrypted, AAD-bound, write-only for every type. `env_vars`/`api_key` are injected as environment; a `file`/`ssh_key` credential is materialised by the sandbox as an owner-only file (fetched through the audited exchange, written under `.credentials/`, path exposed as `MA_CRED_<NAME>_FILE`) — the value never sits in spawn env where `docker inspect` would show it |
| Model gateway | delivered | ✅ | Catalogue, per-workspace allowlist, usage and cost; provider injected at build. **Three-layer resilience**, composed in order. *Retry*: a retryable provider blip on the requested model is retried in place with bounded exponential backoff + full jitter before anything escalates (reuses `withRetry` from `@ma/core`). *Circuit breaker*: once a model records N retryable failures in a window it is skipped **instantly** — no retry, no provider call — for a cooldown, then a single half-open probe closes or re-opens it; per-model, in-process, fail-safe (only ever skips a model it has evidence is down, always re-probes). *Failover*: the version's declared `fallbackModelIds` are walked when a model exhausts its retries or is skipped by an open breaker, re-checking each model's enablement + workspace allowlist and attributing usage/metrics/events to the model that answered (`fallbackFrom` records the original). A non-retryable error surfaces at once and never trips the breaker; a broken fallback is skipped. All three are observable (`ma_model_retries_total`, `ma_model_breaker_state`/`_skips_total`, `ma_model_failover_total`) and tunable/disable-able per deployment (`MA_MODEL_RETRY_*`, `MA_MODEL_BREAKER_*`). **Budget is a hard ceiling, not a soft gate**: each completion clamps the sandbox-requested `maxOutputTokens` to the per-model/per-version cap at the sink (an untrusted sandbox can't request an arbitrarily large output), and atomically **reserves** its worst-case estimated spend against the workspace's daily token/cost caps before the upstream call — releasing it on settle — so N concurrent completions can't all read the same under-cap snapshot and race past the cap the way a plain read-then-compare gate allowed. The reservation sizes input as UTF-8 bytes / 3 over the messages *and* the tool definitions (an over-count for Latin text, the safe side), and is released against the day it was taken. **Every call is bounded and cancellable**: a provider call races a per-call deadline (`MA_MODEL_CALL_TIMEOUT_MS`, default 120s; a timeout goes straight to failover rather than retrying in place) and the sandbox's own request, so a turn that ends or is interrupted cancels its upstream call instead of leaving it running and billable. Tools are offered only to a model whose catalogue row says it can call them, judged per attempt, and the answer names the model that actually answered. The reference platform's model calls are single-shot. See `RuntimeBridge.complete` / `#completeWith` / `#runCompletionChain` / `#callProvider`, `CircuitBreaker` in `@ma/core` |
| Native model providers | **beyond reference** | ✅ | Beside OpenRouter, the gateway calls Anthropic (Messages API), Azure OpenAI (deployments, `api-key`), AWS Bedrock (Converse, SigV4-signed with the platform's own AWS identity — the chain the SQS connectors use) and Google Vertex AI (Gemini `generateContent`, OAuth from a service account key, application-default credentials or the metadata server), with no vendor SDK. Each is configured with its models and their prices (`MA_<PROVIDER>_MODELS="[id=]model@in/out[/cacheRead/cacheWrite]"`); every model is one catalogue id, unique across providers, so the allowlist, the daily caps, retry, the circuit breaker and failover work across vendors — a version can fail over from Anthropic to Gemini, and each call is billed at the price of the model that answered, cached input apart from fresh. A model taken out of the configuration is retired at startup rather than left serving at its old price. Each provider's failures are classified for retry and failover, its tool-call shape translated both ways (results merged into the turn that must follow, tool history written out as text for a fallback without tools, schemas reduced to what Gemini reads). Proven against wire-faithful stand-ins that refuse what the services refuse — Bedrock's signature recomputed independently, Vertex's tokens only from a JWT grant whose RS256 signature is verified — through a real server and real sandboxes. See `providers/`, `provider-config.ts`, `model-provider.ts` |
| Free-model discovery and registration | **beyond reference** | ✅ | `GET /v1/models/free` lists the free models the configured provider (OpenRouter) offers right now, tools-capable first; `POST /v1/models/free` puts one into the catalogue after re-checking it against a fresh copy of the provider's list. A model counts as free only as a published `:free` variant priced at zero in *every* price field, because spend the catalogue cannot price is spend the daily cost cap cannot see (some zero-priced previews bill per item). Registration needs a platform admin whose key scopes cover `model.register`, keeps what an operator already decided about an existing row (`enabled`, `allowedWorkspaceIds`, `securityLevel`, a tighter output cap) and is audited. Free-only is the default: a startup check disables any paid row a previous run left in the catalogue, and paid models are an explicit opt-in (`MA_OPENROUTER_ALLOW_PAID`) priced from the provider's catalogue at startup — highest tier, cache tokens included — and left out with a warning when the platform cannot meter how they charge. See `model-discovery.ts`, `model-provider.ts` (`paidModelGuard`), `routes.ts` |
| Per-session model choice | **beyond reference** | ✅ | `PUT /v1/sessions/:id/model` points one session at another catalogued model without touching its agent (`null` clears it). The change lands only where the sandbox picks it up at once — a queued session, or a ready/idle one whose sandbox is rebound in place, carrying the whole conversation and its turn count across the rebind; a session mid-turn answers 409 and keeps its model, and a rebind that turns out busy is rolled back by a compare-and-set on the override, so the row and the sandbox never disagree. The model in use, the agent's default and the fallbacks are shown in the console, which offers the catalogue as a picker. Audited as `session.model`. See `SessionService.setModel`, `rollbackModelOverride` |
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
| Persisted run logs | planned | ✅ | The event log, now **searchable** end to end: a read accepts a case-insensitive content query (`q`, session-scoped) and a timestamp window (`fromTs`/`toTs`), plus `toSeq`/`order`. The query matches the payload's **values only** — string and number values, precomputed at append into a side table (`event_search`, backfilled by migration, cascaded away by retention) — so a field name never matches and quotes and newlines match as written. The **whole retained log is reachable**: one request examines up to 100,000 events in yielding steps of 1,000, and when it stops at that cap it says so (`search.truncated`) and where to resume (`search.resumeSeq`); at most two searches run per process, with a bounded queue and a `429 SEARCH_BUSY` past it. The operator **console surfaces it**: the session view has a search box that pauses the live stream, shows the newest matches read-only with how far the search got and a *Search older* control, and returns to live on clear. The CLI has `ma session events --q` |
| Full event production and replay | planned | ✅ | Replay is exact; all 43 typed event types are produced. The two audit types (`audit.credential.accessed`, `audit.permission.decided`) and the two approval types (`approval.requested`, `approval.decided`) are emitted by the control plane — the audit decision derived from the trusted tool-decision events, since a sandbox may not assert an audit claim or a person's answer |
| Audit trail | — | ✅ | Separate, with reasons. Retention is a global window (`MA_AUDIT_RETENTION_DAYS`, default keep-forever) swept by the scheduler on its periodic loop — audit rows outlive event logs and are pruned only when an operator sets a window |
| Tamper-evident audit log | **beyond reference** | ✅ | The audit log is a hash chain: each entry stores the previous entry's hash and its own `entryHash = sha256(prevHash ‖ canonical(entry))`, so any edit, insert, deletion or reordering of a historical row breaks the chain and `verifyChain()` reports exactly where — even against an attacker with direct database access. The chain head lives in its own row (not derived from `MAX(seq)`), and retention pruning records a checkpoint so a legitimate prune re-anchors the chain instead of reading as tampering, while a tail-truncation of recent rows is still caught. Appends serialize under `BEGIN IMMEDIATE` so the chain never forks. Exposed to platform admins at `GET /v1/audit/verify` (200 with `ok:false` + break location, so a monitor can poll it). Canonical, key-sorted hash material is round-trip stable through SQLite. This makes good on the architecture's long-standing "tamper-evident" claim. See `resources.ts` (`SqliteAuditRepository`), `canonicalJson` in `crypto.ts` |

---

## The harness gap (closed)

The single most important thing to know about this codebase. While the gap was
open, several rows above were downgraded from ✅ to ◐; they returned to ✅ only
once the capability was reachable from a real sandbox, not just from tests.

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

**A CNI that enforces NetworkPolicy.** Both drivers *enforce* an `network.egress`
allowlist rather than declaring it. The container driver joins an egress-less
internal network and forces traffic through the egress proxy; the Kubernetes
driver creates a NetworkPolicy per pod — deny-all-egress (DNS excepted) for `deny`
and an empty allowlist, proxy-only egress for an allowlist — so a raw socket or a
`--noproxy` client is fenced at the network layer, not merely un-hinted, and it
refuses a restricted pod whose NetworkPolicy cannot be created. The proxy now
ships (`deploy/egress-proxy`, enforcing each sandbox's own allowlist from a signed
grant), and so do deployment manifests. The network plugin is still the
cluster's own — but the driver no longer takes it on trust: it proves policies are
enforced before the first restricted pod, and refuses restricted pods on a cluster
that accepts policies and ignores them.

The formerly-deferred features themselves are done:

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
production caller — and were downgraded at the time: skills/MCP install, the
knowledge base's *retrieval* half, sandbox-loss *recovery*, `file`-typed
credential *delivery*, and two never-produced audit event types. All five have
since been delivered end to end and are ✅ again. Strict
capability-weighted completion came out at roughly three-quarters; excluding the
deliberate out-of-scope items (event-subscription adapter, third-party SSO,
volume mounts, hot upgrade, a prewarm policy), around four-fifths. The audit's
own summary, a dated snapshot of that moment, lives in
`docs/reports/maturity-audit.html`.

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

## A later round: the billing dedup that a restart erased

The dedup above was correct within one process — and only within one process. Its
markers (`#billedTurns`, `#completionsBilled`) lived in Sets on the gateway's
`RuntimeBridge`, while the usage they guarded was billed *durably* (the session row
and the workspace daily counter both persist). The asymmetry is the bug: a
`/completions` call bills durably and records its dedup marker only in memory, so a
control-plane restart between that billing and the matching `turn.completed` starts
the fresh process with empty Sets. The sandbox — whose token binding is recovered
from the store on restart — then reports the turn it already paid for, finds no
marker, and bills the same usage a second time, double-incrementing the daily quota
counter that gates the workspace budget along with it. A rolling deploy mid-turn is
enough to trigger it; a fail-first test reproduces it as a fresh `RuntimeBridge`
over the same store (140 tokens billed where 100 is correct).

Fixed by making the markers durable — a `billed_turns` table — and, crucially,
writing the marker *in the same transaction as the usage fold*. Durability alone
would not be enough: a marker written in a second transaction could still be lost to
a restart between the two, reintroducing the same split. So the fold and the mark
commit or roll back together (`recordProxyUsage`), and the report path's
check-and-fold is likewise one transaction — `consume` is an atomic
delete-returning-whether-it-existed, so two concurrent reports of one turn cannot
both bill and a rolled-back fold cannot lose a consumed marker
(`recordReportedUsage`). The turn-less flag survives as the sentinel turn `-1` (real
turns are `>= 0`, so it cannot collide). All of the prior round's semantics are
preserved and re-tested against the durable store: omitted-envelope-turn dedups,
turn-less dedups, a keyed multi-completion turn does not over-suppress, and a
turn-less tool loop does not leak a suppressor into a later turn.

The key is `(session_id, sandbox_id, turn)`, not the session alone — and that came
out of the adversarial review, which caught the first cut keying on
`(session_id, turn)` and clearing markers on every re-queue path to compensate. A
session outlives its sandbox: a lost-sandbox recovery or a spec-changing upgrade
re-queues it with the *same id* onto a *fresh sandbox whose turn counter resets to
1*. A `(session, turn)` marker from the old generation then dedups the new
generation's turn 1 and silently *under-bills* it. Chasing that with a
`clearSession` on each re-queue path was the wrong shape — it missed the upgrade path
(a fix-every-sibling miss the review found), and a straggler `/completions` from the
dying sandbox could re-create the marker *after* the clear, which no amount of
clearing closes. Keying by `sandbox_id` fixes it at the root: `sandbox_id` changes
at each such generation boundary and is stable across a mere restart/rebind, so a
stale generation's marker can no longer match a live generation's fetch on the async
re-queue paths — a fail-first test drives the recovery sequence and confirms the new
generation's turn is billed *despite* the old marker still existing. A *second*
review round then found the one boundary where the id does **not** change: a
spec-preserving hot upgrade. The pool key excludes `runtime` config, so a version
that only swaps the runtime rebinds the *same* sandbox in place (`rebind → 'ok'`)
while the rebuilt harness still resets its turn counter — aliasing two generations
under one `(session, sandbox)`. That path clears the session's markers explicitly,
which is race-free precisely because the rebind runs on an *idle* session and the
old runtime is torn down synchronously before it returns (none of the straggler
hazard that made clearing the async paths futile). Fail-first tested.

With correctness decoupled from cleanup on the async paths, the leftover markers are
pure hygiene: inert (they can never match a live generation) but unbounded if left. A
retention sweep on the maintenance tick (`billedTurns.prune`, a fixed window well
past any turn deadline) reclaims them, covering the terminal paths that bypass
`shutdown` (the unrecoverable sandbox-loss branch) and long-lived sessions alike;
the session-row `ON DELETE CASCADE` remains the backstop.

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
  between turns recovers from its snapshot; a session interrupted mid-turn was, at
  the time of this round, failed rather than recovered (the session state machine
  had no `running → queued` edge) — a gap closed in a later round below.
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
had not (both logged, neither introduced by this round): a prewarmed sandbox was
provisioned with an empty environment and a rebind re-materialised only *file*
credentials, so an agent relying on an `env_vars` / `api_key` / `bearer_token`
credential would run without it on a prewarmed sandbox; and the `running → queued`
gap that made a mid-turn interruption fail rather than resume. Both are closed in
later rounds below.

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

## A later round: two ways a background loop dropped work under a race or a bad row

A third comprehensive gap-audit, aimed at subsystems the earlier rounds had not
deeply swept (agent-core internals, the delivery pipeline and scheduler, store
transactions, knowledge/ingestion, identity, client surfaces) and adversarially
verified, surfaced two HIGH defects in the "keep the platform running in the
background" machinery — both where a single event silently starved a lot of work:

- **A submit could run against a session being torn down.** agent-core reuses one
  process across sessions: `/rebind` tears the previous session's runtime all the
  way down (deletes the workDir, kills MCP/plugin subprocesses, closes the event
  reporter) and builds the next. But it kept its `current` pointer aimed at the old
  session across both `await`s of that teardown, and `close()` does not flip the
  session's `running` flag — so a concurrent `/submit` in the window passed the
  not-running guard and ran a turn against the destroyed session: its events dropped
  by the closed reporter, its model call billed under the runtime token that now
  resolved to the *new* session, its tool calls hitting a deleted workDir. The fix
  makes the process's session state an explicit `SessionSlot` with a `rebinding`
  phase: `beginRebind()` clears the slot and closes it to submits for the whole
  teardown+rebuild, so a submit in the window is refused (409) until the new runtime
  is live. The state the bug lived in — an implicit "between sessions" — is now named
  and unit-tested.
- **One bad row could stop every background sweep.** The scheduler's `tick()` ran its
  sweeps — provision queued sessions, apply upgrades, fire schedules, drain
  deliveries, reap zombies, expire sessions, prune events/audit/idempotency, sweep
  credentials — as a bare sequence of awaits under a single `finally`. A throw from
  any one escaped the whole tick, so every sweep ordered after it was skipped. The
  sharpest trigger: a single corrupt `schedule` connector row (malformed config JSON,
  a non-numeric timestamp) made `findDueSchedules` throw while *decoding* the row —
  before the code that would advance or disable it — so the row was re-selected and
  re-thrown every tick, starving delivery draining, zombie reaping, session expiry,
  retention pruning and the credential sweep platform-wide, forever. Each sweep now
  runs in its own try/catch (log and continue, contributing zero that pass), and
  `findDueSchedules` skips a row it cannot decode rather than aborting the scan.

## A later round: four lifecycle and accounting gaps behind the session

Continuing the third audit's findings, four medium defects in the agent lifecycle
and session accounting — each an "the record and the reality disagree" bug — fixed
with fail-first tests:

- **A failed session build leaked its subprocesses and workdir.** `buildSession`
  creates a temp workdir and spawns MCP/plugin subprocesses, then runs setup
  commands. A required setup command that exits non-zero throws, and with no
  try/finally the teardown (which lived only in the returned runtime's `close()`,
  never reached) never ran — so every failed rebind leaked a temp tree and orphaned
  subprocesses. The build now tears both down on any post-workdir failure.
- **A killed command-runtime turn left the control-plane turn open.** A command
  runtime posts its own `turn.*` events over the bridge. When its process is
  SIGKILLed at the turn deadline (or exits non-zero), it can no longer post a
  terminal event — so the control plane saw `turn.started` with no matching
  `turn.failed`, and the session sat `running`, holding its sandbox, until the lease
  reaper. The parent now posts a `turn.failed` itself on abnormal termination (and
  stays silent on a clean exit, where the child already reported).
- **A status change and its transition event could commit separately.** `transition`
  ran the status compare-and-set in one transaction and published its event
  (`sandbox.lost`, `session.upgraded`, …) in another. A store error on the event
  append after the CAS committed left the row in its new status with no transition
  event — the fold that reproduces the row would disagree with it. The two now
  commit in one transaction (append via a synchronous repository core), with the
  subscriber fan-out as a post-commit side effect.
- **Usage could be folded past a session's final snapshot.** `recordUsage` checked
  the session was non-terminal *outside* the transaction, then folded usage inside a
  separate one. A concurrent `terminate` in the gap let a straggler turn's usage
  push the session counters and the workspace daily counter (what the budget reads)
  past the emitted `session.terminated` snapshot. The terminal check is now re-done
  inside the transaction, on the same connection, closing the TOCTOU.

## A later round: three connector delivery and scheduling gaps

Continuing the third audit, three medium defects in the connector subsystem, each
fail-first tested:

- **The credential-expiry sweep only ever swept the first page of workspaces.**
  `sweepCredentials` listed workspaces with a fixed `limit` and no cursor, and
  `workspaces.list` orders by id — so every tick swept the same lowest-id page, and
  a workspace whose id sorted after it never had `sweepExpiry` called: its
  credentials were never marked `expiring`/`expired`, and an expired secret stayed
  active. The sweep now carries a rotating cursor across ticks, wrapping at the end,
  so every workspace is visited in turn.
- **A schedule fire could be silently lost, not retried.** `fireDueSchedules` claims
  a tick by advancing `next_fire_at` from the due time to the next occurrence
  *before* the receipt is enqueued (whoever advances it owns the tick — replica
  safety). But if the enqueue then threw (a `SQLITE_BUSY` in `createIfAbsent` under
  write contention), the row already pointed past the due time, so
  `findDueSchedules` would not re-select it until the *next* occurrence — the fire
  was lost, while the catch logged a misleading "will retry". The claim is now rolled
  back (a compare-and-set from the advanced time back to the due time) when the
  enqueue fails, so the next tick genuinely re-fires that occurrence.
- **Two adapters fell back to a random dedup id.** The webhook and eventbus adapters
  were already hardened to derive a delivery's dedup id from its request signature
  when the source omits its own id, so a replayed or untagged signed delivery lands
  on one receipt rather than starting a second agent run. The chat and hook adapters
  had not been: they fell straight through to a fresh random id, so an untagged
  signed retry double-delivered. Both now use the same signature-derived fallback
  before the random last resort.

Two further pipeline findings from the same audit — a reply wait that runs inside the
scheduler tick (stalling the safety sweeps for a whole agent turn), and a receipt
lease that can be shorter than a cold sandbox provision (letting a reaper zombie a
live delivery) — are deferred as a pair: both change the delivery execution model and
warrant a dedicated design rather than a patch. They are tracked, not forgotten.

## A later round: seven store, knowledge and identity gaps

Continuing the third audit, seven medium defects across the storage layer, the
knowledge base and the identity providers, each fail-first tested:

- **A failed COMMIT wedged the connection.** `Database.transaction` decremented its
  depth counter *before* issuing COMMIT/RELEASE, so a throwing COMMIT (SQLITE_FULL,
  an I/O error, a busy-timeout — and SQLite keeps the transaction open on a failed
  COMMIT) fell into the catch, which decremented again: the counter ended two below
  entry while the connection still held an open transaction. The next transaction
  then issued `BEGIN` on top of it. The depth is now dropped only after the commit
  succeeds and restored to its entry value in the catch.
- **Audit-chain verification falsely reported tampering on legacy rows.** Migration
  10 gave pre-chain rows a seq but empty, uncomputable hashes and anchored the head
  past them. `verifyChain` recomputed a content hash for *every* row and compared it
  to the stored one — so a legacy row's empty hash read as a modification on any
  install that upgraded across migration 10. Legacy rows (empty hash and prev-hash)
  are now exempt from the content recompute, as they already were from the linkage
  check.
- **A crashed ingest orphaned its blob, and left the document stuck.** `process()`
  wrote a document's bytes to the blob store but recorded the digest on the row only
  in its success update — so a crash after the blob write left durable bytes with no
  digest pointing at them, permanently unrecoverable. And it flipped the row to
  `processing` before a long chunk/embed, with no recovery path — a killed worker
  left it stuck `processing` forever, never re-selected. Now the digest is persisted
  right after the blob write, and a stale-`processing` sweep requeues a document a
  dead worker abandoned.
- **Search scoring leaked across tenants.** The keyword index is process-wide;
  `search` correctly filtered *returned* chunks to the caller's datasets, but scored
  them with BM25 statistics (N, document frequency, average length) computed over the
  *whole* index — so one tenant's corpus skewed another's ranking. The stats are now
  computed over the queried-dataset subset, scoping the scoring to the same datasets
  as the results.
- **A SCIM delete could undo an admin's disable.** `deleteUser` stamped the
  "SCIM deactivated this" marker unconditionally, even on a principal an admin had
  deliberately disabled outside SCIM — so a later SCIM re-provision read the marker
  and cleared the admin's decision. The marker is now stamped only when the delete is
  what disabled the principal (mirroring the create/patch guard); keys are still
  revoked unconditionally for idempotency.
- **Concurrent SSO logins lost memberships.** `#reconcileMembership` rewrote a
  workspace's whole member array from a value read outside any transaction, so two
  logins to the same workspace each read the pre-image and the second write clobbered
  the first. The read-modify-write now runs inside a transaction that re-reads on the
  same connection.

## A later round: four lower-severity correctness gaps

Closing out the third audit's confirmed findings, four low-severity defects, each
fail-first tested:

- **A non-numeric Retry-After caused a zero-delay retry storm.** The SDK read
  `retryAfterSeconds` as `Number(header)`. Retry-After may be an HTTP-date, and
  `Number(date)` is NaN — which is not `undefined`, so it slipped past the retry
  loop's guard and turned the delay into `sleep(NaN)`, an immediate retry that
  hammers the server. A non-finite hint is now dropped so the client falls back to
  its computed backoff.
- **The event-retention sweep could starve behind not-yet-expired sessions.** The
  candidate query returned any session with an event older than the shortest
  possible window, oldest-first, then skipped the ones not actually expired under
  their own (longer) workspace retention — but those perennial no-op candidates
  refilled the front of the fixed batch every tick, so a genuinely expirable session
  behind them was never reached. The sweep now carries a rotating cursor on the
  oldest-event timestamp, paging past the no-ops across ticks.
- **A dataset's size was under-counted by one document.** The create route seeded
  `document.sizeBytes` with the content length, but the dataset's rolled-up
  `sizeBytes` is maintained by ingestion as a delta (`dataset - current + new`) — so
  the first ingest computed `- N + N = 0` and the dataset total never accrued that
  document. The document now starts at `sizeBytes: 0` (like `chunkCount`), letting
  ingestion establish the real value.
- **A SCIM full-list could lose its own users behind another provider's.** The
  no-filter `listUsers` fetched a single page-capped batch and filtered by provider
  *after* — so on a multi-provider deployment, another provider's principals could
  fill that page and this provider's users fell off it, invisible to a full sync,
  and `startIndex` was ignored. It now filters by provider while paging (bounded)
  and honours `startIndex`/`count`.

## A later round: the delivery that outran its own lease

One architectural defect deferred from the third audit, now closed. It is worth its
own round because the fix is a small mechanism guarding a subtle exactly-once hole.

- **A live delivery could be zombied and then double-run.** A connector delivery
  claims its receipt under a lease (`claimNext` stamps `lease_expires_at = now +
  120s`) and holds it `working` across a *cold* sandbox provision — a container or
  k8s cold start can exceed that window — plus the submit. Nothing renewed the lease
  while the delivery ran, so the reaper's `findExpiredLeases` would see a
  *still-running* delivery as expired and `compareAndSetStatus('working' →
  'zombie')` it. The delivery then finished and its own success write
  (`compareAndSetStatus('working' → 'succeeded')`) matched zero rows — logged as
  "reaped", the work silently uncredited — and because `zombie` is a terminal state
  an operator's `retry` of it minted a fresh receipt and **ran the same external
  event a second time**, breaking the exactly-once guarantee the receipt exists to
  provide. The fix mirrors the sandbox lease: a new `receipts.renewLease` (a
  compare-and-set on `status = 'working'`, so it can never resurrect a terminal
  receipt) is heartbeated from a background loop for as long as the delivery is
  genuinely in flight, and torn down the moment it settles — so the reaper never
  collects a live delivery, while a truly dead worker still lapses on schedule.
  Two failure modes are guarded so the cure is not worse than the disease: a
  transient store error during a heartbeat (a `SQLITE_BUSY`) is caught and retried
  on the next beat rather than unwinding the loop (an unwind would both surface as
  an unhandled rejection and permanently stop renewing — reintroducing the very
  double-run), and a hard delivery ceiling (default ten leases, clamped to at least
  one) stops renewal for a genuinely wedged delivery so it lapses to a visible,
  retryable `zombie` rather than renewing forever and pinning a worker invisibly.

## A later round: the delivery drain that starved every other sweep

The companion to the lease fix above, and the reason it had to land first.

- **A blocking delivery froze all periodic maintenance.** The scheduler ran a
  single loop: each tick provisioned queued sessions, fired schedules, *drained
  deliveries*, reaped zombies, expired sessions, and ran the retention prunes — in
  sequence. But a connector delivery does not return quickly: for a connector that
  replies (a chat, a webhook callback), `#deliver` waits for the agent's turn to
  finish and produce an answer before it returns, up to the reply timeout. Draining
  such a delivery inside the tick meant the tick itself blocked for a whole agent
  turn, and every sweep ordered after it — zombie reaping, session expiry, event and
  audit and idempotency pruning, the credential sweep, the sandbox reaper — did not
  run until the turn finished. One slow conversational delivery stalled
  platform-wide maintenance. Delivery draining now runs on its own loop, so the
  maintenance sweeps keep their cadence regardless of how long a delivery takes.
  Deliveries stay *serial* on that loop: the reply-correlation logic assumes at most
  one delivery waits on a given (possibly reused) session at a time, so draining one
  at a time preserves that invariant — true parallelism would first need a
  per-submission turn token. This is why the lease-renewal fix landed first: moving
  the drain off the tick makes zombie reaping run *concurrently* with an in-flight
  delivery (before, the reaper ran strictly after the drain returned within one
  tick), and the lease heartbeat is exactly what makes that concurrency safe.

## A later round: the conversation that died with its sandbox

Closing a gap two earlier rounds had named but deferred: a session lost *mid-turn*
used to fail outright.

- **A mid-turn sandbox loss failed the whole conversation.** A sandbox that died
  while a turn was in flight (a crash, a node eviction, the `maxLifetimeSeconds`
  heartbeat refusal) left the session row `running`. Recovery re-queues a lost
  session from its last snapshot — but only from `ready`/`idle`: the state machine
  had no `running → queued` edge, so `handleSandboxLost` fell through to the
  unrecoverable branch and failed the session, even with lease time remaining. One
  crash mid-turn ended the entire conversation. The edge was omitted deliberately,
  because context snapshots persist only at *turn boundaries* — so the last snapshot
  predates the in-flight turn's prompt, and naively re-queuing would silently drop
  that prompt (the session would look healthy while the user's last message
  vanished). The fix keeps the availability without the silent drop: add the
  `running → queued` edge, recover from the last turn-boundary snapshot, and close
  the interrupted turn with a synthetic `turn.failed` (numbered from the
  control-plane completed-turn count, appended atomically with `sandbox.lost` in the
  same transaction as the recovery CAS) so the log honestly records that the turn
  failed. The in-flight prompt is **not** auto-resubmitted — replaying it would
  re-run any at-least-once tool side effect the turn had already performed (an email
  sent, an API called) — so the caller resubmits. The turn.failed carries no usage
  and is appended by the control plane directly, so it never touches billing dedup;
  and for a `ready`/`idle` origin (no in-flight turn) nothing is fabricated.

## A later round: the prewarmed sandbox that ran without its secrets

The second of the two pre-existing issues an earlier round's review surfaced, now
closed.

- **A rebound/prewarmed sandbox was missing an agent's non-file credentials.** The
  drivers bake `env_vars` and `api_key`/`bearer_token` credentials into the process
  environment at `provision()` time. But a prewarmed sandbox is provisioned with no
  session and an empty environment, and it is claimed via `/rebind` — an HTTP POST
  to the already-running agent-core process, which never re-runs `provision()`.
  `buildSession` on rebind re-materialised only *file* credentials, and the
  bootstrap shipped only file-credential references, so an agent that depended on a
  non-file credential ran without its secret on any prewarmed (or otherwise rebound)
  sandbox. Distinct from the earlier fix that delivered `MA_CRED_*` past
  `sanitizeEnv` — that covered the initial cold provision, not the rebind path. Now
  the bootstrap carries *every* granted credential by reference (id, name, and type
  for the non-file ones), and agent-core materialises them on bind through the same
  audited exchange as file credentials, applying the same trust split cold provision
  uses: `env_vars` contents are untrusted (parsed defensively so a malformed value's
  plaintext never escapes, merged `__proto__`-safely, then run through `sanitizeEnv`
  so a credential cannot set a reserved `MA_*`/loader/proxy key), while the
  platform-generated `MA_CRED_*` keys are trusted and delivered unsanitised. A
  credential that fails to fetch or parse is logged and skipped, never fatal. The
  trust helpers that were duplicated across the drivers and the provisioner moved to
  `@ma/core` so this third materialiser shares one implementation rather than a
  third copy. Scope: like the file credentials already delivered on rebind, these
  reach the built-in tools' (bash) child environment — matching the existing rebind
  contract, and at the time narrower than cold provision, which bakes env
  process-wide at the driver (so setup commands and non-ref MCP servers see it). A
  later round extended this to the setup commands too (a rebound setup command now
  sees the same `env_vars`/`MA_CRED_*` a cold one does); the MCP-server spawn stays
  deliberately scoped, withholding the broad env so an untrusted server never
  receives the runtime token. The fix here closed the actual gap — an agent's
  non-file secrets were entirely absent on a prewarmed sandbox.

## A later round: a fourth audit, and re-reviewing the fixes

A fourth comprehensive gap-audit — six finder dimensions (including a re-review of
the just-landed fixes), each adversarially verified — surfaced a batch of subtle
defects the earlier rounds had not. Each lands fail-first-tested and
adversarially-reviewed.

- **The lease reaper could destroy a live, heartbeating sandbox.** `reapExpiredLeases`
  reads an expired sandbox, then `await`s a driver health probe (a real event-loop
  yield — a network round-trip that a slow or 500-ing k8s API resolves as a false
  "unreachable"). A heartbeat landing *during* that probe calls `renewLease`, which
  advanced `lease_expires_at` and left the runtime executing its turn — but the reaper
  then marked the sandbox lost with a *raw update by id* and deleted the pod, pulling
  the environment out from under a live turn (which `handleSandboxLost` then re-queues,
  discarding the turn's work). The mark-lost is now a compare-and-set on the observed
  `lease_expires_at` (`markLostIfLeaseUnchanged`), exactly mirroring the `drainIfIdle`
  guard the idle reaper already had: if a heartbeat renewed the lease in the window the
  CAS matches nothing, the reaper skips the destroy, and the live sandbox is left alone.
  The asymmetry — the idle path guarded, the lease path not — was the whole bug.
- **An admin could rewrite the member list to make itself owner.** `updateMembers` is
  gated by `workspace.members.update` (admin-level) and checked only that the new list
  retained at least one owner — never that the *actor* was allowed to assign the roles
  it was handing out. So an admin could submit `[{self, owner}]`, pass both checks
  (the wholesale array replace drops the sitting owner), and seize `owner` — then
  archive/delete the workspace and raise its quota, all owner-gated. The fix caps every
  assigned role at the actor's own rank (an admin, rank 3, cannot assign owner, rank 4),
  while still allowing an actor to *preserve* a member's existing higher role (so an
  admin can keep the owner as owner while editing developers), and forbids a non-owner
  from demoting or removing a sitting owner. The same rank cap is applied to
  `grantResourceRole`, so a resource grant cannot become an owner-escalation channel.
  A platform admin (`isAdmin`) still resolves as owner everywhere, preserving that
  deliberate escape hatch.
- **A credential value of `null` could permanently DoS a session.** An `env_vars`
  credential's value is member-authored and only checked non-empty. `JSON.parse`
  succeeds on `null`, a number, a bare string, or an array — none a `{key: value}` map —
  and the value then reached `Object.entries` in `mergeEnvVars`: `null` threw a
  TypeError that failed the whole provision (session → `failed`, permanently
  unstartable) and crashed agent-core boot/rebind, while a string spread its characters
  as numeric-keyed env vars. A single member-authored value could stop every session
  granted it from ever starting. `mergeEnvVars` now ignores a non-object (defense in
  depth, never throws), and both materialisers shape-check the parse result: agent-core
  skips it (logging without the value, honoring its "never fatal" contract) and the
  provisioner throws the same clean, value-free validation error it already raised for
  invalid JSON — never a raw TypeError.
- **Reaped sandboxes leaked their runtime-bridge caches.** When a session is released,
  the composition root calls `forgetSandbox(id)` to drop the sandbox's cached token
  binding and its billed-turn markers. The two reaper paths (lease-expiry and idle)
  also destroy sandboxes, but `onSandboxReap` never called `forgetSandbox` for them —
  so every reaped sandbox left a token-binding entry and any lingering billing markers
  behind for the process's lifetime (unbounded growth on a long-lived node), and a
  stray call from a still-terminating agent-core on the old token could resolve to and
  append to the session that had since been re-queued — the exact reuse misroute
  `forgetSandbox` exists to prevent. `onSandboxReap` now forgets every id from both
  reaper sweeps (the idle sweep's return value, previously discarded, is now used).
- **A busy rebind could pin a session to a version its sandbox was not running.** The
  hot-upgrade sweep re-pins an idle session's `resolvedVersion` to the new version,
  then rebinds the sandbox in place. If the rebind reports `busy` (a turn started
  underneath it — the row lagged agent-core's synchronous `running=true`), the re-pin
  is rolled back. But the rollback was a *status*-guarded compare-and-set expecting the
  idle/ready it re-pinned from — and the very `turn.started` that made the rebind busy
  had committed `idle → running`, so the rollback matched nothing and silently no-oped,
  leaving `resolvedVersion` pinned to a version the sandbox was not running. Because the
  upgrade sweep only selects `resolved_version < production_version`, that split-brain
  was permanent — the sweep could never re-select the row to correct it — and per-turn
  authorization resolved the new version's grants against the old runtime. The rollback
  is now guarded on the *version* (`rollbackVersion`), so it undoes the re-pin
  regardless of status, while still refusing to clobber a concurrent re-pin to a newer
  version.
- **The `session.terminated` event could disagree with the row it summarizes.** The
  terminated event's `usage` was snapshotted from the in-memory session read *before*
  the `terminating` dwell (the `provisioner.release` await). A straggler `turn.completed`
  flushed during that dwell still folds usage onto the row — `recordUsage` skips only a
  *terminal* session and `terminating` is not terminal — so the event ended up claiming
  less usage than the row it was meant to summarize. (Money and quota stayed correct —
  the row and the daily counter bill the real tokens, and no consumer reads the event's
  usage field — so this was an audit-log self-consistency defect, not a billing one.)
  `shutdown` now refreshes a `session.terminated` event's usage from the fresh row at the
  moment of the terminal transition, so the event equals the row and the fold reproduces
  it.

## A later round: the flags the CLI documented one way and read another

A fifth audit round (partly rained out by transient API errors, but its one confirmed
finding stands).

- **Seven CLI flags were unreachable because the usage string omitted them.** The CLI
  derives a command's accepted-flag set by scraping `--foo` tokens out of its *usage*
  string, and the strict gate rejects anything else with exit 2 before the command runs
  — a deliberate design so a typo fails loudly instead of being silently discarded. But
  the derivation only enforces one direction (usage → accepted); nothing checked that a
  flag the command *reads* also appears in its usage. Seven did not: `--description` on
  workspace/agent create+update and template create, `--limit` on agent list, `--summary`
  on agent version create, and — the worst — `--owner-type` on credential create. That
  last one was the sole way to scope a credential to an agent/session/principal; with it
  unreachable, every CLI-created credential was forced to the widest (`workspace`) scope
  even though the SDK and gateway supported the narrower ones. The seven usage strings
  now list their flags, `--owner-id` is wired in alongside `--owner-type` (with a check
  that a non-workspace scope names an id), and a new test walks the command source and
  fails if any flag a command reads is missing from its usage — closing the reverse
  direction the original derivation left open.
- **Accepted content could be lost, and a failed document could never recover.** A
  document upload returns `202` and stages its content — but the content sat only in
  an in-memory map until the first ingestion tick wrote it to the blob store, so a
  restart in that accept→first-tick window lost it server-side and the pipeline
  dead-ended the row `failed`. Worse, nothing ever reprocessed a `failed` document
  (the queries only select `pending`/stuck-`processing`), so `error.retryable: true`
  was a dead flag — a transient embedder blip or a momentarily-unreachable blob was
  as fatal as genuinely bad content. Staging now persists the blob and records the
  staged digest at accept time (in `metadata.stagedDigest`, kept distinct from the
  processed-digest field so the unchanged-content skip is unaffected; `#loadContent`
  prefers the staged digest so a changed re-sync reloads the new content, not the
  stale processed one after a restart), and a new `reprocessFailed` sweep returns
  retryable-failed documents to `pending` — bounded by an attempt counter so a
  permanently broken document is not retried forever. (The dataset's `documentCount`
  roll-up is still never decremented; it is a display number, not an accounting or
  quota gate, and there is no per-document delete path to hook a decrement onto yet —
  tracked as a follow-up.)
- **An SSE live-overflow silently lost the interior events it dropped.** The event
  stream replays history then goes live through a bounded queue drained with
  backpressure. When a client stalled under a burst the queue overflowed and dropped
  events — but as it drained, later events kept being admitted and emitted, advancing
  the sent-cursor *past* the dropped range. The overflow notice then named
  `earliestSeq = cursor + 1` — past the gap — so a client that acted on it would
  resume *after* the events it missed, and both shipped clients ignore the notice
  entirely, so the interior events were lost with no signal at all: a hole in the
  middle of a guaranteed-exact stream. The bridge now records the first dropped seq
  and, on drain, self-heals — it re-reads the log from that seq and re-sends the tail
  in order (rewinding its cursor so the recovered range is not suppressed), rather
  than trusting the client to recover from a notice. Events already sent past the gap
  are re-sent, a benign duplicate the client dedups by the frame's `id:` line — the
  price of guaranteeing no interior gap and correct order. The log is the source of
  truth and every fan-out is post-persist, so a dropped event is always still in the
  log for the re-read to find.

## A later round: six smaller gaps in identity, the console, and the CLI

Continuing the fifth audit — a batch of medium/low defects across the edges, each
fail-first tested:

- **A SCIM user created inactive could never be activated.** Reactivation is gated on
  a SCIM-deactivation marker so a routine sync never clears an *admin's* deliberate
  disable — but a user provisioned `active:false` was disabled without that marker, so
  every SCIM path misclassified it as an admin disable and refused to enable it. The
  standard future-hire flow (provision inactive, activate on start date) was a dead
  end. Create-inactive now stamps the marker, so SCIM owns that disable and can lift it.
- **SCIM `listUsers` reported the page size as the total.** `totalResults` was set to
  the returned page length, so a spec-compliant IdP that pages until it has seen
  `totalResults` users stopped after the first page — every later user invisible to a
  full sync. It now reports the provider-wide count, distinct from `itemsPerPage`.
- **A wholesale member-list replace could clobber a concurrent change.** `updateMembers`
  read the workspace, then wrote a full replacement — a concurrent SSO reconcile or
  admin edit committing in between was lost. The validation and write now run inside a
  transaction that re-reads on the same connection, so the rank cap and sitting-owner
  protection apply to the *current* members (a concurrent change cannot slip an
  escalation past a stale check) and the read-validate-write is atomic. Fully closing
  the replace-API lost update needs an If-Match precondition on a monotonic version —
  `updatedAt` is unreliable as a version (same-millisecond writes collide) — tracked as
  a follow-up.
- **The console hid the middle of a long session log.** The session view fetched the
  earliest 500 events, then opened its live stream at `lastSeq + 1` — so for a session
  with more than 500 events, everything between the 500th and the tail was never fetched
  nor streamed: a silent gap on the primary operator surface. It now resumes the stream
  from the last event it actually rendered; the SSE bridge replays from that point
  before going live, backfilling the gap.
- **The CLI stored credentials with a stray line-ending.** `--value-file` stripped only
  a single trailing `\n`, so a Windows-authored (CRLF) file left a `\r` and a trailing
  blank line left a `\n` baked into a write-only credential — undiagnosable, surfacing
  only as an opaque third-party 401. It now trims all trailing whitespace.
- **The CLI dropped a flag value beginning with `-`.** `--token -sk_live_…` (the
  documented space-separated form, and any negative-number value) was parsed as a
  boolean because the next token started with a dash, then echoed the token to stderr as
  an unknown flag — leaking the secret it refused to accept. Only a `--`-prefixed token
  now terminates a flag's value.

## A later round: the audit prune that could strand a row where tampering hides

A sixth audit, targeting the two tamper-evidence primitives — the audit hash chain
and the tenant boundary on the grants that confer access — each fail-first tested:

- **Audit pruning could strand a retained row in the linkage-exempt zone.** The
  hash chain lets `verifyChain` skip the *linkage* check for rows at or below the
  prune watermark (they have no surviving predecessor to link to) while still
  content-verifying every survivor. That exemption is only safe if the watermark is
  a true *deleted-prefix* boundary — nothing live below it. But `prune` deleted by
  raw time (`DELETE WHERE at < before`) while the watermark and the exemption are
  keyed on `seq`, and `at` is caller-supplied: an NTP step, a DST shift, or a manual
  clock set makes `at` non-monotonic with `seq`. A row written out of `at`-order
  (later `seq`, older `at`) sat *above* a retained row in `seq` yet got carved out
  of the middle by the time-sweep — advancing the watermark past a row that
  survived. That retained row now lived below the watermark, in the zone where
  linkage is not checked: it could be deleted or its business fields forged (recompute
  a self-consistent `entryHash`) and `verifyChain` would not notice — the exact hole
  the chain exists to close. Pruning is now by **seq-prefix**: delete only the maximal
  all-expired oldest run (`firstKept = min seq with at >= before`; cutoff =
  `firstKept - 1`), computing the delete boundary and the watermark from the *same*
  value in one transaction. A clock-skewed expired row after a retained one simply
  lingers in the live, linkage-checked zone — the safe direction ("keep at least the
  retention window"). Adversarially re-verified across pre-existing gaps, the legacy
  migration-10 prefix, repeated prunes, and the no-live-row endpoint: no retained row
  can land at or below the watermark.
- **A resource-grant revoke crossed the tenant boundary.** `revokeResourceGrant`
  authorized `workspace.members.update` against the workspace in the request path,
  then deleted the grant with `DELETE FROM resource_grants WHERE id = ?` — no
  workspace predicate. An admin of workspace A who learned the id of a grant owned by
  workspace B could revoke it: strip access B's owner conferred, with the audit row
  filed under A so B's own trail showed nothing. The delete is now scoped to the
  caller's workspace and returns whether a row matched; a cross-tenant or nonexistent
  revoke is a not-found no-op, never audited as an allowed revoke. The authorization
  named the right action but trusted a caller-supplied id past the boundary the
  authorization was scoped to — the check-the-action-not-the-object lesson, applied to
  the object this time.

## A later round: the knowledge query that could wedge every tenant

A seventh audit, fanning finders across the subsystems earlier rounds had not
reached (crypto/credentials, retrieval, connector delivery, artifact/quota, gateway
routing, schema integrity). The one that landed was a denial of service in
knowledge-base search. The regex file-search tool had already been moved to a
terminable worker precisely because a model-controlled pattern can block the event
loop — but the BM25 *knowledge* query ran in-process on the control-plane event
loop, and nothing bounded it. `RetrievalService.search` handed the raw query — up
to the 10 MB HTTP body limit — straight to a scoring pass whose cost scales with the
query's term count across every allowed chunk, and `KeywordIndex.search` did not
deduplicate the query terms. So a single `/runtime/v1/search` from one sandbox with
a query of one word repeated a few hundred thousand times ran that many scoring
iterations (each an `O(chunkLength)` scan) synchronously, stalling the whole
multi-tenant control plane — health checks, the scheduler, every other tenant's
requests — for the duration. The un-deduplicated terms were also a correctness bug:
a repeated query word was folded into BM25 additively, so its score inflated
linearly with the repeat count (a test measured a 100,000× inflation).

Fixed at the chokepoint every caller converges on — the in-process toolset path, the
HTTP bridge path, and the sandbox callback all reach the index only through
`RetrievalService.search`. It now truncates the query to a bounded length (a real
retrieval query is a short question) before tokenizing, embedding, or scoring, and
clamps the result limit to a hard ceiling. `KeywordIndex.search` additionally
deduplicates query terms and caps their distinct count — the fix for the score
inflation, and defense in depth for a direct caller.

But bounding the query was only half of it — and the fix's own adversarial review
caught the other half. The scoring cost is `O(queryTerms × Σ chunkLength)`, so
capping the query still left two unbounded dimensions on the *corpus* side: a single
document with no sentence punctuation chunked into one enormous ~5 MB chunk (the
chunker's oversized-paragraph fallback emitted the whole run when it found no `.!?`
to split on), and the per-term frequency count was an `O(chunkLength)`
`tokens.filter(...)` scan. Either turned *any* later query — even a one-word one —
into a synchronous multi-hundred-million-operation stall, now persistent (every query
pays it) and surviving restart (the index rebuilds from the same content). So the fix
went deeper: the chunker hard-splits an oversized punctuation-free sentence into
size-bounded pieces, so no single chunk can exceed the target size; and the index now
stores, per chunk, a term-frequency map and token length computed once at ingest,
so scoring and document-frequency both probe the map in `O(1)` per query term. The
per-query hot path is now `O(allowedChunks × queryTerms)` with the chunk-length factor
gone entirely. Fail-first tests drive each layer: a term repeated 100,000 times scores
exactly once, a term past the query-length cap is truncated away, and a
punctuation-free blob is chunked into many bounded pieces rather than one giant one.

The same round found a scheduling defect that the default configuration walked
straight into. `skipIfRunning` — the guard that stops a scheduled run from starting
while its previous run is still going — asked "does this connector have a live
session?" and counted `idle` among the live statuses. That is right for the reuse
policies, where the next fire reuses that very session, so an idle (mid-conversation)
one is a genuine conflict. But the default policy is `new_per_event`: every fire
creates a fresh session, and after its turn the old one settles to `idle` and lingers
for its whole 24-hour TTL, never reused. Counting that completed run as "still
running" made a sub-daily schedule fire once and then skip every fire for ~24 hours —
a self-restarting suppression window that silently throttled hourly automation by up
to 24×, with only an INFO log to show for it. An earlier fix had scoped the check to
the connector's own sessions to stop *foreign* idle sessions from causing this; the
dual — the connector's *own* idle sessions — was left. The running-check is now
policy-aware: under `new_per_event` an `idle` session is a finished run and does not
count; under a reuse policy it still does. A fail-first test drives an hourly schedule
whose own prior run sits idle and asserts the next fire proceeds.

A third finding was a cross-tenant credential hole in the same family as the
grant-revoke IDOR. A connector carries a `secretCredentialId` (a webhook signing
key, a bot token), and create/patch accepted that id from the caller with no check
that the credential belonged to the caller's workspace — while every sibling path
(`SessionService.create`, `AgentService.createVersion`) does verify ownership and
require `credential.read`. The delivery pipeline later unseals that secret with no
session to authorize against, and the unseal's additional-authenticated-data is the
credential's own id, so decryption succeeds for *any* credential id, including one
belonging to another workspace. A member of workspace A could therefore bind
workspace B's credential id (learned out of band) and have the platform decrypt and
use B's secret. Both create and patch now run the same gate the session path does —
the credential must belong to this workspace and the caller must hold
`credential.read` on it, or the reference is a not-found no-op. A fail-first test
drives workspace A binding B's credential id, on both create and patch, and asserts
rejection.

And a fourth, quieter one: the two document-recovery sweeps that run on every
scheduler tick — the failed-reprocess and the stuck-`processing` recovery — had the
same unindexed-full-scan problem an earlier migration had already fixed for the
pending-ingest sweep, just on the other two statuses. The only other documents index
is dataset-id-leading, useless for a status-only scan, so each sweep full-scanned the
monotonically-growing documents table twice a tick. Two partial indexes (one per
status, keyed by `updated_at` so the range filter and ordering are both served from
the index) turn both into bounded index range scans, verified by `EXPLAIN QUERY
PLAN`. It is the fix-every-sibling lesson again: the pending sweep was indexed, its
two siblings were not.

## A later round: the corpus with no ceiling, and the count that only grew

The round-7 DoS fix bounded a knowledge query's own cost, but its adversarial
re-review left one residual standing: the BM25 scan is `O(indexed chunks)`, and
nothing capped how many chunks a workspace could accumulate. A tenant that uploaded
a large enough corpus made *every* one of its retrieval queries a multi-hundred-
millisecond synchronous scan on the shared control-plane event loop — a slow-burn
against every other tenant's latency, no amplification required. And a second,
quieter bug sat next to it: `dataset.documentCount` was incremented when a document
was created but *never* decremented, because there was no per-document delete route
at all — the count could only grow, and knowledge-chunk usage, once accrued, could
never be released.

Both are closed together. A new per-workspace `maxKnowledgeChunks` quota (default
100_000, generous over the few-thousand-chunk design target) is enforced as
*ingestion admission* at the real cost point: in `IngestionPipeline.process`, after
the chunks are built but before they enter the index, the projected workspace total
(the summed dataset rollup, minus this document's own prior chunks so a re-sync is a
replacement not an addition) is checked against the cap, and a document that would
overflow it is recorded `failed` with a non-retryable `QUOTA_EXCEEDED` error and
indexed not at all — so the cap actually holds and the retry sweep leaves it be.
Enforcing at `process` rather than at the upload is deliberate: the chunk count is
only known after chunking, and it is the indexed chunks, not the accepted documents,
that drive the scan. And a new `DELETE /v1/datasets/:datasetId/documents/:documentId`
route (via `IngestionPipeline.deleteDocument`) evicts a document's chunks from the
index, decrements the dataset's counts in one transaction with the row delete, and
is scoped to its dataset so a document addressed under the wrong one is a not-found
rather than a cross-dataset delete — the same IDOR guard the grant-revoke and
connector-secret fixes established. Deleting releases the chunk quota it held, and
the decrement (clamped at zero, since pre-fix datasets already over-counted) is what
makes `documentCount` finally able to go down. `GET /quota` reports the new
dimension. Fail-first tests drive each layer: an over-budget document is failed and
adds no chunks; a delete decrements the counts, evicts from the index, and refuses a
mismatched dataset id.

## A later round: the rebound setup command that ran without its environment

Delivering non-file credentials on rebind (an earlier round) reached the built-in
tools' child environment but, by its own note, not the setup commands — tracked as a
follow-up. This closes it. The asymmetry: on a cold provision the driver bakes the
agent's environment (sanitized `env_vars` plus `MA_CRED_*`) into agent-core's own
process env, and a setup command — spawned by `runShell`, which passed no explicit
env and so inherited `process.env` — saw it. On a rebind the driver never re-runs,
so that environment lives only in the `toolEnv` handed to the tools, and
`runSetupCommands`/`runShell` passed nothing: a rebound sandbox ran an agent's
declared setup steps (`pip install`, a build, anything reading a configured
`env_vars` value) without the environment a cold-provisioned one had — a silent
divergence that surfaces only as a setup step behaving differently after a warm
claim. `runShell` now spawns with `{ ...process.env, ...env }` and `buildSession`
passes `toolEnv`, so a rebound setup command sees the same environment as a cold one;
the empty-env default is a no-op overlay that leaves the cold path (and every other
caller) exactly as it was, and the sanitize boundary is unchanged (`env_vars` cannot
set a reserved `MA_*` key). The adversarial review then caught a sibling the first
pass missed: the *command runtime* (the pluggable non-agent-core path) has its own
`buildCommandRuntime`, which never materialised non-file credentials at all — so a
prewarmed command-runtime sandbox, booted with an empty `process.env`, ran its setup
commands and every turn's child with no `env_vars`/`MA_CRED_*` whatsoever. That path
now materialises the same `toolEnv` and threads it into both `runSetupCommands` and
each turn's child environment (with the platform `MA_RUNTIME_*` vars still layered
last so they stay authoritative). The MCP-server spawn is deliberately *not* included: it
withholds the broad environment on purpose so an untrusted server never receives
`MA_RUNTIME_TOKEN`, resolving only its own per-server credential refs — the same on
both paths, so no parity gap there. Fail-first: a setup command that requires a
threaded var succeeds only once the env is passed, and fails without it — verified on
both the built-in `runSetupCommands` path and the `buildCommandRuntime` path.

## A later round: the rollup increment that raced its own atomic decrement

Closing the chunk-quota gap made the dataset rollup a *correctness* surface, not just
a display counter: `chunk_count` is the exact basis the `maxKnowledgeChunks` quota
sums, so a count that drifts below the true live total silently re-opens the O(chunks)
BM25 event-loop stall the quota exists to bound. The per-document delete was hardened
against a double-decrement by making its rollup mutation atomic — `applyDocumentRemovalSync`
inside `store.transaction`, gated on a `removeSync` compare-and-set. But the two paths
that *raise* the same rollup were left as they were: the ingest re-sync
(`process()`) did `const dataset = await store.datasets.get(id)` then, across an
event-loop boundary, `await store.datasets.update(id, { chunkCount: dataset.chunkCount − old + new })`,
and the document-create route did the same `get`-then-`update(+1)` for `documentCount`.
An absolute write computed from a stale read is a lost update: a concurrent
`deleteDocument` — whose decrement is atomic — commits in the await window, and the
raise then overwrites it with a value that never saw the delete. A lost decrement
over-counts (denies capacity, mis-reports `GET /quota`); a lost *increment*
under-counts and lets the corpus index past the cap. This is the same
fix-every-sibling lesson as the rebind env change one round earlier: the decrement was
made safe, the siblings that raise the same counter were not.

The fix expresses *every* rollup mutation as a signed delta applied in one SQL
statement — `applyRollupDeltaSync`, `UPDATE datasets SET chunk_count = MAX(0, chunk_count + ?), …`
— so `applyDocumentRemovalSync` now delegates to it with negative deltas and both
raise-sites route through it with positive ones. A single `UPDATE` reads-and-writes
inside the engine, so add and remove *compose* regardless of interleaving: there is no
read to go stale, and the `MAX(0, …)` clamp keeps a delta from driving any column
negative (pre-existing drift or a double-applied removal). The phantom interleave —
a delete landing between the ingest's row write and its rollup delta — composes too:
the delete removes the row's `chunk_count` (already the new value), the delta adds
`new − old`, and the net is exactly `−old`, the true "remove this document's prior
contribution".

The adversarial review of the fix then tightened two more seams. The ingest's
"mark ready" row write and its rollup delta, previously two separate transactions, are
folded into **one** `store.transaction` (via a synchronous `documents.updateSync`), so
the row's new `chunkCount` and the rollup that must move with it commit or roll back
together — a throw on the rollup can no longer leave the row committed `ready` at the
new count while the rollup never accrued. And `deleteDocument`, which decremented by
the chunk/size counts read from a copy fetched *before* its transaction opened, now
re-reads the row's counts *inside* the transaction (`documents.findById` on the same
connection) so a re-sync that changed this document's size committing in between can
no longer make the delete decrement by a stale magnitude — the same
read-inside-the-write discipline the membership and OIDC-reconcile paths already use.
Fail-first at two levels: a store test drives the exact stale-read interleave (read a
snapshot, commit an atomic decrement, then apply the raise) and asserts the delta
lands on the decremented value — against the old absolute-write pattern it reads 120
where the true live sum is 100 — and an engine-level test runs the real `process()`
against a concurrent `deleteDocument` (plus a shrink re-sync) and asserts the dataset
`chunkCount` equals the summed live-document count, so a revert of the delta wiring is
caught at the caller, not only at the primitive. One seam is deliberately left for a
separate change: because the digest is persisted early (to avoid orphaning a blob), a
mid-ingest crash on a *re-sync* can still leave the in-memory index — mutated by
`index.add` outside any store transaction — out of step with the rollup on the retry
that takes the unchanged-digest skip; reconciling the in-memory index with the store is
its own tracked item, not something this counter fix claims to close.

## A later round: the one reuse path that skipped the lifetime ceiling

`maxLifetimeSeconds` is a hard bound, and by this round four paths enforced it —
the heartbeat refusal, the keep-warm release decision, the idle reaper, and the
expired-lease reaper — all through the broker's one `#agedOut` formula. The fifth
path, the one that actually hands a warm sandbox to a *new* session, did not.
`claimFromPool` filtered candidates on `pool_key`, `status = 'ready'`, and
`lease_expires_at > now` — but a warm sandbox heartbeats continuously and so
renews its own lease forever, so an unexpired lease says nothing about age. A
sandbox that crossed its ceiling while sitting `ready` could be claimed and
rebound onto a fresh session, only for its very next heartbeat to be refused
mid-turn — forcing a lost-sandbox recovery in place of the clean cold start the
caller would otherwise have gotten. This is the "enforce a bound on every path the
resource survives on" class: a ceiling checked on four of five paths is not a
ceiling. The fix hoists the predicate into one shared `sandboxAgedOut` in
`@ma/contracts` — the broker's `#agedOut` now delegates to it, and `claimFromPool`
calls it to skip an aged-out candidate (leaving it for the idle reaper, which
collects it via the same formula, so nothing is stranded). Notably this closes,
not opens, a leak: an aged-out warm sandbox is no longer briefly claimed and
holder-stamped, so it stays holderless-and-idle and is reaped promptly. Fail-first:
a store test seeds a `ready`, valid-lease sandbox created past its ceiling and
asserts `claimFromPool` passes it over while still claiming a fresh sibling in the
same pool.

## A later round: the member update that could silently drop a concurrent change

Member updates replace the whole list. An earlier round made that atomic — the
validation and write run in one transaction that re-reads the row, so the rank-cap
and sitting-owner checks always see the current members and a concurrent change
cannot be used to slip an escalation past a stale check. But the transaction alone
could not close a genuine *lost update*: because the API replaces rather than
merges, a member added concurrently (by another admin, or the SSO reconcile) but
absent from *this* caller's pre-change list was silently dropped — the caller's
payload was computed from a stale view. Closing that needs an optimistic-concurrency
precondition: the client edits against the version it read, and the server refuses
if the row moved since. `updatedAt` cannot be that token — a millisecond timestamp
collides on same-ms writes, so a stale write with an equal `updatedAt` would pass.

So a monotonic integer `version` column now backs an optional `If-Match`. The
load-bearing decision is *where* it is bumped: not in `updateMembers`, but in the
shared repository write path, so **every** workspace writer — name, quota, members,
archive, and the SSO reconcile — advances it, in the same `UPDATE`
(`… , version = version + 1`). A precondition is only as strong as its weakest
writer: had the bump lived in `updateMembers` alone, a member's `If-Match` token
would stay valid across a concurrent quota or SSO change and the check would be
defeated. `GET` (and `PATCH`) expose the version as an `ETag`; the member `PUT`
reads `If-Match`, and if it is present and no longer matches the freshly-read row,
the write is refused with **412** rather than clobbering the concurrent change. The
header is *optional* — absent means the prior unconditional behaviour, so every
existing caller keeps working — and it is parsed to a finite integer at the
boundary, so a garbage `If-Match` is a 400, never a `NaN` that would silently pass
the equality check. The SDK's `setMembers` takes an optional expected version and a
412 surfaces as a `precondition` error. Fail-first at every layer: the schema
defaults `version` to 1; the store bumps it on each write and not on a no-op patch;
the engine rejects a stale expected version and accepts the current one; and an
end-to-end test reads the `ETag`, updates with it, replays the now-stale token for a
412, and confirms an update with no `If-Match` still succeeds.

## A later round: the unchanged-digest skip that could hide a document forever

The knowledge index is in-memory and not transactional, and a document's digest is
persisted *early* — before its chunks are (re-)indexed — so that a crash between the
two never orphans the blob. That early write created a subtle hole on the *re-sync*
path: a daily re-sync of unchanged content takes a fast skip guarded by
`digest === current.digest && chunkCount > 0`, but a crash on a prior re-sync could
leave the row `ready` with the new digest while the index lost (or never regained)
the document's chunks. The skip would then fire on every future re-sync, and the
content would stay invisible to search forever — the row looks healthy, the index is
empty, and nothing reconciles them. (A first ingest self-heals, because a rolled-back
row keeps `chunkCount = 0` and fails the `> 0` guard; only a re-sync over an
already-`ready` row hits it.)

The skip now also requires the index to actually hold the document's chunks:
`index.documentChunkCount(id) === current.chunkCount`. When they disagree, `process()`
falls through and re-indexes, repairing the divergence — and because unchanged
content re-chunks to the same count, the rollup delta is zero, so a pure index repair
never disturbs a correct count. The check is **O(1)**: `KeywordIndex` maintains a
`documentId → chunk count` map alongside its parallel chunk arrays, updated in
lockstep by `add`/`removeDocument`. That cost discipline is deliberate — the skip is
the hot daily-re-sync path, and an O(chunks) scan there would reintroduce the very
event-loop-stall class the index's frequency-map design and the ingestion quota exist
to prevent. Scope kept honest: this closes the *index*-vs-row divergence; a
*rollup*-only drift (the dataset `chunk_count` sum disagreeing with the rows) is a
separate concern, and since a later round already commits the row and its rollup in
one transaction, such drift can only be pre-existing historical data — a reconcile
sweep, not this change. Fail-first: a test indexes a document, evicts its chunks from
the index behind the row's back, then re-syncs the unchanged content and asserts it
is re-indexed rather than skipped into permanent invisibility.

## A later round: the stdin write that could crash the whole runtime

The pluggable *command runtime* — the path that runs a non-agent-core agent (a
Python program, say) as a subprocess and feeds it the prompt on stdin — spawned the
child with a piped stdin and wrote the prompt with `stdin.end(prompt)`. If the child
exited before reading (a fast-failing command, or one that never consumes stdin), the
write raised `EPIPE`, emitted as an `'error'` on the stdin *stream*. That stream is a
separate emitter from the child process object, whose `'error'` handler covered only
spawn failure — so the stdin EPIPE was unhandled, and an unhandled stream error is a
process-level uncaught exception. It would not fail just the turn; it would crash the
entire agent-core process, taking down every session on that sandbox. This is exactly
the fix-every-sibling shape: the MCP stdio transport, which also pipes and writes to a
child's stdin, already attaches a no-op `stdin.on('error')` for precisely this reason
(with a comment naming EPIPE) — the command-runtime path was the one sibling that
wrote to stdin without the same guard. It now attaches the same listener (debug-logged
rather than silent), and the child exiting is handled where it already was — the
`close`/`exit` path that resolves the turn. `runShell` and the bash tool are
unaffected: they spawn with stdin *ignored*, never writing to it. Fail-first: a
command that exits immediately without reading stdin, handed a prompt larger than the
OS pipe buffer so the write cannot be absorbed first, used to throw `write EPIPE` and
crash; now the turn resolves and the process survives.

## A later round: the fall-back guard that assumed every zone shifts an hour

A cron expression names a wall-clock time, and on a DST fall-back a wall-clock minute
occurs twice — so the scheduler suppresses the second occurrence, or a nightly job
would fire twice. The suppression detected the repeat by looking *one hour* back in
absolute time and asking whether it lands on the same local minute. That silently
assumed every DST transition shifts a full hour. Australia/Lord_Howe shifts only
**30 minutes**: on its fall-back day local 01:30 occurs at 14:30Z and 15:00Z, thirty
minutes apart, so the one-hour lookback never saw the earlier occurrence and a nightly
`30 1 * * *` fired twice. The guard now scans back minute-by-minute up to the largest
real DST shift (a 120-minute ceiling) and reports a repeat if *any* earlier instant
shares the exact local minute — correct for a 30- or 60-minute shift alike. The scan
runs only on an already-matched candidate (a handful of formatter calls, at most twice
a year per schedule), so it adds nothing to the per-minute search. Fail-first: a
nightly schedule in Lord Howe fired at both 14:30Z and 15:00Z on the fall-back day
against the old lookback; now the 15:00Z repeat is suppressed and the schedule advances
to the next day normally.

## A later round: the ingestion start with no atomic claim

Document ingestion flips a row `pending → processing`, then chunks, embeds, indexes,
and finally commits `ready` plus the dataset chunk-rollup delta. The start was an
unconditional write: `process()` re-read the row and did `update({status:'processing'})`
with no status predicate. Within one process a periodic worker serializes that, but
the control plane is designed to run multiple replicas against one store (the session
and receipt repositories carry compare-and-set precisely for this), and there ingestion
had none. Two replicas both find the `pending` document, both flip it, both ingest —
and each applies `applyRollupDeltaSync(+N)`, so the dataset `chunk_count` becomes 2N
while the row records N. The unchanged-digest skip then re-reads a matching row and
index and skips forever, so the overcount is permanent and non-self-healing; worse,
the quota admission sums the inflated rollup and starts rejecting legitimate documents
at roughly half the true `maxKnowledgeChunks`, plus paying to embed everything twice.

The fix gives the document repository the compare-and-set its siblings already have:
`claimForProcessing(id)` runs `UPDATE documents SET status='processing' WHERE id=? AND
status='pending'` and returns whether this caller won. `process()` claims first and
returns immediately if it lost — so the `pending → processing` edge is the single
serialization point, and exactly one worker ingests. Every production (re)process
routes the row through `pending` first (a re-upload creates a fresh pending row;
`reprocessFailed` and `recoverStuckProcessing` requeue to pending), so the claim covers
every real start path; the machine's unused `ready → processing` edge is gone with the
old assert. Fail-first: two workers claim the same pending row — the CAS lets exactly
one win; and a `process()` racing a worker that already claimed the row applies no
rollup delta and indexes nothing (against the old code the loser ingested and drove the
rollup to 2N). A separate, pre-existing seam remained: the stuck-`processing` reaper
requeues without a status CAS and the final commit had no ownership re-check, so a
worker slower than the recovery window could still double-commit — closed by the next
change.

## A later round: the ingestion commit with no ownership check

The atomic claim serialized the *start* of ingestion, but not the *finish*. A worker
that outran the stuck-`processing` recovery window could still double-commit: the
reaper requeues its row to `pending`, another worker claims and ingests it, and then
the slow original worker — oblivious — commits its own `ready` + `+N` rollup delta a
second time, so the dataset `chunk_count` reaches 2N and the unchanged-digest skip
locks the overcount in. The claim guarded who *starts*; nothing guarded who *finishes*.

The fix is an ownership token. `claimForProcessing` now stamps a fresh
`processing_token` on the row as it flips `pending → processing`, and every terminal
write goes through `finalizeIfOwnedSync`, which lands `UPDATE … SET …,
processing_token = NULL WHERE id = ? AND status = 'processing' AND processing_token = ?`
— committing (and clearing the token) only if this worker still owns the row. All
three terminal paths use it: the `ready` + rollup commit (skipping the rollup delta
when ownership was lost, so no phantom `+N`), the unchanged-digest skip (also a
terminal `ready` write — routing it through the same gate was a sibling easy to miss),
and the failure write (so a dispossessed worker cannot stamp `failed` over the new
owner's row). The reaper's requeue is now itself a compare-and-set —
`requeueIfProcessingSync` runs `WHERE status = 'processing' AND updated_at < staleBefore`
— so a row the owner completed *or* that a fresh worker re-claimed (a new
`updated_at`) between the reaper's stale-scan read and its write is left alone, not
clobbered back to `pending`. Re-asserting the same staleness filter the scan used at
read time closes a cross-replica TOCTOU that a status-only predicate would leave open
(disowning a freshly-claimed row → a wasted re-ingest). Clearing the token on requeue
is what disarms the slow worker: its `finalizeIfOwnedSync` finds its token gone and
discards the run.

The token is a nullable column (`optional`, so no entity-literal churn), present only
while `processing` and cleared on every terminal or requeue write. Fail-first: a
controllable embedder pauses Worker A mid-ingest; the reaper requeues its row; Worker
B claims and fully ingests; A is then released and attempts its commit — against the
un-gated code A's stale commit drove the rollup to 2N, and with the token gate A's
commit is discarded and the count stays at the true N. A second test asserts the
reaper leaves an already-`ready` row untouched, and the skip path clears its token.

## A later round: the startup reaper that mistook live sandboxes for orphans

At startup the platform reaps *orphaned* backend resources — a container or pod
whose sandbox row is gone, which nothing else will ever clean up. It did so by
listing the live sandboxes, then asking the driver to destroy every labelled
resource whose ref is not in that set. The list was `store.sandboxes.list({ statuses:
['pending','ready','draining'] })` with no `limit` — and the paged `list` clamps to
its default page size of 50. So the "known-live" set was only the first 50 rows by
id, and the driver destroyed every live sandbox whose row sorted past them: on any
container/k8s control-plane restart with more than 50 live sandboxes, the highest-id
ones were torn down as orphans, killing running (possibly mid-turn) environments that
non-terminal sessions still held — and because the reaper does not feed session
recovery, those sessions were left `ready`/`running` against a destroyed sandbox. The
live-sandbox count is global; the only cap near it, `maxSandboxes`, is per-workspace,
so a deployment of a few dozen tenants clears 50 easily. The reap needs the
*complete* live set — a missed ref is a live sandbox wrongly destroyed — so a paged
read is categorically the wrong tool. A dedicated unpaged `listLiveProviderRefs()`
projects just the provider ref for the resource-owning statuses, and the startup reap
now uses it. Fail-first: 60 live sandboxes, and the accessor returns all 60 (the paged
`list` returns 50), so `reapOrphans` sees every one as known and destroys none.

## A later round: an aborted request body could crash the sandbox process

agent-core runs one session per process and serves `/submit` and `/rebind` over
HTTP. Both read the request body — `handleSubmit` via `req.on('data'|'end')`,
`handleRebind` via `for await (const chunk of req)` — and neither guarded the body
*stream* against an error. A request body can error mid-read on an ordinary network
fault (ECONNRESET, a client abort), which is routine on the warm-reuse `/rebind` hot
path. On `handleSubmit` that raised an unlistened-emitter `uncaughtException`; on
`handleRebind`, launched fire-and-forget as `void handleRebind(...)`, it became an
unhandled rejection — and with agent-core (unlike the control plane) installing no
process-level guard, either one killed the whole single-session process, some of that
time with a live session mid-flight, instead of degrading to the documented 500 +
cold fallback. Three guards close it: `handleSubmit` attaches a `req.on('error')` that
answers 400 (the turn was never accepted, so nothing is lost); the `handleRebind`
launch gets a `.catch` that answers 500; and agent-core installs process-level
`unhandledRejection` (log and continue) and `uncaughtException` (log and exit for a
clean restart) handlers as defense in depth. Fail-first: a raw socket sends an
authenticated POST declaring a large `Content-Length`, writes a few bytes, then
destroys the connection — against the unguarded code the handler faulted; now the
process survives and its `/healthz` beacon still answers 200.

## A later round: the discarded ingest that stayed in the local index

The ownership token stops a lost-ownership worker from committing to the *store*, but
the in-memory search index is per-replica and outside any store transaction. Ingestion
runs `index.add(chunks)` before the ownership-gated commit, so a worker requeued by
the stuck-processing reaper and superseded by another replica had already mutated
*its* index — and the `!owned` branches (both the successful commit and the failure
path) simply returned, leaving those chunks behind. That replica then served its
discarded version of the document (split-brain search across replicas), and its
`documentChunkCount` disagreed with the row — which, if they happened to match, would
pin the stale text under the O(1) unchanged-digest skip. The fix is the index-side
sibling of the store-side gate: on either lost-ownership branch, `index.removeDocument`
drops the speculative chunks from the local index before returning, so the losing
replica holds nothing for the document and re-indexes on its next successful sync
(`removeDocument` is idempotent, so it is safe on the failure path whether or not
`index.add` had run). Fail-first: two workers on separate indexes race one document;
the reaper requeues the slow one, the other ingests, and after the slow worker is
released its own index holds zero chunks for the document (one, before the fix).

## A later round: the command-runtime build that leaked its temp dir on failure

`buildSession` (the built-in runtime path) was hardened an earlier round to tear down
its subprocesses and remove its `mkdtemp`'d working directory when the build throws —
a required setup command that exits non-zero raises `SANDBOX_SETUP_FAILED`, and the
teardown otherwise lives only in the returned runtime's `close()`, which a throw never
reaches. `buildCommandRuntime` (the pluggable non-agent-core path) was the sibling that
never got the same guard: it `mkdtemp`'d a workDir and ran the setup commands with no
cleanup, so every failed prewarm or boot of a command-runtime agent leaked a temp tree
for the process lifetime. It now wraps the setup step in a try that `rm`s the workDir
before rethrowing, mirroring `buildSession`. Fail-first: a command runtime with a
required setup command that exits non-zero throws, and the count of `ma-agent-cmd-*`
temp directories is unchanged across the failed build (it grew by one before the fix).

## A later round: the transient sandbox error that permanently dropped a delivery

When the control plane submits a connector-triggered prompt to a sandbox, a 409 is
already handled with care — it means the session is mid-turn, so it is thrown as a
*retryable* `conflict` and the delivery pipeline backs off and retries. But every
*other* non-ok response fell through to `throw new Error(...)`, and a plain `Error`
coerces to category `internal`, which is not retryable — so the pipeline
(`if (exhausted || !failure.retryable)`) wrote the receipt to terminal `failed` on the
first attempt. A sandbox answering 503/500/504 during a rolling restart, or a
connection-level failure (ECONNREFUSED, reset) that rejected the `fetch` itself and
was likewise coerced to `internal`, therefore *permanently dropped* a connector
delivery — an alert or webhook — that would have succeeded seconds later. This is the
exact trap the 409 branch sidesteps, on every neighbouring path. Now a `>= 500`
response throws a retryable `MaError` (`timeout` for 504, `unavailable` otherwise), a
fetch rejection is wrapped as retryable `unavailable`, and a genuine non-409 4xx (a
real client error the sandbox will reject identically) stays non-retryable. Fail-first:
a retryable submit failure requeues the receipt to `pending` with a backoff instead of
failing it — while the existing non-retryable case still fails terminally.

## A later round: the model provider whose errors defeated retry and failover

The runtime bridge is built to survive a flaky model: `withRetry` backs off on a
retryable failure, and the failover loop advances to the next authorised model when
the requested one fails retryably (`if (i === 0 && !failure.retryable) throw failure`).
Both key off `MaError.retryable`. But the sole shipped provider, OpenRouter, threw a
plain `Error` for *every* non-ok response — 429, 503, 401, 400 alike — and a plain
Error coerces to category `internal`, which is not retryable. So a primary model
returning 429 for a few seconds failed the turn *immediately* as a non-retryable
INTERNAL error, with no in-place backoff and no fallback model tried — precisely the
transient case the machinery exists for. The provider now classifies by status: 429 →
`quota` (retryable, carrying any `Retry-After`), 5xx → `unavailable`/`timeout`
(retryable), 401 → `unauthenticated`, 403 → `permission`, other 4xx → `validation`
(non-retryable, since the model will reject it identically on retry) — and the
non-JSON branch classifies by status too, so a 5xx HTML error page from a proxy is
retryable rather than an opaque `internal`. This is the same "an unclassified Error
becomes a non-retryable `internal` and defeats the retry/requeue machinery" class as
the sandbox-submit fix one round earlier — two neighbours of the same trap. Fail-first:
a 429 surfaces as a retryable `quota` MaError and a 5xx as retryable
`unavailable`/`timeout`, while a 400/401 stays non-retryable — against the old plain
Error, the assertions that the thrown value is even a `MaError` fail.

## A later round: the migration runner that could double-apply on a simultaneous boot

The schema-migration runner reads the applied-migration set once, then loops applying
each not-yet-recorded migration in its own write transaction. The read was a snapshot
taken *before* the loop, and the migration DDL is raw (`CREATE TABLE workspaces (...)`,
not `IF NOT EXISTS`). The target deployment shares one SQLite file across replicas, so
two booting together against a fresh database both snapshot an empty applied-set and
both enter the loop for migration 1 — and the second's raw `CREATE TABLE` (or its
`schema_migrations` primary-key insert) throws, crashing that replica's boot. The runner
now re-reads inside each write transaction (`SELECT 1 FROM schema_migrations WHERE id=?`)
and skips a migration a peer committed since the snapshot; SQLite's single-writer lock
serializes the transactions, so the re-check sees the peer's committed row. The
checksum-drift guard (refusing to run an edited, already-applied migration) is unchanged.
Fail-first: re-running a migration set is a clean no-op — the raw `CREATE TABLE` is never
executed twice and nothing is double-counted.

## A later round: the SSE resume that stayed silent below the retention watermark

Retention truncates the *head* of a session's event log — `prune` deletes every seq
below a watermark — deliberately, because a head-truncation is recoverable (a client is
told the earliest surviving sequence and re-reads from there) while a hole in the middle
is not. The REST read path honours this: `readEvents` returns `earliestSeq` alongside the
events, so a REST client that asked to resume from a pruned sequence can see that the
range it wanted is gone. The SSE path did not. A browser that slept through a prune
reconnects with its old `Last-Event-ID`, so it asks to resume from a sequence that no
longer exists; `store.events.read` filters `seq >= fromSeq`, so the first row it returns
is the earliest *surviving* seq, and the bridge's duplicate-suppression only skips
`seq <= fromSeq - 1` — so that survivor sailed straight through and the client believed it
had resumed exactly, silently missing `[fromSeq, earliestSeq)`. Two sibling endpoints
disagreed on whether a gap had occurred, and the one a browser cannot work around (it
auto-reconnects with a header; it cannot pre-check `earliestSeq`) was the blind one. The
bridge now reads `earliestSeq` before the replay loop and, when the requested resume point
sits below it, emits a `stream.lagged { earliestSeq, during: 'resume' }` notice *before*
the first surviving event — and, like the other overflow notices, without an `id:` line so
it cannot rewind the browser's resume cursor. Guarded so it never cries wolf: a resume from
the beginning (`fromSeq: 0`) asked for everything and cannot perceive a truncated head, and
an empty log has nothing to be behind. Fail-first: seed 1..100, prune below 50, resume from
31 — the client's first frame is now the `stream.lagged` naming `earliestSeq: 50`, ahead of
seq 50, where before seq 50 arrived with no signal at all.

## A later round: the console that watched a dead session forever

The operator console watches a session by opening the SSE stream and rendering each
event into a log, reconnecting from its last-seen sequence if the socket drops. The
watcher loop only ever exited on two conditions — the reader reporting `done`, or the
view being left — so when a *live* session reached a terminal state (terminated,
failed, or expired) mid-watch, the stream stayed open. The bridge holds an SSE
connection open until the client leaves (a terminated session simply stops producing
events, it does not close the stream), so the console sat on an idle socket behind a
green "live" badge for a session that would never emit again, and on a drop it would
dutifully reconnect and re-replay the whole dead history. The read-only treatment
already existed but was decided *once*, from the status snapshot taken at page load; a
session that ended a second later was never re-classified. The watcher now recognises
the three terminal event types as they arrive and tears the stream down — aborts the
connection, marks the badge ended, and retires the interrupt/terminate/compose controls
whose only outcome on a finished session is a server rejection. Two smaller correctness
points fell out of reviewing the fix: the teardown is idempotent (a fail-then-expire, or
a re-entrant call, collapses to one), and it closes a load-time race — if the status
snapshot read non-terminal but the history fetched a moment later already contained the
terminal event, replay tears down during `append`, and the stream-open guard now honours
that (`if (terminal || ended)`) instead of reopening a live feed on a dead session; the
reconnect tail is likewise gated on the abort so it cannot overwrite the "ended" badge
with "reconnecting…". Asserted on the shipped inline script, as the console's other
behaviours are (it ships as one self-contained document with no build step, so its logic
is verified against the rendered artifact).

## A later round: the replay guard an unsigned header could walk around

The webhook connector will not activate without a signing secret, and it rejects any
inbound request whose HMAC over `timestamp.body` does not verify — so by the time an
event is normalised into a delivery, it is provably a request the holder of the secret
sent. What stops that *same* signed request, captured and replayed inside the signature's
tolerance window, from starting a second agent run is the dedup key: the delivery's
`externalEventId` feeds a `(connector, external_event_id)` unique index, so a repeat lands
on the existing receipt instead of a new run. The key was chosen from the first of: the
body's own `eventId`, then the `x-ma-event-id` request header, then a value derived from
the signature, then a fresh random id. The header sat one rung too high. It is *not*
covered by the signature — only `timestamp.body` is — so an attacker who captured one
signed delivery whose body carried no `eventId` could replay it unchanged (the signature
stays valid, the body never moved) while varying the `x-ma-event-id` header on each
replay: every distinct header minted a distinct dedup key, a fresh receipt, another run.
The signature-derived key, which collapses byte-identical replays onto one receipt exactly
as intended, was unreachable because the attacker-controlled header outranked it. The fix
drops the header below the signature-derived key: on a signed delivery the id is the body's
`eventId` or the signature digest, never the header, so identical signed replays always
share one key; the header survives only as a best-effort producer id for an *unsigned*
adapter reaching the same path (the webhook, always signed, never consults it). The body's
own `eventId` still wins, so a producer's legitimate tagged retries deduplicate as before.
Fail-first: two normalises of the same signed body (no `eventId`) with different
`x-ma-event-id` headers must yield the same `externalEventId` — they did not before.

## A later round: the maintenance step that could strand a reaped session

One periodic loop does everything: it reaps sandboxes whose lease lapsed, sweeps idle
warm sandboxes, forgets their cached runtime state, runs artifact retention, and ingests
documents — and then hands the reaped sandbox ids back to the scheduler, which recovers
each session that held one (a session whose sandbox was destroyed must re-provision, not
sit `ready` against nothing). The scheduler already isolates each of its *own* sweeps so
one failure cannot skip the rest, but it called this whole reap-and-maintain callback as a
single opaque step — and inside, the callback was a bare `await` chain ending in
`return reaped`. The reaped ids, the callback's entire contract, came out last, behind
artifact retention and three ingestion calls. A single poison ingest document (making
`processNext` throw) or a transient artifact-store fault would throw past the return; the
scheduler logged "sandbox reap failed" and never recovered the sessions, which stayed
`ready` against sandboxes that no longer existed — and since the ids were lost and the
sandboxes already gone from the lease table, no later tick recovered them either. The
sweep is now an extracted `reapAndMaintain`: the reap runs first (it produces the ids, and
its own failure genuinely means there is nothing safe to return, so that alone
propagates), then every maintenance step runs isolated — a failure is logged and skipped,
so `return reaped` is unreachable by a maintenance throw, and one failing step (retention)
no longer skips the next (ingestion) within the tick. Extracting it also made the ordering
guarantee unit-testable directly: fail-first, a throwing purge or a throwing `processNext`
still returns the reaped ids — they did not before.

## A later round: the content-addressed blob served without checking its address

Artifacts are stored content-addressed: a blob's key is the sha256 of its bytes, computed
once at publish over exactly what was received, and everything downstream trusts that row's
`digest`. Reading it back, though, took the bytes on faith. `download` (the audited path by
which an agent's output reaches a person) and `readForPreview` (the public preview origin)
both fetched the blob by its digest key and served it without re-hashing — so a blob that
no longer matched its address (bit-rot at rest, a filesystem fault, a backend that returned
the wrong or a truncated object) would be handed over as authentic. The digest was used as
a *key* but never as an *integrity check*. Both paths now go through one
`#loadVerifiedBytes` that hashes the bytes read back and refuses a mismatch as an internal
fault (`ARTIFACT_CONTENT_CORRUPT`, distinct from `ARTIFACT_CONTENT_MISSING` so an operator
can tell "the content is damaged" from "the content is gone") rather than serving corrupt
content. Sharing one helper is the point: `readForPreview` is documented as "otherwise
identical to download", and the guarantee must not drift between them. Cheap — one hash
over bytes already in memory — and it makes content-addressing honest on read, not only on
write. Fail-first: overwrite a stored blob with different bytes under its own digest key,
then download it — it is now refused rather than returned.

## A later round: the in-flight idempotency lease that outlived the request

An idempotency key protects a mutation from running twice: the middleware reserves the key,
runs the handler, then records the response so a retry replays it. A key reserved but not
yet completed means the original request is still in flight, so a concurrent retry gets a
409 rather than a duplicate run. The flaw was in how long "still in flight" lasted. The
reservation was stamped with the same expiry as a *completed* record — the 24-hour
retention window — because `reserve` took one TTL and used it for both. So if the process
died between the reserve and the complete (a hard crash, an OOM kill, an eviction, or a
shutdown drain that abandoned the in-flight work), the reserved-but-incomplete row survived,
and for the next 24 hours every retry of that key got `IDEMPOTENT_REQUEST_IN_FLIGHT` — a
409, which is not retryable, so the SDK surfaced it as a hard failure. The very retry
idempotency exists to serve was bricked for a day, and nothing reclaimed the row early: it
conflated "a request is in flight right now" with "a request was abandoned hours ago" — the
same boolean-vs-tri-state and enforce-a-bound-on-every-path shapes this codebase has hit
before. The two states now have two clocks: a fresh reservation gets a short in-flight lease
(minutes), and `complete` extends the expiry out to the full retention window. An abandoned
reservation self-heals once its short lease lapses — the next retry reclaims it and proceeds
— while a genuinely concurrent request, still within the lease, still gets its 409. The
lease is deliberately longer than any keyed handler legitimately runs (session creation
leaves the session `queued` for the scheduler; nothing provisions synchronously under the
lock), so a slow-but-live request is never reclaimed and re-executed. Fail-first: reserve
with a short lease, advance past it but far short of the retention TTL, reserve again — it is
now reclaimed rather than returning the stale in-flight record; and a completed record still
replays for the whole retention window.

## A feature round: making the run log searchable

The event log is the platform's persisted run-log surface, but the only ways to slice it
were by sequence range, `turn`, and event `type` — an operator could not ask "which events
mention this error string?" or "what happened in this five-minute window?". This round adds
both: a case-insensitive content query (`q`) that substring-matches the event payload, and a
timestamp window (`fromTs`/`toTs`) — and, while there, exposes the `toSeq`/`turn`/`order`
filters the query schema already supported but the HTTP layer silently dropped. The whole
thing threads one path: contract schema → store `read()` → engine `readEvents` → gateway
route → OpenAPI → SDK.

The design deliberately does **not** introduce a full-text index. There is no SQLite FTS5
anywhere in the codebase, and its availability in this `node:sqlite` build is unconfirmed;
the only text-search precedent is the knowledge base's in-memory BM25 index, which is
decoupled from events. Instead, `q` is an additional `LIKE` predicate on the existing
`payload` column — no migration, no new column, no change to the sequence-critical append
path, working on all existing data immediately. But a `%x%` LIKE is non-sargable, and a
query that matches few or zero rows does not stop at the result `LIMIT` — it keeps scanning.
`session_id` scoping alone is **not** a sufficient bound: retention caps a session's log only
by *time* (up to years), the payload text is schema-unbounded, and `node:sqlite` runs the
scan synchronously on the single control-plane event loop — so an unbounded search was an
authenticated cross-tenant stall (an adversarial review of this very change caught it; the
first cut wrongly reasoned that scope + `LIMIT` bounded the cost). The scan is now bounded on
*both* dimensions: it examines only the most-recent `MAX_SEARCH_SCAN` events of the session
(an inner `ORDER BY seq DESC LIMIT` window) and only the first `MAX_PAYLOAD_SCAN` bytes of
each payload, making a search O(rows × bytes) with both factors fixed. The documented price
is that content search covers recent history rather than the entire retained log. The
other known limit is that matching the raw serialized JSON also matches field names (a search
for `text` hits the `"text":` key) — an accepted v1 trade-off; value-only extraction and a
larger/precomputed search window are future refinements.

Three details carry the safety. The user's query has its `LIKE` metacharacters (`%`, `_`,
and the escape char `\`) escaped and is bound with an explicit `ESCAPE '\'`, so a literal
search for `50%` does not wildcard-match everything starting `50`. The query length is
clamped (a search string reaches SQL as a bound parameter — an oversized one is a scan-cost
lever). And the time window is filtered in the `WHERE` while ordering stays with `seq`: a
window is a filter, not a resume cursor, so `ts` ties are irrelevant and the gap-free-seq
ordering the whole log depends on is untouched. Timestamp params are gated with
`Number.isFinite` at the boundary, so a garbage `?fromTs=abc` is ignored rather than passed
as `NaN` (which would compare false against every row and silently return nothing). Each
layer landed fail-first: the `LIKE`-escape, the time window, the dropped-filter regressions,
the NaN gate, and the SDK query forwarding each have a test that fails against the code
before the change.

A follow-on round put the search where an operator can reach it: the console session view
now has a search box. It is a *static* search — typing a query pauses the live stream,
re-fetches the history filtered by `q`, clears the log, and shows only the matching events
read-only; Clear returns to the live view via a full re-render. Client-side filtering of the
live tail was deliberately not attempted: the SSE feed carries no `q`, so matching events
client-side would diverge from the server's (bounded, ASCII-`LOWER`, raw-JSON) semantics — a
point-in-time query over recent history is the honest surface for what the backend actually
does. The box is emitted unconditionally, so a *finished* session's log — often the one an
operator most wants to search — is searchable too. The console ships as one inlined browser
script tested by assertions on the rendered document, so the search input, the query
construction, its unconditional placement, and (a guard against the template's backtick
hazard, which bit once during implementation) that the script still parses are all asserted
against the shipped source.

A later round closed both documented limits. **Values only:** each event's search text —
its payload's string and number values, lower-cased with full Unicode folding and capped at
16 KB — is computed once at append into a side table, `event_search`, whose foreign key
cascades from `events` so retention and session deletion take it along; a migration
backfills existing history with SQLite's `json_tree` (ASCII folding for those rows, as
before). A search is now `instr` over that text: no field names, no JSON escapes, no
wildcard metacharacters to escape. **The window:** the precomputed column alone bought
little — measured, an `instr` over 16 KB rows ran only ~1.7× faster than the old
`LOWER(substr(...)) LIKE`, because reading the bytes dominates — so the cap moved from
"how much one synchronous query may scan" to "how much one request may scan in yielding
steps". The scan walks the session's log by keyset in the caller's order, 1,000 events per
step with the event loop running between steps, up to 100,000 events per request; when it
stops at that cap it reports `truncated` and the `resumeSeq` to continue from, so the whole
retained log is reachable a request at a time. Because every immediate queued before the
loop's check phase runs in that phase, unbounded concurrent searches would still run one
step each back to back before any I/O; a per-process limit (two running, sixteen waiting,
then `429 SEARCH_BUSY`) keeps that to two steps per loop turn, and a client that disconnects
stops its search between steps. Each guard has a mutation that turns its test red, and a
real-process e2e boots a server on a database left at the old schema with 120,000 logged
events: the backfill runs at boot, a search past the cap resumes to the oldest event, and a
flood of thirty searches is served or refused while `/health` keeps answering — without the
yield between steps, it answered twice in the whole flood.

## An audit round on the identity surface: SSO, SCIM, RBAC, delegation, credentials

A dedicated adversarial pass over the auth/identity code — OIDC login, SCIM provisioning,
resource-scoped grants, sub-agent delegation, credential materialisation — surfaced nine
confirmed defects (four medium, five low), all now fixed fail-first. The core paths held up
(the OIDC token verification is textbook: asymmetric-only alg allowlist, JWKS signature
check, iss/aud/azp/exp/iat/nonce, sealed state carrying the PKCE verifier), but the edges
had gaps:

- **A credential-supplied `env_vars` could inject interpreter code.** The env denylist
  stripped Node/Python loader vars but not Ruby's `RUBYOPT`, Perl's `PERL5OPT`, or
  `NODE_PATH` — all read at interpreter startup — so a principal with only credential
  access (not version-authoring) could get code execution in a polyglot image. Added to the
  single shared denylist.
- **Offboarding could be undone by a rehire.** SCIM deactivate is fail-open on key
  revocation (it disables immediately even if the revoke throws); reactivation cleared the
  disabled flag without re-revoking, so a key that survived a failed offboard sprang back.
  Every reactivation path now re-revokes.
- **A resource grant stopped halfway.** A grant of `developer` on one agent was honoured by
  get/update but ignored by version.create/read and archive (a plain workspace-role check),
  so the grant could not do the thing it was granted for. Those paths now consult the grant.
- **Command-runtime agents got no file credentials.** A foreign-process runtime skipped the
  file-credential materialisation entirely (drivers delegate it to agent-core, which only
  ran it for the built-in harness), so an ssh_key/file credential was written by nobody.
  Extracted into a shared helper both runtimes call.
- Plus five lower-severity fixes: SCIM create honouring `active:false` on an existing user;
  OIDC first-login converging on a concurrent winner rather than a 409; rejecting a
  credential name that collides with another's `MA_CRED_*` env key (unified into one
  `credentialEnvName` used by every materialiser and the collision check); propagating a
  parent turn's interrupt/deadline into a delegated child so it can't wedge the session; and
  scoping the SCIM list scan to its own provider so `totalResults` can't under-report behind
  a large other provider.

The recurring shape across the medium findings: a safety property that held on the primary
path but not its mirror — a denylist missing a language, a revoke skipped on the reverse
transition, a grant honoured on some verbs, a credential type materialised on one runtime.

## An audit round on the sandbox isolation boundary

A dedicated pass over the sandbox drivers — network egress, volume mounts, pod-spec
construction, and driver parity — found five confirmed defects (one high, four medium),
all fixed fail-first. The egress model itself held up (default-deny NetworkPolicy that the
driver refuses to run without, `automountServiceAccountToken: false`), but the mount and
policy edges did not:

- **A volume mount target could escape to the host root.** The `mount.target` schema
  checked for an absolute path with no `..`, but the value was then interpolated verbatim
  into docker's comma/equals-delimited `--mount` string. A target of `/data,source=/`
  passed validation and made docker's last-wins parser bind the host root writable — a full
  escape of the per-workspace volume confinement. The same field also let non-canonical
  spellings (`/.`, `//workspace`, `/tmp/.`) slip past the reserved-mount check and shadow
  the sandbox's own managed mounts. The schema now rejects the delimiter metacharacters and
  compares the reserved set against the canonical form; the container driver adds a boundary
  assertion behind it. (Schema validity is not injection safety for a value that flows into
  a different downstream grammar.)
- **The k8s ingress fence keyed on the wrong CIDR.** The pod's inbound rule sourced from the
  control-plane Service ClusterIP, but a NetworkPolicy ingress matches the packet source and
  the control plane dials the pod from its own pod IP — so on a real CNI every `/submit` and
  `/rebind` would be dropped, and the natural "widen the CIDR to fix it" reaction would open
  those endpoints to any pod. Split into two knobs: egress destination (ClusterIP) and
  ingress source (control-plane pod CIDR).
- **The local (default/dev) driver silently ignored a restricted egress policy** and its
  docstring claimed a runtime-harness enforcement that does not exist. It now warns loudly on
  every restricted provision (rather than fail closed, which would break the default dev flow)
  and the docstring tells the truth.
- **The k8s volume name derivation was lossy**, so `data.cache` and `data_cache` collided into
  one pod volume name and k8s rejected the pod — a deterministic self-inflicted DoS. The
  derived name now carries a hash of the raw name so distinct declarations stay distinct.

## An audit round on the crypto, key, token and signature surface

A dedicated pass over the cryptographic trust boundary — envelope encryption and key
lifecycle, OIDC/JWT federation, self-issued tokens, inbound signatures, and credential
delivery to sandboxes — with adversarial finders and refute-by-default verification. The
primitives themselves (AES-256-GCM + AAD, random IVs, fixed-width `safeEqual`, integer-only
signed timestamps, asymmetric-only JWT algs, hash-only stored tokens) held; the defects were
in how the surrounding code *used* them. Three confirmed, all fixed fail-first:

- **An expired webhook signing key authenticated inbound deliveries forever.** The connector
  secret path (`unsealForConnector`) was a bare decrypt: unlike the session `exchange()`
  path it never checked `status`/`expiresAt`, so an `api_key` credential with an
  `expiresAt` bound to an active webhook kept validating correctly-signed public ingress
  after it lapsed — in the lazy window before the expiry sweep, and indefinitely afterwards
  (expiry does not disable the connector). One shared `isUsable` gate now backs both
  unseal paths, and the pipeline pre-checks it on the entity before decrypting and fails
  closed; `expiring` remains usable.
- **A 200 non-JSON or JSON-`null` upstream OIDC document sprayed 500s on the pre-auth
  login/callback paths.** `response.json()` sat outside the try, and a body of literal
  `null` dereferenced into a `TypeError` before the shape guard — so a captive/maintenance
  proxy answering 200 with HTML in front of the IdP turned a clean "identity unavailable /
  login refused" into an internal error. Discovery/JWKS now map any non-object document to
  `OIDC_METADATA_UNAVAILABLE` (503, like a network failure) and the token endpoint maps it to
  `OIDC_TOKEN_EXCHANGE_FAILED` (400); a null/empty JWKS denies and self-heals on key
  rotation rather than being cached as a pass.
- **Two credentials could collapse onto one sandbox environment key across owners.** The
  create-time collision guard was scoped to `(workspace, ownerType, ownerId)`, but a session
  materialises the version's pins *across* owners and types: two same-normalised
  `MA_CRED_*` credentials both created fine and, pinned together, one silently overwrote the
  other at delivery (a file cred `foo` vs an api_key `foo_file` even inverted the
  documented path/value contract, divergently between the two runtimes), both audited as
  delivered. A type-aware set-collision check (path form vs value form; `env_vars` occupies
  no `MA_CRED_` key) now runs at both admission points where the delivered set is known —
  version pin and session attach — and is re-validated against the live credential rows at
  both materialisation sinks (cold provision and bootstrap/rebind), so a later rename or
  reactivation cannot reopen it. Two adjacent holes closed with it: a rename used the
  owner-scoped guard and could move a pinned credential onto another owner's key, and a
  value rotation unconditionally reset status to `active`, silently **reactivating a revoked
  credential** — revocation is now terminal for rotation.

## An audit round on the model batch: provider, discovery, per-session choice, launcher

The batch that wired a real model provider (de52388..a95e719: OpenRouter with tool-call
forwarding, free-model discovery and registration, `PUT /v1/sessions/:id/model`, the
console's model view, and `scripts/start.sh`) shipped without review. Four adversarial
passes — the session/rebind path, discovery and pricing, the provider and completion
path, and the launcher/console/CLI — each refuted by default against the code, confirmed
about forty defects. Every fix is test-first; the end-to-end ones run the real platform
and a real agent-core process. The most consequential:

- **`--prod` handed the production server a public admin key.** The documented way to
  make the env file is to copy `.env.demo.example`, which sets
  `MA_BOOTSTRAP_TOKEN=demo-admin-token`; `--prod` loaded it, and on a fresh database that
  string — readable in the repository — became a permanent `ma:*` platform-admin key.
  `--prod` now takes only the model settings from that file, and bootstrap refuses the
  published token everywhere but the demo entry. The same launcher put the provider key
  and the admin token in argv, `source`d the env file as shell code after parsing flags
  (so a `HOST=0.0.0.0` line beat `--host 127.0.0.1`), and treated `-?` as a glob that
  swallowed pnpm's `--`; all closed, and `--dry-run` lets the tests drive the real script.
- **A model call could hang forever, holding the budget.** Nothing bounded a provider
  call, so an upstream that accepted and never answered pinned the completion: no error,
  so retry, breaker and failover never engaged, and the worst-case daily-budget
  reservation (released only on settle) stayed held — a few hung calls could exhaust a
  workspace's budget. Each call now races a deadline and its caller's request; agent-core
  had been dropping the turn's abort signal, so that half only worked once the signal
  reached `fetch()`. A timeout fails over rather than retrying in place, because three
  in-place attempts outlast the sandbox's own wait.
- **Changing a session's model could wedge it.** The bridge permits only the override (or
  the version's model) plus fallbacks, while the sandbox keeps asking for the model it
  bootstrapped with. A change requested mid-turn, a rebind that came back busy, or an
  override that stopped resolving moved the row without the sandbox, and every later
  completion was refused with 403. A change now lands only where it reaches the sandbox at
  once, a busy rebind is rolled back by a compare-and-set on the override itself, and a
  sandbox asking for its stale primary is served the current one.
- **A model switch erased the conversation and refilled the turn budget.** The in-place
  rebind rebuilt the runtime from the last periodic snapshot (every five turns), so the
  new model saw a truncated history and turn numbers restarted — toggling models extended
  a session's `maxTurnsPerSession` indefinitely. agent-core now checkpoints before a
  same-session rebind, and a snapshot upload names its session so a warm sandbox handed
  to the next session cannot file one conversation under another.
- **Paid spend the cost cap could not see.** "Free" was judged from prompt/completion
  prices alone, so per-request, image, reasoning and cache fees passed, and two
  zero-priced previews bill per song; `MA_OPENROUTER_ALLOW_PAID` catalogued paid models at
  $0; the demo entry catalogued any `--model` at $0 with no check; and a database kept the
  paid rows after the flag was turned off. Free now means a `:free` variant priced at zero
  in every field, paid models are priced from the provider at startup or left out, and
  free-only startup disables leftover paid rows.
- **The provider's failures read as successes or as permanent errors.** OpenRouter reports
  a failure after generation started as HTTP 200 with `error.code`, which was classified
  by the 200 as non-retryable; an empty `choices`, an errored choice or
  `finish_reason: "error"` became the turn's final answer; a connection refused escaped as
  a plain `Error`. One over-long tool name or id from a model failed every later request
  of the session, because the harness replays it and the bridge rejects it; ids that
  models number from `call_0` on every answer collided across turns.

Smaller confirmed defects: registration ignored narrowed API-key scopes and overwrote an
operator's `enabled` / allowlist / security level; neither registration nor a model change
was audited; tools were sent to models catalogued as unable to call them; the catalogue's
compaction point was never applied, so a long session overran a small window; a
reservation straddling UTC midnight was released against the wrong day; the reservation
ignored tool definitions and undercounted CJK text; `nullable()` emitted an OpenAPI 3.0
keyword into a 3.1 document, so the published contract forbade the `null` that clears an
override; `model.completed` named the model that failed rather than the fallback that
answered; and in the console a stale picker rolled back a change made elsewhere, a click
could change a different session, and the Change button outlived the session. One finding
was closed only after the round: a hot upgrade and a model change could rebind one session at
once, and when the upgrade lost agent-core's single rebind slot to a model change that had
already bootstrapped the new version, its rollback left the row on the old version and the
sandbox on the new one until the next idle sweep. The two now take a per-session rebind claim
in the store (so it holds across replicas, and expires if a holder dies); the loser waits for
the next sweep, or answers a model change with a 409 to retry. The CLI
printed provider-controlled model names and agent text to the terminal unescaped, so an
escape sequence in a model name was a terminal command; human-readable output now shows
control characters as visible `\xNN`.

The pattern is the earlier rounds' in a new place: each feature worked on the path its
author drove, and the defects sat on the paths a second actor creates — a concurrent turn,
a previous run's catalogue, a model numbering its own ids, a copied example file.

## A feature round: delivering in parallel without crossing replies

Connector deliveries drained one at a time, and two earlier rounds wrote down why: the reply
listener armed on "the first `turn.started` after subscribing", which is only this delivery's
turn if nothing else submits to the session meanwhile. Closing that needed a per-submission
turn token, so that is what this round built. A submission now has a name (`submissionId`,
generated by `submit` or chosen by the caller, `^[A-Za-z0-9_-]{1,64}$` because it lands in
events and environments). The control plane passes it to the sandbox with the prompt;
agent-core echoes it on the `turn.started` of the turn it runs; a command runtime gets it as
`MA_SUBMISSION_ID` and is asked to do the same (the reference runtime does). The reply listener
arms only on its own name. A runtime that predates the token names nothing, and for that case
the old rule still applies, safely, because of the next change.

With correlation keyed on identity, the drain runs `MA_DELIVERY_CONCURRENCY` workers (default
one, as before). Parallel across conversations is not enough on its own: two messages in one
chat thread delivered together could be answered out of order, the second would bounce off the
busy session as a retryable `SESSION_BUSY`, and on a brand-new scope both could create sessions
and split the thread. So a delivery whose conversation — its `reuse_per_scope` binding, or its
`reuse_connector` connector — already has one in flight in this process steps aside: the claim
is undone without spending an attempt, and the receipt comes back a second later, behind the
one ahead of it.

Two things surfaced on the way. First, in the real server, replies went nowhere: the hook and
chat adapters were registered without a transport, so the pipeline waited for each turn and
then dropped the answer, and this table's Chat bot row claimed otherwise. A hook callback
transport now ships, off until `MA_HOOK_CALLBACK_ORIGINS` lists where it may go, because the
callback URL is the hook caller's choice: only listed origins are reached, a redirect is not
followed, and the body is signed with the connector's secret as inbound hooks are. A chat send
API is platform-specific and still does not ship; the row now says so. Second, the drain's
batch size and the scheduler's restart precondition were written for a single worker, and are
now stated for many.

Tests: an engine test for the name being generated, honoured and validated; agent-core and
command-runtime tests against real processes that the name comes back on `turn.started`; a
pipeline test where another submission's entire turn runs first on the same session (the old
listener posted that turn's answer); per-conversation ordering with the attempt count checked;
the drain overlapping with three workers and staying serial with one; the callback transport's
allow-list, redirect and signature. A real-process e2e runs the server with the local driver,
real agent-core sandboxes, a slow stand-in model and a callback receiver: three hooks to
different conversations are in flight at the model together and each answer reaches its own
callback in one model-delay; two hooks to one conversation run on one session, the second
starting only after the first was answered, with distinct submission ids. Run with one worker,
the same e2e sees one call in flight and takes three times as long.

## A feature round: resubmitting a cut-off turn, and the turn the row never saw start

A sandbox lost mid-turn recovers onto a new sandbox, but by design its prompt was not sent
again: the cut-off turn may already have run tools with side effects, and the caller was
left to decide. That stays the default. A version can now set `resubmitInterruptedTurn`:
the recovery records the prompt on the session (`pendingResubmit`, a column so a restart in
between does not drop it), and a scheduler pass right after provisioning sends it once the
session has a sandbox. It goes out once per prompt — sent under a `submissionId` of its own,
so an interruption of the resubmitted turn is recognised by identity and not sent a third
time; a turn that ends after it (compared by log seq, not time — the cut-off turn's closing
event can share the resubmission's millisecond) means a later interruption is a new prompt.
It is claimed by compare-and-set so two workers send it once, goes back to the queue if the
sandbox refuses it, and is dropped if someone submits to the session first.

Building the real-process test exposed a gap in the recovery itself. The test kills
agent-core mid-turn, as an eviction would; the session recovered, but no `turn.failed` was
written and nothing was resubmitted, because the row still said `ready`. agent-core reports
events in batches, and the kill took the unsent `turn.started` with it, so the control plane
never moved the session to `running`. The log did know: the control plane records the prompt
once the sandbox accepts it. A turn now counts as interrupted when the row says `running` or
the log holds an accepted prompt with no turn ending after it — which also gives agents that
do not opt in the honest `turn.failed` they were missing in exactly this case.

Tests cover queueing and sending once, not sending a third time, a later prompt being
resubmitted on its own, an explicit submission winning, a refused send returning to the
queue, two concurrent sweeps sending once, a runtime that names no submission, and the turn
whose `turn.started` never arrived — each guard with a mutation that turns its test red. The
real-process e2e runs the server with the local driver and a two-second lease, holds the
first model call open, SIGKILLs the sandbox's agent-core, and sees the session come back on
a new sandbox, the same prompt resubmitted under a new submission id, and the turn answered.

## A feature round: holding the local driver to an egress policy

The local driver shares the host's network, so a restricted policy ran open with a warning —
a deliberate default, since the out-of-the-box dev flow runs on it. It still does by default;
`MA_LOCAL_EGRESS=enforce` now holds the policy. The whole child cannot be fenced without
cutting agent-core off from the control plane, and agent-core is platform code anyway; what
must be held is everything it starts for the agent. So the driver passes the policy to
agent-core as `MA_EGRESS_CONFINE`, and every such subprocess — shell and skill tools, MCP
stdio servers, setup commands, a command runtime — starts through one `confineCommand`. On
macOS that is `sandbox-exec` with a profile that denies all networking except outbound to
the control plane's loopback port (and the proxy's, for an allowlist): measured, a confined
`curl` reaches that port and no other, not even another loopback one, and cannot resolve a
name. On Linux it is `unshare --net --map-root-user`, which reaches nothing on the host, so an
allowlist (which needs the proxy) and a command runtime (which needs the control plane) are
refused there. agent-core's one in-process path out on the agent's behalf, an MCP server
over HTTP, is held to loopback under the same flag. Whatever a host cannot hold is refused
with `SANDBOX_EGRESS_UNENFORCEABLE`, naming the fix.

Two defects surfaced. Tools start from a minimal environment, and the proxy variables a
driver sets on agent-core never reached them — so on the container driver an allowlisted
agent's shell tool had no proxy, and its only way out was closed; they are now passed on
(the runtime token still is not). And the broker classified every provisioning failure from
the words in its message, so a driver's own classified refusal was re-coded — the egress
refusal surfaced as `SANDBOX_STARTUP_FAILED`, and one that happened to mention a "limit"
would have become a *retryable* quota error. A driver's `MaError` now keeps its code.

The confinement is tested against the real mechanism where the host has it: Seatbelt on
macOS, and a network namespace in a Linux container. The real-process e2e (server with
`MA_LOCAL_EGRESS=enforce`, a stand-in model that has the agent fetch a service on this host,
then report what came back) passes in all three environments it can meet: on macOS the
default-policy agent's fetch fails with curl's "could not connect" while its turn completes
and an `allow` agent's succeeds; the same in a Linux container where namespaces are allowed;
and where they are not (Ubuntu 24.04's AppArmor restriction, which the Colima VM has), the
restricted agent is refused with that code instead of running open.

## A feature round: the egress proxy, and proof that NetworkPolicy holds

Two pieces of the network boundary were left to the operator: the filtering proxy and
a CNI that enforces NetworkPolicy. Both had the same weakness — the platform could not
tell whether they did their job. A generic proxy applies one allowlist to every sandbox
behind it, so per-sandbox allowlists held only as far as someone configured them; and an
API server accepts NetworkPolicies whether or not anything enforces them, so on a plugin
that does not implement policies every `deny` sandbox had the open network while the
platform reported it fenced.

**The proxy.** `apps/egress-proxy` knows which sandbox is asking. The control plane signs a
grant per allowlisted sandbox (id, hosts, expiry) with a secret it shares with the proxy
and puts it in the sandbox's proxy URL, so every HTTP client presents it; the proxy checks
signature, expiry and owner, then the host, then resolves the name itself and refuses
private, loopback, link-local and metadata addresses before connecting to the address it
checked. Node built-ins only; the image is two files. Its tests found that a client
resetting a refused CONNECT threw out of the process — in production, one curl would have
dropped every sandbox's tunnels — and a Docker e2e runs the image in the real topology.

**The probe.** Before its first restricted pod the k8s driver runs an experiment: a target
pod, a control pod that must reach it, and a pod under a deny-all-egress policy that must
not. The first design aimed at the API server's Service and was wrong: on k3s it is
DNAT'd to the node, and iptables-based policy engines exempt traffic to the node, so a
fenced pod reached it on a cluster that enforces policies. Pod-to-pod traffic is what every
implementation must filter. Measuring that showed the second subtlety: kube-router programs
a new pod's rules about a second after the pod starts, so the first connection got out —
the fenced pod now lets its fence settle before testing. The verdict is cached; anything but
`enforced` refuses restricted pods with `SANDBOX_NETWORK_POLICY_UNENFORCED`, including an
inconclusive run (an image that will not pull), because a fence nobody has seen hold is not
a fence. The Kubernetes client also had a latent defect on the way: it read the cluster CA
and then called `fetch`, which cannot take one, so on a real cluster every API call would
have failed TLS; it now uses `node:https` with the CA.

**Manifests and images.** `deploy/k8s` (namespace, a Role limited to what the driver calls,
control plane, egress proxy with a policy admitting only sandbox pods, a ConfigMap for the
per-cluster CIDRs) and `deploy/Dockerfile` (server and runtime targets).

The k3s e2e starts two real clusters in Docker — one as k3s ships, one with
`--disable-network-policy` — and drives them through the driver's own client, as the
ServiceAccount from the manifests: the probe finds the first enforcing and catches the
second; the driver refuses a restricted sandbox on the second and leaves nothing behind;
every manifest is accepted by a real API server (server-side dry run); and the proxy
deploys from its manifest and image and becomes ready. It runs, with the proxy image e2e,
in a `docker-e2e` CI job.

## A feature round: reading SQS and Kafka without a client library

The event feed was push-only, and the row above said why: a pull consumer needs a broker
client, which the zero-dependency design does not take on. Both clients turned out to be
small enough to own. SQS is an HTTPS JSON protocol plus a SigV4 signature. Kafka is a binary
protocol — framing, nine request types, record batches, CRC-32C, four codecs and SASL — but
a consumer needs only a fixed subset of it, and pinning the versions the Kafka 2.1 client
sent keeps every encoding free of tagged fields while working from 2.1 through 4.x, since
4.0 dropped exactly the versions older than that.

**What a delivery means.** A pulled message goes through the same `enqueue` as an inbound
request and is acknowledged — deleted, or its offset committed — only once its receipt
exists. A crash in between is a re-read, and the receipt's dedupe on the message's identity
makes it a duplicate rather than a second run. The identity is the event's own id when there
is one (CloudEvents and EventBridge, scoped by source), so a producer's retry or a bus's
double delivery is also one delivery; otherwise the SQS message id, or the Kafka record's
topic, partition, offset *and timestamp* — without the timestamp, a topic deleted and
recreated would have its first records taken for ones delivered before. The same dedupe is
what lets the Kafka consumer skip the group protocol: it commits as a consumer with an
explicit assignment does, two replicas both read everything, and the second copy costs a
read, not a run.

**Backpressure.** Pull is the one shape where the platform can say "not yet". A connector
stops reading while `maxInFlight` of its deliveries are pending; the backlog stays in the
broker, durable and visible there, instead of being copied into receipts that each start
an agent. The SQS e2e samples it live: at most one delivery in flight with `maxInFlight: 1`,
and the rest still on the queue meanwhile; without the check it saw four.

**Where it may connect.** The address is a workspace admin's, so it is checked against an
operator's list (`MA_SQS_ENDPOINTS`, `MA_KAFKA_BROKERS`), at activation and again on every
connect — editing an active connector does not re-run activation. For Kafka the check covers
every broker the cluster *advertises*, since those are where the consumer actually connects;
a bootstrap name on the list does not admit whatever its metadata names.

**What the real brokers showed.** The Kafka client read all five codecs the Java producer
writes on its first run against Kafka 4.1, including xerial-framed snappy and the LZ4 frame
format, both decoded here. Two things only a live cluster produced: a fresh cluster answers
the first `FindCoordinator` with `COORDINATOR_NOT_AVAILABLE` while it creates
`__consumer_offsets`, which the consumer reports and retries rather than treating as fatal;
and ElasticMQ hands back queue URLs under its own address rather than the mapped one. One
defect turned up beside the feature, in the push subscription: its template was filled one
placeholder at a time, so an event whose data contained `{{source}}` had that text replaced
— a producer could rewrite the prompt around its own content. Both paths now fill templates
in one pass.

**Verification.** The signature is pinned to AWS's published SigV4 examples and SCRAM to
RFC 7677's exchange, because the emulators check neither. The consumers' failure paths —
an offset that fell off the log, a leader move, a group owned by protocol members, an
advertised broker off the list, a broker without a needed version — run against a fake
broker; aborted transactions and control batches against batches built byte by byte. The
e2e runs a real server against ElasticMQ, Kafka 4.1 over plaintext and Kafka 3.9 behind
SASL: filtering, duplicates, SNS-wrapped EventBridge events, FIFO groups and record keys as
conversations, `startFrom`, a restart that re-reads nothing, a wrong password shown on the
connector (and in neither the error nor the log) until the credential is swapped, missing
queues and topics, and the allowlists. A mutation pass broke 39 behaviours one at a time;
the one the tests first let through — committing what was fetched rather than what was
handed out, so a crash would skip records already decoded — now has its own test.

What the consumers do not do: Kafka does not join group rebalancing, so N replicas read N
times. (SQS took static keys only when this round landed; the platform's own AWS identity
and assumed roles came later — see "What was left optional".)


## An audit round on the new features, and what a status check turned up

A status check of the repository found four things wrong with shipped behaviour:

- **The agent got the receipt's summary, not the prompt.** Every delivery sent
  `payloadSummary`, capped at 4,000 characters for listings, so a longer schedule
  prompt, hook body, event or queue message reached the agent cut short with no sign of
  it — while run-now delivered the same schedule's prompt whole. A receipt now keeps the
  prompt it sends (up to 100,000 characters, past which the cut is marked), and a retry
  resends it without its replay note.
- **The console opened a session on its oldest 500 events,** so a long finished
  session's answer and terminal event were out of reach except through search. It opens
  on the newest page and pages back on request without moving what is being read.
- **Kafka lost a connection every SASL session lifetime** on a broker that expires
  sessions (`connections.max.reauth.ms`, as managed clusters set). The consumer now
  replaces a connection before its session lapses, while nothing is in flight on it, and
  replaces one the broker closed while idle. The e2e reads across three 15-second
  session lifetimes without an error.
- The README's status still listed the egress proxy and NetworkPolicy enforcement as
  unbuilt.

Then independent adversarial audits of the round's features, every report refuted by
default and each confirmed defect fixed with a test that fails against the previous code.

**SQS and Kafka consumers — nine defects.** A topic listed with no partitions stalled the
whole process (the read loop never yielded, so HTTP and every other connector stopped); a
partition added before a restart lost its records under `startFrom: latest`; a fetch
whose batches end before its position was refetched forever; `maxInFlight` did not bound
memory (870 MB for one 2.7 MB fetch; records are now decoded as they are handed out, 14
MB); one workspace's connectors could fill the 200-connector work list on every replica
(now round-robin, with `PULL_OVER_CAPACITY` on any left out); SASL PLAIN sent the
password readable by default; two CloudEvents from different sources could share a
dedupe key; SCRAM's key stretching blocked the event loop; and every message key left an
unused binding under policies that keep no conversation.

**Parallel delivery — thirteen defects.**

- *A sub-agent ended the wait for the parent's answer.* A child's turn events were
  forwarded as the session's own, numbered from 1: they ended a connector's reply wait,
  so the callback carried the child's working notes (reproduced end to end with a real
  agent-core); they flipped the session idle mid-turn; and they moved the turn the
  session's model calls are billed under. A child's turn lifecycle now stays with the
  child, the reply wait ignores a child's messages, and a turn's end names its
  submission, so the wait settles only on its own.
- *What a failed or timed-out turn had said so far was sent as its answer.* The reply is
  now the answer, or `TURN_FAILED` / `REPLY_TIMEOUT`.
- *A busy session failed deliveries.* A sandbox refuses a submit while a turn runs
  (`SESSION_BUSY`, retryable), five retries could not outlast a turn, and the event was
  failed for good. Waiting for the session's turn, like waiting for the conversation,
  now costs no attempt.
- *Order held in one process only.* A delivery now also waits while an earlier event of
  its conversation is still open — read from the store, in arrival order, ties broken by
  insertion because an id is random within its millisecond — and while its session is
  mid-turn.
- *Workers.* Deliveries ran in passes of ten that waited for their slowest, so one
  turn-long reply wait idled every other worker; a handed-back delivery used up a slot
  of the pass and counted as processed; a failed delivery let the pass return while its
  siblings ran on, unwatched, beside the next pass's; and a stopping scheduler kept
  claiming. Now `MA_DELIVERY_CONCURRENCY` long-lived workers deliver, outlive their own
  failures and look for `stop` before every claim; a store error before a run hands the
  delivery back instead of leaving it to be reaped as abandoned.
- *No transport, still waiting.* With no chat `send` and no `MA_HOOK_CALLBACK_ORIGINS`
  (the default), chat and hook adapters still offered `respond`, so a worker waited out
  every turn for a reply it then dropped.
- *Callbacks.* A callback was signed exactly as an inbound hook is, so anyone who saw one
  could post it back and it verified as the caller's own request; it is now signed over
  `callback.<timestamp>.<body>`. A connector whose secret was unusable sent its callback
  unsigned; it now sends none. A callback URL carrying credentials surfaced them through
  the fetch error's text, and a `blob:` URL passed the origin check; both are refused up
  front, and a fetch error is described rather than quoted. `MA_HOOK_CALLBACK_ORIGINS`
  and `MA_SQS_ENDPOINTS` refused `HTTPS://Host:443` as if it had a path and echoed an
  entry's credentials; entries are now normalized as `URL` does, credentials masked.

Forty-four mutations of these fixes each turn a test red. The audit's twenty-one
reproductions, rerun against this code, all show the fixed behaviour — the sub-agent one
end to end, its callback now carrying the parent's answer.

Two more reviews read the round's features against their documentation and ran them,
on real clusters where it mattered.

**The egress proxy and the drivers — two high, six medium, and smaller findings.**

- *The documented Kubernetes fence matched nothing.* `deploy/k8s` and the manual named
  Service ClusterIPs as the control plane's, the proxy's and DNS's `ipBlock`s; a
  NetworkPolicy is enforced after the Service address is translated, so on k3s a
  restricted sandbox could reach neither its control plane nor DNS. Peers are now named
  by pod label (`MA_CONTROL_PLANE_PODS`, `MA_EGRESS_PROXY_PODS`), for egress and for the
  agent port's ingress, whose shipped placeholder had admitted every pod; a new k3s e2e
  provisions a restricted sandbox through the real driver and checks what it can and
  cannot reach, and who can reach it.
- *One request could take the proxy down for every tenant:* a bad percent-escape in the
  proxy username (no grant needed; both replicas restarted on k3s), or an allowlisted
  upstream answering with a status outside 100–999. Both are answered now, and the
  request paths can no longer throw out of the process.
- A tunnel to a dead upstream closed without a word or a log line; a plain forward kept
  its upstream for two minutes after its client left; an allowlist past about 200 hosts
  hit Node's 16 KiB header limit (now 256 KiB, with `allowedHosts` capped at 256 so the
  proxy URL stays under Linux's 128 KiB environment-variable limit); NAT64,
  IPv4-compatible and 6to4 forms of the metadata address got through; the client's
  `Host` was forwarded; the grant sat in the Pod spec; `NO_PROXY` held only `host:port`,
  which curl ignores; the Role granted two verbs the driver never uses; the local
  driver signed no grants; a confined MCP client followed redirects off the host; and a
  Linux command runtime's refusal lost its code.

**Prewarm, resubmission and search — fourteen findings.**

- *One agent's warm pool could lock its whole workspace out:* idle warm sandboxes
  counted against `maxSandboxes` at admission, so no session of any agent was admitted
  while they stood. Admission counts held sandboxes, and a session that needs a sandbox
  of its own gives a warm one back, so the limit still holds.
- *A filtered search, or a filtered read, could stall the server:* `LIMIT` counted rows
  that passed the filter, so one step read the whole session (four seconds of `/health`
  waiting at a million events). Steps now read a window of events and judge filters per
  row.
- Only the last message of an interrupted multi-message submission was resubmitted; a
  user's submission that got in during a resubmission did not cancel it; an expired
  session was resubmitted before it was expired; the prompt outlived retention on the
  row; and a turn that had just finished could be resubmitted.
- The sweep never reached agents past the first 50; warm sandboxes outlived their
  declaration (lowered depth, archived agent, rotated credentials) for a day — now a
  lowered depth applies at the sweep's next pass and an undeclared pool loses its
  protection within ten minutes; two replicas filled a pool to twice its depth;
  migration 23's backfill differed from new writes; and a query with a newline matched
  across two values.
- Rerunning the review's race against the first fix showed it held only where the
  user's message reached the log before the refused resubmission looked; an accepted
  submission now clears a resubmission that is on its way as well as one still queued.

Fifty-nine mutations of these fixes are caught — one more survives as equivalent (Node's
`BlockList` already judges an IPv4-mapped address by its IPv4 rules) — and the reviewers'
own reproductions, pointed at this code, show the fixed behaviour.


## A feature round: what was left optional

With the review rounds closed, four things were still listed as optional. This round does
them.

**A locked database is a retryable error.** SQLite allows one writer; past the busy
timeout another writer's lock surfaced as an opaque `500`, and a delivery that hit it
was failed as if the agent had refused it. Every statement and transaction boundary now
turns `SQLITE_BUSY` / `SQLITE_LOCKED` (extended codes included) into `STORE_BUSY` —
`unavailable`, retryable, `503` with `Retry-After: 1` — which the delivery pipeline
already retries. A test holds a real write lock from a second connection and checks the
statement, the transaction and the explicit `begin` each give way with nothing written.

**SQS without access keys.** An SQS connector's `config.auth` may be `assume-role` (the
platform assumes the customer's `roleArn`, passing the workspace's id as the external id,
and reads with the session) or `platform-identity` (the platform's own identity as it
is). Both are off until an operator sets `MA_SQS_AWS_IDENTITY`, since both lend the
control plane's identity to a tenant; `platform-identity` needs `direct`, because every
workspace would share what it may read. The identity is found where the AWS SDKs look —
environment keys, a web identity token (IRSA), the container endpoint (ECS, EKS Pod
Identity), the EC2 instance role over IMDSv2 — with no SDK: each is one or two HTTP calls,
and `AssumeRole` is SigV4 with service `sts`. Credentials are renewed five minutes before
they expire, one fetch at a time; a renewal that fails keeps credentials that have not yet
expired; a session SQS calls expired is dropped, and STS calling the platform's *own*
credentials expired drops those rather than blaming the role. The tests run the whole
chain against fake STS, IMDS and container endpoints, and the ElasticMQ e2e reads with
credentials the real server fetched from a container endpoint for itself. Thirty-seven
mutations of the identity code, its schema and its gating, and three of the server's
wiring, are each caught; the one that first survived — an access key id without its
secret taken as an identity — now has its own test.

**Slack and Feishu, built in.** A chat connector's `config.platform` may be `slack` or
`feishu`, and the platform's event subscription then points straight at the ingress URL:
Slack's v0 signature (five minutes either way), Feishu's AES-encrypted events and their
signature, both platforms' URL checks, the bot's own messages ignored, and a mention that
Slack sends twice — as a message and as a mention — delivered once. The answer goes out
through `chat.postMessage` or Feishu's reply API, in the thread it came from, cut into
several messages at line breaks when long, a rate limit waited out once. Each needs two
secrets, so the connector's one credential holds a JSON object of them, checked at
activation. Feishu's tenant tokens are cached by app id *and* secret: by app id alone,
another workspace naming the same app with a wrong secret could forge events to its own
endpoint and have its agent post with this one's token. A reply the platform refuses —
the bot not in the channel, a missing scope — now shows on the connector, for every
connector that replies, and clears when a reply goes through; it was in the log and
nowhere else. `MA_SLACK_API_URL` / `MA_FEISHU_API_URL` / `MA_LARK_API_URL` reach GovSlack
or a private Feishu deployment. A real server answers a Slack mention and a Feishu message
end to end against fake APIs; forty-six mutations of the platform code and five of the
server's wiring are each caught.

**Postgres.** `MA_DATABASE=postgres://…` runs the same repositories and the same
migrations — ids and checksums unchanged — on a Postgres server, so replicas share one
database. There is no client library: the store speaks the wire protocol itself (TLS by
SSLRequest, refusing bytes that arrive before encryption; SCRAM-SHA-256 with the server's
signature checked, or MD5; cleartext only over TLS). The repositories' calls are
synchronous — that is what keeps a transaction's callback from interleaving with other
work — so the connection lives in a worker thread and each call blocks on it, as
SQLite's calls block. A translator handles where the SQL differs (placeholders,
`IS ?`, the planner hint, insert-or-ignore, two-argument `MAX`, `instr`, `LIKE`'s case
folding, column types, text sorting byte by byte), three statements were rewritten in a
form both accept (an upsert's unqualified column, a `HAVING` on an alias, a unique
violation matched by message), and six `json_extract` calls say what they compare. The
store's invariants were written against SQLite's single writer, so writes stay
serialized across replicas: a transaction takes an advisory lock as it begins, a lone
write takes it for its own implicit transaction, and each statement inside a
transaction runs under a savepoint, because Postgres aborts a whole transaction on an
error that SQLite undoes statement by statement. A connection given up mid-transaction
refuses the rest of it rather than continuing on a new one, where the rest would commit
without the start. The test switch `MA_TEST_POSTGRES_URL` gives every in-memory store a
schema of its own on a server, and the whole suite passes there; CI runs it, and two
replicas on one database end to end, in the docker job. Forty-two mutations of the
driver are each caught, against a stand-in server that records every pipeline or
against a real one. Two found gaps: the store's functional checks of the sweep queries
sat in a block skipped on Postgres, so a broken JSON read there went unseen (they run
on both now); and `connect_timeout` bounded only the TCP connect, so a server that
stalled a TLS handshake or a login held the worker for good (it bounds the whole login
now).

## A feature round: running as several replicas

Postgres let replicas share one database, but three things still assumed one process, and
three more were left over. This round does all six.

**Live events cross replicas.** A sandbox reports to one replica. An SSE stream or a
connector's reply wait on another followed only its own process's bus, so it heard
nothing: the stream stayed open and silent, and the reply wait ran out its time. The bus
now watches each session that has a subscriber in its process, with the last sequence it
delivered; every `MA_EVENT_PEER_POLL_MS` (250 ms) one query asks the log for the newest
sequence of all of them, and a session that moved on is read from just past its mark.
What is published here and what is read from the log merge into one stream, in sequence
order with no gaps — an event past a gap waits until the gap is read — because the SSE
endpoint drops anything at or below the last sequence it sent, so an event out of order
would be lost rather than late. A Postgres end-to-end test streams a session from one
replica while its sandbox reports to the other; against the old bus it fails. Seventeen
mutations of the bus are each caught; the first run's survivors, events held during a
catch-up and never released when it ended, are what two of the tests are for.

**The knowledge index catches up.** Each replica's keyword index is in memory and was
built at startup only, so a document ingested, re-synced or deleted on one replica stayed
missing, or stale, on the others until they restarted. Every `MA_KNOWLEDGE_SYNC_MS` (15 s)
each replica now reads a one-row fingerprint of the documents table and, only when it
changed, walks the ready documents: each is indexed at the content its row names unless
this replica already holds that version, and a deleted one is evicted; one whose re-sync
failed keeps what this replica has. The content comes from the artifact root, which the
replicas therefore share. Sixteen mutations are each caught; a fingerprint without its
count survived until a test added a row that changes neither the sum nor the maximum.

**Pull connectors are split between replicas.** Every replica read every pull connector,
up to 200 for the whole deployment, so a second replica doubled the reads and raised
nothing. A connector is now leased to one replica at a time, by a compare-and-set upsert
in the database, renewed each scheduler tick for three; each replica records that it is
alive, counts the replicas seen within a lease, and reads its share of the first
200 × replicas connectors, giving back what is over. One that stops gives its leases back
and leaves the count at once; one that dies has its connectors taken when its leases lapse;
one that cannot renew stops reading rather than read beside the next holder. Thirty
mutations of the supervisor and the lease table are each caught. Writing those tests
turned up three defects in the first version: a connector was reported over capacity
while another replica had room for it and had not yet scanned, and the report stayed until
that replica's first read; a replica already full never gave a connector back to make room
for a new workspace's first, so "every workspace's first connector before any second" held
only at startup; and a consumer stopped while counting its in-flight deliveries polled
once more, which for Kafka held the stop up for a whole fetch wait.

**Kafka consumer groups.** The Kafka consumer read every partition and committed as a
groupless member, so two connectors on one group each read everything, their commits
overwrote each other's — after a restart the slower could start past records it never
read — and a group another application's consumers were in was refused only when a
commit bounced. It now joins the group through the classic protocol (JoinGroup,
SyncGroup, a heartbeat, LeaveGroup on close), at the versions the 2.1 Java client sent,
which Kafka 4 kept. The leader assigns each topic's partitions in ranges by member id.
A commit carries the generation that read the records; a rebalance waits for the batch
in hand to be committed, drops what is buffered and every fetch begun before it, and
fetches nothing until it is done. Closing leaves over a connection of its own when the
coordinator's is busy, since a broker answers one request per connection at a time and
holds a JoinGroup until the group settles. The assignor's name is its own, so Kafka
refuses to mix it with another application's consumers (`KAFKA_GROUP_IN_USE`); against
Kafka 4.1 that is checked with Kafka's own console consumer in the group. Two connectors
on one group split a topic there, each record read once, and when one is disabled the
other takes its partitions without reading anything twice. Writing the tests turned up
two more things: the leader's metadata request went over a leader's connection, where
it could wait out a fetch's long poll while the whole group waited for the assignment
(it goes over the coordinator's now), and a member handed a partition its metadata did
not have yet asked for a second rebalance of the whole group.

**Load tests, and what the first run found.** `pnpm load` starts a real server on the
local sandbox driver with a model that answers at once, and measures where a client
does: control-plane requests, sessions taking turns side by side, a burst of signed
webhooks through to each agent's reply, and one session's events fanned out to many
subscribers. A smoke profile runs in CI on every push and fails on any error or a p99
an order of magnitude past what a laptop measures. Its first run put thirty webhooks
over three conversations at 41 s, though each turn took about 35 ms: a delivery that
found its session mid-turn stepped aside for a fixed five seconds, one behind an earlier
event of its conversation for a second, and an idle delivery worker slept out a whole
scheduler tick (five seconds by default) before it looked for new work. Now the
pipeline tells idle workers in its process when a delivery comes due — accepted,
retried, or brought forward — a delivery waiting on a turn comes due when that turn's
`turn.completed` or `turn.failed` reaches the bus, and a delivery that finishes brings
its conversation's oldest waiting event forward in the store, so that works across
replicas. One in retry backoff keeps its backoff. The same burst takes 0.6 s, its
slowest delivery the first of a conversation waiting for its session to start, and the
looks stay as the fallback for news that does not arrive; fourteen mutations of the
change are each caught.

**A shorter CI.** The Docker job ran every container test in one process, about
fourteen minutes, nine of them the whole suite run again on Postgres. That run is now
spread over three runners (`MA_PG_SUITE_SHARD=k/3`, Node's test sharding, with the
replica tests in the first) beside a fourth that runs the brokers, the egress proxy
and the clusters, and the load test's smoke profile has a job of its own.


## A feature round: a person in the loop, and models beside OpenRouter

Two capabilities a deployment kept asking about were built, each end to end.

**A person approves a tool call.** The harness had an `approve` hook and nothing
plugged into it, so `prompt` mode — "a human should decide" — denied every call it
covered. Now the call waits for one. The sandbox asks the control plane over the
runtime bridge (`POST /runtime/v1/approvals`, then polls, each poll held at most 25 s),
which records an approval keyed by session and call, so asking again after a dropped
connection or a restart finds the same one. Whoever holds `session.approve` answers it
from the API, the SDK, the CLI or the console; the decision is a compare-and-set on a
pending row, so a second answer reads back as a 409 naming the first. Unattended
sessions, calls nobody decides in time, and calls whose turn, session or sandbox went
away are settled as denials on the record, by the sweep and lazily on every read.
Building it turned up five defects, each fixed test-first:

- **A local sandbox died with its control plane.** Its stdout and stderr were pipes to
  the control-plane process; once that crashed, the first line the sandbox logged —
  here, "asking again" — raised EPIPE, an uncaught exception, and the session ended
  instead of reconnecting. A log line that cannot be written is now dropped. The
  approval end-to-end test kills the control plane while a call waits and approves it
  after the restart; it failed until this was fixed.
- **The log showed the approval before the call it was about.** The sandbox batches
  its events, so `approval.requested` (written by the control plane at once) landed
  ahead of `tool.requested`, and the session still read `ready` while its turn waited.
  The sandbox now sends the turn's events before asking.
- **An approval could outlive the turn that asked.** A sandbox lost mid-wait takes the
  turn with it, but the approval stayed pending, and approving it ran nothing. An
  approval now records the sandbox that asked and is cancelled once the session runs
  on another.
- **A turn's end could cancel the next turn's call.** The end of a turn is reported in
  a batch that can arrive after the next turn has asked; cancelling "every pending call
  of the session" would deny that one. Only the ended turn's calls, and earlier ones,
  are cancelled.
- **The console's queue redrew itself every five seconds**, taking keyboard focus and
  any selection from someone reading a call's arguments; it now redraws only when what
  it shows changed. In a narrow window the header and the cards overflowed the page,
  and an approval line in the log took the card's style; both fixed, checked in a
  browser.

About sixty mutations across the service, the repository, the bridge, the harness, the
sandbox's approver and the console's routes were applied; three survived the first run.
A status filter applied after a lazy settle survived because the only test had settled
the row first; a recheck after subscribing survived a sweep that slid the decision
across forty microtask positions, and is now pinned by a store that shows the call
pending until the wait subscribes while the decision lands in between; a caller's abort
survived because the test's reason happened to be an `MaError`.

**Models beside OpenRouter.** Anthropic, Azure OpenAI, Bedrock and Vertex AI are wired
the way OpenRouter is — the server holds the credential, the sandbox never sees it —
behind one router keyed by catalogue id. The configuration names each model and its
price, because the daily cost cap reads catalogue prices and nothing else; an id two
providers both claim fails startup, and a model removed from the configuration is
retired rather than left serving under OpenRouter's name at the removed model's price.
Each provider is tested against a stand-in that refuses what the real service refuses:
Anthropic's alternation and `tool_result` placement and its rule that tool blocks need
tools declared, OpenAI's tool-message pairing, Converse's alternation, `toolConfig` and
blank-text rules with a SigV4 signature recomputed from the specification, and Gemini's
role names, function-response naming and schema subset behind a token endpoint that
verifies the service account's JWT. Through a real server and real sandboxes, a
tool-using turn completes on each provider and is billed at its catalogue price, a
version fails over from Anthropic to Gemini and back with Gemini's tool call in
Anthropic's history, and Bedrock failing on every call is skipped by the circuit
breaker without another request reaching it.


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
- **Revocable auth, body-bound webhooks.** The reference AK/SK scheme signs only the
  key and timestamps and has no revocation, so a captured header authorizes any request
  until it expires. We do not sign API requests at all — inbound calls carry a bearer
  token stored only as a salted hash, and the advantage is *revocation*: an offboarded
  principal's live keys are killed at once (SCIM `active:false`), so a leaked credential
  dies on the next request rather than living to its expiry. Inbound webhook signatures
  bind the body and timestamp (not method/path, which is moot for a fixed endpoint).
- **One session model.** No cloud/local fork, which there means every feature is
  built twice or declared unavailable on one side.
