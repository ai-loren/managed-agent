/**
 * The store's SQL is written for SQLite. This rewrites it for Postgres where
 * the two differ in what the store uses: placeholders, `IS ?`, the planner
 * hint, insert-or-ignore, two-argument MAX, instr, LIKE's case folding, and
 * the column types its migrations declare. String literals, quoted names and
 * comments are never touched.
 */

const translated = new Map<string, string>();
/** Repository SQL is a fixed set, but a cap keeps generated SQL from growing it without bound. */
const MAX_CACHED = 4000;

/** A statement the repositories run, as Postgres takes it. */
export function toPostgres(sql: string): string {
  let result = translated.get(sql);
  if (result === undefined) {
    result = translate(sql);
    if (translated.size < MAX_CACHED) translated.set(sql, result);
  }
  return result;
}

function translate(sql: string): string {
  let placeholder = 0;
  let result = mapCode(sql, (code) =>
    code
      // SQLite's IS compares with NULL as a value; Postgres spells that IS NOT DISTINCT FROM.
      .replace(/\bIS\s+NOT\s+\?/gi, 'IS DISTINCT FROM ?')
      .replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?')
      .replace(/\?/g, () => `$${++placeholder}`)
      .replace(/\s+INDEXED\s+BY\s+\w+/gi, '')
      .replace(/\bMAX\(\s*0\s*,/gi, 'GREATEST(0,')
      .replace(/\binstr\(/gi, 'strpos(')
      // SQLite's LIKE folds ASCII case; Postgres's does not.
      .replace(/(?<![\w])LIKE\b/gi, 'ILIKE'),
  );
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(result)) {
    result = `${result.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO')} ON CONFLICT DO NOTHING`;
  }
  return result;
}

/**
 * A migration statement as Postgres takes it. Table definitions map SQLite's
 * types: INTEGER (SQLite's are 64-bit) to BIGINT, REAL to DOUBLE PRECISION,
 * BLOB to BYTEA, and TEXT to TEXT in the "C" collation, so text sorts and
 * compares byte by byte as SQLite's does — keyset paging over ids depends on it.
 */
export function migrationToPostgres(statement: string): string {
  const code = stripComments(statement);
  if (!/^\s*(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(code)) return toPostgres(code);
  return mapCode(code, (part) =>
    part
      .replace(/\bINTEGER\b/g, 'BIGINT')
      .replace(/\bTEXT\b/g, 'TEXT COLLATE "C"')
      .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
      .replace(/\bBLOB\b/g, 'BYTEA'),
  );
}

function stripComments(sql: string): string {
  return mapCode(sql, (code) => code, true);
}

/**
 * Apply `fn` to the parts of `sql` outside string literals, quoted identifiers
 * and `--` comments. Comments are kept as written, or dropped: a quote inside
 * one opens nothing, and a `?` inside one is not a placeholder.
 */
function mapCode(sql: string, fn: (code: string) => string, dropComments = false): string {
  let result = '';
  let code = '';
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (char === '-' && sql[index + 1] === '-') {
      result += fn(code);
      code = '';
      const newline = sql.indexOf('\n', index);
      const end = newline === -1 ? sql.length : newline;
      if (!dropComments) result += sql.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char !== "'" && char !== '"') {
      code += char;
      continue;
    }
    result += fn(code);
    code = '';
    let end = index + 1;
    for (;;) {
      end = sql.indexOf(char, end);
      if (end === -1) {
        end = sql.length;
        break;
      }
      if (sql[end + 1] === char) {
        end += 2;
        continue;
      }
      break;
    }
    result += sql.slice(index, end + 1);
    index = end;
  }
  return result + fn(code);
}
