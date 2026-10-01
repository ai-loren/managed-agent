/**
 * SCRAM as Kafka uses it: the shared client with Kafka's iteration bounds.
 */

import { ScramClient as Scram, ScramError } from '@ma/core';

export { ScramError };

/** Kafka's floor for SCRAM iterations; fewer from a server is a downgrade to refuse. */
const MIN_ITERATIONS = 4096;
/**
 * Kafka's ceiling: no broker stores credentials with more, so a server asking
 * for more is not one, and it would be buying minutes of CPU per login.
 */
const MAX_ITERATIONS = 16_384;

export class ScramClient extends Scram {
  constructor(algorithm: 'sha256' | 'sha512', username: string, password: string, nonce?: string) {
    super(algorithm, username, password, { minIterations: MIN_ITERATIONS, maxIterations: MAX_ITERATIONS, ...(nonce ? { nonce } : {}) });
  }
}
