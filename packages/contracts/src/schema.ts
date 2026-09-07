/**
 * Schema combinators.
 *
 * One schema definition yields three things that must never drift apart:
 * the static TypeScript type, the runtime validator, and the JSON Schema for
 * OpenAPI. Keeping them in one expression is the whole point — a hand-written
 * validator beside a hand-written interface is a bug waiting for its release.
 *
 * Why not a library? This validator is ~400 lines, has no dependencies, and we
 * need exact control over two behaviours that general-purpose libraries differ
 * on: error *accumulation* (an API should report every bad field at once, not
 * the first) and *coercion* (a query string's `"20"` must become `20`, but a
 * JSON body's `"20"` must not).
 */

import { validationError } from '@ma/core';

/** A path into the validated value, e.g. `['spec', 'skills', 0, 'sha256']`. */
export type Path = readonly (string | number)[];

export interface Issue {
  /** Dotted/bracketed rendering of the path, e.g. `spec.skills[0].sha256`. */
  path: string;
  message: string;
}

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: Issue[] };

export interface ParseOptions {
  /**
   * Convert string inputs to the target primitive. Enabled for query strings
   * and path params, never for JSON bodies — a JSON client sending `"5"` for a
   * number field has a bug we should surface, not paper over.
   */
  coerce?: boolean;
}

/** JSON Schema fragment, emitted for OpenAPI. */
export type JsonSchema = Record<string, unknown>;

export interface Schema<T> {
  readonly kind: string;
  /** Validate and return the typed value, or the accumulated issues. */
  parse(value: unknown, options?: ParseOptions, path?: Path): ValidationOutcome<T>;
  /** JSON Schema representation. */
  toJsonSchema(): JsonSchema;
  /** Phantom marker so `Infer` can recover the type. */
  readonly _type?: T;
}

/** Recover the static type a schema validates. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

// --- helpers ---------------------------------------------------------------

function renderPath(path: Path): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

function fail(path: Path, message: string): ValidationOutcome<never> {
  return { ok: false, issues: [{ path: renderPath(path), message }] };
}

function succeed<T>(value: T): ValidationOutcome<T> {
  return { ok: true, value };
}

function define<T>(
  kind: string,
  parse: (value: unknown, options: ParseOptions, path: Path) => ValidationOutcome<T>,
  toJsonSchema: () => JsonSchema,
): Schema<T> {
  return {
    kind,
    parse: (value, options = {}, path = []) => parse(value, options, path),
    toJsonSchema,
  };
}

// --- primitives ------------------------------------------------------------

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** Reject a string that is empty or only whitespace. */
  nonBlank?: boolean;
  format?: string;
  description?: string;
}

export function string(options: StringOptions = {}): Schema<string> {
  return define<string>(
    'string',
    (value, _opts, path) => {
      if (typeof value !== 'string') return fail(path, `expected a string, got ${typeName(value)}`);
      if (options.nonBlank && value.trim() === '') return fail(path, 'must not be blank');
      if (options.minLength !== undefined && value.length < options.minLength) {
        return fail(path, `must be at least ${options.minLength} characters`);
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        return fail(path, `must be at most ${options.maxLength} characters`);
      }
      if (options.pattern && !options.pattern.test(value)) {
        return fail(path, `must match ${options.pattern}`);
      }
      return succeed(value);
    },
    () => ({
      type: 'string',
      ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
      ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
      ...(options.pattern ? { pattern: options.pattern.source } : {}),
      ...(options.format ? { format: options.format } : {}),
      ...(options.description ? { description: options.description } : {}),
    }),
  );
}

export interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  description?: string;
}

export function number(options: NumberOptions = {}): Schema<number> {
  return define<number>(
    'number',
    (value, opts, path) => {
      let candidate = value;
      if (opts.coerce && typeof candidate === 'string' && candidate.trim() !== '') {
        const parsed = Number(candidate);
        if (Number.isFinite(parsed)) candidate = parsed;
      }
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
        return fail(path, `expected a number, got ${typeName(value)}`);
      }
      if (options.integer && !Number.isInteger(candidate)) return fail(path, 'must be an integer');
      if (options.min !== undefined && candidate < options.min) {
        return fail(path, `must be >= ${options.min}`);
      }
      if (options.max !== undefined && candidate > options.max) {
        return fail(path, `must be <= ${options.max}`);
      }
      return succeed(candidate);
    },
    () => ({
      type: options.integer ? 'integer' : 'number',
      ...(options.min !== undefined ? { minimum: options.min } : {}),
      ...(options.max !== undefined ? { maximum: options.max } : {}),
      ...(options.description ? { description: options.description } : {}),
    }),
  );
}

export function integer(options: Omit<NumberOptions, 'integer'> = {}): Schema<number> {
  return number({ ...options, integer: true });
}

export function boolean(description?: string): Schema<boolean> {
  return define<boolean>(
    'boolean',
    (value, opts, path) => {
      if (opts.coerce && typeof value === 'string') {
        if (value === 'true' || value === '1') return succeed(true);
        if (value === 'false' || value === '0' || value === '') return succeed(false);
      }
      if (typeof value !== 'boolean') return fail(path, `expected a boolean, got ${typeName(value)}`);
      return succeed(value);
    },
    () => ({ type: 'boolean', ...(description ? { description } : {}) }),
  );
}

/** A closed set of string values. The workhorse for every status field. */
export function enumOf<const V extends readonly string[]>(
  values: V,
  description?: string,
): Schema<V[number]> {
  const allowed = new Set<string>(values);
  return define<V[number]>(
    'enum',
    (value, _opts, path) => {
      if (typeof value !== 'string' || !allowed.has(value)) {
        return fail(path, `must be one of: ${values.join(', ')}`);
      }
      return succeed(value as V[number]);
    },
    () => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  );
}

/** Exactly one value — used as a discriminant inside unions. */
export function literal<const V extends string>(value: V): Schema<V> {
  return define<V>(
    'literal',
    (input, _opts, path) => (input === value ? succeed(value) : fail(path, `must be "${value}"`)),
    () => ({ type: 'string', const: value }),
  );
}

/** Epoch milliseconds. */
export function timestamp(description?: string): Schema<number> {
  return number({ min: 0, integer: true, ...(description ? { description } : {}) });
}

/** A resource id of a specific kind, e.g. `id('session')`. */
export function id<K extends string>(kind: K, description?: string): Schema<string> {
  return define<string>(
    'id',
    (value, _opts, path) => {
      if (typeof value !== 'string') return fail(path, `expected a ${kind} id, got ${typeName(value)}`);
      // Validated structurally here; `isId` from core does the prefix check at
      // the boundary where the kind registry is available.
      if (!/^[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
        return fail(path, `must be a valid ${kind} id`);
      }
      return succeed(value);
    },
    () => ({
      type: 'string',
      pattern: '^[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{26}$',
      description: description ?? `A ${kind} identifier`,
    }),
  );
}

/** A lowercase hex SHA-256 digest. */
export function sha256(description?: string): Schema<string> {
  return string({
    pattern: /^[0-9a-f]{64}$/,
    ...(description ? { description } : {}),
  });
}

/** Any JSON value. Used only where the payload is genuinely open. */
export function unknown(description?: string): Schema<unknown> {
  return define<unknown>(
    'unknown',
    (value) => succeed(value),
    () => (description ? { description } : {}),
  );
}

// --- composites ------------------------------------------------------------

export function array<T>(
  element: Schema<T>,
  options: { minItems?: number; maxItems?: number; description?: string } = {},
): Schema<T[]> {
  return define<T[]>(
    'array',
    (value, opts, path) => {
      if (!Array.isArray(value)) return fail(path, `expected an array, got ${typeName(value)}`);
      if (options.minItems !== undefined && value.length < options.minItems) {
        return fail(path, `must contain at least ${options.minItems} items`);
      }
      if (options.maxItems !== undefined && value.length > options.maxItems) {
        return fail(path, `must contain at most ${options.maxItems} items`);
      }
      const out: T[] = [];
      const issues: Issue[] = [];
      for (let index = 0; index < value.length; index++) {
        const result = element.parse(value[index], opts, [...path, index]);
        if (result.ok) out.push(result.value);
        else issues.push(...result.issues);
      }
      return issues.length > 0 ? { ok: false, issues } : succeed(out);
    },
    () => ({
      type: 'array',
      items: element.toJsonSchema(),
      ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
      ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
      ...(options.description ? { description: options.description } : {}),
    }),
  );
}

/** A string-keyed map with uniformly-typed values. */
export function record<T>(value: Schema<T>, description?: string): Schema<Record<string, T>> {
  return define<Record<string, T>>(
    'record',
    (input, opts, path) => {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return fail(path, `expected an object, got ${typeName(input)}`);
      }
      const out: Record<string, T> = {};
      const issues: Issue[] = [];
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        const result = value.parse(item, opts, [...path, key]);
        if (result.ok) out[key] = result.value;
        else issues.push(...result.issues);
      }
      return issues.length > 0 ? { ok: false, issues } : succeed(out);
    },
    () => ({
      type: 'object',
      additionalProperties: value.toJsonSchema(),
      ...(description ? { description } : {}),
    }),
  );
}

/** Marks a field as optional inside `object`. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
  readonly inner: Schema<T>;
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  const schema = define<T | undefined>(
    'optional',
    (value, opts, path) => (value === undefined || value === null ? succeed(undefined) : inner.parse(value, opts, path)),
    () => inner.toJsonSchema(),
  );
  return Object.assign(schema, { optional: true as const, inner });
}

/**
 * A field that may be omitted on input but is always present on output.
 *
 * This distinction matters and is easy to get wrong: `optional(x)` yields
 * `key?: T` because the key really can be absent afterwards, whereas
 * `withDefault(x, d)` yields `key: T` — the parser guarantees a value. Typing
 * defaulted fields as optional would force every consumer to write `?? fallback`
 * for a value that is definitionally there, and would let a genuine `undefined`
 * slip through unnoticed.
 *
 * The two share the `optional: true` marker, which the object parser reads to
 * decide "may this be absent on input?"; `defaulted: true` is what the type
 * inference reads to decide "is this present on output?".
 */
export interface DefaultedSchema<T> extends Schema<T> {
  readonly optional: true;
  readonly defaulted: true;
  readonly inner: Schema<T>;
}

export function withDefault<T>(inner: Schema<T>, defaultValue: T | (() => T)): DefaultedSchema<T> {
  const make = (): T => (typeof defaultValue === 'function' ? (defaultValue as () => T)() : defaultValue);
  const schema = define<T>(
    'default',
    (value, opts, path) => (value === undefined || value === null ? succeed(make()) : inner.parse(value, opts, path)),
    () => ({
      ...inner.toJsonSchema(),
      ...(typeof defaultValue === 'function' ? {} : { default: defaultValue }),
    }),
  );
  return Object.assign(schema, { optional: true as const, defaulted: true as const, inner });
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return define<T | null>(
    'nullable',
    (value, opts, path) => (value === null ? succeed(null) : inner.parse(value, opts, path)),
    () => ({ ...inner.toJsonSchema(), nullable: true }),
  );
}

type ShapeOf = Record<string, Schema<unknown>>;

/**
 * Keys the *output* type marks `?`. A `withDefault` field may be absent on
 * input but is always present on output, so it is deliberately excluded here —
 * see the note on `DefaultedSchema`.
 */
type OptionalKeys<S extends ShapeOf> = {
  [K in keyof S]: S[K] extends { defaulted: true } ? never : S[K] extends { optional: true } ? K : never;
}[keyof S];

type RequiredKeys<S extends ShapeOf> = Exclude<keyof S, OptionalKeys<S>>;

export type ObjectType<S extends ShapeOf> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Infer<S[K]>;
};

export interface ObjectOptions {
  /** Keep properties not present in the shape. Default: strip them. */
  passthrough?: boolean;
  /** Reject unknown properties instead of stripping. */
  strict?: boolean;
  description?: string;
}

/**
 * An object schema. Unknown keys are **stripped** by default: a client sending
 * an extra field gets a clean result rather than an error, but that field never
 * reaches storage. `strict` is for places where an unexpected key signals a
 * client bug worth surfacing (e.g. agent version specs).
 */
export function object<S extends ShapeOf>(
  shape: S,
  options: ObjectOptions = {},
): Schema<ObjectType<S>> & { readonly shape: S } {
  const schema = define<ObjectType<S>>(
    'object',
    (value, opts, path) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return fail(path, `expected an object, got ${typeName(value)}`);
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const issues: Issue[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const present = Object.hasOwn(input, key);
        const raw = present ? input[key] : undefined;
        // `optional` here means "may be absent on input" — true for both
        // `optional()` and `withDefault()`.
        const mayBeAbsent = (fieldSchema as { optional?: boolean }).optional === true;

        if (!present && !mayBeAbsent) {
          issues.push({ path: renderPath([...path, key]), message: 'is required' });
          continue;
        }
        const result = fieldSchema.parse(raw, opts, [...path, key]);
        if (!result.ok) issues.push(...result.issues);
        else if (result.value !== undefined) out[key] = result.value;
      }

      if (options.strict) {
        for (const key of Object.keys(input)) {
          if (!Object.hasOwn(shape, key)) {
            issues.push({ path: renderPath([...path, key]), message: 'is not a known property' });
          }
        }
      } else if (options.passthrough) {
        for (const [key, item] of Object.entries(input)) {
          if (!Object.hasOwn(shape, key)) out[key] = item;
        }
      }

      return issues.length > 0 ? { ok: false, issues } : succeed(out as ObjectType<S>);
    },
    () => {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, fieldSchema] of Object.entries(shape)) {
        properties[key] = fieldSchema.toJsonSchema();
        // A defaulted field is not required of the *client*, so it belongs
        // outside `required` even though it is always present on output.
        if ((fieldSchema as { optional?: boolean }).optional !== true) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...(options.strict ? { additionalProperties: false } : {}),
        ...(options.description ? { description: options.description } : {}),
      };
    },
  );
  return Object.assign(schema, { shape });
}

/**
 * A tagged union keyed on a discriminant field. Errors point at the specific
 * variant once the tag matches, which is far more useful than "no variant
 * matched" from a naive union.
 */
export function discriminatedUnion<K extends string, S extends Record<string, Schema<unknown>>>(
  discriminant: K,
  variants: S,
): Schema<Infer<S[keyof S]>> {
  const tags = Object.keys(variants);
  return define<Infer<S[keyof S]>>(
    'union',
    (value, opts, path) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return fail(path, `expected an object, got ${typeName(value)}`);
      }
      const tag = (value as Record<string, unknown>)[discriminant];
      if (typeof tag !== 'string' || !Object.hasOwn(variants, tag)) {
        return fail([...path, discriminant], `must be one of: ${tags.join(', ')}`);
      }
      return variants[tag]!.parse(value, opts, path) as ValidationOutcome<Infer<S[keyof S]>>;
    },
    () => ({
      oneOf: Object.values(variants).map((variant) => variant.toJsonSchema()),
      discriminator: { propertyName: discriminant },
    }),
  );
}

/** Narrow an existing schema with an extra predicate. */
export function refine<T>(inner: Schema<T>, check: (value: T) => true | string): Schema<T> {
  return define<T>(
    'refine',
    (value, opts, path) => {
      const result = inner.parse(value, opts, path);
      if (!result.ok) return result;
      const verdict = check(result.value);
      return verdict === true ? result : fail(path, verdict);
    },
    () => inner.toJsonSchema(),
  );
}

// --- entry points ----------------------------------------------------------

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Parse, returning the outcome. Use when issues are data. */
export function parse<T>(schema: Schema<T>, value: unknown, options?: ParseOptions): ValidationOutcome<T> {
  return schema.parse(value, options ?? {}, []);
}

/**
 * Parse or throw a `VALIDATION_FAILED` error carrying every issue. This is what
 * the gateway calls, so a client sees all its mistakes in one response.
 */
export function parseOrThrow<T>(schema: Schema<T>, value: unknown, options?: ParseOptions): T {
  const result = schema.parse(value, options ?? {}, []);
  if (result.ok) return result.value;
  throw validationError(
    `Request validation failed: ${result.issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`,
    { issues: result.issues },
  );
}
