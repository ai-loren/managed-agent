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

  /** The tools a child may see, already narrowed by its policy. */
  #scopedTools(policy: ToolPolicy): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of this.#options.tools.list()) {
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
  async run(subAgent: SubAgent, task: string): Promise<SubAgentResult> {
    const { parentVersion, clock } = this.#options;

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

    const result = await child.runTurn(task);

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
   */
  #labelled(name: string): HarnessEvents {
    const parent = this.#options.events;
    const tag = (itemId: string): string => `subagent:${name}:${itemId}`;

    return {
      ...parent,
      messageDelta: (itemId, text) => parent.messageDelta(tag(itemId), text),
      messageCompleted: (itemId, text) => parent.messageCompleted(tag(itemId), text),
      thinkingDelta: (itemId, text) => parent.thinkingDelta(tag(itemId), text),
      thinkingCompleted: (itemId, text) => parent.thinkingCompleted(tag(itemId), text),
    };
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

    async execute(args) {
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

      const result = await options.runner.run(subAgent, task);

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
