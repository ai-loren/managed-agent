/**
 * The `sqs` and `kafka` connector types, and which brokers they may reach.
 *
 * A pull connector makes the control plane open connections to an address a
 * workspace admin typed in. Unchecked, that is a way to reach whatever the
 * control plane can — an internal service, a metadata endpoint, a port scan
 * read off error messages. So the brokers are an operator's list, as hook
 * callback origins are, and with no list a pull connector cannot be activated.
 */

import { MaError, validationError } from '@ma/core';
import { kafkaConfigSchema, parseOrThrow, sqsConfigSchema, type Connector } from '@ma/contracts';

import type { ConnectorAdapter, VerifyResult } from '../adapter.ts';
import { exactOrigin, redactCredentials } from '../origin.ts';

/** `MA_SQS_ENDPOINTS`: AWS's own endpoints, and/or exact origins. */
export interface SqsEndpointPolicy {
  aws: boolean;
  origins: readonly string[];
}

const AWS_SQS_HOST = /^sqs\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;
const AWS_LEGACY_QUEUE_HOST = /^(?:([a-z0-9-]+)\.)?queue\.amazonaws\.com(\.cn)?$/;

/** Parse `MA_SQS_ENDPOINTS`: comma-separated, `aws` and/or origins like `http://elasticmq:9324`. */
export function parseSqsEndpoints(raw: string | undefined): SqsEndpointPolicy {
  const entries = (raw ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const origins: string[] = [];
  let aws = false;
  for (const entry of entries) {
    if (entry === 'aws') {
      aws = true;
      continue;
    }
    const origin = exactOrigin(entry);
    if (origin === undefined) {
      throw validationError(
        `MA_SQS_ENDPOINTS expects \`aws\` and/or http(s) origins like http://elasticmq:9324, comma-separated; ` +
          `got ${JSON.stringify(redactCredentials(entry))}. Give each as scheme://host[:port] alone, with no path ` +
          '(the queue URL carries it), query, fragment or credentials.',
      );
    }
    origins.push(origin);
  }
  return { aws, origins };
}

function sqsEndpointAllowed(policy: SqsEndpointPolicy, url: URL): boolean {
  if (policy.origins.includes(url.origin)) return true;
  return (
    policy.aws &&
    url.protocol === 'https:' &&
    url.port === '' &&
    (AWS_SQS_HOST.test(url.hostname) || AWS_LEGACY_QUEUE_HOST.test(url.hostname))
  );
}

/** The signing region: configured, or read from an AWS queue URL. */
export function sqsRegion(url: URL, configured: string | undefined): string | undefined {
  if (configured) return configured;
  const modern = AWS_SQS_HOST.exec(url.hostname);
  if (modern) return modern[1];
  const legacy = AWS_LEGACY_QUEUE_HOST.exec(url.hostname);
  if (legacy) return legacy[1] ?? 'us-east-1';
  return undefined;
}

/**
 * Check an SQS connector can run here, with the reason it cannot. Run at
 * activation and again each time the consumer connects, so taking an endpoint
 * off the list stops a connector that was activated while it was on it.
 */
export function checkSqsConnector(connector: Connector, policy: SqsEndpointPolicy): void {
  const config = parseOrThrow(sqsConfigSchema, connector.config);
  const url = new URL(config.queueUrl);
  if (!sqsEndpointAllowed(policy, url)) {
    throw new MaError({
      code: 'PULL_ENDPOINT_NOT_ALLOWED',
      category: 'permission',
      message:
        `The queue is at ${url.origin}, which MA_SQS_ENDPOINTS does not allow ` +
        `(it allows: ${describeSqsPolicy(policy)}). ` +
        'An operator adds the origin to MA_SQS_ENDPOINTS, or `aws` for the AWS SQS endpoints.',
      details: { connectorId: connector.id },
    });
  }
  if (!sqsRegion(url, config.region)) {
    throw validationError(
      `Set config.region: ${url.origin} is not an AWS SQS endpoint, so the signing region cannot be read from the queue URL.`,
      { connectorId: connector.id },
    );
  }
  if (!connector.secretCredentialId) {
    throw validationError(
      `An SQS connector needs a credential holding the secret access key for ${config.accessKeyId}; ` +
        'create one and set secretCredentialId before activating.',
      { connectorId: connector.id },
    );
  }
}

function describeSqsPolicy(policy: SqsEndpointPolicy): string {
  const parts = [...(policy.aws ? ['aws'] : []), ...policy.origins];
  return parts.length > 0 ? parts.join(', ') : 'nothing — it is unset';
}

/** Parse `MA_KAFKA_BROKERS`: comma-separated `host:port` or `*.domain:port`. */
export function parseKafkaBrokers(raw: string | undefined): string[] {
  const entries = (raw ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (!/^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+:\d{1,5}$/.test(entry) && !/^\[[0-9a-f:.]+\]:\d{1,5}$/.test(entry)) {
      throw validationError(
        `MA_KAFKA_BROKERS expects host:port entries (or *.domain:port to allow a cluster's brokers), comma-separated; got ${JSON.stringify(entry)}.`,
      );
    }
  }
  return entries;
}

/**
 * Whether the control plane may connect to `address` (`host:port`).
 *
 * Checked for the bootstrap brokers and again for every broker the cluster
 * advertises, since those are where the consumer actually connects.
 */
export function brokerAllowed(allowed: readonly string[], address: string): boolean {
  const candidate = address.toLowerCase();
  const split = candidate.lastIndexOf(':');
  const host = candidate.slice(0, split);
  const port = candidate.slice(split + 1);
  return allowed.some((entry) => {
    if (entry === candidate) return true;
    if (!entry.startsWith('*.')) return false;
    const at = entry.lastIndexOf(':');
    return entry.slice(at + 1) === port && host.endsWith(entry.slice(1, at));
  });
}

export function brokerNotAllowed(address: string, allowed: readonly string[], role: string): MaError {
  return new MaError({
    code: 'PULL_ENDPOINT_NOT_ALLOWED',
    category: 'permission',
    message:
      `Kafka broker ${address} (${role}) is not in MA_KAFKA_BROKERS ` +
      `(it allows: ${allowed.length > 0 ? allowed.join(', ') : 'nothing — it is unset'}). ` +
      'An operator adds it, or a *.domain:port pattern covering the cluster, to MA_KAFKA_BROKERS.',
  });
}

/** Check a Kafka connector can run here, with the reason it cannot. */
export function checkKafkaConnector(connector: Connector, allowed: readonly string[]): void {
  const config = parseOrThrow(kafkaConfigSchema, connector.config);
  for (const broker of config.brokers) {
    if (!brokerAllowed(allowed, broker)) throw brokerNotAllowed(broker, allowed, 'a bootstrap broker');
  }
  if (config.sasl && !connector.secretCredentialId) {
    throw validationError(
      `SASL ${config.sasl.mechanism} needs ${config.sasl.username}'s password: create a credential holding it ` +
        'and set secretCredentialId before activating.',
      { connectorId: connector.id },
    );
  }
}

function pullAdapter(type: 'sqs' | 'kafka', check: (connector: Connector) => void): ConnectorAdapter {
  return {
    type,
    verify(): Promise<VerifyResult> {
      // The consumer reads the broker; an HTTP endpoint that accepted deliveries
      // for this connector would be a second, unauthenticated way in.
      return Promise.resolve({
        ok: false,
        reason: `${type} connectors read from their broker and accept no inbound requests`,
      });
    },
    normalize() {
      return Promise.resolve(undefined);
    },
    validateConfig(connector) {
      check(connector);
    },
  };
}

export function sqsAdapter(options: { endpoints: SqsEndpointPolicy }): ConnectorAdapter {
  return pullAdapter('sqs', (connector) => checkSqsConnector(connector, options.endpoints));
}

export function kafkaAdapter(options: { brokers: readonly string[] }): ConnectorAdapter {
  return pullAdapter('kafka', (connector) => checkKafkaConnector(connector, options.brokers));
}
