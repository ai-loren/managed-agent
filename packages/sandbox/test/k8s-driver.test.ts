/**
 * Kubernetes driver tests.
 *
 * A fake `KubeClient` stands in for the cluster, so these run anywhere and can
 * provoke failures a real cluster would not produce on demand. What is under
 * test is the driver's own logic: the Pod spec it builds, how it waits for
 * readiness, how it maps pod phases to health, and whether it cleans up — not
 * whether Kubernetes works.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, TestClock, nullLogger, systemClock } from '@ma/core';
import type { SandboxSpec } from '@ma/contracts';

import {
  K8sSandboxDriver,
  VolumeManager,
  fromPodObject,
  toPodManifest,
  toNetworkPolicyManifest,
  type KubeClient,
  type KubeNetworkPolicy,
  type KubePod,
  type KubePodSpec,
  type KubeSecret,
  type ProvisionRequest,
} from '../src/index.ts';

const START = 1_700_000_000_000;

/**
 * A scriptable in-memory cluster.
 *
 * Records the Pod spec passed to `createPod` (the analogue of the container
 * test's recorded argv) and returns whatever pod state a test scripts.
 */
class FakeKube implements KubeClient {
  created: KubePodSpec[] = [];
  deleted: string[] = [];
  secrets: KubeSecret[] = [];
  deletedSecrets: string[] = [];
  policies: KubeNetworkPolicy[] = [];
  deletedPolicies: string[] = [];
  /** What `getPod` returns, by name. Absent means a 404 (gone). */
  pods = new Map<string, KubePod>();
  /** What `getPodLogs` returns, by name. */
  logs = new Map<string, string>();
  /** When set, `createPod` rejects with this. */
  createError: Error | undefined;
  /** When set, `deletePod` rejects with this. */
  deleteError: Error | undefined;
  /** When set, `createNetworkPolicy` rejects with this. */
  policyError: Error | undefined;

  createPod(spec: KubePodSpec): Promise<void> {
    if (this.createError) return Promise.reject(this.createError);
    this.created.push(spec);
    return Promise.resolve();
  }

  getPod(name: string): Promise<KubePod | undefined> {
    return Promise.resolve(this.pods.get(name));
  }

  getPodLogs(name: string): Promise<string> {
    return Promise.resolve(this.logs.get(name) ?? '');
  }

  deletePod(name: string): Promise<void> {
    if (this.deleteError) return Promise.reject(this.deleteError);
    this.deleted.push(name);
    this.pods.delete(name);
    return Promise.resolve();
  }

  listPods(labelSelector: string): Promise<KubePod[]> {
    const key = labelSelector.split('=')[0]!;
    return Promise.resolve([...this.pods.values()].filter((pod) => key in pod.labels));
  }

  createSecret(secret: KubeSecret): Promise<void> {
    this.secrets.push(secret);
    return Promise.resolve();
  }

  deleteSecret(name: string): Promise<void> {
    this.deletedSecrets.push(name);
    return Promise.resolve();
  }

  createNetworkPolicy(policy: KubeNetworkPolicy): Promise<void> {
    if (this.policyError) return Promise.reject(this.policyError);
    this.policies.push(policy);
    return Promise.resolve();
  }

  deleteNetworkPolicy(name: string): Promise<void> {
    this.deletedPolicies.push(name);
    return Promise.resolve();
  }

  listSecrets(): Promise<string[]> {
    return Promise.resolve(
      this.secrets.filter((s) => !this.deletedSecrets.includes(s.name)).map((s) => s.name),
    );
  }

  listNetworkPolicies(): Promise<string[]> {
    return Promise.resolve(
      this.policies.filter((p) => !this.deletedPolicies.includes(p.name)).map((p) => p.name),
    );
  }

  /** Convenience: mark a pod running-and-ready with an IP. */
  ready(name: string, podIp = '10.1.2.3'): void {
    this.pods.set(name, {
      name,
      phase: 'Running',
      ready: true,
      podIp,
      labels: { 'managed-agent': 'true' },
    });
  }
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

function makeRequest(spec = makeSpec()): ProvisionRequest {
  return {
    sandboxId: 'SB_01ARZ3ND',
    workspaceId: 'ws_01ARZ3ND',
    spec,
    env: { CUSTOM: 'value' },
    runtimeToken: 'runtime-token-secret',
    controlPlaneUrl: 'http://control-plane:8080',
  };
}

let kube: FakeKube;
let clock: TestClock;

function driver(
  options: {
    egressProxy?: string;
    egressProxyCidr?: string;
    dnsCidr?: string;
    volumes?: VolumeManager;
  } = {},
): K8sSandboxDriver {
  return new K8sSandboxDriver({
    clock,
    kube,
    logger: nullLogger,
    ...(options.egressProxy ? { egressProxy: options.egressProxy } : {}),
    ...(options.egressProxyCidr ? { egressProxyCidr: options.egressProxyCidr } : {}),
    ...(options.dnsCidr ? { dnsCidr: options.dnsCidr } : {}),
    ...(options.volumes ? { volumes: options.volumes } : {}),
  });
}

/** The proxy options a fully-configured allowlist deployment supplies. */
const PROXY = { egressProxy: 'http://ma-egress:3128', egressProxyCidr: '10.0.5.7/32' };

beforeEach(() => {
  kube = new FakeKube();
  clock = new TestClock(START);
});

afterEach(() => {
  // TestClock has no resource to release; kept for symmetry with other suites.
});

describe('provisioning', () => {
  test('builds a pod with the resource limits from the spec', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(makeRequest(makeSpec({ cpu: 4, memoryMb: 8192, diskMb: 40_960 })));

    const pod = kube.created[0]!;
    assert.equal(pod.cpu, 4);
    assert.equal(pod.memoryMb, 8192);
    assert.equal(pod.diskMb, 40_960);
    assert.equal(pod.image, 'managed-agent/runtime:latest');
    assert.equal(pod.agentPort, 8090);
    assert.equal(pod.workingDir, '/workspace');
  });

  test('names the pod from the sandbox id and labels it for reaping', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(makeRequest());
    const pod = kube.created[0]!;
    assert.equal(pod.name, 'ma-sb_01arz3nd');
    assert.equal(pod.labels['managed-agent'], 'true');
    assert.equal(pod.labels['managed-agent.sandbox'], 'SB_01ARZ3ND');
    assert.equal(pod.labels['managed-agent.workspace'], 'ws_01ARZ3ND');
  });

  test('secrets go in a Secret, not inlined; platform env stays authoritative', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(makeRequest());
    const pod = kube.created[0]!;

    // The runtime token and the credential-supplied CUSTOM must NOT be inline
    // pod env (readable via `kubectl get pod -o yaml`); they live in the Secret.
    assert.equal(pod.env.MA_RUNTIME_TOKEN, undefined, 'the token is never inline');
    assert.equal(pod.env.CUSTOM, undefined, 'credential values are never inline');
    assert.ok(pod.secretEnv.includes('MA_RUNTIME_TOKEN'), 'the token is referenced from the Secret');
    assert.ok(pod.secretEnv.includes('CUSTOM'));

    const secret = kube.secrets.find((s) => s.name === pod.secretName)!;
    assert.equal(secret.data.MA_RUNTIME_TOKEN, 'runtime-token-secret');
    assert.equal(secret.data.CUSTOM, 'value');

    // Non-secret platform vars are inline and authoritative.
    assert.equal(pod.env.MA_CONTROL_PLANE_URL, 'http://control-plane:8080');
    assert.equal(pod.env.MA_SANDBOX_ID, 'SB_01ARZ3ND');
  });

  test('resolves the endpoint from the pod IP', async () => {
    kube.ready('ma-sb_01arz3nd', '10.4.5.6');
    const result = await driver().provision(makeRequest());
    assert.equal(result.providerRef, 'ma-sb_01arz3nd');
    assert.equal(result.endpoint, 'http://10.4.5.6:8090');
  });

  test('waits for the ready marker in logs when the pod is running but not ready', async () => {
    const name = 'ma-sb_01arz3nd';
    kube.pods.set(name, { name, phase: 'Running', ready: false, podIp: '10.1.1.1', labels: {} });
    kube.logs.set(name, 'starting up\nAGENT_CORE_READY\n');
    const result = await driver().provision(makeRequest());
    assert.equal(result.endpoint, 'http://10.1.1.1:8090');
  });
});

describe('volume mounts', () => {
  const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';

  function mountRequest(spec: SandboxSpec): ProvisionRequest {
    return { ...makeRequest(spec), sandboxId: 'SB_01ARZ3ND', workspaceId: WS };
  }

  test('resolves each mount to a node-local hostPath under the volume root', async () => {
    kube.ready('ma-sb_01arz3nd');
    const volumes = new VolumeManager({ root: '/srv/ma-volumes' });
    await driver({ volumes }).provision(
      mountRequest(makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: true }] })),
    );

    const pod = kube.created[0]!;
    assert.equal(pod.mounts.length, 1);
    const mount = pod.mounts[0]!;
    // The hostPath is the workspace-scoped managed dir, never a path from the
    // spec; the target and read-only flag come from the declaration.
    assert.equal(mount.hostPath, `/srv/ma-volumes/${WS}/cache`);
    assert.equal(mount.target, '/data');
    assert.equal(mount.readOnly, true);
    // The k8s volume name is a DNS-1123 label derived from the declared name.
    assert.ok(/^vol-[a-z0-9-]+$/.test(mount.name), `not a DNS-1123 label: ${mount.name}`);
  });

  test('refuses a declared mount when no volume storage is configured', async () => {
    // Fail-closed, like the container driver: a pod that would run without its
    // persistent storage is refused rather than scheduled.
    kube.ready('ma-sb_01arz3nd');
    await assert.rejects(
      driver().provision(
        mountRequest(makeSpec({ mounts: [{ name: 'cache', target: '/data', readOnly: true }] })),
      ),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'SANDBOX_MOUNT_UNSUPPORTED');
        return true;
      },
    );
    // Nothing was created: it refused before the secret/pod were made.
    assert.equal(kube.created.length, 0);
    assert.equal(kube.secrets.length, 0);
  });
});

describe('service-account identity (runAs)', () => {
  const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';

  function identityRequest(spec: SandboxSpec): ProvisionRequest {
    return { ...makeRequest(spec), sandboxId: 'SB_01ARZ3ND', workspaceId: WS };
  }

  test('no runAs leaves the pod without a ServiceAccount', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(identityRequest(makeSpec()));
    const pod = kube.created[0]!;
    assert.equal(pod.serviceAccountName, undefined, 'an agent with no runAs stays identity-less');
  });

  test('a declared runAs binds the pod to a workspace-confined ServiceAccount', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(identityRequest(makeSpec({ runAs: 's3-reader' })));
    const pod = kube.created[0]!;
    // The name is confined to the workspace: it always begins with the workspace
    // prefix, so a workspace can only ever name an account provisioned for it.
    assert.equal(pod.serviceAccountName, 'ws-01arz3ndektsv4rrffq69g5fav-s3-reader');
  });
});

describe('egress', () => {
  test('an allowlist with hosts is refused without a proxy', async () => {
    const error = await driver()
      .provision(
        makeRequest(makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } })),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof MaError && error.code === 'SANDBOX_EGRESS_UNSUPPORTED');
    assert.equal(kube.created.length, 0, 'no pod should have been created');
  });

  test('an allowlist with a proxy but no proxy CIDR is refused', async () => {
    // A NetworkPolicy scopes to CIDRs, not hostnames. Without the proxy's CIDR
    // the fence could only permit ports to *any* host — no fence at all — so the
    // driver refuses rather than emit an advisory policy.
    const error = await driver({ egressProxy: 'http://ma-egress:3128' })
      .provision(
        makeRequest(makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } })),
      )
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof MaError && error.code === 'SANDBOX_EGRESS_UNSUPPORTED');
    assert.match(error.message, /CIDR/);
    assert.equal(kube.created.length, 0);
  });

  test('an allowlist is fenced to the proxy CIDR, not to any host', async () => {
    // The core fix: the egress rule must scope `to` the proxy CIDR. A ports-only
    // rule (no `to`) would let the agent reach any host on 443, bypassing the
    // proxy the allowlist depends on.
    kube.ready('ma-sb_01arz3nd');
    await driver(PROXY).provision(
      makeRequest(makeSpec({ network: { egress: 'allowlist', allowedHosts: ['api.example.com'] } })),
    );
    const pod = kube.created[0]!;
    assert.equal(pod.env.HTTP_PROXY, 'http://ma-egress:3128', 'the proxy env is still set');

    const policy = kube.policies.find((p) => p.name === 'ma-sb_01arz3nd-egress')!;
    // Every rule that opens a port must be scoped to a destination — never
    // ports-only (which would be to-any-host).
    for (const rule of policy.egress) {
      const hasDestination = rule.toDns || (rule.cidrs?.length ?? 0) > 0;
      assert.ok(hasDestination, 'no rule may open a port to every host');
    }
    // The proxy CIDR is the only non-DNS destination.
    assert.ok(
      policy.egress.some((rule) => rule.cidrs?.includes('10.0.5.7/32')),
      'egress is fenced to the proxy CIDR',
    );
  });

  test('deny provisions with no proxy env', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver(PROXY).provision(
      makeRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })),
    );
    assert.equal(kube.created[0]!.env.HTTP_PROXY, undefined);
  });

  test('deny creates a deny-all-egress NetworkPolicy with no DNS', async () => {
    // A pod whose contract is "no network" must not get a DNS channel — DNS is a
    // live exfiltration path (encode data in lookups the resolver forwards
    // upstream). Deny means an empty egress list: nothing, not even :53.
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(
      makeRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })),
    );
    const policy = kube.policies.find((p) => p.name === 'ma-sb_01arz3nd-egress');
    assert.ok(policy, 'a deny pod must get a NetworkPolicy');
    assert.equal(policy!.egress.length, 0, 'deny is empty egress — not even DNS');
  });

  test('the default empty allowlist also gets a deny-all NetworkPolicy', async () => {
    // The schema default (allowlist + no hosts) means "reach nothing" — it must
    // not silently grant full egress, and it gets no DNS either.
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(
      makeRequest(makeSpec({ network: { egress: 'allowlist', allowedHosts: [] } })),
    );
    const policy = kube.policies.find((p) => p.name === 'ma-sb_01arz3nd-egress');
    assert.ok(policy, 'an empty allowlist is restricted, not open');
    assert.equal(policy!.egress.length, 0, 'and reaches nothing, DNS included');
  });

  test('allow gets no NetworkPolicy, deliberately', async () => {
    kube.ready('ma-sb_01arz3nd');
    await driver().provision(
      makeRequest(makeSpec({ network: { egress: 'allow', allowedHosts: [] } })),
    );
    assert.equal(kube.policies.length, 0, 'allow is unrestricted by design');
  });

  test('a restricted pod is refused when its NetworkPolicy cannot be created', async () => {
    // The refuse-rather-than-pretend rule: if the egress fence cannot be put up,
    // the pod must not run on the open network. The secret is rolled back too.
    kube.policyError = new Error('networkpolicies.networking.k8s.io is forbidden');
    const error = await driver()
      .provision(makeRequest(makeSpec({ network: { egress: 'deny', allowedHosts: [] } })))
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof MaError && error.code === 'SANDBOX_EGRESS_UNSUPPORTED');
    assert.equal(kube.created.length, 0, 'no pod runs without its egress fence');
    assert.ok(kube.deletedSecrets.includes('ma-sb_01arz3nd-env'), 'the secret is rolled back');
  });
});

describe('startup failures', () => {
  test('a create failure is a retryable startup error', async () => {
    kube.createError = new Error('insufficient quota');
    const error = await driver()
      .provision(makeRequest())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof MaError);
    assert.equal(error.code, 'SANDBOX_STARTUP_FAILED');
    assert.equal(error.retryable, true);
  });

  test('a pod that fails during startup reports why, and is cleaned up', async () => {
    const name = 'ma-sb_01arz3nd';
    kube.pods.set(name, { name, phase: 'Failed', ready: false, labels: {} });
    kube.logs.set(name, 'ImagePullBackOff: no such image');

    const error = await driver()
      .provision(makeRequest())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof MaError && error.code === 'SANDBOX_STARTUP_FAILED');
    assert.match(error.message, /ImagePullBackOff/);
    assert.ok(kube.deleted.includes(name), 'a failed pod must be deleted');
  });

  test('a pod that never becomes ready times out', async () => {
    const name = 'ma-sb_01arz3nd';
    kube.pods.set(name, { name, phase: 'Pending', ready: false, labels: {} });

    // A real short timeout, like the container driver's timeout test: the poll
    // loop genuinely elapses rather than depending on TestClock interleaving.
    const slow = new K8sSandboxDriver({
      clock: systemClock,
      kube,
      logger: nullLogger,
      startupTimeoutMs: 600,
    });
    const error = await slow.provision(makeRequest()).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof MaError && error.code === 'SANDBOX_STARTUP_FAILED');
    assert.equal(error.retryable, true);
  });

  test('a pod that becomes ready without an IP is an internal fault', async () => {
    const name = 'ma-sb_01arz3nd';
    kube.pods.set(name, { name, phase: 'Running', ready: true, labels: {} });
    const error = await driver()
      .provision(makeRequest())
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof MaError && error.code === 'SANDBOX_UNREACHABLE');
  });
});

describe('health', () => {
  test('running-and-ready is healthy', async () => {
    kube.ready('pod-a');
    assert.equal(await driver().health('pod-a'), 'healthy');
  });

  test('a gone pod is gone', async () => {
    assert.equal(await driver().health('missing'), 'gone');
  });

  test('a failed pod is gone', async () => {
    kube.pods.set('pod-b', { name: 'pod-b', phase: 'Failed', ready: false, labels: {} });
    assert.equal(await driver().health('pod-b'), 'gone');
  });

  test('pending is unreachable, not gone', async () => {
    kube.pods.set('pod-c', { name: 'pod-c', phase: 'Pending', ready: false, labels: {} });
    assert.equal(await driver().health('pod-c'), 'unreachable');
  });
});

describe('destroy and reap', () => {
  test('destroy deletes the pod and is idempotent', async () => {
    kube.ready('pod-a');
    await driver().destroy('pod-a', 'done');
    assert.ok(kube.deleted.includes('pod-a'));
    // A second destroy, now that it is gone, must not throw.
    await driver().destroy('pod-a', 'again');
  });

  test('a delete failure is swallowed, not thrown', async () => {
    kube.deleteError = new Error('api server unreachable');
    // The reaper must not be stopped by one stubborn pod.
    await driver().destroy('pod-x', 'reap');
  });

  test('destroy removes the pod, its secret, and its egress policy', async () => {
    // The three resources are created together and must be torn down together,
    // or the credential-bearing secret leaks.
    kube.ready('ma-sb_1');
    kube.secrets.push({ name: 'ma-sb_1-env', namespace: 'managed-agent', labels: {}, data: {} });
    await driver().destroy('ma-sb_1', 'done');
    assert.ok(kube.deleted.includes('ma-sb_1'));
    assert.ok(kube.deletedSecrets.includes('ma-sb_1-env'), 'the secret must go with the pod');
    assert.ok(kube.deletedPolicies.includes('ma-sb_1-egress'), 'so must the egress policy');
  });

  test('a live pod whose delete fails keeps its egress fence (no fail-open)', async () => {
    // If deletePod fails and the pod is still there, its NetworkPolicy must NOT
    // be deleted — stripping the fence off a running pod is fail-open.
    kube.pods.set('ma-sb_1', {
      name: 'ma-sb_1',
      phase: 'Running',
      ready: true,
      labels: { 'managed-agent': 'true' },
    });
    kube.deleteError = new Error('api server unreachable');
    await driver().destroy('ma-sb_1', 'attempt');
    assert.ok(
      !kube.deletedPolicies.includes('ma-sb_1-egress'),
      'a still-running pod must not lose its egress fence',
    );
    assert.ok(!kube.deletedSecrets.includes('ma-sb_1-env'), 'nor its secret');
  });

  test('reapOrphans deletes labelled pods the control plane has forgotten', async () => {
    kube.pods.set('ma-known', {
      name: 'ma-known',
      phase: 'Running',
      ready: true,
      labels: { 'managed-agent': 'true' },
    });
    kube.pods.set('ma-orphan', {
      name: 'ma-orphan',
      phase: 'Running',
      ready: true,
      labels: { 'managed-agent': 'true' },
    });

    const reaped = await driver().reapOrphans(['ma-known']);
    assert.deepEqual(reaped, ['ma-orphan']);
    assert.ok(kube.deleted.includes('ma-orphan'));
    assert.ok(!kube.deleted.includes('ma-known'), 'a known pod must survive');
  });

  test('reapOrphans sweeps a secret whose pod is already gone', async () => {
    // The leak the review found: a secret whose pod was deleted but whose own
    // delete failed has no pod to key off, so nothing else would ever remove it.
    kube.secrets.push({ name: 'ma-dead-env', namespace: 'managed-agent', labels: {}, data: {} });
    kube.policies.push({
      name: 'ma-dead-egress',
      namespace: 'managed-agent',
      labels: {},
      podSelector: {},
      egress: [],
    });
    // No pod `ma-dead` exists and it is not in knownRefs.
    await driver().reapOrphans([]);
    assert.ok(kube.deletedSecrets.includes('ma-dead-env'), 'an orphaned secret is reclaimed');
    assert.ok(kube.deletedPolicies.includes('ma-dead-egress'), 'so is an orphaned policy');
  });

  test('reapOrphans keeps the secret of a live known pod', async () => {
    kube.pods.set('ma-live', {
      name: 'ma-live',
      phase: 'Running',
      ready: true,
      labels: { 'managed-agent': 'true' },
    });
    kube.secrets.push({ name: 'ma-live-env', namespace: 'managed-agent', labels: {}, data: {} });
    await driver().reapOrphans(['ma-live']);
    assert.ok(!kube.deletedSecrets.includes('ma-live-env'), 'a live pod keeps its secret');
  });
});

describe('pod manifest', () => {
  const spec: KubePodSpec = {
    name: 'ma-sb_1',
    namespace: 'managed-agent',
    labels: { 'managed-agent': 'true' },
    image: 'managed-agent/runtime:latest',
    cpu: 2,
    memoryMb: 4096,
    diskMb: 20_480,
    agentPort: 8090,
    env: { MA_SANDBOX_ID: 'SB_1' },
    secretEnv: ['MA_RUNTIME_TOKEN', 'CUSTOM'],
    secretName: 'ma-sb_1-env',
    egress: 'deny',
    allowedHosts: [],
    workingDir: '/workspace',
    mounts: [],
  };

  test('maps every isolation flag the container driver sets', () => {
    const manifest = toPodManifest(spec, 8090) as {
      spec: {
        restartPolicy: string;
        automountServiceAccountToken: boolean;
        securityContext: { runAsNonRoot: boolean };
        containers: {
          image: string;
          workingDir: string;
          resources: { limits: Record<string, string> };
          securityContext: {
            allowPrivilegeEscalation: boolean;
            readOnlyRootFilesystem: boolean;
            capabilities: { drop: string[] };
          };
          env: {
            name: string;
            value?: string;
            valueFrom?: { secretKeyRef: { name: string; key: string } };
          }[];
          ports: { containerPort: number }[];
        }[];
        volumes: { name: string }[];
      };
    };

    assert.equal(manifest.spec.restartPolicy, 'Never', 'a dead sandbox is reaped, not restarted');
    assert.equal(
      manifest.spec.automountServiceAccountToken,
      false,
      'a sandbox must have no cluster identity',
    );
    assert.equal(manifest.spec.securityContext.runAsNonRoot, true);

    const container = manifest.spec.containers[0]!;
    assert.equal(container.image, 'managed-agent/runtime:latest');
    assert.equal(container.workingDir, '/workspace');
    assert.equal(container.resources.limits.cpu, '2');
    assert.equal(container.resources.limits.memory, '4096Mi');
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
    assert.equal(container.ports[0]!.containerPort, 8090);

    // Non-secret env is inline; secret env is a secretKeyRef, never a plaintext
    // value in the Pod object.
    const sandboxId = container.env.find((entry) => entry.name === 'MA_SANDBOX_ID');
    assert.equal(sandboxId?.value, 'SB_1');
    const token = container.env.find((entry) => entry.name === 'MA_RUNTIME_TOKEN');
    assert.equal(token?.value, undefined, 'the token is never an inline value');
    assert.equal(token?.valueFrom?.secretKeyRef.name, 'ma-sb_1-env');
    assert.equal(token?.valueFrom?.secretKeyRef.key, 'MA_RUNTIME_TOKEN');

    // The root filesystem is read-only, so /workspace and /tmp are writable volumes.
    const volumeNames = manifest.spec.volumes.map((volume) => volume.name).sort();
    assert.deepEqual(volumeNames, ['tmp', 'workspace']);
  });

  test('emits a hostPath volume and a volumeMount for each managed mount', () => {
    const withMount: KubePodSpec = {
      ...spec,
      mounts: [
        { name: 'vol-cache', hostPath: '/srv/ma-volumes/ws_x/cache', target: '/data', readOnly: true },
        { name: 'vol-work', hostPath: '/srv/ma-volumes/ws_x/work', target: '/work', readOnly: false },
      ],
    };
    const manifest = toPodManifest(withMount, 8090) as {
      spec: {
        containers: {
          volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
          securityContext: { readOnlyRootFilesystem: boolean };
        }[];
        volumes: { name: string; hostPath?: { path: string; type: string }; emptyDir?: unknown }[];
      };
    };

    const container = manifest.spec.containers[0]!;
    // The default workspace/tmp mounts are preserved; the managed mounts are added.
    const cacheMount = container.volumeMounts.find((m) => m.name === 'vol-cache')!;
    assert.equal(cacheMount.mountPath, '/data');
    assert.equal(cacheMount.readOnly, true);
    const workMount = container.volumeMounts.find((m) => m.name === 'vol-work')!;
    assert.equal(workMount.mountPath, '/work');
    assert.equal(workMount.readOnly, false);

    // Each managed volume is a node-local hostPath at the resolved source, with
    // DirectoryOrCreate so the node makes it on first mount.
    const cacheVol = manifest.spec.volumes.find((v) => v.name === 'vol-cache')!;
    assert.equal(cacheVol.hostPath?.path, '/srv/ma-volumes/ws_x/cache');
    assert.equal(cacheVol.hostPath?.type, 'DirectoryOrCreate');
    assert.equal(cacheVol.emptyDir, undefined, 'a managed volume is a hostPath, not an emptyDir');

    // The isolation posture is untouched: the root filesystem stays read-only.
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  });

  test('omits serviceAccountName when no identity is declared', () => {
    // The default spec has no serviceAccountName; the manifest must not invent
    // one, leaving the pod on the namespace default (with the token unmounted).
    const manifest = toPodManifest(spec, 8090) as { spec: Record<string, unknown> };
    assert.equal(
      'serviceAccountName' in manifest.spec,
      false,
      'an identity-less pod names no ServiceAccount',
    );
  });

  test('names the ServiceAccount but keeps the API token unmounted when runAs is set', () => {
    // The load-bearing property: a declared identity grants a *cloud* role
    // through the SA name, and MUST NOT re-enable the Kubernetes API token — a
    // compromised sandbox still cannot reach the cluster API.
    const withIdentity: KubePodSpec = {
      ...spec,
      serviceAccountName: 'ws-01arz3ndektsv4rrffq69g5fav-s3-reader',
    };
    const manifest = toPodManifest(withIdentity, 8090) as {
      spec: { serviceAccountName?: string; automountServiceAccountToken: boolean };
    };
    assert.equal(manifest.spec.serviceAccountName, 'ws-01arz3ndektsv4rrffq69g5fav-s3-reader');
    assert.equal(
      manifest.spec.automountServiceAccountToken,
      false,
      'a cloud identity must not come with a cluster-API token',
    );
  });

  test('reads phase, readiness and IP back out of a raw pod object', () => {
    const pod = fromPodObject({
      metadata: { name: 'ma-sb_1', labels: { 'managed-agent': 'true' } },
      status: {
        phase: 'Running',
        podIP: '10.9.8.7',
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    });
    assert.equal(pod.name, 'ma-sb_1');
    assert.equal(pod.phase, 'Running');
    assert.equal(pod.ready, true);
    assert.equal(pod.podIp, '10.9.8.7');
  });

  test('a pod with no Ready condition reads as not ready', () => {
    const pod = fromPodObject({
      metadata: { name: 'x' },
      status: { phase: 'Pending', conditions: [] },
    });
    assert.equal(pod.ready, false);
    assert.equal(pod.podIp, undefined);
  });

  test('a ports-only egress rule is never emitted (no to-any-host hole)', () => {
    // The manifest builder is the last line of defence: even if a rule reaches
    // it with ports but no destination, it must be dropped, because a ports-only
    // NetworkPolicy rule permits those ports to every host.
    const manifest = toNetworkPolicyManifest({
      name: 'p',
      namespace: 'managed-agent',
      labels: {},
      podSelector: { x: 'y' },
      egress: [
        { ports: [{ protocol: 'TCP', port: 443 }] }, // no cidrs, no toDns → must be dropped
        { cidrs: ['10.0.0.1/32'], ports: [{ protocol: 'TCP', port: 3128 }] }, // kept
      ],
    }) as { spec: { egress: { to?: unknown[]; ports?: unknown[] }[] } };

    assert.equal(manifest.spec.egress.length, 1, 'the ports-only rule is dropped');
    assert.ok(manifest.spec.egress[0]!.to, 'the surviving rule is scoped to a destination');
  });

  test('an empty egress list renders as deny-all', () => {
    const manifest = toNetworkPolicyManifest({
      name: 'p',
      namespace: 'managed-agent',
      labels: {},
      podSelector: { x: 'y' },
      egress: [],
    }) as { spec: { egress: unknown[]; policyTypes: string[] } };
    assert.deepEqual(manifest.spec.egress, [], 'deny-all is an empty egress list');
    assert.deepEqual(manifest.spec.policyTypes, ['Egress']);
  });
});
