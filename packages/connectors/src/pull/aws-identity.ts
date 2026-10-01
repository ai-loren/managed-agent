/**
 * AWS credentials the platform finds for itself, and roles it assumes with them.
 *
 * For SQS connectors that carry no access key of their own: `assume-role`
 * reads with a role the customer names, assumed with the platform's identity;
 * `platform-identity` reads with that identity directly. The identity is
 * looked for where the AWS SDKs look, in their order: access keys in the
 * environment, a web identity token (IRSA on EKS), the container credentials
 * endpoint (ECS, EKS Pod Identity), then the EC2 instance metadata service.
 * No SDK: each is one or two HTTP calls.
 */

import { readFile } from 'node:fs/promises';

import { MaError, type Clock } from '@ma/core';

import { signV4, type AwsCredentials } from './sigv4.ts';

export interface AwsCredentialProvider {
  /** Current credentials, renewed before they expire. */
  get(): Promise<AwsCredentials>;
  /** Drop what is cached, after a call was refused for an expired token. */
  invalidate(): void;
  /** Whose credentials these are, for messages. Never a secret. */
  readonly describe: string;
}

export interface AwsIdentityOptions {
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  /** Where the instance metadata service is; for tests. */
  imdsEndpoint?: string;
  /** Where the container credentials endpoint is, for a relative URI; for tests. */
  containerEndpoint?: string;
  /** STS's endpoint for a region; for tests. */
  stsEndpoint?: (region: string) => string;
}

interface Expiring {
  credentials: AwsCredentials;
  expiresAt?: number;
}

/** Renewed this long before they expire, so a call signed near the end does not outlive them. */
const RENEW_BEFORE_MS = 5 * 60_000;
/** Short: off EC2 nothing answers, and the chain should say so promptly. */
const IMDS_TIMEOUT_MS = 2_000;
const HTTP_TIMEOUT_MS = 10_000;

/** STS's regional endpoint; China's regions are under their own domain. */
export function stsEndpoint(region: string): string {
  return `https://sts.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}/`;
}

function unavailable(message: string, cause?: unknown): MaError {
  return new MaError({ code: 'AWS_IDENTITY_UNAVAILABLE', category: 'unavailable', retryable: true, message, ...(cause ? { cause } : {}) });
}

/**
 * One fetch of credentials at a time, and none while the last ones are good.
 * A renewal that fails before they expire keeps them: the next call tries
 * again, and only expired credentials turn a failed renewal into an error.
 */
function cached(clock: Clock, describe: string, load: () => Promise<Expiring>): AwsCredentialProvider {
  let current: Expiring | undefined;
  let loading: Promise<Expiring> | undefined;
  return {
    describe,
    async get() {
      if (current && (current.expiresAt === undefined || clock.now() < current.expiresAt - RENEW_BEFORE_MS)) {
        return current.credentials;
      }
      loading ??= load().finally(() => {
        loading = undefined;
      });
      try {
        current = await loading;
      } catch (error) {
        if (current?.expiresAt !== undefined && clock.now() < current.expiresAt) return current.credentials;
        throw error;
      }
      return current.credentials;
    },
    invalidate() {
      current = undefined;
    },
  };
}

/** The platform's own AWS identity, from the first place that has one. */
export function awsIdentity(options: AwsIdentityOptions): AwsCredentialProvider {
  const { env, clock } = options;
  const sts = options.stsEndpoint ?? stsEndpoint;
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1';

  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    const credentials: AwsCredentials = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    };
    return { describe: `the platform's access key ${env.AWS_ACCESS_KEY_ID}`, get: () => Promise.resolve(credentials), invalidate: () => {} };
  }

  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) {
    const roleArn = env.AWS_ROLE_ARN;
    const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
    return cached(clock, `the platform's web identity role ${roleArn}`, async () => {
      let token: string;
      try {
        // Read each time: the kubelet rotates the projected token.
        token = (await readFile(tokenFile, 'utf8')).trim();
      } catch (error) {
        throw unavailable(`AWS_WEB_IDENTITY_TOKEN_FILE (${tokenFile}) could not be read; mount the service account token there.`, error);
      }
      const body = new URLSearchParams({
        Action: 'AssumeRoleWithWebIdentity',
        Version: '2011-06-15',
        RoleArn: roleArn,
        RoleSessionName: env.AWS_ROLE_SESSION_NAME ?? 'managed-agent',
        WebIdentityToken: token,
      }).toString();
      return stsCredentials(
        await stsPost(sts(region), body, {}),
        `assume ${roleArn} with the web identity token`,
        "The role's trust policy must trust the cluster's OIDC provider for this pod's service account (sts:AssumeRoleWithWebIdentity).",
      );
    });
  }

  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    const url =
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI ??
      `${options.containerEndpoint ?? 'http://169.254.170.2'}${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
    return cached(clock, "the platform's container role", async () => {
      let authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
      if (!authorization && env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) {
        authorization = (await readFile(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8')).trim();
      }
      const response = await get(url, authorization ? { authorization } : {}, HTTP_TIMEOUT_MS, 'the container credentials endpoint');
      return jsonCredentials(await response.text(), 'the container credentials endpoint');
    });
  }

  const imds = options.imdsEndpoint ?? 'http://169.254.169.254';
  return cached(clock, "the platform's EC2 instance role", async () => {
    let token: string;
    try {
      const response = await fetch(`${imds}/latest/api/token`, {
        method: 'PUT',
        headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' },
        signal: AbortSignal.timeout(IMDS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      token = await response.text();
    } catch (error) {
      throw unavailable(
        'No AWS identity for the platform: no access key (AWS_ACCESS_KEY_ID with AWS_SECRET_ACCESS_KEY), no web identity token (AWS_WEB_IDENTITY_TOKEN_FILE and ' +
          'AWS_ROLE_ARN), no container credentials endpoint, and the EC2 instance metadata service did not answer. ' +
          'Give the control plane one of these, or use access keys on the connector.',
        error,
      );
    }
    const headers = { 'x-aws-ec2-metadata-token': token };
    const roles = await get(`${imds}/latest/meta-data/iam/security-credentials/`, headers, IMDS_TIMEOUT_MS, 'the instance metadata service');
    const role = (await roles.text()).split('\n')[0]?.trim();
    if (!role) throw unavailable('The EC2 instance has no IAM role attached; attach an instance profile, or use access keys on the connector.');
    const credentials = await get(`${imds}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, headers, IMDS_TIMEOUT_MS, 'the instance metadata service');
    return jsonCredentials(await credentials.text(), 'the instance metadata service');
  });
}

export interface AssumeRoleOptions {
  /** The identity that assumes the role. */
  base: AwsCredentialProvider;
  roleArn: string;
  /** Required by the role's trust policy, so another tenant of the platform cannot assume it. */
  externalId: string;
  sessionName: string;
  region: string;
  clock: Clock;
  stsEndpoint?: (region: string) => string;
}

/** Temporary credentials for `roleArn`, assumed with `base` and renewed before they expire. */
export function assumeRole(options: AssumeRoleOptions): AwsCredentialProvider {
  const endpoint = (options.stsEndpoint ?? stsEndpoint)(options.region);
  return cached(options.clock, `role ${options.roleArn}`, async () => {
    const base = await options.base.get();
    const body = new URLSearchParams({
      Action: 'AssumeRole',
      Version: '2011-06-15',
      RoleArn: options.roleArn,
      RoleSessionName: options.sessionName,
      ExternalId: options.externalId,
      DurationSeconds: '3600',
    }).toString();
    const headers = signV4({
      method: 'POST',
      url: new URL(endpoint),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      region: options.region,
      service: 'sts',
      credentials: base,
      now: options.clock.now(),
    });
    const answer = await stsPost(endpoint, body, headers);
    if (answer.error?.startsWith('ExpiredToken')) {
      // The platform's credentials were refused, not the role: renewing the
      // role's credentials alone would sign with the same expired ones again.
      options.base.invalidate();
      throw unavailable(`AWS STS refused ${options.base.describe} as expired while assuming ${options.roleArn}; they are fetched again on the next attempt.`);
    }
    if (answer.error) {
      throw new MaError({
        code: 'AWS_ASSUME_ROLE_FAILED',
        category: 'permission',
        message:
          `The platform (${options.base.describe}) could not assume ${options.roleArn} (${answer.error}). The role's trust ` +
          `policy must let the platform's principal sts:AssumeRole with sts:ExternalId "${options.externalId}" — this ` +
          "workspace's id — and the platform's identity needs sts:AssumeRole on the role.",
      });
    }
    return stsCredentials(answer, `assume ${options.roleArn}`);
  });
}

async function get(url: string, headers: Record<string, string>, timeoutMs: number, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw unavailable(`Could not reach ${what} for the platform's AWS credentials.`, error);
  }
  if (!response.ok) throw unavailable(`${what} answered ${response.status} when asked for the platform's AWS credentials.`);
  return response;
}

async function stsPost(endpoint: string, body: string, headers: Record<string, string>): Promise<{ xml: string; error?: string }> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw unavailable(`Could not reach AWS STS at ${new URL(endpoint).origin}.`, error);
  }
  const xml = await response.text();
  if (response.ok) return { xml };
  if (response.status >= 500 || /Throttl/.test(tag(xml, 'Code') ?? '')) {
    throw unavailable(`AWS STS answered ${response.status} (${tag(xml, 'Code') ?? 'no code'}); retrying.`);
  }
  return { xml, error: `${tag(xml, 'Code') ?? `HTTP ${response.status}`}: ${tag(xml, 'Message') ?? ''}`.trim() };
}

function stsCredentials(answer: { xml: string; error?: string }, what: string, hint = ''): Expiring {
  if (answer.error) {
    throw new MaError({ code: 'AWS_ASSUME_ROLE_FAILED', category: 'permission', message: `AWS STS refused to ${what} (${answer.error}). ${hint}`.trim() });
  }
  const accessKeyId = tag(answer.xml, 'AccessKeyId');
  const secretAccessKey = tag(answer.xml, 'SecretAccessKey');
  const sessionToken = tag(answer.xml, 'SessionToken');
  const expiration = tag(answer.xml, 'Expiration');
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw unavailable(`AWS STS answered a request to ${what} without credentials.`);
  return { credentials: { accessKeyId, secretAccessKey, sessionToken }, ...expiry(expiration) };
}

function jsonCredentials(text: string, what: string): Expiring {
  let parsed: { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw unavailable(`${what} answered with something other than credentials.`);
  }
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey) throw unavailable(`${what} answered without credentials.`);
  return {
    credentials: {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      ...(parsed.Token ? { sessionToken: parsed.Token } : {}),
    },
    ...expiry(parsed.Expiration),
  };
}

function expiry(value: string | undefined): { expiresAt?: number } {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? { expiresAt: at } : {};
}

/** A tag's text in AWS's XML answers, which carry no attributes or nesting where these are read. */
function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match?.[1]
    ?.replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
