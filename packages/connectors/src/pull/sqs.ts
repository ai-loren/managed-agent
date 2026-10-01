/**
 * The SQS consumer: long-poll `ReceiveMessage`, delete what was delivered.
 *
 * Speaks SQS's JSON protocol over `fetch` with a SigV4 signature, so there is
 * no AWS SDK to carry. A message is deleted only after it has a receipt (or was
 * dropped by the filter); until then the queue's visibility timeout is what
 * brings it back if this process dies, and the receipt's dedupe is what makes
 * that second delivery harmless.
 */

import { createHash } from 'node:crypto';

import { MaError, type Clock, type Logger } from '@ma/core';
import { parseOrThrow, sqsConfigSchema, type Connector } from '@ma/contracts';

import { checkSqsConnector, sqsRegion, type SqsEndpointPolicy } from './adapters.ts';
import type { PulledMessage } from './message.ts';
import { signV4, type AwsCredentials } from './sigv4.ts';
import type { PullSource, PullSourceFactory } from './supervisor.ts';

export interface SqsMessage {
  MessageId: string;
  ReceiptHandle: string;
  Body: string;
  MD5OfBody?: string;
  Attributes?: Record<string, string>;
}

export interface SqsClientOptions {
  queueUrl: string;
  region: string;
  credentials: AwsCredentials;
  clock: Clock;
  /** Ceiling on one call beyond its long poll. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The two calls the consumer makes, plus `call` for anything else (tests create queues with it). */
export class SqsClient {
  readonly #queueUrl: string;
  readonly #endpoint: URL;
  readonly #region: string;
  readonly #credentials: AwsCredentials;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(options: SqsClientOptions) {
    this.#queueUrl = options.queueUrl;
    this.#endpoint = new URL('/', options.queueUrl);
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#clock = options.clock;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async receive(
    max: number,
    waitSeconds: number,
    visibilityTimeout: number | undefined,
    signal?: AbortSignal,
  ): Promise<SqsMessage[]> {
    const response = await this.call<{ Messages?: SqsMessage[] }>(
      'ReceiveMessage',
      {
        QueueUrl: this.#queueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(10, max)),
        WaitTimeSeconds: waitSeconds,
        ...(visibilityTimeout !== undefined ? { VisibilityTimeout: visibilityTimeout } : {}),
        AttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
      },
      signal,
      waitSeconds * 1000 + this.#timeoutMs,
    );
    return response.Messages ?? [];
  }

  /** Delete by receipt handle; returns the handles SQS could not delete. */
  async deleteBatch(handles: readonly string[]): Promise<{ handle: string; code: string; message: string }[]> {
    const failed: { handle: string; code: string; message: string }[] = [];
    for (let start = 0; start < handles.length; start += 10) {
      const chunk = handles.slice(start, start + 10);
      const response = await this.call<{ Failed?: { Id: string; Code?: string; Message?: string }[] }>(
        'DeleteMessageBatch',
        { QueueUrl: this.#queueUrl, Entries: chunk.map((handle, index) => ({ Id: String(index), ReceiptHandle: handle })) },
      );
      for (const entry of response.Failed ?? []) {
        failed.push({ handle: chunk[Number(entry.Id)] ?? '', code: entry.Code ?? '', message: entry.Message ?? '' });
      }
    }
    return failed;
  }

  async call<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.#timeoutMs): Promise<T> {
    const payload = JSON.stringify(body);
    const headers = signV4({
      method: 'POST',
      url: this.#endpoint,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${action}` },
      body: payload,
      region: this.#region,
      service: 'sqs',
      credentials: this.#credentials,
      now: this.#clock.now(),
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: 'POST',
        headers,
        body: payload,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MaError({
        code: 'SQS_UNAVAILABLE',
        category: 'unavailable',
        message: `Could not reach SQS at ${this.#endpoint.origin} for ${action}: ${error instanceof Error ? error.message : String(error)}.`,
        cause: error,
      });
    }
    const text = await response.text();
    if (response.ok) return (text ? JSON.parse(text) : {}) as T;
    throw this.#failure(action, response, text);
  }

  #failure(action: string, response: Response, text: string): MaError {
    let type = response.headers.get('x-amzn-errortype') ?? '';
    let message = '';
    try {
      const parsed = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
      type = parsed.__type ?? type;
      message = parsed.message ?? parsed.Message ?? '';
    } catch {
      message = text.slice(0, 300);
    }
    type = type.slice(type.lastIndexOf('#') + 1).split(':')[0] ?? type;
    const said = `${type || `HTTP ${response.status}`}${message ? `: ${message}` : ''}`;

    if (/QueueDoesNotExist|NonExistentQueue/.test(type)) {
      return new MaError({
        code: 'SQS_QUEUE_NOT_FOUND',
        category: 'not_found',
        message: `SQS says ${this.#queueUrl} does not exist (${said}). Check config.queueUrl, and config.region if set.`,
      });
    }
    if (response.status === 401 || response.status === 403 || /Signature|ClientToken|UnrecognizedClient|AccessDenied|Authentication|ExpiredToken|AuthFailure/.test(type)) {
      return new MaError({
        code: 'SQS_ACCESS_DENIED',
        category: 'permission',
        message:
          `SQS refused ${action} for access key ${this.#credentials.accessKeyId} (${said}). ` +
          "Check config.accessKeyId, the secret access key in the connector's credential, and that the key " +
          'may sqs:ReceiveMessage and sqs:DeleteMessage on the queue.',
      });
    }
    if (response.status >= 500 || /Throttl|RequestThrottled|OverLimit|ServiceUnavailable/.test(type)) {
      return new MaError({
        code: 'SQS_UNAVAILABLE',
        category: 'unavailable',
        message: `SQS answered ${action} with ${response.status} (${said}); retrying.`,
      });
    }
    return new MaError({
      code: 'SQS_REQUEST_FAILED',
      category: 'validation',
      message: `SQS rejected ${action} with ${response.status} (${said}). Check the connector's config against the queue.`,
    });
  }
}

export interface SqsSourceOptions {
  clock: Clock;
  endpoints: SqsEndpointPolicy;
  logger?: Logger;
}

export function sqsSourceFactory(options: SqsSourceOptions): PullSourceFactory {
  return {
    settings(connector) {
      const config = parseOrThrow(sqsConfigSchema, connector.config);
      return { maxInFlight: config.maxInFlight, filter: config };
    },

    async open(connector: Connector, secret: string | undefined): Promise<PullSource> {
      checkSqsConnector(connector, options.endpoints);
      const config = parseOrThrow(sqsConfigSchema, connector.config);
      if (!secret) {
        throw new MaError({
          code: 'PULL_CREDENTIAL_UNUSABLE',
          category: 'precondition',
          message:
            "The connector's credential is missing, revoked or expired, so the queue cannot be read. " +
            `Bind a usable credential holding the secret access key for ${config.accessKeyId}.`,
        });
      }
      const client = new SqsClient({
        queueUrl: config.queueUrl,
        region: sqsRegion(new URL(config.queueUrl), config.region)!,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: secret },
        clock: options.clock,
      });
      const logger = options.logger?.child({ connectorId: connector.id });

      return {
        async receive(limit, signal) {
          const received = await client.receive(limit, config.waitTimeSeconds, config.visibilityTimeoutSeconds, signal);
          const messages: PulledMessage[] = [];
          const handles: string[] = [];
          for (const message of received) {
            if (message.MD5OfBody && md5(message.Body) !== message.MD5OfBody) {
              // Not processed and not deleted: it comes back after the visibility
              // timeout, and the queue's redrive policy moves it aside if it never
              // arrives intact.
              logger?.error('an SQS message failed its MD5 check; leaving it on the queue', {
                messageId: message.MessageId,
              });
              continue;
            }
            const group = message.Attributes?.MessageGroupId;
            messages.push({
              transportId: message.MessageId,
              body: Buffer.from(message.Body, 'utf8'),
              ...(group ? { key: group } : {}),
            });
            handles.push(message.ReceiptHandle);
          }
          return {
            messages,
            async ack() {
              if (handles.length === 0) return;
              const failed = await client.deleteBatch(handles);
              if (failed.length > 0) {
                // Each one comes back after its visibility timeout and is
                // recognised as already delivered, so this costs a re-read.
                logger?.warn('SQS did not delete some delivered messages', {
                  failed: failed.map(({ code, message }) => ({ code, message })),
                });
              }
            },
          };
        },
        close() {
          return Promise.resolve();
        },
      };
    },
  };
}

function md5(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}
