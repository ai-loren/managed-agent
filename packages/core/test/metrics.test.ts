/**
 * Metrics registry tests — counters, gauges, histograms, and the Prometheus
 * text exposition, including the escaping that stops a hostile label value from
 * corrupting the output.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MetricsRegistry } from '../src/index.ts';

describe('metrics registry', () => {
  test('a counter accumulates per label set and renders with TYPE/HELP', async () => {
    const r = new MetricsRegistry();
    r.describe('http_requests_total', 'Total HTTP requests');
    r.incrementCounter('http_requests_total', { route: '/v1/agents', status: '200' });
    r.incrementCounter('http_requests_total', { route: '/v1/agents', status: '200' });
    r.incrementCounter('http_requests_total', { route: '/v1/agents', status: '500' });

    const out = await r.render();
    assert.match(out, /# HELP http_requests_total Total HTTP requests/);
    assert.match(out, /# TYPE http_requests_total counter/);
    assert.match(out, /http_requests_total\{route="\/v1\/agents",status="200"\} 2/);
    assert.match(out, /http_requests_total\{route="\/v1\/agents",status="500"\} 1/);
  });

  test('a counter ignores a negative delta (monotonic)', async () => {
    const r = new MetricsRegistry();
    r.incrementCounter('c', {}, 5);
    r.incrementCounter('c', {}, -3);
    const out = await r.render();
    assert.match(out, /^c 5$/m);
  });

  test('a gauge holds the last set value', async () => {
    const r = new MetricsRegistry();
    r.setGauge('sessions_active', 3, { status: 'ready' });
    r.setGauge('sessions_active', 7, { status: 'ready' });
    const out = await r.render();
    assert.match(out, /# TYPE sessions_active gauge/);
    assert.match(out, /sessions_active\{status="ready"\} 7/);
  });

  test('a histogram renders cumulative buckets, +Inf, sum and count', async () => {
    const r = new MetricsRegistry();
    const buckets = [0.1, 0.5, 1];
    r.observeHistogram('latency', 0.05, {}, buckets); // <= 0.1
    r.observeHistogram('latency', 0.3, {}, buckets); // <= 0.5, 1
    r.observeHistogram('latency', 2, {}, buckets); // only +Inf
    const out = await r.render();

    assert.match(out, /# TYPE latency histogram/);
    // Cumulative: le=0.1 has 1, le=0.5 has 2, le=1 has 2, +Inf has 3.
    assert.match(out, /latency_bucket\{le="0.1"\} 1/);
    assert.match(out, /latency_bucket\{le="0.5"\} 2/);
    assert.match(out, /latency_bucket\{le="1"\} 2/);
    assert.match(out, /latency_bucket\{le="\+Inf"\} 3/);
    assert.match(out, /latency_sum 2.35/);
    assert.match(out, /latency_count 3/);
  });

  test('bucket counts are monotonically non-decreasing across le', async () => {
    const r = new MetricsRegistry();
    const buckets = [0.01, 0.1, 1, 10];
    for (const v of [0.005, 0.02, 0.2, 2, 20]) r.observeHistogram('h', v, {}, buckets);
    const out = await r.render();
    const counts = [...out.matchAll(/h_bucket\{le="[^"]+"\} (\d+)/g)].map((m) => Number(m[1]));
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i]! >= counts[i - 1]!, `bucket ${i} (${counts[i]}) < ${counts[i - 1]}`);
    }
    // The final +Inf bucket equals the total observation count.
    assert.equal(counts[counts.length - 1], 5);
  });

  test('escapes label values so a hostile value cannot corrupt the output', async () => {
    const r = new MetricsRegistry();
    // A value with a quote, backslash and newline — the three that would break
    // the line format or inject a fake series.
    r.incrementCounter('c', { route: 'a"b\\c\nd' });
    const out = await r.render();
    assert.match(out, /c\{route="a\\"b\\\\c\\nd"\} 1/);
    // Exactly one metric line for c (no injected extra line from the newline).
    const cLines = out.split('\n').filter((l) => l.startsWith('c{'));
    assert.equal(cLines.length, 1);
  });

  test('a scrape-time collector is rendered and its throw is isolated', async () => {
    const r = new MetricsRegistry();
    r.registerCollector('sessions_by_status', 'Sessions per status', () => [
      { labels: { status: 'ready' }, value: 4 },
      { labels: { status: 'queued' }, value: 1 },
    ]);
    r.registerCollector('broken', 'Throws', () => {
      throw new Error('collector failure');
    });
    const out = await r.render();
    assert.match(out, /sessions_by_status\{status="ready"\} 4/);
    assert.match(out, /sessions_by_status\{status="queued"\} 1/);
    // The throwing collector is skipped, not fatal — the good one still renders.
    assert.doesNotMatch(out, /^broken /m);
  });

  test('an async collector is awaited', async () => {
    const r = new MetricsRegistry();
    r.registerCollector('async_gauge', 'x', async () => {
      await Promise.resolve();
      return [{ value: 42 }];
    });
    const out = await r.render();
    assert.match(out, /async_gauge 42/);
  });

  test('renders non-finite values the Prometheus way', async () => {
    const r = new MetricsRegistry();
    r.setGauge('g', Infinity);
    const out = await r.render();
    assert.match(out, /^g \+Inf$/m);
  });

  test('an empty registry renders nothing', async () => {
    assert.equal(await new MetricsRegistry().render(), '');
  });
});
