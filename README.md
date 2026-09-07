# Managed-Agent

A cloud platform for hosting, governing and observing autonomous agents.

It runs agent harnesses in isolated sandboxes, manages their session lifecycle and
context, brokers credentials and models, records every action as a replayable audit
event, and connects them to the outside world through uniform triggers.

The design is informed by a study of a mature production managed-agent platform;
[`docs/research/design-deltas.md`](docs/research/design-deltas.md) records where this
diverges and why.

---

## Why this exists

Teams building on agent harnesses keep rebuilding the same infrastructure: containers
and images, session state that survives a disconnect, an audit trail of what the agent
actually did, credential handling, and one integration path per trigger source. That
work is common to every agent and specific to none of them.

Managed-Agent is that layer. A team supplies a prompt, some skills and a permission
policy; the platform handles everything between "an event happened" and "an agent
finished working on it, and here is exactly what it did".

## Design tenets

These are load-bearing — every module traces back to one.

1. **The control plane is a broker, never a proxy.** It resolves a session to a runtime
   endpoint and mints a scoped token. Tool output and model tokens never transit it.
2. **Configuration is immutable and versioned; running work pins a version.** A session
   resolves its agent version once and is thereafter immune to edits.
3. **The event log is the source of truth.** Session state is a fold over an append-only,
   gap-free sequence. Resume, audit and time-travel debugging are one mechanism.
4. **Every write is a plan, a confirmation, one attempt, and a readback.** No mutation is
   silently replayed; an ambiguous outcome is reported as ambiguous.
5. **Every inbound trigger produces a receipt and is idempotent.** External systems retry;
   we deduplicate and expose the delivery's full fate.
6. **Secrets are write-only.** A credential value can be created and referenced, never read
   back through the API. Every access is audited.
7. **Failure is data.** Quota exhaustion and sandbox scheduling failures are structured
   fields on the resource, not log lines.
8. **Leases, not lifetimes.** Sandboxes and sessions hold independently renewable leases.
   Nothing is immortal by accident.

## Getting started

Requires Node 24+ and pnpm 9. There is no build step — Node runs the TypeScript directly.

```bash
pnpm install
pnpm check          # lint, typecheck, and the full test suite
pnpm dev            # start the platform
```

On first start with an empty database, a bootstrap admin is created and its token
printed once:

```
  A bootstrap admin was created because the store was empty.
  Token:   <shown once>
```

Then open <http://127.0.0.1:8080> for the console, or use the CLI:

```bash
export MA_URL=http://127.0.0.1:8080
export MA_TOKEN=<the token>

ma workspace create --name "Platform" --slug platform      # prints a plan
ma workspace create --name "Platform" --slug platform --yes # applies it

ma agent create --workspace ws_… --name Reviewer --spec ./agent.json --yes
ma session create --agent ag_… --yes
ma session watch --session sn_…
```

Mutations print a plan and change nothing without `--yes`. That is not a prompt to
click through; it is the whole discipline.

## Architecture

```
Console · CLI · SDK · Connectors
              │
        API Gateway            authn · authz · quota · idempotency · SSE
              │
           Engine              the resource graph and its state machines
       ┌──────┼──────┐
  Sandbox   Event    Scheduler
  Broker    Store    cron · leases · retries · reaping
       │
   Sandbox → Agent Core (the harness: main loop, tools, model calls)
```

| Package | Responsibility |
|---|---|
| `@ma/core` | ids, errors, clock, logging, retry, crypto |
| `@ma/contracts` | schemas, domain types, the event protocol, lifecycle machines |
| `@ma/store` | repository interfaces, migrations, the SQLite driver |
| `@ma/engine` | resource services, authorization, quota, the event bus |
| `@ma/sandbox` | the broker, leases, pooling, provider drivers |
| `@ma/runtime` | the agent harness: main loop, tools, context management |
| `@ma/gateway` | HTTP routing, middleware, resumable SSE |
| `@ma/connectors` | trigger adapters, the delivery pipeline, cron |
| `@ma/sdk` · `@ma/cli` · `@ma/console` | the surfaces |

Full detail: [`docs/architecture.md`](docs/architecture.md).

## Notable properties

**Resumable streaming.** Each SSE frame carries its event sequence as the frame `id`,
so a browser's native reconnect resumes exactly. The bridge replays history, buffers
what arrives during the replay, then hands over — no gap, no duplicate. A consumer that
falls behind is told the earliest surviving sequence and re-reads, rather than the
server buffering on its behalf.

**Isolation you can inspect.** Two sessions share a sandbox only when their pool key
matches, and that key is a hash of image, resources, network policy, setup commands and
the credential set. Reuse is a visible property rather than emergent broker behaviour.

**A permission engine that explains itself.** Deny always beats allow. Compound shell
commands are refused rather than parsed, because deciding what `git status; rm -rf /`
"really" runs is a losing game. Every denial names the rule that caused it, so the model
can choose a permitted route and an operator can fix the policy.

**Versions that cannot silently drop capabilities.** A new version merges a patch over
its base and returns the resulting diff, so an accidental omission is visible before
anything depends on it.

## Deliberately not included

No vertical workbench, no artifact pipeline, no heavy knowledge-base product. The
platform does the common, stable, reusable part well; domain knowledge and scenario
design belong to whoever is building on it.

## Development

```bash
pnpm test           # tests only
pnpm lint           # project-specific invariants
pnpm typecheck
```

Tests run against the real SQLite driver and a real HTTP server rather than mocks: the
behaviour worth testing is exactly what a mock would agree with and get wrong.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for standards and commit conventions.

## License

Apache-2.0
