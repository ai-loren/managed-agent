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
    if (events.length === 0) return Promise.resolve([]);

    const stored = this.#db.transaction(() => {
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

    return Promise.resolve(stored);
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

    const order = options.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(options.limit ?? 200, MAX_READ_LIMIT);
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

  deleteForSession(sessionId: string): Promise<void> {
    this.#db.run('DELETE FROM events WHERE session_id = ?', [sessionId]);
    return Promise.resolve();
  }
}

/** A nullable SQL count as a sequence floor. */
function toSeq(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}
