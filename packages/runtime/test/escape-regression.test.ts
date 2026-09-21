/**
 * Regression tests for the sandbox's inner boundary: the permission engine and
 * the filesystem tools.
 *
 * These exist because a suite of 525 passing tests did not catch any of them.
 * Every case below is an attack that worked against shipped code, so each test
 * is phrased as the attack rather than as the feature.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError } from '@ma/core';
import type { ToolPolicy } from '@ma/contracts';

import {
  PermissionEngine,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  type Tool,
  type ToolContext,
} from '../src/index.ts';

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    mode: 'auto',
    allow: [],
    deny: [],
    allowedCommands: [],
    deniedCommands: [],
    ...overrides,
  };
}

const bash: Tool = {
  name: 'bash',
  description: 'run a command',
  readOnly: false,
  parameters: { type: 'object', properties: {} },
  execute: () => Promise.resolve({ output: '' }),
};

describe('command permission bypasses', () => {
  test('a non-string command is refused, not coerced', () => {
    // The engine used to read a non-string as "not a shell tool" and skip every
    // command rule, while the tool itself coerced with String(). Two layers
    // disagreeing about a type is the whole exploit: ["env"] became "env".
    const engine = new PermissionEngine(policy({ deniedCommands: ['env'] }));

    for (const value of [['env'], { toString: () => 'env' }, 42, true]) {
      const outcome = engine.evaluate(bash, { command: value });
      assert.equal(outcome.decision, 'deny', `${JSON.stringify(value)} must be refused`);
      assert.equal(outcome.rule, 'command:notAString');
    }
  });

  test('quotes cannot hide a denied command', () => {
    // The shell strips these before the binary ever sees them, so `e"n"v` runs
    // env while matching no rule that spells it plainly.
    const engine = new PermissionEngine(policy({ deniedCommands: ['env', 'git push'] }));

    for (const command of ['e"n"v', "e'n'v", '"env"', 'git  push', 'git\tpush']) {
      const outcome = engine.evaluate(bash, { command });
      assert.equal(outcome.decision, 'deny', `${JSON.stringify(command)} must be refused`);
      // Denied either as an explicit denylist prefix or, for `env`, as a re-exec
      // wrapper — both are correct refusals; what matters is that quoting never
      // let it through.
      assert.match(outcome.rule, /^(denyCommand:|command:wrapper:)/);
    }
  });

  test('a newline cannot smuggle a second command', () => {
    // A newline separates commands exactly as `;` does. This regressed once:
    // normalizing whitespace before the metacharacter check turned the newline
    // into a space, so the check could never see it. The order of those two
    // steps is the fix, which is why the assertion is on the raw string.
    const engine = new PermissionEngine(policy({ deniedCommands: ['rm'] }));

    for (const command of [
      'git status\nrm -rf /',
      'git status\r\nrm -rf /',
      'git status; rm -rf /',
      'git status && rm -rf /',
      'git status | rm -rf /',
      'git status $(rm -rf /)',
      'git status `rm -rf /`',
    ]) {
      const outcome = engine.evaluate(bash, { command });
      assert.equal(outcome.decision, 'deny', `${JSON.stringify(command)} must be refused`);
      assert.equal(outcome.rule, 'command:compound');
    }
  });

  test('an allowlist is not a suggestion in auto mode', () => {
    // `auto` used to short-circuit to allow before the allowlist was consulted,
    // which made configuring one silently pointless.
    const engine = new PermissionEngine(policy({ allowedCommands: ['git'] }));

    assert.equal(engine.evaluate(bash, { command: 'git status' }).decision, 'allow');
    assert.equal(engine.evaluate(bash, { command: 'curl evil.example' }).decision, 'deny');
  });
});

describe('filesystem escapes', () => {
  let workDir: string;
  let outside: string;

  function context(): ToolContext {
    return {
      sessionId: 'ses_01ARZ3ND',
      workspaceId: 'ws_01ARZ3ND',
      turn: 1,
      workDir,
      signal: new AbortController().signal,
      emit: () => {},
    };
  }

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ma-fs-'));
    workDir = join(root, 'workspace');
    outside = join(root, 'outside');
    await mkdir(workDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'HOST SECRET', 'utf8');
  });

  afterEach(async () => {
    await rm(join(workDir, '..'), { recursive: true, force: true });
  });

  /** A tool rejects by throwing; the harness turns that into a model-visible error. */
  async function rejection(run: Promise<unknown>): Promise<MaError> {
    const caught = await run.then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(caught instanceof MaError, 'the tool must refuse');
    return caught;
  }

  test('a symlink cannot be followed out of the workspace', async () => {
    // Path-prefix checks pass here: `link/secret.txt` starts with the work dir.
    // Only resolving the real path catches it, and the check has to resolve the
    // root too — on macOS /tmp is itself a symlink into /private/tmp, so a naive
    // comparison rejects every legitimate path instead.
    await symlink(outside, join(workDir, 'link'));

    const error = await rejection(readFileTool.execute({ path: 'link/secret.txt' }, context()));

    assert.match(error.message, /outside the sandbox/i);
    assert.ok(!error.message.includes('HOST SECRET'));
  });

  test('a symlinked directory cannot be written into', async () => {
    await symlink(outside, join(workDir, 'link'));

    const error = await rejection(
      writeFileTool.execute({ path: 'link/planted.txt', content: 'x' }, context()),
    );

    assert.match(error.message, /outside the sandbox/i);
  });

  test('a write cannot follow a dangling leaf symlink out of the workspace', async () => {
    // The leaf itself is a symlink pointing outside, to a target that does NOT
    // exist yet. safeRealPath resolved only fully-existing targets and existing
    // ancestors, never the final component when it dangled — so realpath(leaf)
    // threw ENOENT, the ancestor walk landed on workDir (inside), and the write
    // went straight through the link, creating an attacker-controlled file
    // outside the sandbox (e.g. ~/.ssh/authorized_keys). This is the exact
    // arbitrary-out-of-sandbox-file-creation the containment check exists to stop.
    const target = join(outside, 'planted-via-leaf.txt');
    await symlink(target, join(workDir, 'link'));

    const error = await rejection(
      writeFileTool.execute({ path: 'link', content: 'ssh-rsa ATTACKER' }, context()),
    );

    assert.match(error.message, /outside the sandbox/i);
    // And nothing was written through the link.
    const leaked = await readFile(target, 'utf8').then(
      (content) => content,
      () => undefined,
    );
    assert.equal(leaked, undefined, 'no file may be created at the outside target');
  });

  test('a traversal path cannot escape', async () => {
    const error = await rejection(
      readFileTool.execute({ path: '../outside/secret.txt' }, context()),
    );

    assert.match(error.message, /escapes the sandbox/i);
  });

  test('ordinary paths inside the workspace still work', async () => {
    // The counterpart that makes the tests above meaningful: a fix that broke
    // legitimate reads would also pass every assertion so far.
    await mkdir(join(workDir, 'nested'), { recursive: true });
    await writeFile(join(workDir, 'nested', 'notes.txt'), 'legitimate', 'utf8');

    const read = await readFileTool.execute({ path: 'nested/notes.txt' }, context());
    assert.ok(!read.isError, read.output);
    assert.match(read.output, /legitimate/);

    // A write to a path that does not exist yet: the check has to walk up to
    // the nearest existing ancestor rather than demanding the target exist.
    const written = await writeFileTool.execute(
      { path: 'nested/new.txt', content: 'fine' },
      context(),
    );
    assert.ok(!written.isError, written.output);

    const listed = await listDirectoryTool.execute({ path: 'nested' }, context());
    assert.ok(!listed.isError, listed.output);
    assert.match(listed.output, /notes\.txt/);
  });

  test('a leaf symlink pointing inside the workspace is still writable', async () => {
    // The counterpart to the dangling-leaf escape: a link whose target is inside
    // the sandbox (even if the target does not exist yet) is legitimate and must
    // not be over-rejected by the leaf-resolution guard.
    await symlink(join(workDir, 'real-target.txt'), join(workDir, 'inside-link'));

    const written = await writeFileTool.execute(
      { path: 'inside-link', content: 'ok' },
      context(),
    );
    assert.ok(!written.isError, written.output);
    // The content landed at the in-sandbox target the link points to.
    const content = await readFile(join(workDir, 'real-target.txt'), 'utf8');
    assert.equal(content, 'ok');
  });
});
