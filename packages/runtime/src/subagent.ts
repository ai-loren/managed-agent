/**
 * Sub-agent delegation.
 *
 * A sub-agent is a scoped child run: its own prompt, its own tool allowlist, its
 * own turn budget, and a fresh context. The parent gets back a summary rather
 * than the child's whole transcript.
 *
 * That last point is the reason sub-agents exist. A parent that reads every
 * intermediate step of an exploration spends its context on work it has already
 * delegated. Delegation is only useful if the result is smaller than the work.
 *
 * The scoping is not advisory. A sub-agent's tools are the intersection of what
 * it declares and what its parent version permits, so delegation can never widen
 * authority — otherwise "spawn a sub-agent" would be a way around the parent's
 * own permission policy.
 */

import { MaError, type Clock, type Logger } from '@ma/core';
import type { AgentVersion, SubAgent, ToolPolicy, Usage } from '@ma/contracts';

import { AgentHarness, type HarnessEvents } from './harness.ts';
import type { ModelClient } from './model.ts';
import { ToolRegistry, type Tool } from './tools.ts';

export interface SubAgentResult {
  name: string;
  /** The child's final answer — what the parent actually consumes. */
  summary: string;
  turns: number;
  usage: Usage;
  /** Why it stopped, so the parent can tell "finished" from "gave up". */
  reason: string;
}

/**
 * How deep delegation may nest.
 *
 * Small on purpose. Real delegation is one or two levels; anything deeper is a
 * loop, and an unbounded one exhausts the heap in seconds from a single prompt.
 */
export const MAX_DELEGATION_DEPTH = 2;

export interface SubAgentRunnerOptions {
  sessionId: string;
  workspaceId: string;
  /** The parent's version, whose policy bounds every child. */
  parentVersion: AgentVersion;
  model: ModelClient;
  /** Every tool the parent could use; children receive a subset. */
  tools: ToolRegistry;
  events: HarnessEvents;
  clock: Clock;
  workDir: string;
  logger?: Logger;
  /** Current nesting level. 0 is the top-level agent. */
  depth?: number;
}

export class SubAgentRunner {
  readonly #options: SubAgentRunnerOptions;

  constructor(options: SubAgentRunnerOptions) {
    this.#options = options;
  }

  /**
   * Tool policy for a child.
   *
   * The intersection of what the child asks for and what the parent holds.
   * Deny rules are inherited wholesale: a parent that forbids something must not
   * be able to reach it by delegating.
   */
  #scopedPolicy(subAgent: SubAgent): ToolPolicy {
    const parent = this.#options.parentVersion.tools;

    // An empty request means "whatever the parent has", not "everything".
    const requested = subAgent.tools.length > 0 ? subAgent.tools : parent.allow;
    const allow = requested.filter(
      (tool) => parent.allow.includes(tool) && !parent.deny.includes(tool),
    );

    return {
      // Children are always strict. A parent in `prompt` mode has a human
      // watching *it*, not each of its delegates.
      mode: 'strict',
      allow,
      deny: [...parent.deny],
      allowedCommands: [...parent.allowedCommands],
      deniedCommands: [...parent.deniedCommands],
    };
  }

  /**
   * The tools a child may see, already narrowed by its policy.
   *
   * `delegate` is excluded unconditionally. Setting `subAgents: []` on the child
   * version is not enough on its own: the delegate tool closes over the sub-agent
   * list captured when it was built, so a child inheriting the parent's instance
   * would still resolve the parent's full roster and could recurse without limit.
   * Removing the tool is what actually stops it.
   */
  #scopedTools(policy: ToolPolicy): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of this.#options.tools.list()) {
      if (tool.name === 'delegate') continue;
      if (policy.allow.includes(tool.name)) registry.register(tool);
    }
    return registry;
  }

  /**
   * Run a sub-agent to completion and return its summary.
   *
   * The child's own events are emitted with its name attached, so the parent's
   * log records that delegation happened and what the child did — without the
   * child's transcript entering the parent's context.
   */
  async run(subAgent: SubAgent, task: string, options: { signal?: AbortSignal } = {}): Promise<SubAgentResult> {
    const { parentVersion, clock } = this.#options;
    const depth = this.#options.depth ?? 0;

    // Belt and braces alongside withholding the tool: a host wiring its own
    // registry could still hand a child a delegate tool, and a depth counter
    // bounds that too.
    if (depth >= MAX_DELEGATION_DEPTH) {
      throw new MaError({
        code: 'DELEGATION_TOO_DEEP',
        category: 'precondition',
        message: `Delegation may nest at most ${MAX_DELEGATION_DEPTH} levels`,
        details: { depth },
      });
    }

    const policy = this.#scopedPolicy(subAgent);
    if (policy.allow.length === 0 && subAgent.tools.length > 0) {
      // Every requested tool was outside the parent's grant. Failing loudly
      // beats running a child that silently cannot do its job.
      throw new MaError({
        code: 'SUBAGENT_HAS_NO_TOOLS',
        category: 'validation',
        message: `Sub-agent '${subAgent.name}' requested only tools its parent does not permit`,
        details: { requested: subAgent.tools, parentAllows: parentVersion.tools.allow },
      });
    }

    // A child version, derived from the parent but with its own prompt, model
    // and budget. Everything else — sandbox, credentials, context policy — is
    // inherited, because a child runs inside its parent's environment.
    const childVersion: AgentVersion = {
      ...parentVersion,
      systemPrompt: subAgent.systemPrompt,
      model: {
        ...parentVersion.model,
        ...(subAgent.modelId ? { modelId: subAgent.modelId } : {}),
      },
      tools: policy,
      // Bounded independently: an exploring child must not be able to consume
      // the parent's whole session budget.
      maxTurnsPerSession: subAgent.maxTurns,
      subAgents: [],
    };

    const child = new AgentHarness({
      sessionId: this.#options.sessionId,
      workspaceId: this.#options.workspaceId,
      version: childVersion,
      model: this.#options.model,
      tools: this.#scopedTools(policy),
      events: this.#labelled(subAgent.name),
      clock,
      workDir: this.#options.workDir,
      // `maxTurns` is the child's whole budget, and a sub-agent runs exactly one
      // turn — so it also bounds the model round-trips within that turn. Without
      // this a child declaring `maxTurns: 2` could still make forty model calls,
      // which is not the limit anyone thought they were setting.
      maxIterationsPerTurn: subAgent.maxTurns,
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
    });

    // Thread the parent turn's signal so its interrupt/deadline aborts the child
    // rather than leaving the parent wedged awaiting a child that runs to its own
    // (independent) deadline.
    const result = await child.runTurn(task, options.signal ? { signal: options.signal } : {});

    return {
      name: subAgent.name,
      summary: result.text,
      turns: result.turn,
      usage: result.usage,
      reason: result.reason,
    };
  }

  /**
   * Wrap the parent's event sink so a child's events are attributable.
   *
   * Prefixing the item id means the parent's log shows delegation happening and
   * what the child did, while the two streams stay distinguishable.
   *
   * Only the four id-bearing streams are re-tagged; every other event must reach
   * the parent unchanged. We cannot do that with `{ ...parent }`: the parent sink
   * is a class instance in production (agent-core's `EventReporter`), so its
   * methods live on the prototype and a spread copies none of them — the wrapper
   * would silently drop ~18 of the interface's methods, and the child's very
   * first `turnStarted` call would throw. Instead we forward every non-overridden
   * method to the parent by name, preserving its `this` binding.
   */
  #labelled(name: string): HarnessEvents {
    const parent = this.#options.events;
    const tag = (itemId: string): string => `subagent:${name}:${itemId}`;

    const overrides: Partial<HarnessEvents> = {
      messageDelta: (itemId, text) => parent.messageDelta(tag(itemId), text),
      messageCompleted: (itemId, text) => parent.messageCompleted(tag(itemId), text),
      thinkingDelta: (itemId, text) => parent.thinkingDelta(tag(itemId), text),
      thinkingCompleted: (itemId, text) => parent.thinkingCompleted(tag(itemId), text),
    };

    // A Proxy forwards everything to `parent` (binding methods so prototype
    // methods keep working) except the four id-tagging overrides above.
    // `Object.hasOwn`, not `in`: `in` would also match inherited names like
    // `toString`/`constructor` and shadow the parent's with Object's.
    return new Proxy(parent, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && Object.hasOwn(overrides, prop)) {
          return overrides[prop as keyof HarnessEvents];
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

/**
 * The tool that lets a parent delegate.
 *
 * Exposed as a tool rather than a special instruction, so delegation goes
 * through the same permission engine as everything else — a parent whose policy
 * denies `delegate` simply cannot.
 */
export function createDelegateTool(options: {
  runner: SubAgentRunner;
  subAgents: readonly SubAgent[];
}): Tool {
  const byName = new Map(options.subAgents.map((agent) => [agent.name, agent]));
  const names = [...byName.keys()];

  return {
    name: 'delegate',
    description:
      names.length > 0
        ? `Delegate a self-contained task to a specialist sub-agent. Available: ${names.join(', ')}. ` +
          'You receive a summary, not their full working, so state the task precisely.'
        : 'No sub-agents are configured for this agent.',
    // Not read-only: a child can use tools that change things.
    readOnly: false,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Which sub-agent to use', enum: names },
        task: {
          type: 'string',
          description:
            'What to do. The sub-agent starts with no context beyond this, so include what it needs.',
        },
      },
      required: ['agent', 'task'],
    },

    async execute(args, context) {
      const name = String(args.agent ?? '');
      const task = String(args.task ?? '').trim();

      const subAgent = byName.get(name);
      if (!subAgent) {
        // Named plainly, so the model picks a real one rather than guessing.
        return {
          output: `Unknown sub-agent '${name}'. Available: ${names.join(', ') || 'none'}.`,
          isError: true,
        };
      }
      if (task.length === 0) {
        return { output: 'A task description is required.', isError: true };
      }

      // Pass the parent turn's abort signal so an interrupt/deadline propagates
      // into the delegated child instead of orphaning it.
      const result = await options.runner.run(subAgent, task, { signal: context.signal });

      // The reason is included because "finished" and "hit its turn limit"
      // deserve different responses from the parent.
      return {
        output:
          result.reason === 'completed'
            ? result.summary
            : `[${result.name} stopped: ${result.reason}]\n${result.summary}`,
      };
    },
  };
}
