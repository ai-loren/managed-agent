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
import { sanitizeEnv, reservedKeys } from '../src/env.ts';

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
      makeRequest(makeSpec(), {
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
      makeRequest(makeSpec(), {
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
});

describe('egress policy', () => {
  test('an allowlist naming no hosts permits no hosts', async () => {
    // This is the schema default. It used to mean full bridge networking, which
    // is the exact opposite of what it says.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(
      makeRequest(makeSpec({ network: { egress: 'allowlist', allowedHosts: [] } })),
    );

    const run = await runArgs();
    assert.ok(run.includes('--network none'), 'an empty allowlist must not grant networking');
  });

  test('an allowlist naming hosts is refused rather than silently widened', async () => {
    // The driver has no filtering proxy. Refusing is honest; granting bridge
    // networking and calling it an allowlist is not.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    const error = await driver
      .provision(
        makeRequest(
          makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } }),
        ),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    assert.ok(error instanceof MaError, 'provisioning must fail');
    assert.equal(error.code, 'SANDBOX_EGRESS_UNSUPPORTED');
    // The message has to say what to do instead, or an operator will just
    // switch to 'allow' to make the error go away.
    assert.match(error.message, /api\.example\.com/);
    assert.match(error.message, /'deny'|'allow'/);

    assert.equal(await runArgs(), '', 'no container should have been started');
  });

  test("'allow' still grants networking, deliberately", async () => {
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(
      makeRequest(makeSpec({ network: { egress: 'allow', allowedHosts: [] } })),
    );

    assert.ok((await runArgs()).includes('--network bridge'));
  });
});
