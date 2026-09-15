/**
 * Regression tests for sandbox-boundary escapes.
 *
 * Each test here corresponds to a vulnerability that shipped and was found by
 * adversarial review rather than by the suite. They are written from the
 * attacker's side — "a credential cannot do X" — because that is the question
 * the original tests failed to ask. The code they cover looked correct, and
 * every one of these would have passed against the broken version if phrased
 * as "the happy path still works".
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, systemClock } from '@ma/core';
import type { SandboxSpec } from '@ma/contracts';

import { ContainerSandboxDriver, type ProvisionRequest } from '../src/index.ts';
import { isLoopbackControlPlane, sanitizeEnv, reservedKeys } from '../src/env.ts';

let scriptDir: string;
let fakeBinary: string;
let callLog: string;

const HEALTHY = `
case "$1" in
  run)     echo "container-id-abc" ;;
  logs)    echo "AGENT_CORE_READY" ;;
  inspect) echo "true" ;;
  port)    echo "127.0.0.1:49154" ;;
  rm)      echo "removed" ;;
  ps)      echo "" ;;
  *)       exit 0 ;;
esac
`;

async function fakeContainerCli(behaviour: string): Promise<string> {
  const path = join(scriptDir, 'fake-docker');
  await writeFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callLog}"\n${behaviour}\n`,
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: 'managed-agent/runtime:latest',
    cpu: 2,
    memoryMb: 4096,
    diskMb: 20_480,
    idleTimeoutSeconds: 900,
    maxLifetimeSeconds: 86_400,
    network: { egress: 'allowlist', allowedHosts: [] },
    setupCommands: [],
    allowReuse: true,
    mounts: [],
    runAs: '',
    ...overrides,
  };
}

function makeRequest(
  spec = makeSpec(),
  env: Record<string, string> = { CUSTOM: 'value' },
): ProvisionRequest {
  return {
    sandboxId: 'SB_01ARZ3ND',
    workspaceId: 'ws_01ARZ3ND',
    spec,
    env,
    runtimeToken: 'runtime-token-secret',
    controlPlaneUrl: 'http://127.0.0.1:8080',
  };
}

async function runArgs(): Promise<string> {
  const content = await readFile(callLog, 'utf8').catch(() => '');
  return content.split('\n').find((line) => line.startsWith('run ')) ?? '';
}

beforeEach(async () => {
  scriptDir = await mkdtemp(join(tmpdir(), 'ma-escape-'));
  callLog = join(scriptDir, 'calls.log');
  await writeFile(callLog, '', 'utf8');
  fakeBinary = await fakeContainerCli(HEALTHY);
});

afterEach(async () => {
  await rm(scriptDir, { recursive: true, force: true });
});

describe('credential-supplied environment', () => {
  test('cannot redirect the control plane', async () => {
    // The original bug: `...request.env` spread last, so a credential won. An
    // attacker-controlled MA_CONTROL_PLANE_URL points the agent's event stream
    // and credential exchange at a host of their choosing.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(
      makeRequest(makeSpec({ network: { egress: 'allow', allowedHosts: [] } }), {
        MA_CONTROL_PLANE_URL: 'http://attacker.example',
        MA_RUNTIME_TOKEN: 'forged',
      }),
    );

    const run = await runArgs();
    assert.ok(
      run.includes('--env MA_CONTROL_PLANE_URL=http://127.0.0.1:8080'),
      'the platform control-plane URL must survive',
    );
    assert.ok(!run.includes('attacker.example'), 'the credential value must not appear at all');
    assert.ok(run.includes('--env MA_RUNTIME_TOKEN=runtime-token-secret'));
    assert.ok(!run.includes('forged'));
  });

  test('cannot set loader variables that execute code', async () => {
    // LD_PRELOAD and NODE_OPTIONS are read by the loader before any of our code
    // runs, so they are code execution wearing a configuration costume.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(
      makeRequest(makeSpec({ network: { egress: 'allow', allowedHosts: [] } }), {
        LD_PRELOAD: '/tmp/evil.so',
        NODE_OPTIONS: '--require /tmp/evil.js',
        PATH: '/tmp/evil/bin',
        BASH_ENV: '/tmp/evil.sh',
        SAFE: 'kept',
      }),
    );

    const run = await runArgs();
    for (const forbidden of ['evil.so', 'evil.js', '/tmp/evil/bin', 'evil.sh']) {
      assert.ok(!run.includes(forbidden), `${forbidden} must be stripped`);
    }
    assert.ok(run.includes('--env SAFE=kept'), 'ordinary variables still pass through');
  });

  test('sanitizeEnv reports what it removed', () => {
    // An operator whose variable silently vanished needs to be able to find out
    // why, so the removal is inspectable rather than just silent.
    const env = { MA_RUNTIME_TOKEN: 'x', PATH: '/evil', PROJECT: 'ok' };
    assert.deepEqual(sanitizeEnv(env), { PROJECT: 'ok' });
    assert.deepEqual(reservedKeys(env).sort(), ['MA_RUNTIME_TOKEN', 'PATH']);
  });

  test('isLoopbackControlPlane flags unreachable-from-a-sandbox hosts', () => {
    for (const url of [
      'http://127.0.0.1:8080',
      'http://127.0.0.5:8080',
      'http://localhost:8080',
      'https://[::1]:8080',
      'http://0.0.0.0:8080',
      'http://localhost.:8080',
      'http://LOCALHOST:8080',
      'http://2130706433:8080',
      'https://[::ffff:127.0.0.1]:8080',
    ]) {
      assert.equal(isLoopbackControlPlane(url), true, `${url} must be flagged loopback`);
    }
    for (const url of [
      'http://control-plane:8080',
      'http://host.docker.internal:8080',
      'http://10.0.0.5:8080',
      'https://ma.svc.cluster.local',
    ]) {
      assert.equal(isLoopbackControlPlane(url), false, `${url} must be routable`);
    }
    // An unparseable URL is a different misconfiguration; do not swallow it here.
    assert.equal(isLoopbackControlPlane('not a url'), false);
  });

  test('a credential cannot set proxy variables', () => {
    // Proxy vars are the platform's egress control. A credential-supplied
    // HTTP_PROXY could redirect a filtered sandbox's traffic to an attacker's
    // proxy; an empty NO_PROXY could punch a hole in the allowlist. The reserved
    // rule matches the proxy *class* (any `*_PROXY`), so FTP_PROXY and future
    // variants are covered too, in either casing.
    const env = {
      HTTP_PROXY: 'http://evil:3128',
      https_proxy: 'http://evil:3128',
      NO_PROXY: '',
      no_proxy: '*',
      ALL_PROXY: 'socks5://evil',
      FTP_PROXY: 'http://evil:3128',
      ftp_proxy: 'http://evil:3128',
      PROJECT: 'ok',
    };
    assert.deepEqual(sanitizeEnv(env), { PROJECT: 'ok' }, 'every proxy var is stripped');
  });
});

describe('egress policy', () => {
  const PROXY = { egressProxy: 'http://ma-egress:3128', internalNetwork: 'ma-internal' };
  // A routable control-plane URL: a restricted sandbox must reach the control
  // plane, and a loopback address is unreachable from inside a container.
  const ROUTABLE = 'http://control-plane:8080';
  function restrictedRequest(spec = makeSpec()): ProvisionRequest {
    return { ...makeRequest(spec), controlPlaneUrl: ROUTABLE };
  }

  test('an empty allowlist is refused without the egress infra, not silently dead', async () => {
    // This is the schema default. It used to resolve to `--network none` — a
    // sandbox with no route to the control plane, which can never bootstrap.
    // A restricted sandbox needs the egress-less internal network (with the
    // control plane on it) to phone home; without that infra, refuse loudly.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    const error = await driver
      .provision(restrictedRequest(makeSpec({ network: { egress: 'allowlist', allowedHosts: [] } })))
      .then(() => undefined, (caught: unknown) => caught);

    assert.ok(error instanceof MaError, 'provisioning must fail loudly');
    assert.equal(error.code, 'SANDBOX_EGRESS_UNSUPPORTED');
    assert.match(error.message, /'allow'/);
    assert.equal(await runArgs(), '', 'no container should have been started');
  });

  test('an allowlist naming hosts is refused rather than silently widened', async () => {
    // The driver has no filtering proxy. Refusing is honest; granting bridge
    // networking and calling it an allowlist is not.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    const error = await driver
      .provision(
        restrictedRequest(
          makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } }),
        ),
      )
      .then(() => undefined, (caught: unknown) => caught);

    assert.ok(error instanceof MaError, 'provisioning must fail');
    assert.equal(error.code, 'SANDBOX_EGRESS_UNSUPPORTED');
    assert.match(error.message, /api\.example\.com/);
    assert.match(error.message, /'allow'/);
    assert.equal(await runArgs(), '', 'no container should have been started');
  });

  test("'allow' still grants networking, deliberately", async () => {
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(
      makeRequest(makeSpec({ network: { egress: 'allow', allowedHosts: [] } })),
    );

    assert.ok((await runArgs()).includes('--network bridge'));
  });

  test('a restricted sandbox joins the egress-less internal network when the proxy is configured', async () => {
    // With the egress infra, a restricted policy is honoured: the container joins
    // the egress-less internal network, on which the control plane (and, for an
    // allowlist, the filtering proxy) are the only reachable peers.
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      binary: fakeBinary,
      ...PROXY,
    });
    await driver.provision(
      restrictedRequest(
        makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } }),
      ),
    );

    const run = await runArgs();
    assert.ok(run.includes('--network ma-internal'), 'joins the egress-less internal network');
    assert.ok(!run.includes('--network bridge'), 'never falls back to unrestricted bridge');
    assert.ok(run.includes('--env HTTP_PROXY=http://ma-egress:3128'), 'forced through the proxy');
    assert.ok(run.includes('--env HTTPS_PROXY=http://ma-egress:3128'));
    // The control plane must stay reachable directly, or the token exchange breaks.
    assert.match(run, /--env NO_PROXY=[^ ]*control-plane:8080/);
  });

  test('deny joins the internal network (control plane reachable) with no proxy env', async () => {
    // deny still has to reach the control plane — it just gets no filtering proxy,
    // so on the internal network the control plane is its only reachable peer.
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      binary: fakeBinary,
      ...PROXY,
    });

    await driver.provision(
      restrictedRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })),
    );
    const run = await runArgs();
    assert.ok(run.includes('--network ma-internal'), 'deny reaches the control plane on the internal net');
    assert.ok(!run.includes('HTTP_PROXY'), 'deny gets no filtering proxy env');
  });

  test('a restricted sandbox is refused without the internal-network infra', async () => {
    // The safety invariant: isolation infra is opt-in. A deployment that has not
    // configured the egress-less internal network + proxy must not silently get a
    // dead `--network none` sandbox for a config that reads as restricted.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    const error = await driver
      .provision(restrictedRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })))
      .then(() => undefined, (caught: unknown) => caught);

    assert.ok(error instanceof MaError && error.code === 'SANDBOX_EGRESS_UNSUPPORTED');
    assert.equal(await runArgs(), '', 'no container should have been started');
  });

  test('a restricted sandbox with a loopback control-plane URL is refused', async () => {
    // 127.0.0.1 inside a container is the container itself, so a restricted
    // sandbox given the loopback default could never reach the control plane.
    // Refuse loudly rather than start a sandbox that cannot bootstrap.
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      binary: fakeBinary,
      ...PROXY,
    });
    const error = await driver
      .provision({
        ...makeRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })),
        controlPlaneUrl: 'http://127.0.0.1:8080',
      })
      .then(() => undefined, (caught: unknown) => caught);

    assert.ok(error instanceof MaError, 'provisioning must fail');
    assert.equal(error.code, 'SANDBOX_CONTROL_PLANE_UNREACHABLE');
    assert.match(error.message, /MA_CONTROL_PLANE_URL|routable/);
    assert.equal(await runArgs(), '', 'no container should have been started');
  });

  test("'allow' egress keeps working with a loopback control-plane URL (dev convenience)", async () => {
    // The guard is only for restricted egress: an operator who chose unrestricted
    // egress owns reachability, and loopback is convenient for local runs.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision({
      ...makeRequest(makeSpec({ network: { egress: 'allow', allowedHosts: [] } })),
      controlPlaneUrl: 'http://127.0.0.1:8080',
    });
    assert.ok((await runArgs()).includes('--network bridge'), 'allow + loopback still provisions');
  });
});
