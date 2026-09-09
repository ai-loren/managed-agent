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
  env: Record<string, string>;
  /** Egress intent, mapped to a NetworkPolicy name or none by the caller's cluster. */
  egress: 'deny' | 'allow' | 'allowlist';
  allowedHosts: readonly string[];
  workingDir: string;
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
    // enforced through it (env below); without one, refuse.
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

    const podSpec: KubePodSpec = {
      name,
      namespace: this.#namespace,
      labels: {
        [this.#label]: 'true',
        [`${this.#label}.sandbox`]: request.sandboxId,
        [`${this.#label}.workspace`]: request.workspaceId,
      },
      image: spec.image,
      cpu: spec.cpu,
      memoryMb: spec.memoryMb,
      diskMb: spec.diskMb,
      agentPort: this.#agentPort,
      env: {
        // Credential-supplied values first, so the platform's own variables
        // below cannot be overridden by them — same rule as the container driver.
        ...sanitizeEnv(request.env),
        MA_SANDBOX_ID: request.sandboxId,
        MA_WORKSPACE_ID: request.workspaceId,
        MA_CONTROL_PLANE_URL: request.controlPlaneUrl,
        MA_RUNTIME_TOKEN: request.runtimeToken,
        MA_AGENT_PORT: String(this.#agentPort),
        ...this.#proxyEnv(spec, request.controlPlaneUrl),
      },
      egress: spec.network.egress,
      allowedHosts: spec.network.allowedHosts,
      workingDir: '/workspace',
    };

    await this.#kube.createPod(podSpec).catch((error: unknown) => {
      throw new MaError({
        code: 'SANDBOX_STARTUP_FAILED',
        category: 'unavailable',
        message: `Failed to create the pod: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    });

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
      // A pod that never became ready must not linger and hold cluster capacity.
      await this.destroy(name, 'startup failed');
      throw error;
    }
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

  /** Delete the pod. Idempotent: the reaper legitimately calls this for a pod already gone. */
  async destroy(providerRef: string, reason: string): Promise<void> {
    await this.#kube.deletePod(providerRef, { force: true }).catch((error: unknown) => {
      this.#logger?.warn('failed to delete a pod', {
        providerRef,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
