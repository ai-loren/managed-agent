import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_PAYLOADS,
  EVENT_TYPES,
  agentVersionSchema,
  connectorMachine,
  documentMachine,
  isTransientEvent,
  matchesEventFilter,
  parse,
  receiptMachine,
  sandboxMachine,
  sessionMachine,
  submitEventsSchema,
  universalEventSchema,
  validateEventPayload,
  workspaceSchema,
  type EventType,
} from '../src/index.ts';

const NOW = 1_700_000_000_000;
const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const AG = 'ag_01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('lifecycle machines', () => {
  test('session cannot skip provisioning to run', () => {
    assert.equal(sessionMachine.canTransition('queued', 'provisioning'), true);
    assert.equal(sessionMachine.canTransition('queued', 'running'), false);
    assert.equal(sessionMachine.canTransition('provisioning', 'ready'), true);
  });

  test('session can re-provision after losing a sandbox', () => {
    // The recovery path: a lost sandbox must not fail an otherwise healthy
    // session. It returns to `queued` so it re-provisions through the queue's
    // single atomic claim, rather than jumping straight to `provisioning` with
    // no claim before the expensive provision.
    assert.equal(sessionMachine.canTransition('ready', 'queued'), true);
    assert.equal(sessionMachine.canTransition('idle', 'queued'), true);
  });

  test('session terminal states absorb', () => {
    assert.equal(sessionMachine.isTerminal('terminated'), true);
    assert.equal(sessionMachine.isTerminal('failed'), true);
    assert.equal(sessionMachine.canTransition('terminated', 'running'), false);
  });

  test('every non-terminal session state can still reach termination', () => {
    for (const status of sessionMachine.states()) {
      if (sessionMachine.isTerminal(status)) continue;
      assert.ok(
        sessionMachine.canEventuallyReach(status, 'terminated') ||
          sessionMachine.canEventuallyReach(status, 'failed'),
        `${status} must be able to reach a terminal state or it can leak a sandbox`,
      );
    }
  });

  test('archived connectors can be restored', () => {
    // The platform we studied blocked restore, forcing operators to recreate
    // connectors and lose delivery history.
    assert.equal(connectorMachine.canTransition('archived', 'draft'), true);
    assert.equal(connectorMachine.canTransition('failed', 'active'), true);
  });

  test('receipt zombie is terminal and distinct from failed', () => {
    assert.equal(receiptMachine.canTransition('working', 'zombie'), true);
    assert.equal(receiptMachine.canTransition('pending', 'zombie'), false);
    assert.equal(receiptMachine.isTerminal('zombie'), true);
  });

  test('sandbox distinguishes released from lost', () => {
    assert.equal(sandboxMachine.canTransition('ready', 'lost'), true);
    assert.equal(sandboxMachine.canTransition('ready', 'released'), false);
    assert.equal(sandboxMachine.canTransition('draining', 'released'), true);
  });

  test('a failed document can be retried but a deleted one cannot', () => {
    assert.equal(documentMachine.canTransition('failed', 'pending'), true);
    assert.equal(documentMachine.isTerminal('deleted'), true);
  });
});

describe('workspace schema', () => {
  const valid = {
    id: WS,
    name: 'Platform Team',
    slug: 'platform-team',
    status: 'active',
    quota: {},
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'pr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  };

  test('applies quota defaults so a workspace is never unbounded', () => {
    const result = parse(workspaceSchema, valid);
    assert.ok(result.ok);
    assert.equal(result.value.quota.maxConcurrentSessions, 20);
    assert.equal(result.value.quota.eventRetentionDays, 90);
  });

  test('rejects slugs that would not be URL-safe', () => {
    for (const slug of ['Has Capitals', 'has_underscore', '-leading', 'trailing-', 'a']) {
      assert.equal(parse(workspaceSchema, { ...valid, slug }).ok, false, `${slug} should be rejected`);
    }
  });
});

describe('agent version', () => {
  const base = {
    agentId: AG,
    version: 1,
    model: { modelId: 'anthropic/claude-sonnet-5' },
    tools: {},
    context: {},
    sandbox: {},
    createdAt: NOW,
    createdBy: 'pr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  };

  test('fills every execution policy with a safe default', () => {
    const result = parse(agentVersionSchema, base);
    assert.ok(result.ok);
    // Unattended agents must not default to prompting or to allow-all.
    assert.equal(result.value.tools.mode, 'strict');
    assert.equal(result.value.sandbox.network.egress, 'allowlist');
    assert.equal(result.value.sandbox.allowReuse, true);
    assert.ok(result.value.context.compactTargetTokens < result.value.context.compactThresholdTokens);
  });

  test('rejects a compaction target at or above the threshold', () => {
    // Otherwise compaction would loop forever without reducing the context.
    const result = parse(agentVersionSchema, {
      ...base,
      context: { compactThresholdTokens: 10_000, compactTargetTokens: 10_000 },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues[0]?.message.includes('compactTargetTokens'));
  });

  test('rejects duplicate capability names', () => {
    const digest = 'a'.repeat(64);
    const result = parse(agentVersionSchema, {
      ...base,
      skills: [
        { name: 'review', source: 'registry', digest },
        { name: 'review', source: 'git', digest },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues[0]?.message.includes('duplicate'));
  });

  test('requires a command for stdio MCP servers and a url for the rest', () => {
    const stdio = parse(agentVersionSchema, {
      ...base,
      mcpServers: [{ name: 'fs', transport: 'stdio' }],
    });
    assert.equal(stdio.ok, false);
    assert.ok(!stdio.ok && stdio.issues[0]?.message.includes('requires a command'));

    const http = parse(agentVersionSchema, {
      ...base,
      mcpServers: [{ name: 'api', transport: 'http' }],
    });
    assert.equal(http.ok, false);
    assert.ok(!http.ok && http.issues[0]?.message.includes('requires a url'));

    const good = parse(agentVersionSchema, {
      ...base,
      mcpServers: [{ name: 'fs', transport: 'stdio', command: '/usr/bin/mcp-fs' }],
    });
    assert.equal(good.ok, true);
  });

  test('requires a content digest on every capability', () => {
    // Without a digest a version is not reproducible.
    const result = parse(agentVersionSchema, {
      ...base,
      skills: [{ name: 'review', source: 'git', repo: 'org/repo', ref: 'main' }],
    });
    assert.equal(result.ok, false);
  });
});

describe('event taxonomy', () => {
  test('every declared event type has a payload schema', () => {
    for (const type of EVENT_TYPES) {
      assert.ok(EVENT_PAYLOADS[type], `${type} is missing a payload schema`);
    }
    assert.equal(Object.keys(EVENT_PAYLOADS).length, EVENT_TYPES.length);
  });

  test('validates a payload against its own type', () => {
    const good = validateEventPayload('turn.completed', {
      turn: 1,
      reason: 'completed',
      durationMs: 1500,
      usage: {},
    });
    assert.equal(good.ok, true);

    const bad = validateEventPayload('turn.completed', { turn: 1, reason: 'exploded' });
    assert.equal(bad.ok, false);
  });

  test('rejects an unknown event type rather than passing it through', () => {
    // Payloads arrive from sandboxes and are untrusted.
    const result = validateEventPayload('tool.injected' as EventType, {});
    assert.equal(result.ok, false);
  });

  test('marks stream control events as transient', () => {
    assert.equal(isTransientEvent('stream.lagged'), true);
    assert.equal(isTransientEvent('stream.heartbeat'), true);
    assert.equal(isTransientEvent('turn.completed'), false);
  });

  test('filters match exact types and namespace prefixes', () => {
    assert.equal(matchesEventFilter('tool.started', ['tool.']), true);
    assert.equal(matchesEventFilter('turn.started', ['tool.']), false);
    assert.equal(matchesEventFilter('turn.started', ['turn.started']), true);
    assert.equal(matchesEventFilter('anything', []), true, 'no filter means everything');
  });
});

describe('ingress events', () => {
  test('accepts each member of the closed union', () => {
    const cases = [
      { type: 'user.message', text: 'hello' },
      { type: 'user.interrupt' },
      { type: 'user.tool_decision', toolCallId: 'call_1', decision: 'deny' },
      { type: 'control.compact' },
      { type: 'control.snapshot' },
      { type: 'control.terminate' },
    ];
    for (const value of cases) {
      assert.equal(parse(universalEventSchema, value).ok, true, `${value.type} should parse`);
    }
  });

  test('rejects an event type outside the union', () => {
    // The ingress surface is deliberately closed; anything else is an attack
    // surface or a client bug.
    const result = parse(universalEventSchema, { type: 'tool.completed', toolCallId: 'x' });
    assert.equal(result.ok, false);
  });

  test('rejects an empty user message', () => {
    assert.equal(parse(universalEventSchema, { type: 'user.message', text: '' }).ok, false);
  });

  test('bounds a submission batch', () => {
    const one = { type: 'user.message', text: 'hi' };
    assert.equal(parse(submitEventsSchema, { events: [] }).ok, false);
    assert.equal(parse(submitEventsSchema, { events: Array(51).fill(one) }).ok, false);
    assert.equal(parse(submitEventsSchema, { events: [one] }).ok, true);
  });

  test('accepts an idempotency key of usable length', () => {
    const result = parse(submitEventsSchema, {
      events: [{ type: 'user.message', text: 'hi' }],
      idempotencyKey: 'retry-key-0001',
    });
    assert.ok(result.ok);
    assert.equal(result.value.idempotencyKey, 'retry-key-0001');
    // Too short to be collision-resistant.
    assert.equal(
      parse(submitEventsSchema, { events: [{ type: 'user.message', text: 'x' }], idempotencyKey: 'ab' }).ok,
      false,
    );
  });
});
