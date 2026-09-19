# Design rationale: where we diverge from the reference platform

Managed-Agent's design was informed by studying a mature, production managed-agent
platform. This document records the points where we deliberately chose differently, and
why. It is the short list a reviewer should read to understand *why this is not a clone*.

The reference platform is referred to throughout as "the reference platform"; its internal
API specifications and deployment details are confidential and are not reproduced here.
What follows is design reasoning, which is ours.

---

## 1. Timestamp cursors → gap-free sequence cursors

**Reference platform**: cloud sessions resume with `since_ts` (millisecond timestamp); only the *local*
runtime got a real `since_sequence` cursor. The response carries `next_ts`.

**Problem**: two events in the same millisecond are indistinguishable to the cursor. A
resume at `next_ts` either replays the tail of that millisecond or skips it — there is no
third option. Under load, agent events routinely land in the same millisecond.

**Ours**: every event carries a **gap-free `seq`, monotonic per session**, assigned under
the same lock that appends it. `ts` is informational and never used for ordering.
Resume is `fromSeq`, which is exact. SSE frames put `seq` in the `id:` field so a
browser's native `Last-Event-ID` reconnect is correct with no client code.

## 2. Three exported event types → a full typed event taxonomy

**Reference platform**: the MQ egress contract exposes exactly three types — `item.completed`,
`turn.ended`, `error` — and the roadmap still lists "Agent Event 全量事件生产、订阅、
持久化与回放" as *planned*. Persisted run logs are also listed as planned; only
"CLI 实时结果返回" is delivered.

**Ours**: the event log is the source of truth from day one, with a typed taxonomy
covering session, turn, message, thinking, tool, model, context, sandbox, artifact and
audit namespaces. Session state is a fold over the log, so resume, audit and time-travel
debugging are one mechanism rather than three subsystems.

## 3. Best-effort event delivery → durable log + best-effort fanout

**Reference platform**: event egress is "async best-effort, no retry-to-strong-consistency"; consumers
must dedupe on `event_id` themselves.

**Ours**: durability is at the log (the write is the commit), and *fanout* is the
best-effort part. A subscriber that falls behind gets a `stream.lagged` frame with the
earliest available `seq` and can re-read from the log — it never silently loses events.

## 4. Cloud/local fork → one session model, pluggable executor

**Reference platform**: `AgentType` forks the entire model. Cloud sessions are SSE-centric with `session_id`;
local sessions are called "receipts" internally, keyed by `receipt_id`, with a separate
`Turn` entity, different cursor fields, different endpoints (`/sessions` vs `/receipts`),
and a different event struct. Model, Dataset, Connectors are cloud-only; Workspace Plugin
is local-only. The SDK's `SessionHandle` exists purely to branch on `AgentType`.

**Problem**: two half-platforms. Every feature must be built twice or declared
unavailable on one side, which is exactly what the capability matrix shows.

**Ours**: **one** Session entity and one event log. Where execution happens is a property
of the *sandbox provider* (`local`, `docker`, `k8s`), not a fork in the resource model.
A local sandbox is a driver, not a parallel universe.

## 5. `map[string]string` metadata carrying real config → typed config

**Reference platform**: execution-affecting configuration is smuggled through `AgentVersion.Metadata` as
stringified values — `permission_mode`, `run_as`, `subagent_enabled`,
`auto_compact_context`, and `startup_install_commands` as a **JSON-array-inside-a-string**.

**Problem**: unvalidatable, unmigratable, and invisible to any schema consumer. A typo in
`startup_install_commands` is discovered at sandbox boot.

**Ours**: `metadata` is for human labels only. Everything that affects execution is a
typed, validated field: `tools` (ToolPolicy), `context` (ContextPolicy), `sandbox`
(SandboxSpec with structured `setupCommands`), `runAs`, `subAgents`.

## 6. A vendor-specific validator blocking generic activation → polymorphic validators

**Reference platform**: schedule status transitions are blocked because the activation
path applies one connector type's validation rules to *every* connector type. Connector
restore and schedule run-now/next-fire are likewise unavailable. A leak of one integration's
assumptions into shared code permanently disabled a feature for all the others.

**Ours**: activation validation is dispatched per connector type through the adapter
interface. `archived → draft` restore is a declared transition. Run-now and next-fire are
first-class operations.

## 7. AK/SK signature not covering the request → revocable bearer tokens + body-bound webhooks

**Reference platform**: the workspace signature is
`auth-v1/{ak}/{ts}/{exp}/hex(HMAC_SHA256(sk, "auth-v1/{ak}/{ts}/{exp}"))` — it signs only
the key and timestamps, **not the method, path, or body**.

**Problem**: a captured header is a bearer token for any request to any endpoint until it
expires. It authenticates the caller but does not bind the call — and, worse, the
reference scheme has no revocation path, so a leaked key is live until its `exp`.

**Ours**: we do not use a home-grown request-signing scheme for the API at all. Inbound API
calls carry an opaque bearer token, stored only as a salted hash and compared in constant
time (`middleware.ts`); the delta that matters is **revocation**, not per-request signing.
A token can be revoked, expired, or killed the instant its principal is offboarded — the
SCIM `active:false` path revokes every live key a removed user holds (§ on SCIM), so a
leaked credential dies on the next request rather than living to its expiry. A captured
bearer token is still a bearer token until then, exactly as anywhere else; short expiry
plus immediate revocation is the mitigation, not signing.

Where a signature *is* used — the inbound webhook/chat/event-bus connectors — it is an
HMAC over **`timestamp.body`** (`verifySignature` in `crypto.ts`): it binds the payload and
the timestamp (checked against a tolerance window against replay), so a tampered body or a
stale capture is rejected. It does not sign the method or path, which is moot for a
connector endpoint that accepts exactly one method at one fixed path. So the honest claim
is narrower than "full request binding": revocable bearer auth for the API, and
body-plus-timestamp-bound signatures on the webhook surface — not a method/path/body
request signature.

## 8. No public sandbox surface → sandbox as a first-class resource

**Reference platform**: no sandbox CRUD API exists; readiness is inferred from a non-empty
`sandbox_session_id`. Image, quota, network policy and reuse rules are invisible to users.

**Ours**: `Sandbox` is a resource with status, spec, lease, `poolKey` and structured
errors. Reuse eligibility is an explicit, inspectable hash of
(image, resources, network, setup, credentials) rather than hidden engine behaviour.

## 9. Version config with no inheritance → explicit base + diff

**Reference platform**: `CreateAgentVersion` takes a full snapshot with **no inheritance** from the base
version. Omitting a field silently drops the capability.

**Ours**: versions are still immutable full snapshots (reproducibility demands it), but
creation accepts `baseVersion` and applies an explicit patch, and the API reports the
resulting diff so an accidental drop is visible before the write.

## 10. Absent operational affordances we ship

Present in the reference platform only as roadmap items or explicitly blocked operations:
- persisted, searchable run logs → **the event log, from day one**
- context compaction and archival → **`ContextPolicy` with snapshots**
- sandbox pre-warming → **prewarm pool in the broker**
- connector restore, schedule run-now / next-fire → **implemented**
- sub-agent management → **typed `subAgents` on the version**

---

## What we deliberately keep

Not everything differs. These choices in the reference platform are good, and we adopt them:

- **Immutable versions with pinned resolution** — a session is immune to concurrent edits.
- **Content-addressed capabilities (sha256)** across registry / upload / git sources.
- **Receipts with idempotency and a `zombie` state** for inbound deliveries. The zombie
  state in particular is a genuinely well-observed failure mode.
- **Write-only credentials with OOB device-code authorization** and an `expiry` sweep.
- **A/B fields on installed capabilities** — rolling a skill change to a slice of sessions
  is real operational need.
- **`plan → confirm → single write → readback`** as the mutation discipline, with no
  replay of an ambiguous write.
- **Two independent leases** (sandbox lease vs. session lease).
- **Session policy on triggers** (`new_per_event` / `reuse_per_scope` / `reuse_connector`).
- **Per-turn dynamic identity** (`permission_mode: dynamic`), so an agent acts with the
  requesting user's authority rather than a single service account.
