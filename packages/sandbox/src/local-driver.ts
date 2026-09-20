/**
 * The local driver: sandboxes as child processes.
 *
 * This is the driver that makes the platform runnable on a laptop with no
 * container runtime, and it is what the test suite exercises. It is genuinely
 * useful — for development, for self-hosting, and for CI — but it is honest
 * about its isolation: a child process shares the host kernel, filesystem and
 * network. It cannot enforce a restricted egress policy — there is no OS
 * namespace and no runtime-harness filter behind it — so a `deny`/`allowlist`
 * spec runs with full host network and the driver *warns* on every such
 * provision rather than silently implying enforcement. A scoped cloud identity
 * (`runAs`) it cannot honour at all and *refuses*.
 *
 * For untrusted workloads, use the container or Kubernetes driver, where the
 * same interface is backed by a real isolation boundary (and both fail closed on
 * a restricted egress spec).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MaError, type Clock, type Logger } from '@ma/core';

import { sanitizeEnv } from './env.ts';
import { VolumeManager } from './volumes.ts';
import type {
  ProvisionRequest,
  ProvisionedSandbox,
  SandboxDriver,
  SandboxHealth,
} from './driver.ts';

export interface LocalDriverOptions {
  clock: Clock;
  logger?: Logger;
  /**
   * Command that starts an agent core. Receives its configuration through the
   * environment so nothing sensitive appears in the process table, where any
   * user on the host could read it.
   */
  command?: string;
  args?: string[];
  /** How long to wait for the process to report readiness. */
  startupTimeoutMs?: number;
  /** Root for sandbox working directories. */
  workRoot?: string;
  /** Platform-managed volume storage. Absent means declared mounts are refused. */
  volumes?: VolumeManager;
}

interface LocalSandbox {
  id: string;
  child: ChildProcess;
  workDir: string;
  endpoint: string;
  /** Set when the process exits, so health can distinguish gone from silent. */
  exited?: { code: number | null; signal: NodeJS.Signals | null };
}

const READY_MARKER = 'AGENT_CORE_READY';

export class LocalSandboxDriver implements SandboxDriver {
  readonly name = 'local';

  readonly #clock: Clock;
  readonly #logger: Logger | undefined;
  readonly #command: string;
  readonly #args: string[];
  readonly #startupTimeoutMs: number;
  readonly #workRoot: string | undefined;
  readonly #volumes: VolumeManager | undefined;
  readonly #running = new Map<string, LocalSandbox>();

  constructor(options: LocalDriverOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#command = options.command ?? process.execPath;
    // Defaults to the agent core, not a bare `node`.
    //
    // This was the harness gap: the driver spawned `process.execPath` with no
    // arguments, so every sandbox started an idle Node REPL that never fetched
    // its configuration and never ran a turn. The harness, its tool policy and
    // its sub-agents were all built, tested, and unreachable — because nothing
    // pointed a process at them.
    this.#args = options.args ?? [defaultAgentCorePath()];
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.#workRoot = options.workRoot;
    this.#volumes = options.volumes;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedSandbox> {
    // A declared cloud identity (`runAs`) cannot be honoured by a child process:
    // it runs as the host user, with no service-account and no path to a scoped
    // cloud IAM role. Refuse rather than pretend — running as the host user while
    // the version asked for a confined identity is exactly the silent over-grant
    // the k8s driver's confinement exists to prevent. Use the k8s driver.
    if (request.spec.runAs) {
      throw new MaError({
        code: 'SANDBOX_IDENTITY_UNSUPPORTED',
        category: 'precondition',
        message:
          `The ${this.name} driver cannot run a sandbox as a service-account identity ` +
          `('${request.spec.runAs}'): a child process runs as the host user, so honouring it is ` +
          `impossible and ignoring it would run with more identity than the agent asked for. Use ` +
          `the Kubernetes driver, or remove runAs from the agent spec.`,
      });
    }

    // A restricted egress policy cannot be enforced by a child process: it shares
    // the host's network with no namespace, NetworkPolicy or filtering proxy — and
    // there is no runtime-harness egress enforcement to fall back on (`allowedHosts`
    // is honoured only by the container/k8s drivers). Rather than silently pretend
    // to honour it, say so loudly on every restricted provision so an operator who
    // put an untrusted workload on the dev driver learns the boundary is not real.
    // (The driver is documented as dev/self-host/CI only; untrusted workloads use
    // the container or k8s driver, which fail closed on the same spec.)
    if (request.spec.network.egress !== 'allow') {
      this.#logger?.warn('local driver cannot enforce a restricted egress policy; the sandbox has full host network', {
        sandboxId: request.sandboxId,
        egress: request.spec.network.egress,
      });
    }

    const workDir = this.#workRoot
      ? join(this.#workRoot, request.sandboxId)
      : await mkdtemp(join(tmpdir(), 'ma-sandbox-'));

    // Realize declared volumes. A local child shares the host filesystem, so
    // there is no mount namespace to enforce read-only or confinement — the
    // volume is surfaced as a symlink from the working directory to its managed
    // directory, and the env carries the resolved path. `readOnly` is advisory
    // here, as this driver's resource and egress limits already are. No host path
    // can be reached: the source is always the workspace-scoped managed dir.
    const volumeEnv = await this.#linkVolumes(request, workDir);

    const child = spawn(this.#command, this.#args, {
      cwd: workDir,
      env: {
        // Credential-supplied values first, so nothing below can be overridden
        // by them. On this driver an overridden PATH is straightforward code
        // execution as the host user.
        ...sanitizeEnv(request.env),
        // Platform-generated credential env (`MA_CRED_<NAME>` secrets). Trusted —
        // the keys are ours — so delivered without sanitizeEnv (which strips all
        // `MA_*`). After the sanitized supplied env so it cannot be shadowed, and
        // before the reserved vars below so it cannot override PATH or the token.
        ...(request.credentialEnv ?? {}),
        // A deliberately minimal environment: the host's variables are not
        // inherited, so a stray AWS_SECRET_ACCESS_KEY on a developer's machine
        // does not silently become available to every agent they run.
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: workDir,
        MA_SANDBOX_ID: request.sandboxId,
        MA_WORKSPACE_ID: request.workspaceId,
        MA_CONTROL_PLANE_URL: request.controlPlaneUrl,
        MA_RUNTIME_TOKEN: request.runtimeToken,
        ...volumeEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so killing the sandbox takes its children too
      // rather than orphaning them.
      detached: true,
    });

    const sandbox: LocalSandbox = {
      id: request.sandboxId,
      child,
      workDir,
      endpoint: '',
    };
    this.#running.set(request.sandboxId, sandbox);

    child.once('exit', (code, signal) => {
      sandbox.exited = { code, signal };
    });

    // Everything the agent core writes after startup used to go nowhere: the
    // ready-marker reader stops listening once it has its line, so a core that
    // failed mid-turn failed silently and the operator saw a session that
    // simply stopped producing events. Forwarded at debug, prefixed, so it is
    // findable without drowning the control plane's own log.
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#logger?.debug('sandbox stderr', {
        sandboxId: request.sandboxId,
        output: chunk.toString('utf8').trimEnd().slice(0, 2000),
      });
    });

    try {
      sandbox.endpoint = await this.#awaitReady(sandbox);
      return {
        providerRef: request.sandboxId,
        endpoint: sandbox.endpoint,
        startedAt: this.#clock.now(),
      };
    } catch (error) {
      await this.destroy(request.sandboxId, 'startup failed');
      throw error;
    }
  }

  /**
   * Realize the version's declared volumes for a child-process sandbox.
   *
   * A child process shares the host's mount namespace, so there is no bind mount
   * to make and no kernel-enforced read-only — the honest realization is a
   * symlink from `<workDir>/<target-basename>` to the workspace-scoped managed
   * directory, plus an env var carrying each resolved path so the agent can find
   * it deterministically. `readOnly` is advisory here, exactly as this driver's
   * resource and egress limits are; the container and k8s drivers enforce it.
   *
   * A declared mount with no volume storage configured is refused, mirroring the
   * container driver and the egress-proxy fail-closed posture: honouring it is
   * impossible and silently dropping the agent's persistence is worse than a
   * loud failure. No host path can be reached — every source is resolved through
   * the VolumeManager, which confines it under `<root>/<workspaceId>/<name>`.
   */
  async #linkVolumes(
    request: ProvisionRequest,
    workDir: string,
  ): Promise<Record<string, string>> {
    const mounts = request.spec.mounts;
    if (mounts.length === 0) return {};
    if (!this.#volumes || !this.#volumes.enabled) {
      throw new MaError({
        code: 'SANDBOX_MOUNT_UNSUPPORTED',
        category: 'precondition',
        message:
          `The ${this.name} driver was asked to mount ${mounts.length} volume(s) but no volume ` +
          `storage is configured. Set MA_VOLUME_ROOT, or remove the mounts from the agent spec.`,
      });
    }

    const env: Record<string, string> = {};
    for (const mount of mounts) {
      const source = await this.#volumes.resolve(request.workspaceId, mount.name);
      // The symlink lives beside the working directory under the mount target's
      // basename — a child process has no separate filesystem to place it at an
      // absolute target, so the reachable, non-escaping surface is the workdir.
      const linkPath = join(workDir, basename(mount.target));
      await symlink(source, linkPath).catch((error: NodeJS.ErrnoException) => {
        // A pre-existing link from an earlier provision into the same fixed
        // workRoot is fine; anything else is a real failure.
        if (error.code !== 'EEXIST') throw error;
      });
      // `MA_VOLUME_<NAME>` carries the resolved path, upper-cased and sanitized
      // to a valid env-var segment, so the agent locates its volume without
      // guessing the layout.
      const key = `MA_VOLUME_${mount.name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
      env[key] = source;
    }
    return env;
  }

  /**
   * Wait for the process to print its endpoint.
   *
   * The contract is one line on stdout: `AGENT_CORE_READY <url>`. A marker
   * rather than a port scan, because a port that happens to be open is not
   * evidence that *our* process opened it.
   */
  #awaitReady(sandbox: LocalSandbox): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let stderr = '';
      const deadline = new AbortController();

      const finish = (error?: Error, endpoint?: string): void => {
        if (settled) return;
        settled = true;
        deadline.abort();
        if (error) reject(error);
        else resolve(endpoint!);
      };

      void this.#clock.sleep(this.#startupTimeoutMs, deadline.signal).then(
        () => {
          finish(
            new Error(
              `Sandbox did not become ready within ${this.#startupTimeoutMs}ms${
                stderr ? `: ${stderr.slice(-500)}` : ''
              }`,
            ),
          );
        },
        () => {
          // Aborted because the sandbox became ready or failed first.
        },
      );

      sandbox.child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const line of text.split('\n')) {
          const marker = line.indexOf(READY_MARKER);
          if (marker >= 0) {
            finish(undefined, line.slice(marker + READY_MARKER.length).trim());
            return;
          }
        }
      });

      // Keep the tail of stderr so a startup failure explains itself instead of
      // reporting a bare timeout.
      sandbox.child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      sandbox.child.once('error', (error) => finish(error));
      sandbox.child.once('exit', (code, signal) => {
        finish(
          new Error(
            `Sandbox exited during startup with code ${code ?? 'null'} signal ${signal ?? 'none'}` +
              (stderr ? `: ${stderr.slice(-500)}` : ''),
          ),
        );
      });
    });
  }

  health(providerRef: string): Promise<SandboxHealth> {
    const sandbox = this.#running.get(providerRef);
    if (!sandbox) return Promise.resolve('gone');
    if (sandbox.exited) return Promise.resolve('gone');

    // Signal 0 tests for existence without delivering anything.
    try {
      process.kill(sandbox.child.pid!, 0);
      return Promise.resolve('healthy');
    } catch {
      return Promise.resolve('gone');
    }
  }

  /**
   * Stop the sandbox. Idempotent: destroying something already gone succeeds,
   * because the reaper legitimately calls this for vanished environments.
   */
  async destroy(providerRef: string, reason: string): Promise<void> {
    const sandbox = this.#running.get(providerRef);
    if (!sandbox) return;
    this.#running.delete(providerRef);

    if (!sandbox.exited && sandbox.child.pid) {
      try {
        // Negative pid targets the whole process group, so an agent's own
        // children go with it rather than being orphaned.
        process.kill(-sandbox.child.pid, 'SIGTERM');
        await this.#awaitExit(sandbox, 5000);
        if (!sandbox.exited) process.kill(-sandbox.child.pid, 'SIGKILL');
      } catch (error) {
        // ESRCH means it is already gone, which is the outcome we wanted.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          this.#logger?.warn('failed to signal sandbox', { providerRef, reason, error });
        }
      }
    }

    if (!this.#workRoot) {
      await rm(sandbox.workDir, { recursive: true, force: true }).catch(() => {
        // A leftover temp directory is untidy, not a failure worth propagating.
      });
    }
  }

  #awaitExit(sandbox: LocalSandbox, ms: number): Promise<void> {
    if (sandbox.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = new AbortController();
      sandbox.child.once('exit', () => {
        deadline.abort();
        resolve();
      });
      void this.#clock.sleep(ms, deadline.signal).then(
        () => resolve(),
        () => {
          // Aborted because the process exited first.
        },
      );
    });
  }

  async close(): Promise<void> {
    for (const id of [...this.#running.keys()]) {
      await this.destroy(id, 'driver shutting down');
    }
  }

  /** Live sandbox count, for tests and metrics. */
  get runningCount(): number {
    return this.#running.size;
  }
}

/**
 * Where the agent core lives, relative to this module.
 *
 * Resolved from `import.meta.url` rather than the working directory: the driver
 * runs from wherever the operator started the control plane, and a relative
 * path would break the moment someone launched it from elsewhere.
 */
function defaultAgentCorePath(): string {
  return fileURLToPath(new URL('../../../apps/agent-core/src/main.ts', import.meta.url));
}
