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

import { ContainerSandboxDriver, VolumeManager, type ProvisionRequest } from '../src/index.ts';

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
    // Mechanics tests here exercise resource limits, env, labels and ports, not
    // egress — use `allow` so provisioning proceeds without the internal-network
    // infra a restricted policy now requires. Egress behavior is covered in
    // escape-regression.test.ts.
    network: { egress: 'allow', allowedHosts: [] },
    setupCommands: [],
    allowReuse: true,
    mounts: [],
    runAs: '',
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

  test('refuses a restricted-egress sandbox without the internal-network infra', async () => {
    // deny/allowlist need the egress-less internal network (with the control plane
    // on it) to phone home; without that infra a restricted container would be a
    // dead `--network none` box that can never bootstrap, so refuse loudly. A
    // routable URL isolates this from the separate loopback-URL guard.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await assert.rejects(
      driver.provision({
        ...makeRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })),
        controlPlaneUrl: 'http://control-plane:8080',
      }),
      (error: unknown) => MaError.is(error) && error.code === 'SANDBOX_EGRESS_UNSUPPORTED',
    );
  });

  test('passes configuration through the environment, never argv', async () => {
    // `docker inspect` shows the command line to anyone who can reach the
    // daemon, so a token there is a token leaked.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(run.includes('--env MA_RUNTIME_TOKEN=runtime-token-secret'));
    assert.ok(run.includes('--env CUSTOM=value'));
    // agent-core must bind all interfaces inside the container: `--publish`
    // forwards the host port to the container's bridge interface, not its
    // loopback, so a 127.0.0.1 bind would never receive the forwarded /submit.
    assert.ok(
      run.includes('--env MA_AGENT_HOST=0.0.0.0'),
      `the container must bind all interfaces, not loopback: ${run}`,
    );
    // The image is the final positional argument; the token must not appear as
    // a bare one.
    assert.ok(run.trimEnd().endsWith('managed-agent/runtime:latest'));
  });

  test('delivers platform credential env, which sanitizeEnv would otherwise strip', async () => {
    // The silent-drop bug: an api_key/bearer_token credential is delivered as
    // `MA_CRED_<NAME>=<secret>`. It used to be merged into `env`, but `env` is
    // sanitized and sanitizeEnv drops every `MA_*` key — so the secret never
    // reached the agent. The trusted platform-generated map is delivered
    // separately, past the sanitizer.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision({
      ...makeRequest(),
      credentialEnv: { MA_CRED_STRIPE: 'sk_live_secret' },
    });

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(
      run.includes('--env MA_CRED_STRIPE=sk_live_secret'),
      'the platform credential value must reach the container',
    );
  });

  test('a supplied MA_CRED_* key is still stripped; only the trusted map is delivered', async () => {
    // Trust is by map, not by prefix. A key an env_vars credential supplies (in
    // `env`) is untrusted and sanitized away even if it mimics MA_CRED_*, so it
    // cannot spoof a platform-delivered secret; the trusted credentialEnv is kept.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision({
      ...makeRequest(),
      env: { CUSTOM: 'value', MA_CRED_FAKE: 'spoofed' },
      credentialEnv: { MA_CRED_REAL: 'genuine' },
    });

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(!run.includes('MA_CRED_FAKE'), 'a supplied MA_CRED_* must be stripped');
    assert.ok(run.includes('--env MA_CRED_REAL=genuine'), 'the trusted one is delivered');
  });

  test('credential env cannot override reserved platform variables', async () => {
    // Defense in depth: platform code never generates MA_RUNTIME_TOKEN as a
    // credential key, but even if credentialEnv carried one it must not win —
    // the reserved platform vars are layered after it.
    const driver = new ContainerSandboxDriver({ clock: systemClock, binary: fakeBinary });
    await driver.provision({
      ...makeRequest(),
      credentialEnv: { MA_RUNTIME_TOKEN: 'spoof' },
    });

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(
      run.includes('--env MA_RUNTIME_TOKEN=runtime-token-secret'),
      'the real runtime token must win over a credential-supplied one',
    );
    assert.ok(!run.includes('MA_RUNTIME_TOKEN=spoof'), 'the spoofed token must not appear');
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

describe('volume mounts', () => {
  const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';

  function mountRequest(spec: SandboxSpec): ProvisionRequest {
    return { ...makeRequest(spec), workspaceId: WS };
  }

  test('binds a managed volume read-only by default', async () => {
    const binary = await fakeContainerCli(HEALTHY);
    const volumeRoot = await mkdtemp(join(tmpdir(), 'ma-volroot-'));
    try {
      const driver = new ContainerSandboxDriver({
        clock: systemClock,
        logger: nullLogger,
        binary,
        volumes: new VolumeManager({ root: volumeRoot }),
      });
      await driver.provision(
        mountRequest(makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: true }] })),
      );

      const run = (await calls()).find((line) => line.startsWith('run '))!;
      // The source is the managed dir, never a host path from the spec, and the
      // bind is read-only.
      assert.ok(
        run.includes(`type=bind,source=${join(volumeRoot, WS, 'cache')},destination=/data,readonly`),
        `run args did not include the read-only bind: ${run}`,
      );
      // The isolation posture is untouched: read-only root and dropped caps stay.
      assert.ok(run.includes('--read-only'));
      assert.ok(run.includes('--cap-drop ALL'));
    } finally {
      await rm(volumeRoot, { recursive: true, force: true });
    }
  });

  test('omits readonly for a writable mount', async () => {
    const binary = await fakeContainerCli(HEALTHY);
    const volumeRoot = await mkdtemp(join(tmpdir(), 'ma-volroot-'));
    try {
      const driver = new ContainerSandboxDriver({
        clock: systemClock,
        logger: nullLogger,
        binary,
        volumes: new VolumeManager({ root: volumeRoot }),
      });
      await driver.provision(
        mountRequest(makeSpec({ mounts: [{ name: 'work', target: '/work', readOnly: false }] })),
      );

      const run = (await calls()).find((line) => line.startsWith('run '))!;
      assert.ok(run.includes(`destination=/work`));
      assert.ok(!/destination=\/work,readonly/.test(run), 'a writable mount must not be marked readonly');
    } finally {
      await rm(volumeRoot, { recursive: true, force: true });
    }
  });

  test('refuses a declared mount when no volume storage is configured', async () => {
    // Fail-closed: honouring the mount is impossible and silently dropping the
    // agent's persistence is worse than a loud failure.
    const binary = await fakeContainerCli(HEALTHY);
    const driver = new ContainerSandboxDriver({
      clock: systemClock,
      logger: nullLogger,
      binary,
      // No volumes configured at all.
    });

    await assert.rejects(
      driver.provision(
        mountRequest(makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: true }] })),
      ),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'SANDBOX_MOUNT_UNSUPPORTED');
        return true;
      },
    );
    // It must refuse before starting a container that would run without its data.
    assert.equal((await calls()).some((line) => line.startsWith('run ')), false);
  });

  test('a spec with no mounts adds no bind and needs no volume storage', async () => {
    const binary = await fakeContainerCli(HEALTHY);
    const driver = new ContainerSandboxDriver({ clock: systemClock, logger: nullLogger, binary });
    await driver.provision(makeRequest());

    const run = (await calls()).find((line) => line.startsWith('run '))!;
    assert.ok(!run.includes('type=bind'), 'no mounts declared means no bind args');
  });
});

describe('service-account identity (runAs)', () => {
  test('refuses a declared runAs: a container cannot bind a cloud identity', async () => {
    // Fail-closed, like an unenforceable egress allowlist: a container has no
    // service-account, so running one that asked for a scoped identity would
    // silently give it the driver's own, not the one the version declared.
    const binary = await fakeContainerCli(HEALTHY);
    const driver = new ContainerSandboxDriver({ clock: systemClock, logger: nullLogger, binary });

    await assert.rejects(
      driver.provision(makeRequest(makeSpec({ runAs: 's3-reader' }))),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'SANDBOX_IDENTITY_UNSUPPORTED');
        return true;
      },
    );
    // It refuses before starting a container that would run as the wrong identity.
    assert.equal((await calls()).some((line) => line.startsWith('run ')), false);
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
