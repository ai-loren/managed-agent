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
| `MA_CONTROL_PLANE_URL` | `http://127.0.0.1:$MA_PORT` | What a sandbox calls back on |
| `MA_SANDBOX_DRIVER` | `local` | `local` (process), `container`, or `k8s` |
| `MA_CONTAINER_BINARY` | `docker` | Also `podman` or `nerdctl` |
| `MA_EGRESS_PROXY` | (unset) | Filtering proxy that enforces an egress allowlist (container/k8s) |
| `MA_EGRESS_PROXY_CIDR` | (unset) | The proxy's CIDR, required for the k8s allowlist NetworkPolicy `to` scope |
| `MA_DNS_CIDR` | (unset) | DNS resolver CIDR a proxied k8s pod may reach (else the kube-system namespace) |
| `MA_INTERNAL_NETWORK` | `ma-internal` | Egress-less container network joined when proxy-filtered |
| `MA_K8S_NAMESPACE` | `managed-agent` | Namespace for sandbox pods when the driver is `k8s` |
| `MA_SANDBOX_LEASE_SECONDS` | `120` | Missed heartbeats past this mean lost |
| `MA_SANDBOX_PREWARM` | `0` | Warm sandboxes per pool; costs idle capacity |
| `MA_VOLUME_ROOT` | (unset) | Root for platform-managed named volumes; unset (or `:memory:`) disables mounts, so a spec declaring `sandbox.mounts` is **refused**. Each volume lives at `<root>/<workspaceId>/<name>` |
| `MA_SCHEDULER` | on | `off` to disable the periodic loop |
| `MA_SCHEDULER_TICK_MS` | `5000` | |
| `MA_AUDIT_RETENTION_DAYS` | `0` | `0` keeps the audit trail forever; a positive value prunes rows older than it |
| `MA_RATE_LIMIT` | `600` | Requests per window, per principal |
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

If many appear at once, workers are being killed — usually memory, usually during
a deploy.

### A schedule that did not fire

Three things stop a schedule, in order of likelihood:

1. It is not `active`. Check the status; a validation failure on activation leaves
   the reason on the row.
2. It fired but was skipped, because the previous run was still going
   (`skipIfRunning`) or the tick arrived past its `misfireGraceSeconds`. Both are
   logged. A nightly report firing at noon after an outage is worse than not
   firing, which is why the default is to skip.
3. Its cron means something other than you think. Ask:

```bash
curl "$MA_URL/v1/connectors/cn_…/next-fire" -H "authorization: Bearer $MA_TOKEN"
```

Day-of-month and day-of-week are **ORed** when both are restricted, matching
historical cron: `0 0 1 * mon` means the 1st *and* every Monday.

### Quota refusals

A `429` carries a machine-readable dimension and an honest `Retry-After`.
Concurrency suggests ~30s because sessions end continuously; a daily token budget
points at the window rollover, because it will not free up sooner.

```bash
ma workspace quota --workspace ws_…
```

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
`credentials_expired`), so an operator can confirm reclamation is actually
happening rather than inferring it.

### Verifying the audit log has not been tampered with

The audit log is a hash chain: each entry commits to the one before it, so any
edit, insert, deletion, or reordering of a historical row is detectable — even by
someone with direct database access, who cannot recompute the chain forward
without breaking a later link. `GET /v1/audit/verify` (platform admins only)
walks the chain and returns `{ ok, checked, brokenAtSeq?, brokenId?, reason? }`.
A healthy log answers `ok: true`; a tampered one answers `200` with `ok: false`
and the location of the first break — a `200` on purpose, so an external monitor
can poll the endpoint and alert on the body rather than a status code.

Retention pruning is not tampering: `prune` records a checkpoint of the highest
seq it removed, and verification re-anchors the live chain there, so trimming
expired rows verifies cleanly while a truncation of *recent* rows still fails.
Every surviving row is content-verified unconditionally, so an edit to any
retained entry is caught regardless of pruning. Wire the verify endpoint into a
periodic external check (a cron hitting it with an admin token, alerting on
`ok: false`) so tampering surfaces on its own rather than only when someone
thinks to look. The check is read-only and safe to run as often as the audit
table size allows.

**What the chain does and does not guarantee.** It makes tampering *evident* — it
does not prevent it. An attacker who can write the database can still delete or
edit rows; the point is that `verifyChain` then reports it. The one residual is
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

**Sandboxes hold no provider keys.** Model calls go through the gateway, so a
compromised sandbox has nothing to exfiltrate.

**The runtime surface is four operations**, each scoped by a session-bound token:
append events to its own session, renew its lease, exchange a granted credential,
call a permitted model. It cannot read another session or enumerate anything.

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
`deny` and an empty allowlist get deny-all-egress — an empty egress list, not
even DNS, since a no-network pod must not have a DNS exfiltration channel. An
allowlist gets egress fenced to the proxy's CIDR (`MA_EGRESS_PROXY_CIDR`) plus a
DNS rule, with `MA_EGRESS_PROXY` doing the per-host filtering beyond that; the
CIDR is required, because a NetworkPolicy scopes to CIDRs, not hostnames, and a
ports-only rule would permit those ports to any host. A restricted pod whose
NetworkPolicy cannot be created — or an allowlist with no proxy CIDR — is
refused, not run on the open network, so the namespace needs a CNI plugin that
enforces NetworkPolicy and RBAC to create pods, secrets and networkpolicies, or
use `network.egress 'allow'` deliberately.

**Egress control.** `network.egress` accepts three values:

| Value | Behaviour |
| --- | --- |
| `deny` | `--network none`. No networking, enforced by the kernel. |
| `allowlist` with no hosts | Identical to `deny` — an allowlist naming nothing permits nothing. This is the schema default. |
| `allowlist` with hosts | Enforced through a filtering proxy when `MA_EGRESS_PROXY` is set (see below); **provisioning fails** with `SANDBOX_EGRESS_UNSUPPORTED` when it is not. |
| `allow` | `--network bridge`. Unrestricted egress. |

Per-host filtering needs a filtering proxy. Configure one and the container
driver enforces the allowlist: set `MA_EGRESS_PROXY` (e.g. `http://ma-egress:3128`)
to a proxy that permits only the allowlisted hosts, and `MA_INTERNAL_NETWORK`
(default `ma-internal`) to a container network created with `--internal` — being
egress-less is what makes the proxy the only way out. A proxy-filtered container
joins that internal network and receives `HTTP(S)_PROXY`/`NO_PROXY` env forcing
its traffic through the proxy; the control-plane address is exempted via
`NO_PROXY` so the runtime token exchange still works.

Without a proxy configured, an allowlist naming hosts is *refused*, never
silently widened. It used to fall through to bridge networking, which meant an
operator who picked the safest-sounding option — and anyone who never touched the
setting, since `allowlist` is the default — got unrestricted egress while the
config read as restricted. The refusal is the safe default; configure a proxy to
turn the allowlist into real enforcement, or set `allow` and mean it.

The platform integrates with a proxy rather than shipping one: point at your own
(Squid, tinyproxy, a CNI egress gateway) configured with the same host list.

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
