// A minimal fake MCP stdio server for tests: speaks newline-delimited JSON-RPC,
// answers initialize / tools/list / tools/call for a single `echo` tool.
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
    if (msg.id === undefined) continue; // a notification
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, {
        tools: [
          {
            name: 'echo',
            description: 'Echoes its text argument',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
      });
    } else if (msg.method === 'tools/call') {
      const text = msg.params?.arguments?.text ?? '';
      reply(msg.id, { content: [{ type: 'text', text: `echo: ${text}` }] });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown method' } }) + '\n');
    }
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
