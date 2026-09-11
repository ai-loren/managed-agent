/**
 * Plugin manifest parsing and launch-as-local-MCP-server.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { nullLogger, systemClock } from '@ma/core';

import { parsePluginManifest } from '../src/plugins.ts';
import { McpSupervisor } from '../src/mcp.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('plugin manifest parsing', () => {
  test('reads command, args, env and allowlist', () => {
    const manifest = parsePluginManifest(
      bytes(JSON.stringify({ name: 'p', version: '1', command: 'node', args: ['server.js'], env: { K: '${cred:cr_x}' }, toolAllowlist: ['echo'] })),
    );
    assert.equal(manifest?.command, 'node');
    assert.deepEqual(manifest?.args, ['server.js']);
    assert.equal(manifest?.env.K, '${cred:cr_x}');
    assert.deepEqual(manifest?.toolAllowlist, ['echo']);
  });

  test('returns undefined when there is no command to run', () => {
    assert.equal(parsePluginManifest(bytes(JSON.stringify({ name: 'p' }))), undefined);
    assert.equal(parsePluginManifest(bytes('not json')), undefined);
  });
});

describe('plugin launch as a local tool-server', () => {
  test('launches the plugin command and proxies its tools as plugin__…', async () => {
    const supervisor = new McpSupervisor(systemClock, nullLogger);
    try {
      const tools = await supervisor.launchPlugin(
        { name: 'mytool', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
        () => Promise.resolve('unused'),
      );
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.name, 'plugin__mytool__echo', 'plugin tools are namespaced plugin__name__tool');
    } finally {
      supervisor.stop();
    }
  });

  test('a plugin that fails to start contributes no tools, without throwing', async () => {
    const supervisor = new McpSupervisor(systemClock, nullLogger);
    try {
      const tools = await supervisor.launchPlugin(
        { name: 'broken', transport: 'stdio', command: process.execPath, args: ['/does/not/exist.mjs'] },
        () => Promise.resolve('unused'),
      );
      assert.deepEqual(tools, []);
    } finally {
      supervisor.stop();
    }
  });
});
