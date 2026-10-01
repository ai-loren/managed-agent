/**
 * The agent core: the process a sandbox actually runs.
 *
 * This is the piece that was missing. `AgentHarness` — the main loop, tool
 * dispatch, permission policy, context compaction, sub-agents — was built and
 * tested and had no production caller, because nothing started it. The control
 * plane provisioned sandboxes that ran a bare `node` with no arguments.
 *
 * What this does, in order:
 *
 *  1. Reads its identity from the environment the driver set. Nothing is passed
 *     on argv: `docker inspect` shows a command line to anyone who can reach
 *     the daemon, and `MA_RUNTIME_TOKEN` is a credential.
 *  2. Prints the ready marker the driver waits for, so provisioning completes.
 *  3. Fetches its pinned configuration from `/runtime/v1/bootstrap`.
 *  4. Builds a harness over that configuration and runs turns.
 *  5. Reports every event back through `/runtime/v1/events`, and heartbeats so
 *     the control plane knows it is alive.
 *
 * The control plane is the only thing it trusts. It holds no provider
 * credential — model calls go through `/runtime/v1/completions`, which attaches
 * the key on the other side — and it can only write to its own session,
 * because its token resolves to exactly one.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, createLogger, credentialEnvName, hashToken, isPlainObject, mergeEnvVars, safeEqual, sanitizeEnv, systemClock, type Clock, type Logger } from '@ma/core';
import { SUBMISSION_ID_PATTERN, type AgentVersion, type Usage } from '@ma/contracts';
import {
  AgentHarness,
  CONFINE_ENV,
  ToolRegistry,
  builtinTools,
  confineCommand,
  createDelegateTool,
  createRetrievalTool,
  createSkillTools,
  extractArchive,
  formatRetrievalResults,
  formatSkillInstructions,
  McpSupervisor,
  parsePluginManifest,
  parseSkillManifest,
  parseSkillTools,
  skillInstallDir,
  sniffArchive,
  type HarnessEvents,
  type McpServerConfig,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type ParsedSkill,
  SubAgentRunner,
  type Tool,
  type ModelToolCall,
} from '@ma/runtime';

/**
 * What the driver puts in the environment. Absent means misconfigured.
 *
 * Note what is *not* here: the session id. A sandbox is provisioned for a
 * session but may later be reused from the pool by another, so the driver
 * cannot know it at spawn time. The core learns it from `/bootstrap`, which
 * resolves it from the runtime token — the same value the control plane
 * authorizes against, so the two cannot disagree.
 */
interface CoreConfig {
  sandboxId: string;
  workspaceId: string;
  controlPlaneUrl: string;
  token: string;
  port: number;
  host: string;
}

const READY_MARKER = 'AGENT_CORE_READY';
/** How often to renew the sandbox lease. Comfortably inside the default 120s. */
const HEARTBEAT_MS = 30_000;
/**
 * How long to batch events before flushing.
 *
 * Deltas arrive token by token; one HTTP request each would spend more time in
 * the network than in the model. Small enough that a watching operator still
 * sees the agent think.
 */
const FLUSH_MS = 250;

function readConfig(): CoreConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} is not set; the agent core is started by the sandbox driver`);
    }
    return value;
  };

  return {
    sandboxId: required('MA_SANDBOX_ID'),
    workspaceId: required('MA_WORKSPACE_ID'),
    controlPlaneUrl: required('MA_CONTROL_PLANE_URL'),
    token: required('MA_RUNTIME_TOKEN'),
    // 0 means "let the OS choose", which is the right default for the local
    // driver: every sandbox is a process on one shared host, so a fixed port
    // means the second concurrent session fails with EADDRINUSE. The container
    // driver sets this explicitly, because a container has its own namespace
    // and a predictable port is what it publishes.
    port: Number(process.env.MA_AGENT_PORT ?? '0'),
    // The interface to bind. Loopback by default, which is correct and safest
    // for the local driver: agent-core is a child process on the same host and
    // the control plane dials 127.0.0.1:<port> directly, so nothing outside the
    // host can reach it. The container and k8s drivers set MA_AGENT_HOST=0.0.0.0
    // explicitly: there the control plane (and, on k8s, the kubelet readiness
    // probe) dial the container's published port / the pod IP, which a loopback
    // bind inside the namespace never receives — the sandbox would come up
    // "ready" yet be unreachable for /submit and /rebind. Binding all interfaces
    // is safe there because the namespace itself is the isolation boundary.
    host: process.env.MA_AGENT_HOST ?? '127.0.0.1',
  };
}

/** The pinned session config the control plane hands a bound sandbox at boot. */
interface BootstrapConfig {
  sessionId: string;
  systemPrompt: string;
  model: AgentVersion['model'];
  tools: AgentVersion['tools'];
  context: AgentVersion['context'];
  runtime: AgentVersion['runtime'];
  subAgents: AgentVersion['subAgents'];
  skills: AgentVersion['skills'];
  plugins: AgentVersion['plugins'];
  mcpServers: AgentVersion['mcpServers'];
  maxTurnsPerSession: number;
  turnTimeoutSeconds: number;
  setupCommands: readonly {
    name: string;
    command: string;
    timeoutSeconds: number;
    optional: boolean;
  }[];
  fileCredentials: { id: string; name: string }[];
  /**
   * Non-file credentials (`env_vars`, `api_key`, `bearer_token`), by reference.
   * Materialised into the process environment on bind — see
   * `materializeCredentialEnv`. References only; each value is fetched through the
   * audited exchange. A prewarmed/rebound sandbox never re-runs the driver's
   * `provision()`, so without delivering these here an agent that depends on a
   * non-file credential would run without its secret.
   */
  envCredentials: { id: string; name: string; type: string }[];
  datasetIds: string[];
  /** The latest context snapshot to restore, when the session has one. */
  snapshotDigest?: string;
  snapshotTurn?: number;
}

/**
 * Bootstrap answers `{ unbound: true }` for a prewarmed sandbox that no session
 * has claimed yet — the core boots idle and waits for a `/rebind`.
 */
type BootstrapResult = BootstrapConfig | { unbound: true };

/**
 * A client for the runtime bridge.
 *
 * Every call carries the session-scoped token. There is no other credential in
 * this process.
 */
export class ControlPlane {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #logger: Logger;

  constructor(config: CoreConfig, logger: Logger) {
    this.#baseUrl = config.controlPlaneUrl.replace(/\/+$/, '');
    this.#token = config.token;
    this.#logger = logger;
  }

  async #call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}/runtime/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MaError({
        code: 'CONTROL_PLANE_ERROR',
        category: response.status >= 500 ? 'unavailable' : 'precondition',
        message: `${init.method ?? 'GET'} ${path} answered ${response.status}: ${detail.slice(0, 300)}`,
        retryable: response.status >= 500,
      });
    }

    return (await response.json()) as T;
  }

  bootstrap(): Promise<BootstrapResult> {
    return this.#call('/bootstrap');
  }

  /** Download a capability artifact (skill/plugin) by digest. */
  async fetchCapability(digest: string): Promise<Uint8Array> {
    const { content } = await this.#call<{ content: string }>(`/capabilities/${digest}`);
    return new Uint8Array(Buffer.from(content, 'base64'));
  }

  /**
   * Persist a context snapshot's bytes so a lost sandbox can resume.
   *
   * `sessionId` names the session the context belongs to. The token may already
   * have been re-pointed at another session (a warm sandbox claimed by the next
   * one), and the bridge refuses a snapshot for a session the token does not
   * serve, so one session's conversation can never be filed under another's.
   */
  saveSnapshot(
    snapshot: { digest: string; turn: number; tokens: number; bytes: string },
    sessionId: string,
  ): Promise<unknown> {
    return this.#call('/snapshots', {
      method: 'POST',
      body: {
        digest: snapshot.digest,
        turn: snapshot.turn,
        tokens: snapshot.tokens,
        content: snapshot.bytes,
        sessionId,
      },
    });
  }

  /** Fetch a context snapshot's bytes for a recovering sandbox. */
  async getSnapshot(digest: string): Promise<Uint8Array> {
    const { content } = await this.#call<{ content: string }>(`/snapshots/${digest}`);
    return new Uint8Array(Buffer.from(content, 'base64'));
  }

  /** Exchange a granted credential reference for its value (audited server-side). */
  async exchangeCredential(credentialId: string): Promise<string> {
    const { value } = await this.#call<{ value: string }>(`/credentials/${credentialId}`, {
      method: 'POST',
      body: { purpose: 'mcp server env' },
    });
    return value;
  }

  appendEvents(events: { type: string; payload: unknown; turn?: number; itemId?: string }[]): Promise<unknown> {
    return this.#call('/events', { method: 'POST', body: { events } });
  }

  heartbeat(): Promise<{ alive: boolean }> {
    return this.#call('/heartbeat', { method: 'POST' });
  }

  /**
   * One model call through the bridge. `signal` is the turn's: when the turn is
   * interrupted or hits its deadline, the request is dropped, and the bridge
   * cancels the upstream call instead of running (and billing) it for a turn
   * that has already ended.
   */
  complete(
    request: {
      modelId: string;
      turn?: number;
      messages: {
        role: string;
        content: string;
        toolCallId?: string;
        toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
      }[];
      tools: unknown[];
      maxOutputTokens?: number;
      temperature?: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    stopReason: string;
    usage: Usage;
    /** The model that answered, which after a failover is not the one asked for. */
    modelId?: string;
  }> {
    return this.#call('/completions', { method: 'POST', body: request, ...(signal ? { signal } : {}) });
  }

  /** Search the knowledge bases this session's version was granted. */
  search(
    query: string,
    limit?: number,
  ): Promise<{ results: { source: string; index: number; text: string; score: number }[] }> {
    return this.#call('/search', { method: 'POST', body: { query, limit } });
  }

  /** Best-effort: a failed heartbeat must not kill the turn in progress. */
  async safeHeartbeat(): Promise<boolean> {
    try {
      const result = await this.heartbeat();
      return result.alive;
    } catch (error) {
      this.#logger.warn('heartbeat failed', { error });
      return true;
    }
  }
}

/**
 * The model, as seen by the harness.
 *
 * The bridge's `/completions` is not a stream, so this yields one chunk. That
 * is a real limitation and it is visible here rather than hidden: a streaming
 * bridge endpoint would replace this class and nothing else.
 */
class BridgeModel implements ModelClient {
  readonly #control: ControlPlane;
  /**
   * The turn currently running.
   *
   * `ModelRequest` has no turn field and widening it would push a billing
   * concern into the runtime contract, so the core tracks it here and tags each
   * completion. The bridge uses the tag to bill a turn exactly once: without
   * it, usage is counted both at the completion and again at `turn.completed`.
   */
  #turn = 0;

  constructor(control: ControlPlane) {
    this.#control = control;
  }

  setTurn(turn: number): void {
    this.#turn = turn;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const response = await this.#control.complete({
      modelId: request.modelId,
      turn: this.#turn,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        // The assistant's own prior tool calls, so the model sees the tool-use
        // loop it is in the middle of rather than a conversation that appears to
        // have invented tool results from nowhere.
        ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      })),
      tools: request.tools,
      ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    }, request.signal);

    if (response.text) yield { type: 'text', text: response.text };
    // Tool calls the model asked for. Yielding these is what lets the harness
    // run a tool at all — without them a completion is text-only and the whole
    // tool-dispatch loop is dead.
    for (const call of response.toolCalls ?? []) {
      yield { type: 'tool_call', call };
    }
    yield {
      type: 'done',
      stopReason: normalizeStopReason(response.stopReason),
      usage: response.usage,
      ...(typeof response.modelId === 'string' ? { modelId: response.modelId } : {}),
    };
  }
}

/**
 * Buffers harness events and flushes them to the control plane.
 *
 * Batched because deltas arrive per token. Ordering is preserved: a flush in
 * flight blocks the next one, so events reach the log in the order the harness
 * produced them — the whole event log design rests on that.
 */
class EventReporter implements HarnessEvents {
  readonly #control: ControlPlane;
  readonly #logger: Logger;
  readonly #pending: { type: string; payload: unknown; turn?: number; itemId?: string }[] = [];
  readonly #clock: Clock;
  readonly #stop = new AbortController();
  /** The submission each running turn was started for, until its end is reported. */
  readonly #submissions = new Map<number, string | undefined>();
  /** Told when a turn begins, so the model client can tag its calls. */
  #onTurn: ((turn: number) => void) | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #scheduled = false;
  #closed = false;

  constructor(control: ControlPlane, logger: Logger, clock: Clock) {
    this.#control = control;
    this.#logger = logger;
    this.#clock = clock;
  }

  #emit(type: string, payload: unknown, extra: { turn?: number; itemId?: string } = {}): void {
    if (this.#closed) return;
    this.#pending.push({ type, payload, ...extra });
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    // `clock.sleep` rather than a bare timer, so a test can drive the flush
    // instead of waiting on wall time — the same reason every other periodic
    // thing in this codebase takes a Clock.
    void this.#clock.sleep(FLUSH_MS, this.#stop.signal).then(
      () => {
        this.#scheduled = false;
        void this.flush();
      },
      () => {
        // Aborted at shutdown; the final flush happens in `close`.
        this.#scheduled = false;
      },
    );
  }

  onTurnStart(handler: (turn: number) => void): void {
    this.#onTurn = handler;
  }

  /** Send everything buffered. Chained, so batches never overtake each other. */
  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(async () => {
      if (this.#pending.length === 0) return;
      const batch = this.#pending.splice(0, this.#pending.length);
      try {
        await this.#control.appendEvents(batch);
      } catch (error) {
        // Dropped rather than retried: the events are already stale by the time
        // a retry lands, and a queue that grows during an outage is how a
        // sandbox runs out of memory. The control plane's own log is the record.
        this.#logger.warn('dropped an event batch', {
          count: batch.length,
          types: batch.map((event) => event.type).join(','),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return this.#flushing;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stop.abort();
    await this.flush();
  }

  // `turn` goes in the payload as well as the envelope. The envelope field is
  // an index for querying; the payload schema requires its own copy, and a
  // batch missing it is rejected whole — which is how a first run produced
  // `message.completed` and no `turn.*` at all.
  turnStarted(turn: number, promptPreview: string, submissionId?: string): void {
    this.#onTurn?.(turn);
    this.#submissions.set(turn, submissionId);
    this.#emit(
      'turn.started',
      { turn, promptPreview, ...(submissionId !== undefined ? { submissionId } : {}) },
      { turn },
    );
  }
  // The turn's end names its submission too, so a submitter waiting on the
  // session settles on the end of *its* turn and not on another one that shares
  // the turn number.
  turnCompleted(turn: number, reason: string, durationMs: number, usage: Usage): void {
    this.#emit('turn.completed', { turn, reason, durationMs, usage, ...this.#submissionOf(turn) }, { turn });
  }
  turnFailed(turn: number, error: MaError): void {
    this.#emit('turn.failed', { turn, error: errorInfo(error, this.#clock.now()), ...this.#submissionOf(turn) }, { turn });
  }
  #submissionOf(turn: number): { submissionId?: string } {
    const submissionId = this.#submissions.get(turn);
    this.#submissions.delete(turn);
    return submissionId !== undefined ? { submissionId } : {};
  }
  messageDelta(itemId: string, text: string): void {
    this.#emit('message.delta', { text }, { itemId });
  }
  messageCompleted(itemId: string, text: string): void {
    this.#emit('message.completed', { role: 'assistant', text }, { itemId });
  }
  thinkingDelta(itemId: string, text: string): void {
    this.#emit('thinking.delta', { text }, { itemId });
  }
  thinkingCompleted(itemId: string, text: string): void {
    this.#emit('thinking.completed', { text }, { itemId });
  }
  // Every tool event carries `toolCallId` in the payload, not only in the
  // envelope, and the field names match the schema exactly — `input` not
  // `arguments`, `resultPreview` not `preview`, a nested `decision` object for
  // approve/deny. The envelope's `itemId` is an index for correlation; the
  // payload the schema validates needs its own copy, and a mismatch has the
  // bridge reject the whole batch — which is how tool events reached the log as
  // nothing at all and tool use looked broken end to end.
  toolRequested(call: ModelToolCall): void {
    this.#emit(
      'tool.requested',
      { toolCallId: call.id, toolName: call.name, input: call.arguments },
      { itemId: call.id },
    );
  }
  toolApproved(toolCallId: string, rule: string, reason: string): void {
    this.#emit(
      'tool.approved',
      { toolCallId, decision: { decision: 'allow', rule, reason } },
      { itemId: toolCallId },
    );
  }
  toolDenied(toolCallId: string, rule: string, reason: string): void {
    this.#emit(
      'tool.denied',
      { toolCallId, decision: { decision: 'deny', rule, reason } },
      { itemId: toolCallId },
    );
  }
  permissionDecided(): void {
    // The control plane derives `audit.permission.decided` from the trusted
    // `tool.approved`/`tool.denied` events it receives — a sandbox must not
    // assert an audit claim itself (see SANDBOX_EVENT_TYPES in the bridge), so
    // this reporter deliberately emits nothing.
  }
  toolStarted(toolCallId: string): void {
    this.#emit('tool.started', { toolCallId }, { itemId: toolCallId });
  }
  toolOutput(toolCallId: string, chunk: string, stream: 'stdout' | 'stderr'): void {
    this.#emit('tool.output', { toolCallId, chunk, stream }, { itemId: toolCallId });
  }
  toolCompleted(toolCallId: string, durationMs: number, preview: string, truncated: boolean): void {
    this.#emit(
      'tool.completed',
      { toolCallId, durationMs, resultPreview: preview, truncated },
      { itemId: toolCallId },
    );
  }
  toolFailed(toolCallId: string, error: MaError): void {
    this.#emit(
      'tool.failed',
      { toolCallId, error: errorInfo(error, this.#clock.now()) },
      { itemId: toolCallId },
    );
  }
  modelRequested(modelId: string, inputTokens: number): void {
    this.#emit('model.requested', { modelId, inputTokens });
  }
  modelCompleted(modelId: string, durationMs: number, usage: Usage, stopReason: string): void {
    this.#emit('model.completed', { modelId, durationMs, usage, stopReason });
  }
  modelFailed(modelId: string, error: MaError): void {
    this.#emit('model.failed', { modelId, error: errorInfo(error, this.#clock.now()) });
  }
  contextCompacted(before: number, after: number, turnsSummarized: number, strategy: string): void {
    this.#emit('context.compacted', { before, after, turnsSummarized, strategy });
  }
  contextSnapshot(digest: string, tokens: number, turn: number): void {
    this.#emit('context.snapshot', { turn, digest, tokens }, { turn });
  }
}

/**
 * One session's runtime inside the sandbox process.
 *
 * The agent loop itself, behind a small interface so the sandbox can run either
 * the built-in harness or an operator-declared command runtime. Everything a
 * single session owns and that must not survive into the next one when the
 * sandbox is reused — its loop, its subprocesses, its working directory holding
 * unpacked skills and materialised credentials — is torn down by `close()`, so a
 * rebind leaves nothing of the previous session behind.
 */
export interface Runtime {
  sessionId: string;
  /** True while a turn is in flight; the /submit 409 guard reads this. */
  readonly running: boolean;
  /**
   * Run one turn to completion. Errors are the caller's to log. The turn's
   * `turn.started` must carry `submissionId`: it is how the submitter finds
   * its own turn on a session others also submit to.
   */
  runTurn(prompt: string, options?: { submissionId?: string }): Promise<void>;
  /** Cooperatively stop the current turn (rebind/shutdown). */
  interrupt(): void;
  /**
   * Persist the conversation now, so a rebuild for the same session resumes it
   * whole. Absent for a runtime whose context does not live in this process.
   */
  checkpoint?(): Promise<boolean>;
  /** Tear the session's runtime all the way down. */
  close(): Promise<void>;
}

/**
 * The process's single live session, and the transitions between sessions.
 *
 * Exists to make one invariant impossible to get wrong: **no turn may be
 * submitted while a rebind is tearing the previous session down**. The bug this
 * guards was a bare `let current`: `/rebind` kept `current` pointing at the old
 * session across `await previous.close()` (which deletes the workDir, kills the
 * subprocesses and closes the reporter) and `await buildSession()`. A concurrent
 * `/submit` in that window read a session whose `running` was still false —
 * `close()` interrupts but does not flip it — passed the guard, and ran a turn
 * against a destroyed session: its events dropped by the closed reporter, its
 * model call billed under the token that now resolved to the *new* session.
 *
 * The slot closes that window explicitly: `beginRebind()` clears the runtime and
 * raises a `rebinding` flag, so `takeForSubmit()` returns nothing (→ 409) until
 * `finishRebind()` installs the new runtime or clears the flag on failure.
 */
export class SessionSlot {
  #current: Runtime | undefined;
  #rebinding = false;
  constructor(initial: Runtime | undefined) {
    this.#current = initial;
  }

  /** The bound session, if any (for /healthz reporting and shutdown). */
  get current(): Runtime | undefined {
    return this.#current;
  }

  /** True while a rebind is in flight — a submit must be refused. */
  get rebinding(): boolean {
    return this.#rebinding;
  }

  /**
   * The runtime a `/submit` may run a turn on, or a reason it may not. There is
   * no `await` between calling this and `runTurn`, so the decision cannot go
   * stale under the caller.
   */
  takeForSubmit(): { runtime: Runtime } | { refuse: 'unbound' | 'busy' } {
    if (this.#rebinding || !this.#current) return { refuse: 'unbound' };
    if (this.#current.running) return { refuse: 'busy' };
    return { runtime: this.#current };
  }

  /**
   * Whether a rebind may proceed. Refused while a turn is running AND while a
   * rebind is already in flight — `beginRebind` clears `#current` before the long
   * `buildSession` runs, so a `!this.#current?.running` check alone reads `true`
   * during the build and would admit a second concurrent rebind (the control plane
   * retries `/rebind` on a 30s timeout). A second builder tears down nothing (the
   * slot is already cleared) and its `finishRebind` overwrites `#current`, leaking
   * the first runtime and duplicating setup side effects. The `#rebinding` guard —
   * the same one `takeForSubmit` uses — makes the second `/rebind` a clean 409 the
   * caller backs off on.
   */
  canRebind(): boolean {
    return !this.#rebinding && !this.#current?.running;
  }

  /**
   * Enter the rebinding state and hand back the previous runtime to tear down.
   * From here until `finishRebind`, the slot is closed to submits.
   */
  beginRebind(): Runtime | undefined {
    const previous = this.#current;
    this.#current = undefined;
    this.#rebinding = true;
    return previous;
  }

  /** Install the newly-built runtime (or `undefined`) and reopen the slot. */
  finishRebind(next: Runtime | undefined): void {
    this.#current = next;
    this.#rebinding = false;
  }
}

/**
 * Resolve non-file credentials into the two env maps a session runs with,
 * applying the same trust split the provisioner uses at cold-provision time.
 *
 * A prewarmed sandbox boots with an empty environment and is claimed via
 * `/rebind`, which never re-runs the driver's `provision()` — so `env_vars` and
 * `api_key`/`bearer_token` credentials, which the drivers bake at provision, would
 * otherwise never reach a rebound agent. Fetched here through the audited
 * `exchange` (per-credential, emitting `audit.credential.accessed`), by the same
 * two-map trust split as `platform.ts`:
 *   - `env`: `env_vars` contents. Untrusted — a workspace member authors the JSON,
 *     so the value is parsed defensively (a malformed value's SyntaxError embeds
 *     plaintext, so it must never escape), merged `__proto__`-safely, and the
 *     caller runs it through `sanitizeEnv` (strips `MA_*`/loader/proxy keys).
 *   - `credentialEnv`: `MA_CRED_<NAME>` for api_key/bearer. The keys are ours, so
 *     they are delivered without sanitising (that is what keeps them from being
 *     stripped as reserved `MA_*`).
 * A credential that fails to fetch or parse is logged and skipped, never fatal —
 * the same degradation as a file credential that cannot be materialised.
 */
export async function materializeCredentialEnv(
  envCredentials: readonly { id: string; name: string; type: string }[],
  exchange: (credentialId: string) => Promise<string>,
  logger: Logger,
): Promise<{ env: Record<string, string>; credentialEnv: Record<string, string> }> {
  const untrusted: Record<string, string> = {};
  const credentialEnv: Record<string, string> = {};
  for (const cred of envCredentials) {
    let value: string;
    try {
      value = await exchange(cred.id);
    } catch (error) {
      logger.error('failed to exchange a credential on bind', { credential: cred.name, error });
      continue;
    }
    if (cred.type === 'env_vars') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        // Never include the value: a SyntaxError embeds the input's first chars,
        // so an invalid secret-shaped value would leak into the log.
        logger.error('an env_vars credential is not valid JSON; skipping', { credential: cred.name });
        continue;
      }
      if (!isPlainObject(parsed)) {
        // Valid JSON but not a {key: value} map (`null`, a number, a string, an
        // array). Skip like the parse-failure case — honoring the "never fatal"
        // contract — rather than letting it reach mergeEnvVars. Log without the
        // value (it may be a secret shaped as a scalar).
        logger.error('an env_vars credential is not a JSON object; skipping', { credential: cred.name });
        continue;
      }
      mergeEnvVars(untrusted, parsed as Record<string, string>);
    } else {
      // api_key / bearer_token (and any other non-file type): a single MA_CRED_*.
      const envName = credentialEnvName(cred.name);
      credentialEnv[envName] = value;
    }
  }
  // Strip reserved keys an env_vars credential must not set. `credentialEnv` is
  // ours and deliberately not sanitised (its keys are the reserved `MA_CRED_*`).
  return { env: sanitizeEnv(untrusted), credentialEnv };
}

/**
 * Materialise `file`/`ssh_key` credentials to disk and return the `MA_CRED_<NAME>_FILE`
 * env map pointing at them.
 *
 * Each secret is written to `<workDir>/.credentials/<name>` with owner-only
 * permissions; only the *path* is exposed as `MA_CRED_<NAME>_FILE`, so the value
 * never enters the process environment (where `docker inspect` would show it). A
 * credential that fails to fetch is logged and skipped, never fatal.
 *
 * Shared by both `buildSession` (the built-in harness) and `buildCommandRuntime`
 * (a foreign process): the drivers deliberately skip file/ssh_key at cold
 * provision, delegating materialisation here, so BOTH runtimes must call this or a
 * command-runtime agent's file credential is written by nobody. Returns an env map
 * the caller folds into its tool/child env.
 */
export async function materializeFileCredentials(
  fileCredentials: readonly { id: string; name: string }[] | undefined,
  workDir: string,
  exchange: (credentialId: string) => Promise<string>,
  logger: Logger,
): Promise<Record<string, string>> {
  const credentialEnv: Record<string, string> = {};
  if ((fileCredentials ?? []).length === 0) return credentialEnv;
  const credDir = join(workDir, '.credentials');
  await mkdir(credDir, { recursive: true, mode: 0o700 });
  for (const cred of fileCredentials!) {
    try {
      const value = await exchange(cred.id);
      const safeName = cred.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'credential';
      const path = join(credDir, safeName);
      await writeFile(path, value, { mode: 0o600 });
      const envName = `${credentialEnvName(cred.name)}_FILE`;
      credentialEnv[envName] = path;
    } catch (error) {
      logger.error('failed to materialise a file credential', { credential: cred.name, error });
    }
  }
  return credentialEnv;
}

/**
 * Build the runtime for whichever session the token currently resolves to.
 *
 * Calls `GET /bootstrap` (once per session, at boot or on each rebind), then
 * installs that session's skills, materialises its file credentials, registers
 * its tools, launches its MCP servers and plugins, restores its snapshot if any,
 * and constructs a fresh harness with a brand-new ContextWindow. Reused across
 * the process's first boot and every subsequent `/rebind`.
 *
 * Returns `undefined` when the control plane reports the sandbox is `unbound` —
 * a prewarmed environment no session has claimed yet. The caller then boots idle
 * and waits for a `/rebind` to bind it to its first real session.
 */
async function buildSession(
  control: ControlPlane,
  config: CoreConfig,
  logger: Logger,
): Promise<Runtime | undefined> {
  const boot = await control.bootstrap();
  if ('unbound' in boot) return undefined;

  // A command runtime replaces the built-in loop with an operator-declared
  // process that drives its turns over the bridge protocol. It needs none of the
  // built-in harness's in-process machinery (tools, context, MCP), only a
  // working directory and the bridge env, so it is built on a separate, much
  // shorter path.
  if (boot.runtime.type === 'command') {
    return buildCommandRuntime(boot, config, logger, control);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'ma-agent-'));

  // A supervisor holds the session's MCP/plugin subprocesses. Hoisted out of the
  // try below so the failure path can stop it: buildSession spawns subprocesses
  // (MCP servers, plugin stdio) and only afterwards runs setup commands, so a
  // required setup command that exits non-zero (runSetupCommands throws
  // SANDBOX_SETUP_FAILED) — or any other post-spawn failure — would otherwise
  // leak those subprocesses and the workDir, because the teardown lives only in
  // the returned runtime's close(), which is never reached when the build throws.
  let mcpSupervisor: McpSupervisor | undefined;
  try {
  // Download and install each pinned skill. Bytes are pulled by digest from the
  // control plane, which authorizes each digest against this session's pinned
  // version — the sandbox has no other read path to them. A single-file skill's
  // bytes are its `SKILL.md`; an archive is unpacked under `.skills/<name>` and
  // its root `SKILL.md` is read from the tree. Either way the instructions are
  // appended to the system prompt (author-controlled text, same trust position
  // as workspace policy). A skill that fails to download, unpack or parse is
  // logged and skipped rather than failing the whole session.
  const installedSkills: ParsedSkill[] = [];
  const skillTools: Tool[] = [];
  for (const ref of boot.skills ?? []) {
    try {
      const bytes = await control.fetchCapability(ref.digest);
      if (sniffArchive(bytes) === 'none') {
        installedSkills.push(parseSkillManifest(bytes, ref.name));
        continue;
      }
      const dir = skillInstallDir(workDir, ref.name);
      await extractArchive(bytes, dir);
      const manifestBytes = await readFile(join(dir, 'SKILL.md')).catch(() => undefined);
      if (!manifestBytes) {
        logger.warn('a skill archive has no SKILL.md; installed its files only', {
          skill: ref.name,
        });
        continue;
      }
      installedSkills.push(parseSkillManifest(new Uint8Array(manifestBytes), ref.name));
      // A skill may declare executable tools in `skill.json`; each becomes a
      // `skill__<name>__<tool>` tool that runs its entrypoint inside the skill
      // dir. Absent or malformed declarations simply contribute no tools.
      const toolBytes = await readFile(join(dir, 'skill.json')).catch(() => undefined);
      if (toolBytes) {
        const specs = parseSkillTools(new Uint8Array(toolBytes));
        skillTools.push(...createSkillTools({ skillName: ref.name, rootDir: dir, specs, clock: systemClock }));
      }
    } catch (error) {
      logger.error('failed to install a skill', { skill: ref.name, digest: ref.digest, error });
    }
  }
  const skillInstructions = formatSkillInstructions(installedSkills);
  const systemPrompt = skillInstructions
    ? `${boot.systemPrompt}\n\n${skillInstructions}`
    : boot.systemPrompt;

  const reporter = new EventReporter(control, logger, systemClock);
  const model = new BridgeModel(control);
  reporter.onTurnStart((turn) => model.setTurn(turn));

  // Materialise file-type credentials as files the agent can read by path. Each
  // is fetched through the audited exchange, written under `.credentials/` with
  // owner-only permissions, and its path exposed as `MA_CRED_<NAME>_FILE` — the
  // secret value never enters the process environment (where `docker inspect`
  // would show it), only a path to a file inside the sandbox. A credential that
  // fails to fetch is logged and skipped rather than failing the session.
  const credentialEnv: Record<string, string> = await materializeFileCredentials(
    boot.fileCredentials,
    workDir,
    (id) => control.exchangeCredential(id),
    logger,
  );

  // Non-file credentials (`env_vars`, `api_key`, `bearer_token`) are delivered on
  // bind too — a prewarmed/rebound sandbox never re-runs the driver's provision(),
  // which is the only place the drivers otherwise bake them. `env_vars` contents
  // are untrusted (sanitised, so a credential cannot set a reserved `MA_*`/loader/
  // proxy key); `MA_CRED_*` are ours and trusted, merged alongside the file creds.
  //
  // Scope: this reaches the built-in tools' child environment (the bash tool) AND
  // the setup commands (passed as `toolEnv` to `runSetupCommands` below), so a
  // rebound sandbox's setup steps see the same env_vars/MA_CRED_* a cold-
  // provisioned one gets from the driver-baked process env. It does NOT reach the
  // MCP-server spawn env, which is resolved from per-server credential *refs*
  // independently and deliberately withholds the broad env so an untrusted server
  // never receives the runtime token.
  const { env: credentialVarsEnv, credentialEnv: nonFileCredentialEnv } = await materializeCredentialEnv(
    boot.envCredentials ?? [],
    (id) => control.exchangeCredential(id),
    logger,
  );
  Object.assign(credentialEnv, nonFileCredentialEnv);
  const toolEnv = { ...credentialVarsEnv, ...credentialEnv };

  const tools = new ToolRegistry().registerAll(
    builtinTools(Object.keys(toolEnv).length > 0 ? { env: toolEnv } : {}),
  );

  // Platform-provided capability tools (retrieval, MCP, skill tools) are added
  // to the policy's allow-list below. Without this they would be registered but
  // always denied under the default `strict` mode — dead on the common path.
  const capabilityToolNames: string[] = [];

  // Skill-contributed tools, collected while installing the skills above.
  for (const tool of skillTools) {
    // Per-tool guard, like the plugin loop below: a skill tool whose name
    // collides with an already-registered one (another skill, a built-in) must
    // not throw out of buildSession and crash the whole session — skip it.
    try {
      tools.register(tool);
      capabilityToolNames.push(tool.name);
    } catch (error) {
      logger.warn('skipping a skill tool that could not be registered', { tool: tool.name, error });
    }
  }

  // Knowledge retrieval, if the version has datasets attached. The tool calls
  // back to the control plane's `/search`, which authorizes the datasets against
  // the session's pinned version — the sandbox never queries the index directly.
  // Previously this tool existed but nothing registered it into the running
  // agent, so an ingested document could never be recalled by the agent itself.
  if (boot.datasetIds.length > 0) {
    const retrievalTool = createRetrievalTool({
      datasetIds: boot.datasetIds,
      retrieval: {
        search: async (_datasetIds, query, limit) => (await control.search(query, limit)).results,
        format: formatRetrievalResults,
      },
    });
    tools.register(retrievalTool);
    capabilityToolNames.push(retrievalTool.name);
  }

  // MCP servers, if the version declares any. Each enabled stdio server is
  // launched as a subprocess speaking JSON-RPC; its advertised tools are proxied
  // as `mcp__<server>__<tool>`. A server that fails to launch is skipped, not
  // fatal. Credential-ref env is resolved through the audited exchange.
  mcpSupervisor = new McpSupervisor(systemClock, logger);
  if ((boot.mcpServers ?? []).length > 0) {
    const mcpTools = await mcpSupervisor.start(
      boot.mcpServers as McpServerConfig[],
      (credentialId) => control.exchangeCredential(credentialId),
    );
    for (const tool of mcpTools) {
      // Per-tool guard, like the plugin loop below: an MCP tool whose namespaced
      // name collides with an already-registered one must not throw out of
      // buildSession and permanently wedge the session — skip it. (createMcpTools
      // already dedups within one server; this covers a cross-server or
      // server-vs-skill collision.)
      try {
        tools.register(tool);
        capabilityToolNames.push(tool.name);
      } catch (error) {
        logger.warn('skipping an MCP tool that could not be registered', { tool: tool.name, error });
      }
    }
  }

  // Plugins: each is downloaded, unpacked, and its `plugin.json` command is
  // launched as a local stdio MCP server from the bundle dir. Its tools are
  // proxied `plugin__<name>__<tool>`. A plugin that fails to download, unpack,
  // or start is logged and skipped, never fatal.
  for (const ref of boot.plugins ?? []) {
    try {
      const bytes = await control.fetchCapability(ref.digest);
      if (sniffArchive(bytes) === 'none') {
        logger.warn('a plugin is not an archive; skipping', { plugin: ref.name });
        continue;
      }
      const dir = skillInstallDir(workDir, `plugin-${ref.name}`);
      await extractArchive(bytes, dir);
      const manifestBytes = await readFile(join(dir, 'plugin.json')).catch(() => undefined);
      const manifest = manifestBytes ? parsePluginManifest(new Uint8Array(manifestBytes), ref.name) : undefined;
      if (!manifest) {
        logger.warn('a plugin has no runnable plugin.json; skipping', { plugin: ref.name });
        continue;
      }
      const pluginTools = await mcpSupervisor.launchPlugin(
        {
          name: manifest.name,
          transport: 'stdio',
          command: manifest.command,
          args: manifest.args,
          env: manifest.env,
          toolAllowlist: manifest.toolAllowlist,
          cwd: dir,
        },
        (credentialId) => control.exchangeCredential(credentialId),
      );
      for (const tool of pluginTools) {
        tools.register(tool);
        capabilityToolNames.push(tool.name);
      }
    } catch (error) {
      logger.error('failed to install a plugin', { plugin: ref.name, digest: ref.digest, error });
    }
  }

  const version = {
    systemPrompt,
    model: boot.model,
    // Auto-allow the platform-provided capability tools ONLY under strict mode,
    // where an un-allowlisted tool is otherwise silently denied — that is the
    // one case these tools need help reaching the agent. Under `prompt`, `plan`
    // or `auto`, the operator chose that policy deliberately, so a capability
    // tool goes through it like any other: prompt still asks for approval, plan
    // still blocks a mutating tool. Auto-allowing everywhere would let a
    // third-party MCP/plugin tool skip the approval a prompt-mode session wants.
    tools:
      (boot.tools?.mode ?? 'strict') === 'strict'
        ? { ...boot.tools, allow: [...(boot.tools?.allow ?? []), ...capabilityToolNames] }
        : boot.tools,
    context: boot.context,
    subAgents: boot.subAgents,
    maxTurnsPerSession: boot.maxTurnsPerSession,
    turnTimeoutSeconds: boot.turnTimeoutSeconds,
  } as AgentVersion;

  // Delegation, if the version declares any children. The runner enforces that
  // a child's tools are a subset of its parent's and that nesting is bounded —
  // both already tested, both previously unreachable because nothing built one.
  if (boot.subAgents.length > 0) {
    const runner = new SubAgentRunner({
      sessionId: boot.sessionId,
      workspaceId: config.workspaceId,
      parentVersion: version,
      model,
      tools,
      events: reporter,
      clock: systemClock,
      workDir,
      logger,
    });
    tools.register(createDelegateTool({ runner, subAgents: boot.subAgents }));
  }

  // Before the first turn. The spec says these run in order and that a failure
  // fails the session rather than leaving an agent in a half-provisioned
  // environment — previously nothing ran them at all, so an agent that declared
  // `npm ci` started work without its dependencies and failed confusingly later.
  //
  // `toolEnv` is passed so a rebound sandbox's setup commands see the same
  // environment (sanitized `env_vars` + `MA_CRED_*`) a cold-provisioned one gets
  // from the driver-baked process env — on rebind the driver never re-runs, so
  // without this the env would be absent here (see runShell).
  await runSetupCommands(boot.setupCommands, workDir, logger, systemClock, toolEnv);

  // Restore a persisted context snapshot, when the session has one, so a
  // sandbox recovering after its predecessor was lost continues the conversation
  // rather than starting over. A snapshot that cannot be fetched, parsed, or
  // whose shape is wrong is logged and skipped: a corrupt snapshot must degrade
  // to a fresh start (exactly today's behaviour), never wedge recovery.
  let restored: { systemPrompt: string; messages: unknown[]; turnStarts: number[] } | undefined;
  if (boot.snapshotDigest) {
    try {
      const bytes = await control.getSnapshot(boot.snapshotDigest);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        systemPrompt?: unknown;
        messages?: unknown;
        turnStarts?: unknown;
      };
      if (
        typeof parsed.systemPrompt === 'string' &&
        Array.isArray(parsed.messages) &&
        Array.isArray(parsed.turnStarts)
      ) {
        restored = {
          systemPrompt: parsed.systemPrompt,
          messages: parsed.messages,
          turnStarts: parsed.turnStarts as number[],
        };
        logger.info('restoring context from a snapshot', {
          digest: boot.snapshotDigest,
          turn: boot.snapshotTurn ?? 0,
          messages: parsed.messages.length,
        });
      } else {
        logger.warn('a snapshot had an unexpected shape; starting fresh', {
          digest: boot.snapshotDigest,
        });
      }
    } catch (error) {
      logger.warn('could not restore a snapshot; starting fresh', {
        digest: boot.snapshotDigest,
        error,
      });
    }
  }

  const harness = new AgentHarness(
    {
      // From bootstrap, not the environment: the control plane resolved it from
      // the token, so it is the session this sandbox is actually serving.
      sessionId: boot.sessionId,
      workspaceId: config.workspaceId,
      version,
      model,
      tools,
      events: reporter,
      clock: systemClock,
      workDir,
      logger,
      // Upload each snapshot's bytes so a future sandbox can resume from it.
      persistSnapshot: (snapshot) => control.saveSnapshot(snapshot, boot.sessionId).then(() => undefined),
    },
    restored as ReturnType<AgentHarness['snapshot']> | undefined,
    // Resume the turn counter with the context, so a recovered session keeps its
    // maxTurnsPerSession budget and its turn numbers stay monotonic. Only applied
    // when a snapshot actually restored (guarded in the constructor).
    boot.snapshotTurn,
  );

  return {
    sessionId: boot.sessionId,
    get running() {
      return harness.running;
    },
    runTurn: async (prompt: string, options: { submissionId?: string } = {}) => {
      try {
        await harness.runTurn(prompt, options.submissionId !== undefined ? { submissionId: options.submissionId } : {});
      } finally {
        // Flush whatever the turn buffered, on success or failure, so a watching
        // operator sees the final events promptly.
        reporter.flush();
      }
    },
    interrupt: () => harness.interrupt(),
    checkpoint: () => harness.checkpoint(),
    close: async () => {
      // Order matters: stop the turn, kill subprocesses, flush the log, then
      // remove the working tree. `rm` last so a slow flush cannot race a
      // half-deleted directory. Every step is best-effort — a rebind must make
      // progress even if one teardown step throws.
      try {
        harness.interrupt();
      } catch (error) {
        logger.warn('error interrupting the harness on teardown', { error });
      }
      try {
        mcpSupervisor?.stop();
      } catch (error) {
        logger.warn('error stopping MCP subprocesses on teardown', { error });
      }
      try {
        await reporter.close();
      } catch (error) {
        logger.warn('error closing the reporter on teardown', { error });
      }
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('error removing the working directory on teardown', { error });
      }
    },
  };
  } catch (error) {
    // The build failed after creating the workDir (and possibly spawning MCP/
    // plugin subprocesses). The returned runtime's close() — which would have
    // torn these down — is never reached, so do it here before rethrowing, or a
    // failed rebind leaks a temp tree and orphaned subprocesses on every attempt.
    try {
      mcpSupervisor?.stop();
    } catch (stopError) {
      logger.warn('error stopping MCP subprocesses after a failed build', { error: stopError });
    }
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (rmError) {
      logger.warn('error removing the working directory after a failed build', { error: rmError });
    }
    throw error;
  }
}

/**
 * Build a command runtime: an operator-declared agent process, run per turn.
 *
 * The process drives its turn entirely over the bridge protocol — it calls
 * `/runtime/v1/completions` for the model and posts its own `turn.*`/`message.*`
 * events to `/runtime/v1/events`, exactly as the built-in harness does. It learns
 * where the bridge is and how to authenticate from its environment
 * (`MA_RUNTIME_URL`, `MA_RUNTIME_TOKEN`, `MA_SESSION_ID`), plus whatever extra
 * env the version declared. The prompt arrives on stdin.
 *
 * Per-turn rather than a long-lived child server: a fresh process per turn is
 * simpler, needs no child-side HTTP server, and gives interruption for free
 * (kill the process). The token it receives is the same session-scoped one the
 * built-in harness holds, inside the same sandbox — this replaces the loop, it
 * does not widen the trust boundary.
 */
export async function buildCommandRuntime(
  boot: BootstrapConfig,
  config: CoreConfig,
  logger: Logger,
  control: ControlPlane,
): Promise<Runtime> {
  if (boot.runtime.type !== 'command') throw new Error('not a command runtime');
  const spec = boot.runtime;
  // A command runtime drives its turns over the bridge, so it must reach the
  // control plane; a network namespace leaves it nothing but its own loopback.
  if (process.env[CONFINE_ENV] === 'netns') {
    throw new MaError({
      code: 'SANDBOX_EGRESS_UNENFORCEABLE',
      category: 'precondition',
      message:
        "This sandbox's egress is restricted with a network namespace, which would cut a command runtime off from " +
        'the control plane it reports to. Use the container or Kubernetes driver, run the control plane on macOS ' +
        '(where the restriction leaves the control plane reachable), or allow egress for this agent.',
    });
  }
  const workDir = await mkdtemp(join(tmpdir(), 'ma-agent-cmd-'));

  // Materialize the session's non-file credentials the same way buildSession does,
  // because a command runtime is subject to the same rebind gap: a prewarmed/
  // rebound sandbox never re-runs the driver's provision(), which is the only place
  // the driver otherwise bakes env_vars/MA_CRED_* into the process env. Without this
  // a prewarmed command-runtime agent runs its setup commands AND its turns without
  // its non-file secrets. env_vars are untrusted (sanitized); MA_CRED_* are ours
  // (trusted). A credential that fails to fetch/parse is logged and skipped.
  const { env: credentialVarsEnv, credentialEnv: cmdCredentialEnv } = await materializeCredentialEnv(
    boot.envCredentials ?? [],
    (id) => control.exchangeCredential(id),
    logger,
  );
  // File/ssh_key credentials must materialise here too: the drivers skip them at
  // cold provision (delegating to this process), and buildSession's file block is
  // never reached for a command runtime — so without this a command-runtime agent's
  // file credential is written by nobody and `MA_CRED_<NAME>_FILE` is empty.
  const cmdFileCredentialEnv = await materializeFileCredentials(
    boot.fileCredentials,
    workDir,
    (id) => control.exchangeCredential(id),
    logger,
  );
  const toolEnv = { ...credentialVarsEnv, ...cmdCredentialEnv, ...cmdFileCredentialEnv };

  // Setup commands still run for a command runtime — a Python agent may need
  // `pip install` just as a built-in one may need `npm ci` — and see the same
  // credential env a cold-provisioned run gets (see buildSession/runShell).
  //
  // Wrapped so a failure here does not leak the temp workDir: a required setup
  // command that exits non-zero throws SANDBOX_SETUP_FAILED, and the workDir's
  // teardown otherwise lives only in the returned runtime's close(), which a throw
  // never reaches — so a failed prewarm/boot would leak an mkdtemp'd tree for the
  // process lifetime. Mirrors buildSession's build-failure cleanup.
  try {
    await runSetupCommands(boot.setupCommands, workDir, logger, systemClock, toolEnv);
  } catch (error) {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (rmError) {
      logger.warn('error removing the command-runtime working directory after a failed build', {
        error: rmError,
      });
    }
    throw error;
  }

  let child: ReturnType<typeof spawn> | undefined;
  let running = false;
  // Best-effort turn counter for reconciling a turn the child could not close
  // itself. The child posts its own `turn.*` events with its own turn index; the
  // parent cannot observe that index, so on a kill/abnormal-exit it posts a
  // `turn.failed` with this monotonic count. The exact number only matters for
  // billing dedup (there is no usage to bill for a killed turn); what reconciles
  // the record is that a `turn.failed` arrives at all, so the bridge drives the
  // session out of `running`.
  let turnNumber = 0;

  const childEnv: Record<string, string> = {
    ...spec.env,
    // The agent's own non-file credentials (sanitized env_vars + MA_CRED_*), so a
    // command-runtime turn can reach them just as the built-in tools' child can.
    // Placed before the platform vars below so a sanitized env_vars value (which
    // cannot be an MA_* key anyway) can never shadow MA_RUNTIME_TOKEN et al.
    ...toolEnv,
    MA_RUNTIME_URL: `${config.controlPlaneUrl}/runtime/v1`,
    MA_RUNTIME_TOKEN: config.token,
    MA_SESSION_ID: boot.sessionId,
    MA_WORKSPACE_ID: config.workspaceId,
  };

  return {
    sessionId: boot.sessionId,
    get running() {
      return running;
    },
    runTurn: (prompt: string, options: { submissionId?: string } = {}) =>
      new Promise<void>((resolve) => {
        running = true;
        const turn = ++turnNumber;
        const confined = confineCommand(spec.command, spec.args);
        const proc = spawn(confined.executable, confined.args, {
          cwd: workDir,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: workDir,
            ...childEnv,
            // The process posts its own turn.started; this is what it echoes as
            // `submissionId` (see docs/runtime-protocol.md).
            ...(options.submissionId !== undefined ? { MA_SUBMISSION_ID: options.submissionId } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child = proc;
        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        // The prompt goes in on stdin; the runtime reports its own events over
        // the bridge, so stdout is informational only.
        //
        // An 'error' listener on the stdin STREAM is mandatory before writing: if
        // the child exits (or closes stdin) before reading — a fast-failing
        // command, or one that never consumes stdin — the write raises EPIPE,
        // emitted as an 'error' on the stdin stream. That stream is a SEPARATE
        // emitter from `proc` (whose 'error' handler below only covers spawn
        // failure), so without this listener the EPIPE is unhandled and crashes the
        // whole agent-core process — every session on it, not just this turn. We
        // swallow it (debug-log only): the child exiting is already handled by the
        // 'close'/'exit' path below, which resolves the turn correctly.
        proc.stdin?.on('error', (error) => {
          logger.debug('command runtime stdin closed before the prompt was fully written', {
            command: spec.command,
            error,
          });
        });
        proc.stdin?.end(prompt);

        // A wall-clock deadline on the whole turn, mirroring the built-in
        // harness's `turnTimeoutSeconds` (which this path does not run) and the
        // bash tool's own timeout. Without it a hung command-runtime process —
        // an infinite loop, a stuck network read, a wait on input that never
        // comes — leaves `runTurn` unresolved forever, the session stuck
        // `running`, and the sandbox occupied until the lease reaper. On overrun
        // the process is SIGKILLed and the turn resolves so the session frees up.
        const deadline = new AbortController();
        let timedOut = false;
        let done = false;
        // Post a terminal `turn.failed` ONLY when the child could not report one
        // itself: a timeout SIGKILL, a spawn error, or a non-zero exit. On a clean
        // exit (code 0) the runtime has already posted its own turn.completed/
        // turn.failed over the bridge, so the parent stays silent to avoid a
        // duplicate. Without this, a killed turn left the control-plane record open
        // — turn.started with no matching terminal — so the session sat `running`
        // (occupying its sandbox) until the lease reaper eventually collected it.
        const finish = (reason?: string): void => {
          if (done) return;
          done = true;
          deadline.abort();
          running = false;
          child = undefined;
          if (reason !== undefined) {
            void control
              .appendEvents([
                {
                  type: 'turn.failed',
                  turn,
                  payload: {
                    turn,
                    error: {
                      code: 'RUNTIME_TERMINATED',
                      message: reason,
                      details: {},
                      occurredAt: systemClock.now(),
                      retryable: false,
                    },
                  },
                },
              ])
              .catch((error: unknown) => {
                logger.error('failed to post turn.failed for a terminated command runtime', {
                  error,
                });
              });
          }
          resolve();
        };
        void systemClock.sleep(boot.turnTimeoutSeconds * 1000, deadline.signal).then(
          () => {
            timedOut = true;
            logger.error('command runtime turn exceeded its deadline; killing it', {
              command: spec.command,
              turnTimeoutSeconds: boot.turnTimeoutSeconds,
              stderr: stderr.slice(-500),
            });
            proc.kill('SIGKILL');
            // `close` still fires after the kill and runs `finish`; guard in case
            // the process was already gone.
            finish(`turn exceeded its ${boot.turnTimeoutSeconds}s deadline and was killed`);
          },
          () => {
            // Aborted because the turn finished first — nothing to do.
          },
        );

        proc.on('error', (error) => {
          logger.error('command runtime failed to start', { command: spec.command, error });
          finish('the runtime process failed to start');
        });
        proc.on('close', (code) => {
          if (timedOut) {
            finish(); // already reported by the timeout path
            return;
          }
          if (code !== 0) {
            logger.warn('command runtime exited non-zero', {
              command: spec.command,
              code,
              stderr: stderr.slice(-500),
            });
            finish(`the runtime process exited with code ${code ?? 'null'}`);
            return;
          }
          finish(); // clean exit: the runtime posted its own terminal event
        });
      }),
    interrupt: () => {
      child?.kill('SIGTERM');
    },
    close: async () => {
      child?.kill('SIGKILL');
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn('error removing the command runtime working directory', { error });
      }
    },
  };
}

/**
 * Start the agent core.
 *
 * Returns once the process is serving. The caller keeps it alive; this is a
 * long-running process by design.
 */
export async function startAgentCore(): Promise<{ close(): Promise<void> }> {
  const config = readConfig();
  const logger = createLogger({ level: logLevel(process.env.MA_LOG_LEVEL) });

  // Defense in depth against a leaked rejection or an unlistened stream 'error'
  // crashing the single-session process. The request handlers now guard their own
  // body streams, but agent-core runs one session per process, so a bug that lets
  // a rejection escape must not silently kill it with no diagnostic: an
  // unhandledRejection is logged and swallowed (the request that leaked it has
  // already failed), while an uncaughtException may have corrupted state, so it is
  // logged and the process exits for a clean restart rather than running wounded.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection in agent-core', { reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception in agent-core; exiting for a clean restart', { error });
    process.exit(1);
  });

  const control = new ControlPlane(config, logger);

  // The session-specific runtime, rebuilt on each `/rebind`. Everything a single
  // session owns — its bootstrap, workdir, tools, MCP subprocesses, reporter and
  // harness — lives here; the HTTP server, heartbeat and control-plane client
  // outlive it. A warm sandbox reused by a second session tears this down and
  // builds a fresh one, so no context, credential or subprocess from the first
  // session leaks into the second.
  const slot = new SessionSlot(await buildSession(control, config, logger));

  // The lease. A sandbox the control plane has written off must stop rather
  // than keep working in an environment nobody is watching.
  const stopHeartbeat = new AbortController();
  const beat = async (): Promise<void> => {
    for (;;) {
      try {
        await systemClock.sleep(HEARTBEAT_MS, stopHeartbeat.signal);
      } catch {
        return; // aborted at shutdown
      }
      if (stopHeartbeat.signal.aborted) return;
      if (!(await control.safeHeartbeat())) {
        logger.warn('the control plane reaped this sandbox; stopping');
        void shutdown();
        return;
      }
    }
  };
  void beat();

  /**
   * The endpoints the control plane calls to hand work in and to rebind, plus
   * an unauthenticated `/healthz` for the k8s readiness probe.
   *
   * The bind interface is `config.host` (see `readConfig`): loopback for the
   * local driver, where the control plane shares the host and nothing outside it
   * should reach these; `0.0.0.0` for container/k8s, where the control plane
   * dials the published port / pod IP across the namespace boundary and a
   * loopback bind would be unreachable. The namespace is the isolation boundary
   * there, not the bind address.
   */
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Liveness/readiness. The k8s driver points a readinessProbe at /healthz, so
    // a pod is only marked Ready — and only becomes reachable through its
    // Service / dialable by the control plane, and only reported 'healthy' by
    // the driver's health() during lease recovery — once this answers 200.
    // Without it the probe 404s forever: the pod never goes Ready, and every
    // lease hiccup reaps a live, in-progress pod. Unauthenticated by design: it
    // reveals nothing (a static body) and the kubelet probe carries no
    // credential. It is a liveness beacon, so /submit and /rebind — which do act
    // on the session — are authenticated separately below.
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    // Everything past here acts on the session, so it must prove it is the
    // control plane. Binding all interfaces (container/k8s) makes these
    // endpoints reachable by co-located sandboxes and cluster pods, and network
    // isolation alone is not a fence: the container bridge and the shared
    // internal network both permit lateral TCP to a peer's agent port. So gate
    // on a shared secret. The control plane presents the sandbox's runtime-token
    // *hash* (which every control-plane process can read from the sandbox record
    // and which agent-core can derive from its own token); the raw token is
    // never sent inbound, so capturing this header cannot impersonate the
    // sandbox back to the control plane.
    if (!isAuthorizedControlCall(req)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/submit') {
      handleSubmit(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/rebind') {
      // Fire-and-forget, but with a terminal .catch: handleRebind consumes the
      // request body (a stream that can error mid-read on an ordinary network
      // fault — ECONNRESET, client abort — on this routine warm-reuse hot path).
      // Without this, that rejection would be an unhandledRejection and, with
      // agent-core running no process-level guard, would kill the whole
      // single-session process instead of degrading to a 500 + cold fallback.
      void handleRebind(req, res).catch((error: unknown) => {
        logger.error('rebind handler failed', { error });
        if (!res.headersSent) res.writeHead(500).end('{"error":"rebind failed"}');
      });
      return;
    }
    res.writeHead(404).end();
  });

  // The control plane authenticates to this sandbox by presenting the runtime
  // token's hash as a bearer credential. Computed once here; compared in
  // constant time so a wrong guess leaks no timing signal.
  const expectedControlCredential = hashToken(config.token);
  function isAuthorizedControlCall(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    return safeEqual(match[1]!, expectedControlCredential);
  }

  function handleSubmit(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    // A request body is a stream that can error mid-read (ECONNRESET, client
    // abort). Without an 'error' listener that emits on `req` as an
    // unlistened-emitter `uncaughtException` — crashing the whole single-session
    // process (which is carrying a live session here) on an ordinary network
    // fault. Swallow it into a 400: the turn was never accepted, so nothing was
    // lost, and the process survives.
    req.on('error', (error) => {
      logger.warn('submit request body stream errored', { error });
      if (!res.headersSent) res.writeHead(400).end('request body stream error');
    });
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      let prompt = '';
      let submissionId: string | undefined;
      try {
        const parsed = JSON.parse(body) as { events?: { text?: string }[]; submissionId?: unknown };
        prompt = (parsed.events ?? []).map((event) => event.text ?? '').join('\n').trim();
        // Echoed into an event and a child's environment, so anything outside
        // the contract's alphabet is dropped rather than passed along.
        if (typeof parsed.submissionId === 'string' && SUBMISSION_ID_PATTERN.test(parsed.submissionId)) {
          submissionId = parsed.submissionId;
        }
      } catch {
        res.writeHead(400).end('malformed body');
        return;
      }
      if (prompt.length === 0) {
        res.writeHead(400).end('no prompt');
        return;
      }

      // Refuse a submission while a turn is already running, rather than
      // acknowledging it and dropping it. `harness.runTurn` throws
      // `TURN_IN_PROGRESS` in that case, but by then we have already sent 202 —
      // the control plane would record the work as accepted and then never see
      // it happen. There is no `await` between this check and `runTurn`'s
      // synchronous `#running` set, so the check cannot go stale under us.
      const decision = slot.takeForSubmit();
      if ('refuse' in decision) {
        if (decision.refuse === 'unbound') {
          // Either a prewarmed sandbox not yet bound to a session, or a rebind in
          // flight tearing the previous session down — in both cases there is no
          // session that may safely run a turn right now.
          res
            .writeHead(409, { 'content-type': 'application/json' })
            .end('{"error":"this sandbox is not bound to a session yet"}');
          return;
        }
        res
          .writeHead(409, { 'content-type': 'application/json' })
          .end('{"error":"a turn is already running for this session"}');
        return;
      }
      const active = decision.runtime;

      // Answer immediately: a turn takes as long as it takes, and holding the
      // control plane's request open for it would couple the two lifetimes.
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');

      void active.runTurn(prompt, submissionId !== undefined ? { submissionId } : {}).catch((error: unknown) => {
        logger.error('turn failed', { error });
      });
    });
  }

  /**
   * Rebind this sandbox to a new session.
   *
   * Called by the provisioner when it hands this warm process to a second
   * session. It refuses mid-turn (the same guard `/submit` uses), then tears the
   * current session's runtime all the way down — MCP/plugin subprocesses,
   * working directory, everything — and re-bootstraps as the new session,
   * fetching *its* skills, credentials, datasets and (if any) snapshot. The
   * runtime token is unchanged; the control plane has already re-pointed it at
   * the new session, so `control.bootstrap()` now returns the new identity. A
   * failure leaves no usable session and answers 500, which tells the provisioner
   * to discard this sandbox and cold-start instead.
   */
  async function handleRebind(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The session id is authoritative from the token via bootstrap; the body's
    // `sessionId` is advisory, used only to tell an in-place rebind of the same
    // session (whose conversation must carry over) from a hand-over to the next.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= 4096) chunks.push(chunk as Buffer);
    }
    let target: string | undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (parsed && typeof parsed === 'object' && typeof (parsed as { sessionId?: unknown }).sessionId === 'string') {
        target = (parsed as { sessionId: string }).sessionId;
      }
    } catch {
      target = undefined;
    }

    if (!slot.canRebind()) {
      res
        .writeHead(409, { 'content-type': 'application/json' })
        .end('{"error":"a turn is running; cannot rebind"}');
      return;
    }

    // Enter the rebinding state: this clears the slot's runtime and closes it to
    // submits for the whole teardown+rebuild. Tearing the previous session down
    // (`previous.close()` deletes the workDir, kills MCP/plugin subprocesses and
    // closes the reporter) does not flip its `running` flag, so without this a
    // concurrent POST /submit would pass the running guard and run a turn against
    // a destroyed session — events dropped by the closed reporter, model call
    // billed under the token that now resolves to the new session. `beginRebind`
    // makes that submit take the 409 branch until the new runtime is live.
    const previous = slot.beginRebind();
    if (previous) {
      // The same session re-pinned in place (a hot upgrade, a model change): save
      // the conversation first, so the rebuilt runtime restores all of it and its
      // turn count, as a recovery would. A hand-over to another session must not
      // carry anything over, and the bridge refuses the snapshot if the token has
      // moved on, so an advisory id that lies cannot leak one session into another.
      if (target !== undefined && target === previous.sessionId && previous.checkpoint) {
        try {
          const stored = await previous.checkpoint();
          if (!stored) logger.warn('the conversation could not be saved before rebinding; the rebuild resumes from the last snapshot');
        } catch (error) {
          logger.warn('error saving the conversation before rebinding', { error });
        }
      }
      try {
        await previous.close();
      } catch (error) {
        logger.warn('error tearing down the previous session on rebind', { error });
      }
    }
    let built: Runtime | undefined;
    try {
      built = await buildSession(control, config, logger);
    } catch (error) {
      logger.error('rebind failed to build the new session', { error });
      slot.finishRebind(undefined);
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":"rebind failed"}');
      return;
    }
    if (!built) {
      // The token still resolves to no session — the control plane asked to
      // rebind a sandbox it has not yet claimed. Leave it idle rather than
      // pretend success.
      logger.warn('rebind produced no session; the sandbox remains unbound');
      slot.finishRebind(undefined);
      res
        .writeHead(409, { 'content-type': 'application/json' })
        .end('{"error":"no session to bind to"}');
      return;
    }
    slot.finishRebind(built);
    logger.info('rebound to a new session', { sessionId: built.sessionId });
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ sessionId: built.sessionId }));
  }

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  // The bound port, which is what the driver must publish — not the requested
  // one, which may have been 0.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : config.port;

  const shutdown = async (): Promise<void> => {
    stopHeartbeat.abort();
    await slot.current?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // The driver waits for this line before reporting the sandbox ready. Printed
  // only once everything above is actually serving, so "ready" is true. A
  // prewarmed sandbox becomes ready while still unbound; it serves nothing until
  // a `/rebind` binds it to its first session.
  //
  // The URL is the local driver's dial target (it reads it straight off this
  // line), so it must be reachable: report loopback when we bound a wildcard
  // (`0.0.0.0`/`::`, the container/k8s case, where the driver resolves the real
  // endpoint itself anyway), otherwise the host we actually bound.
  const wildcard = config.host === '0.0.0.0' || config.host === '::' || config.host === '';
  const markerHost = wildcard ? '127.0.0.1' : config.host;
  process.stdout.write(`${READY_MARKER} http://${markerHost}:${boundPort}\n`);
  logger.info('agent core ready', {
    ...(slot.current ? { sessionId: slot.current.sessionId } : { unbound: true }),
    host: config.host,
    port: boundPort,
  });

  return { close: shutdown };
}

/**
 * What agent-core writes to stderr when it cannot start. A refusal also gets a
 * line of its own with its code, which the local driver turns back into the
 * error it was; otherwise the session sees only that the sandbox exited.
 */
export function startupFailureText(error: unknown): string {
  const refusal = MaError.is(error) ? `AGENT_CORE_REFUSED ${JSON.stringify({ code: error.code, message: error.message })}\n` : '';
  return `${refusal}agent core failed to start: ${String(error)}\n`;
}

// Only when run directly, so the module stays importable by tests.
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('agent-core')) {
  startAgentCore().catch((error: unknown) => {
    process.stderr.write(startupFailureText(error));
    process.exitCode = 1;
  });
}

/** Narrow an env string to a log level, defaulting rather than throwing. */
function logLevel(value: string | undefined): 'debug' | 'info' | 'warn' | 'error' {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

/**
 * An `MaError` as the event schema wants it.
 *
 * `toJSON()` omits `occurredAt`, which `errorInfoSchema` requires — so every
 * failure event was rejected, and a batch containing one took the events
 * alongside it. The first turn to fail therefore reported nothing at all,
 * which is the worst moment to lose the log.
 */
function errorInfo(error: MaError, at: number): Record<string, unknown> {
  return { ...error.toJSON(), occurredAt: at };
}

/**
 * Run a version's setup commands, in order, before any turn.
 *
 * Each gets its own timeout: a hung `apt-get` should fail its own step rather
 * than the sandbox's whole startup budget. A non-zero exit fails the session
 * unless the command is marked optional, which is what the schema promises.
 */
export async function runSetupCommands(
  commands: readonly { name: string; command: string; timeoutSeconds: number; optional: boolean }[],
  workDir: string,
  logger: Logger,
  clock: Clock,
  env: Record<string, string> = {},
): Promise<void> {
  for (const step of commands) {
    const startedAt = clock.monotonic();
    const outcome = await runShell(step.command, workDir, step.timeoutSeconds * 1000, env);

    if (outcome.code === 0) {
      logger.info('setup command finished', { name: step.name, ms: clock.monotonic() - startedAt });
      continue;
    }

    const detail = `${step.name} exited ${outcome.code}${outcome.output ? `: ${outcome.output.slice(-500)}` : ''}`;
    if (step.optional) {
      // Logged rather than swallowed: an operator who marked a step optional
      // still wants to know it failed.
      logger.warn('optional setup command failed', { name: step.name, detail });
      continue;
    }

    throw new MaError({
      code: 'SANDBOX_SETUP_FAILED',
      category: 'precondition',
      message: `Setup command ${detail}`,
    });
  }
}

/** Run one command, capturing output and enforcing a deadline. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // Inherit agent-core's own process env, then overlay the caller's `env`. On a
    // cold provision the driver bakes the agent's environment (sanitized `env_vars`
    // plus `MA_CRED_*`) into this process, so inheriting it is exactly what a setup
    // command already saw. On a rebind the driver never re-runs, so that
    // environment is absent from `process.env` and the caller passes it explicitly
    // as `env` — this overlay is what gives a rebound sandbox's setup commands the
    // same environment a cold-provisioned one had. An empty `env` (the cold path)
    // is a no-op overlay, preserving the prior inherit-only behaviour exactly.
    const confined = confineCommand('/bin/sh', ['-c', command]);
    const child = spawn(confined.executable, confined.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let output = '';
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ code, output });
    };

    // A bare timer rather than the clock: this runs inside the sandbox before
    // any harness exists, and a setup step's deadline is wall time by
    // definition — there is nothing here for a test to drive.
    // ma-lint-disable-next-line no-bare-timers -- pre-harness startup, wall-clock by definition
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\n[timed out after ${timeoutMs}ms]`;
      finish(124);
    }, timeoutMs);

    const capture = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > 64_000) output = output.slice(-64_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (error) => {
      output += String(error);
      finish(127);
    });
    child.once('close', (code) => finish(code ?? 1));
  });
}

/**
 * Map a provider stop reason onto the harness's closed set.
 *
 * A provider may return a string the harness does not model (or none at all);
 * the harness only understands these four. `tool_use` matters most: a turn that
 * asked for tools and reported `end_turn` would end before the tools ran.
 */
function normalizeStopReason(raw: string): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  switch (raw) {
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return raw;
    default:
      return 'end_turn';
  }
}
