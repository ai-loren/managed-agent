/**
 * Prefixed, lexicographically-sortable identifiers.
 *
 * Every resource id is `<prefix>_<26 char Crockford base32 ULID>`. The ULID's
 * leading 48 bits are a millisecond timestamp, so ids sort by creation time as
 * plain strings — which lets the store use them as cursors without a secondary
 * index, and lets a client mint an id before the write so creates can be
 * idempotent.
 */

import { randomBytes } from 'node:crypto';

/** Crockford base32: no I, L, O or U, so ids survive being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODED_TIME_LENGTH = 10;
const ENCODED_RANDOM_LENGTH = 16;
export const ULID_LENGTH = ENCODED_TIME_LENGTH + ENCODED_RANDOM_LENGTH;

/** The closed set of resource kinds. Adding one is a deliberate act. */
export const ID_PREFIXES = {
  workspace: 'ws',
  agent: 'ag',
  agentVersion: 'av',
  session: 'sn',
  sandbox: 'sb',
  credential: 'cr',
  connector: 'cn',
  binding: 'bd',
  receipt: 'rc',
  schedule: 'sc',
  dataset: 'ds',
  document: 'dc',
  skill: 'sk',
  plugin: 'pg',
  event: 'ev',
  principal: 'pr',
  apiKey: 'ak',
  auditEntry: 'au',
  task: 'tk',
  artifact: 'ar',
  memory: 'me',
  agentTemplate: 'at',
} as const;

export type ResourceKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[ResourceKind];

/** `ws_01J...` — the string form every API surface speaks. */
export type Id<K extends ResourceKind = ResourceKind> = string & { readonly __kind?: K };

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError(`ULID timestamp out of range: ${now}`);
  }
  let out = '';
  let remaining = now;
  for (let i = ENCODED_TIME_LENGTH - 1; i >= 0; i--) {
    const mod = remaining % 32;
    out = ALPHABET[mod]! + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  // 16 base32 chars = 80 bits of entropy, drawn from the CSPRNG. Rejection
  // sampling is unnecessary because 256 % 32 === 0, so masking is unbiased.
  const bytes = randomBytes(ENCODED_RANDOM_LENGTH);
  let out = '';
  for (let i = 0; i < ENCODED_RANDOM_LENGTH; i++) {
    out += ALPHABET[bytes[i]! & 0x1f];
  }
  return out;
}

/**
 * A bare ULID with no prefix.
 *
 * `now` defaults to the wall clock because id minting happens in places with no
 * `Clock` in scope (client-side pre-generation, for one) and because an id's
 * embedded timestamp is metadata, not behaviour — nothing branches on it. Every
 * caller that *does* have a clock should pass `clock.now()`.
 */
// ma-lint-disable-next-line no-date-now -- see the note above
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Mint an id for a resource kind, e.g. `newId('session') → 'sn_01J...'`. */
export function newId<K extends ResourceKind>(kind: K, now?: number): Id<K> {
  return `${ID_PREFIXES[kind]}_${ulid(now)}` as Id<K>;
}

const PREFIX_TO_KIND: ReadonlyMap<string, ResourceKind> = new Map(
  Object.entries(ID_PREFIXES).map(([kind, prefix]) => [prefix, kind as ResourceKind]),
);

const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** True when `value` is a syntactically valid id, optionally of a given kind. */
export function isId(value: unknown, kind?: ResourceKind): value is Id {
  if (typeof value !== 'string') return false;
  const sep = value.indexOf('_');
  if (sep <= 0) return false;
  const prefix = value.slice(0, sep);
  const body = value.slice(sep + 1);
  if (!ULID_PATTERN.test(body)) return false;
  const resolved = PREFIX_TO_KIND.get(prefix);
  if (resolved === undefined) return false;
  return kind === undefined || resolved === kind;
}

/** The resource kind an id belongs to, or `undefined` if it is not an id. */
export function kindOf(value: string): ResourceKind | undefined {
  const sep = value.indexOf('_');
  if (sep <= 0) return undefined;
  return PREFIX_TO_KIND.get(value.slice(0, sep));
}

/** The creation time encoded in an id's ULID, or `undefined` if unparseable. */
export function timeOf(value: string): number | undefined {
  const sep = value.indexOf('_');
  const body = sep > 0 ? value.slice(sep + 1) : value;
  if (!ULID_PATTERN.test(body)) return undefined;
  let time = 0;
  for (let i = 0; i < ENCODED_TIME_LENGTH; i++) {
    const digit = ALPHABET.indexOf(body[i]!);
    if (digit < 0) return undefined;
    time = time * 32 + digit;
  }
  return time;
}
