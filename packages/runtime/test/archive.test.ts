/**
 * Archive extraction — the security-critical path for skill/plugin bundles.
 *
 * The path-traversal and symlink refusals are the point: a skill archive is a
 * second source of hostile paths into the workspace (see builtin-tools' safePath
 * note), and this surface never ran under tests before it existed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { sniffArchive, unpackTar, extractArchive } from '../src/archive.ts';

/** Build a minimal ustar tar from {path, content} entries. */
function buildTar(entries: { path: string; content: string; typeflag?: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();

  for (const entry of entries) {
    const data = enc.encode(entry.content);
    const header = new Uint8Array(512);
    const write = (str: string, start: number, len: number) => {
      const b = enc.encode(str);
      header.set(b.subarray(0, len), start);
    };
    write(entry.path, 0, 100);
    write('0000644', 100, 7); // mode
    write('0000000', 108, 7); // uid
    write('0000000', 116, 7); // gid
    write(data.length.toString(8).padStart(11, '0'), 124, 11); // size (octal)
    write('00000000000', 136, 11); // mtime
    header[156] = (entry.typeflag ?? '0').charCodeAt(0);
    write('ustar\0', 257, 6); // magic
    write('00', 263, 2); // version
    // Checksum: spaces first, then compute.
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (const b of header) sum += b;
    write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  // Two zero blocks terminate the archive.
  blocks.push(new Uint8Array(512), new Uint8Array(512));

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

describe('archive sniffing', () => {
  test('recognises gzip and tar by magic bytes', () => {
    const tar = buildTar([{ path: 'SKILL.md', content: 'hi' }]);
    assert.equal(sniffArchive(tar), 'tar');
    assert.equal(sniffArchive(new Uint8Array(gzipSync(Buffer.from(tar)))), 'gzip');
    assert.equal(sniffArchive(new TextEncoder().encode('just text')), 'none');
  });
});

describe('tar unpacking', () => {
  test('reads regular file entries with their content', () => {
    const tar = buildTar([
      { path: 'SKILL.md', content: '# skill' },
      { path: 'scripts/run.sh', content: 'echo hi' },
    ]);
    const entries = unpackTar(tar);
    assert.equal(entries.length, 2);
    assert.equal(new TextDecoder().decode(entries[0]!.bytes), '# skill');
    assert.equal(entries[1]!.path, 'scripts/run.sh');
  });

  test('refuses a symlink entry (typeflag 2)', () => {
    const tar = buildTar([{ path: 'link', content: '/etc/passwd', typeflag: '2' }]);
    assert.throws(() => unpackTar(tar), /link entry/);
  });
});

describe('archive extraction to disk', () => {
  test('writes a gzip-compressed tar tree under the destination', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'ma-arch-'));
    const tar = buildTar([
      { path: 'SKILL.md', content: '# greeter' },
      { path: 'scripts/run.sh', content: 'echo hi' },
    ]);
    const gz = new Uint8Array(gzipSync(Buffer.from(tar)));

    const entries = await extractArchive(gz, dest);
    assert.equal(entries.length, 2);
    assert.equal(await readFile(join(dest, 'SKILL.md'), 'utf8'), '# greeter');
    assert.equal(await readFile(join(dest, 'scripts/run.sh'), 'utf8'), 'echo hi');
  });

  test('refuses a path that escapes the destination', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'ma-arch-'));
    const tar = buildTar([{ path: '../escape.txt', content: 'pwned' }]);
    await assert.rejects(extractArchive(tar, dest), /escapes the archive root/);
  });

  test('refuses an absolute path', async () => {
    const dest = await mkdtemp(join(tmpdir(), 'ma-arch-'));
    const tar = buildTar([{ path: '/etc/cron.d/x', content: 'pwned' }]);
    await assert.rejects(extractArchive(tar, dest), /absolute path/);
  });
});
