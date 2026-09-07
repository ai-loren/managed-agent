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

  constructor(systemPrompt: string, policy: ContextPolicy) {
    this.#systemPrompt = systemPrompt;
    this.#policy = policy;
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
    return estimateContextTokens(this.toMessages());
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

    const keepFrom = this.#recentTurnBoundary();

    // First pass: shrink stale tool output.
    const trimmed = this.#messages.map((message, index) => {
      if (index >= keepFrom) return message;
      if (message.role !== 'tool') return message;
      if (estimateMessageTokens(message) < 400) return message;
      return {
        ...message,
        content: `${message.content.slice(0, 300)}\n… [output truncated during compaction]`,
      };
    });

    const afterTrim = estimateContextTokens([
      { role: 'system' as const, content: this.#systemPrompt },
      ...trimmed,
    ]);
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

    // Second pass: summarize everything before the recent window.
    const older = trimmed.slice(0, keepFrom);
    const recent = trimmed.slice(keepFrom);
    if (older.length === 0) {
      // Nothing older to summarize: the recent window alone exceeds the target,
      // which means the policy is misconfigured for this model. Keep what we
      // have rather than discarding what the agent is actively working on.
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
      {
        role: 'user',
        content: `[Summary of earlier conversation]\n${summary}`,
      },
      ...recent,
    ];

    // Turn boundaries shifted; the summary counts as one message before the
    // retained turns.
    const dropped = this.#turnStarts.filter((start) => start < keepFrom).length;
    this.#turnStarts = this.#turnStarts
      .filter((start) => start >= keepFrom)
      .map((start) => start - keepFrom + 1);

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
