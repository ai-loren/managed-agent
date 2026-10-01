/**
 * The managed egress proxy: per-sandbox allowlists, enforced.
 *
 * A restricted sandbox on the container or Kubernetes driver can reach only
 * the control plane and this proxy. A generic forward proxy would apply one
 * allowlist to every sandbox behind it; this one applies each sandbox's own.
 * The control plane signs a grant for a sandbox — its id, the hosts its policy
 * allows, an expiry — with a secret it shares with the proxy, and hands it to
 * the sandbox as the password in its proxy URL, so every HTTP client sends it
 * as `Proxy-Authorization`. The proxy checks the signature, the expiry and the
 * host before it opens anything. A `deny` sandbox gets no grant and no proxy.
 *
 * Allowed hostnames are still not trusted to stay public: the proxy resolves
 * them itself, refuses loopback, private, link-local and metadata addresses
 * (so an allowlisted name that resolves to 169.254.169.254 does not open a
 * path into the platform's network), and connects to the address it checked,
 * so a second lookup cannot swap it.
 *
 * Node built-ins only, so the image is this file and `main.ts`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface Grant {
  /** The sandbox the grant was issued to. */
  sid: string;
  /** Its egress allowlist: `host`, `host:port`, or `*.domain`. */
  hosts: string[];
  /** Expiry, epoch milliseconds. */
  exp: number;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface EgressProxyOptions {
  /** Shared with the control plane, which signs grants with it. */
  secret: string;
  /** Private ranges that may still be reached, e.g. an internal API on the allowlist. */
  allowCidrs?: readonly string[];
  resolve?: Resolver;
  now: () => number;
  log?: (entry: Record<string, unknown>) => void;
  /** Idle limit on a tunnel or a forwarded request, either side. */
  idleTimeoutMs?: number;
}

const GRANT_VERSION = 'v1';
const REALM = 'managed-agent egress';

/** Check a grant presented as proxy credentials. */
export function verifyGrant(
  secret: string,
  username: string,
  password: string,
  now: number,
): { ok: true; grant: Grant } | { ok: false; reason: string } {
  const parts = password.split('.');
  if (parts.length !== 3 || parts[0] !== GRANT_VERSION) return { ok: false, reason: 'the proxy credentials are not a grant' };
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const presented = Buffer.from(parts[2]!, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'the grant signature does not verify' };
  }
  let grant: Grant;
  try {
    grant = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Grant;
  } catch {
    return { ok: false, reason: 'the grant payload is not JSON' };
  }
  if (typeof grant.sid !== 'string' || !Array.isArray(grant.hosts) || typeof grant.exp !== 'number') {
    return { ok: false, reason: 'the grant payload is malformed' };
  }
  if (grant.sid !== username) return { ok: false, reason: 'the grant was issued to another sandbox' };
  if (grant.exp <= now) return { ok: false, reason: 'the grant has expired' };
  return { ok: true, grant };
}

/** Whether `host:port` is on a grant's allowlist. An entry without a port allows 80 and 443. */
export function hostAllowed(entries: readonly string[], host: string, port: number): boolean {
  const target = host.toLowerCase().replace(/\.$/, '');
  return entries.some((raw) => {
    const entry = raw.toLowerCase().trim();
    const match = /^(.*?)(?::(\d+))?$/.exec(entry.startsWith('[') ? entry.replace(/^\[(.*)\](.*)$/, '$1$2') : entry);
    const name = (match?.[1] ?? '').replace(/\.$/, '');
    const ports = match?.[2] === undefined ? [80, 443] : [Number(match[2])];
    if (!ports.includes(port)) return false;
    if (name.startsWith('*.')) return target.endsWith(name.slice(1)) && target.length > name.length - 1;
    return name === target;
  });
}

function blockedRanges(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

function cidrList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [network, prefix] = cidr.split('/');
    const family = isIP(network ?? '');
    if (!network || family === 0 || prefix === undefined || !/^\d+$/.test(prefix)) {
      throw new Error(`An allowed CIDR must look like 10.1.0.0/16 or fd00::/8; got ${JSON.stringify(cidr)}.`);
    }
    list.addSubnet(network, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** An IPv4-mapped IPv6 address is judged as the IPv4 address it carries. */
function normalise(address: string, family: number): { address: string; type: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, type: 'ipv4' };
  return { address, type: family === 6 ? 'ipv6' : 'ipv4' };
}

function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port };
}

function credentials(header: string | undefined): { username: string; password: string } | undefined {
  if (!header?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  return { username: decodeURIComponent(decoded.slice(0, colon)), password: decodeURIComponent(decoded.slice(colon + 1)) };
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  if (options.secret.length < 32) {
    throw new Error(`The egress proxy secret must be at least 32 characters; got ${options.secret.length}.`);
  }
  const blocked = blockedRanges();
  const allowed = cidrList(options.allowCidrs ?? []);
  const resolve: Resolver = options.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }));
  const idleMs = options.idleTimeoutMs ?? 120_000;
  const log = options.log ?? (() => {});

  type Decision =
    | { ok: true; grant: Grant; address: string }
    | { ok: false; status: 403 | 407 | 502; reason: string; sid?: string };

  /** Everything that must hold before a byte goes upstream. */
  async function authorise(authorization: string | undefined, host: string, port: number): Promise<Decision> {
    const presented = credentials(authorization);
    if (!presented) return { ok: false, status: 407, reason: 'no grant was presented' };
    const checked = verifyGrant(options.secret, presented.username, presented.password, options.now());
    if (!checked.ok) return { ok: false, status: 407, reason: checked.reason };
    const { grant } = checked;
    if (!hostAllowed(grant.hosts, host, port)) {
      return {
        ok: false,
        status: 403,
        sid: grant.sid,
        reason: `${host}:${port} is not in this sandbox's egress allowlist (${grant.hosts.join(', ') || 'empty'})`,
      };
    }
    let addresses: { address: string; family: number }[];
    try {
      addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
    } catch (error) {
      return { ok: false, status: 502, sid: grant.sid, reason: `${host} did not resolve (${(error as Error).message})` };
    }
    const reachable = addresses.find((entry) => {
      const { address, type } = normalise(entry.address, entry.family);
      return allowed.check(address, type) || !blocked.check(address, type);
    });
    if (!reachable) {
      return {
        ok: false,
        status: 403,
        sid: grant.sid,
        reason:
          `${host} resolves only to addresses this proxy does not open (${addresses.map((a) => a.address).join(', ')}): ` +
          'loopback, private, link-local and metadata ranges are refused unless listed in MA_EGRESS_PROXY_ALLOW_CIDRS',
      };
    }
    return { ok: true, grant, address: normalise(reachable.address, reachable.family).address };
  }

  function refuse(socket: Duplex, decision: Exclude<Decision, { ok: true }>, host: string, port: number): void {
    log({ event: 'egress.refused', sid: decision.sid, host, port, status: decision.status, reason: decision.reason });
    const statusText = { 403: 'Forbidden', 407: 'Proxy Authentication Required', 502: 'Bad Gateway' }[decision.status];
    const body = `managed-agent egress proxy: ${decision.reason}\n`;
    socket.end(
      `HTTP/1.1 ${decision.status} ${statusText}\r\n` +
        (decision.status === 407 ? `Proxy-Authenticate: Basic realm="${REALM}"\r\n` : '') +
        `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? '');
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('managed-agent egress proxy: send an absolute http:// URL, or CONNECT for https\n');
      return;
    }
    if (target.protocol !== 'http:') {
      response.writeHead(400, { 'content-type': 'text/plain' }).end('managed-agent egress proxy: use CONNECT for anything but plain http\n');
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = target.port === '' ? 80 : Number(target.port);
    void authorise(request.headers['proxy-authorization'], host, port).then((decision) => {
      if (!decision.ok) {
        refuse(request.socket, decision, host, port);
        return;
      }
      const headers = { ...request.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = httpRequest(
        { host: decision.address, port, method: request.method, path: `${target.pathname}${target.search}`, headers, timeout: idleMs },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('upstream idle')));
      upstream.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(`managed-agent egress proxy: ${host}:${port} failed (${error.message})\n`);
      });
      log({ event: 'egress.forward', sid: decision.grant.sid, host, port, address: decision.address });
      request.pipe(upstream);
    });
  });

  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    // The HTTP server hands a CONNECT socket over unguarded: a client that
    // resets it — curl does, on a refusal — would otherwise throw out of the
    // process and take every other sandbox's tunnels with it.
    client.on('error', () => client.destroy());
    const authority = parseAuthority(request.url ?? '');
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const { host, port } = authority;
    void authorise(request.headers['proxy-authorization'], host, port).then((decision) => {
      if (!decision.ok) {
        refuse(client, decision, host, port);
        return;
      }
      const upstream: Socket = connect({ host: decision.address, port });
      upstream.setTimeout(idleMs, () => upstream.destroy());
      (client as Socket).setTimeout?.(idleMs, () => client.destroy());
      upstream.once('connect', () => {
        log({ event: 'egress.tunnel', sid: decision.grant.sid, host, port, address: decision.address });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', (error) => {
        if (upstream.connecting) {
          refuse(client, { ok: false, status: 502, sid: decision.grant.sid, reason: `${host}:${port} failed (${error.message})` }, host, port);
        } else {
          client.destroy();
        }
      });
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    });
  });

  return server;
}
