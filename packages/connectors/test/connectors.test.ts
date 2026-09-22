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
  sha256Hex,
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

  test('maps a standalone 7 to Sunday without corrupting other 7s', () => {
    // The bug: day-of-week normalised `7 → 0` with a raw `String.replace(/7/g)`,
    // which rewrites any 7 in the field, not just a standalone Sunday. A full-week
    // range `0-7` collapsed to `0-0` (only Sunday), and a step `*/7` became `*/0`
    // (an invalid-step throw) — a valid schedule silently ran weekly, or was
    // rejected outright.
    assert.deepEqual(
      [...parseCron('0 0 * * 0-7').daysOfWeek].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6],
      '0-7 is the whole week, not just Sunday',
    );
    assert.deepEqual(
      [...parseCron('0 0 * * 1-7').daysOfWeek].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6],
      '1-7 covers Monday..Sunday',
    );
    assert.deepEqual(
      [...parseCron('0 0 * * 6-7').daysOfWeek].sort((a, b) => a - b),
      [0, 6],
      '6-7 is Saturday and Sunday',
    );
    assert.doesNotThrow(() => parseCron('0 0 * * */7'), 'a step of 7 must not become */0');
  });

  test('rejects malformed expressions', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '99 * * * *', '* 25 * * *', 'x * * * *']) {
      assert.throws(() => parseCron(bad), (error: unknown) => MaError.is(error), `${bad} should fail`);
    }
  });

  test('rejects non-canonical numeric tokens instead of coercing them', () => {
    // Number() is too lenient: '' -> 0, '0x1f' -> 31, '5.0' -> 5, ' 5 ' -> 5. A
    // trailing/leading/doubled comma is the common typo — it splits to an empty
    // token that would silently become minute 0, adding a fire the author never
    // wrote. Each of these must be a validation error, not a wrong schedule.
    for (const bad of [
      '5, * * * *', // trailing comma -> empty token
      ',5 * * * *', // leading comma
      '5,,0 * * * *', // doubled comma
      '0x1f * * * *', // hex coercion
      '5.0 * * * *', // float coercion
    ]) {
      assert.throws(() => parseCron(bad), (error: unknown) => MaError.is(error), `${bad} should fail`);
    }
  });

  test('rejects a non-canonical or malformed step instead of coercing it', () => {
    // The step went through raw Number(), bypassing the /^\d+$/ canonical-digit
    // guard applied to value/range tokens. So a step typed with the same
    // coercions rejected in value position — hex, float, exponent, sign — was
    // silently accepted and installed a WRONG fire interval: `*/0x1f` became
    // every-31-minutes, `*/1e1` every-10, `*/1e2` fired only minute 0. The step
    // must be validated exactly like a value token.
    for (const bad of [
      '*/0x1f * * * *', // hex -> 31
      '*/5.0 * * * *', // float
      '*/1e1 * * * *', // exponent -> 10
      '*/+2 * * * *', // leading sign
      '*/ 2 * * * *', // whitespace
      '5/ * * * *', // empty step after the slash
      '5/2/3 * * * *', // a second slash -> non-canonical step token
    ]) {
      assert.throws(() => parseCron(bad), (error: unknown) => MaError.is(error), `${bad} should fail`);
    }
  });

  test('rejects a range with more than two endpoints instead of dropping the tail', () => {
    // `const [a, b] = rangePart.split('-')` kept only the first two segments, so
    // a 3+ part range silently discarded the rest: `9-17-19` became {9..17}
    // dropping 19, `mon-fri-sat` became Mon..Fri dropping Saturday — a schedule
    // that never fires on the dropped portion, with no error at activation. The
    // file's own toNumber guard rejects a trailing comma to avoid "a fire the
    // author never wrote"; the symmetric a-b-c case silently DROPS fires and must
    // fail the same way.
    for (const bad of ['0 9-17-19 * * *', '0 9 * * mon-fri-sat', '1-2-3 * * * *']) {
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

  test('a 0-7 day-of-week range fires every day, not only Sunday', () => {
    // The end-to-end consequence of the day-of-week 7 corruption: `0-7` means the
    // whole week, so a daily job must fire on a weekday. 15 Jan 2026 is a
    // Thursday; the broken parser collapsed 0-7 to Sunday and skipped to the 18th.
    const from = Date.UTC(2026, 0, 15, 8, 0);
    const next = nextFireTime('0 9 * * 0-7', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '15/01/2026, 09:00', 'Thursday must still fire');
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

  test('a late-evening fire on a 25-hour fall-back day is not skipped', () => {
    // The day-first search scans a matching day minute by minute. A fall-back day
    // is a 25-hour civil day, so local 23:59 is ~1499 minutes after local 00:00 —
    // past a naive 24-hour (1440-minute) inner cap. With that cap the scan gave
    // up around 23:01 and the day's late fire was skipped to the next day: a
    // nightly `59 23 * * *` silently missed its run on every fall-back day. The
    // cap must cover the long day.
    const tz = 'Europe/London';
    // Start just before local 00:00 on the 2024-10-27 fall-back day, so the inner
    // scan of that day must reach 23:59 on its own.
    const from = Date.UTC(2024, 9, 26, 23, 0) - 60_000;
    const next = nextFireTime('59 23 * * *', tz, from)!;
    assert.equal(
      inZone(next, tz),
      '27/10/2024, 23:59',
      'the late fire on the fall-back day must not be skipped to the next day',
    );
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

  test('fires once on a 30-minute fall-back (Lord Howe), not twice', () => {
    // Australia/Lord_Howe shifts by only 30 minutes at DST, not a full hour. On
    // 2024-04-07 local 01:30 occurs at BOTH 14:30Z and 15:00Z — 30 minutes apart.
    // A fixed one-hour lookback for the "second occurrence" guard never sees the
    // 30-minutes-earlier first occurrence, so it fails to suppress the repeat and a
    // nightly `30 1 * * *` fires twice. The suppression must key on the actual DST
    // offset delta, not assume an hour.
    const fires: string[] = [];
    let from = Date.UTC(2024, 3, 6, 0, 0);
    for (let index = 0; index < 3; index++) {
      const next = nextFireTime('30 1 * * *', 'Australia/Lord_Howe', from)!;
      fires.push(new Date(next).toISOString());
      from = next;
    }
    // Local 2024-04-07 (the fall-back day) 01:30 occurs at 14:30Z and 15:00Z on
    // 2024-04-06 UTC. Exactly one fire must land in that repeated window; the
    // 15:00Z repeat must be dropped. (The next day's fire is 2024-04-07T15:00Z —
    // a normal post-DST day, correctly present.)
    const inRepeatWindow = fires.filter(
      (fire) => fire === '2024-04-06T14:30:00.000Z' || fire === '2024-04-06T15:00:00.000Z',
    );
    assert.deepEqual(
      inRepeatWindow,
      ['2024-04-06T14:30:00.000Z'],
      `the nightly schedule must fire once across the 30-minute fall-back, fired: ${fires.join(', ')}`,
    );
    // And it advances to the next day normally rather than stalling or repeating.
    assert.equal(fires[1], '2024-04-07T15:00:00.000Z', 'the day after fall-back fires once at the new offset');
  });

  test('fires once on a 3-hour fall-back (Antarctica/Casey), not twice', () => {
    // Casey shifts by a full THREE hours at its autumn transition (offset +11 ->
    // +8). On 2018-03-11 local 03:30 occurs at BOTH 16:30Z and 19:30Z on the 10th
    // — 180 minutes apart. A fixed 120-minute lookback for the repeat guard never
    // reaches the 180-minutes-earlier first occurrence, so the duplicate is not
    // suppressed and a nightly `30 3 * * *` fires twice. The suppression must key
    // on the actual observed offset delta, not a hard-coded ceiling.
    const fires: string[] = [];
    let from = Date.UTC(2018, 2, 10, 0, 0);
    for (let index = 0; index < 3; index++) {
      const next = nextFireTime('30 3 * * *', 'Antarctica/Casey', from)!;
      fires.push(new Date(next).toISOString());
      from = next;
    }
    const inRepeatWindow = fires.filter(
      (fire) => fire === '2018-03-10T16:30:00.000Z' || fire === '2018-03-10T19:30:00.000Z',
    );
    assert.deepEqual(
      inRepeatWindow,
      ['2018-03-10T16:30:00.000Z'],
      `the nightly schedule must fire once across the 3-hour fall-back, fired: ${fires.join(', ')}`,
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

  test('resolves a leap-day cron even when it is beyond two years out', () => {
    // From Jan 2026 the next Feb 29 is 2028 — ~2.16 years away, past the old
    // 2-year search horizon that would have returned undefined and (with the
    // disable-on-undefined rule) killed a valid leap-day schedule. The day-first
    // search looks far enough ahead to resolve it.
    const from = Date.UTC(2026, 0, 1, 0, 0);
    const next = nextFireTime('0 0 29 2 *', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '29/02/2028, 00:00');
  });

  test('resolves a leap-day cron across the century non-leap gap', () => {
    // 2100 is not a leap year, so after 2096-02-29 the next Feb 29 is 2104 — an
    // 8-year gap. The horizon must cover it, or a valid schedule created in that
    // window would look unfireable.
    const from = Date.UTC(2096, 2, 1, 0, 0);
    const next = nextFireTime('0 0 29 2 *', 'UTC', from)!;
    assert.equal(inZone(next, 'UTC'), '29/02/2104, 00:00');
  });

  test('a day-of-month that never occurs is unfireable (undefined)', () => {
    // February has no 30th or 31st, and April/June/September/November have no
    // 31st. These are schema-valid crons that name no real time — undefined, so
    // the scheduler disables them rather than firing forever.
    for (const cron of ['0 0 30 2 *', '0 0 31 2 *', '0 0 31 4 *', '0 0 31 11 *']) {
      assert.equal(nextFireTime(cron, 'UTC', Date.UTC(2026, 0, 1)), undefined, `${cron} is unfireable`);
    }
  });

  test('a day-of-month that never occurs still fires when day-of-week is ORed in', () => {
    // `0 0 31 * 1` ORs "the 31st" with "every Monday" — so even though the 31st
    // is impossible in some months, the Monday clause keeps it fireable. Must not
    // be mistaken for unfireable.
    const next = nextFireTime('0 0 31 * 1', 'UTC', Date.UTC(2026, 0, 1));
    assert.ok(next !== undefined, 'the ORed day-of-week keeps it fireable');
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
  let workspaces: WorkspaceService;
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
    rebind: () => Promise.resolve('ok' as const),
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
    workspaces = new WorkspaceService(deps);
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

  test('rejects a correctly signed delivery once the signing credential has expired', async () => {
    // The connector unseal path used to be a bare decrypt: unlike exchange(), it
    // never checked status/expiresAt, so a retired webhook signing key kept
    // authenticating public inbound deliveries forever. This is the lazy window
    // too — expiresAt in the past while the expiry sweep has not yet flipped
    // status — so the gate must read expiresAt, not only status.
    const connector = await makeWebhook();
    await store.credentials.update(connector.secretCredentialId!, {
      expiresAt: clock.now() - 1,
      updatedAt: clock.now(),
    });

    const result = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-expired' }),
    );
    assert.equal(result.status, 'rejected');
  });

  test('rejects a correctly signed delivery once the signing credential is revoked', async () => {
    const connector = await makeWebhook();
    await store.credentials.update(connector.secretCredentialId!, {
      status: 'revoked',
      updatedAt: clock.now(),
    });

    const result = await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-revoked' }),
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

  test('a retryable submit failure requeues the delivery instead of failing it permanently', async () => {
    // A transient sandbox 5xx / network blip during submit is a retryable MaError
    // (unavailable/timeout), not a plain Error coerced to non-retryable `internal`.
    // The pipeline must requeue with backoff, not write the receipt terminal
    // `failed` on the first attempt — otherwise a connector delivery (alert,
    // webhook) is permanently dropped by a rolling restart it would survive.
    submitError = new MaError({
      code: 'SANDBOX_UNAVAILABLE',
      category: 'unavailable',
      message: 'the sandbox is temporarily unavailable (503)',
      retryable: true,
    });
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'transient failure', eventId: 'evt-transient' }),
    );

    assert.equal(await pipeline.processNext(), true);

    const receipts = await store.receipts.list({ connectorId: connector.id });
    const receipt = receipts.items[0]!;
    assert.equal(receipt.status, 'pending', 'a retryable submit failure requeues, not fails');
    assert.ok((receipt.nextAttemptAt ?? 0) > 0, 'it is scheduled for a backed-off retry');
    assert.equal(receipt.error?.retryable, true, 'the recorded failure is marked retryable');
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

  test('the reaper must not clobber a receipt the worker already finished', async () => {
    // The uncovered race: reapZombies reads working receipts via findExpiredLeases,
    // then wrote `zombie` with an UNGUARDED update. If the original worker settles
    // the receipt (succeeded/failed) between that read and the write, the reaper
    // overwrote a terminal state with `zombie` — a state-machine violation and a
    // lie (a delivery that actually succeeded recorded as abandoned). The write
    // must compare-and-set on `working`, like every other receipt transition.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'hi', eventId: 'evt-finish-race' }),
    );
    const claimed = (await store.receipts.claimNext(clock.now(), clock.now() + 1000))!;
    await clock.advance(5000);

    // Simulate the worker winning the race: findExpiredLeases still returns the
    // (working) receipt, but by the time the reaper writes, the worker has settled
    // it as `succeeded`. A store wrapper flips it the moment the reaper looks.
    let flipped = false;
    const racingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'receipts') {
          const receipts = Reflect.get(target, prop, receiver);
          return new Proxy(receipts, {
            get(rTarget, rProp, rRecv) {
              if (rProp === 'findExpiredLeases') {
                return async (now: number, limit: number) => {
                  const found = await Reflect.get(rTarget, rProp, rRecv).call(rTarget, now, limit);
                  // The worker finishes right after the reaper reads.
                  if (!flipped) {
                    flipped = true;
                    await rTarget.compareAndSetStatus(claimed.id, 'working', {
                      status: 'succeeded',
                      completedAt: clock.now(),
                      leaseExpiresAt: undefined,
                      updatedAt: clock.now(),
                    });
                  }
                  return found;
                };
              }
              const v = Reflect.get(rTarget, rProp, rRecv);
              return typeof v === 'function' ? v.bind(rTarget) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as typeof store;

    const racingPipeline = new DeliveryPipeline({
      store: racingStore,
      clock,
      adapters: new AdapterRegistry().register(webhookAdapter({ clock })),
      sessions,
      credentials,
      logger: nullLogger,
    });

    await racingPipeline.reapZombies();

    const after = await store.receipts.get(claimed.id);
    assert.equal(
      after?.status,
      'succeeded',
      'the reaper must not overwrite a receipt the worker already settled',
    );
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

  test('a live delivery heartbeats its lease so the reaper leaves it alone', async () => {
    // The double-run window: `claimNext` leases 120s, but a delivery holds
    // `working` across a cold provision plus the turn, which can run longer. A
    // slow provision here stands in for that. Without the lease heartbeat,
    // `reapZombies` would promote the still-running delivery to `zombie`, the
    // delivery's own succeed-CAS would then lose, and an operator retry of the
    // false-zombie would double-run the event. With the heartbeat, the lease is
    // pushed out while the delivery runs, so the concurrent reap finds nothing.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'slow one', eventId: 'evt-heartbeat' }),
    );

    // Hold the delivery inside provision() until we release it — the receipt is
    // `working` and its original lease is lapsing while this blocks.
    let releaseProvision = (): void => {};
    const provisionEntered = new Promise<void>((resolve) => {
      gatedProvision = () => {
        resolve();
        return new Promise<void>((release) => {
          releaseProvision = release;
        });
      };
    });

    const done = pipeline.processNext();
    await provisionEntered; // the delivery is now parked in provision(), lease running

    // Let the heartbeat fire at least once, past the original 120s lease. The
    // default lease is 120s and the heartbeat runs at half that, so advancing
    // beyond a full lease guarantees a renewal has landed.
    const receipts = await store.receipts.list({ connectorId: connector.id });
    const receiptId = receipts.items[0]!.id;
    await clock.advance(130_000);
    // Yield so the detached heartbeat's woken sleep runs its renewLease before
    // we snapshot — the clock released the sleeper, the continuation is queued.
    await new Promise((resolve) => setImmediate(resolve));

    // A reaper sweep now: the renewed lease must be in the future, so nothing is
    // collected and the receipt stays `working`.
    const reaped = await pipeline.reapZombies();
    assert.equal(reaped.length, 0, 'a heartbeating delivery must not be reaped');
    assert.equal((await store.receipts.get(receiptId))?.status, 'working');

    // Release the provision; the delivery completes and settles cleanly.
    releaseProvision();
    const worked = await done;
    assert.equal(worked, true);
    assert.equal(
      (await store.receipts.get(receiptId))?.status,
      'succeeded',
      'the delivery it protected settles succeeded, not zombie',
    );
  });

  test('a transient renewLease error does not stop the heartbeat', async () => {
    // Review finding: the heartbeat's renewLease was unguarded. A single
    // transient store error (SQLITE_BUSY under write contention, a handle closing
    // during shutdown) would unwind the whole loop — surfacing as an unhandled
    // rejection AND permanently ending renewal, so the lease lapses and the
    // reaper zombies the *live* delivery: the exact double-run this fix prevents,
    // reintroduced by one hiccup. The loop must instead retry on the next beat.
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
    };
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'flaky renew', eventId: 'evt-flaky-renew' }),
    );

    // Fail the first renewal, then behave normally — proving the loop survives it.
    const realRenew = store.receipts.renewLease.bind(store.receipts);
    let renewCalls = 0;
    store.receipts.renewLease = (id, expiresAt, at) => {
      renewCalls++;
      if (renewCalls === 1) return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
      return realRenew(id, expiresAt, at);
    };

    // Short lease so beats are quick: 10s lease → 5s heartbeat interval.
    const heartbeatPipeline = new DeliveryPipeline({
      store,
      clock,
      adapters: new AdapterRegistry().register(webhookAdapter({ clock })),
      sessions,
      credentials,
      logger: nullLogger,
      leaseSeconds: 10,
    });

    let release = (): void => {};
    const entered = new Promise<void>((resolve) => {
      gatedProvision = () => {
        resolve();
        return new Promise<void>((r) => {
          release = r;
        });
      };
    });

    const done = heartbeatPipeline.processNext();
    await entered;
    const receiptId = (await store.receipts.list({ connectorId: connector.id })).items[0]!.id;

    await clock.advance(5_000); // beat 1 — renewLease throws, must be caught
    await settle();
    await clock.advance(5_000); // beat 2 — renewLease succeeds, lease pushed out
    await settle();
    await clock.advance(1); // now just past the original 10s lease

    assert.ok(renewCalls >= 2, 'the loop retried after the transient error, not gave up');
    const reaped = await pipeline.reapZombies();
    assert.equal(reaped.length, 0, 'the renewed lease keeps the live delivery safe from the reaper');
    assert.equal((await store.receipts.get(receiptId))?.status, 'working');

    release();
    await done;
    store.receipts.renewLease = realRenew;
    assert.equal((await store.receipts.get(receiptId))?.status, 'succeeded');
  });

  test('a delivery that runs past its ceiling stops being renewed and is reaped', async () => {
    // Review finding: with no cap, a wedged delivery (a `/submit` that accepts the
    // socket and never answers) would renew forever and never be reaped — strictly
    // worse than the pre-renewal behaviour, where the lease lapsed and the stuck
    // receipt became a visible, retryable `zombie`. After the delivery ceiling the
    // heartbeat must stop renewing so the lease lapses and the reaper reclaims it.
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
    };
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'wedged', eventId: 'evt-wedged' }),
    );

    // 10s lease (5s beats), 12s ceiling: two renewals land, then the loop stops.
    const cappedPipeline = new DeliveryPipeline({
      store,
      clock,
      adapters: new AdapterRegistry().register(webhookAdapter({ clock })),
      sessions,
      credentials,
      logger: nullLogger,
      leaseSeconds: 10,
      maxDeliverySeconds: 12,
    });

    let release = (): void => {};
    const entered = new Promise<void>((resolve) => {
      gatedProvision = () => {
        resolve();
        return new Promise<void>((r) => {
          release = r;
        });
      };
    });

    const done = cappedPipeline.processNext();
    await entered;
    const receiptId = (await store.receipts.list({ connectorId: connector.id })).items[0]!.id;

    await clock.advance(5_000); // beat @5s: renew → lease 15s
    await settle();
    await clock.advance(5_000); // beat @10s: renew → lease 20s
    await settle();
    await clock.advance(5_000); // beat @15s: past the 12s ceiling → stop renewing
    await settle();
    await clock.advance(5_001); // now @20.001s, past the last renewed lease (20s)

    const reaped = await pipeline.reapZombies();
    assert.deepEqual(reaped, [receiptId], 'a delivery past its ceiling lapses and is reaped');
    assert.equal((await store.receipts.get(receiptId))?.status, 'zombie');

    // Let the wedged delivery unstick so the test does not leak the gate.
    release();
    await done;
  });

  test('a ceiling below the heartbeat interval still grants a healthy delivery its first renewal', async () => {
    // The ceiling is clamped to at least one full lease. Without that clamp, a
    // misconfigured tiny `maxDeliverySeconds` (below the half-lease heartbeat
    // interval) would make the very first beat already exceed the ceiling, so a
    // perfectly healthy delivery would never renew and would lapse at its claim
    // lease under the reaper — punishing a running delivery for a config typo.
    const settle = async (): Promise<void> => {
      for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
    };
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'clamped', eventId: 'evt-clamped' }),
    );

    // 10s lease → 5s beat, but a nonsensical 1s ceiling. The clamp lifts the
    // effective ceiling to a full lease (10s), so the first beat at 5s renews.
    const clampedPipeline = new DeliveryPipeline({
      store,
      clock,
      adapters: new AdapterRegistry().register(webhookAdapter({ clock })),
      sessions,
      credentials,
      logger: nullLogger,
      leaseSeconds: 10,
      maxDeliverySeconds: 1,
    });

    let release = (): void => {};
    const entered = new Promise<void>((resolve) => {
      gatedProvision = () => {
        resolve();
        return new Promise<void>((r) => {
          release = r;
        });
      };
    });

    const done = clampedPipeline.processNext();
    await entered;
    const receiptId = (await store.receipts.list({ connectorId: connector.id })).items[0]!.id;

    await clock.advance(5_000); // first beat: must renew despite the 1s config
    await settle();
    await clock.advance(5_001); // now past the original 10s claim lease (t=10.001s)

    // Only a renewal (which the clamp permits) pushes the lease beyond the claim
    // lease of 10s. Without the clamp the first beat would exceed the 1s ceiling
    // and skip renewal, so the lease would still be 10s and the reaper would
    // collect this healthy delivery here.
    const reaped = await pipeline.reapZombies();
    assert.equal(reaped.length, 0, 'the clamp let the healthy delivery renew, so it is not reaped');
    assert.equal((await store.receipts.get(receiptId))?.status, 'working');

    release();
    await done;
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

  test('the maintenance tick no longer drains deliveries itself', async () => {
    // Delivery draining moved off the maintenance tick onto its own loop, because
    // a delivery can block for a whole agent turn (it waits for a reply) and
    // folding that into the tick starved provisioning, zombie reaping, session
    // expiry and the retention prunes for the length of that turn. The tick must
    // no longer call `drainDeliveries` at all — its sweeps run regardless of how
    // long a delivery is taking. A spy proves the tick does not touch it, and a
    // pending receipt is left unprocessed by the tick.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'pending', eventId: 'evt-not-drained' }),
    );

    let drainCalls = 0;
    const realDrain = scheduler.drainDeliveries.bind(scheduler);
    scheduler.drainDeliveries = () => {
      drainCalls++;
      return realDrain();
    };

    // A queued session too, so we can prove the sweeps still run in the same tick.
    const session = await sessions.create(context, { agentId });
    const report = await scheduler.tick();

    assert.equal(drainCalls, 0, 'tick must not invoke drainDeliveries');
    assert.equal(
      (report as unknown as { deliveriesProcessed?: number }).deliveriesProcessed,
      undefined,
      'the tick report no longer carries a delivery count',
    );
    assert.equal(report.sessionsStarted, 1, 'the maintenance sweeps still run');
    assert.equal((await store.sessions.get(session.id))?.status, 'ready');
    // The receipt is still pending: nothing on the tick path processed it.
    const receipt = (await store.receipts.list({ connectorId: connector.id })).items[0]!;
    assert.equal(receipt.status, 'pending', 'the delivery was not drained by the tick');

    scheduler.drainDeliveries = realDrain;
  });

  test('the dedicated delivery loop drains deliveries once started', async () => {
    // The other half: draining still happens, just on its own loop. Start the
    // scheduler and a pending delivery is picked up without the maintenance tick
    // touching it. Uses the real clock so the loop's own sleep actually elapses.
    const connector = await makeWebhook();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      signedRequest({ prompt: 'drain me', eventId: 'evt-loop-drain' }),
    );

    let delivered = 0;
    const loopScheduler = new Scheduler({
      store,
      clock: systemClock,
      pipeline,
      sessions,
      logger: nullLogger,
      tickMs: 5,
      onDelivery: (processed) => {
        delivered += processed;
      },
    });

    loopScheduler.start();
    try {
      // Wait (bounded) for the delivery loop to run the receipt to a terminal
      // state — not merely off `pending` (claimNext flips it to `working` before
      // `#deliver` finishes), or we would race the in-flight delivery.
      const deadline = Date.now() + 2000;
      for (;;) {
        const receipt = (await store.receipts.list({ connectorId: connector.id })).items[0]!;
        if (['succeeded', 'failed', 'zombie'].includes(receipt.status)) break;
        if (Date.now() > deadline) {
          assert.fail(`the delivery loop never settled the receipt (stuck at ${receipt.status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const receipt = (await store.receipts.list({ connectorId: connector.id })).items[0]!;
      assert.equal(receipt.status, 'succeeded', 'the delivery loop ran the delivery to completion');
      assert.ok(delivered >= 1, 'onDelivery observed the drained delivery');
    } finally {
      await loopScheduler.stop();
    }
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

  test('the event-prune sweep rotates past not-yet-expired sessions to reach an expirable one', async () => {
    // The candidate query returns any session with an event older than the
    // shortest possible window (1 day), ordered oldest-first — but many of those
    // are not actually expired under their own workspace's longer retention. With
    // a fixed batch and no cursor, those no-op candidates at the front monopolized
    // the batch every tick, so an expirable session sorting after them was never
    // reached. Set THIS workspace to long retention (its sessions are perennial
    // no-op candidates), put an expirable session in a second short-retention
    // workspace whose event is NEWER (so it sorts last), and confirm a few ticks
    // at batch size 1 rotate past the no-ops and prune it.
    await setRetentionDays(3650); // this workspace keeps everything

    // Two no-op candidates here: events older than 1 day but far inside 3650-day
    // retention. Older timestamps so they sort first.
    for (let i = 0; i < 2; i++) {
      const s = await sessions.create(context, { agentId });
      await store.events.append(s.id, [
        {
          id: newId('event'),
          sessionId: s.id,
          workspaceId,
          ts: clock.now() - (100 - i) * 24 * 60 * 60 * 1000, // ~100 days old, sorts first
          type: 'message.completed',
          payload: { role: 'assistant', text: 'old but kept' },
        } as never,
      ]);
    }

    // A second workspace with SHORT retention holds the expirable session, whose
    // event is only ~2 days old (newer → sorts after the no-ops).
    const otherWs = await workspaces.create(context, { name: 'Shortlived', slug: 'shortlived' });
    await store.workspaces.update(otherWs.id, {
      quota: { ...otherWs.quota, eventRetentionDays: 1 },
      updatedAt: clock.now(),
    });
    const otherAgent = await store.agents.create({
      id: newId('agent'),
      workspaceId: otherWs.id,
      name: 'a',
      description: '',
      labels: [],
      status: 'active',
      latestVersion: 0,
      productionVersion: 0,
      metadata: {},
      createdAt: clock.now(),
      updatedAt: clock.now(),
      createdBy: principal.id,
    });
    const expirable = await store.sessions.create({
      ...(await sessions.create(context, { agentId })),
      id: newId('session'),
      workspaceId: otherWs.id,
      agentId: otherAgent.id,
    } as never);
    await store.events.append(expirable.id, [
      {
        id: newId('event'),
        sessionId: expirable.id,
        workspaceId: otherWs.id,
        ts: clock.now() - 2 * 24 * 60 * 60 * 1000, // ~2 days old, past its 1-day retention
        type: 'message.completed',
        payload: { role: 'assistant', text: 'should be pruned' },
      } as never,
      {
        id: newId('event'),
        sessionId: expirable.id,
        workspaceId: otherWs.id,
        ts: clock.now(),
        type: 'message.completed',
        payload: { role: 'assistant', text: 'fresh, kept' },
      } as never,
    ]);
    const beforeExpirable = (await store.events.read(expirable.id, {})).length;

    // Batch size 1: without rotation, tick after tick would only ever see the
    // single oldest no-op candidate and never reach the expirable session.
    let prunedTotal = 0;
    for (let pass = 0; pass < 6; pass++) prunedTotal += await scheduler.pruneExpiredEvents(1);

    assert.ok(prunedTotal > 0, 'the rotation eventually reached and pruned the expirable session');
    assert.ok(
      (await store.events.read(expirable.id, {})).length < beforeExpirable,
      'the expirable session past the no-op front was pruned',
    );
  });

  test('the event-prune sweep does not strand a session tied on the oldest timestamp', async () => {
    // The rotating cursor pages on MIN(ts), a NON-unique key, with a strict `>`.
    // When two sessions share the same oldest timestamp and the batch boundary
    // falls between them, the excluded one has oldest == cursor, fails `> cursor`,
    // and is skipped until the cursor happens to wrap — under sustained backlog,
    // a long time. A newer expirable candidate keeps the cursor climbing past the
    // tie, so within the first ticks the tied tail is never reached.
    //
    // Seed a short-retention workspace with A and B tied at the SAME oldest ts and
    // a newer C, all genuinely expirable. At batch size 1: tick 1 prunes one of
    // the tied pair (cursor := T0); a correct compound (oldest, session_id) cursor
    // then prunes the OTHER tied session on tick 2, while the strict-`>` cursor
    // skips it (oldest == T0) and climbs to C instead — leaving the tied session
    // unpruned. Assert both tied sessions are pruned within two ticks.
    await setRetentionDays(1);
    const T0 = clock.now() - 5 * 24 * 60 * 60 * 1000; // ~5 days old, past the 1-day window

    const makeExpirableSession = async (oldestTs: number): Promise<string> => {
      const s = await sessions.create(context, { agentId });
      await store.events.append(s.id, [
        {
          id: newId('event'),
          sessionId: s.id,
          workspaceId,
          ts: oldestTs,
          type: 'message.completed',
          payload: { role: 'assistant', text: 'expired' },
        } as never,
        {
          id: newId('event'),
          sessionId: s.id,
          workspaceId,
          ts: clock.now(),
          type: 'message.completed',
          payload: { role: 'assistant', text: 'fresh, kept' },
        } as never,
      ]);
      return s.id;
    };

    // A and B tie on the oldest ts; C is newer so it sorts after the tie and keeps
    // the cursor advancing past T0 under the buggy strict-`>` paging.
    const a = await makeExpirableSession(T0);
    const b = await makeExpirableSession(T0);
    await makeExpirableSession(T0 + 60_000);

    const expiredCount = async (sessionId: string): Promise<number> =>
      (await store.events.read(sessionId, {})).filter((e) => e.ts <= T0 + 60_000).length;
    assert.equal(await expiredCount(a), 1, 'A starts with one expired event');
    assert.equal(await expiredCount(b), 1, 'B starts with one expired event');

    // Two ticks at batch size 1: enough to reach both members of a tied pair when
    // the cursor pages correctly through the tie.
    await scheduler.pruneExpiredEvents(1);
    await scheduler.pruneExpiredEvents(1);

    assert.equal(await expiredCount(a), 0, 'A was pruned');
    assert.equal(
      await expiredCount(b),
      0,
      'B, tied with A on the oldest ts, must not be stranded by a strict-> cursor',
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

  test('the tick prunes the expired audit prefix past the retention window', async () => {
    // `audit.prune` was fully implemented with no production caller, so the
    // trail grew forever. Driven through `tick()` rather than the method, for
    // the same reason as the event-prune test: a direct call passes whether or
    // not anything reaches it.
    //
    // Pruning is by seq-PREFIX (so a clock-skewed retained row is never stranded
    // below the tamper-evidence watermark — see the audit-chain tests), so the
    // expired rows must be the oldest contiguous run for the sweep to reach them.
    // Model that honestly: an old marker written first, then time passes and a
    // recent marker is written, then the window prunes the old prefix.
    const pruning = new Scheduler({
      store,
      clock,
      pipeline,
      sessions,
      logger: nullLogger,
      auditRetentionDays: 30,
    });

    await appendAudit(0, 'test.marker'); // written "now" — will age past the window
    await clock.advance(60 * 24 * 60 * 60 * 1000); // 60 days pass
    await appendAudit(0, 'test.recent'); // written after the jump — inside the window
    assert.equal(await markerCount(), 1, 'the soon-to-expire marker exists before the sweep');

    const report = await pruning.tick();
    await pruning.stop();
    assert.ok(report.auditPruned >= 1, 'a tick must prune the expired prefix');

    // The old marker (part of the expired prefix) is gone; the recent one survives.
    assert.equal(await markerCount(), 0, 'the 60-day-old marker was pruned');
    const recent = await store.audit.list({ workspaceId, action: 'test.recent' });
    assert.equal(recent.items.length, 1, 'the in-window marker survives');
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

  test('the tick prunes stale billing-dedup markers past the retention window', async () => {
    // `billedTurns.prune` bounds the billed_turns table: a marker for a turn whose
    // report never arrived (a crash/reap) would otherwise linger. Driven through
    // `tick()` rather than the method directly — a direct call passes whether or
    // not the sweep is wired into the loop.
    const session = await sessions.create(context, { agentId });
    // A stale marker (~8 days old, past the 7-day retention) and a fresh one.
    store.billedTurns.mark(session.id, 'sb_stale', 1, clock.now() - 8 * 24 * 60 * 60 * 1000);
    store.billedTurns.mark(session.id, 'sb_fresh', 2, clock.now());

    const report = await scheduler.tick();
    await scheduler.stop();
    assert.ok(report.billedTurnsPruned >= 1, 'a tick must prune the stale marker');

    // The stale marker is gone; the fresh one survives (consume returns false only
    // when absent).
    assert.equal(
      store.billedTurns.consume(session.id, 'sb_stale', 1),
      false,
      'the stale marker was pruned',
    );
    assert.equal(
      store.billedTurns.consume(session.id, 'sb_fresh', 2),
      true,
      'the fresh marker is untouched by the sweep',
    );
  });

  test('a survivable billed-turns-prune failure does not take the tick down', async () => {
    const original = store.billedTurns.prune.bind(store.billedTurns);
    store.billedTurns.prune = () => Promise.reject(new Error('database is busy'));
    try {
      const pruned = await scheduler.pruneBilledTurns();
      assert.equal(pruned, 0, 'a failed sweep reports nothing pruned rather than throwing');
    } finally {
      store.billedTurns.prune = original;
    }
  });

  test('a throwing early sweep does not skip the sweeps ordered after it', async () => {
    // The isolation bug: sweeps ran as bare sequential awaits, so a throw from any
    // one (a corrupt schedule row making findDueSchedules' decode throw, or a
    // transient batch-fetch error) escaped tick() and skipped every later sweep —
    // delivery drain, zombie reap, session expiry, retention prunes, cred sweep —
    // platform-wide, and forever if the trigger was a persistent bad row. Make an
    // early sweep's fetch throw and assert a LATER sweep still runs in that tick.
    const now = clock.now();
    await store.idempotency.reserve('expired-key', 'iso-scope', now - 10_000, 1_000); // due to prune

    const originalFind = store.connectors.findDueSchedules.bind(store.connectors);
    store.connectors.findDueSchedules = () => Promise.reject(new Error('corrupt schedule row'));
    try {
      const report = await scheduler.tick();
      assert.equal(report.schedulesFired, 0, 'the failing sweep contributes 0, not a throw');
      assert.ok(
        report.idempotencyPruned >= 1,
        'a sweep ordered after the failing one still runs (was skipped before the fix)',
      );
    } finally {
      store.connectors.findDueSchedules = originalFind;
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

  test('recovers a lost sandbox even past the first 50 active sessions', async () => {
    // The scan cap: `recoverLostSandboxes` listed active sessions with `limit: 50`
    // and filtered client-side for the one holding the lost sandbox. In a busy
    // workspace with more than 50 active sessions, the holder could sit beyond the
    // first page and was never notified — so it stayed `ready` pointing at a dead
    // sandbox forever, the exact leak recovery exists to prevent. A direct lookup
    // by sandbox id finds it regardless of how many sessions are active.
    const workspace = (await store.workspaces.get(workspaceId))!;
    await store.workspaces.update(workspaceId, {
      quota: { ...workspace.quota, maxConcurrentSessions: 100 },
      updatedAt: clock.now(),
    });
    const holders = [];
    for (let index = 0; index < 60; index++) {
      const created = await sessions.create(context, { agentId, ttlSeconds: 3600 });
      holders.push(await sessions.start(created.id));
    }
    // Sessions list oldest-first (id ascending); the newest is well past row 50.
    const victim = holders[holders.length - 1]!;
    assert.ok(victim.sandboxId, 'precondition: the victim holds a sandbox');

    const recovered = await scheduler.recoverLostSandboxes([victim.sandboxId!]);
    assert.equal(recovered, 1, 'the holder must be found and recovered');

    const after = await store.sessions.get(victim.id);
    assert.equal(after?.status, 'queued', 'the victim re-queues instead of stranding');
    assert.equal(after?.sandboxId, undefined, 'and no longer points at the lost sandbox');
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

  test('the credential sweep rotates across workspaces, not just the first page', async () => {
    // The sweep listed workspaces with a fixed limit and no cursor, so it swept
    // only the lowest-id page every tick — a workspace whose id sorted after it
    // never had its credentials expired. Create several workspaces each with an
    // expiring credential, then drive the sweep at page size 1: a rotating cursor
    // must eventually reach every workspace. (The default `workspaceId` workspace
    // exists too, so account for it.)
    const extra: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = await workspaces.create(context, { name: `Sweep ${i}`, slug: `sweep-${i}` });
      extra.push(ws.id);
      const cred = await credentials.create(context, {
        workspaceId: ws.id,
        ownerType: 'workspace',
        ownerId: ws.id,
        type: 'api_key',
        name: `c-${i}`,
        value: 'v',
        expiresAt: clock.now() + 60_000,
      });
      assert.equal(cred.status, 'active');
    }
    await clock.advance(120_000);

    // Page size 1: without a rotating cursor this would only ever touch the same
    // single workspace. Enough passes to visit every workspace (default + 3) and
    // wrap at least once.
    for (let pass = 0; pass < 8; pass++) await scheduler.sweepCredentials(1);

    for (const wsId of extra) {
      const creds = await store.credentials.list({ workspaceId: wsId });
      assert.ok(
        creds.items.every((c) => c.status === 'expired'),
        `workspace ${wsId} past the first page must still get swept`,
      );
    }
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

  test('a schedule whose enqueue fails is retried next tick, not silently lost', async () => {
    // The claim advances next_fire_at BEFORE the receipt is created. If the
    // enqueue then throws (a SQLITE_BUSY in createIfAbsent, say), the row already
    // points past this occurrence, so without a rollback findDueSchedules never
    // re-selects it until the NEXT occurrence — the fire is lost, and the catch
    // logs a misleading "will retry". The claim must roll back so the next tick
    // genuinely re-fires this occurrence.
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'flaky-enqueue',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'flaky-enqueue',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await pipeline.activate(draft.id);
    await scheduler.scheduleNext(draft.id);
    const dueAt = store.connectors.nextFireAt(draft.id)!;
    await clock.setTime(dueAt + 1000);

    // Fail the enqueue exactly once.
    const realCreate = store.receipts.createIfAbsent.bind(store.receipts);
    let failed = false;
    store.receipts.createIfAbsent = (receipt) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('database is busy'));
      }
      return realCreate(receipt);
    };
    try {
      // First tick: the enqueue throws, the fire is not counted, and the claim
      // must have rolled back so the row is due again.
      assert.equal(await scheduler.fireDueSchedules(), 0, 'the failed enqueue fires nothing');
      assert.equal(
        store.connectors.nextFireAt(draft.id),
        dueAt,
        'the claim rolled back to the due time so the next tick re-selects it',
      );
      // Second tick at the same clock: it re-fires and this time the enqueue works.
      assert.equal(await scheduler.fireDueSchedules(), 1, 'the next tick re-fires the lost occurrence');
    } finally {
      store.receipts.createIfAbsent = realCreate;
    }
    const receipts = await store.receipts.list({ connectorId: draft.id });
    assert.equal(receipts.items.length, 1, 'exactly one receipt for the retried occurrence');
    assert.ok(receipts.items[0]!.externalEventId.endsWith(String(dueAt)), 'and it is for the due tick');
  });

  test('a schedule whose skipIfRunning check throws is retried next tick, not silently lost', async () => {
    // The sibling of the enqueue-rollback bug. The claim advances next_fire_at
    // BEFORE the receipt exists, and skipIfRunning (default true) then runs a
    // store read — sessions.list — which can throw SQLITE_BUSY under write
    // contention, exactly the failure the enqueue rollback defends against. If
    // that throw is not rolled back, next_fire_at already points past this
    // occurrence and findDueSchedules never re-selects it: the fire is lost with
    // a misleading "will retry". The rollback must cover this post-claim store
    // call too, not only the enqueue.
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'flaky-skip-check',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'flaky-skip-check',
      sessionPolicy: 'new_per_event',
      // skipIfRunning defaults to true, so the hasRunningSession read runs.
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await pipeline.activate(draft.id);
    await scheduler.scheduleNext(draft.id);
    const dueAt = store.connectors.nextFireAt(draft.id)!;
    await clock.setTime(dueAt + 1000);

    // Fail the skipIfRunning read exactly once.
    const realList = store.sessions.list.bind(store.sessions);
    let failed = false;
    store.sessions.list = (query) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('database is busy'));
      }
      return realList(query);
    };
    try {
      // First tick: the skip-check throws, the fire is not counted, and the claim
      // must have rolled back so the row is due again.
      assert.equal(await scheduler.fireDueSchedules(), 0, 'the failed skip-check fires nothing');
      assert.equal(
        store.connectors.nextFireAt(draft.id),
        dueAt,
        'the claim rolled back to the due time so the next tick re-selects it',
      );
      // Second tick at the same clock: it re-fires and this time the read works.
      assert.equal(await scheduler.fireDueSchedules(), 1, 'the next tick re-fires the lost occurrence');
    } finally {
      store.sessions.list = realList;
    }
    const receipts = await store.receipts.list({ connectorId: draft.id });
    assert.equal(receipts.items.length, 1, 'exactly one receipt for the retried occurrence');
    assert.ok(receipts.items[0]!.externalEventId.endsWith(String(dueAt)), 'and it is for the due tick');
  });

  test('misfireGraceSeconds:0 still fires an on-time occurrence', async () => {
    // next_fire_at is minute-aligned (cron has minute resolution), but a tick
    // samples the real wall clock, which is essentially never on the :00.000
    // boundary. Measuring lateness as raw `now` minus the minute-aligned
    // `expected` therefore yields a few hundred ms even for a punctual fire, so a
    // grace of 0 — a schema-permitted value (min:0) meaning "no catch-up" — used
    // to drop EVERY occurrence: the schedule stayed active, next_fire_at kept
    // advancing, and it never fired. Lateness must be measured at the resolution
    // cron actually has (whole minutes), so a same-minute fire is 0 late.
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'zero-grace',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'zero-grace',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report', misfireGraceSeconds: 0 },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await pipeline.activate(draft.id);
    await scheduler.scheduleNext(draft.id);
    const dueAt = store.connectors.nextFireAt(draft.id)!;
    // A realistic sub-minute tick offset: the loop sampled the clock 2.137s into
    // the due minute. With grace 0 the old code dropped this; it must fire.
    await clock.setTime(dueAt + 2137);

    assert.equal(await scheduler.fireDueSchedules(), 1, 'an on-time fire is not a misfire at grace 0');
    const receipts = await store.receipts.list({ connectorId: draft.id });
    assert.equal(receipts.items.length, 1, 'the occurrence fired exactly once');
    assert.ok(receipts.items[0]!.externalEventId.endsWith(String(dueAt)), 'and it is the due occurrence');
  });

  test('a fire more than grace-minutes late is still dropped (catch-up guard)', async () => {
    // The counterpart: the misfire drop is a real behaviour and must survive the
    // on-time-detection fix. A fire whole minutes past its time (after an outage)
    // is dropped rather than run at the wrong moment — a nightly report firing at
    // noon is worse than not firing. This path had no test at all, which is how
    // the grace-0 degenerate case went unnoticed.
    const now = clock.now();
    const draft = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'late-drop',
      description: '',
      status: 'draft',
      agentId,
      externalKey: 'late-drop',
      sessionPolicy: 'new_per_event',
      // 5-minute grace; we arrive 10 minutes late.
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report', misfireGraceSeconds: 300 },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    await pipeline.activate(draft.id);
    await scheduler.scheduleNext(draft.id);
    const dueAt = store.connectors.nextFireAt(draft.id)!;
    await clock.setTime(dueAt + 10 * 60_000);

    assert.equal(await scheduler.fireDueSchedules(), 0, 'a fire 10 min late with 5 min grace is dropped');
    const receipts = await store.receipts.list({ connectorId: draft.id });
    assert.equal(receipts.items.length, 0, 'no receipt for the missed occurrence');
    // But the claim advanced, so the schedule is not stuck: the NEXT day fires.
    assert.ok(store.connectors.nextFireAt(draft.id)! > dueAt, 'next_fire_at advanced past the missed tick');
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

  test('a valid but unfireable cron is disabled, not re-fired every minute', async () => {
    // `0 0 30 2 *` is a well-formed cron (day 30, month 2 are each in range) but
    // February never has a 30th, so `nextFireTime` returns undefined — no
    // occurrence within the ~2-year search horizon. The claim used to default a
    // missing next fire to `now + 60s`, so this schedule fired a run and re-armed
    // itself every single minute, forever. It must be disabled instead.
    const now = clock.now();
    const doomed = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'feb-30',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'feb-30',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 0 30 2 *', timezone: 'UTC', prompt: 'never runs' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });
    // Arm it due now, exactly as a legacy row (or the pre-fix scheduleNext) would.
    store.connectors.setNextFire(doomed.id, now - 1000, now);
    await clock.setTime(now + 2000);

    const fired = await scheduler.fireDueSchedules();
    assert.equal(fired, 0, 'an unfireable schedule must not fire a run');

    // It is taken out of service, not left to re-fire every 60s.
    const disabled = await store.connectors.get(doomed.id);
    assert.equal(disabled?.status, 'failed', 'the unfireable schedule is disabled');
    assert.equal(disabled?.error?.code, 'INVALID_SCHEDULE_CONFIG');
    assert.equal(
      (await store.receipts.list({ connectorId: doomed.id })).items.length,
      0,
      'no delivery was ever minted',
    );
  });

  test('scheduleNext disables an unfireable cron instead of silently disarming it', async () => {
    // The twin of the fire-loop case, on the activation/edit path. Arming a
    // schedule whose cron has no next occurrence must surface as a disabled
    // connector, not a still-`active` row with an undefined next fire that never
    // runs and gives the operator no signal.
    const now = clock.now();
    const doomed = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'feb-31',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'feb-31',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 0 31 2 *', timezone: 'UTC', prompt: 'never runs' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    const next = await scheduler.scheduleNext(doomed.id);
    assert.equal(next, undefined, 'no next fire time exists');

    const disabled = await store.connectors.get(doomed.id);
    assert.equal(disabled?.status, 'failed', 'an unfireable schedule is disabled at activation');
    assert.equal(disabled?.error?.code, 'INVALID_SCHEDULE_CONFIG');
  });

  test('a legitimately-sparse leap-day schedule is NOT disabled', async () => {
    // The regression the day-first search + wide horizon guards against: `0 0 29
    // 2 *` (every Feb 29) is valid and recurring, but its next occurrence is
    // usually more than two years out. A short horizon returned undefined and the
    // "disable on undefined" rule would kill a legitimate leap-day schedule after
    // its first fire. The horizon must be wide enough (covering the 8-year
    // century leap gap) that a sparse-but-valid cron resolves.
    const now = clock.now();
    const leap = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'leap-day',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'leap-day',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 0 29 2 *', timezone: 'UTC', prompt: 'happy leap day' },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    const next = await scheduler.scheduleNext(leap.id);
    assert.ok(next !== undefined, 'a leap-day schedule must resolve a next fire time');
    // It falls on a February 29.
    const when = new Date(next!);
    assert.equal(when.getUTCMonth(), 1, 'February');
    assert.equal(when.getUTCDate(), 29, 'the 29th');

    const stillActive = await store.connectors.get(leap.id);
    assert.equal(stillActive?.status, 'active', 'a valid leap-day schedule stays active');
  });

  test('skipIfRunning ignores sessions that belong to another connector or a human', async () => {
    // The silent-skip bug: skipIfRunning counted every live session for the
    // agent, so a human chat or another connector's lingering session made a
    // schedule skip its run forever. It must count only *this* schedule's own
    // sessions.
    const now = clock.now();
    const schedule = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'nightly',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'nightly-skip',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 9 * * *', timezone: 'UTC', prompt: 'report', skipIfRunning: true },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    // An unrelated live session on the same agent: a human's, and another
    // connector's. Neither is this schedule's, so neither should cause a skip.
    const human = await sessions.create(context, { agentId, title: 'human', origin: 'api' });
    await sessions.start(human.id);
    const otherConnectorSession = await sessions.create(context, {
      agentId,
      title: 'other',
      origin: 'connector',
      connectorId: newId('connector'),
    });
    await sessions.start(otherConnectorSession.id);

    // Arm the schedule due now and fire.
    await scheduler.scheduleNext(schedule.id);
    const dueAt = store.connectors.nextFireAt(schedule.id)!;
    await clock.setTime(dueAt + 1000);

    const fired = await scheduler.fireDueSchedules();
    assert.equal(fired, 1, 'the schedule fires despite unrelated live sessions');
    assert.equal(
      (await store.receipts.list({ connectorId: schedule.id })).items.length,
      1,
      'a delivery was minted, not skipped',
    );
  });

  for (const sessionPolicy of ['new_per_event', 'reuse_per_scope', 'reuse_connector'] as const) {
    test(`a ${sessionPolicy} schedule is not suppressed by its own completed (idle) prior run`, async () => {
      // The self-suppression bug: skipIfRunning counted `idle` sessions as
      // "in progress". An idle session is never a reason to skip the next fire:
      //   - new_per_event / reuse_per_scope-on-schedule: scheduled deliveries carry
      //     no binding, so each fire makes a FRESH session; the idle one is a
      //     completed run that lingers ~24h on its TTL and is never reused.
      //   - reuse_connector: the idle session is exactly what the next fire should
      //     reuse — skipping on it drops the fire that would continue it.
      // Either way, a sub-daily schedule went dark for ~24h after its first fire.
      const now = clock.now();
      const schedule = await store.connectors.create({
        id: newId('connector', now),
        workspaceId,
        type: 'schedule',
        name: 'hourly',
        description: '',
        status: 'active',
        agentId,
        externalKey: `hourly-selfskip-${sessionPolicy}`,
        sessionPolicy,
        config: { cron: '0 * * * *', timezone: 'UTC', prompt: 'report', skipIfRunning: true },
        ownerPrincipalId: principal.id,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        createdBy: principal.id,
      });

      // Simulate this schedule's OWN prior run: a session it created that ran a turn
      // and settled to idle (a completed run that lingers on its TTL).
      const priorRun = await sessions.create(context, {
        agentId,
        title: 'prior',
        origin: 'schedule',
        connectorId: schedule.id,
      });
      await sessions.start(priorRun.id);
      await sessions.noteTurnActivity(priorRun.id, 'started');
      await sessions.noteTurnActivity(priorRun.id, 'ended');
      assert.equal((await sessions.get(context, priorRun.id)).status, 'idle', 'the prior run completed to idle');

      // The next hourly fire must proceed — its own completed idle run must not
      // suppress it, regardless of session policy.
      await scheduler.scheduleNext(schedule.id);
      const dueAt = store.connectors.nextFireAt(schedule.id)!;
      await clock.setTime(dueAt + 1000);

      const fired = await scheduler.fireDueSchedules();
      assert.equal(fired, 1, `the ${sessionPolicy} schedule fires despite its own idle prior run`);
      assert.equal(
        (await store.receipts.list({ connectorId: schedule.id })).items.length,
        1,
        'a delivery was minted, not self-suppressed',
      );
    });
  }

  test('skipIfRunning still skips while a prior run is genuinely in flight (running)', async () => {
    // The other half: the guard must still work. A prior run that is actually
    // running (not idle) must suppress the next fire, or two runs overlap.
    const now = clock.now();
    const schedule = await store.connectors.create({
      id: newId('connector', now),
      workspaceId,
      type: 'schedule',
      name: 'hourly-busy',
      description: '',
      status: 'active',
      agentId,
      externalKey: 'hourly-busy',
      sessionPolicy: 'new_per_event',
      config: { cron: '0 * * * *', timezone: 'UTC', prompt: 'report', skipIfRunning: true },
      ownerPrincipalId: principal.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: principal.id,
    });

    const priorRun = await sessions.create(context, {
      agentId,
      title: 'busy',
      origin: 'schedule',
      connectorId: schedule.id,
    });
    await sessions.start(priorRun.id);
    await sessions.noteTurnActivity(priorRun.id, 'started'); // running, not idle
    assert.equal((await sessions.get(context, priorRun.id)).status, 'running');

    await scheduler.scheduleNext(schedule.id);
    const dueAt = store.connectors.nextFireAt(schedule.id)!;
    await clock.setTime(dueAt + 1000);

    const fired = await scheduler.fireDueSchedules();
    assert.equal(fired, 0, 'the fire is skipped while the prior run is genuinely running');
    assert.equal(
      (await store.receipts.list({ connectorId: schedule.id })).items.length,
      0,
      'no delivery minted while a run is in flight',
    );
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

  test('converges on the winner when a peer creates the binding for a new scope first', async () => {
    // The first delivery for a brand-new scope resolves a binding with a
    // read-then-create: findByScope returns nothing, then create() inserts.
    // Two deliveries for the *same* new scope (or the same external event the
    // source retried fast) race that gap: both read no binding, both create, and
    // the loser hits the `UNIQUE (connector_id, scope_key_hash)` constraint. That
    // must converge on the peer's row, not escape `accept()` as a raw 409 before
    // any receipt exists — which would drop the delivery and break the
    // "every delivery has a receipt" guarantee for the first event on a scope.
    const connector = await makeWebhook({ sessionPolicy: 'reuse_per_scope' });

    // Simulate the peer winning the create race exactly once: on the first
    // create call, insert the colliding binding directly (as the peer would),
    // then delegate — so the real create hits the UNIQUE constraint. Only the
    // scoped delivery is affected; the row the peer wrote is the one that must
    // be returned.
    const originalCreate = store.bindings.create.bind(store.bindings);
    let raced = false;
    store.bindings.create = async (binding) => {
      if (!raced) {
        raced = true;
        // The peer's row: same (connector_id, scope_key_hash), different id.
        await originalCreate({ ...binding, id: newId('binding', clock.now()) });
      }
      return originalCreate(binding);
    };
    try {
      const result = await pipeline.accept(
        workspaceId,
        connector.externalKey,
        signedRequest({ scope: 's1', eventId: 'e1', text: 'first' }),
      );
      // The delivery is accepted (or a clean duplicate) — never a 409 dropped
      // before a receipt exists.
      assert.ok(
        result.status === 'accepted' || result.status === 'duplicate',
        `expected the delivery to survive the binding race, got ${result.status}`,
      );
      assert.ok(raced, 'the create race was actually exercised');
      // Exactly one binding for the scope — the peer's winner — and the receipt
      // is bound to it.
      const scopeHash = sha256Hex(`${connector.id}:s1`);
      const winner = await store.bindings.findByScope(connector.id, scopeHash);
      assert.ok(winner, 'the peer-created binding is the surviving row');
      assert.equal(result.receipt?.bindingId, winner!.id);
    } finally {
      store.bindings.create = originalCreate;
    }
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
    rebind: () => Promise.resolve('ok' as const),
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
    // A unique credential name per connector: two chat connectors in one test
    // are workspace-owned, so a shared name would collide on the same
    // MA_CRED_* environment key (`#assertNoEnvKeyCollision`).
    const suffix = Math.random().toString(36).slice(2, 8);
    const credential = await credentials.create(context, {
      workspaceId,
      ownerType: 'workspace',
      type: 'api_key',
      name: `chat secret ${suffix}`,
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
      externalKey: `bot-${suffix}`,
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
  async function readySession(connectorId?: string): Promise<string> {
    const created = await sessions.create(context, {
      agentId,
      title: 'warm',
      origin: 'connector',
      // A connector only reuses its *own* sessions now, so a warm session meant to
      // be reused must carry the connector's id.
      ...(connectorId ? { connectorId } : {}),
    });
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
    const connector = await makeChat();
    const sessionId = await readySession(connector.id);
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

  test('a reuse_connector delivery does not hijack another connector or a human session', async () => {
    // The cross-conversation leak this guards against: reuse used to match any
    // live session for the agent, so a connector could inject its inbound event
    // into a human's chat (or another connector's) and post the reply out to its
    // own external destination. Reuse is now scoped to the connector's own
    // sessions, so a foreign live session is never reused — a fresh one is made.
    const connector = await makeChat();

    // A human (api-origin) session and another connector's session, both live on
    // the same agent, must NOT be reused by this connector.
    const human = await sessions.create(context, { agentId, title: 'human', origin: 'api' });
    await sessions.start(human.id);
    const other = await makeChat();
    const otherSession = await readySession(other.id);

    onSubmit = (sid, wsId) => emitTurn(sid, wsId, 'answer');
    const pipeline = buildPipeline();
    await pipeline.accept(
      workspaceId,
      connector.externalKey,
      chatRequest({ event: { text: 'q', chatId: 'chat-x', messageId: 'm1', senderId: 'u1' } }),
    );
    assert.equal(await pipeline.processNext(), true);

    const receipt = (await store.receipts.list({ connectorId: connector.id })).items[0]!;
    assert.notEqual(receipt.sessionId, human.id, 'must not reuse a human session');
    assert.notEqual(receipt.sessionId, otherSession, "must not reuse another connector's session");
    // The session it did use is this connector's own.
    const used = await store.sessions.get(receipt.sessionId!);
    assert.equal(used?.connectorId, connector.id, 'the delivery ran on this connector’s own session');
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
    const connector = await makeChat();
    const sessionId = await readySession(connector.id);

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

  test('falls back to the signature for dedup when the message carries no id', async () => {
    // A signed chat delivery with no messageId used to get a fresh random dedup
    // id, so a replayed/untagged retry ran a second time. It must derive the id
    // from the signature instead, exactly as the webhook adapter does.
    const req: InboundRequest = {
      headers: { 'x-chat-signature': 'abcdef0123456789abcdef0123456789extra' },
      rawBody: Buffer.from('{}', 'utf8'),
      body: { event: { text: 'no id here', chatId: 'c1', senderId: 'u1' } },
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: clock.now(),
    };
    const trigger = await adapter.normalize(req, connector);
    assert.equal(
      trigger?.externalEventId,
      'sig:abcdef0123456789abcdef0123456789',
      'an untagged signed chat delivery dedups on its signature, not a random id',
    );
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

describe('webhook adapter dedup', () => {
  const clock = new TestClock(START);
  const adapter = webhookAdapter({ clock });
  const connector = { id: 'cn_wh', name: 'hook' } as Connector;

  // A validly-signed webhook whose body carries no eventId. The signature covers
  // `timestamp.rawBody`; the `x-ma-event-id` HEADER is NOT signed.
  function signedRequest(headers: Record<string, string>): InboundRequest {
    const raw = Buffer.from(JSON.stringify({ prompt: 'do the thing' }), 'utf8');
    return {
      headers: { 'x-ma-signature': 'deadbeefdeadbeefdeadbeefdeadbeef0000', ...headers },
      rawBody: raw,
      body: { prompt: 'do the thing' },
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: clock.now(),
    };
  }

  test('an unsigned x-ma-event-id header cannot outrank the signature-derived dedup key', async () => {
    // Replay protection for a signed webhook rests on the dedup key: a captured,
    // byte-identical signed request replayed within the tolerance window must
    // collapse onto one receipt (the `(connector, externalEventId)` UNIQUE index),
    // or it starts a second agent run. The signature-derived `sig:` key does this
    // correctly — but `x-ma-event-id` is an UNSIGNED request header, so an attacker
    // who captures one signed delivery (body without eventId) can replay it with a
    // fresh header each time; if the header outranks `sig:`, every replay gets a
    // distinct dedup key and runs again. The header must not be trusted for dedup
    // on a signed delivery: two identical signed bodies must dedup to the SAME id
    // regardless of the (attacker-chosen) header.
    const a = await adapter.normalize(signedRequest({ 'x-ma-event-id': 'attacker-1' }), connector);
    const b = await adapter.normalize(signedRequest({ 'x-ma-event-id': 'attacker-2' }), connector);
    assert.equal(
      a?.externalEventId,
      b?.externalEventId,
      'identical signed replays must share a dedup key, not be split by an unsigned header',
    );
    // And that shared key is the signature-derived one.
    assert.equal(a?.externalEventId, 'sig:deadbeefdeadbeefdeadbeefdeadbeef');
  });

  test('a signed body’s own eventId is still honoured for dedup', async () => {
    // The producer's own id (inside the signed body) is trustworthy and still wins,
    // so a sender's legitimate retries with a stable eventId deduplicate.
    const raw = Buffer.from(JSON.stringify({ prompt: 'x', eventId: 'evt-42' }), 'utf8');
    const req: InboundRequest = {
      headers: { 'x-ma-signature': 'aaaa1111aaaa1111aaaa1111aaaa1111zzzz', 'x-ma-event-id': 'header-ignored' },
      rawBody: raw,
      body: { prompt: 'x', eventId: 'evt-42' },
      query: new URLSearchParams(),
      sourceIp: '10.0.0.1',
      receivedAt: clock.now(),
    };
    const trigger = await adapter.normalize(req, connector);
    assert.equal(trigger?.externalEventId, 'evt-42', 'the signed body eventId wins over the header');
  });
});

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
