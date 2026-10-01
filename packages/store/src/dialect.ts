/**
 * Where SQLite's and Postgres's SQL differ in a way a text rewrite cannot
 * settle: reading inside a JSON column, whose result the caller compares as
 * text, as a number or as `true`. Paths are dotted keys (`sandbox.prewarm`).
 */

export type Dialect = 'sqlite' | 'postgres';

const pgPath = (path: string): string => `'{${path.split('.').join(',')}}'`;

/** The value at `path` as text, or NULL when absent. */
export function jsonText(dialect: Dialect, column: string, path: string): string {
  return dialect === 'sqlite' ? `json_extract(${column}, '$.${path}')` : `(${column}::jsonb #>> ${pgPath(path)})`;
}

/** The value at `path` as a number, or NULL when absent. */
export function jsonNumber(dialect: Dialect, column: string, path: string): string {
  return dialect === 'sqlite' ? `json_extract(${column}, '$.${path}')` : `(${column}::jsonb #>> ${pgPath(path)})::numeric`;
}

/** Whether the value at `path` is JSON `true`; SQLite's `json_extract` reads it as 1. */
export function jsonIsTrue(dialect: Dialect, column: string, path: string): string {
  return dialect === 'sqlite' ? `json_extract(${column}, '$.${path}') = 1` : `(${column}::jsonb #> ${pgPath(path)}) = 'true'::jsonb`;
}
