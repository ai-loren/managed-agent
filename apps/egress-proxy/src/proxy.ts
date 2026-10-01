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
import { pipeline, type Duplex } from 'node:stream';

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

/**
 * Request headers the proxy accepts, in bytes. A grant carries its sandbox's
 * whole allowlist, twice base64-encoded on the way to `Proxy-Authorization`:
 * the most the platform signs (256 entries of 256 characters) comes to about
 * 118 KB, which Node's default of 16 KiB refused with a 431 for every request.
 */
export const MAX_HEADER_BYTES = 256 * 1024;

/** Check a grant presented as proxy credentials. `sid` is set once the signature verified. */
export function verifyGrant(
  secret: string,
  username: string,
  password: string,
  now: number,
): { ok: true; grant: Grant } | { ok: false; reason: string; sid?: string } {
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
  if (
    typeof grant.sid !== 'string' ||
    !Array.isArray(grant.hosts) ||
    !grant.hosts.every((host) => typeof host === 'string') ||
    typeof grant.exp !== 'number'
  ) {
    return { ok: false, reason: 'the grant payload is malformed' };
  }
  if (grant.sid !== username) return { ok: false, sid: grant.sid, reason: 'the grant was issued to another sandbox' };
  if (grant.exp <= now) return { ok: false, sid: grant.sid, reason: 'the grant has expired' };
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
    // Teredo hides its client's IPv4 address, so it cannot be judged by it.
    ['2001::', 32],
    // Local-use NAT64 puts the IPv4 address at an offset its operator chose.
    ['64:ff9b:1::', 48],
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
    if (!network || family === 0 || prefix === undefined || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) {
      throw new Error(
        `MA_EGRESS_PROXY_ALLOW_CIDRS expects ranges like 10.1.0.0/16 or fd00::/8, the prefix at most 32 for IPv4 and 128 for IPv6; ` +
          `got ${JSON.stringify(cidr)}. Fix or remove that entry.`,
      );
    }
    list.addSubnet(network, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** The sixteen bytes of an IPv6 address, or `undefined` if it is not one. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  if (isIP(address) !== 6) return undefined;
  let text = address.toLowerCase();
  const bytes = new Uint8Array(16);
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split('.').map(Number);
    text = `${text.slice(0, dotted.index)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = tail === undefined ? front : [...front, ...new Array<string>(8 - front.length - back.length).fill('0'), ...back];
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

/**
 * The IPv4 address an IPv6 address carries, where the IPv6 form only wraps it:
 * IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`),
 * IPv4-compatible (`::a.b.c.d`), well-known NAT64 (`64:ff9b::a.b.c.d`) and
 * 6to4 (`2002:aabb:ccdd::`). Each reaches that IPv4 host, so each is judged as it.
 */
function embeddedIpv4(address: string): string | undefined {
  const bytes = ipv6Bytes(address);
  if (!bytes) return undefined;
  const zero = (from: number, to: number): boolean => bytes.slice(from, to).every((byte) => byte === 0);
  const quad = (at: number): string => Array.from(bytes.slice(at, at + 4)).join('.');
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return quad(12);
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) return quad(12);
  if (zero(0, 12) && !(zero(12, 15) && bytes[15]! <= 1)) return quad(12);
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return quad(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return quad(2);
  return undefined;
}

/** An address as the proxy judges it: an IPv6 form that wraps an IPv4 address, as that address. */
function normalise(address: string, family: number): { address: string; type: 'ipv4' | 'ipv6' } {
  const embedded = family === 6 ? embeddedIpv4(address) : undefined;
  if (embedded) return { address: embedded, type: 'ipv4' };
  return { address, type: family === 6 ? 'ipv6' : 'ipv4' };
}

/**
 * Whether the proxy would open a connection to `address`: not in a refused
 * range, or in one of `allowCidrs`.
 */
export function addressPolicy(allowCidrs: readonly string[] = []): (address: string, family: number) => boolean {
  const blocked = blockedRanges();
  const allowed = cidrList(allowCidrs);
  return (raw, family) => {
    const { address, type } = normalise(raw, family);
    return allowed.check(address, type) || !blocked.check(address, type);
  };
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
  try {
    return { username: decodeURIComponent(decoded.slice(0, colon)), password: decodeURIComponent(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  if (options.secret.length < 32) {
    throw new Error(`The egress proxy secret must be at least 32 characters; got ${options.secret.length}.`);
  }
  const reachable = addressPolicy(options.allowCidrs ?? []);
  const resolve: Resolver = options.resolve ?? ((host) => lookup(host, { all: true, verbatim: true }));
  const idleMs = options.idleTimeoutMs ?? 120_000;
  const log = options.log ?? (() => {});

  type Refusal = { ok: false; status: 400 | 403 | 407 | 431 | 502; reason: string; sid?: string };
  type Decision = { ok: true; grant: Grant; address: string } | Refusal;

  /** Everything that must hold before a byte goes upstream. */
  async function authorise(authorization: string | undefined, host: string, port: number): Promise<Decision> {
    const presented = credentials(authorization);
    if (!presented) return { ok: false, status: 407, reason: 'no grant was presented' };
    const checked = verifyGrant(options.secret, presented.username, presented.password, options.now());
    if (!checked.ok) return { ok: false, status: 407, reason: checked.reason, ...(checked.sid ? { sid: checked.sid } : {}) };
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
    const usable = addresses.find((entry) => reachable(entry.address, entry.family));
    if (!usable) {
      return {
        ok: false,
        status: 403,
        sid: grant.sid,
        reason:
          `${host} resolves only to addresses this proxy does not open (${addresses.map((a) => a.address).join(', ')}): ` +
          'loopback, private, link-local and metadata ranges are refused unless listed in MA_EGRESS_PROXY_ALLOW_CIDRS',
      };
    }
    return { ok: true, grant, address: normalise(usable.address, usable.family).address };
  }

  const STATUS_TEXT = {
    400: 'Bad Request',
    403: 'Forbidden',
    407: 'Proxy Authentication Required',
    431: 'Request Header Fields Too Large',
    502: 'Bad Gateway',
  } as const;

  function refuse(socket: Duplex, decision: Refusal, host: string | undefined, port: number | undefined): void {
    log({ event: 'egress.refused', sid: decision.sid, host, port, status: decision.status, reason: decision.reason });
    if (socket.destroyed) return;
    const body = `managed-agent egress proxy: ${decision.reason}\n`;
    socket.end(
      `HTTP/1.1 ${decision.status} ${STATUS_TEXT[decision.status]}\r\n` +
        (decision.status === 407 ? `Proxy-Authenticate: Basic realm="${REALM}"\r\n` : '') +
        `Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }

  /** A failure no request should be able to cause: answered and logged, never thrown out of the process. */
  function fault(socket: Duplex, host: string, port: number, error: unknown): void {
    log({ event: 'egress.error', host, port, reason: error instanceof Error ? error.message : String(error) });
    socket.destroy();
  }

  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? '');
    } catch {
      refuse(request.socket, { ok: false, status: 400, reason: 'send an absolute http:// URL, or CONNECT for https' }, undefined, undefined);
      return;
    }
    if (target.protocol !== 'http:') {
      refuse(request.socket, { ok: false, status: 400, reason: 'use CONNECT for anything but plain http' }, target.hostname, undefined);
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const port = target.port === '' ? 80 : Number(target.port);
    void authorise(request.headers['proxy-authorization'], host, port)
      .then((decision) => {
        if (!decision.ok) {
          refuse(request.socket, decision, host, port);
          return;
        }
        const headers = { ...request.headers };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        // The host the grant was checked against, not whatever the client claims:
        // a virtual host on the same address is a different destination.
        headers.host = target.host;
        let failed = false;
        const fail = (error: Error): void => {
          if (failed) return;
          failed = true;
          log({ event: 'egress.failed', sid: decision.grant.sid, host, port, reason: error.message });
          if (response.headersSent) {
            response.destroy();
            return;
          }
          response.writeHead(502, { 'content-type': 'text/plain' });
          response.end(`managed-agent egress proxy: ${host}:${port} failed (${error.message})\n`);
        };
        const upstream = httpRequest(
          { host: decision.address, port, method: request.method, path: `${target.pathname}${target.search}`, headers, timeout: idleMs },
          (answer) => {
            // Once an answer has arrived, a failure is reported on it rather than
            // on the request, and anything thrown here would leave the process.
            answer.on('error', () => {});
            try {
              const status = answer.statusCode ?? 0;
              if (status < 100 || status > 999) throw new Error(`it answered with status ${status}, which is not an HTTP status`);
              response.writeHead(status, answer.headers);
            } catch (error) {
              answer.destroy();
              upstream.destroy();
              fail(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            pipeline(answer, response, () => {});
          },
        );
        upstream.on('timeout', () => upstream.destroy(new Error(`no answer within ${idleMs} ms`)));
        upstream.on('error', fail);
        // A client gone before its answer is finished takes the upstream request with it.
        response.on('close', () => {
          if (!response.writableFinished) upstream.destroy();
        });
        log({ event: 'egress.forward', sid: decision.grant.sid, host, port, address: decision.address });
        request.pipe(upstream);
      })
      .catch((error: unknown) => fault(request.socket, host, port, error));
  });

  // Node's own answer to a request it cannot parse, or one whose headers are
  // past the limit, would be sent unlogged.
  server.on('clientError', (error: Error & { code?: string }, socket: Duplex) => {
    socket.on('error', () => socket.destroy());
    // A client that reset or dropped its connection is not refused; it is gone.
    if (!error.code?.startsWith('HPE_') || !socket.writable) {
      socket.destroy();
      return;
    }
    const tooLarge = error.code === 'HPE_HEADER_OVERFLOW';
    refuse(
      socket,
      {
        ok: false,
        status: tooLarge ? 431 : 400,
        reason: tooLarge
          ? `the request's headers are over ${MAX_HEADER_BYTES} bytes; a grant this large means an allowlist past what the platform signs`
          : `the request could not be parsed (${error.code ?? error.message})`,
      },
      undefined,
      undefined,
    );
  });

  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    // The HTTP server hands a CONNECT socket over unguarded: a client that
    // resets it — curl does, on a refusal — would otherwise throw out of the
    // process and take every other sandbox's tunnels with it.
    client.on('error', () => client.destroy());
    const authority = parseAuthority(request.url ?? '');
    if (!authority) {
      refuse(client, { ok: false, status: 400, reason: 'CONNECT needs host:port' }, undefined, undefined);
      return;
    }
    const { host, port } = authority;
    void authorise(request.headers['proxy-authorization'], host, port)
      .then((decision) => {
        if (!decision.ok) {
          refuse(client, decision, host, port);
          return;
        }
        let established = false;
        const upstream: Socket = connect({ host: decision.address, port });
        upstream.setTimeout(idleMs, () => upstream.destroy(new Error(`no answer within ${idleMs} ms`)));
        (client as Socket).setTimeout?.(idleMs, () => client.destroy());
        upstream.once('connect', () => {
          established = true;
          log({ event: 'egress.tunnel', sid: decision.grant.sid, host, port, address: decision.address });
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', (error) => {
          // Until the 200 went out the client is still waiting for an answer.
          if (!established) {
            refuse(client, { ok: false, status: 502, sid: decision.grant.sid, reason: `${host}:${port} failed (${error.message})` }, host, port);
          } else {
            client.destroy();
          }
        });
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
      })
      .catch((error: unknown) => fault(client, host, port, error));
  });

  return server;
}
