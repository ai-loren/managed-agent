/**
 * Kafka's wire primitives: big-endian integers, length-prefixed strings and
 * bytes, int32-counted arrays, and the zigzag varints records use.
 *
 * Only the non-flexible encodings: every API version the consumer speaks
 * predates tagged fields, so there are no compact strings here.
 */

export class KafkaProtocolError extends Error {}

export class Writer {
  readonly #chunks: Buffer[] = [];

  int8(value: number): this {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeInt8(value);
    return this.#push(buffer);
  }

  int16(value: number): this {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeInt16BE(value);
    return this.#push(buffer);
  }

  int32(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value);
    return this.#push(buffer);
  }

  int64(value: number | bigint): this {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigInt64BE(BigInt(value));
    return this.#push(buffer);
  }

  boolean(value: boolean): this {
    return this.int8(value ? 1 : 0);
  }

  string(value: string): this {
    const bytes = Buffer.from(value, 'utf8');
    return this.int16(bytes.length).#push(bytes);
  }

  nullableString(value: string | null): this {
    return value === null ? this.int16(-1) : this.string(value);
  }

  bytes(value: Buffer): this {
    return this.int32(value.length).#push(value);
  }

  array<T>(items: readonly T[], write: (writer: this, item: T) => void): this {
    this.int32(items.length);
    for (const item of items) write(this, item);
    return this;
  }

  /** A nullable array written as null (`-1`). */
  nullArray(): this {
    return this.int32(-1);
  }

  build(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  #push(buffer: Buffer): this {
    this.#chunks.push(buffer);
    return this;
  }
}

export class Reader {
  readonly #buffer: Buffer;
  #offset: number;

  constructor(buffer: Buffer, offset = 0) {
    this.#buffer = buffer;
    this.#offset = offset;
  }

  get remaining(): number {
    return this.#buffer.length - this.#offset;
  }

  int8(): number {
    this.#need(1);
    const value = this.#buffer.readInt8(this.#offset);
    this.#offset += 1;
    return value;
  }

  int16(): number {
    this.#need(2);
    const value = this.#buffer.readInt16BE(this.#offset);
    this.#offset += 2;
    return value;
  }

  int32(): number {
    this.#need(4);
    const value = this.#buffer.readInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }

  int64(): bigint {
    this.#need(8);
    const value = this.#buffer.readBigInt64BE(this.#offset);
    this.#offset += 8;
    return value;
  }

  /** An int64 that is an offset or a timestamp, both far inside a double's exact range. */
  long(): number {
    return Number(this.int64());
  }

  boolean(): boolean {
    return this.int8() !== 0;
  }

  string(): string {
    const value = this.nullableString();
    if (value === null) throw new KafkaProtocolError('expected a string, got null');
    return value;
  }

  nullableString(): string | null {
    const length = this.int16();
    if (length < 0) return null;
    return this.take(length).toString('utf8');
  }

  nullableBytes(): Buffer | null {
    const length = this.int32();
    if (length < 0) return null;
    return this.take(length);
  }

  array<T>(read: (reader: this) => T): T[] {
    const count = this.int32();
    if (count < 0) return [];
    // A count larger than the bytes left cannot be honest; refusing it here
    // keeps a corrupt frame from allocating an array of billions.
    if (count > this.remaining) throw new KafkaProtocolError(`array of ${count} in ${this.remaining} bytes`);
    const items: T[] = [];
    for (let index = 0; index < count; index++) items.push(read(this));
    return items;
  }

  /** Unsigned LEB128. */
  uvarint(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 10; index++) {
      const byte = this.int8() & 0xff;
      value += (byte & 0x7f) * multiplier;
      if (byte < 0x80) return value;
      multiplier *= 128;
    }
    throw new KafkaProtocolError('varint longer than 10 bytes');
  }

  /** Zigzag-encoded signed varint (records' `varint` and `varlong`). */
  varint(): number {
    const raw = this.uvarint();
    return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2;
  }

  take(length: number): Buffer {
    this.#need(length);
    const slice = this.#buffer.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  #need(bytes: number): void {
    if (bytes < 0 || this.#offset + bytes > this.#buffer.length) {
      throw new KafkaProtocolError(`truncated: needed ${bytes} bytes at ${this.#offset} of ${this.#buffer.length}`);
    }
  }
}
