/**
 * A tiny in-process metrics registry with Prometheus text exposition.
 *
 * Zero dependencies: the platform ships no metrics client, so this is the whole
 * of it — counters, gauges, and histograms, plus a renderer for the Prometheus
 * text format any scraper understands. It is deliberately small and synchronous;
 * recording a metric is a map lookup and an add, cheap enough for the request
 * hot path, and it never throws into a caller (a bad label is rendered, not
 * rejected, so instrumentation can never take down the thing it measures).
 *
 * Labels are the one cardinality hazard: every distinct label-value combination
 * is a separate series, so callers must label with bounded values (a route
 * *template* like `/v1/agents/:id`, never a concrete id). This module does not
 * police that — it is the caller's contract — but it does escape label values so
 * a value containing a quote, backslash or newline cannot corrupt the output.
 */

export type MetricLabels = Readonly<Record<string, string>>;

interface Series {
  labels: MetricLabels;
  value: number;
}

/** A histogram's per-series state: bucket counts (cumulative rendered later), sum, count. */
interface HistogramSeries {
  labels: MetricLabels;
  bucketCounts: number[];
  sum: number;
  count: number;
}

type MetricKind = 'counter' | 'gauge' | 'histogram';

interface CounterOrGauge {
  kind: 'counter' | 'gauge';
  help: string;
  series: Map<string, Series>;
}

interface Histogram {
  kind: 'histogram';
  help: string;
  buckets: readonly number[];
  series: Map<string, HistogramSeries>;
}

type Metric = CounterOrGauge | Histogram;

/** A gauge whose value is computed at scrape time (e.g. counts from the store). */
export type GaugeCollector = () => Promise<{ labels?: MetricLabels; value: number }[]> | {
  labels?: MetricLabels;
  value: number;
}[];

/** Default latency buckets, in seconds — the Prometheus client-library defaults. */
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>();
  readonly #collectors = new Map<string, { help: string; collect: GaugeCollector }>();

  /** Add to a counter (monotonic; a negative delta is ignored, not subtracted). */
  incrementCounter(name: string, labels: MetricLabels = {}, delta = 1): void {
    if (delta < 0) return;
    const metric = this.#ensure(name, 'counter');
    if (metric.kind === 'histogram') return;
    const key = seriesKey(labels);
    const existing = metric.series.get(key);
    if (existing) existing.value += delta;
    else metric.series.set(key, { labels, value: delta });
  }

  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    const metric = this.#ensure(name, 'gauge');
    if (metric.kind === 'histogram') return;
    metric.series.set(seriesKey(labels), { labels, value });
  }

  /** Record one observation into a histogram (buckets are seconds for latency). */
  observeHistogram(
    name: string,
    value: number,
    labels: MetricLabels = {},
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS,
  ): void {
    const metric = this.#ensureHistogram(name, buckets);
    const key = seriesKey(labels);
    let series = metric.series.get(key);
    if (!series) {
      series = { labels, bucketCounts: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 };
      metric.series.set(key, series);
    }
    series.sum += value;
    series.count += 1;
    // Store one observation in exactly one bucket: the smallest whose upper bound
    // it does not exceed. `render` accumulates these into the cumulative form
    // Prometheus wants. (Counting into every fitting bucket here and then
    // accumulating at render would double-count.) An observation larger than the
    // last bucket falls only into the implicit +Inf bucket, which render derives
    // from the total count.
    for (let i = 0; i < metric.buckets.length; i++) {
      if (value <= metric.buckets[i]!) {
        series.bucketCounts[i]! += 1;
        break;
      }
    }
  }

  /**
   * Register a gauge computed at scrape time. Use for values that live elsewhere
   * (session counts from the store, sandbox pool sizes) rather than being pushed:
   * the collector runs on each `render`, so the exposition is always current and
   * nothing has to remember to update a gauge on every state change.
   */
  registerCollector(name: string, help: string, collect: GaugeCollector): void {
    this.#collectors.set(name, { help, collect });
  }

  /** Provide help text for a metric (optional; improves the exposition). */
  describe(name: string, help: string): void {
    const metric = this.#metrics.get(name);
    if (metric) metric.help = help;
    else this.#pendingHelp.set(name, help);
  }
  readonly #pendingHelp = new Map<string, string>();

  /** Render the whole registry in Prometheus text exposition format. */
  async render(): Promise<string> {
    const lines: string[] = [];

    // Pushed metrics.
    for (const [name, metric] of this.#metrics) {
      if (metric.kind === 'histogram') this.#renderHistogram(lines, name, metric);
      else this.#renderScalar(lines, name, metric);
    }

    // Collected (scrape-time) gauges.
    for (const [name, { help, collect }] of this.#collectors) {
      let points: { labels?: MetricLabels; value: number }[];
      try {
        points = await collect();
      } catch {
        // A collector that throws must not break the whole scrape — skip it.
        continue;
      }
      lines.push(`# HELP ${name} ${escapeHelp(help)}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const point of points) {
        lines.push(`${name}${renderLabels(point.labels ?? {})} ${formatValue(point.value)}`);
      }
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }

  #ensure(name: string, kind: 'counter' | 'gauge'): Metric {
    const existing = this.#metrics.get(name);
    if (existing) return existing;
    const metric: CounterOrGauge = { kind, help: this.#pendingHelp.get(name) ?? '', series: new Map() };
    this.#metrics.set(name, metric);
    return metric;
  }

  #ensureHistogram(name: string, buckets: readonly number[]): Histogram {
    const existing = this.#metrics.get(name);
    if (existing && existing.kind === 'histogram') return existing;
    const metric: Histogram = {
      kind: 'histogram',
      help: this.#pendingHelp.get(name) ?? '',
      // Sorted ascending and deduplicated, so cumulative rendering is monotonic.
      buckets: [...new Set(buckets)].sort((a, b) => a - b),
      series: new Map(),
    };
    this.#metrics.set(name, metric);
    return metric;
  }

  #renderScalar(lines: string[], name: string, metric: CounterOrGauge): void {
    lines.push(`# HELP ${name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${name} ${metric.kind}`);
    for (const series of metric.series.values()) {
      lines.push(`${name}${renderLabels(series.labels)} ${formatValue(series.value)}`);
    }
  }

  #renderHistogram(lines: string[], name: string, metric: Histogram): void {
    lines.push(`# HELP ${name} ${escapeHelp(metric.help)}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const series of metric.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < metric.buckets.length; i++) {
        cumulative += series.bucketCounts[i]!;
        const le = formatValue(metric.buckets[i]!);
        lines.push(`${name}_bucket${renderLabels({ ...series.labels, le })} ${cumulative}`);
      }
      // The mandatory +Inf bucket equals the total count.
      lines.push(`${name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count}`);
      lines.push(`${name}_sum${renderLabels(series.labels)} ${formatValue(series.sum)}`);
      lines.push(`${name}_count${renderLabels(series.labels)} ${series.count}`);
    }
  }
}

// --- rendering helpers ------------------------------------------------------

/** A stable key for a label set, so the same labels map to one series. */
function seriesKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join('\x1f');
}

function renderLabels(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k]!)}"`);
  return `{${parts.join(',')}}`;
}

/** Escape a label value per the Prometheus text format: backslash, quote, newline. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP text may contain backslash and newline but not a raw newline mid-line. */
function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Format a numeric value: integers plainly, non-finite as Prometheus spells them. */
function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}
