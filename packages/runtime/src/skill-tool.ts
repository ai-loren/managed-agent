/**
 * Skill-contributed tools.
 *
 * An archive skill may ship executable entrypoints and declare them as tools in
 * a `skill.json` alongside its `SKILL.md`. Each becomes a `Tool` named
 * `skill__<skill>__<tool>` that runs the entrypoint as a subprocess (never a
 * shell), with the call arguments passed as a single JSON string on argv and the
 * skill's install directory as the working directory.
 *
 * Namespacing matters for the same reasons it does for MCP: two skills declaring
 * a tool of the same name cannot collide in the registry, and a skill tool named
 * `run` is never mistaken for a shell command by the permission engine.
 */

import { spawn } from 'node:child_process';
import { isAbsolute, resolve, relative } from 'node:path';

import type { Clock } from '@ma/core';

import { confineCommand, proxyEnvFrom } from './confine.ts';
import type { SkillToolSpec } from './skills.ts';
import type { Tool, ToolContext, ToolResult } from './tools.ts';

const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64_000;

/** Namespaced skill-tool name, collision-proof and never shell-classified. */
export function skillToolName(skillName: string, toolName: string): string {
  return `skill__${skillName}__${toolName}`;
}

/**
 * An entrypoint must resolve inside the skill's install dir — a skill declaring
 * `../../bin/x` or an absolute path is refused, so the manifest cannot point the
 * runner at an executable outside the unpacked tree.
 */
function safeEntrypoint(rootDir: string, entrypoint: string): string {
  if (isAbsolute(entrypoint)) {
    throw new Error(`skill entrypoint must be relative to the skill dir: ${entrypoint}`);
  }
  const resolved = resolve(rootDir, entrypoint);
  const rel = relative(rootDir, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`skill entrypoint escapes the skill dir: ${entrypoint}`);
  }
  return resolved;
}

function runEntrypoint(
  executable: string,
  argJson: string,
  rootDir: string,
  context: ToolContext,
  clock: Clock,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const confined = confineCommand(executable, [argJson]);
    const child = spawn(confined.executable, confined.args, {
      cwd: rootDir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: context.workDir, ...proxyEnvFrom() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let truncated = false;
    let settled = false;
    const append = (chunk: string): void => {
      if (out.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      out += chunk.slice(0, MAX_OUTPUT_BYTES - out.length);
      if (out.length >= MAX_OUTPUT_BYTES) truncated = true;
      context.emit(chunk);
    };
    child.stdout?.on('data', (c: Buffer) => append(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => append(c.toString('utf8')));

    const deadline = new AbortController();
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      deadline.abort();
      context.signal.removeEventListener('abort', onAbort);
      resolvePromise(result);
    };
    void clock.sleep(CALL_TIMEOUT_MS, deadline.signal).then(
      () => {
        child.kill('SIGKILL');
        finish({ output: `Skill tool timed out after ${CALL_TIMEOUT_MS}ms.\n${out}`, isError: true, truncated });
      },
      () => {},
    );
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({ output: 'Skill tool was interrupted.', isError: true });
    };
    context.signal.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error) =>
      finish({ output: `Skill tool failed to start: ${error.message}`, isError: true }),
    );
    child.once('exit', (code) =>
      finish({ output: out, ...(code === 0 ? {} : { isError: true }), ...(truncated ? { truncated } : {}) }),
    );
  });
}

/**
 * Build the tools an installed skill contributes.
 *
 * `rootDir` is where the skill archive was unpacked. Each spec's entrypoint is
 * validated to stay inside that directory.
 */
export function createSkillTools(options: {
  skillName: string;
  rootDir: string;
  specs: readonly SkillToolSpec[];
  clock: Clock;
}): Tool[] {
  // Dedup by the final namespaced name, keeping the first. A skill.json is
  // author-trusted, but a duplicate tool name would otherwise mint two Tools
  // with one name, and the second `ToolRegistry.register` throws
  // `already registered` — crashing the whole session's bootstrap over one
  // malformed skill manifest. Collapse to the first so the set stays registrable.
  const seen = new Set<string>();
  const tools: Tool[] = [];
  for (const spec of options.specs) {
    const name = skillToolName(options.skillName, spec.name);
    if (seen.has(name)) continue;
    seen.add(name);
    const executable = safeEntrypoint(options.rootDir, spec.entrypoint);
    tools.push({
      name,
      description: spec.description || `Tool ${spec.name} from skill ${options.skillName}`,
      parameters: spec.parameters ?? { type: 'object', properties: {} },
      readOnly: false,
      execute: (args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> =>
        runEntrypoint(executable, JSON.stringify(args), options.rootDir, context, options.clock),
    });
  }
  return tools;
}
