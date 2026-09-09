/**
 * An in-cluster `KubeClient` over the Kubernetes HTTP API.
 *
 * The `K8sSandboxDriver` builds Pod specs and interprets pod state; this turns
 * those into REST calls against the API server, using the pod's own mounted
 * service-account token and CA. It is deliberately thin — one file, `fetch`, no
 * client library — because the driver holds all the logic worth testing and
 * this holds only the wire format.
 *
 * Untested by unit tests on purpose: it is the seam the driver's tests replace
 * with a fake, exactly as the container driver's tests replace the Docker CLI.
 * What can be got wrong here is the JSON shape, which only a real cluster (or an
 * integration environment) can verify.
 */

import { readFile } from 'node:fs/promises';

import type { KubeClient, KubePod, KubePodSpec } from './k8s-driver.ts';

const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

export interface KubeHttpClientOptions {
  /** API server base, e.g. `https://kubernetes.default.svc`. */
  apiServer?: string;
  /** Bearer token; read from the mounted service account when omitted. */
  token?: string;
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
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'agent',
          image: spec.image,
          workingDir: spec.workingDir,
          ports: [{ containerPort: agentPort }],
          env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
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
  }

  async #auth(): Promise<{ token: string }> {
    if (this.#token === undefined) this.#token = (await readFile(TOKEN_PATH, 'utf8')).trim();
    if (this.#ca === undefined) this.#ca = await readFile(CA_PATH).catch(() => Buffer.alloc(0));
    return { token: this.#token };
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
    const { token } = await this.#auth();
    const response = await fetch(`${this.#apiServer}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
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
    const { token } = await this.#auth();
    const response = await fetch(`${this.#apiServer}${this.#podPath(name)}/log${tail}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok ? response.text() : '';
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
    const result = await this.#call(
      'GET',
      `/api/v1/pods?labelSelector=${encodeURIComponent(labelSelector)}`,
    );
    if (result.status >= 300 || !result.json) return [];
    const items = (result.json.items as Record<string, unknown>[] | undefined) ?? [];
    return items.map((item) => fromPodObject(item));
  }

  #podPath(name: string): string {
    // The namespace is fixed per driver; a name reaching here is a pod this
    // driver created, so it needs no namespace argument.
    return `/api/v1/namespaces/${this.#ns}/pods/${name}`;
  }
}
