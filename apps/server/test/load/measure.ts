/**
 * What a load test measures, and how it keeps work in flight.
 */

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Latencies in milliseconds as a client sees them, summarised as an SLO is written. */
export class Latencies {
  readonly #samples: number[] = [];

  record(ms: number): void {
    this.#samples.push(ms);
  }

  summary(): Summary {
    const sorted = [...this.#samples].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? 0,
    };
  }
}

/** Nearest-rank percentile of ascending samples: the smallest one at least `p`% of them do not exceed. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/**
 * Run `work` once per index, at most `concurrency` at a time, until all are
 * done. A worker's failure is the work's to count; one that throws stops only
 * that worker's share, so `work` should catch.
 */
export async function pool(count: number, concurrency: number, work: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(0, Math.min(concurrency, count)) }, async () => {
    while (next < count) await work(next++);
  });
  await Promise.all(workers);
}
