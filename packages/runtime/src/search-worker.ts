/**
 * The regex-search worker.
 *
 * `search` runs a *model-controlled* regular expression, and a catastrophic
 * pattern (e.g. `(a+)+$` against a long non-matching line) backtracks for
 * effectively unbounded time. Run on the main thread that is a denial of
 * service: a synchronous `RegExp.test` blocks the event loop, so neither the
 * turn-deadline timer nor an abort signal can fire — the whole agent-core
 * process wedges and every later turn rejects. So the match runs here, in a
 * worker the caller can `terminate()` on a timeout or an interrupt, exactly as
 * the shell tool SIGKILLs a runaway command. The event loop stays responsive
 * and the ReDoS is contained to a thread that gets killed.
 *
 * The whole walk + read + match runs in the worker, so the expensive part never
 * touches the main thread. Only the results (bounded by `maxResults`) cross back.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface SearchInput {
  root: string;
  workDir: string;
  pattern: string;
  maxResults: number;
}

interface SearchOutput {
  matches: string[];
  truncated: boolean;
}

// Mirrors builtin-tools' walk: the directories a search should never descend
// into. Kept in sync deliberately — the worker is a sibling of that file.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.cache']);

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

async function run(input: SearchInput): Promise<SearchOutput> {
  // `new RegExp` cannot throw here: the caller validated the pattern on the main
  // thread before spawning the worker, so an invalid pattern never reaches this.
  const pattern = new RegExp(input.pattern, 'g');
  const matches: string[] = [];

  await walk(input.root, async (file) => {
    if (matches.length >= input.maxResults) return;
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      // Binary or unreadable files are skipped rather than failing the search.
      return;
    }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && matches.length < input.maxResults; index++) {
      pattern.lastIndex = 0;
      // The line that can block for an unbounded time — but this is a worker, so
      // a blocked thread is a terminated thread, not a wedged process.
      if (pattern.test(lines[index]!)) {
        matches.push(`${relative(input.workDir, file)}:${index + 1}: ${lines[index]!.trim()}`);
      }
    }
  });

  return { matches, truncated: matches.length >= input.maxResults };
}

// `parentPort` is always present when this file is loaded as a worker; the guard
// keeps the module importable (e.g. by a type-checker) without one.
if (parentPort) {
  const port = parentPort;
  run(workerData as SearchInput).then(
    (output) => port.postMessage({ ok: true, output }),
    (error: unknown) => port.postMessage({ ok: false, error: (error as Error).message }),
  );
}
