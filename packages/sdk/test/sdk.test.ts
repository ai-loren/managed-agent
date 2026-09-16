/**
 * SDK tests.
 *
 * `fetch` is stubbed rather than a server being started: what matters here is
 * the client's own behaviour — when it retries, when it refuses to, and how it
 * resumes a stream — and a real server would make those hard to provoke.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, TestClock } from '@ma/core';

import { ManagedAgentClient } from '../src/index.ts';

const START = 1_700_000_000_000;

/** A `fetch` that replays scripted responses and records what it was asked. */
function stubFetch(responses: (() => Response)[]): typeof globalThis.fetch & {
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('stub fetch ran out of scripted responses');
    return Promise.resolve(next());
  }) as ReturnType<typeof stubFetch>;
  impl.calls = calls;
  return impl;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Advance the clock only once the client is actually waiting on it.
 *
 * The client registers its backoff sleep after `fetch` resolves, so advancing
 * immediately would move time past a sleeper that does not exist yet and leave
 * it waiting forever. Draining the microtask queue first is what makes these
 * tests deterministic rather than timing-dependent.
 */
async function advanceWhenWaiting(clock: TestClock, ms: number): Promise<void> {
  for (let index = 0; index < 50 && clock.pendingCount === 0; index++) {
    await Promise.resolve();
  }
  // If nothing ever slept, the client chose not to retry — a legitimate
  // outcome, so return rather than waiting for a sleeper that will not arrive.
  if (clock.pendingCount > 0) await clock.advance(ms);
}

function client(
  fetchImpl: typeof globalThis.fetch,
  clock: TestClock,
  options: Partial<ConstructorParameters<typeof ManagedAgentClient>[0]> = {},
): ManagedAgentClient {
  return new ManagedAgentClient({
    baseUrl: 'http://api.test',
    token: 'test-token',
    fetch: fetchImpl,
    clock,
    ...options,
  });
}

describe('requests', () => {
  test('sends the bearer token and parses the response', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([() => json(200, { status: 'ok', version: '1.0' })]);
    const result = await client(stub, clock).health();

    assert.deepEqual(result, { status: 'ok', version: '1.0' });
    const headers = stub.calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer test-token');
  });

  test('drops undefined query parameters rather than sending "undefined"', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([() => json(200, { models: [] })]);
    await client(stub, clock).listModels(undefined);
    assert.equal(stub.calls[0]!.url.includes('workspaceId'), false);
  });

  test('turns an error response into a typed MaError', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([
      () =>
        json(404, {
          error: { code: 'NOT_FOUND', message: "Agent 'ag_1' was not found", retryable: false },
        }),
    ]);

    await assert.rejects(client(stub, clock).getAgent('ag_1'), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.category, 'not_found');
      return true;
    });
  });

  test('returns nothing for a 204', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([() => new Response(null, { status: 204 })]);
    assert.equal(await client(stub, clock).deleteCredential('cr_1', 'cleanup'), undefined);
  });
});

describe('retries', () => {
  test('retries a read that the server said was retryable', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([
      () => json(503, { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } }),
      () => json(200, { status: 'ok', version: '1.0' }),
    ]);

    const promise = client(stub, clock).health();
    await advanceWhenWaiting(clock, 5000);
    await promise;
    assert.equal(stub.calls.length, 2);
  });

  test('never retries a validation error', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([
      () => json(400, { error: { code: 'VALIDATION_FAILED', message: 'bad', retryable: false } }),
    ]);

    await assert.rejects(client(stub, clock).health());
    assert.equal(stub.calls.length, 1, 'retrying a 400 turns one error into three');
  });

  test('does not retry a mutation without an idempotency key', async () => {
    // The request may well have been received; a blind retry is how one
    // session becomes two.
    const clock = new TestClock(START);
    const stub = stubFetch([
      () => json(503, { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } }),
    ]);

    await assert.rejects(
      client(stub, clock).createWorkspace({ name: 'x', slug: 'x-team' }),
    );
    assert.equal(stub.calls.length, 1);
  });

  test('retries a mutation that carries an idempotency key', async () => {
    // Safe, because the server deduplicates on the key.
    const clock = new TestClock(START);
    const stub = stubFetch([
      () => json(503, { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } }),
      () => json(201, { workspace: { id: 'ws_1' } }),
    ]);

    const promise = client(stub, clock).createWorkspace({
      name: 'x',
      slug: 'x-team',
      idempotencyKey: 'key-12345678',
    });
    await advanceWhenWaiting(clock, 5000);
    await promise;

    assert.equal(stub.calls.length, 2);
    const headers = stub.calls[1]!.init!.headers as Record<string, string>;
    assert.equal(headers['idempotency-key'], 'key-12345678', 'the retry reuses the same key');
  });

  test('defaults an idempotency key on session creation', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([() => json(201, { session: { id: 'sn_1' } })]);
    await client(stub, clock).createSession({ agentId: 'ag_1' });

    const headers = stub.calls[0]!.init!.headers as Record<string, string>;
    assert.ok(headers['idempotency-key'], 'creating a session twice is the failure to prevent');
  });

  test('honours a short Retry-After hint', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([
      () =>
        json(
          429,
          { error: { code: 'QUOTA_EXCEEDED', message: 'slow down', retryable: true } },
          { 'retry-after': '2' },
        ),
      () => json(200, { status: 'ok', version: '1.0' }),
    ]);

    const promise = client(stub, clock).health();
    await advanceWhenWaiting(clock, 1000);
    assert.equal(stub.calls.length, 1, 'still waiting out the 2s hint');
    await clock.advance(1500);
    await promise;
    assert.equal(stub.calls.length, 2);
  });

  test('refuses to sleep through a Retry-After longer than the caller would accept', async () => {
    // A daily token budget legitimately suggests hours. Blocking a caller for
    // that long is worse than telling them, so the error surfaces with the hint
    // intact and they decide.
    const clock = new TestClock(START);
    const stub = stubFetch([
      () =>
        json(
          429,
          { error: { code: 'QUOTA_EXCEEDED', message: 'daily budget spent', retryable: true } },
          { 'retry-after': '3600' },
        ),
    ]);

    await assert.rejects(
      client(stub, clock, { maxRetryDelayMs: 10_000 }).health(),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.retryAfterSeconds, 3600, 'the hint reaches the caller');
        return true;
      },
    );
    assert.equal(stub.calls.length, 1);
    assert.equal(clock.pendingCount, 0, 'and nothing was left sleeping');
  });

  test('an HTTP-date Retry-After is dropped, not turned into a NaN delay', async () => {
    // Retry-After may be an HTTP-date, not a seconds count. `Number(date)` is NaN,
    // and NaN slips past the `=== undefined` guard in the retry loop: the delay
    // became `sleep(NaN)`, an immediate retry that hammers the server (and hangs a
    // fake clock). A non-numeric hint must be dropped so `retryAfterSeconds` is
    // undefined and the client uses its normal backoff. Assert the error the
    // client surfaces carries no NaN hint — deterministic, no sleeping involved.
    const clock = new TestClock(START);
    const stub = stubFetch([
      () =>
        json(
          503,
          { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } },
          { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
        ),
    ]);

    // Zero retries, so the error surfaces immediately without any sleep.
    await assert.rejects(
      client(stub, clock, { retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }).health(),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(
          error.retryAfterSeconds,
          undefined,
          'an unparseable Retry-After must be dropped, never surfaced as NaN',
        );
        return true;
      },
    );
    assert.equal(clock.pendingCount, 0, 'nothing was left sleeping on a NaN delay');
  });

  test('gives up after the configured attempts', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch(
      Array.from(
        { length: 3 },
        () => () => json(503, { error: { code: 'UNAVAILABLE', message: 'down', retryable: true } }),
      ),
    );

    const promise = assert.rejects(client(stub, clock, { retry: { maxAttempts: 3 } }).health());
    // Two backoffs between three attempts.
    await advanceWhenWaiting(clock, 10_000);
    await advanceWhenWaiting(clock, 10_000);
    await promise;
    assert.equal(stub.calls.length, 3);
  });
});

describe('event streaming', () => {
  /** An SSE response built from a list of events. */
  function sse(events: { seq: number; type: string; payload?: unknown }[]): Response {
    const body = events
      .map(
        (event) =>
          `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({
            seq: event.seq,
            type: event.type,
            payload: event.payload ?? {},
          })}\n\n`,
      )
      .join('');
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  test('yields events in order', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([
      () =>
        sse([
          { seq: 1, type: 'session.created' },
          { seq: 2, type: 'message.delta' },
          { seq: 3, type: 'session.terminated' },
        ]),
    ]);

    const seen: number[] = [];
    for await (const event of client(stub, clock).streamEvents('sn_1')) {
      seen.push(event.seq);
    }
    assert.deepEqual(seen, [1, 2, 3]);
  });

  test('does not hand a stream notice to the caller as an event', async () => {
    // The bridge emits `stream.lagged` when it caps its hand-over buffer. It
    // deliberately carries no `id:` line — a notice is metadata about the
    // stream, not a position in it — so it has no sequence either. The parser
    // yielded any frame with a `data:` line, so the caller received an object
    // with no `seq` and no `type`, and the cursor arithmetic did
    // `undefined + 1`.
    const clock = new TestClock(START);
    const body =
      `id: 1\nevent: session.created\ndata: ${JSON.stringify({ seq: 1, type: 'session.created', payload: {} })}\n\n` +
      // No id: line, and no seq in the body — exactly what the bridge sends.
      `event: stream.lagged\ndata: ${JSON.stringify({ earliestSeq: 2, droppedCount: 0 })}\n\n` +
      `id: 2\nevent: session.terminated\ndata: ${JSON.stringify({ seq: 2, type: 'session.terminated', payload: {} })}\n\n`;

    const stub = stubFetch([
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);

    const seen: { seq: number; type: string }[] = [];
    for await (const event of client(stub, clock).streamEvents('sn_1')) {
      seen.push({ seq: event.seq, type: event.type });
    }

    assert.deepEqual(
      seen,
      [
        { seq: 1, type: 'session.created' },
        { seq: 2, type: 'session.terminated' },
      ],
      'the notice must be filtered, and the events either side must still arrive',
    );
    for (const event of seen) {
      assert.ok(Number.isInteger(event.seq), 'every yielded event carries a real sequence');
    }
  });

  test('stops at a terminal event rather than reconnecting forever', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([() => sse([{ seq: 1, type: 'session.failed' }])]);

    const seen: string[] = [];
    for await (const event of client(stub, clock).streamEvents('sn_1')) {
      seen.push(event.type);
    }
    assert.deepEqual(seen, ['session.failed']);
    assert.equal(stub.calls.length, 1);
  });

  test('resumes from the last sequence it saw', async () => {
    // A dropped connection must produce neither a gap nor a repeat.
    const clock = new TestClock(START);
    const stub = stubFetch([
      () => sse([{ seq: 1, type: 'message.delta' }, { seq: 2, type: 'message.delta' }]),
      () => sse([{ seq: 3, type: 'session.terminated' }]),
    ]);

    const seen: number[] = [];
    const iterator = client(stub, clock).streamEvents('sn_1')[Symbol.asyncIterator]();

    // Pull one event at a time, releasing the reconnect backoff whenever the
    // client parks on it. Driving the clock explicitly keeps the test
    // deterministic instead of racing a background loop.
    for (;;) {
      const pull = iterator.next();
      for (let index = 0; index < 50; index++) {
        if (clock.pendingCount > 0) {
          await clock.advance(5000);
          break;
        }
        await Promise.resolve();
      }
      const result = await pull;
      if (result.done) break;
      seen.push(result.value.seq);
    }

    assert.deepEqual(seen, [1, 2, 3]);
    assert.ok(
      stub.calls[1]!.url.includes('fromSeq=3'),
      'the reconnect asks for exactly what it has not seen',
    );
  });

  test('skips a malformed frame instead of ending the stream', async () => {
    const clock = new TestClock(START);
    const body =
      'id: 1\ndata: {"seq":1,"type":"message.delta","payload":{}}\n\n' +
      'id: 2\ndata: {not json\n\n' +
      'id: 3\ndata: {"seq":3,"type":"session.terminated","payload":{}}\n\n';
    const stub = stubFetch([
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);

    const seen: number[] = [];
    for await (const event of client(stub, clock).streamEvents('sn_1')) seen.push(event.seq);
    assert.deepEqual(seen, [1, 3], 'one bad frame must not cost the rest of the session');
  });

  test('ignores heartbeat comments', async () => {
    const clock = new TestClock(START);
    const body =
      ': heartbeat\n\n' + 'id: 1\ndata: {"seq":1,"type":"session.terminated","payload":{}}\n\n';
    const stub = stubFetch([
      () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);

    const seen: number[] = [];
    for await (const event of client(stub, clock).streamEvents('sn_1')) seen.push(event.seq);
    assert.deepEqual(seen, [1]);
  });

  test('stops when the caller aborts', async () => {
    const clock = new TestClock(START);
    const controller = new AbortController();
    const stub = stubFetch([() => sse([{ seq: 1, type: 'message.delta' }])]);

    const seen: number[] = [];
    for await (const event of client(stub, clock).streamEvents('sn_1', {
      signal: controller.signal,
    })) {
      seen.push(event.seq);
      controller.abort();
    }
    assert.deepEqual(seen, [1]);
  });

  test('surfaces an error response rather than retrying it silently', async () => {
    const clock = new TestClock(START);
    const stub = stubFetch([
      () => json(403, { error: { code: 'PERMISSION_DENIED', message: 'no', retryable: false } }),
    ]);

    await assert.rejects(async () => {
      for await (const _event of client(stub, clock).streamEvents('sn_1')) {
        // The first pull should throw.
      }
    }, (error: unknown) => MaError.is(error) && error.code === 'PERMISSION_DENIED');
  });
});
