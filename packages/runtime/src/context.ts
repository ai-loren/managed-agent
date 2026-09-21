/**
 * Context management.
 *
 * An agent's context grows monotonically until it hits the model's window, and
 * what happens at that moment decides whether long-running work is possible at
 * all. Three rules:
 *
 *  1. **The system prompt and the original task are never dropped.** Losing why
 *     the agent is here produces confident, irrelevant work.
 *  2. **Recent turns stay verbatim.** The agent needs exact detail about what it
 *     just did; a summary of the last tool call is not actionable.
 *  3. **Older turns are summarized, not truncated.** Dropping the middle makes
 *     an agent repeat work it has already done, which is worse than a lossy
 *     account of having done it.
 *
 * Token counts are estimated rather than exact. The model gateway returns real
 * usage after each call and that is what drives billing and quota; this
 * estimate only has to be good enough to decide *when* to compact, and being
 * approximately right early beats being exactly right too late.
 */

import type { ContextPolicy } from '@ma/contracts';

import type { ModelMessage } from './model.ts';

/**
 * Messages at the tail of the current turn that trimming leaves alone.
 *
 * Small on purpose: it covers the tool results the model is about to reason
 * over, not the turn's whole history. Anything larger and a long tool-using
 * turn is back to being uncompactable, which is the bug this exists to fix.
 */
const INTRA_TURN_KEEP = 6;

/**
 * Rough token estimate.
 *
 * ~3.5 characters per token is a reasonable average across English prose, code
 * and JSON. Deliberately biased slightly high: over-estimating triggers
 * compaction a little early, while under-estimating means the provider rejects
 * the request mid-turn, which is a much worse failure.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(message: ModelMessage): number {
  let total = estimateTokens(message.content);
  // Per-message framing overhead the provider adds.
  total += 4;
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 8;
  }
  return total;
}

export function estimateContextTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

/**
 * Rough token cost of the tool schemas sent alongside the messages.
 *
 * The tools array is part of every model request but is NOT in `#messages`, so
 * the message-only estimate is blind to it — a large advertised toolset (an MCP
 * server's schemas) could push a request past the window even though the
 * conversation looks small, and compaction, which only shrinks messages, could
 * never recover it. Counting it here lets the window reserve room for it. Shape
 * matches the wire: `{name, description, parameters}` per tool.
 */
export function estimateToolTokens(
  tools: readonly { name: string; description: string; parameters: unknown }[],
): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description);
    try {
      total += estimateTokens(JSON.stringify(tool.parameters ?? {}));
    } catch {
      // A non-serializable schema contributes only its name/description estimate.
    }
    total += 8; // per-tool framing overhead
  }
  return total;
}

/** Summarizes a span of conversation. Injected so the harness can be tested. */
export type Summarizer = (messages: readonly ModelMessage[]) => Promise<string>;

export interface CompactionResult {
  messages: ModelMessage[];
  beforeTokens: number;
  afterTokens: number;
  turnsSummarized: number;
  strategy: 'none' | 'summarize' | 'drop_tool_output';
}

/**
 * The conversation, with the policy that keeps it inside the window.
 *
 * Messages are grouped into turns so compaction can operate on complete
 * exchanges. Splitting a turn — keeping a tool call but dropping its result —
 * would leave the model reading a conversation that never happened.
 */
export class ContextWindow {
  readonly #policy: ContextPolicy;
  readonly #systemPrompt: string;
  #messages: ModelMessage[] = [];
  /** Index of the first message of each turn, for boundary-safe compaction. */
  #turnStarts: number[] = [];
  /**
   * Tokens consumed by non-message parts of every request (the tool schemas),
   * reserved so the compaction decision leaves room for them. Zero until the
   * harness reports the toolset size.
   */
  #reservedTokens = 0;

  constructor(systemPrompt: string, policy: ContextPolicy) {
    this.#systemPrompt = systemPrompt;
    this.#policy = policy;
  }

  /**
   * Record the token cost of the tool schemas sent with every request, so
   * `needsCompaction`/`estimatedTokens` account for prompt content that does not
   * live in `#messages`. Without this the window is blind to a large (e.g.
   * MCP-advertised) toolset and could ship a request past the model's limit that
   * compaction — which only shrinks messages — cannot recover from.
   */
  reserveToolTokens(tokens: number): void {
    this.#reservedTokens = Math.max(0, tokens);
  }

  /** Mark the start of a new turn. */
  beginTurn(): void {
    this.#turnStarts.push(this.#messages.length);
  }

  push(message: ModelMessage): void {
    this.#messages.push(message);
  }

  pushAll(messages: readonly ModelMessage[]): void {
    this.#messages.push(...messages);
  }

  /** The full prompt: system message first, then the conversation. */
  toMessages(): ModelMessage[] {
    return [{ role: 'system', content: this.#systemPrompt }, ...this.#messages];
  }

  get messages(): readonly ModelMessage[] {
    return this.#messages;
  }

  get turnCount(): number {
    return this.#turnStarts.length;
  }

  estimatedTokens(): number {
    return estimateContextTokens(this.toMessages()) + this.#reservedTokens;
  }

  /** True when the context has reached the compaction threshold. */
  needsCompaction(): boolean {
    return this.estimatedTokens() >= this.#policy.compactThresholdTokens;
  }

  /**
   * Compact the context down towards the target.
   *
   * Tries the cheap strategy first: large tool outputs are usually the bulk of
   * a context and are the least valuable to keep verbatim, since the model has
   * already acted on them. Only if that is not enough does it summarize whole
   * turns, which costs a model call.
   */
  async compact(summarize: Summarizer): Promise<CompactionResult> {
    const beforeTokens = this.estimatedTokens();
    if (beforeTokens < this.#policy.compactThresholdTokens) {
      return {
        messages: this.toMessages(),
        beforeTokens,
        afterTokens: beforeTokens,
        turnsSummarized: 0,
        strategy: 'none',
      };
    }

    // Everything from here is "recent" and protected from the turn-level
    // strategies. When the session has fewer turns than `keepRecentTurns` this
    // is 0, meaning *nothing* is old enough to touch.
    const keepFrom = this.#recentTurnBoundary();

    // Within the current turn, protect only the last few messages — what the
    // model is immediately working from. Without this, a single long turn could
    // not compact at all: with one turn on the clock, `keepFrom` is 0, so the
    // trim pass skipped every message and the summarize pass found nothing
    // older to summarize. A 40-tool-call turn sat at 23,785 tokens against a
    // 1,000 threshold and `compact()` returned having changed nothing, leaving
    // the agent to hit the provider's context limit mid-task.
    //
    // That is the case most likely to exhaust a context in the first place: one
    // agent, one instruction, a great deal of tool output.
    //
    // The message-count offset can land *inside* a tool-call group: an assistant
    // message with N parallel toolCalls is followed by N `tool` results, an
    // (N+1)-message group whose size need not divide evenly into the offset. If
    // the split falls between the assistant message and some of its results, the
    // assistant `tool_calls` message is summarized away while its results are
    // kept — orphan `tool` messages the provider rejects with a 400. Snap the
    // boundary back so the recent window never *begins* with a `tool` message:
    // its matching assistant message (and thus the whole group) then travels with
    // it, or the whole group is summarized together.
    const protectedFrom = this.#alignToGroup(
      Math.max(keepFrom, this.#messages.length - INTRA_TURN_KEEP),
    );

    // First pass: shrink stale tool output, oldest first.
    const trimmed = this.#messages.map((message, index) => {
      if (index >= protectedFrom) return message;
      if (message.role !== 'tool') return message;
      if (estimateMessageTokens(message) < 400) return message;
      return {
        ...message,
        content: `${message.content.slice(0, 300)}\n… [output truncated during compaction]`,
      };
    });

    const afterTrim =
      estimateContextTokens([{ role: 'system' as const, content: this.#systemPrompt }, ...trimmed]) +
      this.#reservedTokens;
    if (afterTrim <= this.#policy.compactTargetTokens) {
      this.#messages = trimmed;
      return {
        messages: this.toMessages(),
        beforeTokens,
        afterTokens: afterTrim,
        turnsSummarized: 0,
        strategy: 'drop_tool_output',
      };
    }

    // Second pass: summarize everything before the protected window.
    //
    // Bounded by `protectedFrom`, not `keepFrom`, for the same reason as the
    // trim above: inside a single long turn `keepFrom` is 0 and there is
    // nothing to summarize, so the context could only ever grow. Summarizing
    // the earlier part of an in-flight turn loses less than failing the turn on
    // a context-limit error does.
    // Second pass: summarize everything before the protected window, EXCEPT the
    // original task. Rule #1 says the task is never dropped, but — unlike the
    // system prompt, which lives in its own field — the task is an ordinary
    // message at index 0. Without pinning it, `older` starts at 0 and the first
    // turn is always folded into the summary; the default fallback summarizer
    // then discards its text, so the agent loses its instruction, scope and
    // prohibitions and does confident out-of-scope work. Pin the first message
    // verbatim: summarize only what lies between it and the protected window.
    const pinned = this.#messages.length > 0 ? 1 : 0;
    const older = trimmed.slice(pinned, protectedFrom);
    const recent = trimmed.slice(protectedFrom);
    if (older.length === 0) {
      // Nothing older to summarize. Either the recent window alone exceeds the
      // target — a policy misconfigured for this model — or the session is
      // still inside its first few turns. Either way the trim above is all that
      // is available, and it has already run against everything but the last
      // few messages. Keep that rather than discarding what the agent is
      // actively working on.
      this.#messages = trimmed;
      return {
        messages: this.toMessages(),
        beforeTokens,
        afterTokens: afterTrim,
        turnsSummarized: 0,
        strategy: 'drop_tool_output',
      };
    }

    const summary = await summarize(older);
    this.#messages = [
      ...trimmed.slice(0, pinned),
      {
        role: 'user',
        content: `[Summary of earlier conversation]\n${summary}`,
      },
      ...recent,
    ];

    // Turn boundaries shifted. After compaction the layout is:
    //   [pinned task] [summary] [recent…]
    // so a retained boundary at `start` (>= protectedFrom) moves to
    // `start - protectedFrom + pinned + 1` (past the pinned prefix and the
    // summary). A boundary inside the summarized range collapses onto the pinned
    // task's turn (index 0), so the current turn keeps a start index even when
    // its own earlier messages were folded away — otherwise `beginTurn` would
    // number the next turn against a stale list.
    const summaryOffset = pinned + 1;
    const dropped = this.#turnStarts.filter((start) => start < protectedFrom).length;
    const retained = this.#turnStarts
      .filter((start) => start >= protectedFrom)
      .map((start) => start - protectedFrom + summaryOffset);
    this.#turnStarts = dropped > 0 ? [0, ...retained] : retained;

    return {
      messages: this.toMessages(),
      beforeTokens,
      afterTokens: this.estimatedTokens(),
      turnsSummarized: dropped,
      strategy: 'summarize',
    };
  }

  /** Index of the first message belonging to the retained recent turns. */
  #recentTurnBoundary(): number {
    const keep = this.#policy.keepRecentTurns;
    if (this.#turnStarts.length <= keep) return 0;
    return this.#turnStarts[this.#turnStarts.length - keep] ?? 0;
  }

  /**
   * Move a candidate split index earlier until it does not orphan a tool result.
   *
   * The recent window must not *begin* with a `tool` message: its matching
   * assistant `tool_calls` message would be on the older side and get summarized
   * away, leaving a result whose call no longer exists. Walking back past any
   * leading `tool` messages lands the boundary on the assistant message that owns
   * them (or earlier), so the whole call/result group stays together — either all
   * summarized or all kept. Never moves past 0.
   *
   * INVARIANT this relies on: the harness emits an assistant `tool_calls` message
   * *immediately* followed by one contiguous run of its `tool` results, and
   * `tool` messages appear nowhere else. This guards only the leading edge and
   * trusts contiguity for the trailing edge — so a message injected mid-group (a
   * user interrupt between an assistant and its results) or a provider adapter
   * that emits results non-contiguously would break this. Keep results contiguous
   * with their call, or extend this to align both edges.
   */
  #alignToGroup(index: number): number {
    let boundary = index;
    while (boundary > 0 && this.#messages[boundary]?.role === 'tool') {
      boundary--;
    }
    return boundary;
  }

  /**
   * A resumable snapshot.
   *
   * This is what makes a lost sandbox recoverable: a new sandbox restores the
   * snapshot and continues, rather than starting the user's work again.
   */
  snapshot(): { systemPrompt: string; messages: ModelMessage[]; turnStarts: number[] } {
    return {
      systemPrompt: this.#systemPrompt,
      messages: structuredClone(this.#messages),
      turnStarts: [...this.#turnStarts],
    };
  }

  static restore(
    snapshot: { systemPrompt: string; messages: ModelMessage[]; turnStarts: number[] },
    policy: ContextPolicy,
  ): ContextWindow {
    const window = new ContextWindow(snapshot.systemPrompt, policy);
    window.#messages = structuredClone(snapshot.messages);
    window.#turnStarts = [...snapshot.turnStarts];
    return window;
  }
}
