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
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, createLogger, systemClock, type Clock, type Logger } from '@ma/core';
import type { AgentVersion, Usage } from '@ma/contracts';
import {
  AgentHarness,
  ToolRegistry,
  builtinTools,
  createDelegateTool,
  createRetrievalTool,
  extractArchive,
  formatRetrievalResults,
  formatSkillInstructions,
  parseSkillManifest,
  skillInstallDir,
  sniffArchive,
  type HarnessEvents,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type ParsedSkill,
  SubAgentRunner,
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
  };
}

/**
 * A client for the runtime bridge.
 *
 * Every call carries the session-scoped token. There is no other credential in
 * this process.
 */
class ControlPlane {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #logger: Logger;

  constructor(config: CoreConfig, logger: Logger) {
    this.#baseUrl = config.controlPlaneUrl.replace(/\/+$/, '');
    this.#token = config.token;
    this.#logger = logger;
  }

  async #call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}/runtime/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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

  bootstrap(): Promise<{
    sessionId: string;
    systemPrompt: string;
    model: AgentVersion['model'];
    tools: AgentVersion['tools'];
    context: AgentVersion['context'];
    subAgents: AgentVersion['subAgents'];
    skills: AgentVersion['skills'];
    maxTurnsPerSession: number;
    turnTimeoutSeconds: number;
    setupCommands: readonly {
      name: string;
      command: string;
      timeoutSeconds: number;
      optional: boolean;
    }[];
    datasetIds: string[];
  }> {
    return this.#call('/bootstrap');
  }

  /** Download a capability artifact (skill/plugin) by digest. */
  async fetchCapability(digest: string): Promise<Uint8Array> {
    const { content } = await this.#call<{ content: string }>(`/capabilities/${digest}`);
    return new Uint8Array(Buffer.from(content, 'base64'));
  }

  appendEvents(events: { type: string; payload: unknown; turn?: number; itemId?: string }[]): Promise<unknown> {
    return this.#call('/events', { method: 'POST', body: { events } });
  }

  heartbeat(): Promise<{ alive: boolean }> {
    return this.#call('/heartbeat', { method: 'POST' });
  }

  complete(request: {
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
  }): Promise<{
    text: string;
    toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
    stopReason: string;
    usage: Usage;
  }> {
    return this.#call('/completions', { method: 'POST', body: request });
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
    });

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
  turnStarted(turn: number, promptPreview: string): void {
    this.#onTurn?.(turn);
    this.#emit('turn.started', { turn, promptPreview }, { turn });
  }
  turnCompleted(turn: number, reason: string, durationMs: number, usage: Usage): void {
    this.#emit('turn.completed', { turn, reason, durationMs, usage }, { turn });
  }
  turnFailed(turn: number, error: MaError): void {
    this.#emit('turn.failed', { turn, error: errorInfo(error, this.#clock.now()) }, { turn });
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
 * Start the agent core.
 *
 * Returns once the process is serving. The caller keeps it alive; this is a
 * long-running process by design.
 */
export async function startAgentCore(): Promise<{ close(): Promise<void> }> {
  const config = readConfig();
  const logger = createLogger({ level: logLevel(process.env.MA_LOG_LEVEL) });
  const control = new ControlPlane(config, logger);

  const boot = await control.bootstrap();
  const workDir = await mkdtemp(join(tmpdir(), 'ma-agent-'));

  // Download and install each pinned skill. Bytes are pulled by digest from the
  // control plane, which authorizes each digest against this session's pinned
  // version — the sandbox has no other read path to them. A single-file skill's
  // bytes are its `SKILL.md`; an archive is unpacked under `.skills/<name>` and
  // its root `SKILL.md` is read from the tree. Either way the instructions are
  // appended to the system prompt (author-controlled text, same trust position
  // as workspace policy). A skill that fails to download, unpack or parse is
  // logged and skipped rather than failing the whole session.
  const installedSkills: ParsedSkill[] = [];
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

  const version = {
    systemPrompt,
    model: boot.model,
    tools: boot.tools,
    context: boot.context,
    subAgents: boot.subAgents,
    maxTurnsPerSession: boot.maxTurnsPerSession,
    turnTimeoutSeconds: boot.turnTimeoutSeconds,
  } as AgentVersion;

  const tools = new ToolRegistry().registerAll(builtinTools());

  // Knowledge retrieval, if the version has datasets attached. The tool calls
  // back to the control plane's `/search`, which authorizes the datasets against
  // the session's pinned version — the sandbox never queries the index directly.
  // Previously this tool existed but nothing registered it into the running
  // agent, so an ingested document could never be recalled by the agent itself.
  if (boot.datasetIds.length > 0) {
    tools.register(
      createRetrievalTool({
        datasetIds: boot.datasetIds,
        retrieval: {
          search: async (_datasetIds, query, limit) => (await control.search(query, limit)).results,
          format: formatRetrievalResults,
        },
      }),
    );
  }

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
  await runSetupCommands(boot.setupCommands, workDir, logger, systemClock);

  const harness = new AgentHarness({
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
  });

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
   * The submit endpoint the control plane calls to hand work in.
   *
   * Deliberately bound to loopback: the driver publishes it to the host, and
   * nothing outside the sandbox should reach it directly.
   */
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/submit') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      let prompt = '';
      try {
        const parsed = JSON.parse(body) as { events?: { text?: string }[] };
        prompt = (parsed.events ?? []).map((event) => event.text ?? '').join('\n').trim();
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
      if (harness.running) {
        res
          .writeHead(409, { 'content-type': 'application/json' })
          .end('{"error":"a turn is already running for this session"}');
        return;
      }

      // Answer immediately: a turn takes as long as it takes, and holding the
      // control plane's request open for it would couple the two lifetimes.
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');

      void harness
        .runTurn(prompt)
        .catch((error: unknown) => {
          logger.error('turn failed', { error });
        })
        .finally(() => reporter.flush());
    });
  });

  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  // The bound port, which is what the driver must publish — not the requested
  // one, which may have been 0.
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : config.port;

  const shutdown = async (): Promise<void> => {
    stopHeartbeat.abort();
    harness.interrupt();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await reporter.close();
  };

  // The driver waits for this line before reporting the sandbox ready. Printed
  // only once everything above is actually serving, so "ready" is true.
  process.stdout.write(`${READY_MARKER} http://127.0.0.1:${boundPort}\n`);
  logger.info('agent core ready', { sessionId: boot.sessionId, port: boundPort });

  return { close: shutdown };
}

// Only when run directly, so the module stays importable by tests.
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('agent-core')) {
  startAgentCore().catch((error: unknown) => {
    process.stderr.write(`agent core failed to start: ${String(error)}\n`);
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
async function runSetupCommands(
  commands: readonly { name: string; command: string; timeoutSeconds: number; optional: boolean }[],
  workDir: string,
  logger: Logger,
  clock: Clock,
): Promise<void> {
  for (const step of commands) {
    const startedAt = clock.monotonic();
    const outcome = await runShell(step.command, workDir, step.timeoutSeconds * 1000);

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
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
