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

import { MaError, sha256Hex, type Clock, type Logger } from '@ma/core';
import type { SandboxSpec } from '@ma/contracts';

import { egressProxyEnv } from './egress-grant.ts';
import { probeNetworkPolicyEnforcement, type NetworkPolicyEnforcement } from './netpol-probe.ts';
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
/**
 * Pods picked out by label in a namespace, as a NetworkPolicy peer.
 *
 * In-cluster destinations are named this way, never by a Service's ClusterIP:
 * policy is enforced on the packet after the Service address is translated to a
 * pod's, so an `ipBlock` holding a ClusterIP matches nothing and blocks the very
 * traffic it was meant to let through.
 */
export interface KubePods {
  namespace: string;
  labels: Record<string, string>;
}

export interface KubeEgressRule {
  /** CIDR blocks this rule permits, e.g. a resolver or a control plane outside the cluster. */
  cidrs?: string[];
  /** Pods this rule permits, e.g. the control plane's or the proxy's. */
  pods?: KubePods[];
  /** Named-namespace/pod selectors, e.g. to reach kube-dns. */
  toDns?: boolean;
  ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
}

/** One allowed-ingress source set: from these peers, on these ports. */
export interface KubeIngressRule {
  /** CIDR blocks this rule permits as sources. */
  cidrs?: string[];
  /** Pods this rule permits as sources. */
  pods?: KubePods[];
  ports?: { protocol: 'TCP' | 'UDP'; port: number }[];
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_NAME = /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/;
const LABEL_PREFIX = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * Parse `[namespace:]key=value[,key=value]`, the form of `MA_CONTROL_PLANE_PODS`
 * and `MA_EGRESS_PROXY_PODS`. Without a namespace the pods are looked for in
 * the sandboxes' own. A colon separates it because a label key may hold a `/`.
 */
export function parseKubePods(raw: string, setting: string): { namespace?: string; labels: Record<string, string> } {
  const refuse = (why: string): never => {
    throw new MaError({
      code: 'CONFIG_INVALID',
      category: 'validation',
      message:
        `${setting} expects [namespace:]key=value[,key=value], such as "app=managed-agent" or ` +
        `"managed-agent:app=managed-agent"; got ${JSON.stringify(raw)}: ${why}.`,
    });
  };
  const colon = raw.indexOf(':');
  const namespace = colon >= 0 ? raw.slice(0, colon).trim() : undefined;
  if (namespace !== undefined && (!DNS_LABEL.test(namespace) || namespace.length > 63)) {
    refuse(`"${namespace}" is not a namespace name`);
  }
  const labels: Record<string, string> = {};
  for (const pair of raw.slice(colon + 1).split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const equals = pair.indexOf('=');
    if (equals < 0) refuse(`"${pair}" has no "="`);
    const key = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    const slash = key.lastIndexOf('/');
    const name = key.slice(slash + 1);
    const prefix = slash >= 0 ? key.slice(0, slash) : undefined;
    if (!LABEL_NAME.test(name) || name.length > 63 || (prefix !== undefined && (!LABEL_PREFIX.test(prefix) || prefix.length > 253))) {
      refuse(`"${key}" is not a label key`);
    }
    if (value !== '' && (!LABEL_NAME.test(value) || value.length > 63)) refuse(`"${value}" is not a label value`);
    labels[key] = value;
  }
  // An empty selector picks every pod in the namespace: a hole, not a peer.
  if (Object.keys(labels).length === 0) refuse('it selects no label, so it would admit every pod in the namespace');
  return { ...(namespace !== undefined ? { namespace } : {}), labels };
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
  /** A minimal, unprivileged run-to-completion pod, for the NetworkPolicy probe. */
  createProbePod(spec: KubeProbePodSpec): Promise<void>;
}

/** A throwaway pod that runs one command and exits; see `probeNetworkPolicyEnforcement`. */
export interface KubeProbePodSpec {
  name: string;
  labels: Record<string, string>;
  image: string;
  command: string[];
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
  /** Shared with the managed egress proxy; see the container driver. */
  egressProxySecret?: string;
  /**
   * Prove the cluster enforces NetworkPolicy before the first restricted pod
   * (see `ensureNetworkPolicyEnforced`), with a probe pod of `image`. Absent,
   * the driver trusts the CNI.
   */
  networkPolicyCheck?: { image: string; ttlMs?: number; timeoutMs?: number };
  /**
   * The proxy's pods, as a NetworkPolicy peer: what an allowlist's fence lets a
   * sandbox reach besides its control plane. A namespace-less selector is
   * resolved in `namespace`.
   */
  egressProxyPods?: { namespace?: string; labels: Record<string, string> };
  /**
   * The proxy's address as a NetworkPolicy `to` CIDR — for a proxy outside the
   * cluster. Never its Service's ClusterIP, which no policy matches (see
   * `KubePods`).
   *
   * A NetworkPolicy egress rule scopes to addresses or pods, not hostnames, so
   * enforcing an allowlist at the network layer needs one of this or
   * `egressProxyPods`. Without either, the policy could only permit ports (to
   * *any* host), which is no enforcement — so an allowlist is refused rather
   * than fenced to nothing.
   */
  egressProxyCidr?: string;
  /**
   * A resolver's address a restricted pod may reach for name resolution, in
   * place of the kube-system namespace. Its pods' addresses or one outside the
   * cluster; never the DNS Service's ClusterIP, which no policy matches.
   */
  dnsCidr?: string;
  /**
   * The control plane's pods, as a NetworkPolicy peer. A namespace-less
   * selector is resolved in `namespace`.
   *
   * The control channel is not egress: a sandbox that cannot reach the control
   * plane cannot bootstrap, report events, or make a model call (every model call
   * is proxied through it). So on any *restricted* policy (`deny` or `allowlist`)
   * the NetworkPolicy always permits these pods (or `controlPlaneCidr`) plus DNS,
   * and applies the egress policy to everything else; and the sandbox's agent
   * port accepts connections from them alone. Without either, a restricted pod
   * provably cannot phone home, so provisioning one is refused rather than
   * started into a dead end.
   */
  controlPlanePods?: { namespace?: string; labels: Record<string, string> };
  /**
   * The control plane's address as a NetworkPolicy `to` CIDR — for a control
   * plane outside the cluster. Never its Service's ClusterIP, which no policy
   * matches (see `KubePods`).
   */
  controlPlaneCidr?: string;
  /**
   * The source range the control plane dials sandboxes from, for a control plane
   * that `controlPlanePods` cannot name (one outside the cluster).
   *
   * The sandbox's ingress fence on the agent port matches the *source IP* of the
   * incoming `/submit` and `/rebind` connections. A pod CIDR here admits every pod
   * in it, so with the control plane in the cluster `controlPlanePods` is the
   * fence and this is left unset.
   */
  controlPlaneIngressCidr?: string;
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
  readonly #egressProxySecret: string | undefined;
  readonly #networkPolicyCheck: { image: string; ttlMs?: number; timeoutMs?: number } | undefined;
  #netpol: { verdict: NetworkPolicyEnforcement; detail: string; until: number } | undefined;
  #netpolProbe: Promise<{ verdict: NetworkPolicyEnforcement; detail: string; until: number }> | undefined;
  readonly #egressProxyCidr: string | undefined;
  readonly #egressProxyPods: KubePods | undefined;
  readonly #dnsCidr: string | undefined;
  readonly #controlPlaneCidr: string | undefined;
  readonly #controlPlanePods: KubePods | undefined;
  readonly #controlPlaneIngressCidr: string | undefined;
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
    this.#egressProxySecret = options.egressProxySecret;
    this.#networkPolicyCheck = options.networkPolicyCheck;
    this.#egressProxyCidr = options.egressProxyCidr;
    this.#dnsCidr = options.dnsCidr;
    this.#controlPlaneCidr = options.controlPlaneCidr;
    this.#controlPlaneIngressCidr = options.controlPlaneIngressCidr;
    const inNamespace = (pods: { namespace?: string; labels: Record<string, string> } | undefined): KubePods | undefined =>
      pods ? { namespace: pods.namespace ?? this.#namespace, labels: pods.labels } : undefined;
    this.#controlPlanePods = inNamespace(options.controlPlanePods);
    this.#egressProxyPods = inNamespace(options.egressProxyPods);
    this.#volumes = options.volumes;
  }

  /**
   * Refuse unless this cluster has been shown to enforce NetworkPolicy (see
   * `probeNetworkPolicyEnforcement`). The answer is kept for `ttlMs`, and
   * provisions that arrive while the probe runs share it. Does nothing when no
   * check is configured.
   */
  async ensureNetworkPolicyEnforced(): Promise<void> {
    const check = this.#networkPolicyCheck;
    if (!check) return;
    const now = this.#clock.monotonic();
    let result = this.#netpol;
    if (!result || now >= result.until) {
      this.#netpolProbe ??= probeNetworkPolicyEnforcement(this.#kube, {
        image: check.image,
        namespace: this.#namespace,
        label: this.#label,
        clock: this.#clock,
        ...(check.timeoutMs !== undefined ? { timeoutMs: check.timeoutMs } : {}),
      })
        .then((outcome) => {
          // A pull failure or a slow cluster should not hold sandboxes back for
          // the full interval once it is fixed.
          const ttl = outcome.verdict === 'inconclusive' ? Math.min(check.ttlMs ?? 3_600_000, 60_000) : (check.ttlMs ?? 3_600_000);
          this.#netpol = { ...outcome, until: this.#clock.monotonic() + ttl };
          this.#logger?.info('NetworkPolicy enforcement probed', { verdict: outcome.verdict, detail: outcome.detail });
          return this.#netpol;
        })
        .finally(() => {
          this.#netpolProbe = undefined;
        });
      result = await this.#netpolProbe;
    }
    if (result.verdict === 'enforced') return;
    throw new MaError({
      code: 'SANDBOX_NETWORK_POLICY_UNENFORCED',
      category: 'precondition',
      message:
        `This cluster ${result.verdict === 'not-enforced' ? 'does not enforce NetworkPolicy' : 'could not be shown to enforce NetworkPolicy'} ` +
        `(${result.detail}), so a restricted-egress sandbox would run on the open pod network. Run a network plugin that ` +
        `enforces policies (Calico, Cilium, k3s's built-in controller), point MA_K8S_PROBE_IMAGE at an image with sh and nc ` +
        'that this cluster can pull, or set MA_K8S_NETWORK_POLICY_CHECK=off once you have verified enforcement yourself.',
    });
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
    if (spec.network.egress !== 'allow' && !this.#controlPlanePods && !this.#controlPlaneCidr) {
      throw new MaError({
        code: 'SANDBOX_CONTROL_PLANE_UNREACHABLE',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot provision a restricted-egress pod ` +
          `(network.egress '${spec.network.egress}') without knowing where the control plane is: ` +
          `the pod's NetworkPolicy would block its own callback to the control plane, so it could ` +
          `never bootstrap. Set MA_CONTROL_PLANE_PODS to the control-plane pods' labels (such as ` +
          `"app=managed-agent"), or MA_CONTROL_PLANE_CIDR for a control plane outside the cluster; ` +
          `or use network.egress 'allow' deliberately.`,
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
      (!this.#egressProxy || (!this.#egressProxyPods && !this.#egressProxyCidr))
    ) {
      throw new MaError({
        code: 'SANDBOX_EGRESS_UNSUPPORTED',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot enforce an egress allowlist ` +
          `(${spec.network.allowedHosts.join(', ')}) without a filtering proxy AND where its pods are ` +
          `(MA_EGRESS_PROXY, plus MA_EGRESS_PROXY_PODS or, for a proxy outside the cluster, ` +
          `MA_EGRESS_PROXY_CIDR). A NetworkPolicy scopes to pods or addresses, not hostnames, so ` +
          `without one the pod could reach any host on the proxy ports. Configure both, or use ` +
          `network.egress 'deny' or 'allow' deliberately.`,
      });
    }

    // Last of the preconditions, and the only one that talks to the cluster: a
    // restricted pod's fence is its NetworkPolicy, worth nothing on a cluster
    // that accepts policies and does not enforce them.
    if (spec.network.egress !== 'allow') await this.ensureNetworkPolicyEnforced();

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
      // Its URL carries the signed grant, a credential for the egress proxy.
      ...this.#proxyEnv(spec, request.controlPlaneUrl, request.sandboxId),
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
        // The pod-local volume name joining the volume to its mount. It must be a
        // DNS-1123 label AND injective across distinct declared names: `toDns1123Label`
        // alone is lossy (case + non-alphanumerics collapse), so `data.cache`,
        // `data-cache` and `data_cache` would all become `vol-data-cache` — two such
        // mounts would emit two `volumes[]` with the same name and k8s rejects the pod
        // (a deterministic self-inflicted DoS). Append a short hash of the *raw* name so
        // the handle stays readable but distinct names never collide.
        name: `${toDns1123Label(`vol-${mount.name}`).slice(0, 54)}-${sha256Hex(mount.name).slice(0, 8)}`,
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
    // A pods peer is matched after the Service address is translated, so on the
    // pod's own port: the URL's port is that only when the Service maps a port to
    // itself, as the shipped manifests do.
    const controlPlanePorts = new Set<number>([443, controlPlanePort(controlPlaneUrl)]);
    egress.push({
      ...(this.#controlPlanePods ? { pods: [this.#controlPlanePods] } : {}),
      ...(this.#controlPlaneCidr ? { cidrs: [this.#controlPlaneCidr] } : {}),
      ports: [...controlPlanePorts].map((port) => ({ protocol: 'TCP' as const, port })),
    });

    if (
      spec.network.egress === 'allowlist' &&
      spec.network.allowedHosts.length > 0 &&
      this.#egressProxy &&
      (this.#egressProxyPods || this.#egressProxyCidr)
    ) {
      // Egress to the proxy only (DNS already permitted above). `to`-scoped;
      // there is no ports-only "to anywhere".
      egress.push({
        ...(this.#egressProxyPods ? { pods: [this.#egressProxyPods] } : {}),
        ...(this.#egressProxyCidr ? { cidrs: [this.#egressProxyCidr] } : {}),
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
      // fence — restrict inbound on the agent port to the control plane: its pods,
      // or for one outside the cluster the range it dials from. A NetworkPolicy
      // ingress matches the packet SOURCE, so a Service ClusterIP never matches
      // here either; `controlPlaneCidr` is the fallback only for a deployment that
      // set neither, where it is the control plane's own address.
      // The kubelet's readiness probe originates from the node, which standard
      // CNIs exempt from NetworkPolicy, so /healthz keeps working.
      ingress: [
        {
          ...(this.#controlPlanePods ? { pods: [this.#controlPlanePods] } : {}),
          ...(this.#controlPlaneIngressCidr
            ? { cidrs: [this.#controlPlaneIngressCidr] }
            : this.#controlPlanePods
              ? {}
              : { cidrs: [this.#controlPlaneCidr!] }),
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
  #proxyEnv(spec: SandboxSpec, controlPlaneUrl: string, sandboxId: string): Record<string, string> {
    if (
      spec.network.egress !== 'allowlist' ||
      spec.network.allowedHosts.length === 0 ||
      !this.#egressProxy
    ) {
      return {};
    }
    return egressProxyEnv({
      proxy: this.#egressProxy,
      ...(this.#egressProxySecret ? { secret: this.#egressProxySecret } : {}),
      sandboxId,
      hosts: spec.network.allowedHosts,
      expiresAt: this.#clock.now() + spec.maxLifetimeSeconds * 1000,
      controlPlaneUrl,
    });
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
      //
      // Distinguish a CONFIRMED 404 from a FAILED probe. `getPod` returns
      // undefined only on a real 404 (pod genuinely gone) and THROWS on any
      // transient error — a 5xx, or `JSON.parse` of a non-JSON body such as an
      // HTML 502 from an in-cluster proxy. Collapsing the throw into `undefined`
      // (a bare `.catch(() => undefined)`) would read "probe failed / unknown" as
      // "gone" and strip the still-running pod's egress/ingress fence — the exact
      // fail-open this ordering exists to prevent, and it fires precisely here,
      // where the pod's real state is unknown and the follow-up probe is likely to
      // fail the same way. So only a resolved-undefined counts as gone; a thrown
      // probe leaves the fence in place for a later reap to retry.
      try {
        podGone = (await this.#kube.getPod(providerRef)) === undefined;
      } catch (probeError) {
        this.#logger?.warn('could not confirm a pod is gone; leaving its fence in place', {
          providerRef,
          error: probeError instanceof Error ? probeError.message : String(probeError),
        });
        podGone = false;
      }
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
