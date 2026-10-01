/**
 * Record batches (message format v2, Kafka 0.11+), as a Fetch returns them.
 *
 * The consumer reads `read_committed`, so the broker stops at the last stable
 * offset and lists the aborted transactions in range; skipping a batch from an
 * aborted producer, and every control batch, is the client's job. Done the way
 * the Java client does it, because an agent woken by an aborted write acts on
 * an event that never happened.
 */

import { crc32c } from './crc32c.ts';
import { CODECS, decompress } from './compression.ts';
import { KafkaProtocolError, Reader } from './wire.ts';

export interface KafkaRecord {
  offset: number;
  timestamp: number;
  key: Buffer | null;
  value: Buffer | null;
  headers: Record<string, string>;
}

export interface AbortedTransaction {
  producerId: bigint;
  firstOffset: number;
}

export interface DecodedRecords {
  /** Deliverable records at or past the fetch offset, in offset order. */
  records: KafkaRecord[];
  /** Where the next fetch starts: past the last complete batch, skipped ones included. */
  nextOffset: number;
}

export interface DecodedBatch {
  /** The position after this batch, gaps and skipped records included. */
  next: number;
  /**
   * Its deliverable records at or past the fetch offset, decompressed and
   * decoded only as they are read: a fetch of small records can inflate to
   * millions of them, and only as many as are handed out need to exist.
   * Empty for a batch the consumer skips. Reading throws a KafkaProtocolError
   * when the batch's contents are malformed.
   */
  records: () => Iterator<KafkaRecord>;
}

export interface DecodedFetch {
  batches: DecodedBatch[];
  /** Where the next fetch starts: past the last complete batch, skipped ones included. */
  nextOffset: number;
  /** Complete batches the response held; a batch cut off at the size limit is not counted. */
  complete: number;
}

/** The most one batch may inflate to. */
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 61;
const CONTROL_ABORT = 0;

/** Every deliverable record at once; for callers that hold a small fetch whole. */
export function decodeRecords(
  data: Buffer,
  fetchOffset: number,
  aborted: readonly AbortedTransaction[],
): DecodedRecords {
  const decoded = decodeBatches(data, fetchOffset, aborted);
  const records: KafkaRecord[] = [];
  for (const batch of decoded.batches) {
    const iterator = batch.records();
    for (let step = iterator.next(); !step.done; step = iterator.next()) records.push(step.value);
  }
  return { records, nextOffset: decoded.nextOffset };
}

/**
 * The batches of a fetch response, checked (length, format, CRC) and sorted
 * into delivered and skipped at once, with their records left to be read.
 */
export function decodeBatches(
  data: Buffer,
  fetchOffset: number,
  aborted: readonly AbortedTransaction[],
): DecodedFetch {
  const pendingAborts = [...aborted].sort((a, b) => a.firstOffset - b.firstOffset);
  const abortedProducers = new Set<bigint>();
  const batches: DecodedBatch[] = [];
  let nextOffset = fetchOffset;
  let complete = 0;
  let position = 0;

  // A fetch may end in the middle of a batch (it is cut at the size limit);
  // the partial tail is simply read again by the next fetch.
  while (data.length - position >= 12) {
    const baseOffset = Number(data.readBigInt64BE(position));
    const length = data.readInt32BE(position + 8);
    if (length < HEADER_BYTES - 12) {
      throw new KafkaProtocolError(`the record batch at offset ${baseOffset} declares a length of ${length} bytes`);
    }
    if (data.length - position - 12 < length) break;
    const batch = data.subarray(position, position + 12 + length);
    position += 12 + length;

    const magic = batch.readInt8(16);
    if (magic !== 2) {
      throw new KafkaProtocolError(
        `offset ${baseOffset} is in message format v${magic} (written before Kafka 0.11), which this consumer does not read`,
      );
    }
    const crc = batch.readUInt32BE(17);
    if (crc32c(batch.subarray(21)) !== crc) {
      throw new KafkaProtocolError(`the record batch at offset ${baseOffset} fails its CRC check`);
    }
    const attributes = batch.readInt16BE(21);
    const lastOffset = baseOffset + batch.readInt32BE(23);
    const baseTimestamp = Number(batch.readBigInt64BE(27));
    const maxTimestamp = Number(batch.readBigInt64BE(35));
    const producerId = batch.readBigInt64BE(43);
    const count = batch.readInt32BE(57);
    const transactional = (attributes & 0x10) !== 0;
    const control = (attributes & 0x20) !== 0;
    complete++;
    nextOffset = Math.max(nextOffset, lastOffset + 1);
    const next = lastOffset + 1;

    while (pendingAborts.length > 0 && pendingAborts[0]!.firstOffset <= lastOffset) {
      abortedProducers.add(pendingAborts.shift()!.producerId);
    }
    if (control) {
      if (transactional && controlType(batch) === CONTROL_ABORT) abortedProducers.delete(producerId);
      batches.push({ next, records: none });
      continue;
    }
    if (transactional && abortedProducers.has(producerId)) {
      batches.push({ next, records: none });
      continue;
    }

    const codec = attributes & 0x07;
    if (codec >= CODECS.length) {
      throw new KafkaProtocolError(`the record batch at offset ${baseOffset} uses compression codec ${codec}`);
    }
    const logAppendTime = (attributes & 0x08) !== 0;
    batches.push({
      next,
      records: function* () {
        const reader = new Reader(decompress(codec, batch.subarray(HEADER_BYTES), MAX_BATCH_BYTES));
        for (let index = 0; index < count; index++) {
          const record = readRecord(reader, baseOffset, baseTimestamp);
          if (logAppendTime) record.timestamp = maxTimestamp;
          if (record.offset >= fetchOffset) yield record;
        }
      },
    });
  }
  return { batches, nextOffset, complete };
}

function none(): Iterator<KafkaRecord> {
  return [][Symbol.iterator]();
}

function readRecord(reader: Reader, baseOffset: number, baseTimestamp: number): KafkaRecord {
  const length = reader.varint();
  const body = new Reader(reader.take(length));
  body.int8();
  const timestamp = baseTimestamp + body.varint();
  const offset = baseOffset + body.varint();
  const keyLength = body.varint();
  const key = keyLength < 0 ? null : body.take(keyLength);
  const valueLength = body.varint();
  const value = valueLength < 0 ? null : body.take(valueLength);
  const headers: Record<string, string> = {};
  const headerCount = body.varint();
  for (let index = 0; index < headerCount; index++) {
    const name = body.take(body.varint()).toString('utf8');
    const valueBytes = body.varint();
    headers[name] = valueBytes < 0 ? '' : body.take(valueBytes).toString('utf8');
  }
  return { offset, timestamp, key, value, headers };
}

/** A control batch's marker type, from its first record's key (`version int16, type int16`). */
function controlType(batch: Buffer): number {
  const reader = new Reader(batch.subarray(HEADER_BYTES));
  const record = readRecord(reader, 0, 0);
  if (!record.key || record.key.length < 4) throw new KafkaProtocolError('a control record has no marker');
  return record.key.readInt16BE(2);
}
