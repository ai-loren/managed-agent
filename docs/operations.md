# Operations

How to run, configure and reason about a Managed-Agent deployment.

---

## Try it locally (one command)

To experience the platform — the web console and a working agent — in one step:

```bash
cp .env.demo.example .env.demo   # then add an OpenRouter key (optional)
pnpm demo
```

`pnpm demo` loads `.env.demo` (gitignored), starts the server, waits until it is
listening, opens the console in your browser, and prints the admin token to
paste in. It also seeds a **Demo** workspace with an **Assistant** agent, so the
console is not empty on first open — start a session on the agent and chat.

The agent's model comes from `MA_OPENROUTER_API_KEY` in `.env.demo`: with a key
it uses the free OpenRouter model named by `MA_OPENROUTER_MODEL` (default
`nex-agi/nex-n2.5-mini:free`); with no key it falls back to an offline echo
model, so the demo still runs. The demo uses an in-memory store, so a run leaves
nothing behind. This is the real server with a model provider and seed data
added — not a separate build.

### Wiring a real model in production

The **platform holds the model credential**; a sandbox and a tenant never see it.
The plain server entry (`pnpm dev` / `apps/server/src/main.ts`) wires whichever
provider the environment configures:

```bash
export MA_OPENROUTER_API_KEY=sk-or-v1-…
export MA_OPENROUTER_MODELS=vendor/model:free          # first is the default
# optional: MA_OPENROUTER_BASE_URL (any OpenAI-compatible endpoint),
#           MA_OPENROUTER_ALLOW_PAID=true (default is free-only),
#           MA_MODEL_TOOLS=false (a plain-chat model that rejects `tools`)
pnpm dev
```

On startup the configured ids are upserted into the model catalogue and the
provider is wired; the log line `model provider wired` confirms it. An agent
version pins a model by id (`spec.model.modelId`); a session may only use a model
its version declares. **Tool calling is forwarded** (OpenAI function-calling):
the harness's tools are advertised, an assistant's prior tool calls and their
results round-trip, and the model's requested tools run in the sandbox — so a
real model drives the full tool-use loop, not just chat.

An agent's tools default to `strict` with an empty allow-list, i.e. **no tools**.
To let an agent use tools, set its version's `tools` policy, e.g.
`"tools": { "mode": "auto" }` (or `allow` the specific tool names under
`strict`). Free models can be flaky with a large tool set; the gateway's retry +
failover absorbs transient `5xx` from the provider.

## Running it

The platform is one process. Node runs the TypeScript directly, so there is no
build artifact to produce or ship.

```bash
pnpm install
pnpm dev
```

On first start with an empty database it creates a bootstrap admin and prints the
token once, to stderr. Store it: there is no way to recover it, only to create
another principal from one that already works.

### Configuration

Everything is environment variables, read once at startup and validated
immediately — a misconfiguration is a refusal to start, not a failure on the
first request that happens to need the missing value.

| Variable | Default | Notes |
|---|---|---|
| `MA_HOST` | `127.0.0.1` | Bind address |
| `MA_PORT` | `8080` | |
| `MA_DATABASE` | `./data/managed-agent.db` | `:memory:` for an ephemeral run |
| `MA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MA_ENCRYPTION_KEYS` | — | `v1=<base64>,v2=<base64>`. **Required in production** |
| `MA_ENCRYPTION_KEY_VERSION` | last listed | Which key new writes use |
| `MA_CORS_ORIGINS` | none | Comma-separated; only these are echoed |
| `MA_CONTROL_PLANE_URL` | `http://127.0.0.1:$MA_PORT` | What a sandbox calls back on. Must be host/cluster-routable for a restricted-egress container/k8s sandbox (loopback is refused there) |
| `MA_SANDBOX_DRIVER` | `local` | `local` (process), `container`, or `k8s` |
| `MA_CONTAINER_BINARY` | `docker` | Also `podman` or `nerdctl` |
| `MA_EGRESS_PROXY` | (unset) | Filtering proxy that enforces an egress allowlist (container/k8s) |
| `MA_EGRESS_PROXY_CIDR` | (unset) | The proxy's CIDR, required for the k8s allowlist NetworkPolicy `to` scope |
| `MA_CONTROL_PLANE_CIDR` | (unset) | The control plane's routable CIDR (k8s); required for a restricted-egress pod's control-channel carve-out, else the pod is refused |
| `MA_DNS_CIDR` | (unset) | DNS resolver CIDR a restricted k8s pod may reach (else the kube-system namespace) |
| `MA_INTERNAL_NETWORK` | `ma-internal` | Egress-less container network joined when proxy-filtered |
| `MA_K8S_NAMESPACE` | `managed-agent` | Namespace for sandbox pods when the driver is `k8s` |
| `MA_SANDBOX_LEASE_SECONDS` | `120` | Missed heartbeats past this mean lost |
| `MA_SANDBOX_PREWARM` | `0` | Warm sandboxes per pool; costs idle capacity. **Leave at 0 for agents that use `env_vars`/`api_key`/`bearer_token` credentials** — a prewarmed sandbox boots with an empty environment and a rebind re-materialises only *file* credentials, so those agents would run without their secrets on a prewarmed sandbox |
| `MA_VOLUME_ROOT` | (unset) | Root for platform-managed named volumes; unset (or `:memory:`) disables mounts, so a spec declaring `sandbox.mounts` is **refused**. Each volume lives at `<root>/<workspaceId>/<name>` |
| `MA_SCHEDULER` | on | `off` to disable the periodic loop |
| `MA_SCHEDULER_TICK_MS` | `5000` | |
| `MA_AUDIT_RETENTION_DAYS` | `0` | `0` keeps the audit trail forever; a positive value prunes rows older than it |
| `MA_RATE_LIMIT` | `600` | Per-principal requests per window (the post-auth fairness tier) |
| `MA_RATE_WINDOW_MS` | `60000` | Window for the per-principal tier |
| `MA_RATE_LIMIT_IP` | `3000` | Per-IP requests per window (the pre-auth flood shield); coarser, since one address fronts many principals |
| `MA_RATE_WINDOW_IP_MS` | `60000` | Window for the per-IP tier |
| `MA_MODEL_RETRY_ATTEMPTS` | `3` | Total attempts (incl. the first) for a single model before the gateway fails over to the next declared model. `1` disables retry |
| `MA_MODEL_RETRY_BASE_MS` | `250` | Base backoff before the first retry; grows exponentially (×2), full-jittered |
| `MA_MODEL_RETRY_MAX_MS` | `2000` | Ceiling on the computed backoff, before jitter |
| `MA_MODEL_BREAKER_ENABLED` | `true` | Per-model circuit breaker. `false` disables it (every request dials even a down model) |
| `MA_MODEL_BREAKER_THRESHOLD` | `5` | Retryable failures within the window that trip a model's breaker open |
| `MA_MODEL_BREAKER_WINDOW_MS` | `30000` | Rolling window over which those failures are counted |
| `MA_MODEL_BREAKER_RESET_MS` | `30000` | How long a tripped breaker stays open before admitting one probe |
| `MA_OPENROUTER_API_KEY` | *(unset)* | Platform-held upstream model credential. Set it (with a model list) to wire a model provider; the key never reaches a sandbox. Unset leaves agents unable to run a model turn (`MODEL_GATEWAY_UNAVAILABLE`) |
| `MA_OPENROUTER_MODELS` | *(unset)* | Comma-separated catalogue ids, e.g. `vendor/a:free,vendor/b:free`. The first is the default. `MA_OPENROUTER_MODEL` (singular) is an alias |
| `MA_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL; point it at any compatible endpoint |
| `MA_OPENROUTER_ALLOW_PAID` | `false` | Free-only by default: a non-`:free` id is dropped with a warning unless this is `true` |
| `MA_MODEL_TOOLS` | `true` | Advertise the harness's tools to the model (OpenAI function-calling). `false` for a plain-chat model that rejects a `tools` field |
| `MA_TRUST_PROXY` | `false` | Set `true` **only** behind a proxy that rewrites `X-Forwarded-For` |
| `MA_ARTIFACT_ROOT` | `./data/artifacts` | Root for content-addressed blob storage. Context snapshots live under `<root>/snapshots` and knowledge-base document content under `<root>/documents`, each its own subtree so they never collide and retention never reclaims the wrong one. `:memory:` keeps all of it in the process (ephemeral — knowledge does not survive a restart) |
| `MA_ARTIFACT_MAX_MB` | `25` | Largest single artifact |
| `MA_ARTIFACT_RETENTION_DAYS` | `0` | `0` keeps artifacts until something deletes them |
| `MA_PREVIEW_ORIGIN` | (unset) | A separate origin to render artifacts from, e.g. `https://artifacts.example.com`. Unset disables preview |
| `MA_CONSOLE_ORIGIN` | (unset) | The console's origin, named in the preview CSP's `frame-ancestors` |
| `MA_OIDC_PROVIDERS` | (unset) | Comma-separated SSO provider slugs, e.g. `okta,google`. Unset disables SSO. Each slug `<S>` is configured by the `MA_OIDC_<S>_*` variables below |
| `MA_OIDC_<S>_ISSUER` | (required per provider) | The IdP's https issuer URL (loopback http allowed for a dev IdP) |
| `MA_OIDC_<S>_CLIENT_ID` | (required per provider) | OAuth client id registered with the IdP |
| `MA_OIDC_<S>_REDIRECT_URI` | (required per provider) | This platform's callback URL, `https://<console>/auth/v1/<S>/callback`, matching what the IdP has on file |
| `MA_OIDC_<S>_SECRET` / `_SECRET_FILE` | (required per provider) | The OAuth client secret, from the env or a file. No secret → the provider is refused, never run as a public client |
| `MA_OIDC_<S>_SCOPES` | `openid profile email` | Requested scopes; `openid` is always added |
| `MA_OIDC_<S>_ALLOWED_DOMAINS` | (unset) | Comma-separated email domains permitted to log in. Set this for a *shared* IdP (Google) or any account there could log in |
| `MA_OIDC_<S>_GROUP_MAP` | (unset) | `group:workspaceId:role;…` — grants workspace membership from IdP group claims, additively |
| `MA_OIDC_<S>_SUBJECT_CLAIM` / `_EMAIL_CLAIM` / `_NAME_CLAIM` / `_GROUPS_CLAIM` | `sub` / `email` / `name` / `groups` | Claim names, for an IdP that diverges from the OIDC standard (e.g. Azure AD groups) |
| `MA_OIDC_<S>_AUTO_CREATE` | `true` | Whether a first-seen user is provisioned a principal. `false` admits only already-known principals |
| `MA_OIDC_<S>_SESSION_TTL` | `28800` | Lifetime, in seconds, of the session token a login mints |
| `MA_OIDC_CONSOLE_REDIRECT` | (unset) | When set, the callback 302-redirects the browser here with the token in a URL fragment instead of returning JSON — for a browser console flow |
| `MA_SCIM_TOKEN` / `_FILE` | (unset) | Bearer token the IdP presents on `/scim/v2/*`. Unset disables SCIM. It can deactivate any provisioned user, so use a long random value |
| `MA_SCIM_PROVIDER` | (required with token) | The OIDC provider slug SCIM provisions under, so a provisioned user and a later login of the same person converge on one principal. Must be one of `MA_OIDC_PROVIDERS` |
| `MA_METRICS_TOKEN` / `_FILE` | (unset) | Bearer token a Prometheus scraper presents on `GET /metrics`. Unset disables the endpoint (404). A static secret, not a principal, so the scrape path never touches the principal database |

Without `MA_ENCRYPTION_KEYS` outside production the server generates an ephemeral
key and says so loudly. That is fine on a laptop and catastrophic anywhere else:
every stored credential becomes unreadable on restart.

### Key rotation

Append a new key and point the current version at it. Old keys must stay listed
or ciphertext sealed under them cannot be read.

```bash
MA_ENCRYPTION_KEYS="v1=<old>,v2=<new>" MA_ENCRYPTION_KEY_VERSION=v2
```

Existing credentials are re-sealed lazily as they are updated. To force it, update
each credential's value; there is deliberately no bulk re-encrypt, because it would
need every plaintext in memory at once.

---

## What to watch

### The four questions that matter

**Are sessions starting?** `session.ready` events, and the `provisionMs` on them.
A rising cold-start time usually means sandbox capacity, not a slow control plane.

**Are sessions finishing?** The ratio of `turn.completed` to `turn.failed`, and
sessions sitting in `provisioning` longer than a lease.

**Are triggers being delivered?** Receipt status counts. A rising `failed` count
is a broken integration; a rising `zombie` count is workers dying mid-delivery,
which is a different problem with a different fix.

**Is anything leaking?** Sandbox count against active session count. They should
track each other; a persistent gap means the reaper is not keeping up or a
release path is failing quietly.

### Reading the event log

Every session's history is queryable and replayable:

```bash
ma session events --session sn_… --limit 500
ma session events --session sn_… --types tool.,model.   # namespaces
```

"Which commands did this agent run" is `tool.requested` and `tool.completed`.
"Why was it refused" is `tool.denied`, which names the rule that decided.

### Scraping metrics

Set `MA_METRICS_TOKEN` (a long random secret; `_FILE` variant supported) to
enable `GET /metrics`, then point a Prometheus scraper at it with that token as a
static bearer:

```yaml
scrape_configs:
  - job_name: managed-agent
    authorization: { credentials: '<MA_METRICS_TOKEN>' }
    static_configs: [{ targets: ['managed-agent:8080'] }]
```

The exposition carries RED metrics — `http_requests_total`,
`http_request_errors_total`, and the `http_request_duration_seconds` histogram —
labelled by `method`, `status` and the route *template* (`/v1/agents/:id`), never
a concrete id, so a busy fleet does not blow up label cardinality; a request that
matched no route is bucketed as `<unmatched>`. Scrape-time gauges `ma_sessions`
and `ma_sandboxes` (by status) are queried from the store on each scrape, so they
are always current. The endpoint is its own token surface — a scraper needs no
API key and never touches the principal database — and returns 404 when no token
is set, so nothing is exposed by default.

Beyond HTTP, the exposition also carries: **model** metrics —
`ma_model_requests_total{model,outcome}`, `ma_model_tokens_total{model,kind}`
(input/output/cache), `ma_model_cost_micros_total{model}`, and the
`ma_model_duration_seconds{model}` latency histogram, so model spend and latency
are visible per model; **connector delivery** — `ma_receipts{status}` (a rising
`failed`/`zombie` count is the signal a connector or its target is broken);
and **scheduler throughput** — `ma_scheduler_ticks_total{kind}` (sessions
started, deliveries processed, zombies reaped, and so on). Model and connector
labels are bounded (a catalogued model id, a receipt status) — never a session,
workspace or receipt id.

Useful starting queries: request rate `rate(http_requests_total[5m])`, error
ratio `rate(http_request_errors_total[5m]) / rate(http_requests_total[5m])`, and
p95 latency `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`.

---

## Failure modes and what they mean

### A session stuck in `provisioning`

The broker could not place a sandbox. The reason is on the session row, not only
in logs:

```bash
ma session list --statuses provisioning,failed
```

`SANDBOX_QUOTA_EXCEEDED` and `SANDBOX_PLACEMENT_FAILED` are retryable — capacity
may free up. `SANDBOX_IMAGE_UNAVAILABLE` and `SANDBOX_SETUP_FAILED` are not: they
will fail identically until the agent version changes.

### A session that says `sandbox.lost`

The sandbox stopped heartbeating and the reaper confirmed it was gone. If the
session's logical lease had not expired it returns to `provisioning`; the fresh
sandbox fetches the session's last persisted context snapshot at bootstrap and
restores it, so the conversation continues rather than restarting — the user's
work is not lost, and a `session.resumed` event marks the handover. If the
snapshot is missing or corrupt the session still recovers, but starts with a
clean context. If the lease had expired, the session fails.

This is the recovery path working, not an error. A rising rate of it means
sandboxes are dying, which the driver's own logs will explain.

### Receipts piling up as `zombie`

A `working` receipt whose worker stopped reporting. We do not know whether the
work happened, which is why it gets its own state rather than being retried
blindly. Replay one deliberately:

```bash
# A replay creates a new receipt; the original stays on the record.
curl -X POST "$MA_URL/v1/receipts/rc_…/retry" -H "authorization: Bearer $MA_TOKEN"
```

A running delivery **renews its own lease** in the background for as long as it
is genuinely in flight, so a slow-but-healthy delivery (a cold sandbox start, a
long turn) is no longer mistaken for a dead worker — a `zombie` now means the
worker really stopped heartbeating or the delivery ran past its ceiling. So if
many appear at once, workers are being killed — usually memory, usually during
a deploy — or a downstream is wedged (a delivery that hangs past its renewal
ceiling is deliberately allowed to lapse to `zombie` rather than renew forever,
so it stays visible and retryable instead of pinning a worker silently).

### A schedule that did not fire

Three things stop a schedule, in order of likelihood:

1. It is not `active`. Check the status; a validation failure on activation leaves
   the reason on the row. A cron that is well-formed but names no real time — a day
   that does not exist (`0 0 30 2 *`), or a day-of-month a month never has — is
   disabled with `INVALID_SCHEDULE_CONFIG` rather than being left active and
   dormant. A legitimately-sparse but valid schedule (every leap-day `0 0 29 2 *`)
   is *not* disabled: the fire-time search looks a full leap cycle ahead, so it
   resolves the next Feb 29 even across the century non-leap gap. (It used to be
   worse in two ways: an unfireable cron re-fired a run every 60 seconds forever
   because a missing next-fire time defaulted to "retry soon"; and a short
   lookahead wrongly treated a distant-but-valid leap-day schedule as unfireable.)
2. It fired but was skipped, because the previous run was still going
   (`skipIfRunning`) or the tick arrived past its `misfireGraceSeconds`. Both are
   logged. A nightly report firing at noon after an outage is worse than not
   firing, which is why the default is to skip. `skipIfRunning` counts only *this
   schedule's own* runs, so an unrelated session on the same agent (a human chat,
   another connector) never causes a skip. Lateness is measured in whole minutes
   (cron has minute resolution), so `misfireGraceSeconds: 0` still fires an on-time
   occurrence — it means "no catch-up after a delay", not "fire only if the tick
   lands on the exact millisecond".
3. Its cron means something other than you think. Ask:

```bash
curl "$MA_URL/v1/connectors/cn_…/next-fire" -H "authorization: Bearer $MA_TOKEN"
```

Day-of-month and day-of-week are **ORed** when both are restricted, matching
historical cron: `0 0 1 * mon` means the 1st *and* every Monday.

### Retiring a connector: archive vs delete

Two ways to take a connector out of service, for two different intents.

- **Archive** (`POST /v1/connectors/:id/status` with `{"status":"archived"}`) is
  the reversible default. The connector stops receiving traffic but its
  configuration and its whole delivery history are kept, and `archived → draft`
  restores it. Use this to pause an integration, or when the history still matters
  (an audit, a postmortem). Archived connectors are hidden from the default list
  and shown with `?includeArchived=true`.
- **Delete** (`DELETE /v1/connectors/:id`) is irreversible and **admin-only**
  (`connector.delete`). It removes the connector along with its bindings and
  receipts — the delivery history goes with it — and frees its external key, so a
  new connector can reuse that key and any lingering inbound deliveries to the old
  one are rejected (`404`) immediately. Use it for a connector created in error,
  or when a tenant is offboarding and the history must not be retained. There is
  no undo; archive first if you are unsure.

### Quota refusals

A `429` carries a machine-readable dimension and an honest `Retry-After`.
Concurrency suggests ~30s because sessions end continuously; a daily token budget
points at the window rollover, because it will not free up sooner.

```bash
ma workspace quota --workspace ws_…
```

The daily token budget (`maxTokensPerDay`) is enforced **both** at session
admission *and* on every model completion, so a long-running session cannot burn
arbitrarily past the cap the way it could when the quota was only an admission
gate — a completion is refused (`429`, dimension `tokensPerDay`) once the
workspace is over budget for the current UTC day. The daily total is an exact
per-workspace counter (`usage_daily`), incremented in the same transaction as each
usage record, so the check is O(1) and the two gates always agree. It is a soft
cap by at most one in-flight call: a completion already running when the budget
tips over finishes, and the *next* is refused — hard-stopping mid-turn would
strand a partial turn and waste the tokens already spent. **On first deploy of
this counter, today's pre-existing usage reads as 0 until it re-accrues** (the
counter starts empty); the budget is exact from the next UTC day, or immediately
if you backfill `usage_daily` from session rows.

The daily **cost** budget (`maxCostMicrosPerDay`, in micro-dollars) is a separate,
independent ceiling enforced at the same two gates and backed by the same counter.
It exists because tokens do not bound money: with model failover across a
differently-priced catalogue, a workspace can stay under its token cap while a run
routes to an expensive model. A completion is refused (`429`, dimension
`costPerDay`) once the day's spend reaches the cap. **`0` means no cost cap** — the
default, so existing workspaces are unaffected; this is the opposite of
`maxTokensPerDay`, where `0` blocks all usage. The two caps are independent: a run
is refused the moment *either* is exhausted. Set it with
`PUT /v1/workspaces/:id/quota { "maxCostMicrosPerDay": … }`.

The knowledge-chunk budget (`maxKnowledgeChunks`, default `100_000`) bounds how many
BM25-indexed chunks a workspace may hold. Retrieval search is an in-process
`O(chunks)` synchronous scan on the shared control-plane event loop, so an unbounded
corpus slow-burns every tenant's latency, not just the owner's. It is enforced as
**ingestion admission**, not a synchronous refusal on the upload: a document upload
always returns `202`, and the cap is checked when the pipeline processes the
document — one that would push the workspace past the limit is recorded `failed`
with a non-retryable `QUOTA_EXCEEDED` error (visible on the document's status, so
poll it) and adds zero chunks, rather than a `429` on the POST. `0` blocks all
ingestion (like `maxTokensPerDay:0`, *not* like `maxCostMicrosPerDay:0` which means
unlimited). Deleting a document — `DELETE /v1/datasets/:datasetId/documents/:documentId`
— evicts its chunks and releases the quota it held (and decrements the dataset's
document/chunk counts). Set the limit with
`PUT /v1/workspaces/:id/quota { "maxKnowledgeChunks": … }`; lowering it below the
current usage does not evict already-indexed chunks, it only refuses further
ingestion until deletes bring the workspace back under the cap.

### Reading usage history

`GET /v1/workspaces/:id/usage?from=&to=` returns the per-day token and cost series
behind the budgets, plus a summed `total` — the operator's spend record and the
numbers behind a bill. `from`/`to` are `YYYY-MM-DD` (UTC) or epoch-ms and both
default to the last 30 days; a day with no usage is omitted (it is zero). The span
is bounded (≤ 366 days) and a malformed or reversed range is a `400`. It is
**admin-gated** (`usage.read`), not a viewer read, because spend is billing data —
the same bar as the audit trail. It is pure reporting: read-only, and it never
affects enforcement.

```bash
curl "$MA_URL/v1/workspaces/ws_…/usage?from=2026-09-01&to=2026-09-14" \
  -H "authorization: Bearer $MA_TOKEN"
```

### When a model provider is flaky

The gateway has three layers of defence against a failing provider, and they
compose in this order:

1. **Retry** absorbs a *transient* failure on the model the session asked for. A
   retryable error (a 503, a reset, a brief rate-limit — anything the provider
   marks retryable, or a `Retry-After`) is retried in place with exponential
   backoff and full jitter, up to `MA_MODEL_RETRY_ATTEMPTS` times, before anything
   else happens. Most blips clear here, on the *requested* model, so the agent
   keeps the model its version chose. Watch `ma_model_retries_total{model}` — a
   rising rate means a provider is degrading.
2. **Circuit breaker** handles a *sustained* outage so it stops costing every
   session its retry budget. Once a model records `MA_MODEL_BREAKER_THRESHOLD`
   retryable failures within `MA_MODEL_BREAKER_WINDOW_MS`, its breaker opens and
   subsequent requests skip it **instantly** — no retry, no provider call — for
   `MA_MODEL_BREAKER_RESET_MS`, then admit a single probe (success closes it,
   failure re-opens it). This also stops hammering a provider that is already
   struggling. Watch `ma_model_breaker_state{model}` (0 closed / 1 open / 2
   half-open) and `ma_model_breaker_skips_total{model}`. Per-model and in-process:
   a provider outage is global, and the state is cheap to re-learn after a restart.
3. **Failover** moves to the next model the version declared in `fallbackModelIds`
   — whether the current one exhausted its retries or was skipped by an open
   breaker — and so on down the chain. Watch `ma_model_failover_total{from,to}`.

So a transient blip stays on the requested model (retry), a sustained outage is
skipped without cost (breaker) and the request lands on a fallback (failover), and
only an exhausted chain fails the turn.

A non-retryable error (a bad request, no access, an unknown model) is none of the
above: it is the caller's answer, surfaced at once, and it never trips the breaker.
Retry is bounded and short by default so it never threatens the turn deadline; set
`MA_MODEL_RETRY_ATTEMPTS=1` to disable retry, `MA_MODEL_BREAKER_ENABLED=false` to
disable the breaker.

All three key off `MaError.retryable`, so they only engage for a provider adapter
that maps its transient failures (a 429/503, a reset) to a retryable `MaError`
(category `unavailable`/`timeout`/`quota`). A provider that throws an
undifferentiated error is treated as non-retryable — safe, but it means the
resilience layers only help once the provider adapter classifies its errors. The
shipped OpenRouter adapter does not yet do this granular mapping; a deployment that
wants them to engage should ensure its provider raises retryable `MaError`s. (An
oversized `Retry-After` from a provider is clamped to `MA_MODEL_RETRY_MAX_MS` so it
cannot park a turn.)

---

## Routine operations

### Granting access to one resource

Beyond a workspace-wide role, a principal can be given a role on a *single*
resource — the least-privilege case the role model alone cannot express (a
contractor who should be `developer` on one agent and nothing else). The grant
*raises* their effective role for that one resource and never touches any other,
so it is safe to hand out narrowly.

```bash
# Grant developer on one agent (needs workspace.members.update — i.e. admin).
curl -X POST "$MA_URL/v1/workspaces/ws_…/grants" \
  -H "authorization: Bearer $MA_TOKEN" -H 'content-type: application/json' \
  -d '{"principalId":"pr_…","resourceKind":"agent","resourceId":"ag_…","role":"developer"}'

# See who has been granted what, and revoke.
curl "$MA_URL/v1/workspaces/ws_…/grants" -H "authorization: Bearer $MA_TOKEN"
curl -X DELETE "$MA_URL/v1/workspaces/ws_…/grants/rg_…" -H "authorization: Bearer $MA_TOKEN"
```

A grant is resolved against the workspace in the request path, so `resourceId`
must name a resource in *that* workspace; a grant recorded for an id in another
workspace (or a mistyped id) is inert — it simply never matches, rather than
leaking access. Grants only ever add power: a principal's effective role for a
resource is the higher of their workspace role and any grant, so a grant cannot
be used to *reduce* someone's access, and revoking one drops access on the next
request. Granting, listing and revoking are all gated at the same bar as
changing membership and written to the audit trail.

### Editing members safely under concurrency (If-Match)

`PUT /v1/workspaces/{id}/members` replaces the whole member list. Two admins (or an
admin and the SSO reconcile) editing at once can lose an update: the second write is
computed from a list read *before* the first landed, so a member the first added is
silently dropped. To make an edit conditional, read the workspace first and echo its
version back as `If-Match`:

```bash
# Read the current version from the ETag.
etag=$(curl -sD - "$MA_URL/v1/workspaces/ws_…" -H "authorization: Bearer $MA_TOKEN" \
  -o /dev/null | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')

# Conditional update: refused with 412 if the workspace changed since that read.
curl -X PUT "$MA_URL/v1/workspaces/ws_…/members" \
  -H "authorization: Bearer $MA_TOKEN" -H 'content-type: application/json' \
  -H "if-match: $etag" \
  -d '{"members":[{"principalId":"pr_…","role":"owner"}]}'
```

On a **412**, re-read the workspace, re-apply your change to the fresh member list,
and retry with the new ETag. `If-Match` is optional: omit it for an unconditional
replace (the prior behaviour). The version advances on *every* workspace write —
name, quota, members, archive, and an SSO group-mapping reconcile — so an
outstanding token is invalidated by any of them, not just another member edit. The
SDK's `setMembers(workspaceId, members, expectedVersion?)` sends the header and
surfaces a 412 as a `precondition` error.

### Raising a limit

Quota is per workspace and changed by an owner via a dedicated endpoint (the
workspace `PATCH` deliberately does *not* accept quota — a limit change is an
owner-only act, gated separately from editing name/description). It merges, so
you send only the dimensions you are changing:

```bash
curl -X PUT "$MA_URL/v1/workspaces/ws_…/quota" \
  -H "authorization: Bearer $MA_TOKEN" -H 'content-type: application/json' \
  -d '{"maxConcurrentSessions": 50}'
```

Confirm what took effect — and see live usage per dimension, including summed
artifact storage — with `GET /v1/workspaces/ws_…/quota`.

### Rotating a credential

Update a credential's value in place; the id stays the same, so agents referencing
it need no change. A rotation takes effect for a new session the moment it starts —
even against the warm pool. The sandbox pool key folds a *fingerprint* of each
credential's rotation state, so a rotated value produces a different key: the next
session cold-starts with the fresh value instead of reusing a warm sandbox that
baked in the old one. Sessions already running keep the value they resolved at
start (rotate, then let them finish or terminate them if the old value must stop
being used immediately).

One efficiency note: the fingerprint also moves on a metadata-only edit and on the
automatic `expiring`/`expired` status flip a credential gets near its expiry date.
Each is a one-time cause of a cold start as the warm pool re-coheres around the new
fingerprint — harmless, but it explains an occasional `provisionMs` blip around a
credential's expiry window that is not a capacity problem.

### Rolling back an agent

Versions are immutable, so a rollback is a pointer move rather than a restore:

```bash
ma agent update --agent ag_… --production-version 4
```

Sessions already running keep the version they pinned. Only new ones pick this up.

### Draining for a deploy

`SIGTERM` stops accepting new requests, answers 503 to anything arriving during
the drain, and lets in-flight requests finish before exiting. Long-lived SSE
streams are closed at the socket; clients reconnect and resume from their last
sequence, so a deploy is invisible to them.

**SSE streaming is backpressure-bounded.** Both the replay of a session's log and
the live feed pace their writes to the client: when the socket's write buffer
fills, the server stops writing and waits for it to drain rather than buffering the
rest of the log in memory — so server memory does not scale with (events ×
concurrent slow clients). A client that stops reading entirely is disconnected once
the drain wait exceeds the bridge's drain timeout (30s default); it resumes from its
`Last-Event-ID`, losing nothing, because the event log is the source of truth. A
live client that lags past the in-memory queue gets one `stream.lagged` frame
naming where to resume, never silent loss.

### Retention

Event retention is per workspace (`eventRetentionDays`, default 90). Pruning
truncates the *head* of each log and exposes the earliest surviving sequence, so a
lagging consumer can resume from a known point. It never leaves holes in the
middle, which would be unrecoverable.

Audit entries outlive events deliberately: "who did what" should still be
answerable after the detail of "what exactly happened" has aged out. Audit
retention is a single global window (`MA_AUDIT_RETENTION_DAYS`), not per
workspace, because an audit row can be system-level (no owning workspace) and a
compliance log is a platform policy rather than a tenant setting. It defaults to
`0` — keep forever — since deleting a compliance record should be a deliberate
operator choice. When set, the scheduler's periodic loop drops rows older than
the window (reported as `auditPruned` on each tick).

Idempotency keys are reclaimed automatically, with no configuration. Each key
carries its own TTL (set when the request reserves it), and the scheduler's loop
deletes every key already past its expiry on each tick (reported as
`idempotencyPruned`). An expired key is dead weight — a retry arriving after the
guarantee window has elapsed is correctly treated as a fresh request — so there is
no policy to tune and nothing accumulates: previously this table was the one sweep
the scheduler never ran, and it grew without bound. Each of these sweep outcomes
is also exported on the `/metrics` endpoint as a `kind` label on
`ma_scheduler_ticks_total` (`events_pruned`, `audit_pruned`, `idempotency_pruned`,
`billed_turns_pruned`, `credentials_expired`), so an operator can confirm reclamation
is actually happening rather than inferring it.

Datasets are the one store with no automatic sweep, by design: a knowledge base is
deliberate content, not transient state, so it is removed by an explicit
`DELETE /v1/datasets/:datasetId` (admin-gated, or a resource grant on that dataset)
rather than aged out on a timer. The delete removes the dataset row — its documents
cascade via the foreign key — and, crucially, evicts the dataset's chunks from the
in-memory search index, which has no database FK to cascade through. Without a
delete route these tables (and that index) grew without bound; the response reports
`documentsEvicted` so an operator sees the reclamation took effect.

### Verifying the audit log has not been tampered with

The audit log is a hash chain: each entry commits to the one before it, so any
edit, insert, deletion, or reordering of a historical row is detectable — even by
someone with direct database access, who cannot recompute the chain forward
without breaking a later link. `GET /v1/audit/verify` (platform admins only)
walks the chain and returns `{ ok, checked, brokenAtSeq?, brokenId?, reason? }`.
A healthy log answers `ok: true`; a tampered one answers `200` with `ok: false`
and the location of the first break — a `200` on purpose, so an external monitor
can poll the endpoint and alert on the body rather than a status code.

Retention pruning is not tampering: `prune` removes the oldest *seq-prefix* of
fully-expired rows and records a checkpoint of the highest seq it removed, and
verification re-anchors the live chain there, so trimming expired rows verifies
cleanly while a truncation of *recent* rows still fails. Pruning by seq-prefix
(not a raw `at < cutoff` sweep) is deliberate: `at` is caller-supplied and can run
out of order with `seq` after a clock step, and only a true deleted-prefix boundary
keeps the linkage-exemption below the watermark safe — a row that survives a prune
is always strictly above the watermark, in the zone every check still covers, so it
can never be silently deleted or forged. A legitimately old but clock-skewed row
therefore lingers in the live chain rather than being carved out of the middle —
the safe direction. Every surviving row is content-verified unconditionally, so an
edit to any retained entry is caught regardless of pruning. Wire the verify endpoint
into a periodic external check (a cron hitting it with an admin token, alerting on
`ok: false`) so tampering surfaces on its own rather than only when someone thinks
to look. The check is read-only and safe to run as often as the audit table size
allows.

**What the chain does and does not guarantee.** It makes tampering *evident* — it
does not prevent it. An attacker who can write the database can still delete or
edit rows; the point is that `verifyChain` then reports it. The hash commits to
*every* field of an entry, including any nested key — even one literally named
`__proto__` (an earlier build silently omitted such a key from the hash material,
which would have let content nested under it be altered undetected; the hash now
covers it). The one residual is
that the chain's head/checkpoint lives in the same database (`audit_chain_head`):
an attacker who rewrites both the audit rows *and* that row in a mutually
consistent way could in principle present a shorter but internally-valid chain.
Closing that fully requires anchoring the head outside the database — periodically
exporting `last_seq`/`last_hash` to an append-only or external sink (a WORM
bucket, a log-shipping pipeline, a countersigning service) and comparing on
verify. Until then, treat the in-database head as the boundary of the guarantee,
and export the head hash on a schedule if your threat model includes an attacker
with full database write access.

---

## Scaling

The SQLite driver serializes writers, which is honest rather than incidental —
SQLite does that anyway. For a single deployment serving one organisation it is
usually not the constraint; sandbox capacity is.

**The per-tick sweeps are index-driven and stay cheap as the tables grow.** The
scheduler and retention loops run a handful of queries on every tick — expired
sessions, queued sessions, upgradable sessions, sessions with expired events, and
the document-ingestion backlog (drained up to five times a tick) — against tables
that only ever grow (there is no hard-delete; rows age out on their retention
window). Each of these is pinned to a covering/partial index with an explicit
`INDEXED BY`, so the cost is proportional to the *matching* set (usually small),
not the table size. The `INDEXED BY` is deliberate: SQLite's planner needs
table statistics (`ANALYZE`) to prefer an index, and this deployment does not run
`ANALYZE` on a schedule — so left to guess, the planner would full-scan the events
table via its primary key. Forcing the index removes that dependence on statistics
entirely; a query that can no longer find its index fails loudly rather than
silently degrading to a scan. Adding a new index to an already-large table (a fresh
migration on an existing deployment) briefly locks that table while it builds —
expected for a one-time migration, and the sweep indexes here are small.

When it becomes the constraint, the store is behind repository interfaces and a
Postgres driver slots in without the engine noticing. Two things then become
multi-process safe automatically, because they were already compare-and-set in the
store rather than in-process locks:

- Schedule firing — several replicas produce exactly one delivery per tick.
- Delivery claiming — one worker leases each receipt.

Two things are per-process today and would need attention: the rate limiter (a
guard against a single runaway client, not a distributed quota) and the keyword
index. The index is in-memory per replica, but its source of truth is durable:
document content is persisted to the `<MA_ARTIFACT_ROOT>/documents` blob store at
ingestion, and each process rebuilds its index from there at startup (before it
accepts traffic), so a restart — or a new replica — comes up with the full corpus
searchable rather than an empty index. A `:memory:` artifact root is the one
exception: nothing is durable there, so knowledge is intentionally per-process and
lost on restart, which suits a throwaway dev server.

---

## Security posture

**Credential values are write-only.** No API path returns one. Only the runtime
exchange endpoint decrypts, only for credentials on the session's pinned version,
and every exchange is audited by id and purpose — never by value.

**Attaching a credential to a session costs `credential.read`.** A session's
credentials are exchangeable for plaintext by its agent, so `session.create`
authorizes every credential id the caller names against `credential.read` before
attaching it — an operator (who may start sessions) cannot attach a credential it
is not permitted to read. Ids already pinned on the agent version are exempt: a
developer put them there, and running that agent is the operator's job. The same
check guards version authoring — `agent.version.create` charges `credential.read`
for each newly pinned id — so the exemption cannot be used to smuggle an
unreadable secret in, not even with an API key scoped to agents only. Attaching a
credential from another workspace, or one that does not exist, is `not found`.

**Pinning a dataset into a version costs `dataset.read` and stays in-workspace.**
A version's `datasetIds` flow into the retrieval tool, which returns document
chunks to the agent — and the keyword index is process-wide with no workspace on
its chunks, so the *only* tenant boundary on retrieval is that a version cannot
name a dataset from another workspace. `agent.version.create` therefore validates
every newly-pinned dataset the same way it does credentials: it must exist, belong
to the agent's workspace, and cost `dataset.read`. A dataset from another
workspace, or one that does not exist, is `not found` — so a developer cannot pin a
foreign `ds_` id to read another tenant's ingested documents. (An earlier build
checked this only on a vestigial bind route that persisted nothing; the check now
lives on the path that actually writes `datasetIds`.)

**Credential env is delivered on a trusted path; supplied env is sanitised.** An
`env_vars` credential's contents reach the sandbox as ordinary environment, but
their keys are member-chosen, so they are sanitised first — a reserved key (`MA_*`,
`PATH`, a proxy var, …) is stripped, and a credential cannot spoof a platform
variable. An `api_key`/`bearer_token` credential is delivered as
`MA_CRED_<NAME>=<value>` on a separate trusted path that skips that sanitiser, so
it actually reaches the agent (the `/^MA_/` strip on the supplied path would
otherwise drop the platform's own `MA_CRED_*`). Neither path can override the
runtime token, the control-plane URL, or the egress proxy — those are written
last. If an agent reports a missing `MA_CRED_<NAME>`, check the credential's type
and that its name maps to the expected variable (`MA_CRED_` + upper-cased name,
non-alphanumerics to `_`).

**Sandboxes hold no provider keys.** Model calls go through the gateway, so a
compromised sandbox has nothing to exfiltrate.

**A connector reuses only its own sessions.** A session records which connector
created it, so a `reuse_connector` conversation and a schedule's "is a run still
going?" check are scoped to that connector's own sessions — never a human's chat or
another connector's for the same agent. Without that scoping a connector could have
injected its inbound event into an unrelated live conversation and posted the reply
out to its own destination: a cross-conversation, cross-destination leak.

**The runtime surface is four operations**, each scoped by a session-bound token:
append events to its own session, renew its lease, exchange a granted credential,
call a permitted model. It cannot read another session or enumerate anything.

**The control plane authenticates to the sandbox, too.** agent-core's inbound
endpoints — `/submit` (hand in a prompt) and `/rebind` (repoint a warm sandbox at a
new session) — act on the session, so they require a credential: the control plane
presents the sandbox's runtime-token hash as a bearer token, and agent-core
compares it against the hash of its own token. On the container and k8s drivers the
sandbox binds all interfaces (the control plane reaches it across the namespace
boundary), so a co-located workload can route to the agent port; without this check,
reachability alone would let it inject a prompt or force a rebind. `/healthz` stays
open — it is a static liveness beacon the kubelet probe reaches without credentials.
On k8s a restricted pod's NetworkPolicy also fences the agent port to the
control-plane CIDR as defense in depth (the kubelet probe, coming from the node, is
exempt on standard CNIs). An `allow`-egress pod gets no NetworkPolicy — the operator
chose unrestricted networking — and relies on the endpoint credential alone.

**Rate limiting is two-tier, straddling authentication.** A coarse per-IP tier
runs *before* auth as an anonymous-flood shield, so a flood is refused without ever
reaching the (DB-backed) API-key lookup — auth is not the DoS surface. A finer
per-principal tier runs *after* auth, so one tenant behind a shared NAT/proxy
cannot spend another tenant's budget (before, both were bucketed by IP and one
noisy tenant throttled the rest). The per-principal tier passes public and runtime
paths straight through — they carry no principal and are already bounded by the IP
tier — so high-volume sandbox→control-plane traffic is not capped at the lower
per-principal limit. Both tiers are per-process (see the scaling note below).

**A malformed request cannot crash the process.** The router decodes path
parameters, and a bad percent-escape (`GET /v1/agents/%zz`) makes
`decodeURIComponent` throw; the request URL is parsed against a fixed base rather
than the client's `Host` header, so a malformed host (`Host: foo bar`) cannot make
URL parsing throw either. Both are answered with a `400` and the process keeps
serving — before, either one escaped as an unhandled rejection and took the whole
control plane down, an unauthenticated denial of service from a single crafted
request. As a backstop, the process logs an `unhandledRejection` and continues
(one leaked rejection must not crash-loop every tenant) and drains cleanly on an
`uncaughtException`; if you see either in the logs, it is a bug to file, not an
outage to page on.

**A model-controlled regex cannot wedge a sandbox.** The `search` tool runs a
regular expression the model chose, and a catastrophic pattern backtracks for
effectively unbounded time. It runs in a worker thread the tool terminates at a
timeout (or on an interrupt), so a runaway pattern returns "Search timed out"
instead of blocking the agent-core event loop — which would otherwise freeze the
turn deadline and every subsequent turn. A search that reports a timeout is the
model's pattern being too expensive, not a platform fault.

**Every route names the action it performs.** Membership in a workspace
authorizes nothing on its own — a viewer can read, and that is all. This is
enforced by making the action a required argument at each call site rather than
a check someone must remember to add, because forgetting it once and copying the
pattern is exactly how a viewer ends up able to write.

**The permission engine denies by default** for unattended agents, because there
is nobody to answer a prompt at 3am. Compound shell commands are refused rather
than parsed — deciding what `git status; rm -rf /` really runs is a losing game.

**Set `MA_TRUST_PROXY` only if a proxy really is in front.** Unauthenticated
callers are rate-limited by source address, and `sourceIp` in the audit trail
comes from the same place. `X-Forwarded-For` is chosen by the client unless a
proxy overwrites it, so trusting it without one lets any caller rotate the
header for a fresh rate-limit bucket every request — and write whatever address
it likes into a security record. Left off, both read the socket address, which
nobody can choose for themselves. Turn it on behind a load balancer or ingress
that sets the header itself, and leave it off otherwise.

**Choose the driver to match the trust level.** The `local` driver runs sandboxes
as child processes: fast, dependency-free, and honest that a child shares the
host kernel and filesystem, so its limits are advisory. Use it for development
and for agents you wrote.

The `container` driver gives untrusted workloads a real boundary — CPU and memory
limits the kernel enforces, all capabilities dropped, no new privileges, a
read-only root with a tmpfs workspace, and `--network none` when egress is
denied. Set `MA_SANDBOX_DRIVER=container` and make sure the container binary is
on the path.

The `k8s` driver schedules that same isolated workload across a cluster. It
provisions one Pod per sandbox with the container driver's guarantees (resource
limits, dropped capabilities, read-only root, tmpfs workspace and `/tmp`) plus
two only Kubernetes can express: `runAsNonRoot` and
`automountServiceAccountToken: false`, so a compromised sandbox has no cluster
identity to reach the API server with — even when it opts into a cloud identity
through `runAs` (see below), the API token stays unmounted. Set
`MA_SANDBOX_DRIVER=k8s` and
`MA_K8S_NAMESPACE` (default `managed-agent`); the driver authenticates with its
own mounted service-account token, so the control plane runs in-cluster with a
role that can create, read, log and delete pods, secrets and networkpolicies in
that namespace. Readiness is an HTTP probe on the agent port, falling back to the
same `AGENT_CORE_READY` log marker the container driver uses; the endpoint
resolves to the Pod IP. The runtime token and resolved credential values go in a
per-pod Secret referenced by `secretKeyRef`, never inlined as pod env (which any
namespace pod-reader could see). Egress is enforced by a NetworkPolicy per pod:
every restricted policy (`deny` and any `allowlist`) always permits exactly the
control-plane CIDR (`MA_CONTROL_PLANE_CIDR`) and DNS — the control channel the
sandbox needs to exist as an agent — and nothing else by default. An allowlist
with hosts adds the proxy's CIDR (`MA_EGRESS_PROXY_CIDR`) on top, with
`MA_EGRESS_PROXY` doing the per-host filtering beyond that; the CIDR is required,
because a NetworkPolicy scopes to CIDRs, not hostnames, and a ports-only rule
would permit those ports to any host. A restricted pod whose NetworkPolicy cannot
be created — or one with no control-plane CIDR, or an allowlist with no proxy CIDR
— is refused, not run on the open network, so the namespace needs a CNI plugin
that enforces NetworkPolicy and RBAC to create pods, secrets and networkpolicies,
or use `network.egress 'allow'` deliberately.

**Egress control.** `network.egress` governs where the *agent* may reach —
provider APIs, MCP servers, the internet. It does **not** govern the control
channel: a sandbox always needs to reach the control plane to bootstrap, report
events, and make model calls (every call is proxied through it, so the control
plane is the only host a sandbox strictly needs). So on every restricted policy
the platform permits the control plane (and DNS to resolve it) and applies the
egress policy to everything else — "deny-all **except the control channel**".

**Ingress control (k8s).** A restricted pod's NetworkPolicy also fences *inbound*
traffic: only the control-plane CIDR may reach the agent port. agent-core binds
all interfaces in the pod (the control plane dials the Pod IP), so without this
any pod that can route to the Pod IP could reach `/submit`/`/rebind`; the endpoint
credential is the real fence and this is defense in depth. This relies on the CNI
exempting the **kubelet's** readiness probe from NetworkPolicy — standard on
Calico, Cilium, Weave and the cloud CNIs, because probe traffic is sourced from the
node, not a pod. Treat that as a deployment prerequisite: on a non-conformant CNI
that subjects node→pod probe traffic to NetworkPolicy, the readiness probe would be
dropped and the pod would never go Ready. The failure is safe — the pod is
destroyed at the startup timeout, never run unprotected — but it is an availability
failure to watch for when bringing up an unusual CNI.

| Value | Behaviour |
| --- | --- |
| `deny` | Reaches the control plane and DNS, nothing else. (k8s: a NetworkPolicy with exactly those rules. container: the egress-less internal network, which the other restricted sandboxes on the host share — see below.) |
| `allowlist` with no hosts | Same as `deny` — the agent reaches nothing it named (it named nothing), but the control channel still works. This is the schema default. |
| `allowlist` with hosts | The control plane + DNS, plus the named hosts enforced through a filtering proxy when it is configured; **provisioning fails** with `SANDBOX_EGRESS_UNSUPPORTED` when the proxy infra is not. |
| `allow` | Unrestricted egress (`--network bridge` / no NetworkPolicy). |

**The control-plane address must be routable from inside the sandbox.**
`MA_CONTROL_PLANE_URL` defaults to `http://127.0.0.1:$MA_PORT`, which is correct
only for the `local` driver — inside a container or pod, `127.0.0.1` is the
sandbox itself. On the container/k8s drivers a *restricted* sandbox with a loopback
control-plane URL is **refused** (`SANDBOX_CONTROL_PLANE_UNREACHABLE`): set
`MA_CONTROL_PLANE_URL` to a host- or cluster-routable address (e.g.
`host.docker.internal`, a LAN IP, or the control-plane Service DNS). `allow` egress
keeps the loopback default for local development.

**k8s: set `MA_CONTROL_PLANE_CIDR`.** A NetworkPolicy scopes to CIDRs, so the
control-plane carve-out needs the control-plane Service's routable CIDR. Without
it, a restricted pod is refused (`SANDBOX_CONTROL_PLANE_UNREACHABLE`) rather than
started unable to bootstrap. The carve-out is exactly that CIDR plus DNS — never a
wildcard — so `deny`/`allowlist` still fail closed for every other host.
**Set it to the control-plane Service's `/32` (or the narrowest range that covers
it), not the pod or cluster CIDR:** the agent is untrusted and can reach anything
inside this CIDR on the control-plane ports, so a broad value (a `/16`, or
`0.0.0.0/0`) turns the carve-out into broad egress. Narrow is the whole point.

**Container: the internal network must actually be egress-less.** A restricted
container joins `MA_INTERNAL_NETWORK` and reaches whatever is attached to it. The
driver cannot verify the network was created `--internal`, so this rests on
operator trust: if that network has its own egress, a restricted sandbox silently
gets it. Create it with `docker network create --internal ma-internal` and attach
only the control plane (and the egress proxy). This is a weaker guarantee than the
k8s NetworkPolicy (which a CNI enforces); on the container driver, the internal
network *is* the boundary.

**Container: the internal network isolates egress, not peers.** Every restricted
sandbox on the host joins the same `MA_INTERNAL_NETWORK`, and an `--internal`
network still carries container-to-container traffic, so restricted sandboxes —
including ones from different workspaces — can open connections to each other's
agent-core port. `/submit` and `/rebind` require the sandbox's runtime-token hash,
which a peer cannot derive, so this exposes port reachability rather than control
of another session. `MA_INTERNAL_NETWORK` is a single value per control-plane
process, so the container driver cannot place workspaces on separate networks.
For cross-tenant network isolation use the Kubernetes driver, whose NetworkPolicy
fences each pod's inbound traffic to the control plane, or run a separate
deployment (with its own internal network) per tenant.

**Per-host filtering needs a filtering proxy.** Configure one and the drivers
enforce the allowlist on top of the control-plane carve-out: set `MA_EGRESS_PROXY`
(e.g. `http://ma-egress:3128`) to a proxy that permits only the allowlisted hosts,
`MA_INTERNAL_NETWORK` (default `ma-internal`, a container network created
`--internal`), and on k8s `MA_EGRESS_PROXY_CIDR` for the NetworkPolicy `to` scope.
A proxy-filtered container joins the egress-less internal network and receives
`HTTP(S)_PROXY`/`NO_PROXY` forcing its traffic through the proxy; the control-plane
address is `NO_PROXY`-exempt so its callback goes direct.

Without the proxy infra, an allowlist naming hosts is *refused*, never silently
widened. It used to fall through to bridge networking, which meant an operator who
picked the safest-sounding option — and anyone who never touched the setting, since
`allowlist` is the default — got unrestricted egress while the config read as
restricted. The refusal is the safe default; configure the infra to turn the
allowlist into real enforcement, or set `allow` and mean it.

Run `reapOrphans` at startup on the container driver. A control plane that
crashed mid-provision leaves labelled containers with no row pointing at them,
and nothing else will ever clean them up.

**Volume mounts need storage configured.** An agent version can declare
`sandbox.mounts` — platform-managed *named* volumes (never host paths), each
mounted at a validated absolute target and read-only by default. This is how an
agent carries state across sessions (a workspace volume) or caches a dataset,
without breaching the ephemeral-`/workspace` posture for anything it did not
ask for.

Set `MA_VOLUME_ROOT` to a durable directory (or, on k8s, a node-local path) to
enable them. The platform maps each `(workspace, name)` to a confined
`<MA_VOLUME_ROOT>/<workspaceId>/<name>` directory — the same
workspace-namespaced shape as the artifact store — so a workspace can only ever
reach its own volumes, and removing a workspace's data is a directory removal.
Left unset (or `:memory:`), volumes are disabled and a version that declares a
mount is **refused** with `SANDBOX_MOUNT_UNSUPPORTED`, rather than started
without the persistence it asked for — the same fail-closed rule as a missing
egress proxy. Each mount enters the sandbox pool key, so a warm reused sandbox
is never handed to a session that mounts a different set: the reused filesystem
cannot leak across mount configurations.

How a mount is realized depends on the driver. The `container` driver binds it
(`--mount type=bind`, `readonly` enforced by the runtime); the `k8s` driver
emits a `hostPath` volume with `DirectoryOrCreate` plus a `volumeMount` (a PVC
story is a deployment extension — `hostPath` is node-local, so pin such agents to
a node or provide shared storage at that path). The `local` driver has no mount
namespace, so it surfaces the volume as a symlink beside the working directory
and exposes the resolved path as `MA_VOLUME_<NAME>`; `readOnly` is advisory
there, as the local driver's resource and egress limits already are — use a real
driver for untrusted agents that must not write a read-only volume.

**Sandbox cloud identity (`runAs`) is Kubernetes-only.** An agent version can
declare `sandbox.runAs` — a single DNS-1123 label — to run its sandbox under a
scoped cloud identity, so the agent reaches cloud resources (S3, a database, a
secrets manager) as *itself* rather than as the platform. It is empty by default;
an empty value keeps the sandbox identity-less, unchanged from before.

On the `k8s` driver, `runAs` becomes the pod's `serviceAccountName`, confined to
the requesting workspace: the platform prefixes the value with the workspace ULID
(`ws-<ulid>-<runAs>`), so a workspace can only ever name a ServiceAccount
provisioned for it — never `default`, never another workspace's. **You provision
the ServiceAccount and its cloud binding**; the platform never creates it. Create
a ServiceAccount named `ws-<workspaceid-lowercased>-<runAs>` in the sandbox
namespace and annotate it for your identity provider — AWS IRSA
(`eks.amazonaws.com/role-arn`) or GKE Workload Identity
(`iam.gke.io/gcp-service-account`). A `runAs` that names a ServiceAccount you have
not created makes pod admission fail loudly, not silently run unprivileged.

The Kubernetes API token stays unmounted (`automountServiceAccountToken: false`)
even with `runAs` set: the cloud identity flows through the ServiceAccount's
*name* (IRSA/WI project their own token), so the agent gains a cloud role without
gaining any reach into the cluster API. The `container` and `local` drivers have
no ServiceAccount mechanism and **refuse** a non-empty `runAs` with
`SANDBOX_IDENTITY_UNSUPPORTED` rather than run without the identity it promises —
the same fail-closed rule as an unenforceable egress allowlist. `runAs` also
enters the pool key, so a warm reused sandbox bound to one identity is never
handed to a session that asked for another.

**Single sign-on is opt-in and provider-agnostic.** SSO is off until
`MA_OIDC_PROVIDERS` names at least one provider slug; with none, the `/auth/v1/*`
routes report no providers and nothing changes. Each provider is configured as
data — `MA_OIDC_<S>_ISSUER`, `_CLIENT_ID`, `_REDIRECT_URI`, and a client secret
from `MA_OIDC_<S>_SECRET` or `_SECRET_FILE` — so Okta, Auth0, Google, Azure AD
and Keycloak are reached without provider-specific code. A binding is validated
at startup (an http issuer for a non-loopback host, a missing secret, or a
malformed group mapping all refuse to boot), so a misconfiguration is a loud
failure rather than a login-time surprise.

The flow is standard OIDC authorization-code with PKCE. `GET
/auth/v1/<S>/login` redirects the browser to the IdP and sets a sealed,
`HttpOnly`, `SameSite=Lax` state cookie carrying the CSRF token, the `nonce`, and
the PKCE verifier — the browser cannot read or forge it. `GET
/auth/v1/<S>/callback` verifies the returned ID token against the IdP's JWKS
(asymmetric algorithms only — `none` and HMAC-confusion forgeries are refused
before verification), checks `iss`/`aud`/`exp`/`iat`/`nonce`, then get-or-creates
a principal keyed on `oidc:<provider>:<sub>` and mints an ordinary session token.
Because that token is a normal bearer token, everything downstream — the auth
middleware, roles, scopes, the audit trail — treats a federated caller exactly
like any other.

Two policy knobs matter most. Set `MA_OIDC_<S>_ALLOWED_DOMAINS` for any *shared*
IdP (Google, above all), or any account on it can log in; a single-tenant IdP can
leave it unset. The domain gate trusts the email only when the token's standard
`email_verified` claim is true — an unverified (or absent) `email_verified` is
treated as no email at all, so an attacker who sets their profile address to
`someone@yourcorp.com` at a shared IdP cannot satisfy the allowlist. Use
`MA_OIDC_<S>_GROUP_MAP` (`group:workspaceId:role;…`) to grant workspace
membership from group claims — the reconciliation is **additive**: a login can
add or upgrade a membership, never remove one a human granted by hand, so a
dropped group claim during an IdP outage cannot silently lock people out.
De-provisioning stays a deliberate admin action. A federated principal is never a
platform admin from a claim; grant admin out of band.

For a browser console, set `MA_OIDC_CONSOLE_REDIRECT` so the callback hands the
token back in a URL fragment (never logged, never sent to a server) instead of
returning JSON; a CLI or custom front end omits it and reads the JSON directly.

**SCIM provisioning automates the user lifecycle — including offboarding.** SSO
answers who someone is *when they log in*; SCIM lets the IdP push the lifecycle
around that: create a user (and grant them workspace roles) *before* a first
login, and — the part that matters most for security — deactivate them the moment
HR removes them from the IdP, instead of waiting for their last session token to
expire. Set `MA_SCIM_TOKEN` (a long random secret; `_FILE` variant supported) and
`MA_SCIM_PROVIDER` (an OIDC provider slug from `MA_OIDC_PROVIDERS`) to enable the
`/scim/v2/Users` endpoints. Point the IdP's SCIM connector at
`https://<host>/scim/v2` with that token as its bearer credential.

The load-bearing detail is that SCIM provisions into the **same** identity space
as login: a user's platform principal is keyed on `oidc:<provider>:<externalId>`,
and login matches the same string, so provision-ahead, sign-in, and deactivate
all act on one principal — never a duplicate, and the roles granted before login
are there at login. Make the IdP send the SCIM `externalId` equal to the value it
puts in the OIDC token's `sub`; if they differ, the two will not converge.

Deactivation (`PATCH active:false`, a full-resource `PUT` with `active:false`, or
`DELETE`) disables the principal **and revokes every live API key it holds**, so
the next request with any of that user's tokens is rejected — immediately, not at
token expiry. A `DELETE` is treated as deactivation, not a row deletion: the
principal is preserved so its audit history and workspace memberships survive and
a later re-provision reuses the same identity. SCIM never grants platform-admin
(that stays an out-of-band decision), and a SCIM connector is scoped to its own
provider — it cannot see or touch principals federated from another IdP. Every
provisioning action is written to the audit trail.

**Artifact preview needs a separate origin.** Downloading an artifact is always
safe — the bytes come back as an `attachment` with a sniffed, never-executable
type. *Previewing* means rendering them, which is dangerous for one reason: the
console is served from the same origin as the API, so an agent-authored page
rendered there would run with the operator's session. Preview is therefore
served only from a distinct origin set by `MA_PREVIEW_ORIGIN`, under a
`sandbox` CSP, and gated by a short-lived signed token. Set it to a host that
resolves to this server but is a different origin than the API/console (a
separate subdomain is enough), and set `MA_CONSOLE_ORIGIN` to the console's
public origin — it is **required** whenever preview is enabled, because it is the
origin preview content must be isolated *from* and the one the CSP's
`frame-ancestors` lets embed previews; the server refuses to start with a preview
origin but no console origin, since the isolation could not otherwise be
verified. If `MA_PREVIEW_ORIGIN` is unset, preview is disabled and minting a
preview token fails — there is no safe same-origin preview, so the safe default
is off. The server also refuses to start if `MA_PREVIEW_ORIGIN` equals the
console origin (or a non-loopback API origin), which would defeat the isolation.
