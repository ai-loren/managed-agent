/**
 * Clock abstraction.
 *
 * Time is an input, not an ambient fact. Every component that reads the clock
 * or sleeps takes a `Clock`, so tests can drive lease expiry, retry backoff and
 * cron evaluation deterministically instead of with `setTimeout` and hope.
 */

export interface Clock {
  /** Wall-clock epoch milliseconds. Use for timestamps stored or displayed. */
  now(): number;
  /**
   * Monotonic milliseconds, immune to wall-clock jumps (NTP, DST, manual set).
   * Use for measuring durations, deadlines and lease arithmetic.
   */
  monotonic(): number;
  /** Resolve after `ms`, or reject with an `AbortError` if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => Math.round(performance.now()),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      // Do not keep the event loop alive purely for a sleep; a shutting-down
      // process should not wait out a backoff.
      timer.unref?.();
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

interface PendingSleep {
  at: number;
  /** Insertion order, so sleepers with equal deadlines fire FIFO. */
  seq: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A clock under test control. `advance` fires every sleep whose deadline has
 * passed, in deadline order, so ordering assertions are meaningful.
 */
export class TestClock implements Clock {
  #now: number;
  #pending: PendingSleep[] = [];
  #seq = 0;

  constructor(startAt = 1_700_000_000_000) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  monotonic(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      const entry: PendingSleep = { at: this.#now + ms, seq: this.#seq++, resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          const index = this.#pending.indexOf(entry);
          if (index >= 0) this.#pending.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#pending.push(entry);
    });
  }

  /** Move time forward and release every sleeper whose deadline has arrived. */
  async advance(ms: number): Promise<void> {
    this.#now += ms;
    // Sort by deadline, then insertion order, so equal deadlines fire FIFO.
    const due = this.#pending
      .filter((entry) => entry.at <= this.#now)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.#pending = this.#pending.filter((entry) => entry.at > this.#now);
    for (const entry of due) {
      if (entry.onAbort && entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
      entry.resolve();
      // Yield so the woken continuation runs before the next sleeper fires.
      await Promise.resolve();
    }
  }

  /** Jump to an absolute time. Never moves backwards. */
  async setTime(epochMs: number): Promise<void> {
    if (epochMs < this.#now) throw new Error('TestClock cannot move backwards');
    await this.advance(epochMs - this.#now);
  }

  /** How many sleepers are still waiting — useful for leak assertions. */
  get pendingCount(): number {
    return this.#pending.length;
  }
}
