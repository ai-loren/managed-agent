/**
 * Structured logging.
 *
 * Logs are records, not sentences. Every entry is JSON with a stable shape, and
 * context (request id, session id, workspace) is attached by binding a child
 * logger rather than by remembering to interpolate it at each call site.
 *
 * Redaction is applied here, at the last moment before serialization, because
 * that is the only place we can guarantee it happened.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that stamps `fields` onto every subsequent entry. */
  child(fields: LogFields): Logger;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

/**
 * Field names whose values are replaced with `[redacted]`, matched
 * case-insensitively on the whole key. Redaction is deliberately key-based and
 * conservative: a value that merely looks like a secret is left alone, but a
 * field *named* like one is always removed, however it was produced.
 */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'credentialvalue',
  'value',
  'ciphertext',
  'privatekey',
  'clientsecret',
  'signature',
  'displaycode',
]);

const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  base?: LogFields;
}

/** Default sink: one JSON object per line, warnings and errors to stderr. */
export const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

/** A sink that records into an array — the one to use in tests. */
export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = ((record: LogRecord) => {
    records.push(record);
  }) as LogSink & { records: LogRecord[] };
  sink.records = records;
  return sink;
}

class StructuredLogger implements Logger {
  readonly #level: number;
  readonly #sink: LogSink;
  readonly #base: LogFields;

  constructor(options: LoggerOptions = {}) {
    this.#level = LEVEL_ORDER[options.level ?? 'info'];
    this.#sink = options.sink ?? consoleSink;
    this.#base = options.base ?? {};
  }

  #emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.#level) return;
    const merged = fields ? { ...this.#base, ...fields } : this.#base;
    const record = redact(merged) as LogFields;
    this.#sink({
      ts: new Date().toISOString(),
      level,
      message,
      ...record,
    });
  }

  debug(message: string, fields?: LogFields): void {
    this.#emit('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#emit('error', message, fields);
  }

  child(fields: LogFields): Logger {
    const options: LoggerOptions = {
      sink: this.#sink,
      base: { ...this.#base, ...fields },
    };
    for (const [name, value] of Object.entries(LEVEL_ORDER)) {
      if (value === this.#level) options.level = name as LogLevel;
    }
    return new StructuredLogger(options);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}

/** A logger that discards everything. For tests that do not assert on logs. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};
