/**
 * Lifecycle state machines.
 *
 * Every stateful resource declares its legal transitions here, in one place, so
 * the graph can be reviewed as a whole and rendered into docs. Services call
 * `assert` before writing; nothing else is allowed to set a status field.
 */

import { StateMachine } from '@ma/core';

// --- session ---------------------------------------------------------------

export const SESSION_STATUSES = [
  'queued',
  'provisioning',
  'ready',
  'running',
  'idle',
  'terminating',
  'terminated',
  'failed',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * `queued` exists so quota backpressure has somewhere to wait that is visible
 * to the user, rather than being hidden in a broker retry loop.
 *
 * `idle` is distinct from `ready`: both hold a sandbox, but `idle` has served
 * at least one turn, which is what the reaper uses to decide whether an unused
 * sandbox was ever productive.
 */
export const sessionMachine = new StateMachine<SessionStatus>({
  name: 'Session',
  initial: 'queued',
  transitions: {
    queued: ['provisioning', 'terminating', 'failed'],
    provisioning: ['ready', 'terminating', 'failed'],
    // `ready → provisioning` is the recovery path when a sandbox is lost before
    // any turn ran; the session re-provisions rather than failing the user.
    ready: ['running', 'provisioning', 'terminating', 'failed'],
    running: ['idle', 'running', 'terminating', 'failed'],
    idle: ['running', 'provisioning', 'terminating', 'failed'],
    terminating: ['terminated', 'failed'],
    terminated: [],
    failed: [],
  },
});

/** Statuses that still hold (or are acquiring) a sandbox. */
export const SESSION_ACTIVE_STATUSES: readonly SessionStatus[] = [
  'queued',
  'provisioning',
  'ready',
  'running',
  'idle',
  'terminating',
];

// --- sandbox ---------------------------------------------------------------

export const SANDBOX_STATUSES = ['pending', 'ready', 'draining', 'released', 'lost'] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

/**
 * `lost` is separate from `released`: a released sandbox was given back
 * deliberately, a lost one stopped heartbeating. Only the latter triggers
 * session recovery.
 */
export const sandboxMachine = new StateMachine<SandboxStatus>({
  name: 'Sandbox',
  initial: 'pending',
  transitions: {
    pending: ['ready', 'lost', 'released'],
    ready: ['draining', 'lost'],
    draining: ['released', 'lost'],
    released: [],
    lost: [],
  },
});

// --- connector (and schedule, which is a connector subtype) ----------------

export const CONNECTOR_STATUSES = ['draft', 'active', 'disabled', 'failed', 'archived'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/**
 * Note `archived → draft`: restoring an archived connector is supported. The
 * platform this design studied blocked restore entirely, which left operators
 * recreating connectors and losing their delivery history.
 */
export const connectorMachine = new StateMachine<ConnectorStatus>({
  name: 'Connector',
  initial: 'draft',
  transitions: {
    draft: ['active', 'archived'],
    active: ['disabled', 'failed', 'archived'],
    disabled: ['active', 'archived'],
    // `failed` is recoverable: fix the config, re-activate.
    failed: ['active', 'disabled', 'archived'],
    archived: ['draft'],
  },
});

// --- receipt (one inbound delivery) ----------------------------------------

export const RECEIPT_STATUSES = ['pending', 'working', 'succeeded', 'failed', 'zombie'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * `zombie` is assigned by the reaper to a `working` receipt whose worker stopped
 * heartbeating. It is terminal-but-retryable: an operator can replay it, which
 * creates a new receipt rather than reopening this one.
 */
export const receiptMachine = new StateMachine<ReceiptStatus>({
  name: 'Receipt',
  initial: 'pending',
  transitions: {
    pending: ['working', 'failed'],
    working: ['succeeded', 'failed', 'zombie'],
    succeeded: [],
    failed: [],
    zombie: [],
  },
});

// --- dataset document ------------------------------------------------------

export const DOCUMENT_STATUSES = ['pending', 'processing', 'ready', 'failed', 'deleted'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documentMachine = new StateMachine<DocumentStatus>({
  name: 'Document',
  initial: 'pending',
  transitions: {
    pending: ['processing', 'failed', 'deleted'],
    processing: ['ready', 'failed', 'deleted'],
    // Re-sync of an external document returns a ready doc to the pipeline.
    ready: ['processing', 'deleted'],
    failed: ['pending', 'deleted'],
    deleted: [],
  },
});

// --- generic resource lifecycle (workspace, agent, dataset, credential) ----

export const RESOURCE_STATUSES = ['active', 'archived'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUSES)[number];

export const resourceMachine = new StateMachine<ResourceStatus>({
  name: 'Resource',
  initial: 'active',
  transitions: {
    active: ['archived'],
    archived: ['active'],
  },
});
