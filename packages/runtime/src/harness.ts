/**
 * The agent main loop.
 *
 * One turn is: send the context to the model, stream its response, run whatever
 * tools it asked for, feed the results back, and repeat until it stops asking.
 * That shape is simple; the value is in what surrounds it.
 *
 *  - **Every step emits an event.** The log is the source of truth, so "what did
 *    this agent do" is answerable without reproducing the run.
 *  - **Interruption is checked between steps**, never mid-write. A cancelled
 *    turn ends at a coherent boundary with its context intact, so the session
 *    can continue rather than being poisoned.
 *  - **A tool failure is data, not an exception.** The model is told the tool
 *    failed and gets to adapt; the turn does not collapse because a command
 *    exited non-zero.
 *  - **Bounds are enforced here**, not hoped for. Max iterations, max turns and
 *    the context window all have explicit stopping behaviour.
 */

import { MaError, newId, type Clock, type Logger } from '@ma/core';
import type { AgentVersion, TurnEndReason, Usage } from '@ma/contracts';

import { ContextWindow, type Summarizer } from './context.ts';
import {
  collect,
  type ModelClient,
  type ModelMessage,
  type ModelToolCall,
  type StopReason,
} from './model.ts';
import { PermissionEngine, ToolRegistry, type Tool, type ToolContext } from './tools.ts';

/** How the harness reports what happened. Mirrors the persisted event types. */
export interface HarnessEvents {
  turnStarted(turn: number, promptPreview: string): void;
  turnCompleted(turn: number, reason: TurnEndReason, durationMs: number, usage: Usage): void;
  turnFailed(turn: number, error: MaError): void;

  messageDelta(itemId: string, text: string): void;
  messageCompleted(itemId: string, text: string): void;
  thinkingDelta(itemId: string, text: string): void;
  thinkingCompleted(itemId: string, text: string): void;

  toolRequested(call: ModelToolCall): void;
  toolApproved(toolCallId: string, rule: string, reason: string): void;
  toolDenied(toolCallId: string, rule: string, reason: string): void;
  /**
   * The policy's raw decision for a tool, by name — an audit record of *what the
   * policy decided*, distinct from the per-call `toolApproved`/`toolDenied`
   * (which are keyed by a specific call id). Emitted for every decision.
   */
  permissionDecided(toolName: string, decision: 'allow' | 'deny' | 'prompt', rule: string, reason: string): void;
  toolStarted(toolCallId: string): void;
  toolOutput(toolCallId: string, chunk: string, stream: 'stdout' | 'stderr'): void;
  toolCompleted(toolCallId: string, durationMs: number, preview: string, truncated: boolean): void;
  toolFailed(toolCallId: string, error: MaError): void;

  modelRequested(modelId: string, inputTokens: number): void;
  modelCompleted(modelId: string, durationMs: number, usage: Usage, stopReason: string): void;
  modelFailed(modelId: string, error: MaError): void;

  contextCompacted(before: number, after: number, turnsSummarized: number, strategy: string): void;
  contextSnapshot(digest: string, tokens: number, turn: number): void;
}

export interface HarnessOptions {
  sessionId: string;
  workspaceId: string;
  version: AgentVersion;
  model: ModelClient;
  tools: ToolRegistry;
  events: HarnessEvents;
  clock: Clock;
  workDir: string;
  logger?: Logger;
  /**
   * Answers a tool that policy routed to a human. Absent means `prompt` mode
   * behaves as deny, which is the safe reading for an unattended session.
   */
  approve?(call: ModelToolCall, reason: string): Promise<boolean>;
  /** Summarizes old turns during compaction. */
  summarize?: Summarizer;
  /**
   * Persist a context snapshot's bytes so a lost sandbox can resume.
   *
   * Called before the `context.snapshot` event is emitted, with the serialized
   * snapshot and its digest. Absent means snapshots are not persisted (the
   * event is still emitted for observability, but a lost sandbox restarts). A
   * failure here is swallowed by the caller: a snapshot that fails to upload
   * must not fail the turn that triggered it.
   */
  persistSnapshot?(snapshot: { digest: string; turn: number; tokens: number; bytes: string }): Promise<void>;
  /**
   * Ceiling on model round-trips within one turn. A model that keeps calling
   * tools without converging is stopped rather than left to run.
   */
  maxIterationsPerTurn?: number;
  /** Output above this is truncated for the model and kept as an artifact. */
  maxToolOutputChars?: number;
}

export interface TurnResult {
  turn: number;
  reason: TurnEndReason;
  text: string;
  usage: Usage;
  durationMs: number;
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 40;
const DEFAULT_MAX_TOOL_OUTPUT = 30_000;

export class AgentHarness {
  readonly #options: HarnessOptions;
  readonly #context: ContextWindow;
  readonly #permissions: PermissionEngine;
  readonly #maxIterations: number;
  readonly #maxToolOutput: number;

  #turn = 0;
  #interrupt: AbortController | undefined;
  #running = false;
  /** Set when the deadline fired, so the end reason says so. */
  #timedOut = false;

  constructor(
    options: HarnessOptions,
    restored?: ReturnType<ContextWindow['snapshot']>,
    restoredTurn?: number,
  ) {
    this.#options = options;
    this.#permissions = new PermissionEngine(options.version.tools);
    this.#maxIterations = options.maxIterationsPerTurn ?? DEFAULT_MAX_ITERATIONS;
    this.#maxToolOutput = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT;
    this.#context = restored
      ? ContextWindow.restore(restored, options.version.context)
      : new ContextWindow(options.version.systemPrompt, options.version.context);
    // Resume the turn counter alongside the context. Without this a session that
    // recovered from a snapshot restarted at turn 0, which (a) refilled its
    // `maxTurnsPerSession` budget so an agent could loop indefinitely across
    // repeated recoveries, (b) re-emitted `turn.started`/`turn.completed` with
    // turn numbers already in the event log, colliding with the billing dedup and
    // the event fold, and (c) shifted the snapshot cadence. Only meaningful with a
    // restored context; a fresh session stays at 0.
    if (restored && restoredTurn !== undefined && restoredTurn > 0) {
      this.#turn = restoredTurn;
    }
  }

  get turnCount(): number {
    return this.#turn;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Snapshot the context so a lost sandbox can be recovered. */
  snapshot(): ReturnType<ContextWindow['snapshot']> {
    return this.#context.snapshot();
  }

  /**
   * Ask the running turn to stop.
   *
   * Cooperative rather than forceful: the loop checks between steps, so the
   * turn ends at a coherent boundary with its context intact. Killing it
   * mid-tool would leave the conversation describing a call whose result never
   * arrived.
   */
  interrupt(): void {
    this.#interrupt?.abort();
  }

  /** Run one turn to completion. */
  async runTurn(prompt: string, options: { signal?: AbortSignal } = {}): Promise<TurnResult> {
    if (this.#running) {
      throw new MaError({
        code: 'TURN_IN_PROGRESS',
        category: 'conflict',
        message: 'A turn is already running for this session',
      });
    }

    if (this.#turn >= this.#options.version.maxTurnsPerSession) {
      return this.#endTurn('max_turns', '', emptyUsage(), 0, 0);
    }

    this.#running = true;
    this.#interrupt = new AbortController();
    // Link an external signal (a parent turn's interrupt/deadline, when this
    // harness runs as a delegated child) to this turn's controller, so aborting
    // the parent aborts the child rather than letting it run to its own deadline
    // while the parent is wedged waiting on it.
    if (options.signal) {
      if (options.signal.aborted) this.#interrupt.abort();
      else options.signal.addEventListener('abort', () => this.#interrupt?.abort(), { once: true });
    }
    this.#timedOut = false;
    this.#turn++;

    // A wall-clock deadline on the whole turn. The abort signal is handed to
    // the model provider, but nothing makes a provider honour it — one that
    // stops yielding without erroring would hang here forever, and because
    // `#running` stays set in that state, every later turn rejects with
    // TURN_IN_PROGRESS. The session is then permanently wedged rather than
    // merely slow, which is much harder to diagnose and impossible to recover
    // from without restarting the sandbox.
    const deadline = this.#armDeadline();

    const startedAt = this.#options.clock.monotonic();
    const events = this.#options.events;
    events.turnStarted(this.#turn, prompt.slice(0, 500));

    this.#context.beginTurn();
    this.#context.push({ role: 'user', content: prompt });

    const totals = emptyUsage();
    let finalText = '';
    // Whether `finalText` is already in the context as an assistant message.
    // `finalText` carries the last non-empty text across iterations so the
    // caller gets something useful back, but a later iteration that returns no
    // text must not make `#endTurn` push that earlier text a second time — the
    // model would see itself say the same thing twice, in the context, in every
    // snapshot, and in every replay.
    let finalTextPushed = false;
    let iterations = 0;

    try {
      // Each iteration is one model round-trip. The loop exits when the model
      // stops requesting tools, or when a bound is reached.
      for (; iterations < this.#maxIterations; iterations++) {
        if (this.#interrupt.signal.aborted) {
          return this.#endTurn('interrupted', finalText, totals, startedAt, iterations, finalTextPushed);
        }

        await this.#compactIfNeeded();

        const response = await this.#callModel(totals);
        if (response.text) {
          finalText = response.text;
          finalTextPushed = false;
        }

        if (response.toolCalls.length === 0) {
          const reason: TurnEndReason =
            response.stopReason === 'max_tokens' ? 'context_exhausted' : 'completed';
          return this.#endTurn(reason, finalText, totals, startedAt, iterations + 1, finalTextPushed);
        }

        // Record the assistant's tool requests before running them, so the
        // conversation stays coherent even if the turn ends mid-batch.
        this.#context.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls,
        });
        // Recorded above alongside its tool calls, so `#endTurn` must not add
        // it again if no later iteration produces text.
        if (response.text) finalTextPushed = true;

        const results = await this.#runTools(response.toolCalls);
        this.#context.pushAll(results);

        if (this.#interrupt.signal.aborted) {
          return this.#endTurn('interrupted', finalText, totals, startedAt, iterations + 1, finalTextPushed);
        }
      }

      // The model kept asking for tools without converging.
      return this.#endTurn('max_turns', finalText, totals, startedAt, iterations, finalTextPushed);
    } catch (error) {
      const failure = MaError.from(error);
      events.turnFailed(this.#turn, failure);
      this.#running = false;
      this.#interrupt = undefined;
      throw failure;
    } finally {
      deadline.cancel();
      this.#running = false;
      this.#interrupt = undefined;
      await this.#snapshotIfDue();
    }
  }

  /**
   * Abort the turn if it outlives its budget.
   *
   * Aborting the signal rather than racing a rejection: a rejected race leaves
   * the underlying stream running and still holding the connection, so the
   * process keeps paying for work whose result nobody will read. Aborting gives
   * a well-behaved provider the chance to stop; the guard below covers the ones
   * that ignore it.
   */
  #armDeadline(): { cancel: () => void } {
    const controller = this.#interrupt!;
    const cancel = new AbortController();
    const timeoutMs = this.#options.version.turnTimeoutSeconds * 1000;

    void this.#options.clock.sleep(timeoutMs, cancel.signal).then(
      () => {
        this.#timedOut = true;
        controller.abort();
      },
      () => {
        // Cancelled because the turn finished first.
      },
    );

    return { cancel: () => cancel.abort() };
  }

  async #callModel(totals: Usage): Promise<{
    text: string;
    toolCalls: ModelToolCall[];
    stopReason: StopReason;
  }> {
    const { model, version, events, clock } = this.#options;
    const messages = this.#context.toMessages();
    const inputTokens = this.#context.estimatedTokens();
    const itemId = newId('event', clock.now());

    events.modelRequested(version.model.modelId, inputTokens);
    const startedAt = clock.monotonic();

    try {
      // Deltas are emitted as they arrive so a watching client sees the agent
      // think, rather than waiting for a complete response.
      const stream = model.stream({
        modelId: version.model.modelId,
        messages,
        tools: this.#options.tools.schemas(version.tools),
        ...(version.model.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: version.model.maxOutputTokens }),
        ...(version.model.temperature === undefined
          ? {}
          : { temperature: version.model.temperature }),
        ...(version.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: version.model.reasoningEffort }),
        signal: this.#interrupt!.signal,
      });

      // Racing the abort, not just passing the signal down. A provider that
      // ignores its signal and stops yielding would otherwise leave this await
      // pending forever — the deadline would fire, abort, and change nothing.
      // The stream is abandoned rather than awaited; it holds no lock, and its
      // connection is dropped when the provider notices the abort.
      const response = await this.#raceAbort(
        collect(observe(stream, itemId, events)),
        version.model.modelId,
      );
      const durationMs = clock.monotonic() - startedAt;

      accumulate(totals, response.usage);
      events.modelCompleted(version.model.modelId, durationMs, response.usage, response.stopReason);

      if (response.text) events.messageCompleted(itemId, response.text);
      if (response.thinking) events.thinkingCompleted(itemId, response.thinking);

      return {
        text: response.text,
        toolCalls: response.toolCalls,
        stopReason: response.stopReason,
      };
    } catch (error) {
      const failure = MaError.from(error);
      events.modelFailed(version.model.modelId, failure);
      throw failure;
    }
  }

  /**
   * Reject as soon as the turn is aborted, rather than waiting on `work`.
   *
   * The signal is already passed to the provider; this covers the provider that
   * does not act on it. Without it the interrupt checks in the turn loop are
   * unreachable, because control never returns to the loop to run them.
   */
  #raceAbort<T>(work: Promise<T>, modelId: string): Promise<T> {
    const signal = this.#interrupt!.signal;
    if (!signal.aborted) {
      return Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(this.#abortError(modelId)),
            { once: true },
          );
        }),
      ]);
    }
    return Promise.reject(this.#abortError(modelId));
  }

  #abortError(modelId: string): MaError {
    return this.#timedOut
      ? new MaError({
          code: 'TURN_TIMEOUT',
          category: 'timeout',
          message:
            `The turn exceeded its ${this.#options.version.turnTimeoutSeconds}s budget while ` +
            `waiting on ${modelId}`,
          retryable: true,
        })
      : new MaError({
          code: 'TURN_INTERRUPTED',
          category: 'conflict',
          message: 'The turn was interrupted',
        });
  }

  /**
   * Run the tools the model asked for, in order.
   *
   * Sequential rather than parallel: tools mutate a shared filesystem, and the
   * model's requests routinely depend on each other in ways it did not state.
   * Every call produces a `tool` message, including denials and failures —
   * a missing result would leave the model waiting for something that will
   * never arrive.
   */
  async #runTools(calls: readonly ModelToolCall[]): Promise<ModelMessage[]> {
    const results: ModelMessage[] = [];

    for (const call of calls) {
      if (this.#interrupt?.signal.aborted) {
        results.push(toolMessage(call.id, 'The turn was interrupted before this tool ran.'));
        continue;
      }
      results.push(await this.#runTool(call));
    }

    return results;
  }

  async #runTool(call: ModelToolCall): Promise<ModelMessage> {
    const { events, tools, clock } = this.#options;
    events.toolRequested(call);

    const tool = tools.get(call.name);
    if (!tool) {
      const message = `Unknown tool '${call.name}'.`;
      events.permissionDecided(call.name, 'deny', 'tool:unknown', message);
      events.toolDenied(call.id, 'tool:unknown', message);
      return toolMessage(call.id, message);
    }

    // Everything from the permission decision onward is wrapped, so a throw at
    // ANY step becomes a tool result (data the model can act on) rather than an
    // exception that escapes the turn. This matters for context coherence: the
    // assistant `tool_calls` message is already in the context, so #runTools MUST
    // return one result per call. A throw from `evaluate` (e.g. a malformed
    // arguments object) or from `approve` (a review-service RPC that rejects or
    // times out) used to propagate past #runTools, so `pushAll(results)` never
    // ran and the context was left holding an assistant tool_calls turn with no
    // matching results — which every subsequent provider request rejects with a
    // 400, wedging the session. Turning these into a denial result keeps the
    // documented invariant: a tool/approval failure is data, context stays intact.
    try {
      const verdict = this.#permissions.evaluate(tool, call.arguments);
      // Audit the policy decision itself, by tool name — a record that "the policy
      // decided X for tool Y", independent of this particular call id.
      events.permissionDecided(call.name, verdict.decision, verdict.rule, verdict.reason);

      if (verdict.decision === 'prompt') {
        const approved = this.#options.approve
          ? await this.#options.approve(call, verdict.reason)
          : false;
        if (!approved) {
          // No approver on an unattended session means deny, which is the safe
          // reading of "a human should decide" when no human is present.
          const reason = this.#options.approve ? 'A reviewer denied this call' : verdict.reason;
          events.toolDenied(call.id, verdict.rule, reason);
          return toolMessage(call.id, `Permission denied: ${reason}`);
        }
      } else if (verdict.decision === 'deny') {
        events.toolDenied(call.id, verdict.rule, verdict.reason);
        // The model is told *why*, so it can choose a permitted route rather than
        // retrying the same denied call.
        return toolMessage(call.id, `Permission denied: ${verdict.reason}`);
      }

      events.toolApproved(call.id, verdict.rule, verdict.reason);
      events.toolStarted(call.id);

      const startedAt = clock.monotonic();
      const context: ToolContext = {
        sessionId: this.#options.sessionId,
        workspaceId: this.#options.workspaceId,
        turn: this.#turn,
        workDir: this.#options.workDir,
        signal: this.#interrupt!.signal,
        emit: (chunk, stream = 'stdout') => events.toolOutput(call.id, chunk, stream),
      };

      // Raced against the interrupt, not just handed the signal: a tool that
      // ignores its `context.signal` (e.g. `delegate` before it threaded the
      // signal, or any third-party tool) would otherwise leave this await hanging
      // past the turn deadline, wedging the session in `running`.
      const result = await this.#raceAbort(tool.execute(call.arguments, context), `tool:${call.name}`);
      const durationMs = clock.monotonic() - startedAt;

      let output = result.output;
      let truncated = result.truncated ?? false;
      if (output.length > this.#maxToolOutput) {
        // Truncate for the model but say so, so it knows the picture is partial
        // and can ask for the rest rather than reasoning from a cut-off value.
        output = `${output.slice(0, this.#maxToolOutput)}\n… [${
          output.length - this.#maxToolOutput
        } more characters truncated]`;
        truncated = true;
      }

      events.toolCompleted(call.id, durationMs, output.slice(0, 4000), truncated);
      return toolMessage(call.id, output);
    } catch (error) {
      const failure = MaError.from(error);
      events.toolFailed(call.id, failure);
      // A failing tool — or a failing permission/approval step — is information
      // the model can act on, not a reason to abandon the turn. Returning a
      // result here (rather than throwing) is what keeps the context coherent:
      // every emitted tool_call gets a matching tool_result.
      return toolMessage(call.id, `Tool failed: ${failure.message}`);
    }
  }

  async #compactIfNeeded(): Promise<void> {
    if (!this.#context.needsCompaction()) return;

    const summarize: Summarizer =
      this.#options.summarize ?? ((messages) => Promise.resolve(fallbackSummary(messages)));
    // Raced against the interrupt/deadline, like #callModel and #runTool: an
    // injected model-backed summarizer makes a network call here that can hang,
    // and an un-raced await would park the turn loop past its deadline with
    // #running true — the same session wedge the deadline exists to prevent, just
    // at a different await. (The default fallbackSummary is synchronous and cannot
    // hang, but the option exists to supply a real one.)
    const result = await this.#raceAbort(this.#context.compact(summarize), 'compaction');

    if (result.strategy !== 'none') {
      this.#options.events.contextCompacted(
        result.beforeTokens,
        result.afterTokens,
        result.turnsSummarized,
        result.strategy,
      );
    }
  }

  async #snapshotIfDue(): Promise<void> {
    const every = this.#options.version.context.snapshotEveryTurns;
    if (every <= 0 || this.#turn % every !== 0) return;

    const snapshot = this.#context.snapshot();
    const serialized = JSON.stringify(snapshot);
    const digest = await digestOf(serialized);
    const tokens = this.#context.estimatedTokens();

    // Persist the bytes before announcing the snapshot, so the digest in the
    // event always points at something a recovering sandbox can fetch. A failed
    // upload is logged and swallowed: losing a snapshot degrades recovery to a
    // fresh start (today's behaviour), which must not fail the turn.
    if (this.#options.persistSnapshot) {
      try {
        await this.#options.persistSnapshot({
          digest,
          turn: this.#turn,
          tokens,
          bytes: Buffer.from(serialized, 'utf8').toString('base64'),
        });
      } catch (error) {
        this.#options.logger?.warn('failed to persist a context snapshot', {
          turn: this.#turn,
          error,
        });
      }
    }

    this.#options.events.contextSnapshot(digest, tokens, this.#turn);
  }

  #endTurn(
    reason: TurnEndReason,
    text: string,
    usage: Usage,
    startedAt: number,
    iterations: number,
    /** True when `text` is already in the context from a tool-calling turn. */
    alreadyPushed = false,
  ): TurnResult {
    const durationMs = startedAt === 0 ? 0 : this.#options.clock.monotonic() - startedAt;
    if (text && !alreadyPushed) this.#context.push({ role: 'assistant', content: text });
    this.#options.events.turnCompleted(this.#turn, reason, durationMs, usage);
    return { turn: this.#turn, reason, text, usage, durationMs, iterations };
  }
}

// --- helpers ---------------------------------------------------------------

function toolMessage(toolCallId: string, content: string): ModelMessage {
  return { role: 'tool', content, toolCallId };
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicros: 0,
  };
}

function accumulate(total: Usage, delta: Usage): void {
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  total.costMicros += delta.costMicros;
}

/** Re-emit stream chunks as events while passing them through unchanged. */
async function* observe(
  stream: AsyncIterable<import('./model.ts').ModelChunk>,
  itemId: string,
  events: HarnessEvents,
): AsyncIterable<import('./model.ts').ModelChunk> {
  for await (const chunk of stream) {
    if (chunk.type === 'text') events.messageDelta(itemId, chunk.text);
    else if (chunk.type === 'thinking') events.thinkingDelta(itemId, chunk.text);
    yield chunk;
  }
}

/**
 * Summary used when no summarizer is supplied.
 *
 * Deliberately mechanical rather than clever: it records what happened without
 * inventing a narrative. A real summarizer calls the model; this keeps the
 * harness usable, and testable, without one.
 */
function fallbackSummary(messages: readonly ModelMessage[]): string {
  const toolNames = new Set<string>();
  let userTurns = 0;
  for (const message of messages) {
    if (message.role === 'user') userTurns++;
    for (const call of message.toolCalls ?? []) toolNames.add(call.name);
  }
  const tools = toolNames.size > 0 ? [...toolNames].join(', ') : 'none';
  return `${userTurns} earlier exchange(s) were compacted. Tools used: ${tools}.`;
}

async function digestOf(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}
