/**
 * CLI tests.
 *
 * The mutation discipline is what these exist for. A command that quietly
 * applies a change without `--yes`, or that retries an ambiguous write, is the
 * failure this whole design is built to prevent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MaError } from '@ma/core';

import {
  formatTable,
  parseArgs,
  reportAmbiguous,
  reportError,
  reviewPlan,
  type CommandContext,
} from '../src/index.ts';

/** A context that records what would have been printed. */
function context(overrides: Partial<CommandContext> = {}): CommandContext & {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    args: parseArgs([]),
    json: false,
    confirmed: false,
    out: (text: string) => void stdout.push(text),
    err: (text: string) => void stderr.push(text),
    stdout,
    stderr,
    ...overrides,
  } as CommandContext & { stdout: string[]; stderr: string[] };
}

describe('argument parsing', () => {
  test('handles the flag forms a user actually types', () => {
    const args = parseArgs(['agent', 'create', '--name', 'Bot', '--yes', '--limit=10', '-j']);
    assert.deepEqual(args.positional, ['agent', 'create']);
    assert.equal(args.flags.get('name'), 'Bot');
    assert.equal(args.flags.get('yes'), true);
    assert.equal(args.flags.get('limit'), '10');
    assert.equal(args.flags.get('j'), true);
  });

  test('treats a flag followed by another flag as a boolean', () => {
    const args = parseArgs(['--json', '--limit', '5']);
    assert.equal(args.flags.get('json'), true);
    assert.equal(args.flags.get('limit'), '5');
  });

  test('everything after -- is positional', () => {
    // So a prompt containing something flag-shaped survives intact.
    const args = parseArgs(['session', 'send', '--', '--not-a-flag', 'text']);
    assert.deepEqual(args.positional, ['session', 'send', '--not-a-flag', 'text']);
  });
});

describe('the mutation discipline', () => {
  test('without --yes it prints a plan and reports not confirmed', () => {
    const ctx = context({ confirmed: false });
    const proceed = reviewPlan(ctx, {
      action: 'Delete everything',
      target: 'ws_1',
      changes: { scope: 'all' },
    });

    assert.equal(proceed, false, 'a destructive command must not be one typo away');
    assert.ok(ctx.stdout.join('\n').includes('Nothing was changed'));
  });

  test('with --yes it proceeds', () => {
    const ctx = context({ confirmed: true });
    assert.equal(reviewPlan(ctx, { action: 'Create', target: 'x', changes: {} }), true);
  });

  test('warnings are shown before the user decides', () => {
    const ctx = context({ confirmed: false });
    reviewPlan(ctx, {
      action: 'Terminate',
      target: 'sn_1',
      changes: {},
      warnings: ['This is irreversible.'],
    });
    assert.ok(ctx.stdout.join('\n').includes('This is irreversible.'));
  });

  test('an ambiguous write is reported, never retried', () => {
    // The request may already have been applied; retrying would duplicate it.
    const ctx = context();
    const code = reportAmbiguous(
      ctx,
      new MaError({ code: 'TIMEOUT', category: 'timeout', message: 'timed out' }),
      'create a session',
    );

    assert.equal(code, 1);
    const output = ctx.stderr.join('\n');
    assert.ok(output.includes('NOT retried'));
    assert.ok(output.includes('outcome is unknown'));
  });
});

describe('error reporting', () => {
  test('maps error categories to distinct exit codes', () => {
    // So a script can branch on what went wrong.
    const cases: [MaError['category'], number][] = [
      ['validation', 2],
      ['not_found', 2],
      ['permission', 3],
      ['unauthenticated', 3],
      ['quota', 4],
      ['unavailable', 4],
      ['internal', 1],
    ];

    for (const [category, expected] of cases) {
      const code = reportError(context(), new MaError({ code: 'X', category, message: 'm' }));
      assert.equal(code, expected, `${category} should exit ${expected}`);
    }
  });

  test('lists every validation issue rather than the first', () => {
    const ctx = context();
    reportError(
      ctx,
      new MaError({
        code: 'VALIDATION_FAILED',
        category: 'validation',
        message: 'failed',
        details: {
          issues: [
            { path: 'name', message: 'is required' },
            { path: 'slug', message: 'must match' },
          ],
        },
      }),
    );

    const output = ctx.stderr.join('\n');
    assert.ok(output.includes('name'));
    assert.ok(output.includes('slug'));
  });

  test('emits structured output when --json is set', () => {
    const ctx = context({ json: true });
    reportError(ctx, new MaError({ code: 'NOT_FOUND', category: 'not_found', message: 'gone' }));
    const parsed = JSON.parse(ctx.stderr.join('\n')) as { error: { code: string } };
    assert.equal(parsed.error.code, 'NOT_FOUND');
  });
});

describe('table formatting', () => {
  test('renders rows with aligned headers', () => {
    const output = formatTable([
      { id: 'ws_1', name: 'Platform' },
      { id: 'ws_2', name: 'Team' },
    ]);
    assert.ok(output.includes('ID'));
    assert.ok(output.includes('NAME'));
    assert.ok(output.includes('Platform'));
  });

  test('says so when there is nothing to show', () => {
    assert.ok(formatTable([]).includes('no results'));
  });

  test('renders a timestamp as a date rather than a bare number', () => {
    const output = formatTable([{ createdAt: 1_700_000_000_000 }]);
    assert.ok(output.includes('2023-11-'), 'a raw epoch is unreadable');
  });
});
