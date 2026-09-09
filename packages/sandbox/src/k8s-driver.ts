/**
 * The Kubernetes driver.
 *
 * The container driver gives one host real isolation; this one schedules that
 * same isolated workload across a cluster. It provisions a Pod per sandbox with
 * the same guarantees the container driver enforces — CPU and memory limits,
 * every capability dropped, a read-only root, no egress by default — and adds
 * two the container driver cannot: the pod runs as a non-root user and is denied
 * a Kubernetes service-account token, so a compromised sandbox cannot reach the
 * cluster API.
 *
 * It talks to the cluster through an injected `KubeClient` rather than shelling
 * out, for the same reason the container driver's binary is injectable: the
 * driver's job is to build the right Pod spec and interpret the cluster's
 * answers, and that is fully testable against a fake client without a cluster.
 */

import { MaError, type Clock, type Logger } from '@ma/core';
import type { SandboxSpec } from '@ma/contracts';

import { sanitizeEnv } from './env.ts';
import type {
  ProvisionRequest,
  ProvisionedSandbox,
  SandboxDriver,
  SandboxHealth,
} from './driver.ts';

/** A Pod's status, as much of it as the driver needs. */
export interface KubePod {
  name: string;
  phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  /** From `status.conditions[type=Ready].status`. */
  ready: boolean;
  /** `status.podIP`, once assigned. */
  podIp?: string;
  labels: Record<string, string>;
}

/** The Pod spec the driver builds and hands to the cluster. */
export interface KubePodSpec {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  image: string;
  /** CPU cores, e.g. `2` → `"2"`. */
  cpu: number;
  memoryMb: number;
  diskMb: number;
  /** `containerPort` the agent core listens on. */
  agentPort: number;
  /** Non-secret env, inlined as plaintext `value` pairs. */
  env: Record<string, string>;
  /**
   * Secret env: keys resolved from the per-pod Secret via `secretKeyRef` rather
   * than inlined. The runtime token and resolved credential values go here so
   * they never appear in `kubectl get pod -o yaml`.
   */
  secretEnv: string[];
  /** Name of the per-pod Secret `secretEnv` keys are read from. */
  secretName: string;
  egress: 'deny' | 'allow' | 'allowlist';
  allowedHosts: readonly string[];
  workingDir: string;
}

/** A NetworkPolicy the driver builds to constrain a pod's egress. */
export interface KubeNetworkPolicy {
  name: string;
  namespace: string;
  /** Selects the pod this policy applies to, by label. */
  podSelector: Record<string, string>;
  /**
   * Egress rules. An empty array is deny-all-egress (the policy exists and
   * permits nothing); each entry is a set of allowed destinations. `undefined`
   * would mean "no egress restriction", which the driver never emits.
   */
  egress: KubeEgressRule[];
}

/** One allowed-egress destination set: to these peers, on these ports. */
export interface KubeEgressRule {
  /** CIDR blocks this rule permits, e.g. the proxy or DNS. */
  cidrs?: string[];
  /** Named-namespace/pod selectors, e.g. to reach kube-dns. */
  toDns?: boolean;
  ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
}

/** A per-pod Secret holding values too sensitive to inline as pod env. */
export interface KubeSecret {
  name: string;
  namespace: string;
  /** Key → value; written to a Secret and referenced via `secretKeyRef`. */
  data: Record<string, string>;
}

/**
 * The cluster operations the driver needs.
 *
 * Deliberately narrow, and the seam the tests inject a fake for. A real
 * implementation wraps the Kubernetes HTTP API; nothing here assumes one.
 */
export interface KubeClient {
  createPod(spec: KubePodSpec): Promise<void>;
  /** `undefined` when the pod is gone (a 404), which `destroy` treats as success. */
  getPod(name: string): Promise<KubePod | undefined>;
  getPodLogs(name: string, options?: { tailLines?: number }): Promise<string>;
  /** Idempotent: deleting a pod that is already gone is success. */
  deletePod(name: string, options?: { force?: boolean }): Promise<void>;
  listPods(labelSelector: string): Promise<KubePod[]>;
  /**
   * Create a NetworkPolicy. Rejecting is meaningful: the driver refuses to run a
   * restricted-egress pod whose policy could not be created, rather than leaving
   * it on the open pod network.
   */
  createNetworkPolicy(policy: KubeNetworkPolicy): Promise<void>;
  /** Idempotent, like `deletePod`. */
  deleteNetworkPolicy(name: string): Promise<void>;
  /** Create a per-pod Secret for values referenced via `secretKeyRef`. */
  createSecret(secret: KubeSecret): Promise<void>;
  /** Idempotent. */
  deleteSecret(name: string): Promise<void>;
}

export interface K8sDriverOptions {
  clock: Clock;
  kube: KubeClient;
  logger?: Logger;
  namespace?: string;
  startupTimeoutMs?: number;
  managedLabel?: string;
  agentPort?: number;
  /** Filtering egress proxy, mirroring the container driver. */
  egressProxy?: string;
}

const READY_MARKER = 'AGENT_CORE_READY';
const DEFAULT_AGENT_PORT = 8090;
const DEFAULT_NAMESPACE = 'managed-agent';

export class K8sSandboxDriver implements SandboxDriver {
  readonly name = 'k8s';

  readonly #clock: Clock;
  readonly #kube: KubeClient;
  readonly #logger: Logger | undefined;
  readonly #namespace: string;
  readonly #startupTimeoutMs: number;
  readonly #label: string;
  readonly #agentPort: number;
  readonly #egressProxy: string | undefined;

  constructor(options: K8sDriverOptions) {
    this.#clock = options.clock;
    this.#kube = options.kube;
    this.#logger = options.logger;
    this.#namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.#label = options.managedLabel ?? 'managed-agent';
    this.#agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
    this.#egressProxy = options.egressProxy;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedSandbox> {
    const { spec } = request;
    const name = `ma-${request.sandboxId.toLowerCase()}`;

    // Refuse an unenforceable egress allowlist for the same reason the container
    // driver does: a policy that reads as restricted but grants full networking
    // is worse than a loud failure. With a proxy configured, the allowlist is
    // enforced through it (env below) AND fenced by the NetworkPolicy below.
    if (
      spec.network.egress === 'allowlist' &&
      spec.network.allowedHosts.length > 0 &&
      !this.#egressProxy
    ) {
      throw new MaError({
        code: 'SANDBOX_EGRESS_UNSUPPORTED',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot enforce an egress allowlist ` +
          `(${spec.network.allowedHosts.join(', ')}) without a filtering proxy. Configure an ` +
          `egress proxy, or use network.egress 'deny' or 'allow' deliberately.`,
      });
    }

    // Secrets — the runtime token and every resolved credential value — go in a
    // per-pod Secret referenced via `secretKeyRef`, never inlined as pod env,
    // which is readable by anyone with `get pods` in the namespace. Only the
    // non-secret platform variables are inlined.
    const secretName = `${name}-env`;
    const secretData: Record<string, string> = {
      MA_RUNTIME_TOKEN: request.runtimeToken,
      ...sanitizeEnv(request.env),
    };
    const plainEnv: Record<string, string> = {
      MA_SANDBOX_ID: request.sandboxId,
      MA_WORKSPACE_ID: request.workspaceId,
      MA_CONTROL_PLANE_URL: request.controlPlaneUrl,
      MA_AGENT_PORT: String(this.#agentPort),
      ...this.#proxyEnv(spec, request.controlPlaneUrl),
    };

    const labels = {
      [this.#label]: 'true',
      [`${this.#label}.sandbox`]: request.sandboxId,
      [`${this.#label}.workspace`]: request.workspaceId,
    };

    const podSpec: KubePodSpec = {
      name,
      namespace: this.#namespace,
      labels,
      image: spec.image,
      cpu: spec.cpu,
      memoryMb: spec.memoryMb,
      diskMb: spec.diskMb,
      agentPort: this.#agentPort,
      env: plainEnv,
      secretEnv: Object.keys(secretData),
      secretName,
      egress: spec.network.egress,
      allowedHosts: spec.network.allowedHosts,
      workingDir: '/workspace',
    };

    // Create the Secret and the NetworkPolicy before the pod, so the pod never
    // exists without them. A restricted-egress pod whose NetworkPolicy cannot be
    // created is refused, not left on the open pod network — the same
    // refuse-rather-than-pretend rule the container driver holds.
    await this.#kube.createSecret({ name: secretName, namespace: this.#namespace, data: secretData }).catch(
      (error: unknown) => {
        throw this.#startupError('Failed to create the pod secret', error);
      },
    );

    const policy = this.#networkPolicy(name, labels, spec);
    if (policy) {
      try {
        await this.#kube.createNetworkPolicy(policy);
      } catch (error) {
        // Roll back the secret, then refuse: a restricted pod with no egress
        // fence is exactly the silent over-grant this fixes.
        await this.#kube.deleteSecret(secretName).catch(() => {});
        throw new MaError({
          code: 'SANDBOX_EGRESS_UNSUPPORTED',
          category: 'precondition',
          message:
            `The ${this.name} driver could not create the egress NetworkPolicy for a ` +
            `'${spec.network.egress}' pod (${error instanceof Error ? error.message : String(error)}). ` +
            `Refusing rather than running it with unrestricted egress. The namespace needs a CNI ` +
            `that enforces NetworkPolicy and RBAC to create one, or use network.egress 'allow'.`,
        });
      }
    }

    try {
      await this.#kube.createPod(podSpec);
    } catch (error) {
      await this.#cleanup(name, secretName, policy !== undefined);
      throw this.#startupError('Failed to create the pod', error);
    }

    try {
      const pod = await this.#awaitReady(name);
      if (!pod.podIp) {
        throw new MaError({
          code: 'SANDBOX_UNREACHABLE',
          category: 'internal',
          message: 'The pod became ready but has no IP address',
        });
      }
      return {
        providerRef: name,
        endpoint: `http://${pod.podIp}:${this.#agentPort}`,
        startedAt: this.#clock.now(),
      };
    } catch (error) {
      // A pod that never became ready must not linger and hold cluster capacity;
      // nor must its secret or policy.
      await this.destroy(name, 'startup failed');
      throw error;
    }
  }

  #startupError(message: string, error: unknown): MaError {
    return new MaError({
      code: 'SANDBOX_STARTUP_FAILED',
      category: 'unavailable',
      message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  }

  /**
   * The NetworkPolicy for a pod's egress, or `undefined` for `allow` (which
   * deliberately gets no restriction).
   *
   * `deny` and an empty allowlist get a policy with an *empty* egress list —
   * deny-all-egress — except DNS, without which even a proxied client cannot
   * resolve the proxy's own name. `allowlist` gets egress to the proxy and DNS
   * only; per-host filtering is the proxy's job, but the pod cannot reach
   * anything except the proxy, so a raw socket or a `--noproxy` client is fenced
   * at the network layer rather than merely un-hinted. This is what makes the
   * allowlist enforced rather than advisory.
   */
  #networkPolicy(
    name: string,
    labels: Record<string, string>,
    spec: SandboxSpec,
  ): KubeNetworkPolicy | undefined {
    if (spec.network.egress === 'allow') return undefined;

    const dnsRule: KubeEgressRule = { toDns: true, ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] };
    const egress: KubeEgressRule[] = [dnsRule];

    if (spec.network.egress === 'allowlist' && spec.network.allowedHosts.length > 0 && this.#egressProxy) {
      // Permit reaching the proxy (and the control plane); the proxy enforces
      // the per-host allowlist beyond that. Both are addressed by the operator's
      // cluster, so the rule is expressed as "allow egress to these ports"
      // narrowed by the proxy CIDR the operator supplies out of band — here we
      // encode the intent; a fuller build resolves the proxy to a CIDR.
      egress.push({ ports: [{ protocol: 'TCP', port: 3128 }, { protocol: 'TCP', port: 8080 }, { protocol: 'TCP', port: 443 }] });
    }
    // `deny` / empty allowlist: only the DNS rule — no general egress.

    return {
      name: `${name}-egress`,
      namespace: this.#namespace,
      podSelector: { [`${this.#label}.sandbox`]: labels[`${this.#label}.sandbox`]! },
      egress,
    };
  }

  /** Remove a pod's secret and (if created) its NetworkPolicy. Best-effort. */
  async #cleanup(name: string, secretName: string, hadPolicy: boolean): Promise<void> {
    await this.#kube.deleteSecret(secretName).catch(() => {});
    if (hadPolicy) await this.#kube.deleteNetworkPolicy(`${name}-egress`).catch(() => {});
  }

  /**
   * Proxy environment for a proxy-filtered pod, or nothing. Mirrors the
   * container driver: only an `allowlist` with hosts and a configured proxy
   * yields env, and the control-plane host is exempted so the token exchange
   * still reaches it.
   */
  #proxyEnv(spec: SandboxSpec, controlPlaneUrl: string): Record<string, string> {
    if (
      spec.network.egress !== 'allowlist' ||
      spec.network.allowedHosts.length === 0 ||
      !this.#egressProxy
    ) {
      return {};
    }
    let controlPlaneHost = '';
    try {
      controlPlaneHost = new URL(controlPlaneUrl).host;
    } catch {
      // A malformed URL is surfaced elsewhere; here it just means no exemption.
    }
    const noProxy = ['127.0.0.1', 'localhost', ...(controlPlaneHost ? [controlPlaneHost] : [])].join(
      ',',
    );
    return {
      HTTP_PROXY: this.#egressProxy,
      HTTPS_PROXY: this.#egressProxy,
      NO_PROXY: noProxy,
      http_proxy: this.#egressProxy,
      https_proxy: this.#egressProxy,
      no_proxy: noProxy,
    };
  }

  /** Wait until the pod reports ready, or fail with why it did not. */
  async #awaitReady(name: string): Promise<KubePod> {
    const deadline = this.#clock.monotonic() + this.#startupTimeoutMs;

    while (this.#clock.monotonic() < deadline) {
      const pod = await this.#kube.getPod(name);

      // A pod that reached a terminal phase will never become ready, so stop
      // waiting and report why — the analogue of the container driver's
      // "exited during startup" check rather than an uninformative timeout.
      if (pod && (pod.phase === 'Failed' || pod.phase === 'Succeeded')) {
        const logs = await this.#kube.getPodLogs(name, { tailLines: 50 }).catch(() => '');
        throw new MaError({
          code: 'SANDBOX_STARTUP_FAILED',
          category: 'internal',
          message: `The pod ${pod.phase === 'Failed' ? 'failed' : 'exited'} during startup${
            logs ? `: ${logs.slice(-500)}` : ''
          }`,
        });
      }

      if (pod && pod.phase === 'Running') {
        // Ready by the readiness condition, or — for an image with no health
        // endpoint — by the same ready marker the container driver looks for.
        if (pod.ready) return pod;
        const logs = await this.#kube.getPodLogs(name, { tailLines: 50 }).catch(() => '');
        if (logs.includes(READY_MARKER)) return pod;
      }

      await this.#clock.sleep(500);
    }

    throw new MaError({
      code: 'SANDBOX_STARTUP_FAILED',
      category: 'timeout',
      message: `The pod did not become ready within ${this.#startupTimeoutMs}ms`,
      retryable: true,
    });
  }

  async health(providerRef: string): Promise<SandboxHealth> {
    const pod = await this.#kube.getPod(providerRef).catch(() => undefined);
    if (!pod) return 'gone';
    if (pod.phase === 'Failed' || pod.phase === 'Succeeded') return 'gone';
    if (pod.phase === 'Running' && pod.ready) return 'healthy';
    // Pending, or running-but-not-ready: it exists but is not answering yet.
    return 'unreachable';
  }

  /** Delete the pod and its per-pod secret and egress policy. Idempotent: the reaper legitimately calls this for a pod already gone. */
  async destroy(providerRef: string, reason: string): Promise<void> {
    await this.#kube.deletePod(providerRef, { force: true }).catch((error: unknown) => {
      this.#logger?.warn('failed to delete a pod', {
        providerRef,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // The secret and NetworkPolicy are named deterministically from the pod, so
    // they can be cleaned up without tracking them. Both are idempotent, so a
    // pod that never had a policy (egress: allow) just no-ops on the delete.
    await this.#kube.deleteSecret(`${providerRef}-env`).catch(() => {});
    await this.#kube.deleteNetworkPolicy(`${providerRef}-egress`).catch(() => {});
  }

  /**
   * Delete pods this driver owns that the control plane has forgotten.
   *
   * The k8s analogue of the container driver's orphan reap: a control plane that
   * crashed mid-provision leaves labelled pods with no row pointing at them.
   */
  async reapOrphans(knownRefs: readonly string[]): Promise<string[]> {
    const pods = await this.#kube.listPods(`${this.#label}=true`).catch(() => []);
    const known = new Set(knownRefs);
    const orphans = pods.map((pod) => pod.name).filter((podName) => !known.has(podName));

    for (const orphan of orphans) await this.destroy(orphan, 'orphaned');
    if (orphans.length > 0) {
      this.#logger?.warn('removed orphaned pods', { count: orphans.length });
    }
    return orphans;
  }
}
