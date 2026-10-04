/**
 * Files an agent hands back: whatever it leaves in `outputs/` when a turn
 * ends, stored as artifacts of its session.
 *
 * Collected here rather than by a tool, so a file arrives however it was made
 * — `write_file`, a shell command, a script — and before the turn is reported
 * ended, so whoever waits for the end finds the files already stored. A file
 * that cannot be stored is reported, never dropped in silence: the person
 * expecting it would not otherwise know to ask.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '@ma/core';

/** Where an agent leaves files for the person, relative to its working directory. */
export const OUTPUTS_DIR = 'outputs';

/** Files one turn stores at most. */
export const MAX_OUTPUTS_PER_TURN = 50;

/** How long one turn's files may take to store, all together. */
export const OUTPUTS_BUDGET_MS = 120_000;

/** How deep `outputs/` is walked. */
const MAX_DEPTH = 8;

/** A file as the control plane stored it. */
export interface StoredOutput {
  artifactId: string;
  digest: string;
  sizeBytes: number;
  contentType: string;
}

export type OutputResult =
  | { path: string; stored: StoredOutput }
  | { path: string; sizeBytes: number; failure: string };

/** What each path last was when it was stored, so an unchanged file is not sent again. */
export type StoredOutputs = Map<string, { sizeBytes: number; modifiedMs: number; digest: string }>;

/** What the agent is told, in its system prompt, about handing files back. */
export function outputsNote(maxBytes: number): string {
  return (
    `To hand the person a file, put it in the ${OUTPUTS_DIR}/ directory of your working directory. ` +
    `Whatever is there when your turn ends is delivered to them: at most ${MAX_OUTPUTS_PER_TURN} files a turn, ` +
    `each at most ${formatSize(maxBytes)}. Names starting with a dot are not delivered.`
  );
}

/**
 * Store the files in `outputs/` that are new or changed since `stored`
 * recorded them, recording each one stored. Paths are relative to `outputs/`.
 */
export async function publishOutputs(
  workDir: string,
  stored: StoredOutputs,
  store: (path: string, bytes: Uint8Array, signal: AbortSignal) => Promise<StoredOutput>,
  maxBytes: number,
  logger: Logger,
  signal: AbortSignal,
): Promise<OutputResult[]> {
  const changed = (await listFiles(join(workDir, OUTPUTS_DIR))).filter((file) => {
    const last = stored.get(file.path);
    return last?.sizeBytes !== file.sizeBytes || last.modifiedMs !== file.modifiedMs;
  });
  const results: OutputResult[] = [];
  let sent = 0;
  for (const [index, file] of changed.entries()) {
    // The files left are not recorded, so a later turn stores them if they
    // are still there; they are reported together, not one event each.
    if (sent === MAX_OUTPUTS_PER_TURN || signal.aborted) {
      const left = changed.slice(index);
      const names = `${left.slice(0, 5).map((rest) => rest.path).join(', ')}${left.length > 5 ? ', …' : ''}`;
      results.push({
        path: `${OUTPUTS_DIR}/`,
        sizeBytes: left.reduce((total, rest) => total + rest.sizeBytes, 0),
        failure: signal.aborted
          ? `storing this turn's files ran out of time with ${left.length} left (${names}); they are tried again when a later turn ends`
          : `${left.length} more files changed this turn than the ${MAX_OUTPUTS_PER_TURN} a turn stores (${names}); ` +
            'they are stored when a later turn ends. Fewer files, such as one archive, arrive at once.',
      });
      break;
    }
    if (file.sizeBytes > maxBytes) {
      // Recorded, so the same refusal is not repeated every turn.
      stored.set(file.path, { sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs, digest: '' });
      results.push({ path: file.path, sizeBytes: file.sizeBytes, failure: tooLarge(file.sizeBytes, maxBytes) });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(file.full));
    } catch (error) {
      results.push({ path: file.path, sizeBytes: file.sizeBytes, failure: `it could not be read (${reasonOf(error)})` });
      continue;
    }
    if (bytes.byteLength > maxBytes) {
      results.push({ path: file.path, sizeBytes: bytes.byteLength, failure: tooLarge(bytes.byteLength, maxBytes) });
      continue;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (stored.get(file.path)?.digest === digest) {
      stored.set(file.path, { sizeBytes: bytes.byteLength, modifiedMs: file.modifiedMs, digest });
      continue;
    }
    sent++;
    try {
      const output = await store(file.path, bytes, signal);
      stored.set(file.path, { sizeBytes: bytes.byteLength, modifiedMs: file.modifiedMs, digest });
      results.push({ path: file.path, stored: output });
    } catch (error) {
      logger.warn('could not store an output file', { path: file.path, error });
      results.push({ path: file.path, sizeBytes: bytes.byteLength, failure: `it could not be stored (${reasonOf(error)})` });
    }
  }
  return results;
}

async function listFiles(root: string): Promise<{ path: string; full: string; sizeBytes: number; modifiedMs: number }[]> {
  // A link in place of the directory would hand over whatever it points at.
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) return [];
  const found: { path: string; full: string; sizeBytes: number; modifiedMs: number }[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      // Hidden files are a tool's or an editor's, not the agent's answer.
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // An entry's type is its own, not its target's: a link is neither a
      // directory nor a file here, so one naming something outside the
      // working directory is never followed.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, path, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => undefined);
        if (info) found.push({ path, full, sizeBytes: info.size, modifiedMs: info.mtimeMs });
      }
    }
  };
  await walk(root, '', 0);
  return found;
}

function tooLarge(sizeBytes: number, maxBytes: number): string {
  return `it is ${formatSize(sizeBytes)}, more than the ${formatSize(maxBytes)} a file may be (MA_ARTIFACT_MAX_MB); compress or split it`;
}

/** The control plane's own words when it refused, else the error's message. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const body = message.indexOf('{');
  if (body >= 0) {
    try {
      const parsed = JSON.parse(message.slice(body)) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
    } catch {
      // Not a JSON answer; the message itself is the reason.
    }
  }
  return message.slice(0, 300);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
