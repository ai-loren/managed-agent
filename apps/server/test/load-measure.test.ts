import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Latencies, percentile, pool } from './load/measure.ts';

describe('load test measures', () => {
  test('percentiles are nearest-rank: p50 of four is the second, p99 of a hundred the ninety-ninth', () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile(Array.from({ length: 100 }, (_, index) => index + 1), 99), 99);
    assert.equal(percentile([7], 99), 7);
    assert.equal(percentile([], 50), 0);
  });

  test('a summary sorts what it was given, in whatever order it came', () => {
    const latencies = new Latencies();
    for (const ms of [30, 10, 50, 20, 40]) latencies.record(ms);
    assert.deepEqual(latencies.summary(), { count: 5, p50: 30, p95: 50, p99: 50, max: 50 });
  });

  test('the pool keeps at most its concurrency in flight and runs every index once', async () => {
    let inFlight = 0;
    let peak = 0;
    const ran: number[] = [];
    await pool(10, 3, async (index) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      ran.push(index);
      inFlight--;
    });
    assert.equal(peak, 3);
    assert.deepEqual(ran.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
