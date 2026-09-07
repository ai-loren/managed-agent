/**
 * Row ↔ entity mapping.
 *
 * SQLite has no JSON, boolean or undefined types, so every crossing of that
 * boundary needs an explicit conversion. Centralising them here means the
 * repositories read as domain code, and a mistake shows up in one place rather
 * than scattered through thirty query methods.
 */

import { internalError, validationError } from '@ma/core';

/** A row as `node:sqlite` returns it. */
export type Row = Record<string, unknown>;

// --- reading ---------------------------------------------------------------

export function readString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

export function readNumber(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw internalError(`Column '${column}' is not numeric: ${String(value)}`);
  }
  return parsed;
}

/** Nullable timestamps and counters come back as `undefined`, not `null`. */
export function readOptionalNumber(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return readNumber(row, column);
}

export function readOptionalString(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined || value === '') return undefined;
  return String(value);
}

/** SQLite stores booleans as 0/1. */
export function readBoolean(row: Row, column: string): boolean {
  const value = row[column];
  return value === 1 || value === true || value === '1';
}

/**
 * Parse a JSON column, falling back to `fallback` when the column is empty.
 *
 * A malformed value throws rather than silently returning the fallback: JSON we
 * wrote ourselves failing to parse means corruption, and hiding it would turn a
 * loud failure into a quiet wrong answer.
 */
export function readJson<T>(row: Row, column: string, fallback: T): T {
  const value = row[column];
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw internalError(`Column '${column}' contains malformed JSON`, error);
  }
}

/** A nullable JSON column, e.g. a structured error that is usually absent. */
export function readOptionalJson<T>(row: Row, column: string): T | undefined {
  const value = row[column];
  if (value === null || value === undefined || value === '') return undefined;
  return readJson<T>(row, column, undefined as unknown as T);
}

// --- writing ---------------------------------------------------------------

/** Values `node:sqlite` accepts as bound parameters. */
export type SqlValue = string | number | null | Uint8Array;

export function writeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Omit an absent optional rather than writing the string "undefined". */
export function writeOptionalJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function writeBoolean(value: boolean | undefined): number {
  return value ? 1 : 0;
}

export function writeOptional(value: string | number | undefined | null): SqlValue {
  return value === undefined || value === null ? null : value;
}

// --- patch building --------------------------------------------------------

/**
 * Build the `SET` clause of an UPDATE from a partial patch.
 *
 * Only keys actually present in the patch are written, so a caller updating one
 * field cannot accidentally null out the rest — the read-modify-write race this
 * avoids is the reason repositories take patches instead of whole entities.
 */
export function buildUpdate(
  patch: Record<string, unknown>,
  mapping: Record<string, { column: string; encode?: (value: unknown) => SqlValue }>,
): { clause: string; values: SqlValue[] } {
  const assignments: string[] = [];
  const values: SqlValue[] = [];

  for (const [field, spec] of Object.entries(mapping)) {
    if (!Object.hasOwn(patch, field)) continue;
    const raw = patch[field];
    assignments.push(`${spec.column} = ?`);
    if (spec.encode) {
      values.push(spec.encode(raw));
    } else if (raw === undefined || raw === null) {
      values.push(null);
    } else if (typeof raw === 'boolean') {
      values.push(raw ? 1 : 0);
    } else if (typeof raw === 'object') {
      values.push(JSON.stringify(raw));
    } else {
      values.push(raw as SqlValue);
    }
  }

  return { clause: assignments.join(', '), values };
}

// --- cursors ---------------------------------------------------------------

/**
 * Keyset cursors are opaque to clients but are just a base64url'd key. They are
 * deliberately not signed: a tampered cursor can only page from a different
 * position within data the caller is already authorized to read, and every list
 * query is scoped by authorization independently of the cursor.
 */
export function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    return decoded === '' ? undefined : decoded;
  } catch {
    // A malformed cursor is a client error, but treating it as "start from the
    // beginning" would silently restart a paging loop. Fail loudly instead.
    throw validationError('Malformed pagination cursor', { cursor });
  }
}
