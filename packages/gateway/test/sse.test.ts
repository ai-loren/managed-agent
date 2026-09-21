/**
 * SSE backpressure tests.
 *
 * The bridge streams a session's event log to a client: replay the persisted log,
 * then go live. The property under test here is that it does not buffer without
 * limit for a slow consumer — writes are paced to the client's `drain`, and a
 * client that stops reading is disconnected (it resumes later from Last-Event-ID,
 * since the log is the source of truth), rather than growing the server's memory.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { TestClock, newId, nullLogger } from '@ma/core';
import type { SessionEvent } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';
import { EventBus } from '@ma/engine';
import type { ServerResponse } from 'node:http';

import { SseBridge } from '../src/index.ts';

const START = 1_700_000_000_000;
const WS = 'ws_01ARZ3ND';
const SN = 'sn_01ARZ3ND';

/**
 * A fake ServerResponse that models write backpressure. When `blocked` is true,
 * `write()` returns false (the socket buffer is full); a test calls `drain()` to
 * flush and emit the `drain` event the bridge waits on.
 */
class FakeResponse extends EventEmitter {
  writes: string[] = [];
  ended = false;
  blocked = false;
  /**
   * When true, the socket re-blocks after each `drain()` releases one write —
   * giving a test frame-by-frame control so it can park the write loop at an
   * exact seq (needed to reproduce the handover flush/pump interleaving).
   */
  reblockAfterDrain = false;

  write(chunk: string): boolean {
    if (this.ended) return false;
    this.writes.push(chunk);
    return !this.blocked;
  }

  end(): void {
    this.ended = true;
    this.emit('close');
  }

  /** Unblock and signal drain, as a real socket does once its buffer empties. */
  drain(): void {
    this.blocked = false;
    this.emit('drain');
    // Re-arm backpressure for the next write, so the loop parks again after the
    // one write this drain permitted.
    if (this.reblockAfterDrain) this.blocked = true;
  }

  /** Count of `id:` frames written — one per delivered event. */
  get eventFrames(): number {
    return this.writes.filter((w) => w.startsWith('id: ')).length;
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

let store: SqliteStore;
let bus: EventBus;
let clock: TestClock;

function makeEvent(seq: number): Omit<SessionEvent, 'seq'> {
  return {
    id: newId('event'),
    sessionId: SN,
    workspaceId: WS,
    ts: START,
    type: 'message.delta',
    payload: { text: `e${seq}` },
  } as Omit<SessionEvent, 'seq'>;
}

async function seedLog(count: number): Promise<void> {
  const events = Array.from({ length: count }, (_, i) => makeEvent(i + 1));
  await store.events.append(SN, events);
}

/**
 * Seed the workspace → agent → session FK chain so a real session row (with a
 * durable `last_seq` watermark) exists — needed by the full-prune resume tests,
 * where only the session row's watermark reveals a gap after every event row is
 * pruned.
 */
async function seedSessionRow(lastSeq: number): Promise<void> {
  await store.workspaces.create({
    id: WS,
    slug: 'sse-test',
    name: 'SSE',
    description: '',
    status: 'active',
    members: [],
    quota: {
      maxConcurrentSessions: 100,
      maxSandboxes: 100,
      maxTokensPerDay: 1_000_000,
      maxCostMicrosPerDay: 0,
      maxStorageMb: 1024,
      maxAgents: 100,
      maxKnowledgeChunks: 100_000,
      eventRetentionDays: 90,
    },
    systemPrompt: '',
    version: 1,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'pr_test',
  });
  const agentId = newId('agent');
  await store.agents.create({
    id: agentId,
    workspaceId: WS,
    name: 'Agent',
    description: '',
    status: 'active',
    latestVersion: 1,
    labels: [],
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'pr_test',
  });
  await store.sessions.create({
    id: SN,
    workspaceId: WS,
    agentId,
    resolvedVersion: 1,
    title: '',
    status: 'idle',
    origin: 'api',
    credentialIds: [],
    lastSeq,
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'pr_test',
  });
}

beforeEach(() => {
  store = createMemoryStore();
  clock = new TestClock(START);
  bus = new EventBus(store, clock, nullLogger);
});

afterEach(async () => {
  bus.closeAll();
  await store.close();
});

describe('sse backpressure', () => {
  test('replay pauses at a batch boundary until the client drains', async () => {
    // With a blocked client, the replay must not write the whole log into the
    // socket buffer — it writes at most about one batch, then waits for drain.
    await seedLog(25);
    const res = new FakeResponse();
    res.blocked = true;

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 5,
      drainTimeoutMs: 100_000,
    });

    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );

    // Let the replay run as far as backpressure allows.
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      res.eventFrames <= 6,
      `a blocked client must pause replay near one batch, wrote ${res.eventFrames}`,
    );
    assert.ok(res.eventFrames >= 1, 'it should have written at least the first batch');
    assert.ok(!res.ended, 'not disconnected while within the drain timeout');

    controller.abort();
    await streaming;
  });

  test('draining resumes replay to completion with no gap or duplicate', async () => {
    await seedLog(25);
    const res = new FakeResponse();
    res.blocked = true;

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 5,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );

    // Repeatedly drain until the whole log is delivered.
    for (let i = 0; i < 20 && res.eventFrames < 25; i++) {
      await new Promise((r) => setTimeout(r, 5));
      res.drain();
    }
    await new Promise((r) => setTimeout(r, 10));

    const ids = res.writes
      .filter((w) => w.startsWith('id: '))
      .map((w) => Number(w.slice('id: '.length).trim()));
    assert.deepEqual(ids, Array.from({ length: 25 }, (_, i) => i + 1), 'every seq once, in order');

    controller.abort();
    await streaming;
  });

  test('a client that never drains is disconnected at the drain timeout', async () => {
    await seedLog(25);
    const res = new FakeResponse();
    res.blocked = true;

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 5,
      drainTimeoutMs: 1000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!res.ended, 'still waiting before the timeout elapses');

    // The drain never comes; advance past the timeout.
    await clock.advance(1500);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(res.ended, 'a stuck client must be disconnected at the drain timeout');

    await streaming;
  });

  test('a client that disconnects mid-backpressure settles at once, not at the timeout', async () => {
    // A blocked client that closes its socket must not leave the drain wait
    // dangling until drainTimeoutMs — the stream should end promptly. Uses a long
    // timeout so a hang would be observable if `close` did not settle the wait.
    await seedLog(25);
    const res = new FakeResponse();
    res.blocked = true;

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 5,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!res.ended, 'still streaming while blocked');

    // The client drops. `end()` emits 'close'; the pending drain wait settles and
    // the stream resolves without advancing the clock past the drain timeout.
    res.end();
    await streaming; // resolves promptly; would hang to the 100s timeout if broken
  });

  test('a live event during the pending-flush does not drop lower-seq pending events', async () => {
    // The handover race: pending (lower seqs, arrived during replay) and the live
    // pump (higher seqs) share the monotonic lastSent cursor. If the pump emitted
    // a higher live seq while the flush was parked on drain, lastSent would jump
    // past un-flushed pending events and silently suppress them — a permanent gap
    // with no lagged signal. The client must still receive every seq, in order.
    await seedLog(4); // log has 1..4
    const res = new FakeResponse();
    res.reblockAfterDrain = true; // one write per drain, so we can park at a seq

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 50,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();

    // Block, so the write loop parks after each frame until we single-step it.
    res.blocked = true;
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );
    await new Promise((r) => setTimeout(r, 10)); // replay wrote 1, parked

    // Fill `pending` with live events 5,6 while still replaying.
    await bus.publish([makeEvent(5)]);
    await bus.publish([makeEvent(6)]);
    await new Promise((r) => setTimeout(r, 5));

    // Single-step: 1 is already written; drain to walk 2,3,4 (replay), then 5
    // (first pending). After 5 is written the flush parks awaiting drain on 6.
    while (res.eventFrames < 5) {
      res.drain();
      await new Promise((r) => setTimeout(r, 3));
    }
    // The flush is now parked between 5 and 6. Inject a higher-seq live event.
    // In the buggy version the ungated pump emits 7 here, advancing lastSent to 7,
    // so when the flush resumes it suppresses 6 (6 <= 7) — a permanent gap.
    await bus.publish([makeEvent(7)]);
    await new Promise((r) => setTimeout(r, 5));

    // Drain to completion.
    for (let i = 0; i < 8 && res.eventFrames < 7; i++) {
      res.drain();
      await new Promise((r) => setTimeout(r, 3));
    }
    await new Promise((r) => setTimeout(r, 10));

    const ids = res.writes
      .filter((w) => w.startsWith('id: '))
      .map((w) => Number(w.slice('id: '.length).trim()));
    assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7], `expected 1..7 with no gap, got ${ids.join(',')}`);

    controller.abort();
    await streaming;
  });

  test('a live-queue overflow recovers the dropped interior events from the log', async () => {
    // A burst overflows the bounded live queue while the client is stalled. The
    // dropped events are INTERIOR: after the drop, later events are admitted and
    // emitted, advancing lastSent past the gap. The buggy version then reported
    // stream.lagged { earliestSeq: lastSent + 1 } — PAST the gap — so the client
    // (which ignores the notice anyway) permanently lost the dropped range. The
    // fix self-heals: it re-reads the log from the first dropped seq and re-sends
    // the tail in order, so the client ends up with every seq, no interior hole.
    await seedLog(1); // seq 1 in the log; the rest arrive live
    const res = new FakeResponse();

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 50,
      replayBufferLimit: 2, // tiny live queue, so a small burst overflows it
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );
    // Replay seq 1 and go live.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(res.eventFrames, 1, 'seq 1 replayed');

    // Block the socket so the pump parks and cannot drain the live queue.
    res.blocked = true;
    // Publish a burst of live events. bus.publish persists to the log AND fans
    // out with one consistent seq, so the log and the live stream agree. With a
    // queue limit of 2, seqs past the 2nd are dropped — an interior gap once
    // later ones are admitted after we unblock.
    for (let seq = 2; seq <= 12; seq++) {
      await bus.publish([makeEvent(seq)]);
    }
    await new Promise((r) => setTimeout(r, 5));

    // Unblock and let the pump drain + self-heal from the log.
    for (let i = 0; i < 30 && res.eventFrames < 12; i++) {
      res.drain();
      await new Promise((r) => setTimeout(r, 3));
    }
    await new Promise((r) => setTimeout(r, 10));

    const ids = res.writes
      .filter((w) => w.startsWith('id: '))
      .map((w) => Number(w.slice('id: '.length).trim()));
    // The client must have seen every seq 1..12 — duplicates are allowed (the
    // self-heal re-sends some already-delivered seqs, deduped client-side by id),
    // but no seq may be MISSING.
    const seen = new Set(ids);
    const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter((s) => !seen.has(s));
    assert.deepEqual(missing, [], `no seq may be lost to a live overflow; missing ${missing.join(',')}`);

    controller.abort();
    await streaming;
  });

  test('a replay-buffer overflow recovers the dropped events from the log, like the live path', async () => {
    // The sibling of the live-overflow self-heal, for the REPLAY hand-over buffer.
    // While the replay loop is parked on the final batch's drain, `replaying` is
    // still true, so newly-published events route to `pending`; once `pending`
    // hits its cap they are dropped (newest first). Those dropped seqs are neither
    // in `pending` (dropped) nor `liveQueue` (routed to pending while replaying),
    // and the replay loop already passed them — so without recovery `lastSent`
    // jumps over them and the client has a permanent silent hole (the
    // `stream.lagged{during:'replay'}` notice alone does not close it — both
    // shipped clients ignore it). The fix re-reads the log from the first unseen
    // seq after the flush, exactly as the live-overflow branch does.
    await seedLog(1); // seq 1 in the log; the burst arrives live during replay
    const res = new FakeResponse();
    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      replayBatchSize: 50,
      replayBufferLimit: 2, // tiny hand-over buffer, so a small burst overflows it
      heartbeatMs: 100_000,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();

    // Block the socket so the replay parks on seq 1's write — `replaying` stays
    // true, so events published now route to `pending`.
    res.blocked = true;
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );
    await new Promise((r) => setTimeout(r, 10)); // replay attempted seq 1, parked on drain

    // Burst of live events WHILE replaying: they route to `pending` (limit 2), so
    // seqs past the 2nd are dropped — the interior hole the fix must recover.
    for (let seq = 2; seq <= 12; seq++) {
      await bus.publish([makeEvent(seq)]);
    }
    await new Promise((r) => setTimeout(r, 5));

    // Unblock: the replay flush completes, then (overflowed) the fix re-reads the
    // log and re-sends the dropped tail; the pump drains the rest.
    for (let i = 0; i < 40 && res.eventFrames < 12; i++) {
      res.drain();
      await new Promise((r) => setTimeout(r, 3));
    }
    await new Promise((r) => setTimeout(r, 10));

    const ids = res.writes
      .filter((w) => w.startsWith('id: '))
      .map((w) => Number(w.slice('id: '.length).trim()));
    const seenReplay = new Set(ids);
    const missingReplay = Array.from({ length: 12 }, (_, i) => i + 1).filter((s) => !seenReplay.has(s));
    assert.deepEqual(
      missingReplay,
      [],
      `no seq may be lost to a replay-buffer overflow; missing ${missingReplay.join(',')}`,
    );

    controller.abort();
    await streaming;
  });

  test('a resume below the pruned watermark warns stream.lagged before the first surviving event', async () => {
    // Retention truncates the HEAD of the log (prune drops seq < beforeSeq). A
    // browser that slept through the prune reconnects with its old Last-Event-ID,
    // so it asks to resume from a seq that no longer exists — the range
    // [fromSeq, earliestSeq) is gone. `store.events.read` filters seq >= fromSeq,
    // so the first row it returns is the earliest SURVIVING seq; `emit` only
    // suppresses seq <= lastSent (= fromSeq - 1), so that survivor sails through
    // and the client believes it resumed exactly, silently missing the pruned
    // range. The REST sibling (readEvents) returns earliestSeq so a REST client
    // can detect this; the SSE path must signal it too, or the two endpoints
    // disagree and a browser (which cannot pre-check earliestSeq) loses events.
    await seedLog(100); // log has 1..100
    await store.events.prune(SN, 50); // drop 1..49; earliest surviving is 50
    const res = new FakeResponse();

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 200,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 31, signal: controller.signal }, // resume below the watermark
      res.asServerResponse(),
    );
    await new Promise((r) => setTimeout(r, 10));

    const laggedIndex = res.writes.findIndex((w) => w.startsWith('event: stream.lagged'));
    const firstEventIndex = res.writes.findIndex((w) => w.startsWith('id: '));
    assert.ok(laggedIndex >= 0, 'a below-watermark resume must emit a stream.lagged notice');
    assert.ok(
      firstEventIndex >= 0 && laggedIndex < firstEventIndex,
      'the stream.lagged notice must precede the first surviving event',
    );
    // The notice names the earliest surviving sequence, so a client learns the gap.
    const laggedData = res.writes[laggedIndex + 1] ?? '';
    assert.match(laggedData, /"earliestSeq":50/, 'the notice names the earliest surviving seq');
    // The first delivered event is the earliest survivor, seq 50 — and it is NOT
    // rewound: the notice carries no id: line, so the resume cursor stays put.
    const firstId = Number(res.writes[firstEventIndex]!.slice('id: '.length).trim());
    assert.equal(firstId, 50, 'the first delivered event is the earliest survivor');

    controller.abort();
    await streaming;
  });

  test('a resume above or at the watermark does not warn (no false gap)', async () => {
    // The guard must not fire when there is no gap: a resume at exactly the
    // earliest surviving seq, or above it, or from the beginning (fromSeq 0),
    // has lost nothing and must stream silently.
    await seedLog(100);
    await store.events.prune(SN, 50); // earliest surviving is 50
    for (const fromSeq of [50, 51, 0]) {
      const res = new FakeResponse();
      const bridge = new SseBridge({
        bus,
        store,
        clock,
        logger: nullLogger,
        heartbeatMs: 100_000,
        replayBatchSize: 200,
        drainTimeoutMs: 100_000,
      });
      const controller = new AbortController();
      const streaming = bridge.stream(
        { sessionId: SN, fromSeq, signal: controller.signal },
        res.asServerResponse(),
      );
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(
        res.writes.filter((w) => w.startsWith('event: stream.lagged')).length,
        0,
        `resume fromSeq=${fromSeq} must not warn (no gap)`,
      );
      controller.abort();
      await streaming;
    }
  });

  test('a resume into a FULLY-pruned session warns before jumping to the live tail', async () => {
    // The full-prune blind spot: retention can delete EVERY row of a session
    // whose durable `last_seq` watermark has advanced (a high-watermark session
    // gone idle past its window, then resumed). `earliestSeq()` reads the LOG, so
    // it returns 0 on the emptied log — and the old guard `earliest > 0` treated
    // that as "brand-new session, no gap", suppressing the notice. A client that
    // last saw seq 50 then reconnects and, when the session's next event (say 101)
    // arrives, silently jumps 50 -> 101, missing the pruned range with no signal.
    // The durable watermark on the session ROW (which survives the prune) is the
    // only thing that reveals the gap.
    await seedSessionRow(0);
    await seedLog(100); // append advances the row's last_seq to 100
    await store.events.prune(SN, 101); // drop ALL of 1..100; the log is now empty
    assert.equal(await store.events.earliestSeq(SN), 0, 'the log is fully pruned');
    assert.equal((await store.sessions.get(SN))?.lastSeq, 100, 'the durable watermark survives');

    const res = new FakeResponse();
    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 200,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 51, signal: controller.signal }, // resume into the pruned range
      res.asServerResponse(),
    );
    await new Promise((r) => setTimeout(r, 10));

    const lagged = res.writes.findIndex((w) => w.startsWith('event: stream.lagged'));
    assert.ok(lagged >= 0, 'a fully-pruned resume must still emit a stream.lagged notice');
    // The notice names the next seq the client will actually receive (watermark+1).
    assert.match(
      res.writes[lagged + 1] ?? '',
      /"earliestSeq":101/,
      'the notice names the first seq the client can still receive (watermark + 1)',
    );

    controller.abort();
    await streaming;
  });

  test('a brand-new session (no watermark) resume stays silent', async () => {
    // The other side of the full-prune fix: a genuinely new session has an empty
    // log AND last_seq 0, so a resume must NOT warn — there is no gap, only a
    // session that has produced nothing yet.
    await seedSessionRow(0);

    const res = new FakeResponse();
    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 200,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 51, signal: controller.signal },
      res.asServerResponse(),
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      res.writes.filter((w) => w.startsWith('event: stream.lagged')).length,
      0,
      'a new session with no watermark must not warn',
    );
    controller.abort();
    await streaming;
  });

  test('events that arrive during overflow recovery are delivered even if the session then goes idle', async () => {
    // The dead-re-pump trap: catchUpFromLog awaits store reads + drain, and fresh
    // live events enqueue during it. A re-entrant pump() is a no-op (pumping is
    // still true), so if recovery returned after one heal those events would sit
    // unsent — and be LOST if the session then went idle (no later event to
    // trigger a pump). The pump's drain+heal must loop within one pumping session.
    await seedLog(1);
    const res = new FakeResponse();
    res.reblockAfterDrain = true; // one write per drain, so we can inject mid-recovery

    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 50,
      replayBufferLimit: 2,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 1, signal: controller.signal },
      res.asServerResponse(),
    );
    await new Promise((r) => setTimeout(r, 10)); // seq 1 replayed, parked (reblock)

    // Overflow the live queue: publish 2..10 while blocked. 2,3 queue; 4..10 drop.
    res.blocked = true;
    for (let seq = 2; seq <= 10; seq++) await bus.publish([makeEvent(seq)]);
    await new Promise((r) => setTimeout(r, 5));

    // Single-step through the drain + self-heal. Partway through recovery, inject
    // 11,12 (they persist to the log and enqueue live during catch-up).
    let injected = false;
    for (let i = 0; i < 60 && res.eventFrames < 12; i++) {
      res.drain();
      await new Promise((r) => setTimeout(r, 3));
      if (!injected && res.eventFrames >= 6) {
        injected = true;
        await bus.publish([makeEvent(11)]);
        await bus.publish([makeEvent(12)]);
      }
    }
    // Now go idle — no further events. The during-recovery arrivals must already
    // have been delivered by the pump's own loop, not stranded awaiting a future
    // event that never comes.
    await new Promise((r) => setTimeout(r, 20));

    const ids = res.writes
      .filter((w) => w.startsWith('id: '))
      .map((w) => Number(w.slice('id: '.length).trim()));
    const seen = new Set(ids);
    const missing = Array.from({ length: 12 }, (_, i) => i + 1).filter((s) => !seen.has(s));
    assert.deepEqual(
      missing,
      [],
      `events queued during recovery must not be stranded on idle; missing ${missing.join(',')}`,
    );

    controller.abort();
    await streaming;
  });

  test('a client that disconnected before stream() attached its listeners is torn down, not leaked', async () => {
    // The router awaits sessions.get()/readBody BEFORE calling stream(); a client
    // that disconnects in that window fires res 'close' → controller.abort()
    // *before* stream() attaches its own abort/close listeners. An already-aborted
    // AbortSignal never invokes a freshly-added 'abort' listener, so finish() would
    // never run: with an empty replay stream() would await a promise that never
    // resolves, leaking the bus subscription and the heartbeat and pinning the
    // shutdown drain for the connection's whole life. stream() must detect the
    // already-severed connection at setup and tear down at once.
    await seedLog(3); // a non-empty log to prove it does not even begin replaying
    const res = new FakeResponse();
    const bridge = new SseBridge({
      bus,
      store,
      clock,
      logger: nullLogger,
      heartbeatMs: 100_000,
      replayBatchSize: 200,
      drainTimeoutMs: 100_000,
    });
    const controller = new AbortController();
    controller.abort(); // the disconnect already happened, before stream() runs

    // Must resolve promptly (not hang). A generous race guards the test itself.
    const streaming = bridge.stream(
      { sessionId: SN, fromSeq: 0, signal: controller.signal },
      res.asServerResponse(),
    );
    const raced = await Promise.race([
      streaming.then(() => 'resolved' as const),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 1000)),
    ]);
    assert.equal(raced, 'resolved', 'stream() must return at once for an already-disconnected client, not hang');

    // And the subscription must not have leaked into the bus.
    assert.equal(bus.subscriberCount(SN), 0, 'the subscription was closed, not leaked');
    // Nothing was streamed to the dead socket.
    assert.equal(res.writes.filter((w) => w.startsWith('id: ')).length, 0, 'no events written to a dead socket');
  });
});
