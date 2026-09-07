/**
 * The local driver: sandboxes as child processes.
 *
 * This is the driver that makes the platform runnable on a laptop with no
 * container runtime, and it is what the test suite exercises. It is genuinely
 * useful — for development, for self-hosting, and for CI — but it is honest
 * about its isolation: a child process shares the host kernel, filesystem and
 * network. Resource limits and the egress allowlist are advisory here and
 * enforced by the runtime harness rather than the OS.
 *
 * For untrusted workloads, use the container or Kubernetes driver, where the
 * same interface is backed by a real isolation boundary.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Clock, type Logger } from '@ma/core';

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
  readonly #running = new Map<string, LocalSandbox>();

  constructor(options: LocalDriverOptions) {
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#command = options.command ?? process.execPath;
    this.#args = options.args ?? [];
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.#workRoot = options.workRoot;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionedSandbox> {
    const workDir = this.#workRoot
      ? join(this.#workRoot, request.sandboxId)
      : await mkdtemp(join(tmpdir(), 'ma-sandbox-'));

    const child = spawn(this.#command, this.#args, {
      cwd: workDir,
      env: {
        // A deliberately minimal environment: the host's variables are not
        // inherited, so a stray AWS_SECRET_ACCESS_KEY on a developer's machine
        // does not silently become available to every agent they run.
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: workDir,
        MA_SANDBOX_ID: request.sandboxId,
        MA_WORKSPACE_ID: request.workspaceId,
        MA_CONTROL_PLANE_URL: request.controlPlaneUrl,
        MA_RUNTIME_TOKEN: request.runtimeToken,
        ...request.env,
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
