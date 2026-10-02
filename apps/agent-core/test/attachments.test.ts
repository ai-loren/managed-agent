/**
 * Attached files, as a sandbox receives them: what it trusts in an
 * announcement, what it writes, and what the agent is told.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, nullLogger, type Clock } from '@ma/core';

import { deliverAttachments, describeAttachments, parseAttachedFiles, type AttachedFile } from '../src/attachments.ts';

const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function announced(name: string, bytes: Uint8Array, artifactId = `ar_${name.length}${bytes.byteLength}`): AttachedFile {
  return { artifactId, name, digest: digestOf(bytes), sizeBytes: bytes.byteLength, contentType: 'text/plain; charset=utf-8' };
}

/** A clock whose waits pass at once, recording how long each was. */
function recordingClock(): Clock & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    now: () => 0,
    monotonic: () => 0,
    sleep: (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      return signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve();
    },
  };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ma-attachments-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('announcements', () => {
  test('a file named with a path, or announced without a digest, is dropped', () => {
    const good = announced('data.csv', new Uint8Array([1]));
    const files = parseAttachedFiles([
      good,
      { ...good, name: '../escape.csv' },
      { ...good, name: 'nested/file.csv' },
      { ...good, name: 'back\\slash.csv' },
      { ...good, name: '..' },
      { ...good, name: '.' },
      { ...good, name: '' },
      { ...good, name: 'nul\u0000.csv' },
      { ...good, digest: 'not-a-digest' },
      { ...good, sizeBytes: '1' },
      null,
      'data.csv',
    ]);
    assert.deepEqual(files, [good]);
    assert.deepEqual(parseAttachedFiles(undefined), []);
    assert.deepEqual(parseAttachedFiles({ name: 'x' }), []);
  });
});

describe('delivery', () => {
  test('each file is written under attachments/, byte for byte, in order', async () => {
    const csv = new TextEncoder().encode('region,total\nnorth,10\n');
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
    const files = [announced('sales.csv', csv, 'ar_a'), announced('blob.bin', binary, 'ar_b')];
    const contents = new Map([
      ['ar_a', csv],
      ['ar_b', binary],
    ]);

    const deliveries = await deliverAttachments(files, workDir, (id) => Promise.resolve(contents.get(id)!), recordingClock(), nullLogger);

    assert.deepEqual(deliveries.map((delivery) => ('path' in delivery ? delivery.path : delivery.failure)), [
      'attachments/sales.csv',
      'attachments/blob.bin',
    ]);
    assert.deepEqual(new Uint8Array(await readFile(join(workDir, 'attachments/sales.csv'))), csv);
    assert.deepEqual(new Uint8Array(await readFile(join(workDir, 'attachments/blob.bin'))), binary);
  });

  test('a file that arrives with the wrong digest is not written', async () => {
    const file = announced('data.csv', new TextEncoder().encode('expected'));
    const [delivery] = await deliverAttachments(
      [file],
      workDir,
      () => Promise.resolve(new TextEncoder().encode('tampered')),
      recordingClock(),
      nullLogger,
    );
    assert.deepEqual(delivery, { file, failure: 'it arrived damaged, so it was not written' });
    await assert.rejects(readdir(join(workDir, 'attachments')), { code: 'ENOENT' });
  });

  test('a fetch that failed for a passing reason is tried again', async () => {
    const bytes = new TextEncoder().encode('eventually');
    const clock = recordingClock();
    let attempts = 0;
    const deliveries = await deliverAttachments(
      [announced('late.txt', bytes)],
      workDir,
      () => {
        attempts++;
        if (attempts === 1) return Promise.reject(new TypeError('fetch failed'));
        if (attempts === 2) {
          return Promise.reject(new MaError({ code: 'CONTROL_PLANE_ERROR', category: 'unavailable', message: '503', retryable: true }));
        }
        return Promise.resolve(bytes);
      },
      clock,
      nullLogger,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(clock.waits, [500, 2_000]);
    assert.ok('path' in deliveries[0]!);
  });

  test('a refusal is not asked again, and the agent is told why the file is missing', async () => {
    const clock = recordingClock();
    let attempts = 0;
    const file = announced('gone.txt', new Uint8Array([1]));
    const other = announced('kept.txt', new Uint8Array([2]), 'ar_kept');
    const deliveries = await deliverAttachments(
      [file, other],
      workDir,
      (id) => {
        if (id === 'ar_kept') return Promise.resolve(new Uint8Array([2]));
        attempts++;
        return Promise.reject(
          new MaError({
            code: 'CONTROL_PLANE_ERROR',
            category: 'precondition',
            message: 'GET /attachments/ar_x answered 412: content deleted',
            retryable: false,
          }),
        );
      },
      clock,
      nullLogger,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(clock.waits, []);
    assert.deepEqual(deliveries[0], { file, failure: 'it could not be fetched (GET /attachments/ar_x answered 412: content deleted)' });
    assert.ok('path' in deliveries[1]!, 'one missing file does not stop the rest');
  });

  test('a fetch that keeps failing gives up after its retries', async () => {
    const clock = recordingClock();
    let attempts = 0;
    const [delivery] = await deliverAttachments(
      [announced('never.txt', new Uint8Array([1]))],
      workDir,
      () => {
        attempts++;
        return Promise.reject(new TypeError('fetch failed'));
      },
      clock,
      nullLogger,
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delivery && 'failure' in delivery ? delivery.failure : undefined, 'it could not be fetched (fetch failed)');
  });

  test('a delivery stopped midway stops, rather than reporting a missing file', async () => {
    const stop = new AbortController();
    await assert.rejects(
      deliverAttachments(
        [announced('a.txt', new Uint8Array([1])), announced('b.txt', new Uint8Array([2]), 'ar_b')],
        workDir,
        () => {
          stop.abort();
          return Promise.reject(new TypeError('fetch failed'));
        },
        recordingClock(),
        nullLogger,
        stop.signal,
      ),
    );
  });
});

describe('what the agent is told', () => {
  test('where each file is, or why it is not there', () => {
    const csv = announced('sales.csv', new Uint8Array(1536));
    const pdf = { ...announced('report.pdf', new Uint8Array(3 * 1024 * 1024)), contentType: 'application/pdf' };
    const note = describeAttachments([
      { file: csv, path: 'attachments/sales.csv' },
      { file: pdf, failure: 'it could not be fetched (412)' },
      { file: announced('tiny.txt', new Uint8Array(12)), path: 'attachments/tiny.txt' },
    ]);
    assert.equal(
      note,
      [
        'Files attached to this message, relative to the working directory:',
        '- attachments/sales.csv (text/plain; charset=utf-8, 1.5 KB)',
        '- report.pdf: not in the working directory, because it could not be fetched (412)',
        '- attachments/tiny.txt (text/plain; charset=utf-8, 12 bytes)',
      ].join('\n'),
    );
    assert.equal(describeAttachments([]), '');
  });
});
