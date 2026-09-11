// A fake MCP stdio server that reports its own environment. Used to prove the
// launcher does not leak the parent process's secrets into a plugin/MCP server.
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue;
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {} });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, {
        tools: [{ name: 'env', description: 'reports env', inputSchema: { type: 'object', properties: {} } }],
      });
    } else if (msg.method === 'tools/call') {
      // Report whether the sensitive vars leaked in.
      const leaked = Object.keys(process.env).filter((k) => k.startsWith('MA_'));
      reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(leaked) }] });
    }
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
