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

import { controlPlanePort, isLoopbackControlPlane, sanitizeEnv } from './env.ts';
import { VolumeManager } from './volumes.ts';
import { confineServiceAccount } from './identity.ts';
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
  /**
   * Platform-managed volumes to realize, each already resolved to a host
   * directory on the node. Emitted as a `hostPath` volume + a `volumeMount` at
   * the declared target; `readOnly` is enforced by the container runtime.
   */
  mounts: KubePodMount[];
  /**
   * The ServiceAccount the pod runs as, already confined to the workspace.
   * Absent (the default) leaves the pod on the namespace's `default`
   * ServiceAccount — but with `automountServiceAccountToken: false` the token is
   * never mounted either way, so the pod has no cluster-API identity. Set only
   * when the version declares `runAs`; a cloud identity provider (IRSA, Workload
   * Identity) keys off this name to grant a scoped cloud IAM role.
   */
  serviceAccountName?: string;
}

/** A resolved managed volume: a host directory bound at an absolute target. */
export interface KubePodMount {
  /** A DNS-1123 volume name, derived from the declared volume name. */
  name: string;
  /** The node-local directory the VolumeManager resolved this volume to. */
  hostPath: string;
  /** Absolute path inside the container the volume mounts at. */
  target: string;
  readOnly: boolean;
}

/** A NetworkPolicy the driver builds to constrain a pod's egress. */
export interface KubeNetworkPolicy {
  name: string;
  namespace: string;
  /** The managed label, so an orphaned policy is findable by the reaper. */
  labels: Record<string, string>;
  /** Selects the pod this policy applies to, by label. */
  podSelector: Record<string, string>;
  /**
   * Egress rules. An empty array is deny-all-egress (the policy exists and
   * permits nothing); each entry is a set of allowed destinations. `undefined`
   * would mean "no egress restriction", which the driver never emits.
   */
  egress: KubeEgressRule[];
  /**
   * Ingress rules. Present so agent-core's inbound port is reachable only by the
   * control plane, not by any co-located pod — the pod's endpoints act on the
   * session, so reachability must not equal control. Empty/absent would leave
   * ingress unrestricted; the driver emits a single control-plane rule.
   */
  ingress?: KubeIngressRule[];
}

/** One allowed-egress destination set: to these peers, on these ports. */
export interface KubeEgressRule {
  /** CIDR blocks this rule permits, e.g. the proxy or DNS. */
  cidrs?: string[];
  /** Named-namespace/pod selectors, e.g. to reach kube-dns. */
  toDns?: boolean;
  ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
}

/** One allowed-ingress source set: from these peers, on these ports. */
export interface KubeIngressRule {
  /** CIDR blocks this rule permits as sources. */
  cidrs?: string[];
  ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
}

/** A per-pod Secret holding values too sensitive to inline as pod env. */
export interface KubeSecret {
  name: string;
  namespace: string;
  /** The managed label, so an orphaned secret is findable by the reaper. */
  labels: Record<string, string>;
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
  /** Names of secrets carrying the managed label — for orphan reconciliation. */
  listSecrets(labelSelector: string): Promise<string[]>;
  /** Names of network policies carrying the managed label. */
  listNetworkPolicies(labelSelector: string): Promise<string[]>;
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
  /**
   * The proxy's address as a NetworkPolicy `to` CIDR, e.g. `10.0.5.7/32`.
   *
   * A NetworkPolicy egress rule scopes to CIDRs, not hostnames, so enforcing an
   * allowlist at the network layer needs the proxy's IP range here. Without it,
   * the policy could only permit ports (to *any* host), which is no enforcement
   * — so an allowlist is refused rather than fenced to nothing. `MA_EGRESS_PROXY`
   * alone (a URL) is not enough to build a NetworkPolicy.
   */
  egressProxyCidr?: string;
  /** DNS resolver CIDR a proxied pod may reach for name resolution. */
  dnsCidr?: string;
  /**
   * The control plane's cluster-routable CIDR, e.g. the control-plane Service's
   * ClusterIP as `10.0.7.3/32`.
   *
   * The control channel is not egress: a sandbox that cannot reach the control
   * plane cannot bootstrap, report events, or make a model call (every model call
   * is proxied through it). So on any *restricted* policy (`deny` or `allowlist`)
   * the NetworkPolicy always permits this CIDR plus DNS, and applies the egress
   * policy to everything else. Without it, a restricted pod provably cannot phone
   * home, so provisioning one is refused rather than started into a dead end.
   */
  controlPlaneCidr?: string;
  /**
   * Platform-managed volume storage. Absent means a version that declares mounts
   * is refused rather than scheduled without its persistent storage.
   */
  volumes?: VolumeManager;
}

const READY_MARKER = 'AGENT_CORE_READY';
const DEFAULT_AGENT_PORT = 8090;
const DEFAULT_NAMESPACE = 'managed-agent';

/**
 * Coerce a string into a valid DNS-1123 label for a Kubernetes metadata name:
 * lowercased, non-alphanumerics collapsed to `-`, trimmed of leading/trailing
 * `-`, and bounded to 63 chars (the label limit). Ids embed a timestamp and
 * enough entropy that the prefix stays unique after coercion.
 */
function toDns1123Label(raw: string): string {
  const label = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return label.length > 0 ? label : 'ma-sandbox';
}

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
  readonly #egressProxyCidr: string | undefined;
  readonly #dnsCidr: string | undefined;
  readonly #controlPlaneCidr: string | undefined;
  readonly #volumes: VolumeManager | undefined;

  constructor(options: K8sDriverOptions) {
    this.#clock = options.clock;
    this.#kube = options.kube;
    this.#logger = options.logger;
    this.#namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.#label = options.managedLabel ?? 'managed-agent';
    this.#agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
    this.#egressProxy = options.egressProxy;
    this.#egressProxyCidr = options.egressProxyCidr;
    this.#dnsCidr = options.dnsCidr;
    this.#controlPlaneCidr = options.controlPlaneCidr;
    this.#volumes = options.volumes;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedSandbox> {
    const { spec } = request;
    // Kubernetes metadata names must be DNS-1123 labels: lowercase alphanumerics
    // and `-`, starting/ending alphanumeric. A raw id is `sb_<ULID>` — the
    // underscore is invalid, so the API server would reject every pod/secret/
    // networkpolicy. Sanitize to a valid label (the `-env`/`-egress` suffixes are
    // appended to this already-valid base).
    const name = toDns1123Label(`ma-${request.sandboxId}`);

    // A restricted pod (`deny` or `allowlist`) must still reach the control
    // plane — it is the sandbox's lifeline (bootstrap, events, heartbeat, and
    // every model call, which is proxied through it), not a network destination
    // the egress policy governs. Building that carve-out into the NetworkPolicy
    // needs the control plane's routable CIDR; without it a restricted pod
    // provably cannot phone home, so refuse rather than start it into a dead end.
    if (spec.network.egress !== 'allow' && !this.#controlPlaneCidr) {
      throw new MaError({
        code: 'SANDBOX_CONTROL_PLANE_UNREACHABLE',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot provision a restricted-egress pod ` +
          `(network.egress '${spec.network.egress}') without the control plane's CIDR ` +
          `(MA_CONTROL_PLANE_CIDR): the pod's NetworkPolicy would block its own callback to ` +
          `the control plane, so it could never bootstrap. Set MA_CONTROL_PLANE_CIDR to the ` +
          `control-plane Service CIDR, or use network.egress 'allow' deliberately.`,
      });
    }

    // Same lifeline check as the CIDR one, on the URL: a loopback control-plane
    // URL is unreachable from inside a pod (127.0.0.1 there is the pod itself),
    // so a restricted pod given one can never bootstrap. Refuse loudly.
    if (spec.network.egress !== 'allow' && isLoopbackControlPlane(request.controlPlaneUrl)) {
      throw new MaError({
        code: 'SANDBOX_CONTROL_PLANE_UNREACHABLE',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot provision a restricted-egress pod ` +
          `(network.egress '${spec.network.egress}') with a loopback control-plane URL ` +
          `('${request.controlPlaneUrl}'): 127.0.0.1 inside a pod is the pod itself, so the ` +
          `sandbox could never reach the control plane. Set MA_CONTROL_PLANE_URL to a ` +
          `cluster-routable address (e.g. the control-plane Service DNS).`,
      });
    }

    // Refuse an unenforceable egress allowlist for the same reason the container
    // driver does: a policy that reads as restricted but grants full networking
    // is worse than a loud failure. Enforcing an allowlist needs BOTH a proxy
    // (to filter per host) AND the proxy's CIDR (to fence the pod to it at the
    // network layer). Without the CIDR the NetworkPolicy could only permit ports
    // to *any* host — no fence at all — so refuse rather than pretend.
    if (
      spec.network.egress === 'allowlist' &&
      spec.network.allowedHosts.length > 0 &&
      (!this.#egressProxy || !this.#egressProxyCidr)
    ) {
      throw new MaError({
        code: 'SANDBOX_EGRESS_UNSUPPORTED',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot enforce an egress allowlist ` +
          `(${spec.network.allowedHosts.join(', ')}) without a filtering proxy AND its CIDR ` +
          `(MA_EGRESS_PROXY + MA_EGRESS_PROXY_CIDR). A NetworkPolicy scopes to CIDRs, not ` +
          `hostnames, so without the CIDR the pod could reach any host on the proxy ports. ` +
          `Configure both, or use network.egress 'deny' or 'allow' deliberately.`,
      });
    }

    // Secrets — the runtime token and every resolved credential value — go in a
    // per-pod Secret referenced via `secretKeyRef`, never inlined as pod env,
    // which is readable by anyone with `get pods` in the namespace. Only the
    // non-secret platform variables are inlined.
    const secretName = `${name}-env`;
    const secretData: Record<string, string> = {
      // Untrusted supplied env first (sanitized). Then the trusted
      // platform-generated credential env (`MA_CRED_<NAME>` secrets), delivered
      // without sanitizeEnv (which strips all `MA_*`) and placed in the Secret
      // because its values are secrets. MA_RUNTIME_TOKEN is written last so
      // neither map can override it — the same "reserved wins by coming last"
      // ordering the container driver uses.
      ...sanitizeEnv(request.env),
      ...(request.credentialEnv ?? {}),
      MA_RUNTIME_TOKEN: request.runtimeToken,
    };
    const plainEnv: Record<string, string> = {
      MA_SANDBOX_ID: request.sandboxId,
      MA_WORKSPACE_ID: request.workspaceId,
      MA_CONTROL_PLANE_URL: request.controlPlaneUrl,
      MA_AGENT_PORT: String(this.#agentPort),
      // Bind all interfaces inside the pod: the control plane dials the pod IP
      // and the kubelet readiness probe hits the pod IP, neither of which reaches
      // an agent-core bound to 127.0.0.1. The pod network namespace is the
      // isolation boundary.
      MA_AGENT_HOST: '0.0.0.0',
      ...this.#proxyEnv(spec, request.controlPlaneUrl),
    };

    const labels = {
      [this.#label]: 'true',
      [`${this.#label}.sandbox`]: request.sandboxId,
      [`${this.#label}.workspace`]: request.workspaceId,
    };

    // Resolve declared volumes to their node-local managed directories before
    // building the pod spec. A mount with no volume storage configured is
    // refused, the same fail-closed posture as a missing egress proxy.
    const mounts = await this.#resolveMounts(request);

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
      mounts,
      // A declared identity becomes a workspace-confined ServiceAccount name: the
      // one place a workspace's `runAs` maps to a cluster identity, and it can
      // only ever name an account under its own prefix. Absent when no runAs is
      // declared, leaving the pod identity-less as before.
      ...(spec.runAs ? { serviceAccountName: confineServiceAccount(request.workspaceId, spec.runAs) } : {}),
    };

    // Create the Secret and the NetworkPolicy before the pod, so the pod never
    // exists without them. A restricted-egress pod whose NetworkPolicy cannot be
    // created is refused, not left on the open pod network — the same
    // refuse-rather-than-pretend rule the container driver holds.
    await this.#kube
      .createSecret({ name: secretName, namespace: this.#namespace, labels, data: secretData })
      .catch((error: unknown) => {
        throw this.#startupError('Failed to create the pod secret', error);
      });

    const policy = this.#networkPolicy(name, labels, spec, request.controlPlaneUrl);
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
   * Resolve the version's declared volumes to node-local host directories.
   *
   * Each is validated and confined through the VolumeManager to
   * `<root>/<workspaceId>/<name>`, never a host path from the spec. The honest
   * k8s realization of a managed named volume is a `hostPath` under that root
   * (node-local; a PVC story is a deployment concern, noted as a follow-up).
   * `pathFor` validates without creating a directory: the control plane is not
   * the node, so the manifest asks the node to create it (`DirectoryOrCreate`).
   *
   * A declared mount with no volume storage configured is refused, mirroring the
   * container driver and the egress-proxy fail-closed posture.
   */
  #resolveMounts(request: ProvisionRequest): Promise<KubePodMount[]> {
    const mounts = request.spec.mounts;
    if (mounts.length === 0) return Promise.resolve([]);
    if (!this.#volumes || !this.#volumes.enabled) {
      throw new MaError({
        code: 'SANDBOX_MOUNT_UNSUPPORTED',
        category: 'precondition',
        message:
          `The ${this.name} driver was asked to mount ${mounts.length} volume(s) but no volume ` +
          `storage is configured. Set MA_VOLUME_ROOT, or remove the mounts from the agent spec.`,
      });
    }
    const volumes = this.#volumes;
    return Promise.resolve(
      mounts.map((mount) => ({
        // A DNS-1123 label for the k8s volume name: lower-cased, non-alphanumerics
        // to dashes. The declared name is the identity; this is only the pod-local
        // handle joining the volume to its mount, so a lossy transform is fine.
        name: toDns1123Label(`vol-${mount.name}`),
        hostPath: volumes.pathFor(request.workspaceId, mount.name),
        target: mount.target,
        readOnly: mount.readOnly,
      })),
    );
  }

  /**
   * The NetworkPolicy for a pod's egress, or `undefined` for `allow` (which
   * deliberately gets no restriction).
   *
   * Every restricted policy (`deny` or `allowlist`) *always* permits egress to
   * the control-plane CIDR plus DNS, and nothing else by default. The control
   * channel is not egress: a sandbox that cannot reach the control plane cannot
   * bootstrap, report events, or make a model call (every call is proxied through
   * it), so `deny` means "reach the control plane and nothing else", not "reach
   * nothing". The caller has already refused a restricted pod with no
   * `controlPlaneCidr`, so it is present here.
   *
   * `allowlist` adds, on top of the control-plane carve-out, egress scoped to the
   * proxy's CIDR (per-host filtering is the proxy's job, but the pod cannot reach
   * anything except the control plane, the resolver, and the proxy). Scoping to
   * CIDRs (not just ports) is what makes this real: a ports-only rule with no `to`
   * permits those ports to every host, which is no fence. The caller has already
   * refused an allowlist with no proxy CIDR, so it is present here.
   *
   * DNS is a `to`-scoped rule (a resolver CIDR or the kube-dns namespace), never
   * ports-only. It is a live exfiltration channel, but a pod that can reach the
   * control plane at all already has a channel; withholding name resolution from a
   * pod that must call a DNS-named control plane would just break it. Operators
   * who want to close even that use a control-plane *IP* URL and may omit the DNS
   * rule via configuration (dnsCidr scoping keeps it to the resolver).
   */
  #networkPolicy(
    name: string,
    labels: Record<string, string>,
    spec: SandboxSpec,
    controlPlaneUrl: string,
  ): KubeNetworkPolicy | undefined {
    if (spec.network.egress === 'allow') return undefined;

    const egress: KubeEgressRule[] = [];

    // Always first: the control channel + DNS. This is what makes a restricted
    // pod able to exist as an agent. `controlPlaneCidr` is guaranteed present for
    // a restricted policy by the provision-time guard.
    egress.push({
      ...(this.#dnsCidr ? { cidrs: [this.#dnsCidr] } : { toDns: true }),
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    });
    // Outbound to the control-plane API only. The port is derived from
    // `controlPlaneUrl`, NOT hardcoded: a cluster Service reference commonly
    // lands on port 80 (loopback is refused, but `http://ma.svc` on :80 passes
    // every other guard), and any non-8080 `MA_PORT` fronted by a matching URL
    // would otherwise be dropped by the CNI — the pod could never bootstrap,
    // heartbeat, or make a model call. 443 stays allowed so a TLS control plane
    // (or model calls proxied over HTTPS) works regardless of the parsed port.
    const controlPlanePorts = new Set<number>([443, controlPlanePort(controlPlaneUrl)]);
    egress.push({
      cidrs: [this.#controlPlaneCidr!],
      ports: [...controlPlanePorts].map((port) => ({ protocol: 'TCP' as const, port })),
    });

    if (
      spec.network.egress === 'allowlist' &&
      spec.network.allowedHosts.length > 0 &&
      this.#egressProxy &&
      this.#egressProxyCidr
    ) {
      // Egress to the proxy CIDR only (DNS already permitted above). `to`-scoped;
      // there is no ports-only "to anywhere".
      egress.push({
        cidrs: [this.#egressProxyCidr],
        ports: [
          { protocol: 'TCP', port: 3128 },
          { protocol: 'TCP', port: 8080 },
          { protocol: 'TCP', port: 443 },
        ],
      });
    }
    // `deny` / empty allowlist: only the control-plane + DNS rules above — the
    // pod reaches the control plane and nothing else.

    return {
      name: `${name}-egress`,
      namespace: this.#namespace,
      labels,
      podSelector: { [`${this.#label}.sandbox`]: labels[`${this.#label}.sandbox`]! },
      egress,
      // Ingress: agent-core binds all interfaces (so the control plane and the
      // kubelet probe can reach it), which also exposes /submit and /rebind to
      // any pod that can route to this pod IP. Those endpoints act on the session
      // and are authenticated, but network reachability should not be the only
      // fence — restrict inbound on the agent port to the control-plane CIDR.
      // The kubelet's readiness probe originates from the node, which standard
      // CNIs exempt from NetworkPolicy, so /healthz keeps working.
      ingress: [
        {
          cidrs: [this.#controlPlaneCidr!],
          ports: [{ protocol: 'TCP', port: this.#agentPort }],
        },
      ],
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

  /**
   * Delete the pod and its per-pod secret and egress policy.
   *
   * Order matters for safety. The pod is deleted first; the secret and
   * NetworkPolicy are removed only once the pod is confirmed gone. Otherwise a
   * failed pod-delete followed by a successful policy-delete would strip a
   * *still-running* pod's egress fence — fail-open. And a delete error on the
   * secret is retried on a later reap rather than swallowed, because that secret
   * holds the runtime token and credential values and must not leak in etcd.
   * Idempotent: the reaper legitimately calls this for a pod already gone.
   */
  async destroy(providerRef: string, reason: string): Promise<void> {
    let podGone = false;
    try {
      await this.#kube.deletePod(providerRef, { force: true });
      podGone = true;
    } catch (error) {
      this.#logger?.warn('failed to delete a pod', {
        providerRef,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      // Confirm rather than assume: the delete may have raced a prior one.
      podGone = (await this.#kube.getPod(providerRef).catch(() => undefined)) === undefined;
    }

    // Only remove the fence once the pod it fences is actually gone. A live pod
    // must never be left on the network without its NetworkPolicy.
    if (!podGone) {
      this.#logger?.warn('leaving secret and egress policy in place; pod still present', {
        providerRef,
      });
      return;
    }

    // The secret and NetworkPolicy are named deterministically from the pod, so
    // they can be cleaned up without tracking them. Both are idempotent. A
    // failure here is logged, not swallowed, and reapOrphans will retry.
    await this.#kube.deleteSecret(`${providerRef}-env`).catch((error: unknown) => {
      this.#logger?.warn('failed to delete a pod secret; reap will retry', {
        providerRef,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await this.#kube.deleteNetworkPolicy(`${providerRef}-egress`).catch((error: unknown) => {
      this.#logger?.warn('failed to delete a pod egress policy; reap will retry', {
        providerRef,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Delete pods this driver owns that the control plane has forgotten, and
   * sweep any orphaned secrets and egress policies whose pod is already gone.
   *
   * The k8s analogue of the container driver's orphan reap: a control plane that
   * crashed mid-provision leaves labelled pods with no row pointing at them. It
   * also reconciles the two side objects — a secret or policy whose pod was
   * deleted but whose own delete failed would otherwise leak forever, since
   * nothing else keys off them.
   */
  async reapOrphans(knownRefs: readonly string[]): Promise<string[]> {
    const pods = await this.#kube.listPods(`${this.#label}=true`).catch(() => []);
    const known = new Set(knownRefs);
    const livePodNames = new Set(pods.map((pod) => pod.name));
    const orphans = pods.map((pod) => pod.name).filter((podName) => !known.has(podName));

    for (const orphan of orphans) await this.destroy(orphan, 'orphaned');
    if (orphans.length > 0) {
      this.#logger?.warn('removed orphaned pods', { count: orphans.length });
    }

    // Reconcile side objects: any secret/policy this driver created whose pod is
    // neither known nor live is orphaned and must be removed. Named `<pod>-env`
    // / `<pod>-egress`, so the owning pod name is recoverable from theirs.
    const orphanedSecrets = await this.#kube.listSecrets(`${this.#label}=true`).catch(() => []);
    for (const secret of orphanedSecrets) {
      const podName = secret.replace(/-env$/, '');
      if (!livePodNames.has(podName) && !known.has(podName)) {
        await this.#kube.deleteSecret(secret).catch(() => {});
      }
    }
    const orphanedPolicies = await this.#kube.listNetworkPolicies(`${this.#label}=true`).catch(() => []);
    for (const policy of orphanedPolicies) {
      const podName = policy.replace(/-egress$/, '');
      if (!livePodNames.has(podName) && !known.has(podName)) {
        await this.#kube.deleteNetworkPolicy(policy).catch(() => {});
      }
    }
    return orphans;
  }
}
