# Operations

How to run, configure and reason about a Managed-Agent deployment.

---

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
| `MA_SANDBOX_DRIVER` | `local` | `local` (process) or `container` |
| `MA_CONTAINER_BINARY` | `docker` | Also `podman` or `nerdctl` |
| `MA_SANDBOX_LEASE_SECONDS` | `120` | Missed heartbeats past this mean lost |
| `MA_SANDBOX_PREWARM` | `0` | Warm sandboxes per pool; costs idle capacity |
| `MA_SCHEDULER` | on | `off` to disable the periodic loop |
| `MA_SCHEDULER_TICK_MS` | `5000` | |
| `MA_RATE_LIMIT` | `600` | Requests per window, per principal |

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
session's logical lease had not expired it returns to `provisioning` and continues
from its last context snapshot — the user's work is not lost. If the lease had
expired, the session fails.

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

### Raising a limit

```bash
curl -X PATCH "$MA_URL/v1/workspaces/ws_…" \
  -H "authorization: Bearer $MA_TOKEN" -H 'content-type: application/json' \
  -d '{"quota": {"maxConcurrentSessions": 50}}'
```

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
answerable after the detail of "what exactly happened" has aged out.

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
index (rebuilt at startup, so each replica holds its own copy).

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

**The permission engine denies by default** for unattended agents, because there
is nobody to answer a prompt at 3am. Compound shell commands are refused rather
than parsed — deciding what `git status; rm -rf /` really runs is a losing game.

**Choose the driver to match the trust level.** The `local` driver runs sandboxes
as child processes: fast, dependency-free, and honest that a child shares the
host kernel and filesystem, so its limits are advisory. Use it for development
and for agents you wrote.

The `container` driver gives untrusted workloads a real boundary — CPU and memory
limits the kernel enforces, all capabilities dropped, no new privileges, a
read-only root with a tmpfs workspace, and `--network none` when egress is
denied. Set `MA_SANDBOX_DRIVER=container` and make sure the container binary is
on the path.

Run `reapOrphans` at startup on the container driver. A control plane that
crashed mid-provision leaves labelled containers with no row pointing at them,
and nothing else will ever clean them up.
