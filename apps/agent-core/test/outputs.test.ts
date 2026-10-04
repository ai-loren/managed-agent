/**
 * Files an agent leaves in `outputs/`: which are sent, which are not and why,
 * and what is never sent twice.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, nullLogger } from '@ma/core';

import { MAX_OUTPUTS_PER_TURN, outputsNote, publishOutputs, type StoredOutput, type StoredOutputs } from '../src/outputs.ts';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ma-outputs-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function put(path: string, content: string | Uint8Array): Promise<void> {
  const full = join(workDir, 'outputs', path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

/** A control plane that stores whatever it is sent, and remembers it. */
function plane(refuse?: (path: string) => Error | undefined): {
  store: (path: string, bytes: Uint8Array, signal: AbortSignal) => Promise<StoredOutput>;
  sent: Map<string, string>;
} {
  const sent = new Map<string, string>();
  let next = 0;
  return {
    sent,
    store: (path, bytes) => {
      const refusal = refuse?.(path);
      if (refusal) return Promise.reject(refusal);
      sent.set(path, Buffer.from(bytes).toString('utf8'));
      const digest = createHash('sha256').update(bytes).digest('hex');
      return Promise.resolve({ artifactId: `ar_${++next}`, digest, sizeBytes: bytes.byteLength, contentType: 'text/plain; charset=utf-8' });
    },
  };
}

const open = (): AbortSignal => new AbortController().signal;

describe('what is sent', () => {
  test('every file under outputs/, nested or not, by its path there, in order', async () => {
    await put('report.md', '# Q3');
    await put('charts/north.csv', 'n,1');
    await put('charts/2026/south.csv', 's,2');
    const { store, sent } = plane();
    const results = await publishOutputs(workDir, new Map(), store, 1024, nullLogger, open());
    assert.deepEqual(
      results.map((result) => ('stored' in result ? [result.path, result.stored.artifactId] : [result.path, result.failure])),
      [
        ['charts/2026/south.csv', 'ar_1'],
        ['charts/north.csv', 'ar_2'],
        ['report.md', 'ar_3'],
      ],
    );
    assert.equal(sent.get('report.md'), '# Q3');
  });

  test('outputs/ is walked eight directories deep, no deeper', async () => {
    await put('a/b/c/d/e/f/g/h/eight.txt', '8');
    await put('a/b/c/d/e/f/g/h/i/nine.txt', '9');
    const { store, sent } = plane();
    await publishOutputs(workDir, new Map(), store, 1024, nullLogger, open());
    assert.deepEqual([...sent.keys()], ['a/b/c/d/e/f/g/h/eight.txt']);
  });

  test('nothing is sent when the agent left nothing, or outputs/ is not a directory', async () => {
    const { store, sent } = plane();
    assert.deepEqual(await publishOutputs(workDir, new Map(), store, 1024, nullLogger, open()), []);
    await writeFile(join(workDir, 'outputs'), 'a file, not a directory');
    assert.deepEqual(await publishOutputs(workDir, new Map(), store, 1024, nullLogger, open()), []);
    assert.equal(sent.size, 0);
  });

  test('hidden files and links are not sent, nor is a link standing in for outputs/', async () => {
    await put('.DS_Store', 'junk');
    await put('.cache/state.json', '{}');
    await put('kept.txt', 'yes');
    await writeFile(join(workDir, 'secret.txt'), 'outside outputs');
    await symlink(join(workDir, 'secret.txt'), join(workDir, 'outputs', 'link.txt'));
    const { store, sent } = plane();
    await publishOutputs(workDir, new Map(), store, 1024, nullLogger, open());
    assert.deepEqual([...sent.keys()], ['kept.txt']);

    await rm(join(workDir, 'outputs'), { recursive: true });
    await mkdir(join(workDir, 'elsewhere'));
    await writeFile(join(workDir, 'elsewhere', 'private.txt'), 'not for the person');
    await symlink(join(workDir, 'elsewhere'), join(workDir, 'outputs'));
    sent.clear();
    assert.deepEqual(await publishOutputs(workDir, new Map(), store, 1024, nullLogger, open()), []);
    assert.equal(sent.size, 0);
  });
});

describe('what is not sent twice', () => {
  test('an unchanged file is not sent again; a changed one is', async () => {
    await put('report.md', 'first');
    await put('notes.txt', 'same');
    const stored: StoredOutputs = new Map();
    const { store, sent } = plane();
    await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    sent.clear();

    await put('report.md', 'second, longer');
    assert.deepEqual(
      (await publishOutputs(workDir, stored, store, 1024, nullLogger, open())).map((result) => result.path),
      ['report.md'],
    );
    assert.deepEqual([...sent.entries()], [['report.md', 'second, longer']]);
  });

  test('an unchanged file is not even read again', async () => {
    await put('report.md', 'kept');
    const stored: StoredOutputs = new Map();
    const { store } = plane();
    await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    await chmod(join(workDir, 'outputs', 'report.md'), 0o000);
    try {
      assert.deepEqual(await publishOutputs(workDir, stored, store, 1024, nullLogger, open()), []);
    } finally {
      await chmod(join(workDir, 'outputs', 'report.md'), 0o644);
    }
  });

  test('a file touched but not changed is not sent again', async () => {
    await put('report.md', 'unchanged');
    const stored: StoredOutputs = new Map();
    const { store, sent } = plane();
    await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    sent.clear();
    const later = new Date(Date.now() + 60_000);
    await utimes(join(workDir, 'outputs', 'report.md'), later, later);
    assert.deepEqual(await publishOutputs(workDir, stored, store, 1024, nullLogger, open()), []);
    assert.equal(sent.size, 0);
  });
});

describe('what is reported instead', () => {
  test('a file over the limit is refused before it is read, once', async () => {
    await put('big.bin', new Uint8Array(2048));
    await put('small.txt', 'fits');
    const stored: StoredOutputs = new Map();
    const { store, sent } = plane();
    const first = await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    assert.deepEqual(first[0], {
      path: 'big.bin',
      sizeBytes: 2048,
      failure: 'it is 2.0 KB, more than the 1.0 KB a file may be (MA_ARTIFACT_MAX_MB); compress or split it',
    });
    assert.deepEqual([...sent.keys()], ['small.txt']);
    assert.deepEqual(await publishOutputs(workDir, stored, store, 1024, nullLogger, open()), [], 'not reported again');
  });

  test('a file that grows past the limit after it was listed is refused, not sent', async () => {
    await put('a.txt', 'first');
    await put('b.txt', 'small');
    const sent: string[] = [];
    const results = await publishOutputs(
      workDir,
      new Map(),
      async (path, bytes) => {
        sent.push(path);
        if (path === 'a.txt') await writeFile(join(workDir, 'outputs', 'b.txt'), new Uint8Array(2048));
        return { artifactId: `ar_${sent.length}`, digest: '', sizeBytes: bytes.byteLength, contentType: 'text/plain' };
      },
      1024,
      nullLogger,
      open(),
    );
    assert.deepEqual(sent, ['a.txt']);
    assert.deepEqual(results[1], {
      path: 'b.txt',
      sizeBytes: 2048,
      failure: 'it is 2.0 KB, more than the 1.0 KB a file may be (MA_ARTIFACT_MAX_MB); compress or split it',
    });
  });

  test("a store that fails is reported in the control plane's words, and tried again next turn", async () => {
    await put('report.md', 'content');
    const stored: StoredOutputs = new Map();
    let refusing = true;
    const { store, sent } = plane(() =>
      refusing
        ? new MaError({
            code: 'CONTROL_PLANE_ERROR',
            category: 'quota',
            message: 'POST /artifacts answered 429: {"error":{"code":"QUOTA_EXCEEDED","message":"This workspace has used its 1 MB of artifact storage"}}',
          })
        : undefined,
    );
    const [failure] = await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    assert.deepEqual(failure, {
      path: 'report.md',
      sizeBytes: 7,
      failure: 'it could not be stored (This workspace has used its 1 MB of artifact storage)',
    });
    refusing = false;
    await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    assert.deepEqual([...sent.keys()], ['report.md']);
  });

  test(`a turn stores at most ${MAX_OUTPUTS_PER_TURN} files, says so once, and leaves the rest for the next`, async () => {
    for (let index = 0; index < MAX_OUTPUTS_PER_TURN + 7; index++) await put(`file-${String(index).padStart(3, '0')}.txt`, `#${index}`);
    const stored: StoredOutputs = new Map();
    const { store, sent } = plane();
    const results = await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    assert.equal(sent.size, MAX_OUTPUTS_PER_TURN);
    const summary = results.at(-1)!;
    assert.equal(results.length, MAX_OUTPUTS_PER_TURN + 1);
    assert.equal(summary.path, 'outputs/');
    assert.ok('failure' in summary && summary.failure.startsWith(`7 more files changed this turn than the ${MAX_OUTPUTS_PER_TURN} a turn stores (file-050.txt, file-051.txt`), JSON.stringify(summary));
    assert.equal(summary.sizeBytes, 7 * 3);

    const next = await publishOutputs(workDir, stored, store, 1024, nullLogger, open());
    assert.deepEqual(next.map((result) => result.path), ['file-050.txt', 'file-051.txt', 'file-052.txt', 'file-053.txt', 'file-054.txt', 'file-055.txt', 'file-056.txt']);
  });

  test('a turn out of time says so once, for every file left', async () => {
    await put('a.txt', 'a');
    await put('b.txt', 'b');
    await put('c.txt', 'c');
    const budget = new AbortController();
    const { sent } = plane();
    const results = await publishOutputs(
      workDir,
      new Map(),
      (path, bytes) => {
        budget.abort();
        sent.set(path, Buffer.from(bytes).toString('utf8'));
        return Promise.resolve({ artifactId: 'ar_1', digest: '', sizeBytes: bytes.byteLength, contentType: 'text/plain' });
      },
      1024,
      nullLogger,
      budget.signal,
    );
    assert.deepEqual([...sent.keys()], ['a.txt']);
    assert.deepEqual(results.at(-1), {
      path: 'outputs/',
      sizeBytes: 2,
      failure: "storing this turn's files ran out of time with 2 left (b.txt, c.txt); they are tried again when a later turn ends",
    });
    assert.equal(results.length, 2);
  });
});

test('the agent is told where to leave files, and the limits', () => {
  assert.equal(
    outputsNote(25 * 1024 * 1024),
    'To hand the person a file, put it in the outputs/ directory of your working directory. Whatever is there when your turn ends ' +
      `is delivered to them: at most ${MAX_OUTPUTS_PER_TURN} files a turn, each at most 25.0 MB. Names starting with a dot are not delivered.`,
  );
});
