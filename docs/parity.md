# Capability parity

An honest accounting against the reference platform's own capability matrix.
"Delivered" there is what its documentation lists as shipped; "planned" is what
it lists as roadmap.

---

## Triggers

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Chat bot | delivered | ✅ | Adapter interface; a platform-specific `send` is the only per-vendor code |
| Webhook | delivered | ✅ | HMAC over `timestamp.body`, replay-bounded |
| Cron schedule | delivered | ✅ | Five-field parser, DST-correct, run-now and next-fire |
| Event subscription | delivered | ◐ | Adapter interface exists; no broker client ships |
| SDK | planned | ✅ | Typed TS client, self-resuming streams |
| CLI | planned | ✅ | Full resource coverage, plan/confirm/readback |
| OpenAPI | planned | ✅ | Generated from the validating schemas |

## Agent management

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Workspace / Agent / Session | delivered | ✅ | |
| Version control | delivered | ✅ | Plus patch-merge with a returned diff |
| Skills and MCP install | delivered | ✅ | Content-addressed; registry, upload and Git resolvers |
| Permission management | delivered | ✅ | Roles, scopes, per-tool and per-command policy; every route names its action |
| Dependency configuration | delivered | ✅ | Typed `setupCommands` rather than JSON in a string |
| Knowledge base | delivered | ✅ | BM25 retrieval, exposed as a tool and wired per session |
| SubAgent management | planned | ✅ | Scoped delegation; a child's tools are a subset of its parent's |
| Memory | planned | ✅ | Workspace and agent scope; agent-written memories cannot reach the system prompt |
| Artifact storage | planned | ✅ | Content-addressed, deduplicated, quota-charged, retention-swept |
| Artifact preview | planned | ✗ | Downloads only — see below on why rendering is not offered |
| Agent templates | planned | ✗ | Not built |

## Sessions

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Resume | delivered | ✅ | Exact, via gap-free sequences |
| Renewal | delivered | ✅ | Independent session and sandbox leases |
| Persistence and recovery | delivered | ✅ | Context snapshots; a lost sandbox re-provisions |
| Sandbox reuse | delivered | ✅ | Pool key over image, resources, network, setup, credentials |
| Terminal-state guarantee | planned | ✅ | Expiry reaper drives every session to a terminal state |

## Runtime

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Agent harness | delivered | ✅ | Main loop, tool dispatch, interruption, bounded iterations |
| SSE resume | delivered | ✅ | Sequence-based rather than timestamp-based |
| Startup scripts | delivered | ✅ | Typed, with per-command timeouts |
| Multiple runtimes | planned | ◐ | One harness; the model client is pluggable |
| Context compaction | planned | ✅ | Two strategies, cheapest first |
| Hot upgrade | planned | ✗ | Not built |

## Sandbox

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Image and dependency install | delivered | ✅ | Via the spec and setup commands |
| Volume mounts | delivered | ◐ | Typed on the spec; only the local driver honours them |
| Renewal, recovery, state sync | delivered | ✅ | Lease heartbeats; the reaper confirms before writing off |
| Prewarming | planned | ✅ | Configurable per pool |
| Container isolation | delivered | ✅ | Container driver (Docker/Podman/nerdctl) with enforced limits |

## Credentials

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Model, env var and file credentials | delivered | ✅ | Envelope-encrypted, AAD-bound, write-only |
| Model gateway | delivered | ✅ | Catalogue, per-workspace allowlist, usage and cost |
| Expiry sweep | delivered | ✅ | Marks expiring before it expires |
| Third-party SSO integrations | delivered | ✗ | Deployment-specific by nature |

## Observability

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Live results | delivered | ✅ | |
| Persisted, searchable run logs | planned | ✅ | The event log, from day one |
| Full event production and replay | planned | ✅ | 38 typed event types |
| Audit trail | — | ✅ | Separate, longer retention, with reasons |

---

## What is genuinely missing

Three things, listed because a parity claim that hides them is not worth much.

**A Kubernetes driver.** The container driver covers a single host with real
isolation — enforced CPU and memory limits, dropped capabilities, a read-only
root, kernel-enforced network denial. Scheduling across a cluster is a different
problem and is not solved here; the driver interface is the seam where it would
go.

**Per-host egress filtering.** `network.egress` is all-or-nothing: `deny` (and
an allowlist naming no hosts) gets `--network none`, `allow` gets bridge
networking, and an allowlist naming actual hosts refuses to provision rather
than pretending. Honouring it needs a filtering proxy or a CNI plugin. This is
listed as missing rather than delivered because the schema has always accepted
the field — it just never enforced it, and silently granting full networking to
a config that reads as restricted was the worst of the three options.

**Artifact preview.** Artifacts can be stored and downloaded, but never
rendered. The content type is sniffed from the bytes rather than taken from the
uploading agent, and can only ever be something a browser will not execute;
downloads carry `nosniff`, `attachment` and a sandbox CSP. That is deliberate
and not a stopgap: the console is served from the same origin as the API, so an
agent-authored page rendered there would run with the operator's session. A
preview feature needs a separate origin before it needs anything else, and
shipping it without one would be the "control that reads as enforced and is
not" this codebase keeps refusing to build.

**Agent templates.** Designed, then cut. An adversarial review of the design
argued it was the largest of the four features, changed `agentVersionSchema` —
the immutable contract reproducibility rests on — and delivered least: the
honest alternative is a documented JSON spec file with `ma agent create --spec`,
which already works and is now in the README. Build the catalogue when there is
a catalogue to fill.

## What adversarial review found

Worth recording, because "560 tests pass" is not the same claim as "this is
correct", and the gap between them was large.

With ~525 tests green, adversarial review and hands-on use found **twenty-nine**
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
and the behaviour is wrong in a way only observable by running it. Nine of these
were found by attacking a live server rather than reading source.

The pattern is consistent enough to state plainly. Tests written by whoever
wrote the code encode the same assumptions as the code, so they confirm the
intended path and are blind to everything else. The runtime bridge is the
clearest case — fully unit-tested, and completely unreachable in production,
because nothing ever called `bind()`. Adversarial review and hands-on use find
what a suite structurally cannot.

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
