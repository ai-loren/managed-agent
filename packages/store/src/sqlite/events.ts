/**
 * The event log — the most load-bearing repository in the system.
 *
 * Session state is a fold over this log, so three properties must hold or
 * everything above breaks:
 *
 *  1. **Sequences are gap-free per session.** `append` reads the current max and
 *     inserts under one transaction, and `(session_id, seq)` is the primary
 *     key, so a concurrent writer that computed the same number fails the
 *     insert rather than overwriting. A gap would make a resuming client wait
 *     forever for an event that will never arrive.
 *  2. **Appends are atomic as a batch.** A turn that emits five events either
 *     contributes all five or none; a partial batch would leave the fold in a
 *     state the runtime never actually occupied.
 *  3. **Reads are exact.** `fromSeq` is inclusive and `toSeq` exclusive, always.
 *     Off-by-one here means duplicated or dropped events on every reconnect.
 */

import { newId, type Clock } from '@ma/core';
import type { EventType, SessionEvent } from '@ma/contracts';

import type { Database } from '../database.ts';
import { readJson, readNumber, readOptionalNumber, readString, type Row, type SqlValue } from '../mapping.ts';
import type { EventRepository } from '../repository.ts';

const MAX_READ_LIMIT = 1000;
/**
 * Upper bound on a content-search query, mirroring the knowledge index's
 * `maxQueryChars`. A search string is attacker-influenced (it reaches SQL as a
 * bound parameter), so it is clamped before it can drive an oversized scan.
 */
const MAX_QUERY_CHARS = 1024;
/**
 * How many of a session's most-recent events a content search (`q`) may scan.
 *
 * A `%x%` LIKE is non-sargable, and `ORDER BY seq LIMIT N` only stops once N
 * matches accumulate — so a query matching few or zero rows would otherwise scan
 * *every* retained event of the session, reading the whole (unbounded) payload
 * corpus synchronously on the single control-plane event loop. Retention bounds
 * that only by time (up to years). Capping the scan to the most-recent
 * `MAX_SEARCH_SCAN` events makes the cost O(cap) regardless of retention, at the
 * documented price that content search covers recent history rather than the
 * entire log. Non-search reads (no `q`) are unaffected — they are sargable on the
 * `(session_id, seq)` primary key and already bounded by `LIMIT`.
 */
const MAX_SEARCH_SCAN = 5000;
/**
 * Per-row byte ceiling for a content search: the LIKE tests only the first
 * `MAX_PAYLOAD_SCAN` chars of each payload. Payload text is schema-unbounded
 * (a single `tool.output.chunk` can be large), so without this the scan cost has
 * a second unbounded dimension — bytes per row — even with the row count capped.
 * Bounding both keeps a search O(MAX_SEARCH_SCAN × MAX_PAYLOAD_SCAN). The price is
 * that a match past this offset in an unusually large payload is not found;
 * event payloads are almost always far smaller, and the head is where the
 * human-readable content (message/tool text) lives.
 */
const MAX_PAYLOAD_SCAN = 16_384;

/**
 * Escape the SQL `LIKE` metacharacters in a user's search string so it matches
 * literally. `%` and `_` are wildcards and `\` is our chosen escape char, so all
 * three are prefixed with `\` (the escape char first, in one pass, so it is not
 * double-escaped) and the query is bound with an explicit `ESCAPE '\'` clause.
 * Without this, a search for `50%` would wildcard-match anything starting `50`.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toEvent(row: Row): SessionEvent {
  return {
    seq: readNumber(row, 'seq'),
    id: readString(row, 'id'),
    sessionId: readString(row, 'session_id'),
    workspaceId: readString(row, 'workspace_id'),
    ts: readNumber(row, 'ts'),
    type: readString(row, 'type') as EventType,
    ...(readOptionalNumber(row, 'turn') === undefined ? {} : { turn: readOptionalNumber(row, 'turn')! }),
    ...(row.item_id ? { itemId: readString(row, 'item_id') } : {}),
    payload: readJson(row, 'payload', {}),
  } as SessionEvent;
}

export class SqliteEventRepository implements EventRepository {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  append(
    sessionId: string,
    events: readonly Omit<SessionEvent, 'seq'>[],
  ): Promise<SessionEvent[]> {
    return Promise.resolve(this.appendSync(sessionId, events));
  }

  /**
   * The synchronous core of `append`, for a caller composing it into a larger
   * `db.transaction` (e.g. a status change written atomically with its
   * transition event). node:sqlite is synchronous, so the write is complete when
   * this returns; `append` just wraps it in a resolved promise for the async
   * repository interface.
   */
  appendSync(
    sessionId: string,
    events: readonly Omit<SessionEvent, 'seq'>[],
  ): SessionEvent[] {
    if (events.length === 0) return [];

    return this.#db.transaction(() => {
      // Read the watermark inside the transaction. Under BEGIN IMMEDIATE the
      // write lock is already held, so no other writer can interleave between
      // this read and the inserts below.
      //
      // From `sessions.last_seq`, not `MAX(seq)` over the log. The log is
      // pruned by retention: once every event for a session is gone, MAX is
      // NULL and numbering restarted at 1, reissuing sequences that had already
      // been served. An SSE client resuming from `Last-Event-ID: 5` then
      // silently skipped the new 1..5 forever, because the bridge drops
      // anything at or below the last sequence it sent. `last_seq` is
      // maintained by this method and outlives the rows it counted.
      //
      // The MAX is still consulted, as a floor: a session row that was reset or
      // restored from an older backup must not renumber over surviving events.
      const row = this.#db.get(
        `SELECT
           (SELECT last_seq FROM sessions WHERE id = ?)              AS session_seq,
           (SELECT MAX(seq) FROM events WHERE session_id = ?)        AS log_seq`,
        [sessionId, sessionId],
      );
      let seq = Math.max(toSeq(row?.session_seq), toSeq(row?.log_seq));

      const out: SessionEvent[] = [];
      for (const event of events) {
        seq++;
        const record: SessionEvent = {
          ...event,
          seq,
          id: event.id || newId('event', this.#clock.now()),
          sessionId,
        } as SessionEvent;

        this.#db.run(
          `INSERT INTO events (session_id, seq, id, workspace_id, ts, type, turn, item_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sessionId,
            seq,
            record.id,
            record.workspaceId,
            record.ts,
            record.type,
            record.turn ?? null,
            record.itemId ?? null,
            JSON.stringify(record.payload ?? {}),
          ],
        );
        out.push(record);
      }

      // Keep the session's cursor in step so a reader can resume without
      // scanning the log to find the tail.
      this.#db.run('UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?', [
        seq,
        this.#clock.now(),
        sessionId,
      ]);

      return out;
    });
  }

  read(
    sessionId: string,
    options: {
      fromSeq?: number;
      toSeq?: number;
      limit?: number;
      types?: string[];
      turn?: number;
      order?: 'asc' | 'desc';
      /** Case-insensitive (ASCII-only) substring over the raw JSON payload, session-scoped. */
      q?: string;
      /** Inclusive lower bound on `ts` (ms). */
      fromTs?: number;
      /** Exclusive upper bound on `ts` (ms). */
      toTs?: number;
      /**
       * How many recent events a `q` search may scan. A ceiling of
       * `MAX_SEARCH_SCAN`: a caller may only *lower* it (cheaper), never raise it,
       * so the DoS bound holds. Exists mainly so tests can exercise the boundary.
       */
      searchScanCap?: number;
    } = {},
  ): Promise<SessionEvent[]> {
    const conditions = ['session_id = ?'];
    const params: SqlValue[] = [sessionId];

    if (options.fromSeq !== undefined) {
      conditions.push('seq >= ?');
      params.push(options.fromSeq);
    }
    if (options.toSeq !== undefined) {
      conditions.push('seq < ?');
      params.push(options.toSeq);
    }
    if (options.turn !== undefined) {
      conditions.push('turn = ?');
      params.push(options.turn);
    }

    // A time window is a filter, not a cursor: it narrows the rows but ordering
    // stays with `seq` (below), so `ts` ties are irrelevant. Bounds go straight
    // into the WHERE against the `idx_events_ts`-backed column.
    if (options.fromTs !== undefined) {
      conditions.push('ts >= ?');
      params.push(options.fromTs);
    }
    if (options.toTs !== undefined) {
      conditions.push('ts < ?');
      params.push(options.toTs);
    }

    // Filters accept either an exact type or a `namespace.` prefix, so a
    // consumer can subscribe to `tool.` without enumerating its members.
    if (options.types && options.types.length > 0) {
      const clauses: string[] = [];
      for (const filter of options.types) {
        if (filter.endsWith('.')) {
          clauses.push('type LIKE ?');
          params.push(`${filter}%`);
        } else {
          clauses.push('type = ?');
          params.push(filter);
        }
      }
      conditions.push(`(${clauses.join(' OR ')})`);
    }

    // Content search: a case-insensitive substring over the serialized payload.
    // Case-insensitivity is ASCII-only (SQLite's built-in LOWER); non-ASCII text
    // is matched case-sensitively. The `%x%` LIKE is non-sargable, so it cannot
    // use an index — its cost is bounded on BOTH dimensions instead: row count, by
    // scanning only the most-recent `MAX_SEARCH_SCAN` events (the inner subquery),
    // and bytes-per-row, by testing only the first `MAX_PAYLOAD_SCAN` chars of each
    // payload. A query matching few or zero rows therefore cannot walk the whole
    // (retention-bounded but potentially huge) payload corpus and block the event
    // loop. The query is clamped and its LIKE metacharacters escaped (see
    // `escapeLike`) with an explicit `ESCAPE`.
    const searching = options.q !== undefined && options.q.length > 0;
    const order = options.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(options.limit ?? 200, MAX_READ_LIMIT);

    let sql: string;
    if (searching) {
      // Select the most-recent MAX_SEARCH_SCAN rows matching the non-search
      // predicates (seq DESC bounds the scan to recent history), then apply the
      // LIKE within that window and re-order to the caller's requested order.
      const scanCap = Math.min(options.searchScanCap ?? MAX_SEARCH_SCAN, MAX_SEARCH_SCAN);
      const innerParams = [...params, scanCap];
      const likeParam = escapeLike(options.q!.slice(0, MAX_QUERY_CHARS));
      sql =
        `SELECT * FROM (` +
        `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY seq DESC LIMIT ?` +
        `) WHERE LOWER(substr(payload, 1, ${MAX_PAYLOAD_SCAN})) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' ` +
        `ORDER BY seq ${order} LIMIT ?`;
      const rows = this.#db.all(sql, [...innerParams, likeParam, limit]);
      return Promise.resolve(rows.map(toEvent));
    }

    params.push(limit);
    const rows = this.#db.all(
      `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY seq ${order} LIMIT ?`,
      params,
    );
    return Promise.resolve(rows.map(toEvent));
  }

  lastSeq(sessionId: string): Promise<number> {
    const row = this.#db.get('SELECT MAX(seq) AS value FROM events WHERE session_id = ?', [sessionId]);
    return Promise.resolve(row?.value === null || row?.value === undefined ? 0 : Number(row.value));
  }

  earliestSeq(sessionId: string): Promise<number> {
    const row = this.#db.get('SELECT MIN(seq) AS value FROM events WHERE session_id = ?', [sessionId]);
    return Promise.resolve(row?.value === null || row?.value === undefined ? 0 : Number(row.value));
  }

  countByType(sessionId: string, type: EventType): Promise<number> {
    const row = this.#db.get(
      'SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = ?',
      [sessionId, type],
    );
    return Promise.resolve(Number(row?.value ?? 0));
  }

  /**
   * Drop events below `beforeSeq`. Retention deliberately truncates the *head*
   * of the log rather than sampling it: a consumer that falls behind is told
   * the earliest surviving sequence and re-reads from there, which is
   * recoverable, whereas holes in the middle are not.
   */
  prune(sessionId: string, beforeSeq: number): Promise<number> {
    const result = this.#db.run('DELETE FROM events WHERE session_id = ? AND seq < ?', [
      sessionId,
      beforeSeq,
    ]);
    return Promise.resolve(result.changes);
  }

  seqBefore(sessionId: string, before: number): Promise<number> {
    const row = this.#db.get(
      'SELECT MAX(seq) AS seq FROM events WHERE session_id = ? AND ts < ?',
      [sessionId, before],
    );
    const seq = row?.seq;
    return Promise.resolve(seq === null || seq === undefined ? 0 : Number(seq));
  }

  findSessionsWithExpiredEvents(
    before: number,
    limit: number,
    afterOldest = 0,
  ): Promise<{ sessionId: string; oldest: number }[]> {
    // Grouped rather than one row per event: the sweep wants sessions to work
    // on, and a busy session could otherwise fill the whole batch by itself.
    // `INDEXED BY idx_events_ts` forces the ts-range index: this runs on the
    // largest table every retention tick, and without an explicit hint the
    // planner full-scans it via the primary-key autoindex (no ANALYZE ever runs
    // in production to teach it otherwise).
    //
    // `afterOldest` is a rotating cursor on the oldest-event timestamp. The sweep
    // returns candidates whose events pass a coarse `before` cutoff, but many of
    // those are not actually expired under their own workspace's (longer)
    // retention — they reappear every tick and, ordered oldest-first, would
    // monopolize the fixed batch and starve sessions that genuinely need pruning.
    // Returning the oldest ts lets the caller page past this batch next tick.
    const rows = this.#db.all(
      `SELECT session_id, MIN(ts) AS oldest FROM events INDEXED BY idx_events_ts
        WHERE ts < ?
        GROUP BY session_id
        HAVING oldest > ?
        ORDER BY oldest ASC
        LIMIT ?`,
      [before, afterOldest, limit],
    );
    return Promise.resolve(
      rows.map((row) => ({ sessionId: String(row.session_id), oldest: Number(row.oldest) })),
    );
  }

  deleteForSession(sessionId: string): Promise<void> {
    this.#db.run('DELETE FROM events WHERE session_id = ?', [sessionId]);
    return Promise.resolve();
  }
}

/** A nullable SQL count as a sequence floor. */
function toSeq(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}
