/**
 * Container driver tests.
 *
 * A fake container binary stands in for Docker, so these run anywhere and can
 * provoke failures a real daemon would not produce on demand. What is under
 * test is the driver's own logic: the arguments it builds, how it waits, and
 * whether it cleans up — not whether Docker works.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, nullLogger, systemClock } from '@ma/core';
import type { SandboxSpec } from '@ma/contracts';

import { ContainerSandboxDriver, type ProvisionRequest } from '../src/index.ts';

let scriptDir: string;
let fakeBinary: string;
let callLog: string;

/**
 * Write a fake container CLI.
 *
 * `behaviour` is a shell `case` over the first argument, so a test can make
 * `run` fail, `logs` withhold the ready marker, and so on.
 */
async function fakeContainerCli(behaviour: string): Promise<string> {
  const path = join(scriptDir, `fake-docker-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(
    path,
    `#!/bin/sh
# Record every invocation so the test can assert on the arguments built.
printf '%s\\n' "$*" >> "${callLog}"
${behaviour}
`,
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

function makeRequest(spec = makeSpec()): ProvisionRequest {
  return {
    sandboxId: 'SB_01ARZ3ND',
    workspaceId: 'ws_01ARZ3ND',
    spec,
    env: { CUSTOM: 'value' },
    runtimeToken: 'runtime-token-secret',
    controlPlaneUrl: 'http://127.0.0.1:8080',
  };
}

/** A CLI where everything succeeds and the container reports ready. */
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

async function calls(): Promise<string[]> {
  const content = await readFile(callLog, 'utf8').catch(() => '');
  return content.split('\n').filter((line) => line.length > 0);
}

beforeEach(async () => {
  scriptDir = await mkdtemp(join(tmpdir(), 'ma-container-'));
  callLog = join(scriptDir, 'calls.log');
  await writeFile(callLog, '', 'utf8');
});

afterEach(async () => {
  await rm(scriptDir, { recursive: true, force: true });
});

describe('provisioning', () => {
  beforeEach(async () => {
    fakeBinary = await fakeContainerCli(HEALTHY);
  });

  test('starts a container and resolves its endpoint', async () => {
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      logger: nullLogger,
      binary: fakeBinary,
    });

    const sandbox = await driver.provision(makeRequest());
    assert.equal(sandbox.endpoint, 'http://127.0.0.1:49154');
    assert.ok(sandbox.providerRef.startsWith('ma-'));
  });

  test('enforces the spec’s resource limits', async () => {
    // Limits are the point of using a container; unenforced ones make it
    // isolation theatre.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest(makeSpec({ cpu: 4, memoryMb: 8192 })));

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--cpus 4'));
    assert.ok(run.includes('--memory 8192m'));
    // Without this the container swaps under pressure instead of being killed,
    // turning a bounded failure into an unbounded slowdown.
    assert.ok(run.includes('--memory-swap 8192m'));
    assert.ok(run.includes('--pids-limit'));
  });

  test('drops privileges and capabilities', async () => {
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--security-opt no-new-privileges'));
    assert.ok(run.includes('--cap-drop ALL'), 'an agent needs no capabilities');
  });

  test('gives the container a read-only root and a writable workspace', async () => {
    // A compromised process must not be able to persist into the image.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--read-only'));
    assert.ok(run.includes('destination=/workspace'));
    assert.ok(run.includes('--workdir /workspace'));
  });

  test('disables the network entirely when egress is denied', async () => {
    // Kernel-enforced, rather than something the container can reconfigure.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(
      makeRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })),
    );

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--network none'));
  });

  test('passes configuration through the environment, never argv', async () => {
    // `docker inspect` shows the command line to anyone who can reach the
    // daemon, so a token there is a token leaked.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--env MA_RUNTIME_TOKEN=runtime-token-secret'));
    assert.ok(run.includes('--env CUSTOM=value'));
    // The image is the final positional argument; the token must not appear as
    // a bare one.
    assert.ok(run.trimEnd().endsWith('managed-agent/runtime:latest'));
  });

  test('labels containers so orphans can be found later', async () => {
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--label managed-agent=true'));
    assert.ok(run.includes('--label managed-agent.sandbox=SB_01ARZ3ND'));
  });

  test('publishes the agent port on loopback only', async () => {
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--publish 127.0.0.1::'), 'the agent port must not be world-reachable');
  });
});

describe('provisioning failures', () => {
  test('reports a failed start as retryable', async () => {
    // Capacity and image-pull problems both surface here.
    const binary = await fakeContainerCli(`
case "$1" in
  run) echo "Error: no space left on device" >&2; exit 125 ;;
  *)   exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary, logger: nullLogger });

    await assert.rejects(driver.provision(makeRequest()), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'SANDBOX_STARTUP_FAILED');
      assert.ok(error.message.includes('no space left'), 'the cause must reach the operator');
      return true;
    });
  });

  test('reports a container that exited during startup, with its logs', async () => {
    const binary = await fakeContainerCli(`
case "$1" in
  run)     echo "container-id" ;;
  logs)    echo "fatal: config file missing" >&2 ;;
  inspect) echo "false" ;;
  rm)      echo "removed" ;;
  *)       exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary, logger: nullLogger });

    await assert.rejects(driver.provision(makeRequest()), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.ok(error.message.includes('config file missing'));
      return true;
    });

    // The dead container must not linger.
    assert.ok((await calls()).some((line) => line.startsWith('rm ')));
  });

  test('times out a container that never signals readiness', async () => {
    const binary = await fakeContainerCli(`
case "$1" in
  run)     echo "container-id" ;;
  logs)    echo "still starting" ;;
  inspect) echo "true" ;;
  rm)      echo "removed" ;;
  *)       exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      binary,
      logger: nullLogger,
      startupTimeoutMs: 600,
    });

    await assert.rejects(driver.provision(makeRequest()), /did not become ready/);
    assert.ok((await calls()).some((line) => line.startsWith('rm ')), 'a timed-out container is removed');
  });

  test('treats a missing container binary as a failure, not a crash', async () => {
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      binary: '/nonexistent/docker',
      logger: nullLogger,
    });
    await assert.rejects(driver.provision(makeRequest()), (error: unknown) => MaError.is(error));
  });
});

describe('lifecycle', () => {
  test('reports health from the container state', async () => {
    const running = await fakeContainerCli(HEALTHY);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: running });
    assert.equal(await driver.health('ma-anything'), 'healthy');

    const stopped = await fakeContainerCli(`
case "$1" in
  inspect) echo "false" ;;
  *)       exit 0 ;;
esac
`);
    const other = new ContainerSandboxDriver({ clock: systemClock, binary: stopped });
    assert.equal(await other.health('ma-anything'), 'gone');
  });

  test('reports an unknown container as gone', async () => {
    const binary = await fakeContainerCli(`
case "$1" in
  inspect) echo "No such object" >&2; exit 1 ;;
  *)       exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary });
    assert.equal(await driver.health('ma-vanished'), 'gone');
  });

  test('destroy removes the container and its volumes', async () => {
    const binary = await fakeContainerCli(HEALTHY);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary });
    await driver.destroy('ma-test', 'done');

    const rm = (await calls()).find((line) => line.startsWith('rm '))!;
    assert.ok(rm.includes('--force'));
    // Anonymous volumes are where an orphan quietly accumulates disk.
    assert.ok(rm.includes('--volumes'));
  });

  test('destroying something already gone is not an error', async () => {
    // The reaper legitimately calls this for vanished containers.
    const binary = await fakeContainerCli(`
case "$1" in
  rm) echo "Error: No such container: ma-gone" >&2; exit 1 ;;
  *)  exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary, logger: nullLogger });
    await driver.destroy('ma-gone', 'reaping');
  });
});

describe('orphan reaping', () => {
  test('removes containers the control plane has forgotten', async () => {
    // A control plane that crashed mid-provision leaves containers with no row
    // pointing at them; nothing else will ever clean them up.
    const binary = await fakeContainerCli(`
case "$1" in
  ps) printf 'ma-known\\nma-orphan-one\\nma-orphan-two\\n' ;;
  rm) echo "removed" ;;
  *)  exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary, logger: nullLogger });

    const reaped = await driver.reapOrphans(['ma-known']);
    assert.deepEqual(reaped.sort(), ['ma-orphan-one', 'ma-orphan-two']);
    assert.equal(reaped.includes('ma-known'), false, 'a live container must survive');
  });

  test('filters by the managed label so it cannot touch unrelated containers', async () => {
    const binary = await fakeContainerCli(`
case "$1" in
  ps) echo "" ;;
  *)  exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary });
    await driver.reapOrphans([]);

    const ps = (await calls()).find((line) => line.startsWith('ps '))!;
    assert.ok(ps.includes('--filter label=managed-agent=true'));
  });

  test('reaping nothing is a no-op', async () => {
    const binary = await fakeContainerCli(`
case "$1" in
  ps) echo "" ;;
  *)  exit 0 ;;
esac
`);
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary });
    assert.deepEqual(await driver.reapOrphans(['ma-known']), []);
  });
});
