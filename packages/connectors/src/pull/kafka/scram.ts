/**
 * The client side of SCRAM-SHA-256/512 (RFC 5802, RFC 7677), as Kafka uses it.
 *
 * Kafka hashes the password's UTF-8 bytes without SASLprep, so this does too;
 * applying SASLprep would make a non-ASCII password fail against a broker that
 * stored it Kafka's way.
 */

import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);

/** Kafka's floor for SCRAM iterations; fewer from a server is a downgrade to refuse. */
const MIN_ITERATIONS = 4096;
/**
 * Kafka's ceiling: no broker stores credentials with more, so a server asking
 * for more is not one, and it would be buying minutes of CPU per login.
 */
const MAX_ITERATIONS = 16_384;

export class ScramError extends Error {}

export class ScramClient {
  readonly #algorithm: 'sha256' | 'sha512';
  readonly #password: string;
  readonly #nonce: string;
  readonly #firstBare: string;
  #serverSignature: Buffer | undefined;

  constructor(algorithm: 'sha256' | 'sha512', username: string, password: string, nonce = randomBytes(24).toString('base64')) {
    this.#algorithm = algorithm;
    this.#password = password;
    this.#nonce = nonce;
    this.#firstBare = `n=${username.replace(/=/g, '=3D').replace(/,/g, '=2C')},r=${nonce}`;
  }

  /** client-first-message */
  first(): string {
    return `n,,${this.#firstBare}`;
  }

  /**
   * client-final-message, answering server-first-message. The key stretching
   * runs off the event loop: a login must not stall every other connection.
   */
  async final(serverFirst: string): Promise<string> {
    const fields = parse(serverFirst);
    const nonce = fields.get('r');
    const salt = fields.get('s');
    const iterations = Number(fields.get('i'));
    if (!nonce || !salt || !Number.isInteger(iterations)) throw new ScramError('the server-first message is malformed');
    if (!nonce.startsWith(this.#nonce) || nonce.length === this.#nonce.length) {
      throw new ScramError('the server did not extend the client nonce');
    }
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw new ScramError(`the server asked for ${iterations} iterations; expected ${MIN_ITERATIONS}–${MAX_ITERATIONS}`);
    }

    const length = this.#algorithm === 'sha256' ? 32 : 64;
    const salted = await derive(Buffer.from(this.#password, 'utf8'), Buffer.from(salt, 'base64'), iterations, length, this.#algorithm);
    const clientKey = this.#hmac(salted, 'Client Key');
    const storedKey = createHash(this.#algorithm).update(clientKey).digest();
    const withoutProof = `c=biws,r=${nonce}`;
    const authMessage = `${this.#firstBare},${serverFirst},${withoutProof}`;
    const signature = this.#hmac(storedKey, authMessage);
    const proof = Buffer.alloc(clientKey.length);
    for (let index = 0; index < proof.length; index++) proof[index] = clientKey[index]! ^ signature[index]!;
    this.#serverSignature = this.#hmac(this.#hmac(salted, 'Server Key'), authMessage);
    return `${withoutProof},p=${proof.toString('base64')}`;
  }

  /** Check server-final-message: proof that the server knew the password too. */
  verify(serverFinal: string): void {
    const fields = parse(serverFinal);
    const error = fields.get('e');
    if (error) throw new ScramError(`the server rejected the login: ${error}`);
    const verifier = Buffer.from(fields.get('v') ?? '', 'base64');
    if (!this.#serverSignature || verifier.length !== this.#serverSignature.length || !timingSafeEqual(verifier, this.#serverSignature)) {
      throw new ScramError("the server's signature does not match; it does not know the password");
    }
  }

  #hmac(key: Buffer, data: string): Buffer {
    return createHmac(this.#algorithm, key).update(data).digest();
  }
}

function parse(message: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of message.split(',')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
  }
  return fields;
}
