/**
 * Skill-contributed tools: a skill's declared entrypoint becomes a namespaced
 * tool that runs as a subprocess.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { systemClock } from '@ma/core';

import { createSkillTools, skillToolName } from '../src/skill-tool.ts';
import { parseSkillTools } from '../src/skills.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function toolContext(workDir: string): { signal: AbortSignal } & Record<string, unknown> {
  return {
    sessionId: 'sn_test',
    workspaceId: 'ws_test',
    turn: 1,
    workDir,
    signal: new AbortController().signal,
    emit: () => {},
  };
}

describe('skill tool spec parsing', () => {
  test('reads a tools array from skill.json', () => {
    const specs = parseSkillTools(
      bytes(JSON.stringify({ tools: [{ name: 'greet', entrypoint: 'bin/greet.sh', description: 'Greets' }] })),
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.name, 'greet');
    assert.equal(specs[0]?.entrypoint, 'bin/greet.sh');
  });

  test('drops entries missing a name or entrypoint, keeps the good ones', () => {
    const specs = parseSkillTools(
      bytes(JSON.stringify({ tools: [{ name: 'ok', entrypoint: 'x' }, { name: 'bad' }, { entrypoint: 'y' }] })),
    );
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.name, 'ok');
  });

  test('returns nothing for malformed json', () => {
    assert.deepEqual(parseSkillTools(bytes('not json')), []);
  });
});

describe('skill tool execution', () => {
  test('runs the entrypoint with the JSON args and returns its output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ma-skill-'));
    const script = join(dir, 'echo.mjs');
    // The entrypoint receives the call args as one JSON string on argv[2].
    await writeFile(script, 'const a = JSON.parse(process.argv[2]); process.stdout.write("hi " + a.who);');

    const [tool] = createSkillTools({
      skillName: 'greeter',
      rootDir: dir,
      specs: [
        { name: 'greet', description: 'Greets', entrypoint: 'echo.mjs', parameters: { type: 'object', properties: {} } },
      ],
      clock: systemClock,
    });
    assert.equal(tool?.name, skillToolName('greeter', 'greet'));

    // Run through node by making the entrypoint the node binary would refuse; so
    // instead invoke node explicitly by pointing the entrypoint at a shell that
    // calls node. Simplest: entrypoint is a node script made executable.
    await chmod(script, 0o755);
    // Prepend a shebang so it runs directly.
    await writeFile(
      script,
      '#!/usr/bin/env node\nconst a = JSON.parse(process.argv[2]); process.stdout.write("hi " + a.who);',
    );
    await chmod(script, 0o755);

    const result = await tool!.execute({ who: 'world' }, toolContext(dir) as never);
    assert.equal(result.output, 'hi world');
    assert.ok(!result.isError);
  });

  test('refuses an entrypoint that escapes the skill dir', () => {
    const dir = '/tmp/skill-x';
    assert.throws(
      () =>
        createSkillTools({
          skillName: 'evil',
          rootDir: dir,
          specs: [{ name: 't', description: '', entrypoint: '../../bin/sh', parameters: {} }],
          clock: systemClock,
        }),
      /escapes the skill dir/,
    );
  });
});
