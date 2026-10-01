/**
 * AWS Signature Version 4, for the SQS consumer.
 *
 * Small enough to own rather than take the AWS SDK for: canonical request,
 * string to sign, derived key, HMAC. The tests pin it to AWS's published
 * examples, because the emulators the e2e runs against do not check
 * signatures — a wrong byte here would pass every local test and fail against
 * AWS.
 */

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequest {
  method: string;
  url: URL;
  /** Headers to sign besides `host` and `x-amz-date`, which are added. */
  headers: Readonly<Record<string, string>>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Signing time, epoch milliseconds. */
  now: number;
}

/** The headers to send: the input headers plus `x-amz-date`, `authorization` (and the session token). */
export function signV4(request: SignRequest): Record<string, string> {
  const amzDate = new Date(request.now).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  headers['x-amz-date'] = amzDate;
  if (request.credentials.sessionToken) headers['x-amz-security-token'] = request.credentials.sessionToken;

  const signed: Record<string, string> = { ...headers, host: request.url.host };
  const names = Object.keys(signed).sort();
  const canonical = canonicalRequest(request, signed, names);
  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(request.credentials.secretAccessKey, date, request.region, request.service))
    .update(toSign)
    .digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}

export function canonicalRequest(
  request: Pick<SignRequest, 'method' | 'url' | 'body'>,
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): string {
  // Each segment of the already-encoded path is encoded again: SigV4 encodes
  // paths twice for every service except S3.
  const path = request.url.pathname.split('/').map(encode).join('/') || '/';
  const query = [...request.url.searchParams]
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return [
    request.method.toUpperCase(),
    path,
    query,
    ...names.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}`),
    '',
    names.join(';'),
    sha256(request.body),
  ].join('\n');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 3986 unreserved characters pass; everything else is percent-encoded. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
