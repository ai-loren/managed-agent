/**
 * The NetworkPolicy enforcement probe and the k8s manifests, against real
 * clusters: k3s in Docker. Needs Docker; runs when MA_E2E_DOCKER=1.
 *
 * Two clusters. One as k3s ships, with its built-in policy controller; one
 * started with `--disable-network-policy`, which accepts NetworkPolicies and
 * enforces none — exactly the cluster the probe exists to catch. The driver
 * talks to both through `KubeHttpClient`, authenticated as the ServiceAccount
 * from deploy/k8s/rbac.yaml, so the manifests' RBAC is what is being exercised.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MaError, systemClock } from '@ma/core';

import { K8sSandboxDriver, KubeHttpClient, probeNetworkPolicyEnforcement } from '../src/index.ts';

const enabled = process.env.MA_E2E_DOCKER === '1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const K3S = 'rancher/k3s:v1.31.4-k3s1';
const PROBE_IMAGE = 'busybox:1.36';
const suffix = randomBytes(3).toString('hex');

function run(command: string, args: string[], input?: string, timeoutMs = 300_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function must(command: string, args: string[], input?: string): Promise<string> {
  const result = await run(command, args, input);
  assert.equal(result.code, 0, `${command} ${args.join(' ')}\n${result.err}`);
  return result.out.trim();
}

/** Load a local image into a k3s node; single-platform, since a multi-platform save names layers it does not carry. */
async function importImage(node: string, image: string): Promise<void> {
  const platform = await must('docker', ['image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}']);
  const result = await run('sh', ['-c', `docker save --platform ${platform} ${image} | docker exec -i ${node} ctr -n k8s.io images import -`]);
  assert.equal(result.code, 0, result.err);
}

interface Cluster {
  name: string;
  client: KubeHttpClient;
  kubectl(args: string[], input?: string): Promise<string>;
}

async function startCluster(name: string, extraArgs: string[]): Promise<Cluster> {
  await must('docker', [
    'run', '-d', '--privileged', '--name', name, '-p', '127.0.0.1::6443', K3S,
    'server', '--disable=traefik,metrics-server', '--tls-san=127.0.0.1', ...extraArgs,
  ]);
  const kubectl = (args: string[], input?: string): Promise<string> =>
    must('docker', ['exec', ...(input === undefined ? [] : ['-i']), name, 'kubectl', ...args], input);
  for (let attempt = 0; ; attempt++) {
    const nodes = await run('docker', ['exec', name, 'kubectl', 'get', 'nodes', '--no-headers']);
    if (nodes.code === 0 && / Ready /.test(nodes.out)) break;
    if (attempt > 120) assert.fail(`k3s ${name} never became ready:\n${nodes.out}${nodes.err}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  // The probe image, imported rather than pulled, so the test does not depend on a registry.
  await importImage(name, PROBE_IMAGE);

  await kubectl(['apply', '-f', '-'], await import('node:fs/promises').then((fs) => fs.readFile(`${ROOT}deploy/k8s/namespace.yaml`, 'utf8')));
  await kubectl(['apply', '-f', '-'], await import('node:fs/promises').then((fs) => fs.readFile(`${ROOT}deploy/k8s/rbac.yaml`, 'utf8')));
  // A pod can only be created once the namespace's default ServiceAccount exists.
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await run('docker', ['exec', name, 'kubectl', '-n', 'managed-agent', 'get', 'sa', 'default'])).code === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const token = await kubectl(['-n', 'managed-agent', 'create', 'token', 'managed-agent', '--duration=1h']);
  const ca = Buffer.from(await must('docker', ['exec', name, 'cat', '/var/lib/rancher/k3s/server/tls/server-ca.crt']));
  const port = (await must('docker', ['port', name, '6443/tcp'])).split(':').at(-1);
  return {
    name,
    kubectl,
    client: new KubeHttpClient({ apiServer: `https://127.0.0.1:${port}`, token, ca, namespace: 'managed-agent' }),
  };
}

let enforcing: Cluster;
let ignoring: Cluster;

describe('NetworkPolicy enforcement on real clusters', { skip: enabled ? false : 'set MA_E2E_DOCKER=1 to run against Docker' }, () => {
  before(async () => {
    await must('docker', ['pull', PROBE_IMAGE]);
    [enforcing, ignoring] = await Promise.all([
      startCluster(`ma-k3s-enforcing-${suffix}`, []),
      startCluster(`ma-k3s-ignoring-${suffix}`, ['--disable-network-policy']),
    ]);
  });

  after(async () => {
    await run('docker', ['rm', '-f', `ma-k3s-enforcing-${suffix}`, `ma-k3s-ignoring-${suffix}`]);
  });

  test('the probe finds k3s’s policy controller enforcing', async () => {
    const outcome = await probeNetworkPolicyEnforcement(enforcing.client, {
      image: PROBE_IMAGE,
      namespace: 'managed-agent',
      label: 'managed-agent',
      clock: systemClock,
    });
    assert.deepEqual(outcome, {
      verdict: 'enforced',
      detail: 'a deny-all-egress NetworkPolicy blocked a pod that, unfenced, got through',
    });
  });

  test('the probe catches a cluster that accepts policies and ignores them', async () => {
    const outcome = await probeNetworkPolicyEnforcement(ignoring.client, {
      image: PROBE_IMAGE,
      namespace: 'managed-agent',
      label: 'managed-agent',
      clock: systemClock,
    });
    assert.equal(outcome.verdict, 'not-enforced', outcome.detail);
  });

  test('the driver refuses a restricted sandbox there, and leaves nothing behind', async () => {
    const driver = new K8sSandboxDriver({
      clock: systemClock,
      kube: ignoring.client,
      namespace: 'managed-agent',
      controlPlaneCidr: '10.43.0.100/32',
      networkPolicyCheck: { image: PROBE_IMAGE },
    });
    await assert.rejects(
      driver.provision({
        sandboxId: 'SB_E2E',
        workspaceId: 'ws_e2e',
        spec: {
          image: 'managed-agent/runtime:latest', cpu: 1, memoryMb: 512, diskMb: 1024, idleTimeoutSeconds: 900,
          maxLifetimeSeconds: 3600, network: { egress: 'deny', allowedHosts: [] }, setupCommands: [], allowReuse: false,
          mounts: [], runAs: '', prewarm: 0,
        },
        env: {},
        runtimeToken: 'token',
        controlPlaneUrl: 'http://managed-agent.managed-agent.svc:8080',
      }),
      (error: unknown) => MaError.is(error) && error.code === 'SANDBOX_NETWORK_POLICY_UNENFORCED',
    );
    assert.equal(await ignoring.kubectl(['-n', 'managed-agent', 'get', 'pods,networkpolicies', '--no-headers', '--ignore-not-found']), '');
  });

  test('every manifest in deploy/k8s is accepted by a real API server', async () => {
    const rendered = await must('docker', ['run', '--rm', '-v', `${ROOT}deploy/k8s:/k8s:ro`, '--entrypoint', 'kubectl', K3S, 'kustomize', '/k8s']);
    const result = await enforcing.kubectl(['apply', '--dry-run=server', '-f', '-'], rendered);
    for (const kind of ['namespace/managed-agent', 'serviceaccount/managed-agent', 'role.rbac.authorization.k8s.io/managed-agent-sandboxes',
      'configmap/managed-agent-network', 'persistentvolumeclaim/managed-agent-data', 'deployment.apps/managed-agent',
      'service/managed-agent', 'deployment.apps/ma-egress', 'service/ma-egress', 'networkpolicy.networking.k8s.io/ma-egress-ingress']) {
      assert.match(result, new RegExp(kind.replace(/\./g, '\\.')), `${kind} was not accepted:\n${result}`);
    }
  });

  test('the egress proxy deploys from its manifest and image and becomes ready', async () => {
    const image = `managed-agent/egress-proxy:latest`;
    await must('docker', ['build', '-t', image, '-f', `${ROOT}deploy/egress-proxy/Dockerfile`, `${ROOT}apps/egress-proxy`]);
    await importImage(enforcing.name, image);
    await enforcing.kubectl(['-n', 'managed-agent', 'create', 'secret', 'generic', 'managed-agent', `--from-literal=egress-proxy-secret=${randomBytes(32).toString('base64url')}`]);
    const manifest = (await import('node:fs/promises').then((fs) => fs.readFile(`${ROOT}deploy/k8s/egress-proxy.yaml`, 'utf8')))
      // Imported, not pulled: the image exists only on this node.
      .replace('image: managed-agent/egress-proxy:latest', 'image: managed-agent/egress-proxy:latest\n          imagePullPolicy: Never');
    await enforcing.kubectl(['apply', '-f', '-'], manifest);
    const rollout = await run('docker', ['exec', enforcing.name, 'kubectl', '-n', 'managed-agent', 'rollout', 'status', 'deploy/ma-egress', '--timeout=180s']);
    assert.equal(rollout.code, 0, `${rollout.out}${rollout.err}\n${await enforcing.kubectl(['-n', 'managed-agent', 'describe', 'pods', '-l', 'app=ma-egress'])}`);
  });
});
