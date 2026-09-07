/**
 * Sub-agent tests.
 *
 * The security property under test throughout: delegation narrows authority and
 * can never widen it. If a parent could reach a denied tool by spawning a child,
 * the permission engine would be decorative.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MaError, nullLogger, systemClock } from '@ma/core';
import type { AgentVersion, SubAgent, ToolPolicy, Usage } from '@ma/contracts';

import {
  MAX_DELEGATION_DEPTH,
  SubAgentRunner,
  ToolRegistry,
  createDelegateTool,
  type HarnessEvents,
  type ModelChunk,
  type ModelClient,
  type ModelRequest,
  type Tool,
  type ToolContext,
} from '../src/index.ts';

const ZERO: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 0,
};

let workDir: string;

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return { mode: 'strict', allow: [], deny: [], allowedCommands: [], deniedCommands: [], ...overrides };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    readOnly: true,
    parameters: { type: 'object', properties: {} },
    execute: () => Promise.resolve({ output: `${name} ran` }),
  };
}

function makeVersion(tools: ToolPolicy): AgentVersion {
  return {
    agentId: 'ag_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    version: 1,
    changeSummary: '',
    systemPrompt: 'parent prompt',
    model: { modelId: 'test/parent', fallbackModelIds: [] },
    tools,
    context: {
      compactThresholdTokens: 100_000,
      compactTargetTokens: 40_000,
      keepRecentTurns: 3,
      snapshotEveryTurns: 0,
    },
    sandbox: {} as AgentVersion['sandbox'],
    skills: [],
    plugins: [],
    mcpServers: [],
    subAgents: [],
    credentialIds: [],
    datasetIds: [],
    runAs: '',
    maxTurnsPerSession: 100,
    metadata: {},
    createdAt: 0,
    createdBy: 'test',
  };
}

function makeSubAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    name: 'researcher',
    description: 'Explores a question',
    systemPrompt: 'You research thoroughly and report concisely.',
    tools: [],
    maxTurns: 5,
    ...overrides,
  };
}

/** A model that answers once, recording what it was asked. */
class ScriptedModel implements ModelClient {
  requests: ModelRequest[] = [];
  readonly #script: ModelChunk[][];

  constructor(script: ModelChunk[][]) {
    this.#script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    this.requests.push(request);
    const chunks = this.#script.shift() ?? [{ type: 'done', stopReason: 'end_turn', usage: ZERO }];
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  }
}

function silentEvents(): HarnessEvents {
  const noop = (): void => {};
  return {
    turnStarted: noop,
    turnCompleted: noop,
    turnFailed: noop,
    messageDelta: noop,
    messageCompleted: noop,
    thinkingDelta: noop,
    thinkingCompleted: noop,
    toolRequested: noop,
    toolApproved: noop,
    toolDenied: noop,
    toolStarted: noop,
    toolOutput: noop,
    toolCompleted: noop,
    toolFailed: noop,
    modelRequested: noop,
    modelCompleted: noop,
    modelFailed: noop,
    contextCompacted: noop,
    contextSnapshot: noop,
  };
}

function makeRunner(
  parentPolicy: ToolPolicy,
  model: ModelClient,
  tools: ToolRegistry,
  events: HarnessEvents = silentEvents(),
  depth = 0,
): SubAgentRunner {
  return new SubAgentRunner({
    sessionId: 'sn_test',
    workspaceId: 'ws_test',
    parentVersion: makeVersion(parentPolicy),
    model,
    tools,
    events,
    clock: systemClock,
    workDir,
    logger: nullLogger,
    depth,
  });
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ma-subagent-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('scoping', () => {
  test('a child sees only the intersection of its request and the parent’s grant', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const tools = new ToolRegistry().registerAll([
      fakeTool('read_file'),
      fakeTool('write_file'),
      fakeTool('bash'),
    ]);

    const runner = makeRunner(policy({ allow: ['read_file', 'write_file'] }), model, tools);
    await runner.run(makeSubAgent({ tools: ['read_file', 'bash'] }), 'look at something');

    // `bash` was requested but the parent does not hold it.
    const advertised = model.requests[0]!.tools.map((tool) => tool.name);
    assert.deepEqual(advertised, ['read_file']);
  });

  test('delegation cannot reach a tool the parent denies', async () => {
    // If it could, the permission engine would be decorative. A child asking
    // only for a denied tool is refused outright rather than started without it.
    const tools = new ToolRegistry().registerAll([fakeTool('read_file'), fakeTool('dangerous')]);
    const runner = makeRunner(
      policy({ allow: ['read_file', 'dangerous'], deny: ['dangerous'] }),
      new ScriptedModel([]),
      tools,
    );

    await assert.rejects(
      runner.run(makeSubAgent({ tools: ['dangerous'] }), 'try it'),
      (error: unknown) => MaError.is(error) && error.code === 'SUBAGENT_HAS_NO_TOOLS',
    );
  });

  test('a denied tool is withheld from a child that also asks for permitted ones', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const tools = new ToolRegistry().registerAll([fakeTool('read_file'), fakeTool('dangerous')]);

    const runner = makeRunner(
      policy({ allow: ['read_file', 'dangerous'], deny: ['dangerous'] }),
      model,
      tools,
    );
    await runner.run(makeSubAgent({ tools: ['read_file', 'dangerous'] }), 'try it');

    const advertised = model.requests[0]!.tools.map((tool) => tool.name);
    assert.deepEqual(advertised, ['read_file']);
  });

  test('an empty tool list inherits the parent’s, not everything', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const tools = new ToolRegistry().registerAll([
      fakeTool('read_file'),
      fakeTool('write_file'),
      fakeTool('never_granted'),
    ]);

    const runner = makeRunner(policy({ allow: ['read_file', 'write_file'] }), model, tools);
    await runner.run(makeSubAgent({ tools: [] }), 'do the work');

    const advertised = model.requests[0]!.tools.map((tool) => tool.name).sort();
    assert.deepEqual(advertised, ['read_file', 'write_file']);
  });

  test('refuses a child whose every requested tool is out of scope', async () => {
    // Running it anyway would produce a child that silently cannot work.
    const runner = makeRunner(
      policy({ allow: ['read_file'] }),
      new ScriptedModel([]),
      new ToolRegistry().register(fakeTool('read_file')),
    );

    await assert.rejects(
      runner.run(makeSubAgent({ tools: ['bash', 'network'] }), 'go'),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'SUBAGENT_HAS_NO_TOOLS');
        return true;
      },
    );
  });

  test('a child runs strict even when the parent prompts', async () => {
    // A parent in `prompt` mode has a human watching *it*, not each delegate,
    // so a child gets no prompting path — only what it was explicitly granted.
    const model = new ScriptedModel([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'not_granted', arguments: {} } },
        { type: 'done', stopReason: 'tool_use', usage: ZERO },
      ],
      [
        { type: 'text', text: 'blocked' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const tools = new ToolRegistry().registerAll([fakeTool('read_file'), fakeTool('not_granted')]);

    const runner = makeRunner(policy({ mode: 'prompt', allow: ['read_file'] }), model, tools);
    await runner.run(makeSubAgent(), 'attempt something');

    // The ungranted tool was never advertised, and calling it anyway is denied
    // outright rather than routed to a human who is not watching.
    assert.deepEqual(model.requests[0]!.tools.map((tool) => tool.name), ['read_file']);
    const toolMessage = model.requests[1]!.messages.find((message) => message.role === 'tool');
    assert.ok(toolMessage?.content.includes('Unknown tool') || toolMessage?.content.includes('Permission denied'));
  });

  test('command rules are inherited wholesale', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const runner = makeRunner(
      policy({ allow: ['bash'], allowedCommands: ['git'], deniedCommands: ['rm'] }),
      model,
      new ToolRegistry().register(fakeTool('bash')),
    );

    const result = await runner.run(makeSubAgent({ tools: ['bash'] }), 'run something');
    assert.equal(result.reason, 'completed');
  });
});

describe('child configuration', () => {
  test('uses its own prompt and turn budget', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'reported' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const runner = makeRunner(policy({ allow: ['read_file'] }), model, new ToolRegistry().register(fakeTool('read_file')));

    await runner.run(
      makeSubAgent({ systemPrompt: 'You are a specialist summariser.', maxTurns: 2 }),
      'summarise this',
    );

    const system = model.requests[0]!.messages.find((message) => message.role === 'system');
    assert.equal(system?.content, 'You are a specialist summariser.');
    assert.equal(
      system?.content.includes('parent prompt'),
      false,
      'a child starts fresh rather than inheriting the parent’s framing',
    );
  });

  test('can use a different model, and inherits the parent’s otherwise', async () => {
    const model = new ScriptedModel([
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO }],
      [{ type: 'done', stopReason: 'end_turn', usage: ZERO }],
    ]);
    const runner = makeRunner(policy({ allow: ['read_file'] }), model, new ToolRegistry().register(fakeTool('read_file')));

    await runner.run(makeSubAgent({ modelId: 'test/cheap' }), 'a small task');
    assert.equal(model.requests[0]!.modelId, 'test/cheap');

    await runner.run(makeSubAgent(), 'another task');
    assert.equal(model.requests[1]!.modelId, 'test/parent');
  });

  test('a child cannot spawn further children', async () => {
    // Unbounded nesting is how one delegation becomes a fork bomb.
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);

    const runner = makeRunner(
      policy({ allow: ['read_file'] }),
      model,
      new ToolRegistry().register(fakeTool('read_file')),
    );
    const result = await runner.run(makeSubAgent(), 'work');
    assert.equal(result.reason, 'completed');
  });

  test('returns a summary and its usage, not a transcript', async () => {
    // Delegation is only useful if the result is smaller than the work.
    const model = new ScriptedModel([
      [
        { type: 'thinking', text: 'a long internal exploration the parent should never see' },
        { type: 'text', text: 'The answer is 42.' },
        { type: 'done', stopReason: 'end_turn', usage: { ...ZERO, inputTokens: 900, outputTokens: 60 } },
      ],
    ]);

    const runner = makeRunner(policy({ allow: ['read_file'] }), model, new ToolRegistry().register(fakeTool('read_file')));
    const result = await runner.run(makeSubAgent(), 'find the answer');

    assert.equal(result.summary, 'The answer is 42.');
    assert.equal(result.summary.includes('internal exploration'), false);
    assert.equal(result.usage.inputTokens, 900, 'the child’s cost is still attributed');
  });
});

describe('the delegate tool', () => {
  const context = {
    sessionId: 'sn_test',
    workspaceId: 'ws_test',
    turn: 1,
    workDir: '/tmp',
    signal: new AbortController().signal,
    emit: () => {},
  } as ToolContext;

  test('runs the named sub-agent and returns its summary', async () => {
    const model = new ScriptedModel([
      [
        { type: 'text', text: 'Researched: the service uses Postgres.' },
        { type: 'done', stopReason: 'end_turn', usage: ZERO },
      ],
    ]);
    const runner = makeRunner(policy({ allow: ['read_file'] }), model, new ToolRegistry().register(fakeTool('read_file')));
    const tool = createDelegateTool({ runner, subAgents: [makeSubAgent()] });

    const result = await tool.execute(
      { agent: 'researcher', task: 'What database does it use?' },
      context,
    );
    assert.equal(result.output, 'Researched: the service uses Postgres.');
  });

  test('lists the available sub-agents when asked for an unknown one', async () => {
    const runner = makeRunner(policy(), new ScriptedModel([]), new ToolRegistry());
    const tool = createDelegateTool({ runner, subAgents: [makeSubAgent({ name: 'researcher' })] });

    const result = await tool.execute({ agent: 'nonexistent', task: 'do it' }, context);
    assert.equal(result.isError, true);
    assert.ok(result.output.includes('researcher'), 'name the real ones rather than just refusing');
  });

  test('requires a task', async () => {
    const runner = makeRunner(policy(), new ScriptedModel([]), new ToolRegistry());
    const tool = createDelegateTool({ runner, subAgents: [makeSubAgent()] });

    const result = await tool.execute({ agent: 'researcher', task: '   ' }, context);
    assert.equal(result.isError, true);
  });

  test('says so when a child stopped early rather than finishing', async () => {
    // "Finished" and "hit its turn limit" deserve different responses.
    const loop: ModelChunk[] = [
      { type: 'tool_call', call: { id: 'c', name: 'read_file', arguments: {} } },
      { type: 'done', stopReason: 'tool_use', usage: ZERO },
    ];
    const model = new ScriptedModel(Array.from({ length: 20 }, () => [...loop]));
    const runner = makeRunner(
      policy({ allow: ['read_file'] }),
      model,
      new ToolRegistry().register(fakeTool('read_file')),
    );
    const tool = createDelegateTool({
      runner,
      subAgents: [makeSubAgent({ tools: ['read_file'], maxTurns: 3 })],
    });

    const result = await tool.execute({ agent: 'researcher', task: 'loop forever' }, context);
    assert.ok(
      result.output.startsWith('[researcher stopped:'),
      'a child that ran out of room must not look like one that finished',
    );
  });

  test('advertises the sub-agents it can reach', () => {
    const runner = makeRunner(policy(), new ScriptedModel([]), new ToolRegistry());
    const tool = createDelegateTool({
      runner,
      subAgents: [makeSubAgent({ name: 'researcher' }), makeSubAgent({ name: 'reviewer' })],
    });

    assert.ok(tool.description.includes('researcher'));
    assert.ok(tool.description.includes('reviewer'));
    const parameters = tool.parameters as { properties: { agent: { enum: string[] } } };
    assert.deepEqual(parameters.properties.agent.enum, ['researcher', 'reviewer']);
  });

  test('says plainly when none are configured', () => {
    const runner = makeRunner(policy(), new ScriptedModel([]), new ToolRegistry());
    const tool = createDelegateTool({ runner, subAgents: [] });
    assert.ok(tool.description.includes('No sub-agents'));
  });
});

describe('delegation depth', () => {
  /** A sub-agent definition with no tool narrowing, so only depth is under test. */
  function child(): SubAgent {
    return {
      name: 'child',
      description: 'a delegate',
      systemPrompt: 'you are a delegate',
      tools: [],
      maxTurns: 2,
    };
  }

  const answers = () => [[{ type: 'text' as const, text: 'done' }, { type: 'done' as const, stopReason: 'end_turn' as const, usage: ZERO }]];

  test('a sub-agent cannot delegate further', async () => {
    // Without a depth cap this is a fork bomb: each level spawns the next, and
    // nothing in the permission engine says no, because delegating is exactly
    // what the parent was allowed to do.
    const tools = new ToolRegistry().registerAll([fakeTool('read_file')]);
    const runner = makeRunner(
      policy({ allow: ['read_file', 'delegate'] }),
      new ScriptedModel(answers()),
      tools,
      silentEvents(),
      MAX_DELEGATION_DEPTH,
    );

    const error = await runner.run(child(), 'go deeper').then(
      () => undefined,
      (caught: unknown) => caught,
    );

    assert.ok(error instanceof MaError, 'delegation past the cap must fail');
    assert.equal(error.code, 'DELEGATION_TOO_DEEP');
  });

  test('delegation within the cap still works', async () => {
    // The counterpart: a cap that blocked the first level would pass the test
    // above while breaking the feature entirely.
    const tools = new ToolRegistry().registerAll([fakeTool('read_file')]);
    const runner = makeRunner(
      policy({ allow: ['read_file'] }),
      new ScriptedModel(answers()),
      tools,
      silentEvents(),
      0,
    );

    const result = await runner.run(child(), 'do the thing');
    assert.match(result.summary, /done/);
  });

  test('the delegate tool is withheld from a sub-agent', async () => {
    // Belt and braces: the depth counter stops runaway recursion, but a child
    // should not even see the tool, so it never plans around having one.
    const tools = new ToolRegistry().registerAll([
      fakeTool('read_file'),
      fakeTool('delegate'),
    ]);
    const model = new ScriptedModel(answers());
    const runner = makeRunner(policy({ allow: ['read_file', 'delegate'] }), model, tools);

    await runner.run(child(), 'work');

    const offered = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
    assert.ok(!offered.includes('delegate'), `delegate must not be offered: ${offered.join(', ')}`);
    assert.ok(offered.includes('read_file'), 'other permitted tools remain available');
  });
});
