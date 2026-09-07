/**
 * Sandbox provider drivers.
 *
 * A driver knows how to create, reach, renew and destroy an execution
 * environment. It knows nothing about sessions, agents or the control plane —
 * that separation is what lets `local` (child process), `docker` and `k8s` be
 * genuinely interchangeable rather than three variants of one hard-coded path.
 *
 * The interface is small on purpose. Everything the broker needs is here;
 * anything a specific provider offers beyond it belongs behind its own config.
 */

import type { SandboxSpec } from '@ma/contracts';

/** What a driver is asked to create. */
export interface ProvisionRequest {
  /** Correlates the environment with its control-plane row. */
  sandboxId: string;
  workspaceId: string;
  spec: SandboxSpec;
  /**
   * Environment variables for the agent process. Already resolved from
   * credential references by the broker — drivers never see credential ids.
   */
  env: Record<string, string>;
  /**
   * Token the sandbox uses to call back into the control plane. Session-scoped
   * and short-lived, so a leaked one is bounded in both blast radius and time.
   */
  runtimeToken: string;
  /** Where the sandbox reports events and renews its lease. */
  controlPlaneUrl: string;
}

/** A live environment. */
export interface ProvisionedSandbox {
  /** Opaque provider handle — a container id, a pod name, a pid. */
  providerRef: string;
  /** Base URL where the agent core answers. */
  endpoint: string;
  /** Populated when the driver knows the sandbox's own view of readiness. */
  startedAt?: number;
}

export type SandboxHealth = 'healthy' | 'unreachable' | 'gone';

/**
 * One execution backend.
 *
 * Implementations must be idempotent on `destroy`: the reaper may call it for
 * an environment that already vanished, and that is a normal outcome rather
 * than an error.
 */
export interface SandboxDriver {
  /** Stable identifier recorded on the sandbox row, e.g. `local`. */
  readonly name: string;

  /**
   * Create an environment and wait until it answers.
   *
   * Throws on failure. The broker turns that into a structured error on the
   * session, so a caller can tell "no capacity" from "image not found".
   */
  provision(request: ProvisionRequest): Promise<ProvisionedSandbox>;

  /** Is it still there and answering? Used by the reaper before declaring loss. */
  health(providerRef: string): Promise<SandboxHealth>;

  /**
   * Tear the environment down. Must be idempotent: destroying something already
   * gone is success, not failure.
   */
  destroy(providerRef: string, reason: string): Promise<void>;

  /** Release any driver-level resources. Called at shutdown. */
  close?(): Promise<void>;
}

/** Provisioning failures the broker distinguishes when reporting to a user. */
export const SANDBOX_ERROR_CODES = {
  QUOTA_EXCEEDED: 'SANDBOX_QUOTA_EXCEEDED',
  PLACEMENT_FAILED: 'SANDBOX_PLACEMENT_FAILED',
  IMAGE_UNAVAILABLE: 'SANDBOX_IMAGE_UNAVAILABLE',
  STARTUP_FAILED: 'SANDBOX_STARTUP_FAILED',
  UNREACHABLE: 'SANDBOX_UNREACHABLE',
  SETUP_FAILED: 'SANDBOX_SETUP_FAILED',
} as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[keyof typeof SANDBOX_ERROR_CODES];
