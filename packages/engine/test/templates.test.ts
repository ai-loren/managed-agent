/**
 * Agent template tests.
 *
 * Two things carry the weight here and get the most attention:
 *
 *  1. **Substitution** — a template is only useful if `{{variable}}` resolves
 *     correctly, preserves type for a sole placeholder, and never lets an
 *     unresolved placeholder reach a spec.
 *  2. **The trust boundaries** — a built-in is read-only, and instantiation is
 *     agent creation with the same authorization, not a way around it.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, TestClock, newId, nullLogger } from '@ma/core';
import type { Principal } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  AgentService,
  QuotaService,
  RoleAuthorizer,
  TemplateService,
  WorkspaceService,
  resolveVariables,
  substitute,
  type AuthContext,
} from '../src/index.ts';

const START = 1_700_000_000_000;

let store: SqliteStore;
let clock: TestClock;
let templates: TemplateService;
let agents: AgentService;
let workspaces: WorkspaceService;
let context: AuthContext;
let principal: Principal;
let workspaceId: string;

function deps() {
  return {
    store,
    clock,
    logger: nullLogger,
    authorizer: new RoleAuthorizer(),
    quota: new QuotaService(store, clock),
  };
}

beforeEach(async () => {
  store = createMemoryStore();
  clock = new TestClock(START);

  principal = await store.principals.create({
    id: newId('principal'),
    type: 'user',
    subject: 'operator',
    displayName: 'Operator',
    email: '',
    isAdmin: true,
    disabled: false,
    metadata: {},
    createdAt: START,
    updatedAt: START,
    createdBy: 'system',
  });
  context = { principal } as AuthContext;

  templates = new TemplateService(deps());
  agents = new AgentService(deps());
  workspaces = new WorkspaceService(deps());

  const workspace = await workspaces.create(context, { name: 'Team', slug: 'template-test' });
  workspaceId = workspace.id;
});

afterEach(async () => {
  await store.close();
});

describe('substitution', () => {
  test('a sole placeholder preserves the variable type', () => {
    const values = new Map<string, unknown>([
      ['count', 5],
      ['flag', true],
      ['name', 'Ada'],
    ]);
    assert.equal(substitute('{{count}}', values), 5, 'a number stays a number');
    assert.equal(substitute('{{flag}}', values), true, 'a boolean stays a boolean');
    assert.equal(substitute('{{name}}', values), 'Ada');
  });

  test('an embedded placeholder splices as text', () => {
    const values = new Map<string, unknown>([['name', 'Ada']]);
    assert.equal(substitute('Hello, {{name}}!', values), 'Hello, Ada!');
    assert.equal(substitute('{{name}} and {{name}}', values), 'Ada and Ada');
  });

  test('walks nested objects and arrays, and object keys', () => {
    const values = new Map<string, unknown>([
      ['prompt', 'be helpful'],
      ['field', 'systemPrompt'],
    ]);
    const result = substitute(
      { '{{field}}': '{{prompt}}', list: ['{{prompt}}', 'literal'] },
      values,
    ) as Record<string, unknown>;
    assert.equal(result.systemPrompt, 'be helpful', 'a variable can name a field');
    assert.deepEqual(result.list, ['be helpful', 'literal']);
  });

  test('an unknown placeholder is left verbatim, not blanked', () => {
    // A stray {{typo}} should surface as a visible, debuggable string rather
    // than silently vanishing into an empty field.
    const values = new Map<string, unknown>([['known', 'x']]);
    assert.equal(substitute('{{typo}}', values), '{{typo}}');
    assert.equal(substitute('a {{typo}} b', values), 'a {{typo}} b');
  });

  test('tolerates whitespace inside the braces', () => {
    const values = new Map<string, unknown>([['x', 'ok']]);
    assert.equal(substitute('{{ x }}', values), 'ok');
  });
});

describe('variable resolution', () => {
  const declare = (over: Record<string, unknown>) => ({
    key: 'v',
    label: '',
    description: '',
    type: 'string' as const,
    required: false,
    options: [] as string[],
    ...over,
  });

  test('a required variable with no value is rejected', () => {
    assert.throws(
      () => resolveVariables([declare({ key: 'model', required: true })], {}),
      (error: unknown) => MaError.is(error) && /required/.test(error.message),
    );
  });

  test('an optional variable falls back to its default', () => {
    const resolved = resolveVariables([declare({ key: 'tone', default: 'formal' })], {});
    assert.equal(resolved.get('tone'), 'formal');
  });

  test('an optional variable with neither value nor default becomes empty', () => {
    const resolved = resolveVariables([declare({ key: 'note' })], {});
    assert.equal(resolved.get('note'), '', 'an unset placeholder never survives into the spec');
  });

  test('an enum value outside its options is rejected', () => {
    const variable = declare({ key: 'size', type: 'enum', options: ['s', 'm', 'l'] });
    assert.throws(
      () => resolveVariables([variable], { size: 'xl' }),
      (error: unknown) => MaError.is(error) && /one of/.test(error.message),
    );
    assert.equal(resolveVariables([variable], { size: 'm' }).get('size'), 'm');
  });

  test('a number variable coerces and rejects non-numbers', () => {
    const variable = declare({ key: 'n', type: 'number' });
    assert.equal(resolveVariables([variable], { n: '42' }).get('n'), 42);
    assert.throws(
      () => resolveVariables([variable], { n: 'not a number' }),
      (error: unknown) => MaError.is(error),
    );
  });
});

describe('catalogue', () => {
  test('lists a workspace’s own templates alongside built-ins', async () => {
    await templates.seedBuiltins([
      {
        name: 'Coder',
        category: 'coding',
        spec: { systemPrompt: 'You write code', model: { modelId: 'm' } },
      },
    ]);
    await templates.create(context, workspaceId, {
      name: 'Our Assistant',
      spec: { systemPrompt: 'x', model: { modelId: 'm' } },
    });

    const page = await templates.list(context, workspaceId);
    const names = page.items.map((template) => template.name).sort();
    assert.deepEqual(names, ['Coder', 'Our Assistant']);
    assert.ok(
      page.items.find((template) => template.name === 'Coder')?.builtin,
      'the built-in is marked as such',
    );
  });

  test('re-seeding a built-in refreshes in place rather than duplicating', async () => {
    await templates.seedBuiltins([
      { name: 'Coder', spec: { systemPrompt: 'v1', model: { modelId: 'm' } } },
    ]);
    await templates.seedBuiltins([
      { name: 'Coder', spec: { systemPrompt: 'v2', model: { modelId: 'm' } } },
    ]);

    const page = await templates.list(context, workspaceId);
    const coders = page.items.filter((template) => template.name === 'Coder');
    assert.equal(coders.length, 1, 'a re-seed does not accumulate copies');
    assert.equal((coders[0]?.spec as { systemPrompt: string }).systemPrompt, 'v2');
  });
});

describe('built-ins are read-only', () => {
  test('a built-in cannot be updated or deleted through the API', async () => {
    await templates.seedBuiltins([
      { name: 'Coder', spec: { systemPrompt: 'x', model: { modelId: 'm' } } },
    ]);
    const page = await templates.list(context, workspaceId);
    const builtin = page.items.find((template) => template.name === 'Coder')!;

    await assert.rejects(
      templates.update(context, builtin.id, { description: 'hijacked' }),
      (error: unknown) => MaError.is(error) && error.status === 409,
    );
    await assert.rejects(
      templates.delete(context, builtin.id),
      (error: unknown) => MaError.is(error) && error.status === 409,
    );
  });
});

describe('instantiate', () => {
  test('builds an agent with the variables substituted into the spec', async () => {
    const template = await templates.create(context, workspaceId, {
      name: 'Reviewer',
      spec: {
        systemPrompt: 'You review {{language}} code with a {{tone}} tone',
        model: { modelId: 'm' },
        maxTurnsPerSession: '{{turns}}',
      },
      variables: [
        { key: 'language', label: '', description: '', type: 'string', required: true, options: [] },
        { key: 'tone', label: '', description: '', type: 'string', required: false, options: [], default: 'kind' },
        { key: 'turns', label: '', description: '', type: 'number', required: false, options: [], default: 50 },
      ],
    });

    const agent = await templates.instantiate(context, template.id, {
      workspaceId,
      variables: { language: 'Rust' },
    });

    const version = await store.agentVersions.get(agent.id, agent.latestVersion);
    assert.match(version!.systemPrompt, /review Rust code with a kind tone/);
    assert.equal(
      version!.maxTurnsPerSession,
      50,
      'a sole numeric placeholder fills a numeric field as a number',
    );
  });

  test('a missing required variable is rejected before an agent is created', async () => {
    const template = await templates.create(context, workspaceId, {
      name: 'Reviewer',
      spec: { systemPrompt: 'review {{language}}', model: { modelId: 'm' } },
      variables: [
        { key: 'language', label: '', description: '', type: 'string', required: true, options: [] },
      ],
    });

    const before = (await agents.list(context, workspaceId, {})).items.length;
    await assert.rejects(
      templates.instantiate(context, template.id, { workspaceId, variables: {} }),
      (error: unknown) => MaError.is(error) && /required/.test(error.message),
    );
    const after = (await agents.list(context, workspaceId, {})).items.length;
    assert.equal(after, before, 'no agent is created when a required variable is missing');
  });

  test('a built-in instantiates into any workspace', async () => {
    await templates.seedBuiltins([
      {
        name: 'Coder',
        spec: { systemPrompt: 'You write {{language}}', model: { modelId: 'm' } },
        variables: [
          { key: 'language', label: '', description: '', type: 'string', required: true, options: [] },
        ],
      },
    ]);
    const builtin = (await templates.list(context, workspaceId)).items.find(
      (template) => template.name === 'Coder',
    )!;

    const agent = await templates.instantiate(context, builtin.id, {
      workspaceId,
      agentName: 'Go Writer',
      variables: { language: 'Go' },
    });
    assert.equal(agent.name, 'Go Writer');
    const version = await store.agentVersions.get(agent.id, agent.latestVersion);
    assert.match(version!.systemPrompt, /write Go/);
  });
});

describe('authorization', () => {
  test('a viewer can read the catalogue but not author a template', async () => {
    const viewer = await store.principals.create({
      id: newId('principal'),
      type: 'user',
      subject: 'viewer',
      displayName: 'Viewer',
      email: '',
      isAdmin: false,
      disabled: false,
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'system',
    });
    await store.workspaces.update(workspaceId, {
      members: [
        { principalId: principal.id, role: 'owner', addedAt: START },
        { principalId: viewer.id, role: 'viewer', addedAt: START },
      ],
      updatedAt: START,
    });
    const asViewer = { principal: viewer } as AuthContext;

    await templates.create(context, workspaceId, {
      name: 'Readable',
      spec: { systemPrompt: 'x', model: { modelId: 'm' } },
    });
    assert.equal((await templates.list(asViewer, workspaceId)).items.length, 1);

    await assert.rejects(
      templates.create(asViewer, workspaceId, {
        name: 'Nope',
        spec: { systemPrompt: 'x', model: { modelId: 'm' } },
      }),
      (error: unknown) => MaError.is(error) && error.status === 403,
    );
  });
});
