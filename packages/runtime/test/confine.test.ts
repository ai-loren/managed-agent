/**
 * Confining a sandbox's subprocesses (the local driver's egress enforcement).
 *
 * The wrapping is checked everywhere; whether it actually holds is checked
 * against the real OS mechanism where this host has it — Seatbelt on macOS, an
 * unprivileged network namespace on Linux — and skipped, saying why, where it
 * does not.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { confineCommand, createShellTool, proxyEnvFrom, type ToolContext } from '../src/index.ts';

describe('confineCommand', () => {
  test('passes a command through untouched when nothing is set', () => {
    assert.deepEqual(confineCommand('curl', ['-s', 'x'], undefined), { executable: 'curl', args: ['-s', 'x'] });
    assert.deepEqual(confineCommand('curl', [], ''), { executable: 'curl', args: [] });
  });

  test('runs it under sandbox-exec with the profile it was given', () => {
    assert.deepEqual(confineCommand('curl', ['x'], 'seatbelt:(version 1)(deny network*)'), {
      executable: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1)(deny network*)', 'curl', 'x'],
    });
  });

  test('runs it in a fresh network namespace', () => {
    assert.deepEqual(confineCommand('curl', ['x'], 'netns'), {
      executable: 'unshare',
      args: ['--net', '--map-root-user', '--', 'curl', 'x'],
    });
  });

  test('refuses a value it does not know, naming what it expects', () => {
    assert.throws(() => confineCommand('curl', [], 'firejail'), /MA_EGRESS_CONFINE must be 'seatbelt:<profile>' or 'netns', got "firejail"/);
  });
});

test('proxyEnvFrom passes on the proxy settings, in both casings, and nothing else', () => {
  assert.deepEqual(
    proxyEnvFrom({ HTTPS_PROXY: 'http://p:1', no_proxy: 'localhost', MA_RUNTIME_TOKEN: 'secret', HTTP_PROXY: '' }),
    { HTTPS_PROXY: 'http://p:1', no_proxy: 'localhost' },
  );
});

test('a shell tool sees the proxy its sandbox was given, and still not the runtime token', async () => {
  const saved = { proxy: process.env.HTTPS_PROXY, token: process.env.MA_RUNTIME_TOKEN };
  process.env.HTTPS_PROXY = 'http://proxy.test:3128';
  process.env.MA_RUNTIME_TOKEN = 'never-for-tools';
  try {
    const result = await createShellTool().execute({ command: 'env' }, context);
    assert.match(result.output, /^HTTPS_PROXY=http:\/\/proxy\.test:3128$/m);
    assert.doesNotMatch(result.output, /never-for-tools/);
  } finally {
    if (saved.proxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved.proxy;
    if (saved.token === undefined) delete process.env.MA_RUNTIME_TOKEN;
    else process.env.MA_RUNTIME_TOKEN = saved.token;
  }
});

// --- the real mechanisms ---------------------------------------------------

const servers: Server[] = [];
const dir = mkdtempSync(join(tmpdir(), 'ma-confine-'));
after(() => {
  for (const server of servers) server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function serve(body: string): Promise<number> {
  const server = createServer((_request, response) => response.end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

const context: ToolContext = {
  sessionId: 'sn_confine',
  workspaceId: 'ws_confine',
  turn: 1,
  workDir: dir,
  signal: new AbortController().signal,
  emit: () => {},
};

async function bash(command: string, confine: string): Promise<{ output: string; isError: boolean }> {
  const previous = process.env.MA_EGRESS_CONFINE;
  process.env.MA_EGRESS_CONFINE = confine;
  try {
    const result = await createShellTool().execute({ command }, context);
    return { output: result.output, isError: result.isError === true };
  } finally {
    if (previous === undefined) delete process.env.MA_EGRESS_CONFINE;
    else process.env.MA_EGRESS_CONFINE = previous;
  }
}

const seatbelt = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
const netns = process.platform === 'linux' && spawnSync('unshare', ['--net', '--map-root-user', 'true']).status === 0;

describe('a confined shell tool under Seatbelt', { skip: seatbelt ? false : 'needs macOS sandbox-exec' }, () => {
  test('reaches the one loopback port its profile opens, and nothing else', async () => {
    const open = await serve('open-port');
    const closed = await serve('closed-port');
    const profile = `seatbelt:(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:${open}"))`;

    const allowed = await bash(`curl -s -m 5 http://127.0.0.1:${open}/`, profile);
    assert.equal(allowed.output.trim(), 'open-port');
    const refused = await bash(`curl -s -m 5 http://127.0.0.1:${closed}/`, profile);
    assert.equal(refused.isError, true);
    assert.doesNotMatch(refused.output, /closed-port/);
    const external = await bash('curl -s -m 5 https://example.com/', profile);
    assert.equal(external.isError, true, 'no route off the host, not even a name lookup');
  });
});

describe('a confined shell tool in a network namespace', { skip: netns ? false : 'needs unprivileged user namespaces on Linux' }, () => {
  test('reaches nothing on the host', async () => {
    const port = await serve('host-service');
    const refused = await bash(`curl -s -m 5 http://127.0.0.1:${port}/`, 'netns');
    assert.equal(refused.isError, true);
    assert.doesNotMatch(refused.output, /host-service/);
  });
});
