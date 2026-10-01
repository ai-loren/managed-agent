/**
 * Shared CRUD machinery.
 *
 * Fifteen repositories share the same six query shapes. Writing them out per
 * repository would be ~1500 lines of near-identical SQL where a typo hides
 * easily, so the mechanical parts live here and each repository declares only
 * what is genuinely specific to it: its table, its column mapping, and its
 * filters.
 */

import { conflict, notFound } from '@ma/core';

import type { SqlDatabase } from '../database.ts';
import {
  buildUpdate,
  decodeCursor,
  encodeCursor,
  type Row,
  type SqlValue,
} from '../mapping.ts';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, type Page, type PageRequest } from '../repository.ts';

/** How an entity maps onto a table. */
export interface TableSpec<T> {
  table: string;
  /** Human name used in `NOT_FOUND` messages. */
  kind: string;
  /** Primary key column. Composite keys are handled by their own repository. */
  idColumn?: string;
  /** Row → entity. */
  fromRow(row: Row): T;
  /** Entity → column/value pairs for INSERT. */
  toColumns(entity: T): Record<string, SqlValue>;
  /** Field → column mapping for partial updates. */
  updateMapping: Record<string, { column: string; encode?: (value: unknown) => SqlValue }>;
  /**
   * A column auto-incremented (`col = col + 1`) on every `patch`/`update`, in the
   * same statement, so a monotonic version is bumped by every writer without any
   * caller setting it. Used for optimistic-concurrency tokens (e.g. the workspace
   * `version` backing `If-Match`). The column must not appear in `updateMapping`,
   * so a caller can never write it directly.
   */
  autoIncrementColumn?: string;
}

/** A WHERE fragment plus its bound values. */
export interface Condition {
  sql: string;
  values: SqlValue[];
}

export function condition(sql: string, ...values: SqlValue[]): Condition {
  return { sql, values };
}

/** `IN (?, ?, ...)` with the right arity, or nothing when the list is empty. */
export function inCondition(column: string, values: readonly string[]): Condition | undefined {
  if (values.length === 0) return undefined;
  return { sql: `${column} IN (${values.map(() => '?').join(', ')})`, values: [...values] };
}

export class CrudRepository<T> {
  protected readonly db: SqlDatabase;
  protected readonly spec: TableSpec<T>;

  constructor(db: SqlDatabase, spec: TableSpec<T>) {
    this.db = db;
    this.spec = spec;
  }

  protected get idColumn(): string {
    return this.spec.idColumn ?? 'id';
  }

  insert(entity: T): T {
    const columns = this.spec.toColumns(entity);
    const names = Object.keys(columns);
    const placeholders = names.map(() => '?').join(', ');
    try {
      this.db.run(
        `INSERT INTO ${this.spec.table} (${names.join(', ')}) VALUES (${placeholders})`,
        Object.values(columns),
      );
    } catch (error) {
      // A unique violation is a domain conflict (duplicate slug, duplicate
      // external key), not an internal error — the caller can act on it.
      if (isUniqueViolation(error)) {
        throw conflict(`${this.spec.kind} already exists`, { cause: describeError(error) });
      }
      throw error;
    }
    return entity;
  }

  findById(id: string): T | undefined {
    const row = this.db.get(`SELECT * FROM ${this.spec.table} WHERE ${this.idColumn} = ?`, [id]);
    return row ? this.spec.fromRow(row) : undefined;
  }

  /** Read or throw `NOT_FOUND`, so callers need not repeat the check. */
  requireById(id: string): T {
    const found = this.findById(id);
    if (!found) throw notFound(this.spec.kind, id);
    return found;
  }

  findOne(conditions: readonly Condition[]): T | undefined {
    const { clause, values } = combine(conditions);
    const row = this.db.get(`SELECT * FROM ${this.spec.table} ${clause} LIMIT 1`, values);
    return row ? this.spec.fromRow(row) : undefined;
  }

  patch(id: string, patch: Partial<T>): T {
    const { clause, values } = buildUpdate(patch as Record<string, unknown>, this.spec.updateMapping);
    if (clause === '') {
      // An empty patch is a no-op, not an error: callers that conditionally
      // build a patch should not have to check whether it ended up empty. No
      // real field changed, so the auto-increment column is not bumped either —
      // a version only advances on an actual write.
      return this.requireById(id);
    }
    // Append the monotonic auto-increment (e.g. workspace `version`) in the SAME
    // statement, so every writer that reaches `patch` bumps it atomically without
    // setting it explicitly. `col = col + 1` is read-free in-SQL, so it composes
    // with any concurrent write. The column is deliberately absent from
    // `updateMapping`, so this is the only path that can change it.
    const setClause = this.spec.autoIncrementColumn
      ? `${clause}, ${this.spec.autoIncrementColumn} = ${this.spec.autoIncrementColumn} + 1`
      : clause;
    try {
      const result = this.db.run(
        `UPDATE ${this.spec.table} SET ${setClause} WHERE ${this.idColumn} = ?`,
        [...values, id],
      );
      if (result.changes === 0) throw notFound(this.spec.kind, id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(`${this.spec.kind} update violates a uniqueness constraint`, {
          cause: describeError(error),
        });
      }
      throw error;
    }
    return this.requireById(id);
  }

  remove(id: string): void {
    this.db.run(`DELETE FROM ${this.spec.table} WHERE ${this.idColumn} = ?`, [id]);
  }

  count(conditions: readonly Condition[] = []): number {
    const { clause, values } = combine(conditions);
    const row = this.db.get(`SELECT COUNT(*) AS value FROM ${this.spec.table} ${clause}`, values);
    return Number(row?.value ?? 0);
  }

  /**
   * Keyset pagination over the primary key.
   *
   * Ids are ULIDs, so the key orders by creation time and a cursor is just the
   * last id seen. Offsets are avoided deliberately: with rows being inserted
   * continuously, `OFFSET n` silently skips or repeats records mid-page.
   *
   * One extra row is fetched to decide whether a next page exists without a
   * second COUNT query.
   */
  page(conditions: readonly Condition[], request: PageRequest = {}): Page<T> {
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
    const descending = request.order === 'desc';
    const all = [...conditions];

    const cursor = decodeCursor(request.cursor);
    if (cursor) {
      all.push(condition(`${this.idColumn} ${descending ? '<' : '>'} ?`, cursor));
    }

    const { clause, values } = combine(all);
    const rows = this.db.all(
      `SELECT * FROM ${this.spec.table} ${clause}
       ORDER BY ${this.idColumn} ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      [...values, limit + 1],
    );

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => this.spec.fromRow(row));

    if (!hasMore) return { items };
    const lastRow = rows[limit - 1];
    return {
      items,
      nextCursor: encodeCursor(String(lastRow?.[this.idColumn] ?? '')),
    };
  }

  /** Rows matching `conditions`, ordered by an explicit column. */
  findMany(
    conditions: readonly Condition[],
    options: {
      orderBy?: string;
      order?: 'asc' | 'desc';
      limit?: number;
      /**
       * Force a specific index (`INDEXED BY`). Used for hot sweep queries where
       * the planner would otherwise full-scan a growing table because no ANALYZE
       * has run (the query-plan stats are never refreshed in production). Naming
       * the index makes the plan deterministic and, as a bonus, turns a dropped
       * index into a loud query error rather than a silent full scan.
       */
      indexedBy?: string;
    } = {},
  ): T[] {
    const { clause, values } = combine(conditions);
    const orderBy = options.orderBy ?? this.idColumn;
    const direction = options.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(options.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const indexHint = options.indexedBy ? ` INDEXED BY ${options.indexedBy}` : '';
    const rows = this.db.all(
      `SELECT * FROM ${this.spec.table}${indexHint} ${clause} ORDER BY ${orderBy} ${direction} LIMIT ?`,
      [...values, limit],
    );
    return rows.map((row) => this.spec.fromRow(row));
  }
}

function combine(conditions: readonly Condition[]): { clause: string; values: SqlValue[] } {
  const present = conditions.filter((item): item is Condition => item !== undefined);
  if (present.length === 0) return { clause: '', values: [] };
  return {
    clause: `WHERE ${present.map((item) => item.sql).join(' AND ')}`,
    values: present.flatMap((item) => item.values),
  };
}

export function isUniqueViolation(error: unknown): boolean {
  // Postgres's unique_violation.
  if ((error as { code?: unknown }).code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') || message.includes('PRIMARY KEY');
}

/** Constraint text only — never the offending values, which may be secret. */
function describeError(error: unknown): string {
  const constraint = (error as { constraint?: unknown }).constraint;
  if (typeof constraint === 'string') return constraint;
  const message = error instanceof Error ? error.message : String(error);
  const match = /UNIQUE constraint failed: ([\w., ]+)/.exec(message);
  return match?.[1] ?? 'constraint violation';
}
