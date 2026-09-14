import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_PREFIXES,
  InMemoryKeyProvider,
  CircuitBreaker,
  MaError,
  StateMachine,
  TestClock,
  backoffDelay,
  canonicalJson,
  hmacSha256Hex,
  isId,
  kindOf,
  newId,
  quotaExceeded,
  safeEqual,
  seal,
  timeOf,
  ulid,
  unseal,
  verifySignature,
  withRetry,
  withTimeout,
  createLogger,
  memorySink,
} from '../src/index.ts';

describe('ids', () => {
  test('mints prefixed ids that validate and round-trip their kind', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      assert.ok(isId(id), `${id} should be a valid id`);
      assert.equal(kindOf(id), kind);
      assert.ok(id.startsWith(`${ID_PREFIXES[kind]}_`));
    }
  });

  test('rejects malformed ids', () => {
    for (const bad of ['', 'nope', 'ws_', '_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'zz_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ws_lowercase1234567890abcdef', 'ws_01ARZ3NDEKTSV4RRFFQ69G5FA']) {
      assert.equal(isId(bad), false, `${bad} should be rejected`);
    }
    assert.equal(isId(42), false);
    assert.equal(isId(null), false);
  });

  test('distinguishes kinds so a session id is not accepted as an agent id', () => {
    const session = newId('session');
    assert.equal(isId(session, 'session'), true);
    assert.equal(isId(session, 'agent'), false);
  });

  test('encodes creation time and sorts lexicographically by it', () => {
    const early = newId('session', 1_700_000_000_000);
    const late = newId('session', 1_700_000_001_000);
    assert.equal(timeOf(early), 1_700_000_000_000);
    assert.equal(timeOf(late), 1_700_000_001_000);
    assert.ok(early < late, 'ids must sort by creation time as plain strings');
  });

  test('generates unique ids within the same millisecond', () => {
    const now = 1_700_000_000_000;
    const ids = new Set(Array.from({ length: 2000 }, () => ulid(now)));
    assert.equal(ids.size, 2000);
  });
});

describe('errors', () => {
  test('maps categories to HTTP statuses and retryability', () => {
    assert.equal(new MaError({ code: 'X', category: 'validation', message: 'm' }).status, 400);
    assert.equal(new MaError({ code: 'X', category: 'not_found', message: 'm' }).status, 404);
    assert.equal(new MaError({ code: 'X', category: 'conflict', message: 'm' }).status, 409);
    assert.equal(new MaError({ code: 'X', category: 'quota', message: 'm' }).status, 429);
    assert.equal(new MaError({ code: 'X', category: 'unavailable', message: 'm' }).retryable, true);
    assert.equal(new MaError({ code: 'X', category: 'validation', message: 'm' }).retryable, false);
  });

  test('omits cause and stack from the client-facing shape', () => {
    const error = new MaError({
      code: 'BOOM',
      category: 'internal',
      message: 'exploded',
      cause: new Error('secret internal detail'),
      details: { hint: 'safe' },
    });
    const json = JSON.stringify(error.toJSON());
    assert.ok(!json.includes('secret internal detail'));
    assert.ok(json.includes('BOOM'));
    assert.ok(json.includes('safe'));
  });

  test('wraps unknown throws without losing the original', () => {
    const wrapped = MaError.from(new TypeError('bad type'));
    assert.equal(wrapped.category, 'internal');
    assert.equal(wrapped.message, 'bad type');
    assert.ok(wrapped.cause instanceof TypeError);
  });

  test('passes MaError through unchanged', () => {
    const original = quotaExceeded('sessions', 10, 11, 30);
    assert.equal(MaError.from(original), original);
    assert.equal(original.retryAfterSeconds, 30);
  });
});

describe('state machine', () => {
  const sm = new StateMachine({
    name: 'Session',
    initial: 'queued',
    transitions: {
      queued: ['provisioning', 'failed'],
      provisioning: ['ready', 'failed'],
      ready: ['running', 'terminating', 'failed'],
      running: ['idle', 'terminating', 'failed'],
      idle: ['running', 'terminating', 'failed'],
      terminating: ['terminated', 'failed'],
      terminated: [],
      failed: [],
    },
  });

  test('permits declared transitions and rejects the rest', () => {
    assert.equal(sm.canTransition('queued', 'provisioning'), true);
    assert.equal(sm.canTransition('queued', 'running'), false);
    assert.equal(sm.assert('ready', 'running'), 'running');
    assert.throws(() => sm.assert('terminated', 'running'), (e: unknown) => {
      assert.ok(MaError.is(e));
      assert.equal(e.code, 'INVALID_STATE_TRANSITION');
      assert.equal(e.status, 412);
      return true;
    });
  });

  test('identifies terminal states', () => {
    assert.equal(sm.isTerminal('terminated'), true);
    assert.equal(sm.isTerminal('failed'), true);
    assert.equal(sm.isTerminal('running'), false);
  });

  test('answers reachability so callers can ask if success is still possible', () => {
    assert.equal(sm.canEventuallyReach('queued', 'terminated'), true);
    assert.equal(sm.canEventuallyReach('failed', 'running'), false);
  });
});

describe('clock', () => {
  test('advance releases sleepers in deadline order', async () => {
    const clock = new TestClock(1000);
    const order: string[] = [];
    const a = clock.sleep(300).then(() => void order.push('a'));
    const b = clock.sleep(100).then(() => void order.push('b'));
    const c = clock.sleep(200).then(() => void order.push('c'));
    await clock.advance(300);
    await Promise.all([a, b, c]);
    assert.deepEqual(order, ['b', 'c', 'a']);
    assert.equal(clock.pendingCount, 0);
  });

  test('does not release a sleeper before its deadline', async () => {
    const clock = new TestClock();
    let fired = false;
    void clock.sleep(500).then(() => {
      fired = true;
    });
    await clock.advance(499);
    assert.equal(fired, false);
    await clock.advance(1);
    await Promise.resolve();
    assert.equal(fired, true);
  });

  test('aborting a sleep rejects and removes it', async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    const pending = clock.sleep(1000, controller.signal);
    controller.abort();
    await assert.rejects(pending, (e: unknown) => (e as Error).name === 'AbortError');
    assert.equal(clock.pendingCount, 0);
  });
});

describe('retry', () => {
  test('retries retryable failures then succeeds', async () => {
    const clock = new TestClock();
    let attempts = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new MaError({ code: 'X', category: 'unavailable', message: 'down' });
        return 'done';
      },
      { clock, policy: { initialDelayMs: 10, jitter: false } },
    );
    // Drive the clock past both backoffs.
    for (let i = 0; i < 6; i++) await clock.advance(100);
    assert.equal(await promise, 'done');
    assert.equal(attempts, 3);
  });

  test('does not retry a non-retryable failure', async () => {
    const clock = new TestClock();
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts++;
          throw new MaError({ code: 'BAD', category: 'validation', message: 'nope' });
        },
        { clock },
      ),
    );
    assert.equal(attempts, 1, 'a validation error must not be retried');
  });

  test('gives up after maxAttempts and rethrows the last error', async () => {
    const clock = new TestClock();
    let attempts = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        throw new MaError({ code: 'X', category: 'unavailable', message: `fail ${attempts}` });
      },
      { clock, policy: { maxAttempts: 3, initialDelayMs: 5, jitter: false } },
    );
    const assertion = assert.rejects(promise, /fail 3/);
    for (let i = 0; i < 6; i++) await clock.advance(50);
    await assertion;
    assert.equal(attempts, 3);
  });

  test('honours a server Retry-After hint over computed backoff', async () => {
    const clock = new TestClock();
    const delays: number[] = [];
    let attempts = 0;
    const promise = withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw quotaExceeded('sessions', 1, 2, 7);
        return 'ok';
      },
      {
        clock,
        policy: { initialDelayMs: 1000, jitter: false },
        onRetry: ({ delayMs }) => void delays.push(delayMs),
      },
    );
    for (let i = 0; i < 4; i++) await clock.advance(5000);
    assert.equal(await promise, 'ok');
    assert.deepEqual(delays, [7000], 'Retry-After of 7s must win over the 1s policy');
  });

  test('backoff grows exponentially and respects the cap', () => {
    const policy = { maxAttempts: 9, initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2, jitter: false };
    assert.equal(backoffDelay(1, policy), 100);
    assert.equal(backoffDelay(2, policy), 200);
    assert.equal(backoffDelay(3, policy), 400);
    assert.equal(backoffDelay(9, policy), 1000, 'must clamp at maxDelayMs');
  });

  test('full jitter keeps delays within [0, cap]', () => {
    const policy = { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2, jitter: true };
    for (const r of [0, 0.5, 0.999]) {
      const delay = backoffDelay(3, policy, () => r);
      assert.ok(delay >= 0 && delay <= 400, `${delay} out of range`);
    }
  });

  test('withTimeout rejects slow work with a TIMEOUT error', async () => {
    const clock = new TestClock();
    const never = new Promise<string>(() => {});
    const promise = withTimeout(never, 100, 'slow', clock);
    const assertion = assert.rejects(promise, (e: unknown) => {
      assert.ok(MaError.is(e));
      assert.equal(e.code, 'TIMEOUT');
      return true;
    });
    await clock.advance(100);
    await assertion;
  });
});

describe('circuit breaker', () => {
  const opts = { failureThreshold: 3, windowMs: 1000, resetMs: 5000 };

  test('trips open after the failure threshold within the window', () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });

    // Below the threshold: still closed and allowed.
    breaker.recordFailure('m');
    breaker.recordFailure('m');
    assert.deepEqual(breaker.canAttempt('m'), { allowed: true, state: 'closed' });

    // The third failure trips it.
    breaker.recordFailure('m');
    assert.deepEqual(breaker.canAttempt('m'), { allowed: false, state: 'open' });
  });

  test('failures outside the window do not accumulate toward a trip', async () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    breaker.recordFailure('m');
    breaker.recordFailure('m');
    // Move past the window; the two earlier failures age out.
    await clock.advance(1001);
    breaker.recordFailure('m');
    assert.equal(breaker.stateOf('m'), 'closed', 'stale failures must not trip the breaker');
  });

  test('a probe success closes the breaker and clears history', async () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 3; i++) breaker.recordFailure('m'); // trip
    await clock.advance(5001);
    assert.equal(breaker.canAttempt('m').allowed, true, 'probe admitted');
    breaker.recordSuccess('m'); // recovered probe
    assert.deepEqual(breaker.canAttempt('m'), { allowed: true, state: 'closed' });
    // History cleared: it takes a fresh threshold to trip again.
    breaker.recordFailure('m');
    breaker.recordFailure('m');
    assert.equal(breaker.stateOf('m'), 'closed');
  });

  test('a closed-state success does not wipe the rolling window (partial outage still trips)', () => {
    // The breaker must trip on "N failures within the window", not "N failures
    // uninterrupted by a success" — otherwise a provider failing intermittently
    // keeps resetting the count and never trips. Interleave successes with
    // failures and confirm it still opens.
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts }); // threshold 3, window 1000
    breaker.recordFailure('m');
    breaker.recordSuccess('m'); // a closed success must NOT clear the failure
    breaker.recordFailure('m');
    breaker.recordSuccess('m');
    breaker.recordFailure('m'); // third failure within the window
    assert.equal(breaker.stateOf('m'), 'open', 'a 50%-outage pattern still trips the breaker');
  });

  test('half-opens after resetMs and admits exactly one probe', async () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 3; i++) breaker.recordFailure('m');
    assert.equal(breaker.canAttempt('m').allowed, false, 'open right after tripping');

    await clock.advance(5001); // past resetMs
    // The first caller gets the single probe...
    assert.deepEqual(breaker.canAttempt('m'), { allowed: true, state: 'half-open' });
    // ...concurrent callers do not.
    assert.deepEqual(breaker.canAttempt('m'), { allowed: false, state: 'half-open' });
    assert.deepEqual(breaker.canAttempt('m'), { allowed: false, state: 'half-open' });
  });

  test('a successful probe closes the breaker', async () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 3; i++) breaker.recordFailure('m');
    await clock.advance(5001);
    assert.equal(breaker.canAttempt('m').allowed, true, 'the probe is admitted');
    breaker.recordSuccess('m');
    assert.deepEqual(breaker.canAttempt('m'), { allowed: true, state: 'closed' });
  });

  test('a failed probe re-opens for another cooldown', async () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 3; i++) breaker.recordFailure('m');
    await clock.advance(5001);
    assert.equal(breaker.canAttempt('m').allowed, true, 'the probe is admitted');
    breaker.recordFailure('m'); // probe fails
    assert.deepEqual(breaker.canAttempt('m'), { allowed: false, state: 'open' });
    // And it re-opens for a fresh cooldown, not immediately half-open again.
    await clock.advance(4999);
    assert.equal(breaker.canAttempt('m').allowed, false, 'still open before the new cooldown elapses');
  });

  test('a probe that fails with a non-counting error still settles (never wedged)', async () => {
    // The stuck-probe bug: an admitted half-open probe MUST clear `probing` even
    // when the failure does not count toward tripping (a caller error). Otherwise
    // `probing` stays true forever and the key is locked out — no further probe
    // is ever admitted. A failed probe re-opens regardless of countsTowardTrip.
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 3; i++) breaker.recordFailure('m');
    await clock.advance(5001);
    assert.equal(breaker.canAttempt('m').allowed, true, 'the probe is admitted');
    // Probe fails with a NON-counting error (countsTowardTrip = false).
    breaker.recordFailure('m', false);
    assert.equal(breaker.stateOf('m'), 'open', 're-opened, not stuck half-open');
    // Recovery still works: after another cooldown, a fresh probe is admitted.
    await clock.advance(5001);
    assert.equal(breaker.canAttempt('m').allowed, true, 'the key is not locked out');
  });

  test('a non-counting failure never trips a closed breaker', () => {
    // A caller error (validation) must not open the breaker against a healthy key,
    // no matter how many arrive.
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 10; i++) breaker.recordFailure('m', false);
    assert.deepEqual(breaker.canAttempt('m'), { allowed: true, state: 'closed' });
  });

  test('keys are independent: one tripped model does not affect another', () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, ...opts });
    for (let i = 0; i < 3; i++) breaker.recordFailure('down');
    assert.equal(breaker.canAttempt('down').allowed, false);
    assert.deepEqual(breaker.canAttempt('healthy'), { allowed: true, state: 'closed' });
  });

  test('disabled (threshold 0) always allows and never trips', () => {
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, failureThreshold: 0, windowMs: 1000, resetMs: 5000 });
    assert.equal(breaker.enabled, false);
    for (let i = 0; i < 100; i++) breaker.recordFailure('m');
    assert.deepEqual(breaker.canAttempt('m'), { allowed: true, state: 'closed' });
    assert.equal(breaker.stateOf('m'), 'closed');
  });

  test('a zero window is treated as disabled, not enabled-but-inert', () => {
    // windowMs 0 would prune every failure the instant it lands, so the breaker
    // could never trip. Rather than report "enabled" and silently do nothing,
    // it counts as disabled — honest and consistent.
    const clock = new TestClock(1000);
    const breaker = new CircuitBreaker({ clock, failureThreshold: 3, windowMs: 0, resetMs: 5000 });
    assert.equal(breaker.enabled, false);
    for (let i = 0; i < 10; i++) breaker.recordFailure('m');
    assert.equal(breaker.canAttempt('m').allowed, true);
  });
});

describe('crypto', () => {
  test('canonicalJson sorts object keys recursively and stably', () => {
    // The same logical value built in a different key order must serialize
    // identically — that is the whole point for hashing.
    const a = canonicalJson({ b: 1, a: 2, nested: { y: 1, x: 2 } });
    const b = canonicalJson({ nested: { x: 2, y: 1 }, a: 2, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1,"nested":{"x":2,"y":1}}');
  });

  test('canonicalJson preserves array order but sorts keys within elements', () => {
    // Arrays are order-significant; only object keys are reordered.
    const out = canonicalJson([{ b: 1, a: 2 }, { d: 4, c: 3 }]);
    assert.equal(out, '[{"a":2,"b":1},{"c":3,"d":4}]');
  });

  test('canonicalJson drops undefined fields, like JSON.stringify', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  test('canonicalJson distinguishes values that differ only in content', () => {
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
    assert.notEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
  });

  test('seals and unseals a value', () => {
    const provider = InMemoryKeyProvider.generate('v1');
    const sealed = seal('super-secret-token', provider, 'cr_123');
    assert.ok(!sealed.ciphertext.includes('super-secret'));
    assert.equal(sealed.keyVersion, 'v1');
    assert.equal(unseal(sealed, provider, 'cr_123'), 'super-secret-token');
  });

  test('refuses to decrypt when the AAD context differs', () => {
    const provider = InMemoryKeyProvider.generate();
    const sealed = seal('value', provider, 'cr_owner_a');
    // A ciphertext copied onto another row must not decrypt.
    assert.throws(() => unseal(sealed, provider, 'cr_owner_b'));
  });

  test('detects tampering with the ciphertext', () => {
    const provider = InMemoryKeyProvider.generate();
    const sealed = seal('value', provider);
    const raw = Buffer.from(sealed.ciphertext, 'base64');
    const last = raw.length - 1;
    raw[last] = raw[last]! ^ 0xff;
    assert.throws(() => unseal({ ...sealed, ciphertext: raw.toString('base64') }, provider));
  });

  test('supports key rotation by reading old versions', () => {
    const k1 = Buffer.alloc(32, 1);
    const k2 = Buffer.alloc(32, 2);
    const old = new InMemoryKeyProvider({ v1: k1 }, 'v1');
    const sealed = seal('legacy', old);
    const rotated = new InMemoryKeyProvider({ v1: k1, v2: k2 }, 'v2');
    assert.equal(unseal(sealed, rotated), 'legacy', 'old ciphertexts must stay readable');
    assert.equal(seal('fresh', rotated).keyVersion, 'v2', 'new writes use the current key');
  });

  test('produces a different ciphertext each time (random IV)', () => {
    const provider = InMemoryKeyProvider.generate();
    assert.notEqual(seal('same', provider).ciphertext, seal('same', provider).ciphertext);
  });

  test('safeEqual compares without throwing on length mismatch', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('short', 'a-much-longer-value'), false);
    assert.equal(safeEqual('', ''), true);
  });

  test('verifies a fresh signature and rejects replays and forgeries', () => {
    const now = 1_700_000_000_000;
    const secret = 'webhook-secret';
    const payload = '{"event":"ping"}';
    const signature = hmacSha256Hex(secret, `${now}.${payload}`);

    assert.equal(verifySignature({ secret, payload, signature, timestamp: now, now }), true);
    assert.equal(
      verifySignature({ secret, payload, signature, timestamp: now, now: now + 600_000 }),
      false,
      'a signature older than the tolerance must be rejected',
    );
    assert.equal(
      verifySignature({ secret: 'wrong', payload, signature, timestamp: now, now }),
      false,
    );
    assert.equal(
      verifySignature({ secret, payload: '{"event":"tampered"}', signature, timestamp: now, now }),
      false,
    );
  });
});

describe('logger', () => {
  test('redacts secret-named fields at any depth', () => {
    const sink = memorySink();
    const log = createLogger({ sink, level: 'debug' });
    log.info('created', {
      credential: 'plain-secret',
      nested: { apiKey: 'another-secret', safe: 'visible' },
      list: [{ token: 'third-secret' }],
    });
    const line = JSON.stringify(sink.records[0]);
    assert.ok(!line.includes('plain-secret'));
    assert.ok(!line.includes('another-secret'));
    assert.ok(!line.includes('third-secret'));
    assert.ok(line.includes('visible'));
  });

  test('child loggers accumulate context', () => {
    const sink = memorySink();
    const log = createLogger({ sink }).child({ requestId: 'req_1' }).child({ sessionId: 'sn_1' });
    log.info('hello');
    assert.equal(sink.records[0]?.requestId, 'req_1');
    assert.equal(sink.records[0]?.sessionId, 'sn_1');
  });

  test('suppresses entries below the configured level', () => {
    const sink = memorySink();
    const log = createLogger({ sink, level: 'warn' });
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    assert.equal(sink.records.length, 2);
  });
});
