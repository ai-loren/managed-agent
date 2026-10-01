import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ALLOWED_HOSTS } from '@ma/contracts';

import { egressProxyEnv } from '../src/index.ts';

const SECRET = 'a-shared-secret-of-at-least-thirty-two-chars';

/** Linux's limit on one environment variable (MAX_ARG_STRLEN); past it the sandbox cannot start. */
const MAX_ENV_VALUE = 128 * 1024;

test('the largest allowlist a version may declare fits in one environment variable', () => {
  const hosts = Array.from({ length: MAX_ALLOWED_HOSTS }, (_, index) => `${String(index).padStart(3, '0')}${'h'.repeat(240)}.example.test`);
  assert.ok(hosts.every((host) => host.length === 256));
  const env = egressProxyEnv({
    proxy: 'http://ma-egress-proxy.managed-agent.svc:3128',
    secret: SECRET,
    sandboxId: 'sb_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    hosts,
    expiresAt: 1_700_000_000_000,
    controlPlaneUrl: 'http://managed-agent.managed-agent.svc:8080',
  });
  assert.ok(env.HTTPS_PROXY!.length < MAX_ENV_VALUE, `HTTPS_PROXY is ${env.HTTPS_PROXY!.length} characters`);
});

test('the control plane is exempt from the proxy by name, and by name and port', () => {
  const env = egressProxyEnv({
    proxy: 'http://ma-egress-proxy.managed-agent.svc:3128',
    sandboxId: 'sb_one',
    hosts: [],
    expiresAt: 1_700_000_000_000,
    controlPlaneUrl: 'http://managed-agent.managed-agent.svc:8080',
  });
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,managed-agent.managed-agent.svc,managed-agent.managed-agent.svc:8080');
  assert.equal(env.no_proxy, env.NO_PROXY);
});
