# Capability parity

An honest accounting against the reference platform's own capability matrix.
"Delivered" there is what its documentation lists as shipped; "planned" is what
it lists as roadmap.

---

## Triggers

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Chat bot | delivered | ◐ | Inbound delivery works; replying needs the pipeline to await a turn — see the note on `respond` |
| Webhook | delivered | ✅ | HMAC over `timestamp.body`, replay-bounded |
| Cron schedule | delivered | ✅ | Five-field parser, DST-correct in both directions, run-now and next-fire |
| Event subscription | delivered | ✗ | `eventbus` is an accepted type with no adapter — activation always fails |
| SDK | planned | ✅ | Typed TS client, self-resuming streams |
| CLI | planned | ◐ | Workspace, agent, session (incl. renew), credential, artifact, memory. No connector, dataset or audit commands |
| OpenAPI | planned | ◐ | Entity schemas generated and path coverage enforced; request bodies are hand-written and have drifted |

## Agent management

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Workspace / Agent / Session | delivered | ✅ | |
| Version control | delivered | ✅ | Plus patch-merge with a returned diff |
| Skills and MCP install | delivered | ◐ | Registry and upload wired; Git resolver unwired; nothing launches an MCP server |
| Permission management | delivered | ✅ | Roles, scopes, per-tool and per-command policy; every route names its action |
| Dependency configuration | delivered | ✅ | Typed `setupCommands`, run by the agent core before the first turn |
| Knowledge base | delivered | ✅ | BM25 retrieval, exposed as a tool; uploaded documents are ingested and retrievable |
| SubAgent management | planned | ✅ | Scoped delegation; a child's tools are a subset of its parent's |
| Memory | planned | ✅ | Workspace and agent scope; agent-written memories cannot reach the system prompt |
| Artifact storage | planned | ✅ | Content-addressed, deduplicated, quota-charged, retention-swept |
| Artifact preview | planned | ✗ | Downloads only — see below on why rendering is not offered |
| Agent templates | planned | ✗ | Not built |

## Sessions

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Resume | delivered | ✅ | Exact, via gap-free sequences |
| Renewal | delivered | ✅ | Independent session and sandbox leases; `POST /v1/sessions/:id/renew` |
| Persistence and recovery | delivered | ◐ | A lost sandbox re-provisions inside its TTL; context snapshots store a digest, not the bytes |
| Sandbox reuse | delivered | ✅ | Pool key over image, resources, network, setup, credentials |
| Terminal-state guarantee | planned | ✅ | Expiry reaper drives every session to a terminal state, including one stuck mid-shutdown |

## Runtime

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Agent harness | delivered | ✅ | Main loop, tool dispatch, interruption, bounded iterations — run by `apps/agent-core` |
| SSE resume | delivered | ✅ | Sequence-based rather than timestamp-based |
| Startup scripts | delivered | ✅ | Typed, ordered, with a per-command timeout and an optional flag |
| Multiple runtimes | planned | ◐ | One harness; the model client is pluggable |
| Context compaction | planned | ✅ | Two strategies, cheapest first |
| Hot upgrade | planned | ✗ | Not built |

## Sandbox

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Image and dependency install | delivered | ✅ | Via the spec and setup commands |
| Volume mounts | delivered | ✗ | Not built — the sandbox spec has no mounts field |
| Renewal, recovery, state sync | delivered | ✅ | Lease heartbeats; the reaper confirms before writing off |
| Prewarming | planned | ✗ | Implemented but deliberately unwired — warming needs a policy for *when*, not just a method |
| Container isolation | delivered | ✅ | Container driver (Docker/Podman/nerdctl) with enforced limits |

## Credentials

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Model, env var and file credentials | delivered | ✅ | Envelope-encrypted, AAD-bound, write-only |
| Model gateway | delivered | ✅ | Catalogue, per-workspace allowlist, usage and cost; provider injected at build |
| Expiry sweep | delivered | ✅ | Runs on the scheduler tick, per workspace |
| Third-party SSO integrations | delivered | ✗ | Deployment-specific by nature |

## Observability

| Capability | Reference | Here | Notes |
|---|---|---|---|
| Live results | delivered | ✅ | |
| Persisted run logs | planned | ✅ | The event log. Not searchable: filters are sequence, type and turn |
| Full event production and replay | planned | ✅ | 38 typed event types |
| Audit trail | — | ◐ | Separate, with reasons. "Longer retention" is just never pruned |

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
