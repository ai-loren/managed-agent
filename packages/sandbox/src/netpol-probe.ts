/**
 * Whether this cluster actually enforces NetworkPolicy.
 *
 * The Kubernetes driver fences a restricted pod with a NetworkPolicy, and the
 * API server accepts one whatever the CNI does with it: on a cluster whose
 * network plugin does not implement policies, every fence is created, reported
 * and ignored, and a `deny` sandbox has the open network. So the driver asks the
 * cluster before trusting it, with a controlled experiment on pod-to-pod
 * traffic — the kind every policy implementation must filter. (Traffic to the
 * API server is no test: it often lands on the node itself, which iptables-based
 * plugins exempt, so a fenced pod reaches it even where policies work.)
 *
 *  - a target pod accepts TCP connections;
 *  - a control pod with no policy connects to it;
 *  - a fenced pod selected by a deny-all-egress policy tries the same.
 *
 * The control getting through and the fenced pod not is `enforced`. The fenced
 * pod getting through is `not-enforced`. The control not getting through means
 * the experiment proved nothing (an image that would not pull, a namespace that
 * denies ingress by default), which is `inconclusive`. Only `enforced` lets a
 * restricted sandbox start.
 */

import { randomBytes } from 'node:crypto';

import type { Clock } from '@ma/core';

import type { KubeClient, KubePod } from './k8s-driver.ts';

export type NetworkPolicyEnforcement = 'enforced' | 'not-enforced' | 'inconclusive';

export interface NetworkPolicyProbeOptions {
  /** An image with `sh` and `nc` (busybox has both). */
  image: string;
  namespace: string;
  /** The driver's managed label, so the reaper can find anything left behind. */
  label: string;
  clock: Clock;
  timeoutMs?: number;
}

const CONNECTED = 'MA_PROBE_CONNECTED';
const BLOCKED = 'MA_PROBE_BLOCKED';
const PORT = 8080;

/** Accept and drop connections until deleted; a TCP handshake is the whole test. */
const TARGET_SCRIPT = `while true; do nc -l -p ${PORT} < /dev/null; done`;

/**
 * The control needs one success in ten tries: a pod whose network is still
 * coming up must not read as unreachable.
 */
function controlScript(address: string): string {
  return (
    'for i in 1 2 3 4 5 6 7 8 9 10; do ' +
    `nc -z -w 2 ${address} ${PORT} && { echo ${CONNECTED}; exit 0; }; sleep 1; ` +
    `done; echo ${BLOCKED}`
  );
}

/**
 * The fenced pod lets its fence settle first — measured on k3s, kube-router
 * programs a new pod's rules about a second after it starts, and the first
 * connection gets through — then any one success in three tries means the
 * fence does not hold.
 */
function fencedScript(address: string): string {
  return (
    'sleep 5; ok=0; for i in 1 2 3; do ' +
    `nc -z -w 2 ${address} ${PORT} && ok=1; sleep 1; ` +
    `done; if [ $ok = 1 ]; then echo ${CONNECTED}; else echo ${BLOCKED}; fi`
  );
}

export async function probeNetworkPolicyEnforcement(
  kube: KubeClient,
  options: NetworkPolicyProbeOptions,
): Promise<{ verdict: NetworkPolicyEnforcement; detail: string }> {
  const id = randomBytes(4).toString('hex');
  const names = {
    target: `ma-netpol-probe-${id}-target`,
    open: `ma-netpol-probe-${id}-open`,
    fenced: `ma-netpol-probe-${id}-fenced`,
    policy: `ma-netpol-probe-${id}`,
  };
  const labels = (role: 'target' | 'open' | 'fenced'): Record<string, string> => ({
    [options.label]: 'true',
    'ma-netpol-probe': `${id}-${role}`,
  });
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = options.clock.monotonic() + timeoutMs;
  const waitFor = async (name: string, done: (pod: KubePod) => boolean): Promise<KubePod | string> => {
    for (;;) {
      const pod = await kube.getPod(name);
      if (pod && done(pod)) return pod;
      if (options.clock.monotonic() >= deadline) {
        return `did not get there within ${Math.round(timeoutMs / 1000)}s (phase ${pod?.phase ?? 'gone'}; is ${options.image} pullable?)`;
      }
      await options.clock.sleep(1_000);
    }
  };

  try {
    await kube.createNetworkPolicy({
      name: names.policy,
      namespace: options.namespace,
      labels: { [options.label]: 'true' },
      podSelector: { 'ma-netpol-probe': `${id}-fenced` },
      egress: [],
    });
    await kube.createProbePod({ name: names.target, labels: labels('target'), image: options.image, command: ['sh', '-c', TARGET_SCRIPT] });
    const target = await waitFor(names.target, (pod) => pod.phase === 'Running' && pod.podIp !== undefined);
    if (typeof target === 'string') return { verdict: 'inconclusive', detail: `the target pod ${target}` };

    await kube.createProbePod({ name: names.open, labels: labels('open'), image: options.image, command: ['sh', '-c', controlScript(target.podIp!)] });
    await kube.createProbePod({ name: names.fenced, labels: labels('fenced'), image: options.image, command: ['sh', '-c', fencedScript(target.podIp!)] });
    const outcome = async (name: string): Promise<string> => {
      const pod = await waitFor(name, (current) => current.phase === 'Succeeded' || current.phase === 'Failed');
      if (typeof pod === 'string') return pod;
      const logs = await kube.getPodLogs(name, { tailLines: 20 });
      if (logs.includes(CONNECTED)) return 'connected';
      if (logs.includes(BLOCKED)) return 'blocked';
      return `exited ${pod.phase} without a result`;
    };
    const [open, fenced] = await Promise.all([outcome(names.open), outcome(names.fenced)]);

    if (open !== 'connected') {
      return {
        verdict: 'inconclusive',
        detail: `the control pod, which no policy selects, ${open === 'blocked' ? 'could not reach the target pod either' : open}`,
      };
    }
    if (fenced === 'connected') {
      return { verdict: 'not-enforced', detail: 'a pod under a deny-all-egress NetworkPolicy reached another pod anyway' };
    }
    if (fenced === 'blocked') {
      return { verdict: 'enforced', detail: 'a deny-all-egress NetworkPolicy blocked a pod that, unfenced, got through' };
    }
    return { verdict: 'inconclusive', detail: `the fenced pod ${fenced}` };
  } catch (error) {
    return { verdict: 'inconclusive', detail: `the probe could not run: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await Promise.allSettled([
      kube.deletePod(names.target, { force: true }),
      kube.deletePod(names.open, { force: true }),
      kube.deletePod(names.fenced, { force: true }),
      kube.deleteNetworkPolicy(names.policy),
    ]);
  }
}
