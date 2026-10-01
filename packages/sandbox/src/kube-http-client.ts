/**
 * An in-cluster `KubeClient` over the Kubernetes HTTP API.
 *
 * The `K8sSandboxDriver` builds Pod specs and interprets pod state; this turns
 * those into REST calls against the API server, using the pod's own mounted
 * service-account token and CA. It is deliberately thin — one file, `node:https`,
 * no client library — because the driver holds all the logic worth testing and
 * this holds only the wire format.
 *
 * The CA is not optional: the API server's certificate is signed by the
 * cluster's own CA, which no default trust store holds, so a client that does
 * not present it to TLS fails every call. (An earlier version read the CA and
 * then called `fetch`, which has no way to take it.)
 *
 * The driver's unit tests replace this with a fake; what can be got wrong here
 * is the wire format, which the k3s e2e (`netpol.docker.test.ts`) checks against
 * a real API server.
 */

import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type {
  KubeClient,
  KubeNetworkPolicy,
  KubePod,
  KubePodSpec,
  KubeProbePodSpec,
  KubeSecret,
} from './k8s-driver.ts';

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

export interface KubeHttpClientOptions {
  /** API server base, e.g. `https://kubernetes.default.svc`. */
  apiServer?: string;
  /** Bearer token; read from the mounted service account when omitted. */
  token?: string;
  /** The API server's CA, PEM; read from the mounted service account when omitted. */
  ca?: Buffer;
  /** Namespace the driver operates in; pod get/delete address it implicitly. */
  namespace?: string;
  /** Agent container port to expose on the pod. */
  agentPort?: number;
}

/**
 * Translate a driver `KubePodSpec` into a Kubernetes Pod manifest.
 *
 * Every isolation flag the container driver sets as a `docker run` argument has
 * a securityContext or volume analogue here, plus two the container driver
 * cannot express: `runAsNonRoot` and `automountServiceAccountToken: false`, so a
 * compromised sandbox has no cluster identity.
 *
 * A version may opt into a *cloud* identity with `runAs`, which the driver has
 * confined to a per-workspace `serviceAccountName`. That name is what IRSA /
 * Workload Identity keys off to grant a scoped cloud IAM role — and it works
 * with the API token still unmounted, so the pod gains a cloud identity without
 * gaining any reach into the Kubernetes API. When no identity is declared the
 * field is omitted and the pod stays as it was.
 */
export function toPodManifest(spec: KubePodSpec, agentPort: number): Record<string, unknown> {
  const cpu = String(spec.cpu);
  const memory = `${spec.memoryMb}Mi`;
  const disk = `${spec.diskMb}Mi`;

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: spec.name, namespace: spec.namespace, labels: spec.labels },
    spec: {
      // A sandbox that dies is reaped, never restarted, so its failure is visible.
      restartPolicy: 'Never',
      // No cluster identity: a compromised sandbox must not reach the API server.
      // This stays false even when a ServiceAccount is named below — a cloud
      // identity (IRSA, Workload Identity) is granted through the SA's name, not
      // through the mounted Kubernetes API token, so the pod gets a scoped cloud
      // role while still being unable to reach the cluster API.
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      // Only set when the version declared `runAs`; the driver has already
      // confined it to the workspace. Absent leaves the pod on `default`, which
      // — with the token unmounted above — carries no usable identity anyway.
      ...(spec.serviceAccountName ? { serviceAccountName: spec.serviceAccountName } : {}),
      containers: [
        {
          name: 'agent',
          image: spec.image,
          workingDir: spec.workingDir,
          ports: [{ containerPort: agentPort }],
          // Non-secret vars inline; secret vars via secretKeyRef so they never
          // appear in the Pod object (`kubectl get pod -o yaml`).
          env: [
            ...Object.entries(spec.env).map(([name, value]) => ({ name, value })),
            ...spec.secretEnv.map((name) => ({
              name,
              valueFrom: { secretKeyRef: { name: spec.secretName, key: name } },
            })),
          ],
          resources: {
            limits: { cpu, memory, 'ephemeral-storage': disk },
            requests: { cpu, memory, 'ephemeral-storage': disk },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'tmp', mountPath: '/tmp' },
            // Managed named volumes: the one durable, potentially-writable
            // surface, each gated by its own read-only flag. The read-only root,
            // dropped capabilities and non-root user above are untouched.
            ...spec.mounts.map((mount) => ({
              name: mount.name,
              mountPath: mount.target,
              readOnly: mount.readOnly,
            })),
          ],
          readinessProbe: {
            httpGet: { path: '/healthz', port: agentPort },
            periodSeconds: 2,
            failureThreshold: 60,
          },
        },
      ],
      volumes: [
        { name: 'workspace', emptyDir: { sizeLimit: disk } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
        // Each managed volume is a node-local hostPath under the platform's
        // volume root — the source the VolumeManager resolved, never a path from
        // the spec. `DirectoryOrCreate` lets the node create it on first mount,
        // since the control plane that resolved the path is not the node.
        ...spec.mounts.map((mount) => ({
          name: mount.name,
          hostPath: { path: mount.hostPath, type: 'DirectoryOrCreate' },
        })),
      ],
    },
  };
}

/** Map a raw Pod object from the API into the driver's narrow view. */
export function fromPodObject(pod: Record<string, unknown>): KubePod {
  const metadata = (pod.metadata ?? {}) as { name?: string; labels?: Record<string, string> };
  const status = (pod.status ?? {}) as {
    phase?: string;
    podIP?: string;
    conditions?: { type?: string; status?: string }[];
  };
  const ready = (status.conditions ?? []).some(
    (condition) => condition.type === 'Ready' && condition.status === 'True',
  );
  return {
    name: metadata.name ?? '',
    phase: (status.phase as KubePod['phase']) ?? 'Unknown',
    ready,
    ...(status.podIP ? { podIp: status.podIP } : {}),
    labels: metadata.labels ?? {},
  };
}

/** Translate a driver secret into a Kubernetes Secret manifest. */
export function toSecretManifest(secret: KubeSecret): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: { name: secret.name, namespace: secret.namespace, labels: secret.labels },
    // `stringData` takes plaintext; the API server base64-encodes it. The values
    // are still stored in etcd, but they are out of the Pod object, which is what
    // a namespace pod-reader can see.
    stringData: secret.data,
  };
}

/**
 * Translate a driver NetworkPolicy into a Kubernetes NetworkPolicy manifest.
 *
 * The policy selects the sandbox pod and lists its permitted egress. An empty
 * `egress` array is deny-all — the policy exists and allows nothing, which in
 * Kubernetes is how "this pod may not reach the network" is expressed (a pod
 * that no policy selects, by contrast, is unrestricted).
 *
 * A rule with ports but no destination is *dropped*, never emitted: in
 * NetworkPolicy v1 a ports-only rule permits those ports to every host, which
 * would be an accidental allow-to-anywhere. Every real rule scopes to a `to`.
 */
export function toNetworkPolicyManifest(policy: KubeNetworkPolicy): Record<string, unknown> {
  const egress: Record<string, unknown>[] = [];
  for (const rule of policy.egress) {
    const to: Record<string, unknown>[] = [];
    for (const cidr of rule.cidrs ?? []) to.push({ ipBlock: { cidr } });
    if (rule.toDns) {
      // Reach kube-dns in kube-system. Selecting the namespace is enough for the
      // common CoreDNS layout; an operator with a bespoke DNS setup adjusts it.
      to.push({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } });
    }
    // Never emit a ports-only rule: that would allow those ports to any host.
    if (to.length === 0) continue;
    egress.push({ to, ...(rule.ports ? { ports: rule.ports } : {}) });
  }

  const ingress: Record<string, unknown>[] = [];
  for (const rule of policy.ingress ?? []) {
    const from: Record<string, unknown>[] = [];
    for (const cidr of rule.cidrs ?? []) from.push({ ipBlock: { cidr } });
    // Never emit a ports-only ingress rule: with no `from` it would allow those
    // ports from any source, defeating the point of restricting inbound.
    if (from.length === 0) continue;
    ingress.push({ from, ...(rule.ports ? { ports: rule.ports } : {}) });
  }

  // Name only the policy types we actually constrain. Egress is always present;
  // Ingress only when an ingress rule was built, so a policy that (wrongly) had
  // no ingress rule cannot silently become deny-all-ingress and cut the pod off
  // from the control plane.
  const policyTypes = ['Egress', ...(ingress.length > 0 ? ['Ingress'] : [])];

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: policy.name, namespace: policy.namespace, labels: policy.labels },
    spec: {
      podSelector: { matchLabels: policy.podSelector },
      policyTypes,
      egress,
      ...(ingress.length > 0 ? { ingress } : {}),
    },
  };
}

export class KubeHttpClient implements KubeClient {
  readonly #apiServer: string;
  readonly #agentPort: number;
  readonly #ns: string;
  #token: string | undefined;
  #ca: Buffer | undefined;

  constructor(options: KubeHttpClientOptions = {}) {
    // Default to the in-cluster service address the API server always answers on.
    this.#apiServer = options.apiServer ?? 'https://kubernetes.default.svc';
    this.#agentPort = options.agentPort ?? 8090;
    this.#ns = options.namespace ?? 'managed-agent';
    this.#token = options.token;
    this.#ca = options.ca;
  }

  async #auth(): Promise<{ token: string; ca: Buffer | undefined }> {
    if (this.#token === undefined) this.#token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    if (this.#ca === undefined) this.#ca = await readFile(CA_PATH).catch(() => Buffer.alloc(0));
    return { token: this.#token, ca: this.#ca.length > 0 ? this.#ca : undefined };
  }

  /** One API call: status and raw body text. */
  async #send(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const { token, ca } = await this.#auth();
    const url = new URL(`${this.#apiServer}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          },
          ...(ca ? { ca } : {}),
          timeout: 30_000,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (text += chunk));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
          response.on('error', reject);
        },
      );
      outgoing.on('timeout', () => outgoing.destroy(new Error(`${method} ${path}: the API server did not answer in 30s`)));
      outgoing.on('error', reject);
      outgoing.end(payload);
    });
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
    const { status, text } = await this.#send(method, path, body);
    return { status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  }

  async createProbePod(spec: KubeProbePodSpec): Promise<void> {
    const result = await this.#call('POST', `/api/v1/namespaces/${this.#ns}/pods`, {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: spec.name, namespace: this.#ns, labels: spec.labels },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [
          {
            name: 'probe',
            image: spec.image,
            command: spec.command,
            resources: { limits: { cpu: '100m', memory: '32Mi' }, requests: { cpu: '10m', memory: '16Mi' } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          },
        ],
      },
    });
    if (result.status >= 300) {
      throw new Error((result.json?.message as string) ?? `createProbePod: HTTP ${result.status}`);
    }
  }

  async createPod(spec: KubePodSpec): Promise<void> {
    const manifest = toPodManifest(spec, this.#agentPort);
    const result = await this.#call(
      'POST',
      `/api/v1/namespaces/${spec.namespace}/pods`,
      manifest,
    );
    if (result.status >= 300) {
      const message = (result.json?.message as string) ?? `HTTP ${result.status}`;
      throw new Error(message);
    }
  }

  async getPod(name: string): Promise<KubePod | undefined> {
    const result = await this.#call('GET', this.#podPath(name));
    if (result.status === 404) return undefined;
    if (result.status >= 300 || !result.json) throw new Error(`getPod ${name}: HTTP ${result.status}`);
    return fromPodObject(result.json);
  }

  async getPodLogs(name: string, options: { tailLines?: number } = {}): Promise<string> {
    const tail = options.tailLines ? `?tailLines=${options.tailLines}` : '';
    const result = await this.#send('GET', `${this.#podPath(name)}/log${tail}`);
    return result.status < 300 ? result.text : '';
  }

  async deletePod(name: string, options: { force?: boolean } = {}): Promise<void> {
    const grace = options.force ? '?gracePeriodSeconds=0' : '';
    const result = await this.#call('DELETE', `${this.#podPath(name)}${grace}`);
    // 404 is success: the reaper legitimately deletes a pod already gone.
    if (result.status >= 300 && result.status !== 404) {
      throw new Error(`deletePod ${name}: HTTP ${result.status}`);
    }
  }

  async listPods(labelSelector: string): Promise<KubePod[]> {
    // Namespace-scoped, matching get/delete. A cluster-wide `/api/v1/pods` would
    // demand cluster-scoped list permission the driver otherwise never needs —
    // and a correctly least-privileged ServiceAccount would get 403, which this
    // swallows to [], silently disabling orphan reap exactly when RBAC is tight.
    const result = await this.#call(
      'GET',
      `/api/v1/namespaces/${this.#ns}/pods?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
    if (result.status >= 300 || !result.json) return [];
    const items = (result.json.items as Record<string, unknown>[] | undefined) ?? [];
    return items.map((item) => fromPodObject(item));
  }

  async createSecret(secret: KubeSecret): Promise<void> {
    const result = await this.#call(
      'POST',
      `/api/v1/namespaces/${this.#ns}/secrets`,
      toSecretManifest(secret),
    );
    if (result.status >= 300) {
      throw new Error((result.json?.message as string) ?? `createSecret: HTTP ${result.status}`);
    }
  }

  async deleteSecret(name: string): Promise<void> {
    const result = await this.#call('DELETE', `/api/v1/namespaces/${this.#ns}/secrets/${name}`);
    if (result.status >= 300 && result.status !== 404) {
      throw new Error(`deleteSecret ${name}: HTTP ${result.status}`);
    }
  }

  async listSecrets(labelSelector: string): Promise<string[]> {
    const result = await this.#call(
      'GET',
      `/api/v1/namespaces/${this.#ns}/secrets?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
    return this.#names(result);
  }

  async createNetworkPolicy(policy: KubeNetworkPolicy): Promise<void> {
    const result = await this.#call(
      'POST',
      `/apis/networking.k8s.io/v1/namespaces/${this.#ns}/networkpolicies`,
      toNetworkPolicyManifest(policy),
    );
    if (result.status >= 300) {
      throw new Error(
        (result.json?.message as string) ?? `createNetworkPolicy: HTTP ${result.status}`,
      );
    }
  }

  async deleteNetworkPolicy(name: string): Promise<void> {
    const result = await this.#call(
      'DELETE',
      `/apis/networking.k8s.io/v1/namespaces/${this.#ns}/networkpolicies/${name}`,
    );
    if (result.status >= 300 && result.status !== 404) {
      throw new Error(`deleteNetworkPolicy ${name}: HTTP ${result.status}`);
    }
  }

  async listNetworkPolicies(labelSelector: string): Promise<string[]> {
    const result = await this.#call(
      'GET',
      `/apis/networking.k8s.io/v1/namespaces/${this.#ns}/networkpolicies?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
    return this.#names(result);
  }

  /** Pull `metadata.name` from a list response's items. */
  #names(result: { status: number; json: Record<string, unknown> | undefined }): string[] {
    if (result.status >= 300 || !result.json) return [];
    const items = (result.json.items as { metadata?: { name?: string } }[] | undefined) ?? [];
    return items.map((item) => item.metadata?.name ?? '').filter((name) => name.length > 0);
  }

  #podPath(name: string): string {
    // The namespace is fixed per driver; a name reaching here is a pod this
    // driver created, so it needs no namespace argument.
    return `/api/v1/namespaces/${this.#ns}/pods/${name}`;
  }
}
