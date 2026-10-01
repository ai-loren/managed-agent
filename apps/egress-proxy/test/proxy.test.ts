/**
 * The managed egress proxy, with real sockets and curl as the client.
 *
 * curl stands in for every tool in a sandbox: it turns the credentials in a
 * proxy URL into `Proxy-Authorization`, which is the whole delivery mechanism
 * for a grant. Names resolve through an injected resolver, so the SSRF rules
 * can be exercised without the network. Grants are signed by the platform's
 * own signer, so these tests also pin the two halves of the format together.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';

import { egressProxyEnv, signEgressGrant } from '@ma/sandbox';

import { createEgressProxy, hostAllowed, verifyGrant } from '../src/proxy.ts';

const SECRET = 'a-shared-secret-of-at-least-thirty-two-chars';
const NOW = 1_700_000_000_000;
const NAMES: Record<string, string> = {
  'api.example.test': '127.0.0.1',
  'deep.api.example.test': '127.0.0.1',
  'example.test': '127.0.0.1',
  'metadata.example.test': '169.254.169.254',
  'internal.example.test': '10.1.2.3',
};

let upstream: Server;
let upstreamPort: number;
let lastUpstreamHeaders: IncomingHttpHeaders = {};
let proxy: Server;
let proxyPort: number;
const events: Record<string, unknown>[] = [];

before(async () => {
  upstream = createServer((request, response) => {
    lastUpstreamHeaders = request.headers;
    response.end(`upstream-ok ${request.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as { port: number }).port;

  proxy = createEgressProxy({
    secret: SECRET,
    // The upstream is on loopback, which only an explicit range lets through.
    allowCidrs: ['127.0.0.1/32'],
    resolve: (host) =>
      NAMES[host] ? Promise.resolve([{ address: NAMES[host]!, family: 4 }]) : Promise.reject(new Error('ENOTFOUND')),
    now: () => NOW,
    log: (entry) => events.push(entry),
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyPort = (proxy.address() as { port: number }).port;
});

after(() => {
  upstream.close();
  proxy.close();
});

/** The proxy URL a sandbox with this allowlist gets, from the platform's own code. */
function proxyFor(hosts: string[], options: { sandboxId?: string; expiresAt?: number } = {}): string {
  return egressProxyEnv({
    proxy: `http://127.0.0.1:${proxyPort}`,
    secret: SECRET,
    sandboxId: options.sandboxId ?? 'sb_one',
    hosts,
    expiresAt: options.expiresAt ?? NOW + 60_000,
    controlPlaneUrl: 'http://cp.internal:8080',
  }).HTTPS_PROXY!;
}

/** Asynchronously: the proxy and the upstream run in this process, so a blocking spawn would starve them. */
function curl(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-S', '-m', '10', ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
    });
  });
}

describe('allowed traffic', () => {
  test('a tunnel to an allowlisted host reaches it', async () => {
    const result = (await curl(['-p', '-x', proxyFor([`api.example.test:${upstreamPort}`]), `http://api.example.test:${upstreamPort}/tunnel`]));
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, 'upstream-ok /tunnel');
  });

  test('a plain request is forwarded, without the grant', async () => {
    const result = (await curl(['-x', proxyFor([`api.example.test:${upstreamPort}`]), `http://api.example.test:${upstreamPort}/plain?q=1`]));
    assert.equal(result.out, 'upstream-ok /plain?q=1');
    assert.equal(lastUpstreamHeaders['proxy-authorization'], undefined, 'the grant stops at the proxy');
    assert.equal(lastUpstreamHeaders.host, `api.example.test:${upstreamPort}`);
  });

  test('a wildcard entry covers subdomains, not the domain itself', async () => {
    const grant = proxyFor([`*.example.test:${upstreamPort}`]);
    assert.equal((await curl(['-x', grant, `http://deep.api.example.test:${upstreamPort}/`])).out, 'upstream-ok /');
    assert.match((await curl(['-x', grant, `http://example.test:${upstreamPort}/`])).out, /not in this sandbox's egress allowlist/);
  });
});

describe('refused traffic', () => {
  test('a host off the allowlist is refused, saying which host and what is allowed', async () => {
    const result = (await curl(['-x', proxyFor([`api.example.test:${upstreamPort}`]), `http://example.test:${upstreamPort}/`]));
    assert.equal(
      result.out,
      `managed-agent egress proxy: example.test:${upstreamPort} is not in this sandbox's egress allowlist (api.example.test:${upstreamPort})\n`,
    );
    const tunnel = (await curl(['-p', '-x', proxyFor([`api.example.test:${upstreamPort}`]), `http://example.test:${upstreamPort}/`]));
    assert.notEqual(tunnel.code, 0);
    assert.match(tunnel.err, /403/);
  });

  test('an entry without a port allows 80 and 443 only', async () => {
    const result = (await curl(['-x', proxyFor(['api.example.test']), `http://api.example.test:${upstreamPort}/`]));
    assert.match(result.out, /not in this sandbox's egress allowlist/);
    assert.equal(hostAllowed(['api.example.test'], 'api.example.test', 443), true);
    assert.equal(hostAllowed(['api.example.test'], 'API.example.test.', 80), true);
    assert.equal(hostAllowed(['api.example.test'], 'api.example.test', 8443), false);
  });

  test('no grant, a tampered one, an expired one or another sandbox’s gets 407', async () => {
    const target = `http://api.example.test:${upstreamPort}/`;
    const bare = (await curl(['-i', '-x', `http://127.0.0.1:${proxyPort}`, target])).out;
    assert.match(bare, /^HTTP\/1\.1 407 /);
    assert.match(bare, /Proxy-Authenticate: Basic realm="managed-agent egress"/);

    const valid = new URL(proxyFor([`api.example.test:${upstreamPort}`]));
    const [version, payload, signature] = decodeURIComponent(valid.password).split('.');
    const widened = Buffer.from(JSON.stringify({ sid: 'sb_one', hosts: ['*'], exp: NOW + 60_000 })).toString('base64url');
    valid.password = `${version}.${widened}.${signature}`;
    assert.match((await curl(['-x', valid.toString(), target])).out, /the grant signature does not verify/);
    assert.ok(payload);

    const expired = proxyFor([`api.example.test:${upstreamPort}`], { expiresAt: NOW - 1 });
    assert.match((await curl(['-x', expired, target])).out, /the grant has expired/);

    const borrowed = new URL(proxyFor([`api.example.test:${upstreamPort}`], { sandboxId: 'sb_one' }));
    borrowed.username = 'sb_two';
    assert.match((await curl(['-x', borrowed.toString(), target])).out, /issued to another sandbox/);
  });

  test('an allowlisted name that resolves into a private or metadata range is refused', async () => {
    for (const name of ['metadata.example.test', 'internal.example.test']) {
      const result = (await curl(['-x', proxyFor([`${name}:80`]), `http://${name}/latest/meta-data/`]));
      assert.match(result.out, new RegExp(`${name.replace(/\./g, '\\.')} resolves only to addresses this proxy does not open`));
    }
    const literal = (await curl(['-x', proxyFor(['169.254.169.254:80']), 'http://169.254.169.254/']));
    assert.match(literal.out, /does not open/);
  });

  test('a client that resets its connection mid-refusal does not take the proxy down', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise<void>((resolve) => {
        const socket = connect(proxyPort, '127.0.0.1', () => {
          socket.write(`CONNECT example.test:${upstreamPort} HTTP/1.1\r\nHost: example.test\r\n\r\n`);
          socket.resetAndDestroy();
          resolve();
        });
        socket.on('error', () => resolve());
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await curl(['-x', proxyFor([`api.example.test:${upstreamPort}`]), `http://api.example.test:${upstreamPort}/still-up`]);
    assert.equal(after.out, 'upstream-ok /still-up');
  });

  test('every refusal and every opening is logged with the sandbox it came from', async () => {
    assert.ok(events.some((entry) => entry.event === 'egress.refused' && entry.status === 403 && entry.sid === 'sb_one'));
    assert.ok(events.some((entry) => entry.event === 'egress.tunnel' && entry.sid === 'sb_one'));
  });
});

describe('the grant format', () => {
  test('what the platform signs, the proxy verifies; anything else it does not', async () => {
    const grant = signEgressGrant(SECRET, { sid: 'sb_x', hosts: ['a.test'], exp: NOW + 1 });
    assert.deepEqual(verifyGrant(SECRET, 'sb_x', grant, NOW), { ok: true, grant: { sid: 'sb_x', hosts: ['a.test'], exp: NOW + 1 } });
    assert.equal(verifyGrant('another-secret-of-at-least-thirty-two-chars', 'sb_x', grant, NOW).ok, false);
    assert.equal(verifyGrant(SECRET, 'sb_x', 'not-a-grant', NOW).ok, false);
  });

  test('a short secret is refused at start, saying how long it must be', async () => {
    assert.throws(() => createEgressProxy({ secret: 'short', now: () => NOW }), /at least 32 characters; got 5/);
  });
});
