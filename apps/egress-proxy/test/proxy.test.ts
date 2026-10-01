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
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, createServer as createTcpServer, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

import { egressProxyEnv, signEgressGrant } from '@ma/sandbox';

import { MAX_HEADER_BYTES, addressPolicy, createEgressProxy, hostAllowed, verifyGrant } from '../src/proxy.ts';

const SECRET = 'a-shared-secret-of-at-least-thirty-two-chars';
const NOW = 1_700_000_000_000;
const NAMES: Record<string, string> = {
  'api.example.test': '127.0.0.1',
  'deep.api.example.test': '127.0.0.1',
  'example.test': '127.0.0.1',
  'metadata.example.test': '169.254.169.254',
  'internal.example.test': '10.1.2.3',
  'nat64-metadata.example.test': '64:ff9b::a9fe:a9fe',
  'compat-metadata.example.test': '::a9fe:a9fe',
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
      NAMES[host] ? Promise.resolve([{ address: NAMES[host]!, family: isIP(NAMES[host]!) }]) : Promise.reject(new Error('ENOTFOUND')),
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

  test('a grant that verified but expired, or was borrowed, is logged with the sandbox it names', async () => {
    const target = `http://api.example.test:${upstreamPort}/`;
    await curl(['-x', proxyFor([`api.example.test:${upstreamPort}`], { sandboxId: 'sb_late', expiresAt: NOW - 1 }), target]);
    const borrowed = new URL(proxyFor([`api.example.test:${upstreamPort}`], { sandboxId: 'sb_lender' }));
    borrowed.username = 'sb_borrower';
    await curl(['-x', borrowed.toString(), target]);
    assert.ok(events.some((e) => e.status === 407 && e.sid === 'sb_late' && e.reason === 'the grant has expired'));
    assert.ok(events.some((e) => e.status === 407 && e.sid === 'sb_lender' && e.reason === 'the grant was issued to another sandbox'));
  });

  test('a client that resets before its headers are in is gone, not refused', async () => {
    const before = events.length;
    await new Promise<void>((resolve) => {
      const socket = connect(proxyPort, '127.0.0.1', () => {
        socket.write('GET http://api.example.test/ HTTP/1.1\r\nHost: api.exa');
        setTimeout(() => {
          socket.resetAndDestroy();
          resolve();
        }, 50);
      });
      socket.on('error', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(events.slice(before), []);
  });

  test('a request the proxy cannot use is answered 400 and logged', async () => {
    const answer = await raw(`GET /relative HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 Bad Request/);
    assert.ok(events.some((e) => e.event === 'egress.refused' && e.status === 400 && /absolute http/.test(String(e.reason))));
  });

  test('an allowlisted name that resolves to a NAT64 or IPv4-compatible form of the metadata address is refused', async () => {
    for (const name of ['nat64-metadata.example.test', 'compat-metadata.example.test']) {
      const result = await curl(['-x', proxyFor([`${name}:80`]), `http://${name}/latest/meta-data/`]);
      assert.match(result.out, /resolves only to addresses this proxy does not open/, name);
    }
  });

  test('a tunnel to a port nothing listens on is answered 502, and logged', async () => {
    const closed = await freePort();
    const result = await curl(['-p', '-x', proxyFor([`api.example.test:${closed}`]), `http://api.example.test:${closed}/`]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /502/);
    assert.ok(events.some((e) => e.event === 'egress.refused' && e.status === 502 && e.port === closed && /ECONNREFUSED/.test(String(e.reason))));
  });
});

/** Send `request` straight to the proxy and return everything it answers. */
function raw(request: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    let answer = '';
    const socket = connect(proxyPort, '127.0.0.1', () => socket.end(request));
    socket.on('data', (chunk) => (answer += chunk.toString()));
    socket.on('close', () => resolve(answer));
    socket.on('error', () => resolve(answer));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createTcpServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe('forwarding', () => {
  test('the upstream sees the host the grant was checked against, not the one the client claims', async () => {
    await curl(['-x', proxyFor([`api.example.test:${upstreamPort}`]), '-H', 'Host: not-on-the-allowlist.example', `http://api.example.test:${upstreamPort}/vhost`]);
    assert.equal(lastUpstreamHeaders.host, `api.example.test:${upstreamPort}`);
  });

  test('a client gone mid-download takes the upstream request with it', async () => {
    let upstreamClosedAt: number | undefined;
    const slow = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      const tick = setInterval(() => response.write('x'.repeat(1024)), 20);
      response.on('close', () => {
        clearInterval(tick);
        upstreamClosedAt = Date.now();
      });
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const port = (slow.address() as { port: number }).port;
    try {
      const credentials = new URL(proxyFor([`api.example.test:${port}`]));
      const authorization = Buffer.from(`${credentials.username}:${decodeURIComponent(credentials.password)}`).toString('base64');
      const leftAt = await new Promise<number>((resolve) => {
        const socket = connect(proxyPort, '127.0.0.1', () => {
          socket.write(`GET http://api.example.test:${port}/stream HTTP/1.1\r\nHost: api.example.test:${port}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
        });
        socket.once('data', () => {
          socket.destroy();
          resolve(Date.now());
        });
      });
      for (let waited = 0; upstreamClosedAt === undefined && waited < 3000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(upstreamClosedAt !== undefined, 'the upstream request was still open 3 s after its client left');
      assert.ok(upstreamClosedAt - leftAt < 1000);
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });

  test('a client gone mid-upload takes the upstream request with it', async () => {
    let upstreamGone: number | undefined;
    const sink = createServer((request) => {
      request.on('data', () => {});
      request.on('close', () => (upstreamGone = Date.now()));
    });
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
    const port = (sink.address() as { port: number }).port;
    try {
      const credentials = new URL(proxyFor([`api.example.test:${port}`]));
      const authorization = Buffer.from(`${credentials.username}:${decodeURIComponent(credentials.password)}`).toString('base64');
      const socket = connect(proxyPort, '127.0.0.1', () => {
        socket.write(
          `POST http://api.example.test:${port}/upload HTTP/1.1\r\nHost: api.example.test:${port}\r\n` +
            `Proxy-Authorization: Basic ${authorization}\r\nContent-Length: 1000000\r\n\r\n${'u'.repeat(4096)}`,
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const leftAt = Date.now();
      socket.destroy();
      for (let waited = 0; upstreamGone === undefined && waited < 3000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(upstreamGone !== undefined, 'the upstream request was still open 3 s after its client left');
      assert.ok(upstreamGone - leftAt < 1000);
    } finally {
      sink.closeAllConnections();
      sink.close();
    }
  });

  test('a failure inside the proxy is logged and the connection closed, on both paths', async () => {
    const logged: Record<string, unknown>[] = [];
    const broken = createEgressProxy({
      secret: SECRET,
      now: () => {
        throw new Error('the clock broke');
      },
      log: (entry) => logged.push(entry),
    });
    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve));
    const port = (broken.address() as { port: number }).port;
    try {
      const credentials = new URL(proxyFor(['api.example.test']));
      const authorization = Buffer.from(`${credentials.username}:${decodeURIComponent(credentials.password)}`).toString('base64');
      for (const request of [
        `GET http://api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
        `CONNECT api.example.test:443 HTTP/1.1\r\nHost: api.example.test:443\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`,
      ]) {
        await new Promise<void>((resolve) => {
          const socket = connect(port, '127.0.0.1', () => socket.write(request));
          socket.on('close', () => resolve());
          socket.on('error', () => resolve());
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 2000);
        });
      }
      assert.deepEqual(
        logged.map((entry) => [entry.event, entry.reason]),
        [
          ['egress.error', 'the clock broke'],
          ['egress.error', 'the clock broke'],
        ],
      );
    } finally {
      broken.closeAllConnections();
      broken.close();
    }
  });

  test('the largest allowlist the platform signs fits in a request; a header past the limit is refused and logged', async () => {
    const hosts = Array.from({ length: 255 }, (_, index) => `${String(index).padStart(3, '0')}${'h'.repeat(240)}.example.test`);
    hosts.push(`api.example.test:${upstreamPort}`);
    assert.ok(hosts.slice(0, 255).every((host) => host.length === 256));
    const result = await curl(['-x', proxyFor(hosts), `http://api.example.test:${upstreamPort}/many`]);
    assert.equal(result.out, 'upstream-ok /many');

    const answer = await raw(`GET http://api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\nX-Padding: ${'p'.repeat(MAX_HEADER_BYTES)}\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 431 /);
    assert.ok(events.some((e) => e.event === 'egress.refused' && e.status === 431));
  });
});

describe('which addresses the proxy opens', () => {
  const opens = addressPolicy();

  test('IPv6 forms that only wrap an IPv4 address are judged as that address', () => {
    for (const address of [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:0:a9fe:a9fe',
      '::a9fe:a9fe',
      '::2',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::10.0.0.1',
      '2002:a9fe:a9fe::1',
      '2002:7f00:1::',
    ]) {
      assert.equal(opens(address, 6), false, address);
    }
    for (const address of ['64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8']) {
      assert.equal(opens(address, 6), true, address);
    }
  });

  test('forms that hide their IPv4 address are refused outright, and ordinary IPv6 is not', () => {
    assert.equal(opens('2001:0:4136:e378:8000:63bf:3fff:fdd2', 6), false, 'Teredo');
    assert.equal(opens('64:ff9b:1::a9fe:a9fe', 6), false, 'local-use NAT64');
    assert.equal(opens('::1', 6), false);
    assert.equal(opens('::', 6), false);
    assert.equal(opens('2606:4700:4700::1111', 6), true);
  });

  test('an allowed range admits a wrapped address inside it', () => {
    assert.equal(addressPolicy(['10.1.0.0/16'])('::ffff:10.1.2.3', 6), true);
    assert.equal(addressPolicy(['10.1.0.0/16'])('64:ff9b::10.2.0.1', 6), false);
  });
});

describe('one bad peer does not take the proxy down', () => {
  let child: ChildProcess;
  let port: number;
  let output = '';

  before(async () => {
    port = await freePort();
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
      env: { ...process.env, MA_EGRESS_PROXY_SECRET: SECRET, MA_EGRESS_PROXY_PORT: String(port), MA_EGRESS_PROXY_HOST: '127.0.0.1', MA_EGRESS_PROXY_ALLOW_CIDRS: '127.0.0.1/32' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
    for (let waited = 0; !output.includes('egress.listening') && waited < 10_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(output, /egress\.listening/);
  });

  after(() => {
    child.kill();
  });

  function send(request: string): Promise<string> {
    return new Promise((resolve) => {
      let answer = '';
      const socket = connect(port, '127.0.0.1', () => socket.write(request));
      socket.on('data', (chunk) => (answer += chunk.toString()));
      socket.on('close', () => resolve(answer));
      socket.on('error', () => resolve(answer));
      setTimeout(() => socket.destroy(), 3000);
    });
  }

  async function stillServing(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, `the proxy exited:\n${output}`);
    assert.match(await send('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 /);
  }

  test('a stray percent sign in the credentials gets a 407 on both paths', async () => {
    const authorization = Buffer.from('%zz:x').toString('base64');
    const plain = await send(`GET http://127.0.0.1:9/ HTTP/1.1\r\nHost: 127.0.0.1:9\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
    assert.match(plain, /^HTTP\/1\.1 407 /);
    const tunnel = await send(`CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
    assert.match(tunnel, /^HTTP\/1\.1 407 /);
    await stillServing();
  });

  test('an upstream answering with a status outside 100–999 gets a 502', async () => {
    const odd = createTcpServer((socket) => {
      socket.once('data', () => socket.end('HTTP/1.1 099 Odd\r\nContent-Length: 2\r\n\r\nhi'));
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => odd.listen(0, '127.0.0.1', resolve));
    const upstream = (odd.address() as { port: number }).port;
    try {
      const grant = signEgressGrant(SECRET, { sid: 'sb_odd', hosts: [`127.0.0.1:${upstream}`], exp: Date.now() + 60_000 });
      const authorization = Buffer.from(`sb_odd:${grant}`).toString('base64');
      const answer = await send(`GET http://127.0.0.1:${upstream}/ HTTP/1.1\r\nHost: 127.0.0.1:${upstream}\r\nProxy-Authorization: Basic ${authorization}\r\n\r\n`);
      assert.match(answer, /^HTTP\/1\.1 502 [\s\S]*not an HTTP status/);
      await stillServing();
    } finally {
      odd.close();
    }
  });
});

describe('the grant format', () => {
  test('what the platform signs, the proxy verifies; anything else it does not', async () => {
    const grant = signEgressGrant(SECRET, { sid: 'sb_x', hosts: ['a.test'], exp: NOW + 1 });
    assert.deepEqual(verifyGrant(SECRET, 'sb_x', grant, NOW), { ok: true, grant: { sid: 'sb_x', hosts: ['a.test'], exp: NOW + 1 } });
    assert.equal(verifyGrant('another-secret-of-at-least-thirty-two-chars', 'sb_x', grant, NOW).ok, false);
    assert.equal(verifyGrant(SECRET, 'sb_x', 'not-a-grant', NOW).ok, false);
    const numeric = signEgressGrant(SECRET, { sid: 'sb_x', hosts: [42 as unknown as string], exp: NOW + 1 });
    assert.deepEqual(verifyGrant(SECRET, 'sb_x', numeric, NOW), { ok: false, reason: 'the grant payload is malformed' });
  });

  test('a short secret is refused at start, saying how long it must be', async () => {
    assert.throws(() => createEgressProxy({ secret: 'short', now: () => NOW }), /at least 32 characters; got 5/);
  });

  test('an allowed range with an impossible prefix is refused at start, naming the setting', () => {
    for (const cidr of ['10.0.0.0/33', 'fd00::/129']) {
      assert.throws(
        () => createEgressProxy({ secret: SECRET, allowCidrs: [cidr], now: () => NOW }),
        new RegExp(`MA_EGRESS_PROXY_ALLOW_CIDRS expects .*got "${cidr.replace(/[./]/g, '\\$&')}"`),
      );
    }
  });
});
