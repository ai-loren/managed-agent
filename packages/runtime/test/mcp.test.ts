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
import { createServer, type Server } from 'node:http';

import { nullLogger, systemClock } from '@ma/core';

import {
  McpStdioConnection,
  McpHttpConnection,
  McpSupervisor,
  createMcpTools,
  mcpToolName,
  resolveCredentialRefs,
  type McpConnection,
} from '../src/mcp.ts';
import { ToolRegistry } from '../src/tools.ts';

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

  test('does not leak the parent MA_* environment into the server', async () => {
    // A server/plugin is untrusted; it must not inherit MA_RUNTIME_TOKEN et al,
    // or it could exchange every credential the session holds.
    const envFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'env-mcp-server.mjs');
    process.env.MA_RUNTIME_TOKEN = 'secret-token';
    process.env.MA_CONTROL_PLANE_URL = 'http://cp';
    try {
      const connection = await McpStdioConnection.launch(
        { name: 'env', transport: 'stdio', command: process.execPath, args: [envFixture] },
        systemClock,
        nullLogger,
      );
      open.push(connection);
      const tools = await createMcpTools(connection);
      const result = await tools[0]!.execute({}, toolContext() as never);
      assert.equal(result.output, '[]', 'no MA_* var reached the subprocess');
    } finally {
      delete process.env.MA_RUNTIME_TOKEN;
      delete process.env.MA_CONTROL_PLANE_URL;
    }
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

  test('duplicate advertised tool names are deduped, not left to crash registration', async () => {
    // A hostile server can answer tools/list with two descriptors of the same
    // name. Both used to map to one identical namespaced name, and registering
    // the second threw a "already registered" error that crashed session
    // bootstrap — a single bad server permanently wedging the agent, exactly
    // what the MCP contract forbids. createMcpTools must collapse the duplicate
    // so the produced set has unique names.
    const connection: McpConnection = {
      serverName: 'evil',
      listTools: () =>
        Promise.resolve([
          { name: 'echo', description: 'first', inputSchema: { type: 'object' } },
          { name: 'echo', description: 'second (a shadowing duplicate)', inputSchema: { type: 'object' } },
        ]),
      callTool: () => Promise.resolve({ output: 'x' }),
      close: () => {},
    };

    const tools = await createMcpTools(connection);
    const names = tools.map((t) => t.name);
    assert.deepEqual(
      [...new Set(names)],
      names,
      'createMcpTools must not emit two tools with the same namespaced name',
    );
    // And registering the produced set never throws on a duplicate.
    const registry = new ToolRegistry();
    assert.doesNotThrow(() => registry.registerAll(tools));
  });

  test('oversized tool metadata and tool count are capped, not forwarded verbatim', async () => {
    // A single JSON-RPC message under 16 MiB is accepted, but its description /
    // inputSchema and the tool count are then shipped in EVERY model request for
    // the session's life. Uncapped, a ~1 MiB description or tens of thousands of
    // tools is sustained prompt bloat that can brick the session. createMcpTools
    // must bound both, like the sibling skill/tool-result caps.
    const huge = 'A'.repeat(2_000_000);
    // A large-but-cheap-to-build schema: one property whose description is a big
    // string, so JSON.stringify(inputSchema) comfortably exceeds the cap without
    // an O(n^2) object build.
    const hugeSchema: Record<string, unknown> = {
      type: 'object',
      properties: { big: { type: 'string', description: 'x'.repeat(200_000) } },
    };

    const descriptors = [
      { name: 'bloated', description: huge, inputSchema: { type: 'object', properties: {} } },
      { name: 'bigschema', description: 'ok', inputSchema: hugeSchema },
    ];
    // Also far more tools than any real server: name them uniquely.
    for (let i = 0; i < 5000; i++) descriptors.push({ name: `t${i}`, description: 'ok', inputSchema: { type: 'object', properties: {} } });

    const connection: McpConnection = {
      serverName: 'evil',
      listTools: () => Promise.resolve(descriptors),
      callTool: () => Promise.resolve({ output: 'x' }),
      close: () => {},
    };

    const tools = await createMcpTools(connection);
    assert.ok(tools.length <= 256, `tool count must be capped, got ${tools.length}`);
    const bloated = tools.find((t) => t.name.endsWith('__bloated'))!;
    assert.ok(bloated.description.length < 20_000, 'a huge description must be truncated');
    const bigschema = tools.find((t) => t.name.endsWith('__bigschema'))!;
    assert.ok(
      JSON.stringify(bigschema.parameters).length < 40_000,
      'a huge inputSchema must be dropped/bounded, not forwarded verbatim',
    );
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

describe('MCP http connection', () => {
  let server: Server;
  let url: string;

  afterEach(() => {
    server?.close();
  });

  function startServer(handler: (method: string, params: unknown) => unknown): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const msg = JSON.parse(body) as { id: number; method: string; params: unknown };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: handler(msg.method, msg.params) }));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/mcp`;
        resolve();
      });
    });
  }

  test('lists and calls a tool over HTTP', async () => {
    await startServer((method, params) => {
      if (method === 'tools/list') {
        return { tools: [{ name: 'ping', description: 'pings', inputSchema: { type: 'object', properties: {} } }] };
      }
      if (method === 'tools/call') {
        const p = params as { arguments?: { host?: string } };
        return { content: [{ type: 'text', text: `pong ${p.arguments?.host ?? ''}` }] };
      }
      return {};
    });

    const connection = new McpHttpConnection('remote', url);
    const tools = await createMcpTools(connection);
    assert.equal(tools[0]?.name, mcpToolName('remote', 'ping'));

    const result = await tools[0]!.execute({ host: 'x' }, toolContext() as never);
    assert.equal(result.output, 'pong x');
  });

  test('with egress confined, a loopback server’s redirect is not followed', async () => {
    const elsewhere: string[] = [];
    const target = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        elsewhere.push(body);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
      });
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const targetPort = (target.address() as { port: number }).port;
    server = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/mcp` }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const redirecting = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;

    const previous = process.env.MA_EGRESS_CONFINE;
    process.env.MA_EGRESS_CONFINE = 'netns';
    try {
      const connection = new McpHttpConnection('remote', redirecting);
      await assert.rejects(createMcpTools(connection), /answered 307, a redirect to http:\/\/127\.0\.0\.1:\d+ that this sandbox does not follow/);
      assert.deepEqual(elsewhere, []);
    } finally {
      if (previous === undefined) delete process.env.MA_EGRESS_CONFINE;
      else process.env.MA_EGRESS_CONFINE = previous;
      target.close();
    }
  });
});
