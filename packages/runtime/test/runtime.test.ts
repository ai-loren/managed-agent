/**
 * Runtime tests.
 *
 * The permission engine gets the most attention here, because it is the
 * security boundary inside the sandbox and its failure mode is silent: a rule
 * that does not match what it looks like it matches lets work through that a
 * user believed was blocked.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, TestClock, systemClock, nullLogger } from '@ma/core';
import type { AgentVersion, ToolPolicy, Usage } from '@ma/contracts';

import {
  AgentHarness,
  ContextWindow,
  PermissionEngine,
  ToolRegistry,
  builtinTools,
  createSearchTool,
  createShellTool,
  estimateTokens,
  estimateToolTokens,
  listDirectoryTool,
  readFileTool,
  searchTool,
  writeFileTool,
  type HarnessEvents,
  type HarnessOptions,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type ModelToolCall,
  type Tool,
  type ToolContext,
} from '../src/index.ts';

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
};

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    mode: 'strict',
    allow: [],
    deny: [],
    allowedCommands: [],
    deniedCommands: [],
    ...overrides,
  };
}

function fakeTool(name: string, readOnly = false): Tool {
  return {
    name,
    description: `the ${name} tool`,
    readOnly,
    parameters: { type: 'object', properties: {} },
    execute: () => Promise.resolve({ output: `${name} ran` }),
  };
}

// ---------------------------------------------------------------------------
// Permission engine — the security boundary
// ---------------------------------------------------------------------------

describe('permission engine', () => {
  test('strict mode denies anything not named', () => {
    // The right default for unattended agents: there is nobody to ask at 3am.
    const engine = new PermissionEngine(policy({ mode: 'strict' }));
    const outcome = engine.evaluate(fakeTool('write_file'), {});
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.rule, 'mode:strict');
    assert.ok(outcome.reason.includes('allowlist'), 'a denial must explain itself');
  });

  test('an allowlisted tool runs in strict mode', () => {
    const engine = new PermissionEngine(policy({ mode: 'strict', allow: ['read_file'] }));
    assert.equal(engine.evaluate(fakeTool('read_file', true), {}).decision, 'allow');
  });

  test('deny beats allow', () => {
    // No ordering subtlety: adding a rule can never widen access.
    const engine = new PermissionEngine(
      policy({ mode: 'auto', allow: ['write_file'], deny: ['write_file'] }),
    );
    assert.equal(engine.evaluate(fakeTool('write_file'), {}).decision, 'deny');
  });

  test('plan mode blocks mutation even when allowlisted', () => {
    // A user who asked for a plan did not ask for changes.
    const engine = new PermissionEngine(policy({ mode: 'plan', allow: ['write_file'] }));
    assert.equal(engine.evaluate(fakeTool('write_file', false), {}).decision, 'deny');
    assert.equal(engine.evaluate(fakeTool('read_file', true), {}).decision, 'allow');
  });

  test('prompt mode asks rather than deciding', () => {
    const engine = new PermissionEngine(policy({ mode: 'prompt' }));
    assert.equal(engine.evaluate(fakeTool('write_file'), {}).decision, 'prompt');
  });

  test('auto mode allows what is not denied', () => {
    const engine = new PermissionEngine(policy({ mode: 'auto' }));
    assert.equal(engine.evaluate(fakeTool('anything'), {}).decision, 'allow');
  });

  describe('command matching', () => {
    const engine = new PermissionEngine(
      policy({ mode: 'auto', allowedCommands: ['git', 'npm test'], deniedCommands: ['rm'] }),
    );

    test('allows an allowlisted command', () => {
      assert.equal(engine.evaluate(fakeTool('bash'), { command: 'git status' }).decision, 'allow');
      assert.equal(engine.evaluate(fakeTool('bash'), { command: 'npm test' }).decision, 'allow');
    });

    test('matches on whole words, not raw prefixes', () => {
      // `git` must not permit `github-cli`, which is a different program.
      const outcome = engine.evaluate(fakeTool('bash'), { command: 'github-cli auth' });
      assert.equal(outcome.decision, 'deny');
    });

    test('denies a denylisted command', () => {
      const outcome = engine.evaluate(fakeTool('bash'), { command: 'rm -rf build' });
      assert.equal(outcome.decision, 'deny');
      assert.equal(outcome.rule, 'denyCommand:rm');
    });

    test('refuses to guess at compound commands', () => {
      // The attack this exists for: smuggling a second command past a prefix
      // check by chaining it onto an allowed one.
      for (const command of [
        'git status; rm -rf /',
        'git status && rm -rf /',
        'git status | tee /etc/passwd',
        'git status `rm -rf /`',
        'git status $(rm -rf /)',
        'git status\nrm -rf /',
        'git status > /etc/hosts',
      ]) {
        const outcome = engine.evaluate(fakeTool('bash'), { command });
        assert.equal(outcome.decision, 'deny', `${command} must be refused`);
        assert.equal(outcome.rule, 'command:compound');
      }
    });

    test('a denied command cannot be reached through an allowed prefix', () => {
      const outcome = engine.evaluate(fakeTool('bash'), { command: 'rm' });
      assert.equal(outcome.decision, 'deny');
    });

    test('command rules apply regardless of the tool alias used', () => {
      for (const name of ['bash', 'shell', 'exec', 'run', 'command']) {
        const outcome = engine.evaluate(fakeTool(name), { command: 'rm -rf /' });
        assert.equal(outcome.decision, 'deny', `${name} must be checked too`);
      }
    });

    test('with no command policy, commands are unrestricted', () => {
      const open = new PermissionEngine(policy({ mode: 'auto' }));
      assert.equal(open.evaluate(fakeTool('bash'), { command: 'anything' }).decision, 'allow');
    });

    test('a denied program cannot be reached by a path-qualified spelling', () => {
      // The matcher used to reason about the literal first word, but the executor
      // resolves and runs whatever the token points at. `/bin/rm` and `./rm` are
      // the SAME program as `rm`; a denylist that only catches the bare spelling
      // is no denylist. Under a deny-only policy (allow all except rm) each of
      // these must still be denied.
      const denyOnly = new PermissionEngine(policy({ mode: 'auto', deniedCommands: ['rm'] }));
      for (const command of ['/bin/rm -rf /', './rm -rf .', '/usr/bin/rm x', '../rm x']) {
        const outcome = denyOnly.evaluate(fakeTool('bash'), { command });
        assert.equal(outcome.decision, 'deny', `${command} must be denied`);
      }
    });

    test('a shell/exec wrapper cannot re-introduce a shell or re-exec a denied program', () => {
      // `sh -c '…'` reintroduces the very shell the no-shell design removed, and
      // `env rm` / `xargs rm` re-exec a denied program as an argument — the denied
      // token is never at position 0, so a first-word matcher never sees it. A
      // wrapper must be refused unless the operator explicitly allowlisted it.
      const denyOnly = new PermissionEngine(policy({ mode: 'auto', deniedCommands: ['rm'] }));
      for (const command of ["sh -c 'rm -rf /'", 'env rm -rf /', 'bash -c id', 'xargs rm']) {
        const outcome = denyOnly.evaluate(fakeTool('bash'), { command });
        assert.equal(outcome.decision, 'deny', `${command} must be denied as an opaque wrapper`);
      }
    });

    test('an explicitly allowlisted wrapper is still permitted', () => {
      // The escape hatch: an operator who names `env` in the allowlist has made a
      // deliberate choice, so it runs. (The command allowlist still gates it.)
      const withEnv = new PermissionEngine(
        policy({ mode: 'auto', allowedCommands: ['env', 'git'] }),
      );
      assert.equal(withEnv.evaluate(fakeTool('bash'), { command: 'env FOO=1 git status' }).decision, 'allow');
    });

    test('a path-qualified allowlisted command is still permitted', () => {
      // Canonicalizing the program must not break the allow direction: /usr/bin/git
      // is still git.
      const withGit = new PermissionEngine(policy({ mode: 'auto', allowedCommands: ['git'] }));
      assert.equal(withGit.evaluate(fakeTool('bash'), { command: '/usr/bin/git status' }).decision, 'allow');
    });
  });
});

describe('tool registry', () => {
  test('rejects a duplicate registration', () => {
    const registry = new ToolRegistry().register(fakeTool('a'));
    assert.throws(() => registry.register(fakeTool('a')), (error: unknown) => MaError.is(error));
  });

  test('withholds tools the policy would certainly deny', () => {
    // An agent that cannot see a tool does not waste a turn attempting it.
    const registry = new ToolRegistry().registerAll([
      fakeTool('read_file', true),
      fakeTool('write_file', false),
    ]);
    const names = registry.schemas(policy({ mode: 'plan' })).map((schema) => schema.name);
    assert.deepEqual(names, ['read_file']);
  });

  test('still advertises shell tools whose commands are checked at call time', () => {
    const registry = new ToolRegistry().register(fakeTool('bash'));
    const names = registry
      .schemas(policy({ mode: 'auto', allowedCommands: ['git'] }))
      .map((schema) => schema.name);
    assert.deepEqual(names, ['bash']);
  });
});

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

describe('context window', () => {
  const contextPolicy = {
    compactThresholdTokens: 1000,
    compactTargetTokens: 400,
    keepRecentTurns: 2,
    snapshotEveryTurns: 0,
  };

  test('estimates tokens and reports when compaction is due', () => {
    const window = new ContextWindow('system', contextPolicy);
    assert.equal(window.needsCompaction(), false);
    window.beginTurn();
    window.push({ role: 'user', content: 'x'.repeat(10_000) });
    assert.equal(window.needsCompaction(), true);
  });

  test('keeps the system prompt at the head of every request', () => {
    const window = new ContextWindow('you are helpful', contextPolicy);
    window.push({ role: 'user', content: 'hi' });
    const messages = window.toMessages();
    assert.equal(messages[0]?.role, 'system');
    assert.equal(messages[0]?.content, 'you are helpful');
  });

  test('compacts a single long turn, which is how a context actually fills up', async () => {
    // The bug: `#recentTurnBoundary()` returns 0 while the session has fewer
    // turns than `keepRecentTurns`, so every message counted as "recent" — the
    // trim pass skipped all of them and the summarize pass found nothing older.
    // A 40-tool-call turn sat at ~24k tokens against a 1k threshold and
    // `compact()` returned having changed nothing, leaving the agent to die on
    // the provider's context limit mid-task.
    //
    // One agent, one instruction, a lot of tool output is the *most* likely way
    // to exhaust a context, and it was the one case compaction could not touch.
    const window = new ContextWindow('system', contextPolicy);
    window.beginTurn();
    window.push({ role: 'user', content: 'analyse the repository' });
    for (let call = 0; call < 40; call++) {
      window.push({
        role: 'assistant',
        content: `step ${call}`,
        toolCalls: [{ id: `c${call}`, name: 'read_file', arguments: {} }],
      });
      window.push({ role: 'tool', toolCallId: `c${call}`, content: 'X'.repeat(2000) });
    }

    assert.equal(window.turnCount, 1, 'a single turn, well under keepRecentTurns');
    const before = window.estimatedTokens();
    assert.ok(before > contextPolicy.compactThresholdTokens);

    const result = await window.compact(() => Promise.resolve('earlier work summarized'));

    assert.ok(
      result.afterTokens < before / 2,
      `compaction must actually shrink the context: ${before} -> ${result.afterTokens}`,
    );
  });

  test('never orphans a tool call when compacting inside a turn', async () => {
    // An assistant message carrying a toolCall whose matching tool result was
    // summarized away is a malformed request to most providers — the turn fails
    // with a 400 rather than a context error, which is harder to diagnose.
    const window = new ContextWindow('system', contextPolicy);
    window.beginTurn();
    window.push({ role: 'user', content: 'go' });
    for (let call = 0; call < 30; call++) {
      window.push({
        role: 'assistant',
        content: `step ${call}`,
        toolCalls: [{ id: `c${call}`, name: 'read_file', arguments: {} }],
      });
      window.push({ role: 'tool', toolCallId: `c${call}`, content: 'Y'.repeat(1500) });
    }

    await window.compact(() => Promise.resolve('summary'));

    const messages = window.toMessages();
    const calls = new Set(messages.flatMap((message) => (message.toolCalls ?? []).map((c) => c.id)));
    const results = new Set(
      messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId)
        .filter((id): id is string => id !== undefined),
    );
    assert.deepEqual(
      [...calls].filter((id) => !results.has(id)),
      [],
      'every retained tool call must keep its result',
    );
    assert.deepEqual(
      [...results].filter((id) => !calls.has(id)),
      [],
      'every retained tool result must keep its call',
    );
  });

  test('never orphans a tool result when compacting splits parallel tool calls', async () => {
    // The uncovered case: a model that batches tool calls emits ONE assistant
    // message with N toolCalls, followed by N tool results — an odd-sized group
    // (1 + N messages). The protected window is a fixed message *count* from the
    // end (len - INTRA_TURN_KEEP), so it can land *between* that assistant message
    // and its results: the assistant message is summarized away while its tool
    // results are kept, leaving `tool` messages whose toolCall no longer exists —
    // a malformed request most providers reject with a 400. The split must be
    // aligned so a call and its results are never separated.
    const window = new ContextWindow('system', contextPolicy);
    window.beginTurn();
    window.push({ role: 'user', content: 'go' });
    for (let step = 0; step < 20; step++) {
      // One assistant message, three parallel tool calls, three results: a
      // 4-message group whose size is coprime with INTRA_TURN_KEEP, so the
      // len-6 boundary falls inside a group for some step.
      window.push({
        role: 'assistant',
        content: `step ${step}`,
        toolCalls: [
          { id: `c${step}a`, name: 'read_file', arguments: {} },
          { id: `c${step}b`, name: 'read_file', arguments: {} },
          { id: `c${step}c`, name: 'read_file', arguments: {} },
        ],
      });
      window.push({ role: 'tool', toolCallId: `c${step}a`, content: 'Z'.repeat(700) });
      window.push({ role: 'tool', toolCallId: `c${step}b`, content: 'Z'.repeat(700) });
      window.push({ role: 'tool', toolCallId: `c${step}c`, content: 'Z'.repeat(700) });
    }

    await window.compact(() => Promise.resolve('summary'));

    const messages = window.toMessages();
    const calls = new Set(messages.flatMap((message) => (message.toolCalls ?? []).map((c) => c.id)));
    const orphanResults = messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId)
      .filter((id): id is string => id !== undefined)
      .filter((id) => !calls.has(id));
    assert.deepEqual(
      orphanResults,
      [],
      `no tool result may survive without its call: orphans ${orphanResults.join(', ')}`,
    );
  });

  test('turn numbering survives compacting away a turn boundary', async () => {
    // Summarizing inside a turn removes the messages its start index points at.
    // If the boundary list is left empty, the next `beginTurn` numbers against
    // a stale list and the recent-turn window silently stops working.
    const window = new ContextWindow('system', contextPolicy);
    window.beginTurn();
    window.push({ role: 'user', content: 'go' });
    for (let call = 0; call < 30; call++) {
      window.push({
        role: 'assistant',
        content: `step ${call}`,
        toolCalls: [{ id: `c${call}`, name: 'read_file', arguments: {} }],
      });
      window.push({ role: 'tool', toolCallId: `c${call}`, content: 'Z'.repeat(1500) });
    }

    await window.compact(() => Promise.resolve('summary'));
    assert.ok(window.turnCount >= 1, 'the in-flight turn must still be counted');

    window.beginTurn();
    window.push({ role: 'user', content: 'next' });
    assert.equal(window.turnCount, 2);
  });

  test('trims stale tool output before spending a model call on summarizing', async () => {
    // `keepRecentTurns` holds the last two turns verbatim, so the floor here is
    // whatever those weigh. The target is set above that floor, which is the
    // situation where trimming alone is sufficient.
    const window = new ContextWindow('system', {
      ...contextPolicy,
      compactTargetTokens: 2500,
    });
    for (let turn = 0; turn < 4; turn++) {
      window.beginTurn();
      window.push({ role: 'user', content: `turn ${turn}` });
      window.push({ role: 'tool', content: 'x'.repeat(3000), toolCallId: `c${turn}` });
    }

    let summarizerCalled = false;
    const result = await window.compact(() => {
      summarizerCalled = true;
      return Promise.resolve('summary');
    });

    assert.equal(result.strategy, 'drop_tool_output');
    assert.equal(summarizerCalled, false, 'the cheap strategy must be tried first');
    assert.ok(result.afterTokens < result.beforeTokens);
  });

  test('escalates to summarizing when trimming alone misses the target', async () => {
    const window = new ContextWindow('system', contextPolicy);
    for (let turn = 0; turn < 4; turn++) {
      window.beginTurn();
      window.push({ role: 'user', content: `turn ${turn}` });
      window.push({ role: 'tool', content: 'x'.repeat(3000), toolCallId: `c${turn}` });
    }

    const result = await window.compact(() => Promise.resolve('condensed history'));
    assert.equal(result.strategy, 'summarize');
    assert.ok(result.afterTokens < result.beforeTokens);
  });

  test('summarizes older turns when trimming is not enough', async () => {
    const window = new ContextWindow('system', contextPolicy);
    for (let turn = 0; turn < 10; turn++) {
      window.beginTurn();
      window.push({ role: 'user', content: 'y'.repeat(2000) });
    }

    const result = await window.compact(() => Promise.resolve('the earlier work was done'));
    assert.equal(result.strategy, 'summarize');
    assert.ok(result.turnsSummarized > 0);
    // The summary sits just after the pinned original task (message[0]); it
    // replaces the middle span it summarized.
    assert.ok(
      window.messages.some((message) => message.content.includes('the earlier work was done')),
      'the summary replaces what it summarized',
    );
  });

  test('never discards the most recent turns', async () => {
    const window = new ContextWindow('system', contextPolicy);
    for (let turn = 0; turn < 10; turn++) {
      window.beginTurn();
      window.push({ role: 'user', content: `${'z'.repeat(2000)} marker-${turn}` });
    }

    await window.compact(() => Promise.resolve('summary'));
    const text = window.messages.map((message) => message.content).join('\n');
    assert.ok(text.includes('marker-9'), 'the agent needs exact detail about what it just did');
    assert.ok(text.includes('marker-8'));
  });

  test('never drops the original task, even through a summarize compaction', async () => {
    // Docstring rule #1: "the system prompt and the original task are never
    // dropped". The system prompt is safe (a separate field), but the original
    // task is #messages[0], and the summarized span used to start at index 0, so
    // the first turn was always folded into the summary — and the default
    // fallback summarizer discards its text entirely. The agent then runs on a
    // mechanical "N exchanges compacted" line with the task's scope and its
    // prohibitions gone. The first turn must survive verbatim.
    const window = new ContextWindow('system', contextPolicy);
    window.beginTurn();
    const task = 'Audit only /src/auth for SQLi; do NOT modify billing or write any files';
    window.push({ role: 'user', content: task });
    // Enough text-heavy later turns that the trim pass cannot reach the target and
    // the summarize pass runs. The summarizer is the lossy fallback shape: it does
    // NOT echo the messages it summarized.
    for (let turn = 0; turn < 10; turn++) {
      window.beginTurn();
      window.push({ role: 'user', content: 'y'.repeat(2000) });
    }

    const result = await window.compact(() => Promise.resolve('N earlier exchanges were compacted.'));
    assert.equal(result.strategy, 'summarize', 'the summarize pass must have run');
    assert.ok(result.turnsSummarized > 0);

    const text = window.messages.map((message) => message.content).join('\n');
    assert.ok(
      text.includes(task),
      'the original task and its prohibitions must survive compaction verbatim',
    );
  });

  test('a snapshot restores an equivalent window', () => {
    const window = new ContextWindow('system', contextPolicy);
    window.beginTurn();
    window.push({ role: 'user', content: 'remember this' });

    const restored = ContextWindow.restore(window.snapshot(), contextPolicy);
    assert.deepEqual(restored.toMessages(), window.toMessages());
    assert.equal(restored.turnCount, window.turnCount);
  });

  test('estimates are proportional to length', () => {
    assert.ok(estimateTokens('a'.repeat(1000)) > estimateTokens('a'.repeat(100)));
    assert.ok(estimateTokens('') === 0);
  });

  test('reserved tool-schema tokens count toward the compaction decision', () => {
    // The tool schemas ship with every request but are not in #messages, so the
    // window used to be blind to them: a large advertised toolset could push a
    // request past the model limit while the window thought it had room, and
    // compaction (message-only) could never recover it. A reserved tool-token
    // count must make needsCompaction trip.
    const window = new ContextWindow('system', {
      compactThresholdTokens: 1000,
      compactTargetTokens: 400,
      keepRecentTurns: 2,
      snapshotEveryTurns: 0,
    });
    window.beginTurn();
    window.push({ role: 'user', content: 'small' });
    assert.equal(window.needsCompaction(), false, 'a small context alone is under threshold');

    // A big toolset's estimated cost, reserved.
    const bigToolset = Array.from({ length: 200 }, (_unused, i) => ({
      name: `mcp__evil__t${i}`,
      description: 'x'.repeat(500),
      parameters: { type: 'object', properties: {} },
    }));
    const toolTokens = estimateToolTokens(bigToolset);
    assert.ok(toolTokens > 1000, 'the toolset alone exceeds the threshold');

    window.reserveToolTokens(toolTokens);
    assert.equal(
      window.needsCompaction(),
      true,
      'once the toolset cost is reserved, the window knows it must compact',
    );
    assert.ok(window.estimatedTokens() >= toolTokens, 'reserved tokens are included in the estimate');
  });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A model that replays a scripted sequence of responses. */
class ScriptedModel implements ModelClient {
  requests: ModelRequest[] = [];
  #script: ModelChunk[][];

  constructor(script: ModelChunk[][]) {
    this.#script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    const chunks = this.#script.shift() ?? [
      { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
    ];
    for (const chunk of chunks) {
      // Yield so the harness observes a genuinely asynchronous stream.
      await Promise.resolve();
      yield chunk;
    }
  }
}

/** Records every event the harness emits, for assertions about the log. */
function recorder(): { events: string[]; sink: HarnessEvents } {
  const events: string[] = [];
  const sink: HarnessEvents = {
    turnStarted: (turn) => events.push(`turn.started:${turn}`),
    turnCompleted: (turn, reason) => events.push(`turn.completed:${turn}:${reason}`),
    turnFailed: (turn) => events.push(`turn.failed:${turn}`),
    messageDelta: () => events.push('message.delta'),
    messageCompleted: () => events.push('message.completed'),
    thinkingDelta: () => events.push('thinking.delta'),
    thinkingCompleted: () => events.push('thinking.completed'),
    toolRequested: (call) => events.push(`tool.requested:${call.name}`),
    toolApproved: () => events.push('tool.approved'),
    toolDenied: (_id, rule) => events.push(`tool.denied:${rule}`),
    permissionDecided: (toolName, decision) => events.push(`permission.decided:${toolName}:${decision}`),
    toolStarted: () => events.push('tool.started'),
    toolOutput: () => events.push('tool.output'),
    toolCompleted: () => events.push('tool.completed'),
    toolFailed: () => events.push('tool.failed'),
    modelRequested: () => events.push('model.requested'),
    modelCompleted: () => events.push('model.completed'),
    modelFailed: () => events.push('model.failed'),
    contextCompacted: () => events.push('context.compacted'),
    contextSnapshot: () => events.push('context.snapshot'),
  };
  return { events, sink };
}

/**
 * A model that starts streaming and then stops, ignoring its abort signal.
 *
 * Deliberately hostile: the harness cannot assume a provider acts on the signal
 * it is handed, and this is the failure mode that wedges a session rather than
 * merely slowing it.
 */
class HangingModel implements ModelClient {
  aborted = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    // Registered before the first yield: a real provider wires its signal up
    // when the request starts, not after it has already stalled.
    request.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });
    yield { type: 'text', text: 'thinking' };
    // Never yields again, never returns, never rejects — the signal is observed
    // but deliberately not acted on, which is the case the harness must survive.
    await new Promise<never>(() => {});
  }
}

function makeVersion(overrides: Partial<AgentVersion> = {}): AgentVersion {
  return {
    agentId: 'ag_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    version: 1,
    changeSummary: '',
    systemPrompt: 'be useful',
    model: { modelId: 'test/model', fallbackModelIds: [] },
    tools: policy({ mode: 'auto' }),
    context: {
      compactThresholdTokens: 100_000,
      compactTargetTokens: 40_000,
      keepRecentTurns: 3,
      snapshotEveryTurns: 0,
    },
    sandbox: {} as AgentVersion['sandbox'],
    runtime: { type: 'builtin' },
    skills: [],
    plugins: [],
    mcpServers: [],
    subAgents: [],
    credentialIds: [],
    datasetIds: [],
    maxTurnsPerSession: 10,
    // Long enough that no ordinary test trips it; the deadline tests set
    // their own.
    turnTimeoutSeconds: 1800,
    metadata: {},
    createdAt: 0,
    createdBy: 'test',
    ...overrides,
  };
}

describe('agent harness', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ma-harness-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function harness(
    model: ModelClient,
    tools: ToolRegistry,
    version = makeVersion(),
    extra: Partial<HarnessOptions> = {},
  ): { harness: AgentHarness; events: string[] } {
    const { events, sink } = recorder();
    const instance = new AgentHarness({
      sessionId: 'sn_test',
      workspaceId: 'ws_test',
      version,
      model,
      tools,
      events: sink,
      clock: systemClock,
      workDir,
      logger: nullLogger,
      ...extra,
    });
    return { harness: instance, events };
  }

  test('completes a turn with no tool calls', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' there' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);
    const { harness: agent, events } = harness(model, new ToolRegistry());

    const result = await agent.runTurn('say hello');
    assert.equal(result.reason, 'completed');
    assert.equal(result.text, 'Hello there');
    assert.ok(events.includes('turn.started:1'));
    assert.ok(events.includes('turn.completed:1:completed'));
  });

  test('resuming from a snapshot continues the turn counter, not restart at 1', async () => {
    // A session recovered from a snapshot restored its context but reset #turn to
    // 0, so the next turn re-emitted turn numbers already in the log and refilled
    // its maxTurnsPerSession budget. The turn counter must resume with the
    // context: a session that had run 5 turns before losing its sandbox continues
    // at turn 6.
    const priorContext = new ContextWindow('system', makeVersion().context);
    for (let t = 0; t < 5; t++) {
      priorContext.beginTurn();
      priorContext.push({ role: 'user', content: `turn ${t}` });
      priorContext.push({ role: 'assistant', content: `reply ${t}` });
    }

    const model = new ScriptedModel([
      [
        { type: 'text', text: 'resumed' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);
    const { events, sink } = recorder();
    const agent = new AgentHarness(
      {
        sessionId: 'sn_resume',
        workspaceId: 'ws_test',
        version: makeVersion(),
        model,
        tools: new ToolRegistry(),
        events: sink,
        clock: systemClock,
        workDir,
        logger: nullLogger,
      },
      priorContext.snapshot(),
      5,
    );

    assert.equal(agent.turnCount, 5, 'the resumed harness must report the prior turn count');
    const result = await agent.runTurn('keep going');
    assert.equal(result.turn, 6, 'the next turn continues the count, not restarts at 1');
    assert.ok(events.includes('turn.started:6'), `expected turn.started:6, got ${events.join(', ')}`);
    assert.ok(!events.includes('turn.started:1'), 'must not re-emit an already-used turn number');
  });

  test('a resumed session cannot refill its maxTurnsPerSession budget', async () => {
    // The security/robustness consequence of the reset: recovering restored the
    // budget too, so an agent could loop indefinitely across repeated recoveries.
    // A session at its cap must stay refused after a resume.
    const version = makeVersion({ maxTurnsPerSession: 3 });
    const priorContext = new ContextWindow('system', makeVersion().context);
    for (let t = 0; t < 3; t++) {
      priorContext.beginTurn();
      priorContext.push({ role: 'user', content: `turn ${t}` });
    }
    const model = new ScriptedModel([
      [{ type: 'text', text: 'nope' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const { sink } = recorder();
    const agent = new AgentHarness(
      {
        sessionId: 'sn_cap',
        workspaceId: 'ws_test',
        version,
        model,
        tools: new ToolRegistry(),
        events: sink,
        clock: systemClock,
        workDir,
        logger: nullLogger,
      },
      priorContext.snapshot(),
      3,
    );

    const result = await agent.runTurn('one more');
    assert.equal(
      result.reason,
      'max_turns',
      'a session resumed at its turn cap must not get a fresh budget',
    );
    assert.equal(agent.turnCount, 3, 'the turn counter must not advance past the cap');
  });

  test('emits deltas as they arrive so a client can watch', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);
    const { harness: agent, events } = harness(model, new ToolRegistry());
    await agent.runTurn('hi');
    assert.equal(events.filter((event) => event === 'message.delta').length, 2);
  });

  test('runs a requested tool and feeds the result back to the model', async () => {
    const call: ModelToolCall = { id: 'call_1', name: 'echo', arguments: { value: 'x' } };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);

    const tools = new ToolRegistry().register({
      name: 'echo',
      description: 'echo',
      readOnly: true,
      parameters: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ output: 'the tool output' }),
    });

    const { harness: agent, events } = harness(model, tools);
    const result = await agent.runTurn('use the tool');

    assert.equal(result.reason, 'completed');
    assert.equal(result.iterations, 2);
    assert.ok(events.includes('tool.requested:echo'));
    assert.ok(events.includes('tool.completed'));
    // Every tool decision is audited by name, distinct from the per-call
    // tool.approved: the policy allowed `echo`.
    assert.ok(
      events.includes('permission.decided:echo:allow'),
      'the policy decision is audited by tool name',
    );

    // The second request must carry the tool result.
    const followUp = model.requests[1]!;
    const toolMessage = followUp.messages.find((message) => message.role === 'tool');
    assert.equal(toolMessage?.content, 'the tool output');
  });

  test('tells the model why a tool was denied rather than failing the turn', async () => {
    // The model can then choose a permitted route instead of retrying.
    const call: ModelToolCall = { id: 'call_1', name: 'write_file', arguments: {} };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      [
        { type: 'text', text: 'I will do something else' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);

    const tools = new ToolRegistry().register(fakeTool('write_file'));
    const { harness: agent, events } = harness(
      model,
      tools,
      makeVersion({ tools: policy({ mode: 'strict' }) }),
    );

    const result = await agent.runTurn('write a file');
    assert.equal(result.reason, 'completed');
    assert.ok(events.some((event) => event.startsWith('tool.denied:')));

    const toolMessage = model.requests[1]!.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('Permission denied'));
    assert.ok(toolMessage?.content.includes('allowlist'), 'the reason must reach the model');
  });

  test('a failing tool is reported to the model, not thrown', async () => {
    const call: ModelToolCall = { id: 'call_1', name: 'broken', arguments: {} };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      [
        { type: 'text', text: 'recovered' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);

    const tools = new ToolRegistry().register({
      name: 'broken',
      description: 'always fails',
      readOnly: true,
      parameters: { type: 'object', properties: {} },
      execute: () => Promise.reject(new Error('disk is on fire')),
    });

    const { harness: agent, events } = harness(model, tools);
    const result = await agent.runTurn('try it');

    assert.equal(result.reason, 'completed', 'a tool failure must not collapse the turn');
    assert.ok(events.includes('tool.failed'));
    const toolMessage = model.requests[1]!.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('disk is on fire'));
  });

  test('answers an unknown tool instead of leaving the model waiting', async () => {
    const call: ModelToolCall = { id: 'call_1', name: 'nonexistent', arguments: {} };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);

    const { harness: agent } = harness(model, new ToolRegistry());
    await agent.runTurn('call something imaginary');
    const toolMessage = model.requests[1]!.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('Unknown tool'));
  });

  test('denies a prompt-mode tool when no approver is present', async () => {
    // An unattended session has nobody to ask, and "ask a human" resolves to
    // "do not do it" rather than "do it anyway".
    const call: ModelToolCall = { id: 'call_1', name: 'risky', arguments: {} };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);

    const tools = new ToolRegistry().register(fakeTool('risky'));
    const { harness: agent, events } = harness(
      model,
      tools,
      makeVersion({ tools: policy({ mode: 'prompt' }) }),
    );

    await agent.runTurn('do the risky thing');
    assert.ok(events.some((event) => event.startsWith('tool.denied:')));
  });

  test('runs a prompt-mode tool when an approver says yes', async () => {
    const call: ModelToolCall = { id: 'call_1', name: 'risky', arguments: {} };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);

    const tools = new ToolRegistry().register(fakeTool('risky'));
    const { harness: agent, events } = harness(
      model,
      tools,
      makeVersion({ tools: policy({ mode: 'prompt' }) }),
      { approve: () => Promise.resolve(true) },
    );

    await agent.runTurn('do it');
    assert.ok(events.includes('tool.approved'));
    assert.ok(events.includes('tool.completed'));
  });

  test('a rejecting approver becomes a tool result, not a turn-collapsing throw', async () => {
    // The approval await ran BEFORE the tool try/catch, so a review-service RPC
    // that rejected (or timed out) escaped the turn. Worse: the assistant
    // tool_calls message was already in the context but no tool result was, so
    // every later request carried an orphaned tool_calls turn that providers 400,
    // wedging the session. A rejected approval must become a denial tool result,
    // exactly like an execute failure, so the turn ends coherently and the next
    // turn can run.
    const call: ModelToolCall = { id: 'call_1', name: 'risky', arguments: {} };
    const model = new ScriptedModel([
      // Turn 1: the model asks for the risky tool.
      [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      // Turn 1 continues after the (rejected) approval, then finishes.
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
      // Turn 2: a fresh instruction; this must be able to run.
      [
        { type: 'text', text: 'second turn ran' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);

    const tools = new ToolRegistry().register(fakeTool('risky'));
    const { harness: agent, events } = harness(
      model,
      tools,
      makeVersion({ tools: policy({ mode: 'prompt' }) }),
      { approve: () => Promise.reject(new Error('review service unavailable')) },
    );

    // The turn must NOT throw — the rejection is handled as data.
    const first = await agent.runTurn('do the risky thing');
    assert.equal(first.reason, 'completed', 'the turn ends coherently despite the failed approval');
    assert.ok(events.includes('tool.failed'), 'the failure is recorded');

    // Context coherence: every assistant tool_calls message has a matching tool
    // result, so a follow-up turn is accepted rather than 400ing on an orphan.
    const second = await agent.runTurn('now do something else');
    assert.equal(second.reason, 'completed');
    assert.equal(second.text, 'second turn ran');
  });

  test('stops a model that keeps calling tools without converging', async () => {
    const loop: ModelChunk[] = [
      { type: 'tool_call', call: { id: 'c', name: 'echo', arguments: {} } },
      { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
    ];
    const model = new ScriptedModel(Array.from({ length: 20 }, () => [...loop]));
    const tools = new ToolRegistry().register(fakeTool('echo', true));

    const { harness: agent } = harness(model, tools, makeVersion(), { maxIterationsPerTurn: 3 });
    const result = await agent.runTurn('loop forever');

    assert.equal(result.reason, 'max_turns');
    assert.equal(result.iterations, 3, 'the bound must be enforced, not hoped for');
  });

  test('a model that hangs and ignores its signal cannot wedge the session', async () => {
    // Without a deadline this turn never returns. Worse than slow: `#running`
    // stays true, so every later turn throws TURN_IN_PROGRESS and the session
    // is unusable until its sandbox is destroyed.
    const clock = new TestClock(1_700_000_000_000);
    const model = new HangingModel();
    const { harness: agent } = harness(
      model,
      new ToolRegistry(),
      makeVersion({ turnTimeoutSeconds: 30 }),
      { clock },
    );

    const turn = agent.runTurn('this will hang');
    // Let the stream start before the clock jumps, so the harness is genuinely
    // parked on the model rather than never having reached it.
    await Promise.resolve();
    await clock.advance(30_000);

    await assert.rejects(turn, (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'TURN_TIMEOUT');
      return true;
    });

    assert.equal(model.aborted, true, 'the provider must be told to stop');

    // The session recovers: a later turn runs rather than hitting
    // TURN_IN_PROGRESS.
    const { harness: recovered } = harness(
      new ScriptedModel([
        [
          { type: 'text', text: 'fine' },
          { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
        ],
      ]),
      new ToolRegistry(),
      makeVersion(),
      { clock },
    );
    assert.equal((await recovered.runTurn('again')).reason, 'completed');
  });

  test('a compaction summarizer that hangs cannot wedge the session', async () => {
    // #callModel and #runTool race their blocking awaits against the turn
    // deadline, but the compaction summarize await did not. A production
    // model-backed summarizer that hangs would park the turn loop forever with
    // #running true — the same wedge the deadline exists to prevent, just at a
    // different await. It must be raced too.
    const clock = new TestClock(1_700_000_000_000);
    const contextPolicy = {
      compactThresholdTokens: 1000,
      compactTargetTokens: 400,
      keepRecentTurns: 2,
      snapshotEveryTurns: 0,
    };
    // Pre-load a context with enough text-heavy turns that the first
    // #compactIfNeeded must run the SUMMARIZE pass (trim alone can't reach the
    // target and there are older turns to fold), so the hung summarizer is
    // actually awaited.
    const preloaded = new ContextWindow('be useful', contextPolicy);
    for (let t = 0; t < 10; t++) {
      preloaded.beginTurn();
      preloaded.push({ role: 'user', content: 'y'.repeat(2000) });
    }

    const model = new ScriptedModel([
      [
        { type: 'text', text: 'unreached' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);
    const { events, sink } = recorder();
    const agent = new AgentHarness(
      {
        sessionId: 'sn_test',
        workspaceId: 'ws_test',
        version: makeVersion({ turnTimeoutSeconds: 30, context: contextPolicy }),
        model,
        tools: new ToolRegistry(),
        events: sink,
        clock,
        workDir,
        logger: nullLogger,
        // A summarizer that never resolves — a hung summarization model call.
        summarize: () => new Promise<string>(() => {}),
      },
      preloaded.snapshot(),
      3,
    );
    void events;

    const turn = agent.runTurn('trigger compaction');
    // Let the loop reach the raced summarize await before the clock jumps: the
    // turn runs #compactIfNeeded, whose compact() does a synchronous trim pass
    // and then parks on the hung summarizer. Flush enough microtasks that the
    // race's abort listener is registered before the deadline fires.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await clock.advance(30_000);

    await assert.rejects(turn, (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'TURN_TIMEOUT');
      return true;
    });

    // The session recovers rather than being stuck in `running`.
    assert.equal(agent.running, false, 'the turn must release #running on timeout');
  });

  test('interrupt stops a turn parked on an unresponsive model', async () => {
    // The interrupt checks in the turn loop are unreachable while control is
    // inside the model call, so the abort has to be raced at that boundary.
    const clock = new TestClock(1_700_000_000_000);
    const model = new HangingModel();
    const { harness: agent } = harness(model, new ToolRegistry(), makeVersion(), { clock });

    const turn = agent.runTurn('hang');
    await Promise.resolve();
    agent.interrupt();

    await assert.rejects(turn, (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'TURN_INTERRUPTED');
      return true;
    });
    assert.equal(model.aborted, true);
  });

  test('does not repeat an assistant message that preceded tool calls', async () => {
    // `finalText` carries the last non-empty text forward so the caller gets
    // something useful back. But when a later iteration returns no text — very
    // common after tool results — `#endTurn` pushed that *earlier* text again,
    // even though it had already been recorded alongside its tool calls. The
    // model then sees itself say the same thing twice, and the duplicate is
    // persisted into every snapshot and replay.
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'I will look that up.' },
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: {} } },
        { type: 'done', stopReason: 'tool_use', usage: ZERO_USAGE },
      ],
      // No text this time, which is what triggers the carry-forward.
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
      // A second turn, purely so its request shows us the context the first
      // one left behind — the duplicate is pushed at the *end* of turn one, so
      // no request within that turn can reveal it.
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);
    const tools = new ToolRegistry().register(fakeTool('echo', true));
    const { harness: agent } = harness(model, tools, makeVersion());

    await agent.runTurn('look it up');
    await agent.runTurn('and again');

    const messages = model.requests[2]!.messages;
    const spoken = messages.filter(
      (message) => message.role === 'assistant' && message.content === 'I will look that up.',
    );
    assert.equal(spoken.length, 1, `the assistant said it ${spoken.length} times`);
  });

  test('refuses a turn past the session limit', async () => {
    const model = new ScriptedModel([]);
    const { harness: agent } = harness(
      model,
      new ToolRegistry(),
      makeVersion({ maxTurnsPerSession: 1 }),
    );

    await agent.runTurn('first');
    const second = await agent.runTurn('second');
    assert.equal(second.reason, 'max_turns');
  });

  test('rejects a concurrent turn on the same session', async () => {
    const model = new ScriptedModel([
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const { harness: agent } = harness(model, new ToolRegistry());

    const first = agent.runTurn('one');
    await assert.rejects(agent.runTurn('two'), (error: unknown) => {
      assert.ok(MaError.is(error));
      assert.equal(error.code, 'TURN_IN_PROGRESS');
      return true;
    });
    await first;
  });

  test('accumulates usage across model calls in a turn', async () => {
    const usage: Usage = { ...ZERO_USAGE, inputTokens: 100, outputTokens: 20 };
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call: { id: 'c', name: 'echo', arguments: {} } },
        { type: 'done', stopReason: 'tool_use', usage },
      ],
      [{ type: 'done', stopReason: 'end_turn', usage }],
    ]);
    const tools = new ToolRegistry().register(fakeTool('echo', true));

    const { harness: agent } = harness(model, tools);
    const result = await agent.runTurn('go');
    assert.equal(result.usage.inputTokens, 200);
    assert.equal(result.usage.outputTokens, 40);
  });

  test('reports context exhaustion distinctly from completion', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'partial' },
        { type: 'done', stopReason: 'max_tokens', usage: ZERO_USAGE },
      ],
    ]);
    const { harness: agent } = harness(model, new ToolRegistry());
    const result = await agent.runTurn('write an essay');
    assert.equal(result.reason, 'context_exhausted');
  });

  test('surfaces a model failure as a turn failure', async () => {
    const model: ModelClient = {
      stream() {
        // Fails on the first pull rather than at construction, which is how a
        // provider outage actually surfaces mid-stream.
        return (async function* () {
          await Promise.resolve();
          throw new Error('the provider is down');
        })();
      },
    };
    const { harness: agent, events } = harness(model, new ToolRegistry());

    await assert.rejects(agent.runTurn('hi'), /the provider is down/);
    assert.ok(events.includes('model.failed'));
    assert.ok(events.includes('turn.failed:1'));
  });

  test('a snapshot taken mid-conversation restores the same context', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'remembered' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE },
      ],
    ]);
    const { harness: agent } = harness(model, new ToolRegistry());
    await agent.runTurn('remember this');

    const snapshot = agent.snapshot();
    assert.ok(snapshot.messages.some((message) => message.content.includes('remember this')));
    assert.ok(snapshot.messages.some((message) => message.content.includes('remembered')));
  });

  test('persists a snapshot whose bytes match the event digest, on its cadence', async () => {
    const { createHash } = await import('node:crypto');
    const model = new ScriptedModel([
      [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const persisted: { digest: string; turn: number; bytes: string }[] = [];
    const { harness: agent, events } = harness(
      model,
      new ToolRegistry(),
      // Snapshot every turn, so one turn is enough to trigger it.
      makeVersion({
        context: {
          compactThresholdTokens: 100_000,
          compactTargetTokens: 40_000,
          keepRecentTurns: 3,
          snapshotEveryTurns: 1,
        },
      }),
      {
        persistSnapshot: (snapshot) => {
          persisted.push({ digest: snapshot.digest, turn: snapshot.turn, bytes: snapshot.bytes });
          return Promise.resolve();
        },
      },
    );

    await agent.runTurn('hello');

    assert.equal(persisted.length, 1, 'one snapshot persisted on the every-turn cadence');
    assert.ok(events.includes('context.snapshot'), 'the event is still emitted');
    // The uploaded bytes must hash to the digest the bridge will verify against.
    const decoded = Buffer.from(persisted[0]!.bytes, 'base64');
    assert.equal(
      createHash('sha256').update(decoded).digest('hex'),
      persisted[0]!.digest,
      'the uploaded bytes hash to the reported digest',
    );
    // And they deserialize back to a restorable snapshot.
    const parsed = JSON.parse(decoded.toString('utf8')) as { messages: { content: string }[] };
    assert.ok(parsed.messages.some((m) => m.content.includes('hello')));
  });

  test('model.completed names the model that answered when the client reports one', async () => {
    // After a gateway failover the answer comes from a fallback; reporting the
    // requested model made the log claim the failed primary had answered too.
    const answered: string[] = [];
    const model = new ScriptedModel([
      [{ type: 'text', text: 'hi' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE, modelId: 'x/fallback' }],
      [{ type: 'text', text: 'again' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const { sink } = recorder();
    const { harness: agent } = harness(model, new ToolRegistry(), undefined, {
      events: { ...sink, modelCompleted: (modelId) => answered.push(modelId) },
    });
    await agent.runTurn('first');
    await agent.runTurn('second');
    assert.deepEqual(answered, ['x/fallback', makeVersion().model.modelId], 'the requested model only when none is reported');
  });

  test('checkpoint persists the whole conversation now, off the snapshot cadence', async () => {
    // What an in-place rebind of the same session saves before teardown: the
    // cadence here is every 5 turns, so after 2 turns no periodic snapshot exists.
    const model = new ScriptedModel([
      [{ type: 'text', text: 'one' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
      [{ type: 'text', text: 'two' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const persisted: { turn: number; bytes: string }[] = [];
    const { harness: agent } = harness(
      model,
      new ToolRegistry(),
      makeVersion({
        context: { compactThresholdTokens: 100_000, compactTargetTokens: 40_000, keepRecentTurns: 3, snapshotEveryTurns: 5 },
      }),
      {
        persistSnapshot: (snapshot) => {
          persisted.push({ turn: snapshot.turn, bytes: snapshot.bytes });
          return Promise.resolve();
        },
      },
    );
    await agent.runTurn('first question');
    await agent.runTurn('second question');
    assert.equal(persisted.length, 0, 'the cadence has not fired yet');

    assert.equal(await agent.checkpoint(), true);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.turn, 2, 'the snapshot carries the turn count, so a rebuild resumes it');
    const restored = JSON.parse(Buffer.from(persisted[0]!.bytes, 'base64').toString('utf8')) as {
      messages: { content: string }[];
    };
    assert.ok(restored.messages.some((m) => m.content.includes('first question')), 'the earliest turn is in it');
  });

  test('checkpoint reports a failed upload and has nothing to save before the first turn', async () => {
    const fresh = harness(new ScriptedModel([]), new ToolRegistry(), undefined, {
      persistSnapshot: () => Promise.reject(new Error('must not be called')),
    });
    assert.equal(await fresh.harness.checkpoint(), true, 'an empty conversation is trivially covered');

    const model = new ScriptedModel([
      [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const failing = harness(model, new ToolRegistry(), undefined, {
      persistSnapshot: () => Promise.reject(new Error('upload failed')),
    });
    await failing.harness.runTurn('hi');
    assert.equal(await failing.harness.checkpoint(), false, 'the caller learns the conversation was not saved');
  });

  test('a failing snapshot upload does not fail the turn', async () => {
    // Losing a snapshot degrades recovery to a fresh start; it must never turn a
    // working turn into a failed one.
    const model = new ScriptedModel([
      [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const { harness: agent } = harness(
      model,
      new ToolRegistry(),
      makeVersion({
        context: {
          compactThresholdTokens: 100_000,
          compactTargetTokens: 40_000,
          keepRecentTurns: 3,
          snapshotEveryTurns: 1,
        },
      }),
      { persistSnapshot: () => Promise.reject(new Error('upload failed')) },
    );

    const result = await agent.runTurn('hi');
    assert.equal(result.reason, 'completed', 'the turn completes despite the upload failure');
    assert.equal(result.text, 'done');
  });

  test('restores from a snapshot so a new harness continues the conversation', async () => {
    // The resume path end to end at the harness level: snapshot one harness,
    // build a second from those bytes, and confirm the earlier turn is in its
    // context (what a recovering sandbox does after its predecessor was lost).
    const first = harness(
      new ScriptedModel([[{ type: 'text', text: 'first answer' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }]]),
      new ToolRegistry(),
    );
    await first.harness.runTurn('the original question');
    const snapshot = first.harness.snapshot();

    // A fresh harness restored from the snapshot, as agent-core does on recovery.
    const { events, sink } = recorder();
    const second = new AgentHarness(
      {
        sessionId: 'sn_test',
        workspaceId: 'ws_test',
        version: makeVersion(),
        model: new ScriptedModel([[{ type: 'text', text: 'second answer' }, { type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }]]),
        tools: new ToolRegistry(),
        events: sink,
        clock: systemClock,
        workDir,
        logger: nullLogger,
      },
      snapshot,
    );
    void events;

    const restored = second.snapshot();
    assert.ok(
      restored.messages.some((m) => m.content.includes('the original question')),
      'the restored harness carries the earlier turn',
    );
  });

  test('advertises only tools the policy permits', async () => {
    const model = new ScriptedModel([
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO_USAGE }],
    ]);
    const tools = new ToolRegistry().registerAll([
      fakeTool('read_file', true),
      fakeTool('write_file', false),
    ]);

    const { harness: agent } = harness(
      model,
      tools,
      makeVersion({ tools: policy({ mode: 'strict', allow: ['read_file'] }) }),
    );
    await agent.runTurn('hi');

    const advertised = model.requests[0]!.tools.map((tool) => tool.name);
    assert.deepEqual(advertised, ['read_file']);
  });
});

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

describe('built-in tools', () => {
  let workDir: string;
  let context: ToolContext;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'ma-tools-'));
    context = {
      sessionId: 'sn_test',
      workspaceId: 'ws_test',
      turn: 1,
      workDir,
      signal: new AbortController().signal,
      emit: () => {},
    };
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test('writes and reads a file', async () => {
    await writeFileTool.execute({ path: 'notes/a.txt', content: 'hello' }, context);
    const result = await readFileTool.execute({ path: 'notes/a.txt' }, context);
    assert.equal(result.output, 'hello');
  });

  test('refuses to escape the sandbox with traversal', async () => {
    for (const path of ['../outside.txt', 'a/../../outside.txt', 'a/b/../../../outside.txt']) {
      await assert.rejects(
        readFileTool.execute({ path }, context),
        (error: unknown) => MaError.is(error) && error.status === 400,
        `${path} must be refused`,
      );
    }
  });

  test('refuses an absolute path', async () => {
    await assert.rejects(
      readFileTool.execute({ path: '/etc/passwd' }, context),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('refuses to write outside the sandbox', async () => {
    await assert.rejects(
      writeFileTool.execute({ path: '../escaped.txt', content: 'x' }, context),
      (error: unknown) => MaError.is(error) && error.status === 400,
    );
  });

  test('truncates a large read and says so', async () => {
    await writeFile(join(workDir, 'big.txt'), 'x'.repeat(5000), 'utf8');
    const result = await readFileTool.execute({ path: 'big.txt', maxBytes: 100 }, context);
    assert.equal(result.truncated, true);
    assert.ok(result.output.includes('truncated'));
  });

  test('lists a directory', async () => {
    await mkdir(join(workDir, 'sub'), { recursive: true });
    await writeFile(join(workDir, 'file.txt'), 'x', 'utf8');
    const result = await listDirectoryTool.execute({ path: '.' }, context);
    assert.ok(result.output.includes('file.txt'));
    assert.ok(result.output.includes('sub'));
  });

  test('searches file contents and reports locations', async () => {
    await writeFile(join(workDir, 'a.txt'), 'alpha\nbeta\ngamma', 'utf8');
    const result = await searchTool.execute({ pattern: 'bet' }, context);
    assert.ok(result.output.includes('a.txt:2'));
  });

  test('reports an invalid pattern rather than throwing', async () => {
    const result = await searchTool.execute({ pattern: '[unclosed' }, context);
    assert.equal(result.isError, true);
  });

  test('a catastrophic regex times out instead of wedging the process', async () => {
    // The ReDoS: `(a+)+$` against a long non-matching line backtracks for
    // effectively forever. Run synchronously on the main thread it blocks the
    // event loop — the turn deadline and abort signal can never fire, so the
    // whole agent-core process hangs. The search must run off-thread and be
    // killed at the timeout instead.
    await writeFile(join(workDir, 'evil.txt'), 'a'.repeat(50) + '!', 'utf8');
    const search = createSearchTool({ timeoutMs: 500 });
    const result = await search.execute({ pattern: '(a+)+$' }, context);
    assert.equal(result.isError, true, 'a runaway search must report an error');
    assert.ok(/timed out/i.test(result.output), `expected a timeout message, got: ${result.output}`);
  });

  test('the event loop stays responsive while a catastrophic search runs', async () => {
    // The heart of the fix: a concurrent timer must still fire while the
    // expensive regex is grinding. If the match ran on the main thread this
    // interval would be starved and tick zero times before the search settled.
    await writeFile(join(workDir, 'evil.txt'), 'a'.repeat(60) + '!', 'utf8');
    const search = createSearchTool({ timeoutMs: 1_000 });

    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 20);
    try {
      const result = await search.execute({ pattern: '(a+)+$' }, context);
      assert.equal(result.isError, true);
    } finally {
      clearInterval(interval);
    }
    // With a worker, ~50 ticks are possible in the ~1s window; on the main thread
    // the count would be 0. Assert a generous floor to stay robust on slow CI.
    assert.ok(ticks >= 5, `event loop was starved during the search (only ${ticks} ticks)`);
  });

  test('a catastrophic search timeout is driven by the injected clock', async () => {
    // The timeout is clock-driven, so a test can trigger it deterministically
    // rather than waiting real wall-clock. Advancing the fake clock past the
    // ceiling terminates the worker and returns the timeout.
    await writeFile(join(workDir, 'evil.txt'), 'a'.repeat(60) + '!', 'utf8');
    const clock = new TestClock(1_700_000_000_000);
    const search = createSearchTool({ timeoutMs: 30_000, clock });
    const pending = search.execute({ pattern: '(a+)+$' }, context);
    // Let the worker spin up and start grinding, then jump the clock past the
    // ceiling. `TestClock.sleep` resolves when the clock advances, not on the
    // wall clock, so this settles fast.
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock.advance(30_001);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.ok(/timed out/i.test(result.output));
  });

  test('an interrupted search is aborted', async () => {
    await writeFile(join(workDir, 'evil.txt'), 'a'.repeat(60) + '!', 'utf8');
    const controller = new AbortController();
    const search = createSearchTool({ timeoutMs: 30_000 });
    const pending = search.execute(
      { pattern: '(a+)+$' },
      { ...context, signal: controller.signal },
    );
    // Give the worker a moment to start, then interrupt the turn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.ok(/interrupt/i.test(result.output), `expected an interrupt message, got: ${result.output}`);
  });

  test('runs a command and captures its output', async () => {
    const shell = createShellTool();
    const result = await shell.execute({ command: 'echo hello' }, context);
    assert.ok(result.output.includes('hello'));
    assert.notEqual(result.isError, true);
  });

  test('exposes configured env (e.g. a credential file path) to the command', async () => {
    // A file credential's *path* is exposed as MA_CRED_<NAME>_FILE so a command
    // can read it; the value itself is never placed in env.
    const shell = createShellTool({ env: { MA_CRED_KUBECONFIG_FILE: '/creds/kubeconfig' } });
    const result = await shell.execute({ command: 'printenv MA_CRED_KUBECONFIG_FILE' }, context);
    assert.ok(result.output.includes('/creds/kubeconfig'), 'the configured env var reaches the command');
  });

  test('reports a non-zero exit as an error the model can see', async () => {
    const shell = createShellTool();
    const result = await shell.execute({ command: 'false' }, context);
    assert.equal(result.isError, true);
    assert.ok(result.output.includes('Exit code'));
  });

  test('honours quoted arguments', async () => {
    const shell = createShellTool();
    const result = await shell.execute({ command: 'echo "one two"' }, context);
    assert.ok(result.output.includes('one two'));
  });

  test('does not run through a shell, so operators are literal', async () => {
    // spawn with an argv array means there is no shell to inject into; the
    // permission engine's view of the command is what actually runs.
    const shell = createShellTool();
    const result = await shell.execute({ command: 'echo a;b' }, context);
    assert.ok(result.output.includes('a;b'), 'the semicolon must be data, not syntax');
  });

  test('an interrupted command is killed', async () => {
    const controller = new AbortController();
    const shell = createShellTool();
    const pending = shell.execute(
      { command: 'sleep 30' },
      { ...context, signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.ok(result.output.includes('interrupted'));
  });

  test('reports a missing executable clearly', async () => {
    const shell = createShellTool();
    const result = await shell.execute({ command: 'definitely-not-a-real-binary-xyz' }, context);
    assert.equal(result.isError, true);
    assert.ok(result.output.includes('Failed to start'));
  });

  test('the default set covers read, write, list, search and run', () => {
    const names = builtinTools().map((tool) => tool.name).sort();
    assert.deepEqual(names, ['bash', 'list_directory', 'read_file', 'search', 'write_file']);
  });

  test('read-only tools are marked so plan mode can permit them', () => {
    const byName = new Map(builtinTools().map((tool) => [tool.name, tool.readOnly]));
    assert.equal(byName.get('read_file'), true);
    assert.equal(byName.get('search'), true);
    assert.equal(byName.get('write_file'), false);
    assert.equal(byName.get('bash'), false);
  });
});
