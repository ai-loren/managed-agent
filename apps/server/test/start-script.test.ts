/**
 * scripts/start.sh tests.
 *
 * The launcher decides what reaches the server: which secrets, which bind
 * address, which database. `--dry-run` prints that resolved environment (secret
 * values masked) and exits, so these drive the real script without starting a
 * server; `MA_START_ENV_FILE` points it at a fixture instead of the developer's
 * own `.env.demo`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, '../../../scripts/start.sh');

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ma-start-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function envFile(name: string, lines: string[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string; vars: Map<string, string> } {
  // Bounded: a regression that starts a real server instead of exiting would
  // otherwise block this synchronous call (and the whole test runner) forever.
  const result = spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, MA_START_ENV_FILE: join(dir, 'absent'), ...env },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGTERM',
  });
  const vars = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) vars.set(line.slice(0, at), line.slice(at + 1));
  }
  return { code: result.status ?? -1, out: result.stdout, err: result.stderr, vars };
}

describe('start.sh', () => {
  test('--prod takes only model settings from .env.demo, never its admin token or bind address', async () => {
    const file = await envFile('prod.env', [
      'MA_BOOTSTRAP_TOKEN=demo-admin-token',
      'MA_HOST=0.0.0.0',
      'MA_DATABASE=:memory:',
      'MA_OPENROUTER_API_KEY=sk-or-from-file',
      'MA_OPENROUTER_MODEL=a/b:free',
    ]);
    const { code, vars } = run(['--prod', '--dry-run'], { MA_START_ENV_FILE: file });
    assert.equal(code, 0);
    assert.equal(vars.get('mode'), 'prod');
    assert.equal(vars.has('MA_BOOTSTRAP_TOKEN'), false, 'the published demo token never reaches the production server');
    assert.equal(vars.get('MA_HOST'), '127.0.0.1');
    assert.equal(vars.get('MA_DATABASE'), './data/managed-agent.db');
    assert.equal(vars.get('MA_OPENROUTER_API_KEY'), '<set>', 'the model key is passed on, and masked in the output');
    assert.equal(vars.get('MA_OPENROUTER_MODELS'), 'a/b:free');
  });

  test('flags beat the environment, which beats .env.demo', async () => {
    const file = await envFile('demo.env', ['MA_PORT=9999', 'MA_HOST=0.0.0.0', 'MA_DATABASE=./data/demo.db']);
    const { code, vars } = run(['--dry-run', '--host', '127.0.0.1'], { MA_START_ENV_FILE: file, MA_DATABASE: ':memory:' });
    assert.equal(code, 0);
    assert.equal(vars.get('MA_HOST'), '127.0.0.1', 'the flag wins');
    assert.equal(vars.get('MA_DATABASE'), ':memory:', 'the ambient environment wins over the file');
    assert.equal(vars.get('MA_PORT'), '9999', 'the file still supplies what nothing else set');
  });

  test('.env.demo is read as data: it cannot run code or reset the launcher', async () => {
    const marker = join(dir, 'pwned');
    const file = await envFile('hostile.env', ['MODE=prod', 'HOST=0.0.0.0', `MA_LOG_LEVEL=$(touch ${marker})`, 'export MA_PORT=7777']);
    const { code, vars } = run(['--dry-run'], { MA_START_ENV_FILE: file });
    assert.equal(code, 0);
    assert.equal(existsSync(marker), false, 'no command substitution ran');
    assert.equal(vars.get('mode'), 'demo', 'a non-MA_ key cannot change the launcher');
    assert.equal(vars.get('MA_HOST'), '127.0.0.1');
    assert.equal(vars.get('MA_PORT'), '7777', 'an `export ` prefix is tolerated');
  });

  test('a secret passed on the command line is refused, and not echoed back', () => {
    for (const [flag, replacement] of [['--openrouter-key', '--openrouter-key-file'], ['-k', '--openrouter-key-file'], ['--token', '--token-file'], ['-t', '--token-file']]) {
      const { code, err } = run([flag!, 'sk-or-SECRETVALUE']);
      assert.equal(code, 2, `${flag} is refused`);
      assert.match(err, new RegExp(replacement!));
      assert.match(err, /ps/, 'says why: argv is visible to other processes');
      assert.doesNotMatch(err, /SECRETVALUE/);
    }
  });

  test('secrets come from files, passed to the server by path', async () => {
    const key = await envFile('key', ['sk-or-in-a-file']);
    const token = await envFile('token', ['a-long-random-token-value-0123456789']);
    const { code, vars, out } = run(['--prod', '--dry-run', '--openrouter-key-file', key, '--token-file', token]);
    assert.equal(code, 0);
    assert.equal(vars.get('MA_OPENROUTER_API_KEY_FILE'), key);
    assert.equal(vars.get('MA_BOOTSTRAP_TOKEN_FILE'), token);
    assert.doesNotMatch(out, /sk-or-in-a-file|a-long-random-token/);
  });

  test('the `--` pnpm forwards is skipped, and -h is --host as documented', () => {
    const forwarded = run(['--', '--prod', '--dry-run']);
    assert.equal(forwarded.code, 0, '`pnpm start -- --prod` starts the production server');
    assert.equal(forwarded.vars.get('mode'), 'prod');
    const host = run(['-h', '0.0.0.0', '--dry-run']);
    assert.equal(host.vars.get('MA_HOST'), '0.0.0.0');
  });

  test('an unknown flag is an error, not a silent help screen', () => {
    for (const flag of ['-x', '--foreground', '--bogus']) {
      const { code, err } = run([flag]);
      assert.equal(code, 2, `${flag} exits 2`);
      assert.match(err, /unknown option/);
    }
    assert.equal(run(['--help']).code, 0);
  });
});
