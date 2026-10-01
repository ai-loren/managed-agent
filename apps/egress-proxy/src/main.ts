#!/usr/bin/env node
/**
 * Egress proxy entry point.
 *
 *   MA_EGRESS_PROXY_SECRET / _FILE   shared with the control plane (required, 32+ chars)
 *   MA_EGRESS_PROXY_PORT             default 3128
 *   MA_EGRESS_PROXY_HOST             default 0.0.0.0
 *   MA_EGRESS_PROXY_ALLOW_CIDRS      private ranges that may still be reached, comma-separated
 */

import { readFileSync } from 'node:fs';

import { createEgressProxy } from './proxy.ts';

function fail(message: string): never {
  process.stderr.write(`egress proxy: ${message}\n`);
  process.exit(1);
}

function secret(): string {
  const file = process.env.MA_EGRESS_PROXY_SECRET_FILE;
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (error) {
      fail(`could not read MA_EGRESS_PROXY_SECRET_FILE (${file}): ${(error as Error).message}. Point it at a readable file.`);
    }
  }
  const value = process.env.MA_EGRESS_PROXY_SECRET;
  if (!value) {
    fail('MA_EGRESS_PROXY_SECRET (or MA_EGRESS_PROXY_SECRET_FILE) is required; set it to the value the control plane has.');
  }
  return value;
}

const port = Number(process.env.MA_EGRESS_PROXY_PORT ?? '3128');
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  fail(`MA_EGRESS_PROXY_PORT must be a port number; got ${JSON.stringify(process.env.MA_EGRESS_PROXY_PORT)}.`);
}
const host = process.env.MA_EGRESS_PROXY_HOST ?? '0.0.0.0';

let server: ReturnType<typeof createEgressProxy>;
try {
  server = createEgressProxy({
    secret: secret(),
    allowCidrs: (process.env.MA_EGRESS_PROXY_ALLOW_CIDRS ?? '')
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean),
    now: () => new Date().getTime(),
    log: (entry) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`),
  });
} catch (error) {
  fail((error as Error).message);
}

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'egress.listening', host, port })}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
