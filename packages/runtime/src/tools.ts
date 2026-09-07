/**
 * Tools and the permission engine.
 *
 * This is the security boundary inside the sandbox. Two rules shape it:
 *
 *  1. **Deny wins.** A tool or command matched by a deny rule is refused, even
 *     if an allow rule also matches. There is no ordering subtlety to get wrong
 *     and no way to accidentally widen access by adding a rule.
 *  2. **Every decision is explainable.** A denial names the rule that caused it.
 *     "Permission denied" with no reason is how operators learn to disable
 *     policy rather than fix it.
 *
 * Command matching deserves particular care: an agent asked to run
 * `git status` must not be able to smuggle `rm -rf /` past a prefix check by
 * writing `git status; rm -rf /`. The matcher below rejects shell metacharacters
 * rather than trying to parse them.
 */

import { validationError } from '@ma/core';
import type { ToolPolicy } from '@ma/contracts';

import type { ToolSchema } from './model.ts';

export interface ToolContext {
  sessionId: string;
  workspaceId: string;
  turn: number;
  /** Sandbox working directory. */
  workDir: string;
  signal: AbortSignal;
  /** Emit incremental output for a long-running tool. */
  emit(chunk: string, stream?: 'stdout' | 'stderr'): void;
}

export interface ToolResult {
  /** Text handed back to the model. */
  output: string;
  /** True when the tool failed; the model is told so it can adapt. */
  isError?: boolean;
  /** Large outputs are truncated for the model and stored as an artifact. */
  truncated?: boolean;
  /** Files the tool produced. */
  artifacts?: { path: string; sizeBytes: number }[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments the model must supply. */
  readonly parameters: Record<string, unknown>;
  /**
   * Whether this tool can change anything. Read-only tools are permitted in
   * `plan` mode, where the agent is meant to look without touching.
   */
  readonly readOnly: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type PermissionDecision = 'allow' | 'deny' | 'prompt';

export interface PermissionOutcome {
  decision: PermissionDecision;
  /** Which rule decided, so a denial can be explained and fixed. */
  rule: string;
  reason: string;
}

/**
 * Characters that let one command become several. Any of these in a command
 * string means we cannot reason about what will actually run, so a prefix
 * allowlist is meaningless and the command is refused.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r]|\|\||&&/;

export class PermissionEngine {
  readonly #policy: ToolPolicy;

  constructor(policy: ToolPolicy) {
    this.#policy = policy;
  }

  /** Decide whether a tool may run with these arguments. */
  evaluate(tool: Tool, args: Record<string, unknown>): PermissionOutcome {
    // `plan` mode is read-only by definition, and that beats every allowlist:
    // a user who asked for a plan did not ask for changes.
    if (this.#policy.mode === 'plan' && !tool.readOnly) {
      return {
        decision: 'deny',
        rule: 'mode:plan',
        reason: `${tool.name} can modify state and this session is in plan mode`,
      };
    }

    if (this.#policy.deny.includes(tool.name)) {
      return {
        decision: 'deny',
        rule: `deny:${tool.name}`,
        reason: `${tool.name} is explicitly denied`,
      };
    }

    // Shell commands get their own pass, because the tool name alone says
    // nothing about what the command will do.
    const command = extractCommand(tool, args);
    if (command !== undefined) {
      const verdict = this.#evaluateCommand(command);
      if (verdict.decision !== 'allow') return verdict;
    }

    if (this.#policy.allow.includes(tool.name)) {
      return { decision: 'allow', rule: `allow:${tool.name}`, reason: '' };
    }

    switch (this.#policy.mode) {
      case 'strict':
        // The right default for unattended agents: nothing runs unless it was
        // named. There is nobody to answer a prompt at 3am.
        return {
          decision: 'deny',
          rule: 'mode:strict',
          reason: `${tool.name} is not in the allowlist and this session runs in strict mode`,
        };
      case 'plan':
        // Anything still here is read-only — the mutation check above already
        // rejected the rest — and reading is the entire point of plan mode.
        return { decision: 'allow', rule: 'mode:plan', reason: '' };
      case 'prompt':
        return {
          decision: 'prompt',
          rule: 'mode:prompt',
          reason: `${tool.name} needs approval`,
        };
      case 'auto':
        return { decision: 'allow', rule: 'mode:auto', reason: '' };
      default:
        return { decision: 'deny', rule: 'mode:unknown', reason: 'unrecognised permission mode' };
    }
  }

  #evaluateCommand(command: string): PermissionOutcome {
    const trimmed = command.trim();

    // Refuse anything we cannot read as a single command. Trying to parse shell
    // syntax to decide what is "really" being run is a losing game; declining
    // to guess is the safe answer.
    if (SHELL_METACHARACTERS.test(trimmed)) {
      return {
        decision: 'deny',
        rule: 'command:compound',
        reason:
          'Commands containing shell metacharacters cannot be checked against the allowlist; run one command at a time',
      };
    }

    for (const denied of this.#policy.deniedCommands) {
      if (matchesPrefix(trimmed, denied)) {
        return {
          decision: 'deny',
          rule: `denyCommand:${denied}`,
          reason: `Commands starting with '${denied}' are denied`,
        };
      }
    }

    if (this.#policy.allowedCommands.length > 0) {
      const allowed = this.#policy.allowedCommands.some((prefix) => matchesPrefix(trimmed, prefix));
      if (!allowed) {
        // An explicit command allowlist is a decision, and `auto` mode does not
        // override it. Treating "auto" as "ignore the allowlist" would make
        // configuring one silently pointless, which is the worst kind of
        // security control: present, visible, and not doing anything.
        return {
          decision: 'deny',
          rule: 'command:notAllowed',
          reason: `'${firstWord(trimmed)}' is not in the command allowlist`,
        };
      }
      return { decision: 'allow', rule: 'command:allowed', reason: '' };
    }

    return { decision: 'allow', rule: 'command:noPolicy', reason: '' };
  }
}

/**
 * Prefix match on whole words.
 *
 * `git` must match `git status` but not `github-cli`, so the boundary after the
 * prefix has to be whitespace or end-of-string.
 */
function matchesPrefix(command: string, prefix: string): boolean {
  if (!command.startsWith(prefix)) return false;
  const next = command[prefix.length];
  return next === undefined || next === ' ' || next === '\t';
}

function firstWord(command: string): string {
  return command.split(/\s+/)[0] ?? command;
}

/** Pull the command string out of a shell-like tool's arguments. */
function extractCommand(tool: Tool, args: Record<string, unknown>): string | undefined {
  if (!/^(bash|shell|exec|run|command)$/i.test(tool.name)) return undefined;
  const value = args.command ?? args.cmd ?? args.script;
  return typeof value === 'string' ? value : undefined;
}

/** Tools available to a session, keyed by name. */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.#tools.has(tool.name)) {
      throw validationError(`Tool '${tool.name}' is already registered`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: readonly Tool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /**
   * Schemas to advertise to the model.
   *
   * Tools the policy would certainly deny are withheld rather than offered and
   * refused: an agent that cannot see a tool does not waste a turn attempting
   * it, and its plan is built from what it can actually do.
   */
  schemas(policy: ToolPolicy): ToolSchema[] {
    const engine = new PermissionEngine(policy);
    return this.list()
      .filter((tool) => {
        // Evaluated with empty arguments: this catches per-tool denials and
        // plan mode, while command-level rules are still checked at call time
        // when the actual command is known.
        const outcome = engine.evaluate(tool, {});
        return outcome.decision !== 'deny' || outcome.rule.startsWith('command:');
      })
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }
}
