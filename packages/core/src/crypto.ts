/**
 * Cryptographic primitives.
 *
 * Scope is narrow on purpose: envelope encryption for credential values,
 * constant-time comparison, HMAC signatures for webhooks, and token hashing.
 * Anything more exotic belongs behind a KMS, not in this file.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// --- constant-time comparison ---------------------------------------------

/**
 * Compare two strings without leaking their contents through timing.
 *
 * Length is hashed in rather than compared directly: `timingSafeEqual` throws
 * on length mismatch, and branching on that would leak the length of the
 * expected secret. Hashing both sides to a fixed width removes the branch.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// --- hashing ---------------------------------------------------------------

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');
}

/**
 * Deterministically serialize a value to JSON with object keys in sorted order,
 * at every level of nesting.
 *
 * `JSON.stringify` preserves insertion order, so two objects with the same
 * fields written in a different order stringify differently — fine for display,
 * fatal for hashing, where the same logical value must always produce the same
 * bytes. This sorts keys recursively so the output depends only on content, not
 * on how the object was built or round-tripped through a database.
 *
 * Arrays keep their order (it is semantically meaningful); only object keys are
 * reordered. `undefined` fields are dropped, matching `JSON.stringify`. Intended
 * for hash material (e.g. the tamper-evident audit chain), not for
 * human-readable output.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    sorted[key] = canonicalize(source[key]);
  }
  return sorted;
}

/**
 * Hash an API key or bearer token for storage. We store only the hash, so a
 * database leak does not yield usable credentials.
 */
export function hashToken(token: string): string {
  return sha256Hex(token);
}

/** A URL-safe random token. `bytes` of entropy, base64url encoded. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// --- HMAC signatures (webhook verification) --------------------------------

export function hmacSha256Hex(secret: string, payload: string | Uint8Array): string {
  return createHmac('sha256', secret)
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
    .digest('hex');
}

/**
 * Verify a webhook signature over `timestamp.payload`.
 *
 * The timestamp is inside the signed material and separately checked against a
 * tolerance window, so a captured request cannot be replayed indefinitely.
 */
export function verifySignature(options: {
  secret: string;
  payload: string | Uint8Array;
  signature: string;
  timestamp: number;
  now: number;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = (options.toleranceSeconds ?? 300) * 1000;
  const skew = Math.abs(options.now - options.timestamp);
  if (skew > tolerance) return false;
  const body =
    typeof options.payload === 'string' ? options.payload : Buffer.from(options.payload).toString('utf8');
  const expected = hmacSha256Hex(options.secret, `${options.timestamp}.${body}`);
  return safeEqual(expected, options.signature);
}

// --- envelope encryption ---------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the GCM standard
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * A sealed value. `keyVersion` records which KEK sealed it, so keys can be
 * rotated without a migration: new writes use the current key, old reads
 * resolve the historical one.
 */
export interface SealedValue {
  ciphertext: string; // base64: iv || tag || encrypted
  keyVersion: string;
  algorithm: string;
}

/**
 * Supplies key-encryption keys. The local implementation keeps them in memory
 * (loaded from config); a KMS implementation would fetch and cache them.
 */
export interface KeyProvider {
  /** The key new writes should use. */
  currentVersion(): string;
  /** Resolve a 32-byte key by version. Throws for an unknown version. */
  keyFor(version: string): Uint8Array;
}

export class InMemoryKeyProvider implements KeyProvider {
  readonly #keys: Map<string, Uint8Array>;
  readonly #current: string;

  constructor(keys: Record<string, Uint8Array | string>, current: string) {
    this.#keys = new Map(
      Object.entries(keys).map(([version, key]) => [version, normalizeKey(key)]),
    );
    if (!this.#keys.has(current)) {
      throw new Error(`Current key version '${current}' is not present in the key set`);
    }
    this.#current = current;
  }

  /** Generate a provider with one fresh random key. For dev and tests. */
  static generate(version = 'v1'): InMemoryKeyProvider {
    return new InMemoryKeyProvider({ [version]: randomBytes(KEY_LENGTH) }, version);
  }

  currentVersion(): string {
    return this.#current;
  }

  keyFor(version: string): Uint8Array {
    const key = this.#keys.get(version);
    if (!key) throw new Error(`Unknown key version '${version}'`);
    return key;
  }
}

function normalizeKey(key: Uint8Array | string): Uint8Array {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.from(key);
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(`Encryption keys must be ${KEY_LENGTH} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Encrypt a value with AES-256-GCM.
 *
 * `aad` binds the ciphertext to its context — we pass the credential id — so a
 * ciphertext copied onto a different row fails to decrypt rather than silently
 * granting that row the original's secret.
 */
export function seal(plaintext: string, provider: KeyProvider, aad?: string): SealedValue {
  const version = provider.currentVersion();
  const key = provider.keyFor(version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([iv, tag, encrypted]).toString('base64'),
    keyVersion: version,
    algorithm: ALGORITHM,
  };
}

export function unseal(sealed: SealedValue, provider: KeyProvider, aad?: string): string {
  if (sealed.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported algorithm '${sealed.algorithm}'`);
  }
  const raw = Buffer.from(sealed.ciphertext, 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH) throw new Error('Ciphertext is truncated');
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, provider.keyFor(sealed.keyVersion), iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
