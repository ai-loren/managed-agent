/**
 * Built-in tools.
 *
 * A small, deliberately boring set: read, write, list, search, and run a
 * command. Everything else an agent needs arrives as a skill or an MCP server,
 * because the built-ins are the part with direct filesystem and process access
 * and that surface should stay small enough to audit.
 *
 * Every path is resolved against the sandbox working directory and checked for
 * escape. The permission engine decides *whether* a tool may run; these
 * functions still assume the arguments are hostile, because the model producing
 * them is not the user.
 */

import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

import { MaError, systemClock, validationError, type Clock } from '@ma/core';

import { confineCommand, proxyEnvFrom } from './confine.ts';
import type { Tool, ToolContext, ToolResult } from './tools.ts';

/**
 * Resolve a path inside the sandbox, refusing anything that escapes.
 *
 * `..` traversal and absolute paths are rejected rather than clamped: silently
 * rewriting a path the model asked for produces confusing behaviour, and an
 * explicit refusal tells it to try something else.
 *
 * This is the *lexical* half only. It cannot see symlinks — `link/secret` is a
 * perfectly clean relative path — so callers must use `safeRealPath` below,
 * which resolves the link and re-checks. An agent can create a symlink itself
 * (`ln -s /etc etc` has no metacharacters), and skill archives unpacked into the
 * workspace are a second source, so string checking alone is not containment.
 */
function safePath(workDir: string, requested: string): string {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw validationError('A path is required');
  }
  if (isAbsolute(requested)) {
    throw validationError('Absolute paths are not allowed; use a path relative to the workspace');
  }
  const resolved = resolve(workDir, requested);
  const rel = relative(workDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw validationError('Path escapes the sandbox working directory');
  }
  return resolved;
}

/** True when `candidate` is `root` or sits beneath it. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a path and follow every symlink, refusing anything that lands outside.
 *
 * For a write, the target may not exist yet, so the nearest existing ancestor is
 * resolved instead — creating a file inside a directory that is itself a link
 * out of the workspace is the same escape.
 *
 * The workspace root is resolved too: on macOS `/tmp` is a link to `/private/tmp`,
 * so comparing an unresolved root against a resolved path would reject
 * everything.
 */
async function safeRealPath(
  workDir: string,
  requested: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const lexical = safePath(workDir, requested);
  const root = await realpath(workDir);

  try {
    const real = await realpath(lexical);
    if (!isInside(root, real)) {
      throw validationError('Path resolves outside the sandbox working directory');
    }
    return real;
  } catch (error) {
    if (MaError.is(error)) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (options.mustExist) throw error;
  }

  // `realpath` threw ENOENT, which has two causes: the path does not exist at
  // all, or its final component IS a symlink whose target does not exist (a
  // dangling link). The ancestor walk only checks directories, so it would treat
  // the leaf as a plain not-yet-created file and hand back the lexical path — and
  // a write through it follows the link, creating the file at the link's target,
  // outside the sandbox. So if the leaf is a symlink, resolve its (possibly
  // non-existent) target and re-check THAT lands inside root, via the same
  // nearest-existing-ancestor walk (which resolves a symlinked ancestor and the
  // /tmp -> /private/tmp root aliasing) used for any non-existent path.
  const leafIsSymlink = await lstat(lexical).then(
    (info) => info.isSymbolicLink(),
    () => false, // ENOENT: the leaf truly does not exist — fall through to the ancestor walk.
  );
  const toResolve = leafIsSymlink ? resolve(dirname(lexical), await readlink(lexical)) : lexical;
  return resolveNonExistent(root, toResolve);
}

/**
 * Validate a path that does not (fully) exist by resolving its nearest existing
 * ancestor and confirming it sits inside `root`. Used for a write target that is
 * not yet created and for a dangling symlink's target, so neither can be aimed
 * through a directory that links out of the sandbox.
 */
async function resolveNonExistent(root: string, target: string): Promise<string> {
  let ancestor = dirname(target);
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor);
      if (!isInside(root, realAncestor)) {
        throw validationError('Path resolves outside the sandbox working directory');
      }
      // Re-anchor onto the resolved ancestor so the returned path is real.
      return join(realAncestor, relative(ancestor, target));
    } catch (error) {
      if (MaError.is(error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw validationError('Path escapes the sandbox working directory');
      }
      ancestor = parent;
    }
  }
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      maxBytes: { type: 'integer', description: 'Maximum bytes to read', default: 262_144 },
    },
    required: ['path'],
  },
  async execute(args, context): Promise<ToolResult> {
    const path = await safeRealPath(context.workDir, String(args.path ?? ''), { mustExist: true });
    const maxBytes = Number(args.maxBytes ?? 262_144);

    const info = await stat(path);
    if (!info.isFile()) return { output: `Not a file: ${String(args.path)}`, isError: true };

    const content = await readFile(path, 'utf8');
    if (content.length > maxBytes) {
      return {
        output: `${content.slice(0, maxBytes)}\n… [truncated at ${maxBytes} bytes]`,
        truncated: true,
      };
    }
    return { output: content };
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write a UTF-8 text file in the workspace, creating directories as needed.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(args, context): Promise<ToolResult> {
    const path = await safeRealPath(context.workDir, String(args.path ?? ''));
    const content = String(args.content ?? '');

    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');

    return {
      output: `Wrote ${content.length} bytes to ${String(args.path)}`,
      artifacts: [{ path: String(args.path), sizeBytes: Buffer.byteLength(content, 'utf8') }],
    };
  },
};

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List the entries of a directory in the workspace.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory relative to the workspace root', default: '.' },
    },
  },
  async execute(args, context): Promise<ToolResult> {
    const path = await safeRealPath(context.workDir, String(args.path ?? '.'), { mustExist: true });
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length === 0) return { output: '(empty directory)' };

    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`);
    return { output: lines.join('\n') };
  },
};

export interface SearchToolOptions {
  /**
   * Wall-clock ceiling for one search. A model-controlled regex can backtrack
   * for effectively unbounded time; past this the worker is terminated and the
   * tool returns a timeout rather than wedging.
   */
  timeoutMs?: number;
  /** Injected so a test can drive the timeout without waiting for it. */
  clock?: Clock;
}

/**
 * Search workspace files for a regular expression.
 *
 * The pattern comes from the model, so it is hostile: `(a+)+$` against a long
 * non-matching line backtracks catastrophically. A synchronous `RegExp.test` on
 * the main thread would block the event loop — the turn-deadline timer and the
 * abort signal could never fire, wedging the whole agent-core process. So the
 * match runs in a worker (`search-worker.ts`) that is terminated on a timeout or
 * an interrupt, the same containment the shell tool gives a runaway command.
 */
export function createSearchTool(options: SearchToolOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const clock = options.clock ?? systemClock;

  return {
    name: 'search',
    description: 'Search workspace files for a regular expression.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', default: '.' },
        maxResults: { type: 'integer', default: 100 },
      },
      required: ['pattern'],
    },
    async execute(args, context): Promise<ToolResult> {
      const root = await safeRealPath(context.workDir, String(args.path ?? '.'), { mustExist: true });
      const maxResults = Number(args.maxResults ?? 100);
      const patternText = String(args.pattern ?? '');

      // Validate on the main thread: an invalid pattern is a fast, cheap error
      // that needs no worker, and the worker assumes a valid pattern.
      try {
        new RegExp(patternText, 'g');
      } catch (error) {
        return { output: `Invalid pattern: ${(error as Error).message}`, isError: true };
      }

      // Already interrupted before we start — don't spawn a worker to abandon it.
      if (context.signal.aborted) {
        return { output: 'Search was interrupted.', isError: true };
      }

      const worker = new Worker(new URL('./search-worker.ts', import.meta.url), {
        workerData: { root, workDir: context.workDir, pattern: patternText, maxResults },
      });

      const deadline = new AbortController();
      return await new Promise<ToolResult>((resolvePromise) => {
        let settled = false;
        const finish = (result: ToolResult): void => {
          if (settled) return;
          settled = true;
          deadline.abort();
          context.signal.removeEventListener('abort', onAbort);
          // Terminate unconditionally: on the message path the worker has already
          // exited (a no-op), on the timeout/abort path this is the kill that
          // stops a runaway regex.
          void worker.terminate();
          resolvePromise(result);
        };

        // The timeout that makes a catastrophic pattern survivable. A synchronous
        // regex cannot be interrupted in-thread, so the only cure is to kill the
        // thread — which `terminate()` in `finish` does.
        void clock.sleep(timeoutMs, deadline.signal).then(
          () =>
            finish({
              output: `Search timed out after ${timeoutMs}ms (the pattern may be too expensive).`,
              isError: true,
            }),
          () => {
            // Aborted because the search finished first.
          },
        );

        const onAbort = (): void => finish({ output: 'Search was interrupted.', isError: true });
        context.signal.addEventListener('abort', onAbort, { once: true });

        worker.on('message', (message: { ok: boolean; output?: { matches: string[]; truncated: boolean }; error?: string }) => {
          if (message.ok && message.output) {
            const { matches, truncated } = message.output;
            if (matches.length === 0) finish({ output: 'No matches.' });
            else finish({ output: matches.join('\n'), truncated });
          } else {
            finish({ output: `Search failed: ${message.error ?? 'unknown error'}`, isError: true });
          }
        });

        worker.on('error', (error: Error) => {
          finish({ output: `Search failed: ${error.message}`, isError: true });
        });
      });
    },
  };
}

/** The default search tool, with production timeouts. */
export const searchTool: Tool = createSearchTool();

export interface ShellToolOptions {
  /** Wall-clock ceiling for one command. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Injected so a test can drive the timeout without waiting for it. */
  clock?: Clock;
  /**
   * Extra environment for the command, on top of the minimal `{PATH,HOME}`.
   * Used to expose credential file *paths* (`MA_CRED_<NAME>_FILE`) — never a
   * secret value — so a command can read a granted credential from disk.
   */
  env?: Record<string, string>;
}

/**
 * Run a single command.
 *
 * Deliberately **not** through a shell: `spawn` with an argument array means
 * there is no shell to inject into, so the permission engine's view of the
 * command is the command that actually runs. (The engine separately refuses
 * anything containing shell metacharacters, so the two agree.)
 */
export function createShellTool(options: ShellToolOptions = {}): Tool {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 100_000;
  const clock = options.clock ?? systemClock;

  return {
    name: 'bash',
    description:
      'Run a single command in the workspace. Shell operators (|, &&, ;, redirection) are not supported; run one command at a time.',
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command and its arguments' },
        timeoutMs: { type: 'integer', description: 'Override the default timeout' },
      },
      required: ['command'],
    },
    execute(args, context): Promise<ToolResult> {
      const command = String(args.command ?? '').trim();
      if (command.length === 0) throw validationError('A command is required');

      const parts = tokenize(command);
      const executable = parts[0];
      if (!executable) throw validationError('A command is required');

      const limit = Math.min(Number(args.timeoutMs ?? timeoutMs), timeoutMs);
      return runProcess(executable, parts.slice(1), context, limit, maxOutputBytes, clock, options.env ?? {});
    },
  };
}

/**
 * Split a command into arguments, honouring quotes.
 *
 * Not a shell parser — it handles quoting so that `git commit -m "a message"`
 * works, and nothing else. Anything more exotic was already refused by the
 * permission engine.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ' ' || char === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function runProcess(
  executable: string,
  args: string[],
  context: ToolContext,
  timeoutMs: number,
  maxOutputBytes: number,
  clock: Clock,
  extraEnv: Record<string, string> = {},
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const confined = confineCommand(executable, args);
    const child = spawn(confined.executable, confined.args, {
      cwd: context.workDir,
      // Minimal base plus caller-supplied non-secret vars (credential file
      // paths). A secret value is never placed here — only a path to a file the
      // sandbox already wrote.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: context.workDir, ...proxyEnvFrom(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const append = (target: 'out' | 'err', chunk: string): void => {
      const total = stdout.length + stderr.length;
      if (total >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - total;
      const slice = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (slice.length < chunk.length) truncated = true;
      if (target === 'out') stdout += slice;
      else stderr += slice;
      context.emit(slice, target === 'out' ? 'stdout' : 'stderr');
    };

    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk.toString('utf8')));

    const deadline = new AbortController();
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      deadline.abort();
      context.signal.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };

    void clock.sleep(timeoutMs, deadline.signal).then(
      () => {
        child.kill('SIGKILL');
        finish({
          output: `Command timed out after ${timeoutMs}ms.\n${stdout}${stderr}`,
          isError: true,
          truncated,
        });
      },
      () => {
        // Aborted because the command finished first.
      },
    );

    // An interrupted turn must not leave a command running in the sandbox.
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({ output: 'Command was interrupted.', isError: true });
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) => {
      finish({ output: `Failed to start '${executable}': ${error.message}`, isError: true });
    });

    child.once('close', (code) => {
      const body = [stdout, stderr].filter((part) => part.length > 0).join('\n');
      finish({
        output: code === 0 ? body || '(no output)' : `Exit code ${code ?? 'null'}\n${body}`,
        isError: code !== 0,
        truncated,
      });
    });
  });
}

/** The default tool set for a sandboxed agent. */
export function builtinTools(shell: ShellToolOptions = {}): Tool[] {
  return [readFileTool, writeFileTool, listDirectoryTool, searchTool, createShellTool(shell)];
}
