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
  systemClock,
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
  eventBusAdapter,
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
  /** Session ids a prompt was submitted to, so a test can prove delivery ran. */
  let submittedSessions: string[] = [];
  /** Optional hook a race test uses to block inside provision(). */
  let gatedProvision: (() => Promise<void>) | undefined;
  /** When set, provisioner.submit throws, to drive the submit-failure path. */
  let submitError: Error | undefined;

  const provisioner: SessionProvisioner = {
    provision: async () => {
      if (gatedProvision) await gatedProvision();
      return { sandboxId: newId('sandbox'), reused: false, provisionMs: 1 };
    },
    release: (session) => {
      if (session.sandboxId) releasedSandboxes.push(session.sandboxId);
      return Promise.resolve();
    },
    submit: (session) => {
      if (submitError) return Promise.reject(submitError);
      submittedSessions.push(session.id);
      return Promise.resolve();
    },
    rebind: () => Promise.resolve(true),
  };

  beforeEach(async () => {
    releasedSandboxes = [];
    submittedSessions = [];
    gatedProvision = undefined;
    submitError = undefined;
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
      .register(eventBusAdapter({ clock }))
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

  test('a new_per_event delivery actually succeeds, not just records a session', async () => {
    // The silent-success bug: `new_per_event` creates a fresh session, which
    // `create` leaves `queued`, then submits to it immediately. `submit` refuses
    // anything not `ready`, so the delivery threw INVALID_STATE_TRANSITION (a
    // non-retryable precondition error) and the receipt failed permanently — for
    // EVERY default-policy delivery. The earlier test missed it because it
    // asserted only that a sessionId was recorded (written before the submit) and
    // that processNext returned true (it does, even when the delivery throws).
    // This asserts the receipt reaches `succeeded` and the prompt was delivered.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'do the thing', eventId: 'evt-1' }),
    );

    const worked = await pipeline.processNext();
    assert.equal(worked, true);

    const receipts = await store.receipts.list({ connectorId: connector.id });
    const receipt = receipts.items[0]!;
    assert.equal(receipt.status, 'succeeded', 'the delivery must actually run, not fail');
    assert.ok(receipt.sessionId, 'a processed delivery records which session ran it');
    assert.deepEqual(submittedSessions, [receipt.sessionId], 'the prompt reached the session');

    const session = await store.sessions.get(receipt.sessionId!);
    assert.ok(
      ['ready', 'running', 'idle'].includes(session!.status),
      `the session must be live to accept the prompt, was ${session!.status}`,
    );
  });

  test('a delivery that loses the provisioning race still succeeds, not fails', async () => {
    // Multi-replica race the single-flight path cannot reach in one process. A
    // scheduler tick on another replica can win the `queued→provisioning`
    // compare-and-set for the very session a delivery just created, and the
    // winner then sits inside the slow `provision()`. The delivery's own `start`
    // loses the CAS and, on re-read, sees the session still `provisioning` — the
    // peer is mid-flight, not done. The first fix rethrew that as a non-retryable
    // `conflict`, permanently failing the delivery while the peer's session was
    // left holding a sandbox until TTL. `#ready` must instead wait for the peer
    // to bring the session live and then submit to it.
    //
    // Reproduced deterministically by wrapping `sessions.start` so the first call
    // behaves exactly as a lost race does: the row is moved to `provisioning` (as
    // the winning peer's CAS would), `start` throws `conflict`, and the row is
    // driven to `ready` shortly after — which the delivery must wait for.
    let startCalls = 0;
    let peerReady: Promise<unknown> = Promise.resolve();
    const racingSessions = new Proxy(sessions, {
      get(target, prop, receiver) {
        if (prop === 'start') {
          return async (sessionId: string) => {
            startCalls++;
            if (startCalls === 1) {
              // The peer wins the CAS: move to provisioning now, and finish it
              // live a little later (so the losing caller's *first* re-read still
              // sees `provisioning` — the exact state the bug mishandled). Then
              // report the conflict our caller lost.
              await target.transition(sessionId, 'queued', 'provisioning', {
                event: { type: 'sandbox.provisioning', payload: { provider: 'peer', poolKey: '' } },
              });
              peerReady = new Promise((resolve) => {
                setTimeout(() => {
                  const sandboxId = newId('sandbox');
                  resolve(
                    target.transition(sessionId, 'provisioning', 'ready', {
                      patch: { sandboxId },
                      event: {
                        type: 'session.ready',
                        payload: { sandboxId, provisionMs: 1, reused: false },
                      },
                    }),
                  );
                }, 20);
              });
              throw new MaError({
                code: 'CONFLICT',
                category: 'conflict',
                message: 'Session status changed concurrently',
              });
            }
            return Reflect.get(target, prop, receiver).call(target, sessionId);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SessionService;

    // A real clock so `#awaitReady`'s bounded poll actually elapses; the session
    // service still uses the describe clock for its (sleep-free) transitions.
    const racingPipeline = new DeliveryPipeline({
      store,
      clock: systemClock,
      adapters: new AdapterRegistry().register(webhookAdapter({ clock })),
      sessions: racingSessions,
      credentials,
      logger: nullLogger,
      readyPollMs: 5,
      readyWaitMs: 5000,
    });

    const connector = await makeWebhook();
    await racingPipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'race me', eventId: 'evt-race' }),
    );

    const worked = await racingPipeline.processNext();
    assert.equal(worked, true);

    const receipts = await store.receipts.list({ connectorId: connector.id });
    const receipt = receipts.items[0]!;
    assert.equal(
      receipt.status,
      'succeeded',
      `losing the CAS must not fail the delivery, was ${receipt.status}`,
    );
    assert.ok(receipt.sessionId, 'the delivery records the (peer-provisioned) session');
    assert.deepEqual(submittedSessions, [receipt.sessionId], 'the prompt still reached the session');
    const session = await store.sessions.get(receipt.sessionId!);
    assert.ok(
      ['ready', 'running', 'idle'].includes(session!.status),
      `the peer-provisioned session must be live, was ${session!.status}`,
    );
    // Settle the peer's out-of-band transition so it cannot fire after teardown.
    await peerReady;
  });

  test('a submit failure on a freshly-created session releases its sandbox', async () => {
    // Angle-2 leak the provisioning fix introduced: a `new_per_event` delivery now
    // provisions a sandbox before submitting. If the submit then throws, nothing
    // else references that session, so its sandbox must be released now rather than
    // orphaned until the 24h TTL reaper. A *reused* session is shared and must not
    // be torn down — that case is covered by the reuse tests staying green.
    submitError = new MaError({
      code: 'INTERNAL',
      category: 'internal',
      message: 'submit blew up',
    });
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'will fail at submit', eventId: 'evt-submit-fail' }),
    );

    const worked = await pipeline.processNext();
    assert.equal(worked, true);

    const receipts = await store.receipts.list({ connectorId: connector.id });
    const receipt = receipts.items[0]!;
    assert.equal(receipt.status, 'failed', 'the submit failure fails the delivery');
    assert.equal(releasedSandboxes.length, 1, 'the orphaned sandbox must be released, not leaked');
    const session = await store.sessions.get(receipt.sessionId!);
    assert.ok(
      session && ['terminating', 'terminated', 'failed'].includes(session.status),
      `the created session must be torn down, was ${session?.status}`,
    );
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

  test('an event subscription can be activated and accepts a filtered delivery', async () => {
    // This connector type was accepted by the schema but had no adapter, so
    // activation always failed with UNKNOWN_CONNECTOR_TYPE — a broken promise.
    // With the adapter registered it activates and routes a matching event.
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'bus secret',
      value: 'bus-secret',
    });
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'eventbus',
      name: 'orders',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'orders-feed',
      sessionPolicy: 'new_per_event',
      config: { eventTypes: ['order.created'], promptTemplate: 'handle {{type}}: {{data}}' },
      secretCredentialId: credential.id,
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    const activated = await pipeline.activate(draft.id);
    assert.equal(activated.status, 'active');

    // A matching event is accepted and creates a receipt.
    const raw = Buffer.from(
      JSON.stringify({ id: 'ord-1', type: 'order.created', source: 'shop', data: { id: 7 } }),
      'utf8',
    );
    const ts = clock.now();
    const matched = await pipeline.accept(workspaceId, 'orders-feed', {
      headers: {
        'x-ma-signature': hmacSha256Hex('bus-secret', `${ts}.${raw.toString('utf8')}`),
        'x-ma-timestamp': String(ts),
      },
      rawBody: raw,
      body: { id: 'ord-1', type: 'order.created', source: 'shop', data: { id: 7 } },
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: ts,
    });
    assert.equal(matched.status, 'accepted');
    assert.equal(matched.receipt?.externalEventId, 'ord-1');

    // An event of a type the subscription did not ask for is ignored, not run.
    const otherRaw = Buffer.from(
      JSON.stringify({ id: 'ord-2', type: 'order.deleted', source: 'shop' }),
      'utf8',
    );
    const ots = clock.now();
    const ignored = await pipeline.accept(workspaceId, 'orders-feed', {
      headers: {
        'x-ma-signature': hmacSha256Hex('bus-secret', `${ots}.${otherRaw.toString('utf8')}`),
        'x-ma-timestamp': String(ots),
      },
      rawBody: otherRaw,
      body: { id: 'ord-2', type: 'order.deleted', source: 'shop' },
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: ots,
    });
    assert.equal(ignored.status, 'ignored');
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

  /** Write an audit row at a chosen age, so retention is under test control. */
  async function appendAudit(ageDays: number, action = 'test.marker'): Promise<void> {
    await store.audit.append({
      id: newId('auditEntry'),
      workspaceId,
      principalId: principal.id,
      action,
      resourceKind: 'session',
      resourceId: newId('session'),
      outcome: 'allowed',
      reason: '',
      requestId: '',
      sourceIp: '',
      details: {},
      at: clock.now() - ageDays * 24 * 60 * 60 * 1000,
    });
  }

  /** Count audit rows this test wrote, ignoring seed history (workspace/agent create). */
  async function markerCount(): Promise<number> {
    const page = await store.audit.list({ workspaceId, action: 'test.marker' });
    return page.items.length;
  }

  test('the tick prunes audit rows past the retention window', async () => {
    // `audit.prune` was fully implemented with no production caller, so the
    // trail grew forever. Driven through `tick()` rather than the method, for
    // the same reason as the event-prune test: a direct call passes whether or
    // not anything reaches it.
    const pruning = new Scheduler({
      store,
      clock,
      pipeline,
      sessions,
      logger: nullLogger,
      auditRetentionDays: 30,
    });

    await appendAudit(90); // outside the window
    await appendAudit(1); // inside it
    assert.equal(await markerCount(), 2, 'both marker rows exist before the sweep');

    const report = await pruning.tick();
    await pruning.stop();
    assert.ok(report.auditPruned >= 1, 'a tick must prune the expired row');

    // The in-window marker survives; the 90-day-old one is gone.
    assert.equal(await markerCount(), 1, 'only the in-window marker survives');
  });

  test('audit pruning is off by default, keeping the trail forever', async () => {
    // A compliance log must not be deleted unless an operator has chosen a
    // window. The shared scheduler is built with no retention set.
    await appendAudit(3650); // ten years old

    const pruned = await scheduler.pruneExpiredAudit();
    assert.equal(pruned, 0, 'no window means nothing is pruned');
    assert.equal(await markerCount(), 1, 'the ancient marker is still there');
  });

  test('a survivable audit-prune failure does not take the tick down', async () => {
    // One failed sweep must retry next tick, not crash the loop that also fires
    // schedules and reaps zombies.
    const failing = new Scheduler({
      store,
      clock,
      pipeline,
      sessions,
      logger: nullLogger,
      auditRetentionDays: 30,
    });
    const original = store.audit.prune.bind(store.audit);
    store.audit.prune = () => Promise.reject(new Error('database is busy'));
    try {
      const pruned = await failing.pruneExpiredAudit();
      assert.equal(pruned, 0, 'a failed sweep reports nothing pruned rather than throwing');
    } finally {
      store.audit.prune = original;
      await failing.stop();
    }
  });

  test('the tick prunes idempotency keys past their expiry', async () => {
    // `idempotency.prune` was fully implemented with no production caller, so the
    // idempotency_keys table grew forever. Driven through `tick()` rather than the
    // method directly, for the same reason as the event- and audit-prune tests: a
    // direct call passes whether or not anything reaches it.
    //
    // A key carries its own TTL, so no retention policy is needed — an expired key
    // is dead weight. Reserve one with a tiny TTL, let the clock pass it, and a
    // tick must reclaim it.
    const now = clock.now();
    await store.idempotency.reserve('expired-key', 'test-scope', now - 10_000, 1_000); // expired 9s ago
    await store.idempotency.reserve('live-key', 'test-scope', now, 3_600_000); // an hour out

    const report = await scheduler.tick();
    await scheduler.stop();
    assert.ok(report.idempotencyPruned >= 1, 'a tick must prune the expired key');

    // The expired key is gone (reserving it again succeeds cleanly as a fresh
    // claim); the live one is still held.
    const reExpired = await store.idempotency.reserve('expired-key', 'test-scope', clock.now(), 1_000);
    assert.equal(reExpired.reserved, true, 'the pruned key is free to reserve afresh');
    const stillHeld = await store.idempotency.reserve('live-key', 'test-scope', clock.now(), 1_000);
    assert.equal(stillHeld.reserved, false, 'the unexpired key is untouched by the sweep');
  });

  test('a survivable idempotency-prune failure does not take the tick down', async () => {
    const original = store.idempotency.prune.bind(store.idempotency);
    store.idempotency.prune = () => Promise.reject(new Error('database is busy'));
    try {
      const pruned = await scheduler.pruneExpiredIdempotency();
      assert.equal(pruned, 0, 'a failed sweep reports nothing pruned rather than throwing');
    } finally {
      store.idempotency.prune = original;
    }
  });

  test('a session whose sandbox was reaped goes back to the queue', async () => {
    // The broker marks a sandbox lost and destroys it, but nothing told the
    // session — `handleSandboxLost` had no caller. A session whose environment
    // vanished sat in `ready` forever, pointing at a sandbox that no longer
    // existed, while the parity table claimed "a lost sandbox re-provisions".
    // Recovery returns it to `queued` so it re-provisions through the one atomic
    // claim the queue already has, not a second racy path.
    const session = await sessions.create(context, { agentId, ttlSeconds: 3600 });
    const ready = await sessions.start(session.id);
    assert.equal(ready.status, 'ready');

    await scheduler.recoverLostSandboxes([ready.sandboxId!]);

    const after = await store.sessions.get(session.id);
    assert.equal(after?.status, 'queued', 'an in-TTL session must try again');
    assert.equal(after?.sandboxId, undefined, 'and it no longer points at the lost sandbox');
  });

  test('a recovered session is actually re-provisioned, not stranded', async () => {
    // Returning to the queue is only half the recovery; the provisioning sweep
    // must then bring it back to `ready` with a *new* sandbox. Before, recovery
    // moved the session to `provisioning` where `provisionQueued` (which reads
    // only `queued`) never looked, so it sat there forever — recovered in name,
    // dead in fact.
    const session = await sessions.create(context, { agentId, ttlSeconds: 3600 });
    const ready = await sessions.start(session.id);
    const originalSandbox = ready.sandboxId!;

    await scheduler.recoverLostSandboxes([originalSandbox]);
    assert.equal(
      (await store.sessions.get(session.id))?.status,
      'queued',
      'precondition: recovery re-queued it',
    );

    const provisioned = await scheduler.provisionQueued();
    assert.equal(provisioned, 1, 'the sweep must re-provision the recovering session');

    const recovered = await store.sessions.get(session.id);
    assert.equal(recovered?.status, 'ready', 'the session is live again');
    assert.ok(recovered?.sandboxId, 'it holds a sandbox');
    assert.notEqual(
      recovered?.sandboxId,
      originalSandbox,
      'and it is a fresh sandbox, not the lost one',
    );
  });

  test('two replicas re-provisioning one recovered session provision it once', async () => {
    // The race the recover-to-queue design exists to prevent: recovery via
    // `provisioning` had no claim before the expensive provision() call, so two
    // scheduler replicas could each acquire a sandbox for one session. Through
    // the queue, `start()`'s queued→provisioning compare-and-set is the claim —
    // one replica wins, the other conflicts, and exactly one sandbox is taken.
    const session = await sessions.create(context, { agentId, ttlSeconds: 3600 });
    const ready = await sessions.start(session.id);
    await scheduler.recoverLostSandboxes([ready.sandboxId!]);
    assert.equal((await store.sessions.get(session.id))?.status, 'queued');

    const replicaB = new Scheduler({ store, clock, pipeline, sessions, logger: nullLogger });
    const before = releasedSandboxes.length;
    const [a, b] = await Promise.all([
      scheduler.provisionQueued(),
      replicaB.provisionQueued(),
    ]);
    await replicaB.stop();

    assert.equal(a + b, 1, 'exactly one replica provisions the recovered session');
    const recovered = await store.sessions.get(session.id);
    assert.equal(recovered?.status, 'ready');
    assert.equal(
      releasedSandboxes.length,
      before,
      'no orphaned sandbox: the session was provisioned exactly once',
    );
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

  test('refuses to activate a schedule whose cron parses as shape but not as values', async () => {
    // The schema only checks that the cron has five space-separated fields, so
    // `60 0 * * *` (minute out of range) and a bogus timezone both satisfy it.
    // If they reach the store they throw inside `nextFireTime` on every tick.
    // `validateCron` in the adapter is what rejects them at activation.
    for (const config of [
      { cron: '60 0 * * *', timezone: 'UTC', prompt: 'x' },
      { cron: '0 0 * * *', timezone: 'Mars/Phobos', prompt: 'x' },
    ]) {
      const now = clock.now();
      const draft = await store.connectors.create({
        id: newId('connector', now),
        workspaceId,
        type: 'schedule',
        name: 'semantically-broken',
        description: '',
        status: 'draft',
        agentId,
        externalKey: `broken-${Math.random().toString(36).slice(2, 8)}`,
        sessionPolicy: 'new_per_event',
        config,
        ownerPrincipalId: principal.id,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        createdBy: principal.id,
      });

      await assert.rejects(
        pipeline.activate(draft.id),
        `${JSON.stringify(config)} must be rejected at activation`,
      );
      assert.notEqual(
        (await store.connectors.get(draft.id))?.status,
        'active',
        'a config that cannot produce a fire time must never reach active',
      );
    }
  });

  test('one poisoned schedule does not halt the tick for every other', async () => {
    // The failure this guards against: a schema-valid but unfireable config
    // (bad cron range, unknown timezone) reaches the store — persisted before
    // `validateCron` existed, or written straight to the row. On each tick
    // `nextFireTime` throws *before* `claimSchedule`, so `next_fire_at` never
    // advances and the same connector re-throws forever, taking down all
    // periodic work platform-wide. The loop body must isolate that failure.
    const now = clock.now();

    // A healthy schedule, armed the normal way.
    const good = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'healthy-nightly',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'healthy-nightly',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await scheduler.scheduleNext(good.id);
    const goodDueAt = store.connectors.nextFireAt(good.id)!;

    // A poisoned schedule already in the store. It never went through
    // `validateCron` (that guard is new), so `scheduleNext` would throw — we
    // arm `next_fire_at` directly, exactly as a legacy row would carry it. Make
    // it due *earlier* than the good one so the tick reaches it first, proving
    // the good one still fires afterwards rather than being skipped by a throw.
    const poison = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'poisoned',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'poisoned',
      sessionPolicy: 'new_per_event',
      config: { cron: '60 0 * * *', timezone: 'UTC', prompt: 'never runs' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    store.connectors.setNextFire(poison.id, goodDueAt - 60_000, now);

    // Both are due.
    await clock.setTime(goodDueAt + 1000);

    // The tick must not reject on the poisoned row...
    let fired = 0;
    await assert.doesNotReject(async () => {
      fired = await scheduler.fireDueSchedules();
    }, 'one bad schedule must not throw out of the whole tick');

    // ...the healthy schedule still fired...
    assert.equal(fired, 1, 'the healthy schedule fires despite its poisoned neighbour');
    assert.equal(
      (await store.receipts.list({ connectorId: good.id })).items.length,
      1,
      'the healthy schedule produced its delivery',
    );

    // ...and the poisoned one is taken out of service so it stops re-throwing.
    const disabled = await store.connectors.get(poison.id);
    assert.equal(disabled?.status, 'failed', 'the poisoned schedule is disabled');
    assert.equal(disabled?.error?.code, 'INVALID_SCHEDULE_CONFIG');

    // A subsequent tick is clean: the poisoned row is no longer active, so it is
    // not even selected, and the healthy one keeps its normal cadence.
    const nextGoodDue = store.connectors.nextFireAt(good.id)!;
    assert.ok(nextGoodDue > goodDueAt, 'the healthy schedule advanced');
    await clock.setTime(nextGoodDue + 1000);
    await assert.doesNotReject(scheduler.fireDueSchedules());
  });

  test('a transient store error does not permanently disable a valid schedule', async () => {
    // The fix for the poisoned-schedule halt must not over-correct. A valid
    // connector whose `#enqueue` hits a transient store error (SQLITE_BUSY under
    // write contention, say) must NOT be misdiagnosed as a bad config and set
    // `failed`/INVALID_SCHEDULE_CONFIG/retryable=false — that would take a
    // healthy schedule permanently out of service, since findDueSchedules only
    // selects active rows. The connector must stay active and simply retry.
    const now = clock.now();
    const good = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'valid-but-unlucky',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'valid-but-unlucky',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await scheduler.scheduleNext(good.id);
    const dueAt = store.connectors.nextFireAt(good.id)!;
    await clock.setTime(dueAt + 1000);

    // Make the receipt write throw once, exactly like a locked database would.
    const original = store.receipts.createIfAbsent.bind(store.receipts);
    let threw = false;
    store.receipts.createIfAbsent = () => {
      threw = true;
      return Promise.reject(new Error('database is locked'));
    };
    try {
      await assert.doesNotReject(
        scheduler.fireDueSchedules(),
        'a transient store error must not escape the tick',
      );
    } finally {
      store.receipts.createIfAbsent = original;
    }
    assert.ok(threw, 'the enqueue path was exercised');

    // The connector is still active — not failed — so the next tick retries it.
    const after = await store.connectors.get(good.id);
    assert.equal(after?.status, 'active', 'a valid schedule survives a transient store error');
    assert.notEqual(
      after?.error?.code,
      'INVALID_SCHEDULE_CONFIG',
      'a locked database is not an invalid config',
    );
  });

  test('a failed disable of an unparseable schedule does not abort the tick', async () => {
    // The parse-failure disable path must be guarded like the unfireable-config
    // one: if `#disableSchedule`'s store write throws (a locked database), it
    // must not escape `fireDueSchedules` and abort the rest of the tick's
    // periodic work. It is left for the next tick instead.
    const now = clock.now();
    // An unparseable config that is nonetheless active and armed — exactly the
    // legacy-row shape the poison test uses, but with a body `safeConfig`
    // cannot parse at all.
    const broken = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'unparseable',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'unparseable',
      sessionPolicy: 'new_per_event',
      config: { not: 'a schedule config' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    store.connectors.setNextFire(broken.id, now - 1000, now);
    await clock.setTime(now + 1000);

    // Make the disable write throw, like a locked database would.
    const originalUpdate = store.connectors.update.bind(store.connectors);
    let threw = false;
    store.connectors.update = (id, patch) => {
      if (patch.status === 'failed') {
        threw = true;
        return Promise.reject(new Error('database is locked'));
      }
      return originalUpdate(id, patch);
    };
    try {
      await assert.doesNotReject(
        scheduler.fireDueSchedules(),
        'a failed disable must not abort the tick',
      );
    } finally {
      store.connectors.update = originalUpdate;
    }
    assert.ok(threw, 'the disable path was exercised');
    // The connector is still active (the disable did not commit), so the next
    // tick will simply try again — the row is not lost, the tick is not aborted.
    assert.equal((await store.connectors.get(broken.id))?.status, 'active');
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
// Reply loop — a connector that answers back after the turn completes
// ---------------------------------------------------------------------------

describe('delivery pipeline reply loop', () => {
  let store: SqliteStore;
  let clock: TestClock;
  let bus: EventBus;
  let sessions: SessionService;
  let credentials: CredentialService;
  let context: AuthContext;
  let workspaceId: string;
  let agentId: string;
  let principal: Principal;

  /** What the fake sandbox does when a prompt is submitted to a session. */
  let onSubmit: (sessionId: string, workspaceId: string) => Promise<void>;

  /** Messages the chat adapter would have posted back to the platform. */
  let sent: Array<{ chatId: string; text: string; secret?: string }>;

  const provisioner: SessionProvisioner = {
    provision: () =>
      Promise.resolve({ sandboxId: newId('sandbox'), reused: false, provisionMs: 1 }),
    release: () => Promise.resolve(),
    submit: (session) => onSubmit(session.id, session.workspaceId),
    rebind: () => Promise.resolve(true),
  };

  /** Publish the events a completed assistant turn produces, in order. */
  async function emitTurn(
    sessionId: string,
    wsId: string,
    reply: string | undefined,
    turn = 1,
  ): Promise<void> {
    await bus.publish([
      { sessionId, workspaceId: wsId, type: 'turn.started', turn, payload: { turn, promptPreview: '' } },
    ]);
    if (reply !== undefined) {
      await bus.publish([
        {
          sessionId,
          workspaceId: wsId,
          type: 'message.completed',
          turn,
          payload: { role: 'assistant', text: reply },
        },
      ]);
    }
    await bus.publish([
      {
        sessionId,
        workspaceId: wsId,
        type: 'turn.completed',
        turn,
        payload: { turn, reason: 'completed', durationMs: 5, usage: {
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0,
        } },
      },
    ]);
  }

  function buildPipeline(): DeliveryPipeline {
    const adapters = new AdapterRegistry()
      .register(
        chatAdapter({
          clock,
          send: (chatId, text, secret) => {
            sent.push({ chatId, text, secret });
            return Promise.resolve();
          },
        }),
      )
      .register(webhookAdapter({ clock }));

    return new DeliveryPipeline({
      store,
      clock,
      adapters,
      sessions,
      credentials,
      bus,
      logger: nullLogger,
      // Short, so the timeout case is cheap to drive.
      replyTimeoutMs: 10_000,
    });
  }

  beforeEach(async () => {
    sent = [];
    onSubmit = () => Promise.resolve();
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
  });

  afterEach(async () => {
    bus.closeAll();
    await store.close();
  });

  /** A chat connector that reuses one session, so a pre-started one is submittable. */
  async function makeChat(secret = 'chat-secret'): Promise<Connector> {
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'chat secret',
      value: secret,
    });
    const now = clock.now();
    return store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'chat',
      name: 'bot',
      description: '',
      status: 'active',
      agentId,
      externalKey: `bot-${Math.random().toString(36).slice(2, 8)}`,
      sessionPolicy: 'reuse_connector',
      config: {},
      secretCredentialId: credential.id,
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
  }

  /** A pre-started (`ready`) session on the agent, so `submit` is accepted. */
  async function readySession(): Promise<string> {
    const created = await sessions.create(context, { agentId, title: 'warm', origin: 'connector' });
    await sessions.start(created.id);
    return created.id;
  }

  /** A correctly signed chat event carrying a message. */
  function chatRequest(body: unknown, secret = 'chat-secret'): InboundRequest {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const timestamp = clock.now();
    return {
      headers: {
        'x-chat-signature': hmacSha256Hex(secret, `${timestamp}.${raw.toString('utf8')}`),
        'x-chat-timestamp': String(timestamp),
      },
      rawBody: raw,
      body,
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: timestamp,
    };
  }

  test('sends the assistant’s answer back to the chat after the turn completes', async () => {
    const sessionId = await readySession();
    const connector = await makeChat();
    // When the prompt lands, the sandbox produces an assistant message and ends
    // the turn — exactly the events the reply loop is waiting for.
    onSubmit = (sid, wsId) => emitTurn(sid, wsId, 'the answer is 42');

    const pipeline = buildPipeline();
    const accepted = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      chatRequest({ event: { text: 'what is the answer?', chatId: 'chat-7', messageId: 'm1', senderId: 'u1' } }),
    );
    assert.equal(accepted.status, 'accepted');

    const worked = await pipeline.processNext();
    assert.equal(worked, true);

    // The delivery reused the warm session, so the reply is routed there.
    const receipts = await store.receipts.list({ connectorId: connector.id });
    assert.equal(receipts.items[0]?.sessionId, sessionId);
    assert.equal(receipts.items[0]?.status, 'succeeded');

    // The whole point: the answer went back to the originating chat.
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { chatId: 'chat-7', text: 'the answer is 42', secret: 'chat-secret' });
  });

  test('does not reply when the turn produces no assistant message', async () => {
    await readySession();
    const connector = await makeChat();
    // A turn that completes silently (e.g. a tool-only turn) must not send a
    // blank message to the chat.
    onSubmit = (sid, wsId) => emitTurn(sid, wsId, undefined);

    const pipeline = buildPipeline();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      chatRequest({ event: { text: 'hi', chatId: 'chat-8', messageId: 'm1', senderId: 'u1' } }),
    );
    await pipeline.processNext();

    assert.equal(sent.length, 0);
  });

  test('a reply that never comes times out instead of blocking forever', async () => {
    await readySession();
    const connector = await makeChat();
    // The turn never completes. The reply loop must give up on its deadline
    // rather than hold the worker indefinitely.
    onSubmit = () => Promise.resolve();

    const pipeline = buildPipeline();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      chatRequest({ event: { text: 'hello?', chatId: 'chat-9', messageId: 'm1', senderId: 'u1' } }),
    );

    const done = pipeline.processNext();
    // The reply loop opens its subscription and schedules its deadline together,
    // several awaits into processNext. Wait for the subscription to exist before
    // advancing, or the deadline is registered *after* the clock moves and never
    // fires — which would hang this test rather than exercise the timeout.
    while (bus.subscriberCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(10_000);
    const worked = await done;

    assert.equal(worked, true);
    assert.equal(sent.length, 0);
    // No subscription is left dangling once the wait resolves.
    assert.equal(bus.subscriberCount(), 0);
  });

  test('a delivery whose connector cannot reply still succeeds without waiting', async () => {
    // A webhook has no `respond`, so the reply loop must be skipped entirely —
    // it must not open a subscription or wait on a turn that no one will read.
    const webhookCredential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: 'wh',
      value: 'wh-secret',
    });
    await readySession();
    const now = clock.now();
    const connector = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'webhook',
      name: 'alerts',
      description: '',
      status: 'active',
      agentId,
      externalKey: `wh-${Math.random().toString(36).slice(2, 8)}`,
      sessionPolicy: 'reuse_connector',
      config: {},
      secretCredentialId: webhookCredential.id,
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    onSubmit = (sid, wsId) => emitTurn(sid, wsId, 'ignored, nobody is listening');

    const pipeline = buildPipeline();
    const raw = Buffer.from(JSON.stringify({ prompt: 'go', eventId: 'evt-1' }), 'utf8');
    const ts = clock.now();
    await pipeline.accept(workspaceId, connector.externalKey, {
      headers: {
        'x-ma-signature': hmacSha256Hex('wh-secret', `${ts}.${raw.toString('utf8')}`),
        'x-ma-timestamp': String(ts),
      },
      rawBody: raw,
      body: { prompt: 'go', eventId: 'evt-1' },
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: ts,
    });

    const worked = await pipeline.processNext();
    assert.equal(worked, true);
    assert.equal(sent.length, 0);
    // The reply machinery never engaged, so nothing is left subscribed.
    assert.equal(bus.subscriberCount(), 0);
  });

  test('does not post another turn’s answer to this delivery’s chat', async () => {
    // The misroute this correlation guards against. A reused session can have a
    // prior turn *finishing* in the window between this delivery subscribing and
    // its own prompt being accepted — its `turn.started` fired before we
    // subscribed (so the bus never delivers it to us), but its tail
    // (`message.completed` + `turn.completed`) lands on our stream. Capturing the
    // first assistant message unconditionally would post *that* turn's answer to
    // *this* chat: a cross-conversation leak.
    const sessionId = await readySession();
    const connector = await makeChat();

    // On submit: first the stray *prior* turn's tail lands — a private answer
    // meant for someone else, with no `turn.started` (that already happened
    // before we subscribed) — then this delivery's own turn runs (turn 2, with
    // its own `turn.started`).
    onSubmit = async (sid, wsId) => {
      await bus.publish([
        {
          sessionId: sid,
          workspaceId: wsId,
          type: 'message.completed',
          turn: 1,
          payload: { role: 'assistant', text: 'PRIVATE answer for another conversation' },
        },
      ]);
      await bus.publish([
        {
          sessionId: sid,
          workspaceId: wsId,
          type: 'turn.completed',
          turn: 1,
          payload: { turn: 1, reason: 'completed', durationMs: 5, usage: {
            inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0,
          } },
        },
      ]);
      await emitTurn(sid, wsId, 'the answer to *this* question', 2);
    };

    const pipeline = buildPipeline();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      chatRequest({ event: { text: 'my question', chatId: 'chat-mine', messageId: 'm1', senderId: 'u1' } }),
    );
    const worked = await pipeline.processNext();
    assert.equal(worked, true);

    // Exactly one reply, and it is *this* turn's — never the stray prior one.
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, 'the answer to *this* question');
    assert.notEqual(sent[0]?.text, 'PRIVATE answer for another conversation');
    assert.equal(sent[0]?.chatId, 'chat-mine');
    // The reused session is confirmed — the reply routed to the warm one.
    const receipts = await store.receipts.list({ connectorId: connector.id });
    assert.equal(receipts.items[0]?.sessionId, sessionId);
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

// ---------------------------------------------------------------------------
// Event subscription adapter
// ---------------------------------------------------------------------------

describe('event subscription adapter', () => {
  const clock = new TestClock(START);
  const adapter = eventBusAdapter({ clock });

  /** A connector whose config carries the subscription's filter. */
  function connectorWith(config: Record<string, unknown>): Connector {
    return { id: 'cn_ev', name: 'events', config, secretCredentialId: 'cr_1' } as Connector;
  }

  /** A signed delivery of a CloudEvents envelope. */
  function signed(body: unknown, secret = 'bus-secret'): InboundRequest {
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

  test('refuses an unsigned subscription rather than accepting anything', async () => {
    const result = await adapter.verify(signed({ type: 'order.created' }), connectorWith({}));
    assert.equal(result.ok, false);
  });

  test('accepts a correctly signed delivery', async () => {
    const result = await adapter.verify(
      signed({ type: 'order.created' }),
      connectorWith({}),
      'bus-secret',
    );
    assert.equal(result.ok, true);
  });

  test('rejects a forged signature', async () => {
    const result = await adapter.verify(
      signed({ type: 'order.created' }, 'wrong-secret'),
      connectorWith({}),
      'bus-secret',
    );
    assert.equal(result.ok, false);
  });

  test('delivers an event whose type the subscription asked for', async () => {
    const trigger = await adapter.normalize(
      signed({ id: 'ev-1', type: 'order.created', source: 'shop', data: { orderId: 42 } }),
      connectorWith({ eventTypes: ['order.created'] }),
    );
    assert.ok(trigger, 'a matching event produces a trigger');
    assert.equal(trigger?.externalEventId, 'ev-1');
    assert.equal(trigger?.scopeKey, 'shop');
    assert.equal(trigger?.summary.includes('42'), true);
  });

  test('drops an event whose type the subscription did not ask for', async () => {
    // The whole point of the type: a subscription wakes an agent only for the
    // events it declared, unlike a plain webhook that fires on everything.
    const trigger = await adapter.normalize(
      signed({ id: 'ev-2', type: 'order.deleted', source: 'shop' }),
      connectorWith({ eventTypes: ['order.created'] }),
    );
    assert.equal(trigger, undefined);
  });

  test('a trailing star is a prefix wildcard', async () => {
    const trigger = await adapter.normalize(
      signed({ id: 'ev-3', type: 'order.shipped', source: 'shop', data: {} }),
      connectorWith({ eventTypes: ['order.*'] }),
    );
    assert.ok(trigger);
  });

  test('an empty type list accepts every event', async () => {
    // Re-filtering to nothing would silently drop everything the bus chose to
    // send — the failure mode this connector exists to avoid.
    const trigger = await adapter.normalize(
      signed({ id: 'ev-4', type: 'anything.at.all', source: 's', data: { x: 1 } }),
      connectorWith({}),
    );
    assert.ok(trigger);
  });

  test('filters by source when one is configured', async () => {
    const fromWanted = await adapter.normalize(
      signed({ id: 'ev-5', type: 'order.created', source: 'shop-eu', data: {} }),
      connectorWith({ eventTypes: ['order.created'], sources: ['shop-eu'] }),
    );
    assert.ok(fromWanted, 'an event from a listed source is delivered');

    const fromOther = await adapter.normalize(
      signed({ id: 'ev-6', type: 'order.created', source: 'shop-us', data: {} }),
      connectorWith({ eventTypes: ['order.created'], sources: ['shop-eu'] }),
    );
    assert.equal(fromOther, undefined, 'an event from an unlisted source is dropped');
  });

  test('expands the prompt template with the event fields', async () => {
    const trigger = await adapter.normalize(
      signed({ id: 'ev-7', type: 'order.created', source: 'shop', data: { total: 99 } }),
      connectorWith({
        eventTypes: ['order.created'],
        promptTemplate: 'A {{type}} from {{source}}: {{data}}',
      }),
    );
    assert.equal(
      trigger?.events[0]?.type === 'user.message' ? (trigger.events[0] as { text: string }).text : '',
      'A order.created from shop: {"total":99}',
    );
  });

  test('reads an envelope nested under an event wrapper', async () => {
    // Some buses wrap the CloudEvent under a delivery envelope.
    const trigger = await adapter.normalize(
      signed({ event: { id: 'ev-8', type: 'order.created', source: 'shop', data: {} } }),
      connectorWith({ eventTypes: ['order.created'] }),
    );
    assert.equal(trigger?.externalEventId, 'ev-8');
  });

  test('drops a typeless event when the subscription declared types', async () => {
    const trigger = await adapter.normalize(
      signed({ id: 'ev-9', source: 'shop', data: {} }),
      connectorWith({ eventTypes: ['order.created'] }),
    );
    assert.equal(trigger, undefined);
  });

  test('activation refuses a subscription with no signing secret', () => {
    const connector = { id: 'cn_ev', name: 'events', config: {} } as Connector;
    assert.throws(() => adapter.validateConfig?.(connector));
  });

  test('activation rejects a malformed filter', () => {
    // A filter that cannot be parsed must fail at activation, not at 3am on the
    // first event.
    const connector = {
      id: 'cn_ev',
      name: 'events',
      secretCredentialId: 'cr_1',
      config: { eventTypes: 'not-an-array' },
    } as unknown as Connector;
    assert.throws(() => adapter.validateConfig?.(connector));
  });
});
