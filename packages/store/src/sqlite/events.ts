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

import { MaError, newId, type Clock } from '@ma/core';
import type { EventType, SessionEvent } from '@ma/contracts';

import type { Database } from '../database.ts';
import { readJson, readNumber, readOptionalNumber, readString, type Row, type SqlValue } from '../mapping.ts';
import type { EventReadOptions, EventRepository, EventSearchResult } from '../repository.ts';

const MAX_READ_LIMIT = 1000;
/**
 * Upper bound on a content-search query, mirroring the knowledge index's
 * `maxQueryChars`. A search string is attacker-influenced, so it is clamped
 * before it can drive an oversized scan.
 */
const MAX_QUERY_CHARS = 1024;
/**
 * Per-event ceiling on search text (see `eventSearchText`). It bounds the bytes
 * a search reads per row; `migrations.ts` (event_search_text) backfills with
 * the same number.
 */
const MAX_SEARCH_TEXT = 16_384;
/**
 * Events one search request may examine. A substring match cannot use an
 * index, so a query that matches little reads every row it covers; this caps
 * that per request, and `resumeSeq` lets a caller carry on from where it
 * stopped, so the whole retained log is reachable a request at a time.
 */
const MAX_SEARCH_SCAN = 100_000;
/**
 * Events examined per synchronous step. node:sqlite runs on the control
 * plane's only event loop; between steps every other request gets a turn, so a
 * search never holds the loop for more than one step (~10 ms at the per-row
 * text ceiling).
 */
const SEARCH_CHUNK = 1_000;
/**
 * Searches that run at once. Every immediate queued before the loop's check
 * phase runs in that phase, so N concurrent searches would each run a step
 * back to back before any I/O; this keeps that to two steps per loop turn.
 */
const MAX_ACTIVE_SEARCHES = 2;
/** Searches that may wait for a slot; past this a new one is refused as busy. */
const MAX_WAITING_SEARCHES = 16;
/** Nesting deeper than this contributes no search text. */
const MAX_SEARCH_DEPTH = 64;

/**
 * Between two values in an event's search text. Taken out of values and of
 * queries, so a match never spans two values — with a newline there, a query
 * holding one matched across the end of one value and the start of the next.
 */
const VALUE_SEPARATOR = '\u001f';

/**
 * Which `eventSearchText` wrote a row. Rows written by an older one — the SQL
 * backfill of migration 23 folded only ASCII and formatted numbers its own
 * way — are rewritten in the background (`reindexSearch`).
 */
const SEARCH_TEXT_VERSION = 2;

/**
 * The text a content search matches for one event: the payload's string and
 * number values, separated by `VALUE_SEPARATOR`, lower-cased, capped at
 * `MAX_SEARCH_TEXT`.
 *
 * Keys are left out, so a search for `text` does not hit every `"text":` field,
 * and values are taken as written rather than as JSON escapes them, so a quote
 * or a newline in the query matches one in the value. `toLowerCase` folds all
 * of Unicode; the query is folded the same way.
 */
export function eventSearchText(payload: unknown): string {
  const parts: string[] = [];
  let size = 0;
  const add = (text: string): void => {
    parts.push(text.replaceAll(VALUE_SEPARATOR, ' '));
    size += text.length + 1;
  };
  const visit = (value: unknown, depth: number): void => {
    if (size >= MAX_SEARCH_TEXT || depth > MAX_SEARCH_DEPTH) return;
    if (typeof value === 'string') add(value);
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) add(String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(payload, 0);
  return parts.join(VALUE_SEPARATOR).slice(0, MAX_SEARCH_TEXT).toLowerCase().slice(0, MAX_SEARCH_TEXT);
}

function nextLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
  #activeSearches = 0;
  /** Each entry hands its slot to one waiting search. */
  readonly #waitingSearches: (() => void)[] = [];

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
        this.#db.run('INSERT INTO event_search (session_id, seq, text, version) VALUES (?, ?, ?, ?)', [
          sessionId,
          seq,
          eventSearchText(record.payload ?? {}),
          SEARCH_TEXT_VERSION,
        ]);
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

  async read(sessionId: string, options: EventReadOptions = {}): Promise<SessionEvent[]> {
    if (options.q !== undefined && options.q.length > 0) {
      return (await this.search(sessionId, options)).events;
    }

    const { conditions, params } = filters(sessionId, options, '');
    const limit = Math.min(options.limit ?? 200, MAX_READ_LIMIT);
    const descending = options.order === 'desc';
    const order = descending ? 'DESC' : 'ASC';
    let lower = options.fromSeq;
    let upper = options.toSeq;
    const range = (): { sql: string[]; params: SqlValue[] } => ({
      sql: [...(lower !== undefined ? ['seq >= ?'] : []), ...(upper !== undefined ? ['seq < ?'] : [])],
      params: [...(lower !== undefined ? [lower] : []), ...(upper !== undefined ? [upper] : [])],
    });

    if (conditions.length === 1) {
      const bounds = range();
      const rows = this.#db.all(
        `SELECT * FROM events WHERE ${[conditions[0]!, ...bounds.sql].join(' AND ')} ORDER BY seq ${order} LIMIT ?`,
        [params[0]!, ...bounds.params, limit],
      );
      return rows.map(toEvent);
    }

    // With a filter, LIMIT would count the rows that pass it, and one that
    // matches little read the whole log in a single synchronous query — every
    // other request waited. So the log is walked a window of events at a time,
    // the filter judged per row, with a turn of the event loop between windows.
    const keep = `(${conditions.slice(1).join(' AND ')})`;
    const out: SessionEvent[] = [];
    for (;;) {
      const bounds = range();
      const rows = this.#db.all(
        `SELECT *, ${keep} AS keep FROM events WHERE ${[conditions[0]!, ...bounds.sql].join(' AND ')}
          ORDER BY seq ${order} LIMIT ?`,
        [...params.slice(1), params[0]!, ...bounds.params, SEARCH_CHUNK],
      );
      for (const row of rows) {
        if (Number(row.keep) !== 1) continue;
        out.push(toEvent(row));
        if (out.length >= limit) return out;
      }
      const last = rows.at(-1);
      if (rows.length < SEARCH_CHUNK || last === undefined) return out;
      if (descending) upper = Number(last.seq);
      else lower = Number(last.seq) + 1;
      await nextLoopTurn();
    }
  }

  /** Rewrite up to `limit` rows of search text that an older `eventSearchText` wrote; how many. */
  reindexSearch(limit: number): Promise<number> {
    return Promise.resolve(
      this.#db.transaction(() => {
        const rows = this.#db.all(
          `SELECT s.session_id AS session_id, s.seq AS seq, e.payload AS payload
             FROM event_search AS s JOIN events AS e ON e.session_id = s.session_id AND e.seq = s.seq
            WHERE s.version < ? LIMIT ?`,
          [SEARCH_TEXT_VERSION, limit],
        );
        for (const row of rows) {
          let payload: unknown;
          try {
            payload = JSON.parse(String(row.payload));
          } catch {
            // Not JSON: searched as written, as the backfill did.
            payload = String(row.payload);
          }
          this.#db.run('UPDATE event_search SET text = ?, version = ? WHERE session_id = ? AND seq = ?', [
            eventSearchText(payload),
            SEARCH_TEXT_VERSION,
            row.session_id as string,
            row.seq as number,
          ]);
        }
        return rows.length;
      }),
    );
  }

  /**
   * Content search: events whose search text (see `eventSearchText`) contains
   * `q`, case-insensitively, walking the session's log in `order` from
   * `fromSeq` (asc) or `toSeq` (desc).
   *
   * It stops at `limit` matches, at the end of the range, or after examining
   * `MAX_SEARCH_SCAN` events. Only the last is `truncated`: events past
   * `resumeSeq` were not looked at, and the same query with `toSeq` (desc) or
   * `fromSeq` (asc) set to it carries on.
   */
  async search(sessionId: string, options: EventReadOptions): Promise<EventSearchResult> {
    const query = (options.q ?? '').replaceAll(VALUE_SEPARATOR, '').slice(0, MAX_QUERY_CHARS).toLowerCase();
    const descending = options.order === 'desc';
    const limit = Math.min(options.limit ?? 200, MAX_READ_LIMIT);
    const cap = Math.min(options.searchScanCap ?? MAX_SEARCH_SCAN, MAX_SEARCH_SCAN);
    const chunk = Math.max(1, Math.min(options.searchChunk ?? SEARCH_CHUNK, SEARCH_CHUNK));
    const { conditions, params } = filters(sessionId, options, 'e.');
    // A step reads `chunk` events whatever the filters let through: they are
    // judged per row, as `keep`, so a filter that matches little cannot make
    // one step read the whole log. `conditions[0]` is the session.
    const keep = conditions.length > 1 ? `(${conditions.slice(1).join(' AND ')})` : '1';
    const filterParams = params.slice(1);

    await this.#takeSearchSlot(options.signal);
    try {
      // A search handed a slot as another finished would otherwise run its first
      // step in the same turn, back to back with the last one, before any I/O.
      await nextLoopTurn();
      let lower = options.fromSeq;
      let upper = options.toSeq;
      const range = (): { sql: string[]; params: SqlValue[] } => {
        const sql: string[] = [];
        const values: SqlValue[] = [];
        if (lower !== undefined) {
          sql.push('e.seq >= ?');
          values.push(lower);
        }
        if (upper !== undefined) {
          sql.push('e.seq < ?');
          values.push(upper);
        }
        return { sql, params: values };
      };

      const hits: number[] = [];
      let scanned = 0;
      let exhausted = false;
      while (hits.length < limit && scanned < cap) {
        options.signal?.throwIfAborted();
        const step = Math.min(chunk, cap - scanned);
        const bounds = range();
        const rows = this.#db.all(
          `SELECT e.seq AS seq, ${keep} AS keep, coalesce(instr(s.text, ?), 0) > 0 AS hit
             FROM events AS e
             LEFT JOIN event_search AS s ON s.session_id = e.session_id AND s.seq = e.seq
            WHERE ${[conditions[0]!, ...bounds.sql].join(' AND ')}
            ORDER BY e.seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
          [...filterParams, query, params[0]!, ...bounds.params, step],
        );
        scanned += rows.length;
        for (const row of rows) {
          if (hits.length < limit && Number(row.keep) === 1 && Number(row.hit) === 1) hits.push(Number(row.seq));
        }
        const last = rows.at(-1);
        if (last !== undefined) {
          if (descending) upper = Number(last.seq);
          else lower = Number(last.seq) + 1;
        }
        if (rows.length < step) {
          exhausted = true;
          break;
        }
        if (hits.length < limit && scanned < cap) await nextLoopTurn();
      }

      if (!exhausted && hits.length < limit) {
        // Stopped at the cap: only truncated if something is actually left.
        const bounds = range();
        // Whether anything is left unexamined, filters aside: asking whether
        // anything left passes them could read the rest of the log in one go.
        exhausted =
          this.#db.get(
            `SELECT 1 AS present FROM events AS e WHERE ${[conditions[0]!, ...bounds.sql].join(' AND ')} LIMIT 1`,
            [params[0]!, ...bounds.params],
          ) === undefined;
      }

      const events =
        hits.length === 0
          ? []
          : this.#db
              .all(
                `SELECT * FROM events WHERE session_id = ? AND seq IN (${hits.map(() => '?').join(', ')})
                 ORDER BY seq ${descending ? 'DESC' : 'ASC'}`,
                [sessionId, ...hits],
              )
              .map(toEvent);
      const truncated = !exhausted && hits.length < limit;
      const resumeSeq = descending ? upper : lower;
      return {
        events,
        scanned,
        truncated,
        ...(truncated && resumeSeq !== undefined ? { resumeSeq } : {}),
      };
    } finally {
      this.#giveSearchSlot();
    }
  }

  async #takeSearchSlot(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (this.#activeSearches < MAX_ACTIVE_SEARCHES) {
      this.#activeSearches++;
      return;
    }
    if (this.#waitingSearches.length >= MAX_WAITING_SEARCHES) {
      throw new MaError({
        code: 'SEARCH_BUSY',
        category: 'quota',
        message:
          `This server is already running ${MAX_ACTIVE_SEARCHES} event-log searches with ${MAX_WAITING_SEARCHES} more waiting, ` +
          'so this one was not started. Retry shortly; a search narrowed by types, turn, or a seq or time range finishes sooner.',
        retryAfterSeconds: 1,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waitingSearches.indexOf(handOver);
        if (index !== -1) this.#waitingSearches.splice(index, 1);
        reject(signal!.reason);
      };
      const handOver = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.#waitingSearches.push(handOver);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #giveSearchSlot(): void {
    const next = this.#waitingSearches.shift();
    if (next) next();
    else this.#activeSearches--;
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
    afterSessionId = '',
  ): Promise<{ sessionId: string; oldest: number }[]> {
    // Grouped rather than one row per event: the sweep wants sessions to work
    // on, and a busy session could otherwise fill the whole batch by itself.
    // `INDEXED BY idx_events_ts` forces the ts-range index: this runs on the
    // largest table every retention tick, and without an explicit hint the
    // planner full-scans it via the primary-key autoindex (no ANALYZE ever runs
    // in production to teach it otherwise).
    //
    // The rotating cursor is a COMPOUND (oldest, session_id) keyset, not a bare
    // `oldest > ?`. `oldest` is MIN(ts) — a non-unique key: two sessions can
    // share the same oldest timestamp (ms-resolution collisions from a fan-out
    // or synchronized cron-minute writes are ordinary). A strict `>` on that
    // non-unique key would skip every tied member past the batch boundary — its
    // `oldest` equals the cursor, so `> cursor` is false — until the cursor
    // happened to wrap, which under a sustained backlog (fresh larger-oldest
    // candidates arriving each tick) may not happen for a long time, stranding
    // those sessions' expired events past their retention window. Pairing the
    // timestamp with the unique `session_id` makes the cursor total, so a tied
    // group is paged through within one rotation. (This is what the credential
    // sweep's id-keyed cursor gets for free; the events cursor must build it.)
    //
    // `afterOldest` is a coarse pre-cut cursor: the sweep returns candidates past
    // a shortest-possible-window `before`, but many are not expired under their
    // own workspace's longer retention — they otherwise reappear each tick,
    // monopolize the fixed batch, and starve sessions that genuinely need it.
    const rows = this.#db.all(
      `SELECT session_id, MIN(ts) AS oldest FROM events INDEXED BY idx_events_ts
        WHERE ts < ?
        GROUP BY session_id
        HAVING oldest > ? OR (oldest = ? AND session_id > ?)
        ORDER BY oldest ASC, session_id ASC
        LIMIT ?`,
      [before, afterOldest, afterOldest, afterSessionId, limit],
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

/** A read's predicates other than the seq range, with columns qualified by `prefix`. */
function filters(
  sessionId: string,
  options: EventReadOptions,
  prefix: string,
): { conditions: string[]; params: SqlValue[] } {
  const conditions = [`${prefix}session_id = ?`];
  const params: SqlValue[] = [sessionId];
  if (options.turn !== undefined) {
    conditions.push(`${prefix}turn = ?`);
    params.push(options.turn);
  }
  // A time window is a filter, not a cursor: ordering stays with `seq`, so
  // `ts` ties are irrelevant.
  if (options.fromTs !== undefined) {
    conditions.push(`${prefix}ts >= ?`);
    params.push(options.fromTs);
  }
  if (options.toTs !== undefined) {
    conditions.push(`${prefix}ts < ?`);
    params.push(options.toTs);
  }
  // An exact type or a `namespace.` prefix, so a consumer can subscribe to
  // `tool.` without enumerating its members.
  if (options.types && options.types.length > 0) {
    const clauses = options.types.map((filter) => {
      if (filter.endsWith('.')) {
        params.push(`${filter}%`);
        return `${prefix}type LIKE ?`;
      }
      params.push(filter);
      return `${prefix}type = ?`;
    });
    conditions.push(`(${clauses.join(' OR ')})`);
  }
  return { conditions, params };
}

/** A nullable SQL count as a sequence floor. */
function toSeq(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}
