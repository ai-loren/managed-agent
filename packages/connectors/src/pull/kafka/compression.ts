/**
 * Decompressing record batches.
 *
 * A topic holds whatever codec each producer chose, so a consumer that cannot
 * read one of them stalls on the first such batch. gzip and zstd come with
 * Node; snappy (raw, or in the xerial framing the Java client writes) and the
 * LZ4 frame format are small enough to decode here.
 *
 * Every decoder is bounded by `limit`: a batch is producer-controlled bytes,
 * and a few KB of zeros can claim gigabytes once inflated.
 */

import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import { KafkaProtocolError } from './wire.ts';

export const CODECS = ['none', 'gzip', 'snappy', 'lz4', 'zstd'] as const;

export function decompress(codec: number, data: Buffer, limit: number): Buffer {
  switch (codec) {
    case 0:
      return data;
    case 1:
      return inflate(() => gunzipSync(data, { maxOutputLength: limit }), 'gzip', limit);
    case 2:
      return snappy(data, limit);
    case 3:
      return lz4(data, limit);
    case 4:
      return inflate(() => zstdDecompressSync(data, { maxOutputLength: limit }), 'zstd', limit);
    default:
      throw new KafkaProtocolError(`a record batch uses compression codec ${codec}, which Kafka does not define`);
  }
}

function inflate(run: () => Buffer, codec: string, limit: number): Buffer {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new KafkaProtocolError(`a ${codec} record batch inflates past ${limit} bytes`);
    }
    throw new KafkaProtocolError(`a ${codec} record batch does not decompress: ${(error as Error).message}`);
  }
}

const XERIAL_MAGIC = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]);

/** Snappy: the xerial stream framing (16-byte header, then length-prefixed blocks) or one raw block. */
export function snappy(data: Buffer, limit: number): Buffer {
  if (data.length < 16 || !data.subarray(0, 8).equals(XERIAL_MAGIC)) return snappyBlock(data, limit);
  const blocks: Buffer[] = [];
  let total = 0;
  let position = 16;
  while (position < data.length) {
    if (position + 4 > data.length) throw new KafkaProtocolError('a snappy frame is truncated');
    const length = data.readInt32BE(position);
    position += 4;
    if (length < 0 || position + length > data.length) throw new KafkaProtocolError('a snappy frame is truncated');
    const block = snappyBlock(data.subarray(position, position + length), limit - total);
    total += block.length;
    blocks.push(block);
    position += length;
  }
  return Buffer.concat(blocks, total);
}

function snappyBlock(input: Buffer, limit: number): Buffer {
  let position = 0;
  let length = 0;
  let multiplier = 1;
  for (;;) {
    if (position >= input.length || multiplier > 2 ** 28) throw new KafkaProtocolError('a snappy block has a bad length');
    const byte = input[position++]!;
    length += (byte & 0x7f) * multiplier;
    if (byte < 0x80) break;
    multiplier *= 128;
  }
  if (length > limit) throw new KafkaProtocolError(`a snappy record batch inflates past ${limit} bytes`);

  const out = Buffer.allocUnsafe(length);
  let written = 0;
  const fail = (): never => {
    throw new KafkaProtocolError('a snappy block is corrupt');
  };
  while (position < input.length) {
    const tag = input[position++]!;
    if ((tag & 3) === 0) {
      let literal = tag >>> 2;
      if (literal >= 60) {
        const bytes = literal - 59;
        if (position + bytes > input.length) fail();
        literal = input.readUIntLE(position, bytes);
        position += bytes;
      }
      literal += 1;
      if (position + literal > input.length || written + literal > length) fail();
      input.copy(out, written, position, position + literal);
      position += literal;
      written += literal;
      continue;
    }
    let copy: number;
    let distance: number;
    if ((tag & 3) === 1) {
      if (position + 1 > input.length) fail();
      copy = ((tag >>> 2) & 7) + 4;
      distance = ((tag >>> 5) << 8) | input[position++]!;
    } else if ((tag & 3) === 2) {
      if (position + 2 > input.length) fail();
      copy = (tag >>> 2) + 1;
      distance = input.readUInt16LE(position);
      position += 2;
    } else {
      if (position + 4 > input.length) fail();
      copy = (tag >>> 2) + 1;
      distance = input.readUInt32LE(position);
      position += 4;
    }
    if (distance === 0 || distance > written || written + copy > length) fail();
    // Byte by byte: a copy may overlap its own output (a run of one repeated byte).
    for (let index = 0; index < copy; index++) out[written + index] = out[written - distance + index]!;
    written += copy;
  }
  if (written !== length) fail();
  return out;
}

const LZ4_MAGIC = 0x184d2204;

/** The LZ4 frame format (what Kafka's LZ4 codec writes): one or more frames of blocks. */
export function lz4(data: Buffer, limit: number): Buffer {
  const out = new GrowableBuffer(limit);
  let position = 0;
  const need = (bytes: number): void => {
    if (position + bytes > data.length) throw new KafkaProtocolError('an LZ4 frame is truncated');
  };
  while (position < data.length) {
    need(4);
    const magic = data.readUInt32LE(position);
    position += 4;
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      need(4);
      position += 4 + data.readUInt32LE(position);
      continue;
    }
    if (magic !== LZ4_MAGIC) throw new KafkaProtocolError('an LZ4 record batch has no frame header');
    need(3);
    const flags = data[position]!;
    position += 2;
    if (flags >>> 6 !== 1) throw new KafkaProtocolError(`an LZ4 frame has version ${flags >>> 6}; expected 1`);
    const blockChecksum = (flags & 0x10) !== 0;
    if (flags & 0x08) position += 8;
    if (flags & 0x01) position += 4;
    position += 1;
    for (;;) {
      need(4);
      const header = data.readUInt32LE(position);
      position += 4;
      if (header === 0) break;
      const size = header & 0x7fffffff;
      need(size);
      const block = data.subarray(position, position + size);
      position += size;
      if (header & 0x80000000) out.append(block);
      else lz4Block(block, out);
      if (blockChecksum) position += 4;
    }
    if (flags & 0x04) position += 4;
  }
  return out.result();
}

function lz4Block(input: Buffer, out: GrowableBuffer): void {
  let position = 0;
  const fail = (): never => {
    throw new KafkaProtocolError('an LZ4 block is corrupt');
  };
  const extend = (length: number): number => {
    let total = length;
    if (length === 15) {
      let byte: number;
      do {
        if (position >= input.length) fail();
        byte = input[position++]!;
        total += byte;
      } while (byte === 255);
    }
    return total;
  };
  while (position < input.length) {
    const token = input[position++]!;
    const literal = extend(token >>> 4);
    if (position + literal > input.length) fail();
    out.append(input.subarray(position, position + literal));
    position += literal;
    if (position >= input.length) break;
    if (position + 2 > input.length) fail();
    const distance = input.readUInt16LE(position);
    position += 2;
    const match = extend(token & 15) + 4;
    if (distance === 0 || distance > out.length) fail();
    out.copyBack(distance, match);
  }
}

class GrowableBuffer {
  readonly #limit: number;
  #buffer = Buffer.allocUnsafe(64 * 1024);
  length = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    this.#reserve(chunk.length);
    chunk.copy(this.#buffer, this.length);
    this.length += chunk.length;
  }

  /** Copy `count` bytes from `distance` back; may overlap what it writes. */
  copyBack(distance: number, count: number): void {
    this.#reserve(count);
    const buffer = this.#buffer;
    let from = this.length - distance;
    for (let index = 0; index < count; index++) buffer[this.length++] = buffer[from++]!;
  }

  result(): Buffer {
    return this.#buffer.subarray(0, this.length);
  }

  #reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.#limit) throw new KafkaProtocolError(`an LZ4 record batch inflates past ${this.#limit} bytes`);
    if (needed <= this.#buffer.length) return;
    const grown = Buffer.allocUnsafe(Math.min(this.#limit, Math.max(needed, this.#buffer.length * 2)));
    this.#buffer.copy(grown, 0, 0, this.length);
    this.#buffer = grown;
  }
}
