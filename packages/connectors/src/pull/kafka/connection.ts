/**
 * One connection to one Kafka broker: framing, correlation, TLS and SASL.
 *
 * Requests are pipelined and matched to responses by correlation id. Any
 * failure — the socket closing, a request outliving its deadline, the caller
 * aborting — destroys the connection and fails everything outstanding on it:
 * a response that arrives after its request gave up would otherwise be read
 * as the answer to the next one.
 */

import { isIP, connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { MaError, type Clock } from '@ma/core';

import {
  API,
  apiVersionsRequest,
  apiVersionsResponse,
  errorName,
  saslAuthenticateRequest,
  saslAuthenticateResponse,
  saslHandshakeRequest,
  saslHandshakeResponse,
  type ApiName,
} from './protocol.ts';
import { ScramClient, ScramError } from './scram.ts';
import { Reader, Writer } from './wire.ts';

export interface SaslSettings {
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
}

export interface ConnectionOptions {
  host: string;
  port: number;
  tls: boolean;
  sasl?: SaslSettings | undefined;
  clientId: string;
  clock: Clock;
  /**
   * How long before a SASL session expires the connection counts as due for
   * renewal: at least the longest request it carries, so one issued just
   * before the mark still finishes inside the session.
   */
  renewMarginMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal | undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Larger than any response the consumer asks for; past it the frame is not Kafka's. */
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

interface Pending {
  resolve: (reader: Reader) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export class KafkaConnection {
  readonly address: string;
  readonly #socket: Socket;
  readonly #clientId: string;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #clock: Clock;
  readonly #renewMarginMs: number;
  #received: Buffer = Buffer.alloc(0);
  #correlation = 0;
  #failure: Error | undefined;
  #versions = new Map<number, [number, number]>();
  #detach: (() => void) | undefined;
  /** When the SASL session should be replaced (monotonic); absent when it does not expire. */
  #renewAt: number | undefined;

  private constructor(socket: Socket, address: string, options: ConnectionOptions) {
    this.#socket = socket;
    this.address = address;
    this.#clientId = options.clientId;
    this.#clock = options.clock;
    this.#renewMarginMs = options.renewMarginMs ?? 0;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', (error) => this.#fail(unavailable(`the connection to ${address} failed: ${error.message}`, error)));
    socket.on('close', () => this.#fail(unavailable(`${address} closed the connection`)));
  }

  /** Connect, check the broker speaks every version the consumer needs, and authenticate. */
  static async open(options: ConnectionOptions): Promise<KafkaConnection> {
    const address = options.host.includes(':') ? `[${options.host}]:${options.port}` : `${options.host}:${options.port}`;
    const socket = await connectSocket(options, address);
    const connection = new KafkaConnection(socket, address, options);
    const signal = options.signal;
    if (signal) {
      // Detached when the connection ends: a consumer that reconnects for hours
      // must not pile a listener (and the dead connection it holds) per attempt
      // onto its long-lived signal.
      const onAbort = (): void => connection.close();
      signal.addEventListener('abort', onAbort, { once: true });
      connection.#detach = () => signal.removeEventListener('abort', onAbort);
    }
    try {
      await connection.#negotiate();
      if (options.sasl) await connection.#authenticate(options.sasl);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  }

  /** Send a request; resolves with a reader positioned at the response body. */
  request(api: ApiName, body: Buffer, timeoutMs = this.#requestTimeoutMs): Promise<Reader> {
    if (this.#failure) return Promise.reject(this.#failure);
    const { key, version } = API[api];
    const correlation = (this.#correlation = (this.#correlation + 1) | 0);
    const header = new Writer().int16(key).int16(version).int32(correlation).nullableString(this.#clientId).build();
    const frame = Buffer.allocUnsafe(4);
    frame.writeInt32BE(header.length + body.length);

    return new Promise<Reader>((resolve, reject) => {
      const deadline = AbortSignal.timeout(timeoutMs);
      const onTimeout = (): void => {
        this.#fail(unavailable(`${this.address} did not answer ${api} within ${timeoutMs} ms`));
      };
      deadline.addEventListener('abort', onTimeout, { once: true });
      this.#pending.set(correlation, {
        resolve,
        reject,
        cleanup: () => deadline.removeEventListener('abort', onTimeout),
      });
      this.#socket.write(Buffer.concat([frame, header, body]));
    });
  }

  close(): void {
    this.#fail(unavailable(`the connection to ${this.address} was closed`));
  }

  /** The connection has ended — closed by either side, or failed. */
  get closed(): boolean {
    return this.#failure !== undefined;
  }

  /** Nothing is in flight on it. */
  get idle(): boolean {
    return this.#pending.size === 0;
  }

  /**
   * Its SASL session is close enough to expiring that it should be replaced
   * before the next request. A broker that expires sessions closes the
   * connection on the first request past the expiry, failing whatever was
   * reading through it; a fresh connection re-authenticates instead.
   */
  get renewDue(): boolean {
    return this.#renewAt !== undefined && this.#clock.monotonic() >= this.#renewAt;
  }

  async #negotiate(): Promise<void> {
    const response = apiVersionsResponse(await this.request('ApiVersions', apiVersionsRequest()));
    if (response.errorCode !== 0) {
      throw protocolError(`${this.address} answered ApiVersions with ${errorName(response.errorCode)}; it is not a Kafka 2.1+ broker`);
    }
    this.#versions = response.versions;
    const missing = (Object.keys(API) as ApiName[]).filter((name) => {
      if (name.startsWith('Sasl')) return false;
      const range = this.#versions.get(API[name].key);
      return !range || API[name].version < range[0] || API[name].version > range[1];
    });
    if (missing.length > 0) {
      throw protocolError(
        `${this.address} does not offer ${missing.map((name) => `${name} v${API[name].version}`).join(', ')}, ` +
          'which this consumer speaks; it needs a Kafka 2.1 or newer broker.',
      );
    }
  }

  async #authenticate(sasl: SaslSettings): Promise<void> {
    const mechanism = sasl.mechanism.toUpperCase();
    const handshake = saslHandshakeResponse(await this.request('SaslHandshake', saslHandshakeRequest(mechanism)));
    if (handshake.errorCode !== 0) {
      throw denied(
        `${this.address} does not accept SASL ${mechanism} (${errorName(handshake.errorCode)}); ` +
          `it offers ${handshake.mechanisms.join(', ') || 'none'}. Set config.sasl.mechanism to one of those.`,
      );
    }
    let lifetimeMs = 0;
    const exchange = async (bytes: Buffer): Promise<Buffer> => {
      const response = saslAuthenticateResponse(await this.request('SaslAuthenticate', saslAuthenticateRequest(bytes)));
      if (response.errorCode !== 0) {
        throw denied(
          `${this.address} rejected SASL ${mechanism} for ${sasl.username}: ${response.errorMessage ?? errorName(response.errorCode)}. ` +
            "Check config.sasl.username and the password in the connector's credential.",
        );
      }
      lifetimeMs = response.sessionLifetimeMs;
      return response.bytes;
    };

    if (sasl.mechanism === 'plain') {
      await exchange(Buffer.from(`\0${sasl.username}\0${sasl.password}`, 'utf8'));
    } else {
      const scram = new ScramClient(sasl.mechanism === 'scram-sha-256' ? 'sha256' : 'sha512', sasl.username, sasl.password);
      try {
        const serverFirst = await exchange(Buffer.from(scram.first(), 'utf8'));
        const serverFinal = await exchange(Buffer.from(await scram.final(serverFirst.toString('utf8')), 'utf8'));
        scram.verify(serverFinal.toString('utf8'));
      } catch (error) {
        if (error instanceof ScramError) throw denied(`SASL ${mechanism} with ${this.address} failed: ${error.message}.`);
        throw error;
      }
    }
    // The lifetime runs from the broker's end of the exchange, a moment before
    // this read of the clock; the margin absorbs that as well as the longest
    // request, and never leaves less than a fifth of the session unused.
    if (lifetimeMs > 0) {
      this.#renewAt = this.#clock.monotonic() + lifetimeMs - Math.max(this.#renewMarginMs, lifetimeMs / 5);
    }
  }

  #onData(chunk: Buffer): void {
    this.#received = this.#received.length === 0 ? chunk : Buffer.concat([this.#received, chunk]);
    while (this.#received.length >= 4) {
      const size = this.#received.readInt32BE(0);
      if (size < 4 || size > MAX_FRAME_BYTES) {
        this.#fail(protocolError(`${this.address} sent a ${size}-byte frame; it is not speaking Kafka`));
        return;
      }
      if (this.#received.length < 4 + size) return;
      const frame = this.#received.subarray(4, 4 + size);
      this.#received = this.#received.subarray(4 + size);
      const correlation = frame.readInt32BE(0);
      const pending = this.#pending.get(correlation);
      if (!pending) {
        this.#fail(protocolError(`${this.address} answered a request that was not sent (correlation ${correlation})`));
        return;
      }
      this.#pending.delete(correlation);
      pending.cleanup();
      pending.resolve(new Reader(frame, 4));
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#detach?.();
    this.#socket.destroy();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}

function connectSocket(options: ConnectionOptions, address: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    const socket = options.tls
      ? tlsConnect({ host: options.host, port: options.port, ...(isIP(options.host) === 0 ? { servername: options.host } : {}) })
      : tcpConnect({ host: options.host, port: options.port });
    const settle = (error?: Error): void => {
      deadline.removeEventListener('abort', onTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off(options.tls ? 'secureConnect' : 'connect', onConnect);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = (): void => settle();
    const onError = (error: Error): void =>
      settle(unavailable(`could not connect to Kafka broker ${address}: ${error.message}`, error));
    const onTimeout = (): void => settle(unavailable(`could not connect to Kafka broker ${address} within ${timeoutMs} ms`));
    const onAbort = (): void => settle(options.signal!.reason instanceof Error ? options.signal!.reason : new Error('aborted'));
    socket.once('error', onError);
    socket.once(options.tls ? 'secureConnect' : 'connect', onConnect);
    deadline.addEventListener('abort', onTimeout, { once: true });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function unavailable(message: string, cause?: unknown): MaError {
  return new MaError({ code: 'KAFKA_UNAVAILABLE', category: 'unavailable', message, ...(cause ? { cause } : {}) });
}

export function denied(message: string): MaError {
  return new MaError({ code: 'KAFKA_ACCESS_DENIED', category: 'permission', message });
}

export function protocolError(message: string, cause?: unknown): MaError {
  return new MaError({ code: 'KAFKA_PROTOCOL_ERROR', category: 'internal', message, retryable: true, ...(cause ? { cause } : {}) });
}
