/**
 * CLI framework: argument parsing, output formatting, and the mutation
 * discipline.
 *
 * The discipline is the point. Every command that changes something follows
 * **plan → confirm → one attempt → readback**:
 *
 *  - Without `--yes`, the command prints exactly what it would do and exits.
 *    A destructive operation should never be one typo away.
 *  - With `--yes`, it makes **one** attempt. An ambiguous failure is reported
 *    as ambiguous rather than retried, because a retried create is how one
 *    session becomes two.
 *  - After a successful write it reads the resource back, so the output is
 *    what the server actually stored rather than what we hoped it would.
 */

import { MaError } from '@ma/core';

export interface ParsedArgs {
  /** Positional arguments, e.g. `['agent', 'create']`. */
  positional: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Parse `--flag value`, `--flag=value`, `--bool`, and `-f`.
 *
 * Everything after a bare `--` is positional, which is how a prompt containing
 * something that looks like a flag gets through intact.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let literal = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;

    if (literal) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      // A following token that itself looks like a flag means this one is a
      // boolean, not a flag whose value happens to start with `--`.
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(body, next);
        index++;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      flags.set(token.slice(1), true);
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

export interface CommandContext {
  args: ParsedArgs;
  /** Structured output requested with `--json`. */
  json: boolean;
  /** The user confirmed with `--yes`. */
  confirmed: boolean;
  out(text: string): void;
  err(text: string): void;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  /** True when the command changes state and needs the mutation discipline. */
  mutates?: boolean;
  run(context: CommandContext): Promise<number>;
}

// --- output ----------------------------------------------------------------

/** Render a value as a table when it is tabular, or as key/value lines. */
export function formatTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no results)';

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => display(row[column]).length)),
  );

  const header = columns.map((column, index) => column.toUpperCase().padEnd(widths[index]!)).join('  ');
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = rows.map((row) =>
    columns.map((column, index) => display(row[column]).padEnd(widths[index]!)).join('  '),
  );

  return [header, separator, ...body].join('\n');
}

export function formatDetail(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  const width = Math.max(...keys.map((key) => key.length));
  return keys.map((key) => `${key.padEnd(width)}  ${display(value[key])}`).join('\n');
}

function display(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' && value > 1_600_000_000_000 && value < 4_000_000_000_000) {
    // Anything in this range is an epoch-millisecond timestamp; a raw number
    // there is unreadable.
    return new Date(value).toISOString();
  }
  return String(value);
}

// --- the mutation discipline -----------------------------------------------

export interface Plan {
  /** What the command will do, in one line. */
  action: string;
  /** The resource being changed. */
  target: string;
  /** Fields that will be written. Secrets must already be redacted. */
  changes: Record<string, unknown>;
  /** Consequences a reader should see before confirming. */
  warnings?: string[];
}

/**
 * Print the plan and decide whether to proceed.
 *
 * Returns `false` when the caller has not confirmed, in which case the command
 * must exit without writing anything.
 */
export function reviewPlan(context: CommandContext, plan: Plan): boolean {
  if (context.json) {
    context.out(JSON.stringify({ plan, applied: context.confirmed }, null, 2));
  } else {
    context.out(`Plan: ${plan.action}`);
    context.out(`Target: ${plan.target}`);
    if (Object.keys(plan.changes).length > 0) {
      context.out('');
      context.out(formatDetail(plan.changes));
    }
    for (const warning of plan.warnings ?? []) {
      context.out('');
      context.out(`! ${warning}`);
    }
    if (!context.confirmed) {
      context.out('');
      context.out('Nothing was changed. Re-run with --yes to apply.');
    }
  }
  return context.confirmed;
}

/**
 * Report a mutation whose outcome is unknown.
 *
 * A request that failed after being sent may or may not have been applied.
 * Retrying it automatically is how a duplicate is created, so the CLI stops and
 * tells the operator what to check instead.
 */
export function reportAmbiguous(context: CommandContext, error: MaError, target: string): number {
  context.err(`The request to ${target} failed and its outcome is unknown.`);
  context.err(`  ${error.code}: ${error.message}`);
  context.err('');
  context.err('This was NOT retried, because the change may already have been applied.');
  context.err(`Check the current state before trying again.`);
  return 1;
}

/** Turn an error into an exit code, with a message a human can act on. */
export function reportError(context: CommandContext, error: unknown): number {
  const failure = MaError.from(error);

  if (context.json) {
    context.err(JSON.stringify({ error: failure.toJSON() }, null, 2));
  } else {
    context.err(`Error [${failure.code}]: ${failure.message}`);
    const issues = failure.details.issues as { path: string; message: string }[] | undefined;
    for (const issue of issues ?? []) {
      context.err(`  ${issue.path || '(root)'}: ${issue.message}`);
    }
    if (failure.retryAfterSeconds !== undefined) {
      context.err(`  Retry after ${failure.retryAfterSeconds}s.`);
    }
  }

  // Distinct exit codes so a script can branch: 2 for "you asked wrongly",
  // 3 for "not allowed", 4 for "try later", 1 for everything else.
  switch (failure.category) {
    case 'validation':
    case 'not_found':
      return 2;
    case 'permission':
    case 'unauthenticated':
      return 3;
    case 'quota':
    case 'unavailable':
    case 'timeout':
      return 4;
    default:
      return 1;
  }
}
