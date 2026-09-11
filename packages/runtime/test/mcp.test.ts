/**
 * MCP stdio client — launch, handshake, list, call, and supervise.
 *
 * Driven against a real fake stdio server (a small node fixture) rather than a
 * mock, because the JSON-RPC framing and subprocess lifecycle are exactly where
 * a mock would agree with whatever the code does and tell us nothing.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { nullLogger, systemClock } from '@ma/core';

import {
  McpStdioConnection,
  McpSupervisor,
  createMcpTools,
  mcpToolName,
  resolveCredentialRefs,
} from '../src/mcp.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs');

function toolContext(): { signal: AbortSignal } & Record<string, unknown> {
  return {
    sessionId: 'sn_test',
    workspaceId: 'ws_test',
    turn: 1,
    workDir: '/tmp',
    signal: new AbortController().signal,
    emit: () => {},
  };
}

describe('MCP stdio connection', () => {
  const open: McpStdioConnection[] = [];
  afterEach(() => {
    for (const c of open) c.close();
    open.length = 0;
  });

  test('launches, lists and calls a tool over JSON-RPC', async () => {
    const connection = await McpStdioConnection.launch(
      { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
      systemClock,
      nullLogger,
    );
    open.push(connection);

    const tools = await createMcpTools(connection);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, mcpToolName('fake', 'echo'), 'tools are namespaced mcp__server__tool');

    const result = await tools[0]!.execute({ text: 'hi' }, toolContext() as never);
    assert.equal(result.output, 'echo: hi');
    assert.ok(!result.isError);
  });

  test('a tool name never collides with a shell classification', async () => {
    // mcp__fake__echo contains no bare `run`/`exec`/`bash`, so the permission
    // engine cannot misread it as a shell command.
    assert.equal(mcpToolName('fake', 'run'), 'mcp__fake__run');
    assert.doesNotMatch(mcpToolName('fake', 'run'), /^(bash|shell|exec|run|command)$/);
  });

  test('a crashed server yields an error result, not a hang', async () => {
    const connection = await McpStdioConnection.launch(
      { name: 'fake', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
      systemClock,
      nullLogger,
    );
    open.push(connection);
    const tools = await createMcpTools(connection);
    connection.close(); // kill the server before the call

    const result = await tools[0]!.execute({ text: 'hi' }, toolContext() as never);
    assert.ok(result.isError, 'a call to a dead server fails cleanly');
  });
});

describe('MCP supervisor', () => {
  test('launches enabled stdio servers and skips disabled ones', async () => {
    const supervisor = new McpSupervisor(systemClock, nullLogger);
    try {
      const tools = await supervisor.start(
        [
          { name: 'up', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
          { name: 'off', transport: 'stdio', command: process.execPath, args: [FIXTURE], enabled: false },
        ],
        () => Promise.resolve('unused'),
      );
      assert.equal(tools.length, 1, 'only the enabled server contributes tools');
      assert.equal(tools[0]?.name, mcpToolName('up', 'echo'));
    } finally {
      supervisor.stop();
    }
  });

  test('one failing server does not sink the others', async () => {
    const supervisor = new McpSupervisor(systemClock, nullLogger);
    try {
      const tools = await supervisor.start(
        [
          { name: 'broken', transport: 'stdio', command: process.execPath, args: ['/does/not/exist.mjs'] },
          { name: 'good', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
        ],
        () => Promise.resolve('unused'),
      );
      assert.equal(tools.length, 1, 'the good server still contributes');
      assert.equal(tools[0]?.name, mcpToolName('good', 'echo'));
    } finally {
      supervisor.stop();
    }
  });
});

describe('MCP credential-ref env resolution', () => {
  test('exchanges a ${cred:...} reference and passes literals through', async () => {
    const resolved = await resolveCredentialRefs(
      { TOKEN: '${cred:cr_abc123}', PLAIN: 'literal' },
      (id) => Promise.resolve(`value-of-${id}`),
    );
    assert.equal(resolved.TOKEN, 'value-of-cr_abc123');
    assert.equal(resolved.PLAIN, 'literal');
  });
});
