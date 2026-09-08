/**
 * Connector and scheduler tests.
 *
 * Cron gets close attention because its failure mode is a job that silently
 * fires at the wrong time — or not at all — and nobody notices for a week.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryKeyProvider,
  MaError,
  TestClock,
  hmacSha256Hex,
  newId,
  nullLogger,
} from '@ma/core';
import type { Connector, Principal } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import {
  AgentService,
  CredentialService,
  EventBus,
  QuotaService,
  RoleAuthorizer,
  SessionService,
  WorkspaceService,
  type AuthContext,
  type SessionProvisioner,
} from '@ma/engine';

import {
  AdapterRegistry,
  DeliveryPipeline,
  Scheduler,
  chatAdapter,
  nextFireTime,
  parseCron,
  scheduleAdapter,
  webhookAdapter,
  type InboundRequest,
} from '../src/index.ts';

const START = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

describe('cron parsing', () => {
  test('parses the common shapes', () => {
    assert.deepEqual([...parseCron('0 9 * * *').hours], [9]);
    assert.deepEqual([...parseCron('*/15 * * * *').minutes], [0, 15, 30, 45]);
    assert.deepEqual([...parseCron('0 9-11 * * *').hours], [9, 10, 11]);
    assert.deepEqual([...parseCron('0 0 * * mon').daysOfWeek], [1]);
    assert.deepEqual([...parseCron('0 0 1 jan *').months], [1]);
  });

  test('treats 7 and 0 as Sunday', () => {
    assert.deepEqual([...parseCron('0 0 * * 7').daysOfWeek], [0]);
  });

  test('rejects malformed expressions', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '99 * * * *', '* 25 * * *', 'x * * * *']) {
      assert.throws(() => parseCron(bad), (error: unknown) => MaError.is(error), `${bad} should fail`);
    }
  });

  test('a bare value with a step means "from here onwards"', () => {
    assert.deepEqual([...parseCron('5/15 * * * *').minutes], [5, 20, 35, 50]);
  });
});

describe('cron scheduling', () => {
  /** Local wall-clock rendering, for readable assertions. */
  function inZone(instant: number, timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(instant));
  }

  test('finds the next daily fire', () => {
    const from = Date.UTC(2026, 0, 15, 8, 0);
    const next = nextFireTime('0 9 * * *', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '15/01/2026, 09:00');
  });

  test('rolls to tomorrow when today has passed', () => {
    const from = Date.UTC(2026, 0, 15, 10, 0);
    const next = nextFireTime('0 9 * * *', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '16/01/2026, 09:00');
  });

  test('never returns the instant it was asked from', () => {
    // Otherwise a schedule would re-fire for the minute it just fired in.
    const at = Date.UTC(2026, 0, 15, 9, 0);
    const next = nextFireTime('0 9 * * *', 'UTC', at)!;
    assert.ok(next > at);
  });

  test('honours the schedule timezone rather than UTC', () => {
    // 15 Jan 00:00 UTC is already 09:00 in Tokyo, so the next 09:00 local is
    // the following day — which is exactly the point: the field means local
    // wall-clock time, not a UTC hour.
    const from = Date.UTC(2026, 0, 15, 0, 0);
    const next = nextFireTime('0 9 * * *', 'Asia/Tokyo', from)!;
    assert.equal(inZone(next, 'Asia/Tokyo'), '16/01/2026, 09:00');
    assert.equal(inZone(next, 'UTC'), '16/01/2026, 00:00');
  });

  test('fires once on a fall-back day, not twice', () => {
    // Europe/London 2024-10-27: clocks go back at 02:00 BST to 01:00 GMT, so
    // 01:30 local happens twice. The search steps through absolute minutes and
    // matches local parts, so both instants matched and a nightly job ran
    // twice — and nothing downstream suppressed it, because the receipt dedupe
    // key is `${connectorId}:${firedAt}` and the two instants differ.
    //
    // A cron expression names a wall-clock time; a wall-clock time that occurs
    // twice is still one scheduled run.
    const fires: string[] = [];
    let from = Date.UTC(2024, 9, 26, 12, 0);
    for (let index = 0; index < 3; index++) {
      const next = nextFireTime('30 1 * * *', 'Europe/London', from)!;
      fires.push(new Date(next).toISOString());
      from = next;
    }

    const onTheDay = fires.filter((fire) => fire.startsWith('2024-10-27'));
    assert.deepEqual(onTheDay, ['2024-10-27T00:30:00.000Z'], `fired ${onTheDay.length} times`);
    // And the days either side are untouched.
    assert.equal(fires[1], '2024-10-28T01:30:00.000Z');
  });

  test('fall-back suppression is not specific to one zone', () => {
    // America/New_York goes back on a different date; the rule is about the
    // repeated local minute, not about a hard-coded transition.
    const next = nextFireTime('30 1 * * *', 'America/New_York', Date.UTC(2024, 10, 2, 12, 0))!;
    const after = nextFireTime('30 1 * * *', 'America/New_York', next)!;
    assert.equal(new Date(next).toISOString(), '2024-11-03T05:30:00.000Z');
    assert.equal(
      new Date(after).toISOString(),
      '2024-11-04T06:30:00.000Z',
      'the repeat at 06:30Z must be skipped, and the next day fires normally',
    );
  });

  test('a spring-forward day skips an hour that does not exist', () => {
    // The counterpart, and the reason the fix must not simply reject any
    // candidate near a transition: 02:30 never occurs on 2024-03-31 in London,
    // so the job should skip that day rather than fire at some nearby time.
    const next = nextFireTime('30 2 * * *', 'Europe/London', Date.UTC(2024, 2, 30, 12, 0))!;
    assert.equal(
      new Date(next).toISOString(),
      '2024-03-31T01:30:00.000Z',
      '02:30 BST on the transition day is 01:30 UTC — the hour is skipped, not invented',
    );
  });

  test('keeps local wall-clock time across a DST transition', () => {
    // The bug this guards: fixing a UTC offset at creation makes a 09:00 job
    // drift to 08:00 or 10:00 when the clocks change.
    const beforeDst = Date.UTC(2026, 2, 27, 12, 0); // late March, before EU DST
    const first = nextFireTime('0 9 * * *', 'Europe/London', beforeDst)!;
    assert.equal(inZone(first, 'Europe/London'), '28/03/2026, 09:00');

    const afterDst = nextFireTime('0 9 * * *', 'Europe/London', first)!;
    assert.equal(
      inZone(afterDst, 'Europe/London'),
      '29/03/2026, 09:00',
      'the local hour must stay 09:00 through the transition',
    );
    // And the two instants are 23 hours apart, not 24, because an hour vanished.
    assert.equal(afterDst - first, 23 * 60 * 60 * 1000);
  });

  test('ORs the day fields when both are restricted', () => {
    // The classic cron quirk: `0 0 1 * mon` means the 1st *and* every Monday.
    const from = Date.UTC(2026, 0, 2, 0, 0); // Friday 2 Jan
    const next = nextFireTime('0 0 1 * mon', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '05/01/2026, 00:00', 'the next Monday, not the next 1st');
  });

  test('ANDs nothing when only one day field is restricted', () => {
    const from = Date.UTC(2026, 0, 2, 0, 0);
    const next = nextFireTime('0 0 15 * *', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '15/01/2026, 00:00');
  });

  test('finds a rare date without giving up', () => {
    const from = Date.UTC(2026, 5, 1, 0, 0);
    const next = nextFireTime('0 0 29 2 *', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '29/02/2028, 00:00', 'the next leap year');
  });

  test('rejects an unknown timezone', () => {
    assert.throws(() => nextFireTime('0 9 * * *', 'Mars/Olympus', START));
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('delivery pipeline', () => {
  let store: SqliteStore;
  let clock: TestClock;
  let bus: EventBus;
  let pipeline: DeliveryPipeline;
  let sessions: SessionService;
  let scheduler: Scheduler;
  let credentials: CredentialService;
  let context: AuthContext;
  let workspaceId: string;
  let agentId: string;
  let principal: Principal;

  /** Sandbox ids released, so a test can prove an expiring session frees one. */
  let releasedSandboxes: string[] = [];

  const provisioner: SessionProvisioner = {
    provision: () =>
      Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 1 }),
    release: (session) => {
      if (session.sandboxId) releasedSandboxes.push(session.sandboxId);
      return Promise.resolve();
    },
    submit: () => Promise.resolve(),
  };

  beforeEach(async () => {
    releasedSandboxes = [];
    store = createMemoryStore();
    clock = new TestClock(START);
    bus = new EventBus(store, clock, nullLogger);

    principal = await store.principals.create({
      id: newId('principal'),
      type: 'user',
      subject: 'operator',
      displayName: 'Operator',
      email: '',
      isAdmin: false,
      disabled: false,
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'system',
    });
    context = { principal };

    const quota = new QuotaService(store, clock);
    const deps = { store, clock, quota, logger: nullLogger, authorizer: new RoleAuthorizer() };
    const workspaces = new WorkspaceService(deps);
    const agents = new AgentService(deps);
    sessions = new SessionService({ ...deps, bus, provisioner });
    credentials = new CredentialService({ ...deps, keys: InMemoryKeyProvider.generate() });

    const workspace = await workspaces.create(context, { name: 'Ops', slug: 'ops' });
    workspaceId = workspace.id;
    const agent = await agents.create(context, {
      workspaceId,
      name: 'Responder',
      spec: { model: { modelId: 'test/model' } },
    });
    agentId = agent.id;

    const adapters = new AdapterRegistry()
      .register(webhookAdapter({ clock }))
      .register(chatAdapter({ clock }))
      .register(scheduleAdapter());

    pipeline = new DeliveryPipeline({
      store,
      clock,
      adapters,
      sessions,
      credentials,
      logger: nullLogger,
    });

    scheduler = new Scheduler({ store, clock, pipeline, sessions, credentials, logger: nullLogger });
  });

  afterEach(async () => {
    await scheduler.stop();
    bus.closeAll();
    await store.close();
  });

  /** A connector with a signing secret, ready to receive. */
  async function makeWebhook(
    overrides: Partial<Connector> = {},
    secret = 'signing-secret',
  ): Promise<Connector> {
    // The same CredentialService the pipeline uses, so the secret is sealed and
    // unsealed under one key.
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'webhook secret',
      value: secret,
    });

    const now = clock.now();
    return store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'webhook',
      name: 'alerts',
      description: '',
      status: 'active',
      agentId,
      externalKey: `alerts-${Math.random().toString(36).slice(2, 8)}`,
      sessionPolicy: 'new_per_event',
      config: {},
      secretCredentialId: credential.id,
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
      ...overrides,
    });
  }

  /** A correctly signed inbound request. */
  function signedRequest(body: unknown, secret = 'signing-secret'): InboundRequest {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = clock.now();
    return {
      headers: {
        'x-ma-signature': hmacSha256Hex(secret, `${timestamp}.${raw.toString('utf8')}`),
        'x-ma-timestamp': String(timestamp),
      },
      rawBody: raw,
      body,
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: timestamp,
    };
  }

  test('accepts a correctly signed delivery', async () => {
    const connector = await makeWebhook();
    const result = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'investigate the alert', eventId: 'evt-1' }),
    );

    assert.equal(result.status, 'accepted');
    assert.equal(result.receipt?.status, 'pending');
    assert.equal(result.receipt?.externalEventId, 'evt-1');
  });

  test('rejects a forged signature without explaining why', async () => {
    const connector = await makeWebhook();
    const request = signedRequest({ prompt: 'hi' }, 'the-wrong-secret');
    const result = await pipeline.accept(workspaceId, connector.externalKey, request);

    assert.equal(result.status, 'rejected');
    // Telling an unauthenticated caller how their signature was wrong helps
    // them fix it.
    assert.equal(result.reason, 'verification failed');
  });

  test('rejects a replayed request once the timestamp is stale', async () => {
    const connector = await makeWebhook();
    const request = signedRequest({ prompt: 'hi', eventId: 'evt-1' });
    await clock.advance(10 * 60 * 1000);

    const result = await pipeline.accept(workspaceId, connector.externalKey, request);
    assert.equal(result.status, 'rejected');
  });

  test('refuses an unsigned connector rather than accepting anything', async () => {
    const connector = await makeWebhook({ secretCredentialId: undefined });
    const result = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi' }),
    );
    assert.equal(result.status, 'rejected');
  });

  test('a retried delivery returns the original receipt', async () => {
    // Source systems retry; a second agent run is the failure mode.
    const connector = await makeWebhook();
    const request = signedRequest({ prompt: 'investigate', eventId: 'evt-42' });

    const first = await pipeline.accept(workspaceId, connector.externalKey, request);
    const retry = await pipeline.accept(workspaceId, connector.externalKey, request);

    assert.equal(first.status, 'accepted');
    assert.equal(retry.status, 'duplicate');
    assert.equal(retry.receipt?.id, first.receipt?.id);
  });

  test('rejects a delivery to a disabled connector', async () => {
    const connector = await makeWebhook({ status: 'disabled' });
    const result = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi' }),
    );
    assert.equal(result.status, 'rejected');
    assert.ok(result.reason?.includes('disabled'));
  });

  test('processes a delivery into a session', async () => {
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'do the thing', eventId: 'evt-1' }),
    );

    // The session must be ready before it can accept a submission.
    const worked = await pipeline.processNext();
    assert.equal(worked, true);

    const receipts = await store.receipts.list({ connectorId: connector.id });
    const receipt = receipts.items[0]!;
    assert.ok(receipt.sessionId, 'a processed delivery records which session ran it');
  });

  test('reports no work rather than spinning', async () => {
    assert.equal(await pipeline.processNext(), false);
  });

  test('promotes an abandoned delivery to zombie, not failed', async () => {
    // We do not know whether the work happened, which is genuinely different
    // from knowing it failed.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-1' }),
    );
    await store.receipts.claimNext(clock.now(), clock.now() + 1000);
    await clock.advance(5000);

    const reaped = await pipeline.reapZombies();
    assert.equal(reaped.length, 1);
    const receipts = await store.receipts.list({ connectorId: connector.id });
    assert.equal(receipts.items[0]?.status, 'zombie');
  });

  test('a captured request replayed inside the tolerance window runs once', async () => {
    // The signature covers `timestamp.body` and is valid on a replay, because
    // it *is* the same request — so deduplication is the only thing that can
    // stop a second agent run. `externalEventId` used to fall back to a fresh
    // random id when the sender supplied none, which is the common shape for an
    // alerting webhook, so an identical signed delivery started two runs.
    const connector = await makeWebhook();
    const request = signedRequest({ prompt: 'disk is full on host-7' });

    const first = await pipeline.accept(workspaceId, connector.externalKey, request);
    const second = await pipeline.accept(workspaceId, connector.externalKey, request);

    assert.equal(first.status, 'accepted');
    assert.equal(second.status, 'duplicate', 'a byte-identical replay must not start a second run');
    assert.equal(second.receipt?.id, first.receipt?.id, 'it must land on the original receipt');

    const receipts = await store.receipts.list({ connectorId: connector.id });
    assert.equal(receipts.items.length, 1);
  });

  test('deduplication does not swallow genuinely different events', async () => {
    // The counterpart, and the more important one: a dedupe that drops real
    // alerts is worse than the duplicate run it prevents.
    const connector = await makeWebhook();

    const alertA = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'disk full on host-7' }),
    );
    const alertB = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'disk full on host-9' }),
    );
    assert.equal(alertA.status, 'accepted');
    assert.equal(alertB.status, 'accepted', 'a different alert must get through');

    // The same alert firing again later is a new event — the signature differs
    // because the timestamp does.
    await clock.advance(60_000);
    const repeat = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'disk full on host-7' }),
    );
    assert.equal(repeat.status, 'accepted', 'the same condition recurring must not be suppressed');

    assert.equal((await store.receipts.list({ connectorId: connector.id })).items.length, 3);
  });

  test('a reaped worker cannot resurrect its zombie receipt', async () => {
    // The bug: `#handleFailure` wrote status 'pending' with a raw update, no
    // status guard and no state-machine check. A worker that outlived its lease
    // — agent turns routinely exceed the 120s default — was reaped to `zombie`,
    // then its own failure path flipped the terminal receipt back to `pending`.
    // The same external event was claimed and delivered a second time.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-slow' }),
    );

    // A worker claims it, then stalls past its lease.
    const claimed = (await store.receipts.claimNext(clock.now(), clock.now() + 1000))!;
    await clock.advance(5000);
    await pipeline.reapZombies();
    assert.equal((await store.receipts.get(claimed.id))?.status, 'zombie');

    // The stalled worker now finishes and reports a retryable failure. Driven
    // through the real path: `processNext` re-claims nothing (the receipt is
    // terminal), so the failure is delivered by pointing the pipeline at the
    // stale copy the dead worker still holds — which is exactly what an
    // in-flight `#handleFailure` does when its `await` finally returns.
    await pipeline.reportFailure(
      claimed,
      new MaError({
        code: 'UPSTREAM_TIMEOUT',
        category: 'timeout',
        message: 'downstream took too long',
        retryable: true,
      }),
    );

    const after = await store.receipts.get(claimed.id);
    assert.equal(after?.status, 'zombie', 'a terminal receipt must stay terminal');

    // And nothing is claimable, so the event cannot run twice.
    assert.equal(
      await store.receipts.claimNext(clock.now(), clock.now() + 1000),
      undefined,
      'a reaped receipt must not be re-claimable',
    );
  });

  test('a retry creates a new receipt and leaves the original intact', async () => {
    const connector = await makeWebhook();
    const accepted = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-1' }),
    );
    const original = accepted.receipt!;
    await store.receipts.update(original.id, { status: 'failed' });

    const replay = await pipeline.retry(original.id, 'operator asked');
    assert.notEqual(replay.id, original.id);
    assert.equal(replay.status, 'pending');
    assert.equal(
      (await store.receipts.get(original.id))?.status,
      'failed',
      'the original attempt stays on the record',
    );
  });

  test('refuses to retry a delivery that is still running', async () => {
    const connector = await makeWebhook();
    const accepted = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-1' }),
    );
    await assert.rejects(
      pipeline.retry(accepted.receipt!.id, 'too early'),
      (error: unknown) => MaError.is(error) && error.code === 'RECEIPT_NOT_TERMINAL',
    );
  });

  test('activation runs the adapter’s own validation', async () => {
    // The defect this avoids: one integration's rules leaking into every
    // other type's activation path.
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'webhook',
      name: 'unsigned',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'unsigned-hook',
      sessionPolicy: 'new_per_event',
      config: {},
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    await assert.rejects(
      pipeline.activate(draft.id),
      (error: unknown) => MaError.is(error) && error.status === 400,
      'a webhook without a secret must not activate',
    );
  });

  test('a schedule activates on its own rules, not a webhook’s', async () => {
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'nightly',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'nightly-report',
      sessionPolicy: 'new_per_event',
      // No secret credential, which a webhook would require and a schedule
      // rightly does not.
      config: { cron: '0 2 * * *', timezone: 'UTC', prompt: 'produce the report' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    const activated = await pipeline.activate(draft.id);
    assert.equal(activated.status, 'active');
  });

  test('stop waits for an in-flight tick without starving the event loop', async () => {
    // `while (this.#ticking) await Promise.resolve()` spins on the microtask
    // queue, which starves macrotasks — so a tick waiting on I/O or a timer can
    // never finish and `stop` never returns. This runs in `platform.stop()`
    // before `store.close()`, so shutdown wedged with it.
    let released = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      released = resolve;
    });

    // A tick that parks on a macrotask, which is what real I/O looks like.
    const slow = new Scheduler({
      store,
      clock,
      pipeline,
      sessions,
      logger: nullLogger,
      onSandboxReap: () => blocked,
    });

    const ticking = slow.tick();
    // Let the tick reach the blocked hook.
    await Promise.resolve();

    const stopping = slow.stop();
    // Release on a macrotask: a microtask spin would never yield to this.
    setTimeout(released, 0);

    await stopping;
    await ticking;
  });

  test('a queued session is provisioned by the scheduler', async () => {
    // The platform accepted sessions and never ran them. `create` leaves a
    // session `queued`, `submit` refuses anything that is not `ready`, and
    // `SessionService.start` — which bridges the two — had no production
    // caller at all: grep found it in tests and in its own definition. So the
    // core loop, create a session and send it a prompt, did not work.
    //
    // Missed because engine tests call `start()` directly and the e2e test
    // asserted on session *creation* rather than on a session running.
    const session = await sessions.create(context, { agentId });
    assert.equal(session.status, 'queued');

    assert.equal(await scheduler.provisionQueued(), 1);

    const started = await store.sessions.get(session.id);
    assert.equal(started?.status, 'ready');
    assert.ok(started?.sandboxId, 'a provisioned session holds a sandbox');
  });

  test('the tick provisions, not just the method', async () => {
    // The original bug was not a broken `start()` — it was a correct `start()`
    // nothing called. A test that invokes `provisionQueued()` directly passes
    // whether or not the tick reaches it, so this drives `tick()` instead.
    const session = await sessions.create(context, { agentId });

    const report = await scheduler.tick();

    assert.equal(report.sessionsStarted, 1, 'a tick must provision queued sessions');
    assert.equal((await store.sessions.get(session.id))?.status, 'ready');
  });

  test('provisioning is bounded per tick', async () => {
    // One burst of sessions must not monopolise the loop that also fires
    // schedules and reaps zombies.
    for (let index = 0; index < 8; index++) {
      await sessions.create(context, { agentId });
    }

    assert.equal(await scheduler.provisionQueued(3), 3);
    assert.equal(
      (await store.sessions.list({ workspaceId, statuses: ['queued'] })).items.length,
      5,
      'the rest wait for the next tick',
    );
  });

  test('losing the provisioning race to another replica is not an error', async () => {
    // `start` transitions out of `queued` with a compare-and-set, so two
    // replicas seeing the same row produce one winner and one conflict. The
    // loser must carry on rather than treating a normal race as a failure.
    await sessions.create(context, { agentId });

    const other = new Scheduler({ store, clock, pipeline, sessions, logger: nullLogger });
    const [a, b] = await Promise.all([
      scheduler.provisionQueued(),
      other.provisionQueued(),
    ]);
    await other.stop();

    assert.equal(a + b, 1, 'exactly one replica may provision a given session');
  });

  /** Retention lives on the workspace quota, so a test sets it there. */
  async function setRetentionDays(days: number): Promise<void> {
    const workspace = (await store.workspaces.get(workspaceId))!;
    await store.workspaces.update(workspaceId, {
      quota: { ...workspace.quota, eventRetentionDays: days },
      updatedAt: clock.now(),
    });
  }

  test('the tick prunes events past their retention window', async () => {
    // `docs/operations.md` describes event retention as an operating behaviour,
    // and `events.prune` had no production caller — so every session log grew
    // forever. Driven through `tick()` rather than the method, because a test
    // calling `pruneExpiredEvents()` directly passes whether or not anything
    // reaches it, which is exactly how this shipped.
    await setRetentionDays(30);

    const session = await sessions.create(context, { agentId });
    // An event from well outside the window, written directly so its timestamp
    // is under the test's control.
    await store.events.append(session.id, [
      {
        id: newId('event'),
        sessionId: session.id,
        workspaceId,
        ts: clock.now() - 90 * 24 * 60 * 60 * 1000,
        type: 'message.completed',
        payload: { role: 'assistant', text: 'ancient' },
      } as never,
    ]);

    const before = (await store.events.read(session.id, {})).length;
    assert.ok(before >= 2, 'the session has both a fresh and an ancient event');

    const report = await scheduler.tick();
    assert.ok(report.eventsPruned > 0, 'a tick must prune expired events');

    // Truncated from the head, never leaving a hole: whatever survives must be
    // contiguous, or a resuming consumer would silently skip a range.
    const remaining = await store.events.read(session.id, {});
    const seqs = remaining.map((event) => event.seq);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_unused, index) => seqs[0]! + index),
      'the surviving log must be gap-free',
    );
  });

  test('retention is per workspace, not global', async () => {
    // The quota field is per workspace, so a workspace that keeps events longer
    // must not have them dropped on another workspace's schedule.
    await setRetentionDays(3650);

    const session = await sessions.create(context, { agentId });
    await store.events.append(session.id, [
      {
        id: newId('event'),
        sessionId: session.id,
        workspaceId,
        ts: clock.now() - 90 * 24 * 60 * 60 * 1000,
        type: 'message.completed',
        payload: { role: 'assistant', text: 'old but kept' },
      } as never,
    ]);

    const before = (await store.events.read(session.id, {})).length;
    await scheduler.pruneExpiredEvents();
    assert.equal(
      (await store.events.read(session.id, {})).length,
      before,
      'a long retention window must be honoured',
    );
  });

  test('a session whose sandbox was reaped goes back to provisioning', async () => {
    // The broker marks a sandbox lost and destroys it, but nothing told the
    // session — `handleSandboxLost` had no caller. A session whose environment
    // vanished sat in `ready` forever, pointing at a sandbox that no longer
    // existed, while the parity table claimed "a lost sandbox re-provisions".
    const session = await sessions.create(context, { agentId, ttlSeconds: 3600 });
    const ready = await sessions.start(session.id);
    assert.equal(ready.status, 'ready');

    await scheduler.recoverLostSandboxes([ready.sandboxId!]);

    const after = await store.sessions.get(session.id);
    assert.equal(after?.status, 'provisioning', 'an in-TTL session must try again');
  });

  test('a session past its TTL fails instead of re-provisioning', async () => {
    // Re-provisioning work nobody is waiting for burns capacity.
    const session = await sessions.create(context, { agentId, ttlSeconds: 60 });
    const ready = await sessions.start(session.id);
    await clock.advance(120_000);

    await scheduler.recoverLostSandboxes([ready.sandboxId!]);

    assert.equal((await store.sessions.get(session.id))?.status, 'failed');
  });

  test('the tick sweeps expired credentials', async () => {
    // `sweepExpiry` had no production caller, so a credential's `expiresAt` was
    // recorded and never acted on: an expired secret stayed active and an agent
    // kept exchanging it.
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      ownerId: workspaceId,
      type: 'api_key',
      name: 'short-lived',
      value: 'secret-value',
      expiresAt: clock.now() + 60_000,
    });
    assert.equal(credential.status, 'active');

    await clock.advance(120_000);
    const report = await scheduler.tick();

    assert.ok(report.credentialsExpired >= 1, 'the tick must expire it');
    assert.equal((await store.credentials.get(credential.id))?.status, 'expired');
  });

  test('a session stuck mid-shutdown is still reaped', async () => {
    // `terminating` is not terminal — it is the state a session sits in *while*
    // shutting down. The reaper excluded it, so a shutdown that died halfway (a
    // crashed control plane, a release that threw) left the session there
    // forever holding its quota slot, and the "every session reaches a terminal
    // state" guarantee was false for precisely the cases that needed it.
    const session = await sessions.create(context, { agentId, ttlSeconds: 60 });
    const ready = await sessions.start(session.id);
    await store.sessions.update(ready.id, { status: 'terminating', updatedAt: clock.now() });

    await clock.advance(120_000);
    assert.equal(await scheduler.expireSessions(), 1, 'a stuck session must be reaped');
    assert.equal((await store.sessions.get(session.id))?.status, 'terminated');
  });

  test('expiring a session releases its sandbox', async () => {
    // The TTL sweep drove the two status transitions directly, which skipped
    // the sandbox release entirely: the session reached `terminated` while its
    // environment kept running. That is the exact leak the method's own
    // docstring says it exists to prevent. The sandbox was reclaimed only later
    // by lease expiry — and if the lease outlived the TTL, it burned capacity
    // in between.
    const session = await sessions.create(context, {
      agentId,
      // Comfortably in the past by the time we sweep.
      ttlSeconds: 60,
    });
    const ready = await sessions.start(session.id);
    assert.ok(ready.sandboxId, 'the session holds a sandbox');

    await clock.advance(120_000);
    assert.equal(await scheduler.expireSessions(), 1, 'the session expired');

    const final = await store.sessions.get(session.id);
    assert.equal(final?.status, 'terminated');
    assert.deepEqual(
      releasedSandboxes,
      [ready.sandboxId],
      'the sandbox must be released, not left running',
    );
  });

  test('two replicas racing one due tick fire it exactly once', async () => {
    // The bug: `findDueSchedules` returned connectors without their
    // `next_fire_at`, so the scheduler re-read it with a separate query outside
    // the compare-and-set. Replica A claimed and advanced the time to tomorrow;
    // replica B then read the *already advanced* value and CAS'd
    // tomorrow → tomorrow, which matches. Both fired.
    //
    // Worse than a duplicate: the receipt's external event id is
    // `${connectorId}:${expected}`, so B minted tomorrow's receipt today and
    // tomorrow's legitimate run was silently deduplicated away. A nightly
    // report ran twice one night, then never again.
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'nightly-race',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'nightly-race',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await pipeline.activate(draft.id);
    // Activation alone does not arm the schedule; the API route calls this
    // immediately afterwards, so the test does too.
    await scheduler.scheduleNext(draft.id);

    // Wind forward past the next fire time so the schedule is due.
    const dueAt = store.connectors.nextFireAt(draft.id)!;
    await clock.setTime(dueAt + 1000);

    // A second scheduler over the same store is a second replica.
    const replicaB = new Scheduler({ store, clock, pipeline, sessions, logger: nullLogger });
    const [firedA, firedB] = await Promise.all([
      scheduler.fireDueSchedules(),
      replicaB.fireDueSchedules(),
    ]);
    await replicaB.stop();

    assert.equal(firedA + firedB, 1, 'exactly one replica may fire a given tick');

    const receipts = await store.receipts.list({ connectorId: draft.id });
    assert.equal(receipts.items.length, 1, 'one tick produces one receipt');

    // The receipt must be for the tick that was due, not for a future one — a
    // receipt minted ahead of time is what suppressed the next real run.
    assert.ok(
      receipts.items[0]!.externalEventId.endsWith(String(dueAt)),
      `receipt should be for the due tick ${dueAt}, got ${receipts.items[0]!.externalEventId}`,
    );

    // And the following day still fires rather than being deduplicated away.
    const nextDue = store.connectors.nextFireAt(draft.id)!;
    assert.ok(nextDue > dueAt, 'the schedule advanced');
    await clock.setTime(nextDue + 1000);
    assert.equal(await scheduler.fireDueSchedules(), 1, 'the next day must still fire');
    assert.equal((await store.receipts.list({ connectorId: draft.id })).items.length, 2);
  });

  test('refuses to activate a schedule with an invalid cron', async () => {
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'broken',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'broken-schedule',
      sessionPolicy: 'new_per_event',
      config: { cron: 'not a cron', timezone: 'UTC', prompt: 'x' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    // Caught at activation rather than at 2am when it fails to fire.
    await assert.rejects(pipeline.activate(draft.id));
  });

  test('refuses to activate a connector with no agent', async () => {
    const connector = await makeWebhook({ status: 'draft', agentId: undefined });
    await assert.rejects(
      pipeline.activate(connector.id),
      (error: unknown) => MaError.is(error) && error.code === 'CONNECTOR_HAS_NO_AGENT',
    );
  });

  test('an archived connector can be restored', async () => {
    // The reference platform blocked this, forcing operators to recreate
    // connectors and lose their delivery history.
    const connector = await makeWebhook({ status: 'archived' });
    const restored = await store.connectors.update(connector.id, { status: 'draft' });
    assert.equal(restored.status, 'draft');
  });
});

// ---------------------------------------------------------------------------
// Chat adapter
// ---------------------------------------------------------------------------

describe('chat adapter', () => {
  const clock = new TestClock(START);
  const adapter = chatAdapter({ clock });
  const connector = { id: 'cn_1', name: 'bot' } as Connector;

  function request(body: unknown): InboundRequest {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return {
      headers: {},
      rawBody: raw,
      body,
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: clock.now(),
    };
  }

  test('answers a platform challenge without creating a delivery', async () => {
    const result = await adapter.verify(request({ challenge: 'abc123' }), connector, 'secret');
    assert.equal(result.ok, true);
    assert.deepEqual(result.immediateResponse, { status: 200, body: { challenge: 'abc123' } });
  });

  test('ignores the bot’s own messages', async () => {
    // Otherwise the bot replies to itself, forever.
    const trigger = await adapter.normalize(
      request({ event: { text: 'hello', chatId: 'c1', senderId: 'bot-1', botId: 'bot-1' } }),
      connector,
    );
    assert.equal(trigger, undefined);
  });

  test('ignores an empty message', async () => {
    const trigger = await adapter.normalize(
      request({ event: { text: '   ', chatId: 'c1', senderId: 'u1' } }),
      connector,
    );
    assert.equal(trigger, undefined);
  });

  test('scopes a conversation by chat id', async () => {
    const trigger = await adapter.normalize(
      request({ event: { text: 'help me', chatId: 'chat-9', senderId: 'u1', messageId: 'm1' } }),
      connector,
    );
    assert.equal(trigger?.scopeType, 'chat');
    assert.equal(trigger?.scopeKey, 'chat-9');
    assert.equal(trigger?.externalEventId, 'm1');
  });

  test('does not put the chat id in the operator-facing label', async () => {
    const trigger = await adapter.normalize(
      request({ event: { text: 'hi', chatId: 'private-chat-id', senderId: 'u1' } }),
      connector,
    );
    assert.equal(trigger?.scopeLabel.includes('private-chat-id'), false);
  });
});

// ---------------------------------------------------------------------------
// Schedule adapter
// ---------------------------------------------------------------------------

describe('schedule adapter', () => {
  test('refuses inbound HTTP entirely', async () => {
    // A schedule endpoint that accepted requests would be an unauthenticated
    // way to trigger someone's nightly job.
    const adapter = scheduleAdapter();
    const result = await adapter.verify(
      {
        headers: {},
        rawBody: Buffer.alloc(0),
        body: {},
        query: new URLSearchParams(),
        sourceIp: '',
        receivedAt: START,
      },
      {} as Connector,
      'secret',
    );
    assert.equal(result.ok, false);
  });
});
