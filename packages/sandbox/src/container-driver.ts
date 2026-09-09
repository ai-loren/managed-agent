/**
 * The container driver.
 *
 * The local driver runs sandboxes as child processes, which is honest about
 * sharing the host kernel and filesystem. This one gives untrusted workloads a
 * real boundary: a separate filesystem, enforced CPU and memory limits, and a
 * network the container cannot widen from inside.
 *
 * It shells out to a container CLI rather than speaking a daemon API, which
 * makes it work with Docker, Podman and nerdctl unchanged. The cost is process
 * spawn overhead per operation, which is irrelevant against the seconds a
 * container takes to start.
 */

import { spawn } from 'node:child_process';

import { MaError, type Clock, type Logger } from '@ma/core';

import { sanitizeEnv } from './env.ts';
import type {
  ProvisionRequest,
  ProvisionedSandbox,
  SandboxDriver,
  SandboxHealth,
} from './driver.ts';

export interface ContainerDriverOptions {
  clock: Clock;
  logger?: Logger;
  /** `docker`, `podman` or `nerdctl`. */
  binary?: string;
  /** How long to wait for a container to report ready. */
  startupTimeoutMs?: number;
  /** Label applied to every container, so orphans are findable. */
  managedLabel?: string;
  /** Port the agent core listens on inside the container. */
  agentPort?: number;
  /**
   * Address of the platform's filtering egress proxy, e.g. `http://ma-egress:3128`.
   *
   * When set, an `allowlist` egress policy naming hosts is *enforced* rather than
   * refused: the container joins an egress-less internal network and its traffic
   * is forced through this proxy, which permits only the allowlisted hosts. When
   * unset, an allowlist naming hosts is still refused — a policy that reads as
   * enforced and is not is worse than a loud failure.
   */
  egressProxy?: string;
  /**
   * A container network with no egress of its own, which the container joins
   * when proxy-filtered. Being egress-less is what makes the proxy the only way
   * out — otherwise the allowlist could be bypassed by ignoring the proxy env.
   * The operator creates this network (e.g. `docker network create --internal`).
   */
  internalNetwork?: string;
}

const READY_MARKER = 'AGENT_CORE_READY';
const DEFAULT_AGENT_PORT = 8090;
const DEFAULT_INTERNAL_NETWORK = 'ma-internal';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ContainerSandboxDriver implements SandboxDriver {
  readonly name = 'container';

  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #binary: string;
  readonly #startupTimeoutMs: number;
  readonly #label: string;
  readonly #agentPort: number;
  readonly #egressProxy: string | undefined;
  readonly #internalNetwork: string;

  constructor(options: ContainerDriverOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#binary = options.binary ?? 'docker';
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
    this.#label = options.managedLabel ?? 'managed-agent';
    this.#agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
    this.#egressProxy = options.egressProxy;
    this.#internalNetwork = options.internalNetwork ?? DEFAULT_INTERNAL_NETWORK;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedSandbox> {
    const { spec } = request;
    const name = `ma-${request.sandboxId.toLowerCase()}`;

    const args = [
      'run',
      '--detach',
      '--name',
      name,
      // Labelled so an orphaned container is findable after a control-plane
      // restart, rather than lingering invisibly.
      '--label',
      `${this.#label}=true`,
      '--label',
      `${this.#label}.sandbox=${request.sandboxId}`,
      '--label',
      `${this.#label}.workspace=${request.workspaceId}`,

      // Resource limits are the point of using a container at all, so they are
      // not optional.
      '--cpus',
      String(spec.cpu),
      '--memory',
      `${spec.memoryMb}m`,
      // Without this a container under memory pressure swaps instead of being
      // killed, which turns a bounded failure into an unbounded slowdown.
      '--memory-swap',
      `${spec.memoryMb}m`,
      '--pids-limit',
      '512',

      // Defence in depth against a container escape: no new privileges, and
      // every capability dropped. An agent needs none of them.
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',

      // The agent writes only to its workspace. A read-only root filesystem
      // means a compromised process cannot persist anything into the image.
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--mount',
      `type=tmpfs,destination=/workspace,tmpfs-size=${spec.diskMb}m`,
      '--workdir',
      '/workspace',

      ...this.#networkArgs(spec.network.egress, spec.network.allowedHosts),
      '--publish',
      `127.0.0.1::${this.#agentPort}`,
    ];

    // Configuration goes through the environment, never argv: `docker inspect`
    // shows the command line to anyone who can reach the daemon.
    for (const [key, value] of Object.entries({
      // Credential-supplied values first, so the platform's own variables
      // below cannot be overridden by them. An `env_vars` credential is
      // attacker-reachable — any member who can create one controls arbitrary
      // keys — and overriding MA_CONTROL_PLANE_URL would redirect the agent's
      // event and credential-exchange traffic to a host of their choosing.
      ...sanitizeEnv(request.env),
      MA_SANDBOX_ID: request.sandboxId,
      MA_WORKSPACE_ID: request.workspaceId,
      MA_CONTROL_PLANE_URL: request.controlPlaneUrl,
      MA_RUNTIME_TOKEN: request.runtimeToken,
      MA_AGENT_PORT: String(this.#agentPort),
      // The egress proxy variables come last so a credential cannot unset them:
      // on a proxy-filtered container they are the enforcement, not a hint.
      ...this.#proxyEnv(spec.network.egress, spec.network.allowedHosts, request.controlPlaneUrl),
    })) {
      args.push('--env', `${key}=${value}`);
    }

    args.push(spec.image);

    const created = await this.#run(args);
    if (created.code !== 0) {
      throw new MaError({
        code: 'SANDBOX_STARTUP_FAILED',
        category: 'unavailable',
        message: `Failed to start the container: ${created.stderr.trim() || created.stdout.trim()}`,
        // Capacity and image-pull problems both surface here; the broker
        // classifies which from the message.
        retryable: true,
      });
    }

    try {
      await this.#awaitReady(name);
      const endpoint = await this.#resolveEndpoint(name);
      return { providerRef: name, endpoint, startedAt: this.#clock.now() };
    } catch (error) {
      // A container that never became ready must not linger.
      await this.destroy(name, 'startup failed');
      throw error;
    }
  }

  /**
   * Network arguments for an egress policy.
   *
   * `deny` uses `--network none`, enforced by the kernel rather than by
   * anything the container can reconfigure. `allow` gets bridge networking,
   * which is what it asks for.
   *
   * `allowlist` is the interesting case. An allowlist naming no hosts permits no
   * hosts, which is `--network none` — the same kernel enforcement as `deny`.
   * An allowlist naming hosts needs per-host filtering:
   *
   *  - With an `egressProxy` configured, the container joins an egress-less
   *    *internal* network and its traffic is forced through the proxy (via the
   *    `HTTP(S)_PROXY` env added in `provision`), which permits only the
   *    allowlisted hosts. Being on an internal network is what makes the proxy
   *    the only way out — otherwise the env could simply be ignored.
   *  - Without one, it is refused. Per-host filtering is impossible for this
   *    driver on its own, and a policy that reads as enforced but grants full
   *    networking is the worst outcome — worse than a loud failure that tells an
   *    operator to configure a proxy or pick `deny`/`allow` deliberately.
   */
  #networkArgs(egress: string, allowedHosts: readonly string[]): string[] {
    if (egress === 'allow') return ['--network', 'bridge'];
    if (egress === 'deny' || allowedHosts.length === 0) return ['--network', 'none'];

    if (this.#egressProxy) return ['--network', this.#internalNetwork];

    throw new MaError({
      code: 'SANDBOX_EGRESS_UNSUPPORTED',
      category: 'precondition',
      message:
        `The ${this.name} driver cannot enforce an egress allowlist (${allowedHosts.join(', ')}) ` +
        `without a filtering proxy: honouring the request is impossible and ignoring it would ` +
        `grant unrestricted network access. Configure an egress proxy, or use network.egress ` +
        `'deny' for no network, or 'allow' to accept unrestricted egress deliberately.`,
    });
  }

  /**
   * Proxy environment for a proxy-filtered container, or nothing.
   *
   * Only meaningful when an `allowlist` names hosts and a proxy is configured —
   * the same condition under which `#networkArgs` puts the container on the
   * internal network. The control-plane callback is exempted via `NO_PROXY`:
   * the runtime token exchange must reach the control plane directly, and it is
   * a trusted internal address, not a host the allowlist is about.
   */
  #proxyEnv(egress: string, allowedHosts: readonly string[], controlPlaneUrl: string): Record<string, string> {
    if (egress !== 'allowlist' || allowedHosts.length === 0 || !this.#egressProxy) return {};
    let controlPlaneHost = '';
    try {
      controlPlaneHost = new URL(controlPlaneUrl).host;
    } catch {
      // A malformed control-plane URL is a misconfiguration surfaced elsewhere;
      // here it just means no host to exempt.
    }
    const noProxy = ['127.0.0.1', 'localhost', ...(controlPlaneHost ? [controlPlaneHost] : [])].join(
      ',',
    );
    return {
      HTTP_PROXY: this.#egressProxy,
      HTTPS_PROXY: this.#egressProxy,
      NO_PROXY: noProxy,
      // Lowercase variants too: many clients read only one casing.
      http_proxy: this.#egressProxy,
      https_proxy: this.#egressProxy,
      no_proxy: noProxy,
    };
  }

  /** Wait for the ready marker on the container's logs. */
  async #awaitReady(name: string): Promise<void> {
    const deadline = this.#clock.monotonic() + this.#startupTimeoutMs;

    while (this.#clock.monotonic() < deadline) {
      const logs = await this.#run(['logs', '--tail', '50', name]);
      if (logs.stdout.includes(READY_MARKER) || logs.stderr.includes(READY_MARKER)) return;

      // A container that exited will never print the marker, so stop waiting
      // and report why it died rather than timing out uninformatively.
      const state = await this.#run(['inspect', '--format', '{{.State.Running}}', name]);
      if (state.stdout.trim() === 'false') {
        const tail = (logs.stdout + logs.stderr).slice(-500);
        throw new MaError({
          code: 'SANDBOX_STARTUP_FAILED',
          category: 'internal',
          message: `The container exited during startup${tail ? `: ${tail}` : ''}`,
        });
      }

      await this.#clock.sleep(500);
    }

    throw new MaError({
      code: 'SANDBOX_STARTUP_FAILED',
      category: 'timeout',
      message: `The container did not become ready within ${this.#startupTimeoutMs}ms`,
      retryable: true,
    });
  }

  /** The host address the published port landed on. */
  async #resolveEndpoint(name: string): Promise<string> {
    const result = await this.#run(['port', name, String(this.#agentPort)]);
    if (result.code !== 0) {
      throw new MaError({
        code: 'SANDBOX_UNREACHABLE',
        category: 'internal',
        message: 'The container started but its port could not be resolved',
      });
    }

    // Output is `127.0.0.1:49154`, sometimes with an IPv6 line too.
    const line = result.stdout.split('\n').find((entry) => entry.includes(':'));
    const port = line?.trim().split(':').pop();
    if (!port) {
      throw new MaError({
        code: 'SANDBOX_UNREACHABLE',
        category: 'internal',
        message: `Could not parse a port from '${result.stdout.trim()}'`,
      });
    }
    return `http://127.0.0.1:${port}`;
  }

  async health(providerRef: string): Promise<SandboxHealth> {
    const result = await this.#run(['inspect', '--format', '{{.State.Running}}', providerRef]);
    if (result.code !== 0) return 'gone';
    return result.stdout.trim() === 'true' ? 'healthy' : 'gone';
  }

  /**
   * Stop and remove the container. Idempotent: the reaper legitimately calls
   * this for something already gone.
   */
  async destroy(providerRef: string, reason: string): Promise<void> {
    // `--force` covers both running and stopped; `--volumes` removes the
    // anonymous volumes with it, which is where an orphan would otherwise
    // accumulate disk.
    const result = await this.#run(['rm', '--force', '--volumes', providerRef]);

    if (result.code !== 0 && !/no such container/i.test(result.stderr)) {
      this.#logger?.warn('failed to remove a container', {
        providerRef,
        reason,
        stderr: result.stderr.trim(),
      });
    }
  }

  /**
   * Remove containers this driver owns that the control plane has forgotten.
   *
   * Run at startup: a control plane that crashed mid-provision leaves running
   * containers with no row pointing at them, and nothing else will ever clean
   * them up.
   */
  async reapOrphans(knownRefs: readonly string[]): Promise<string[]> {
    const result = await this.#run([
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `label=${this.#label}=true`,
      '--format',
      '{{.Names}}',
    ]);
    if (result.code !== 0) return [];

    const known = new Set(knownRefs);
    const orphans = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !known.has(line));

    for (const orphan of orphans) await this.destroy(orphan, 'orphaned');
    if (orphans.length > 0) {
      this.#logger?.warn('removed orphaned containers', { count: orphans.length });
    }
    return orphans;
  }

  /** Run the container CLI and collect its output. */
  #run(args: readonly string[]): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(this.#binary, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

      child.once('error', (error) => {
        // A missing binary is reported as a failed command rather than thrown,
        // so every call site handles one shape.
        resolve({ code: 127, stdout, stderr: error.message });
      });
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}
