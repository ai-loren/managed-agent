import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVENT_PAYLOADS,
  EVENT_TYPES,
  agentVersionSchema,
  connectorMachine,
  documentMachine,
  eventQuerySchema,
  idpConfigSchema,
  isSecureOrLoopbackUrl,
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
    // A sandbox lost *mid-turn* (running) recovers too: the session re-queues
    // from its last turn-boundary snapshot and the interrupted turn is closed
    // with a synthetic `turn.failed`. Without this edge one crash failed the
    // whole conversation.
    assert.equal(sessionMachine.canTransition('running', 'queued'), true);
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
    assert.equal(result.value.quota.maxKnowledgeChunks, 100_000);
    assert.equal(result.value.quota.eventRetentionDays, 90);
  });

  test('defaults the optimistic-concurrency version to 1', () => {
    // The monotonic version backing If-Match on member updates. A freshly created
    // workspace (and any row written before the column existed) reads as version 1.
    const result = parse(workspaceSchema, valid);
    assert.ok(result.ok);
    assert.equal(result.value.version, 1);
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
    // Reuse is opt-in: sharing a warm process across sessions is safe only after
    // a full context reset, so an agent must ask for it rather than get it by
    // default. The isolation-first default keeps a reset bug's blast radius to
    // agents that opted in.
    assert.equal(result.value.sandbox.allowReuse, false);
    assert.ok(result.value.context.compactTargetTokens < result.value.context.compactThresholdTokens);
  });

  test('defaults to the built-in runtime', () => {
    // Every existing agent runs the platform's own harness; a command runtime is
    // strictly opt-in.
    const result = parse(agentVersionSchema, base);
    assert.ok(result.ok);
    assert.equal(result.value.runtime.type, 'builtin');
  });

  test('accepts a command runtime and requires its command', () => {
    const ok = parse(agentVersionSchema, {
      ...base,
      runtime: { type: 'command', command: 'python3', args: ['agent.py'] },
    });
    assert.ok(ok.ok);
    assert.equal(ok.value.runtime.type, 'command');
    if (ok.value.runtime.type === 'command') {
      assert.equal(ok.value.runtime.command, 'python3');
      assert.deepEqual(ok.value.runtime.args, ['agent.py']);
    }

    // A command runtime with no command is a misconfiguration, caught at parse.
    const bad = parse(agentVersionSchema, { ...base, runtime: { type: 'command' } });
    assert.equal(bad.ok, false);

    // An unknown runtime type is rejected rather than silently treated as builtin.
    const unknownType = parse(agentVersionSchema, { ...base, runtime: { type: 'wasm' } });
    assert.equal(unknownType.ok, false);
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

describe('sandbox mounts', () => {
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

  test('defaults to no mounts', () => {
    // An existing agent declares nothing; mounts must be an opt-in empty list so
    // every version already in the store keeps its ephemeral-only posture.
    const result = parse(agentVersionSchema, base);
    assert.ok(result.ok);
    assert.deepEqual(result.value.sandbox.mounts, []);
  });

  test('accepts a named volume and defaults it to read-only', () => {
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: { mounts: [{ name: 'cache', target: '/data' }] },
    });
    assert.ok(result.ok);
    assert.equal(result.value.sandbox.mounts.length, 1);
    const mount = result.value.sandbox.mounts[0]!;
    assert.equal(mount.name, 'cache');
    assert.equal(mount.target, '/data');
    // Read-only by default: a mount that persists across sessions is a writable
    // surface only when the version deliberately asks for one.
    assert.equal(mount.readOnly, true);
  });

  test('accepts an explicitly writable mount', () => {
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: { mounts: [{ name: 'work', target: '/work', readOnly: false }] },
    });
    assert.ok(result.ok);
    assert.equal(result.value.sandbox.mounts[0]!.readOnly, false);
  });

  test('rejects a relative target', () => {
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: { mounts: [{ name: 'cache', target: 'data' }] },
    });
    assert.equal(result.ok, false);
  });

  test('rejects a target containing ..', () => {
    // Defence in depth: the driver confines the source, but a traversal in the
    // target is a misconfiguration caught at parse rather than trusted downstream.
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: { mounts: [{ name: 'cache', target: '/data/../etc' }] },
    });
    assert.equal(result.ok, false);
  });

  test('rejects mounting over /, /workspace or /tmp', () => {
    for (const target of ['/', '/workspace', '/tmp', '/workspace/']) {
      const result = parse(agentVersionSchema, {
        ...base,
        sandbox: { mounts: [{ name: 'cache', target }] },
      });
      assert.equal(result.ok, false, `${target} must be refused as a mount target`);
    }
  });

  test('rejects a volume name that is not a single path segment', () => {
    for (const name of ['../escape', 'a/b', '', '.hidden', 'has space']) {
      const result = parse(agentVersionSchema, {
        ...base,
        sandbox: { mounts: [{ name, target: '/data' }] },
      });
      assert.equal(result.ok, false, `${JSON.stringify(name)} must be refused as a volume name`);
    }
  });

  test('rejects two mounts at the same target', () => {
    // A duplicate destination is a misconfiguration that would otherwise surface
    // as a confusing driver-level failure; caught at parse instead. `/data` and
    // `/data/` are the same destination.
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: {
        mounts: [
          { name: 'a', target: '/data' },
          { name: 'b', target: '/data/' },
        ],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues[0]?.message.includes('target'));
  });

  test('rejects two mounts with the same name', () => {
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: {
        mounts: [
          { name: 'cache', target: '/data' },
          { name: 'cache', target: '/other' },
        ],
      },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues[0]?.message.includes('name'));
  });
});

describe('sandbox runAs (service-account identity)', () => {
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

  test('defaults to no identity', () => {
    // An existing agent declares nothing; runAs must default to '' so every
    // version already in the store keeps the platform's identity-less posture.
    const result = parse(agentVersionSchema, base);
    assert.ok(result.ok);
    assert.equal(result.value.sandbox.runAs, '');
  });

  test('accepts a valid DNS-1123 label', () => {
    const result = parse(agentVersionSchema, {
      ...base,
      sandbox: { runAs: 's3-reader' },
    });
    assert.ok(result.ok);
    assert.equal(result.value.sandbox.runAs, 's3-reader');
  });

  test('rejects a value that is not a single DNS-1123 label', () => {
    // The driver prefixes this with the workspace id to form a ServiceAccount
    // name, so it must be one clean label — not a path, not upper-case, not a
    // value with a namespace separator that could be read as another SA.
    for (const runAs of [
      'Foo',
      'foo_bar',
      '-lead',
      'trail-',
      'has space',
      'ns/sa',
      'default:admin',
      'a'.repeat(64),
    ]) {
      const result = parse(agentVersionSchema, { ...base, sandbox: { runAs } });
      assert.equal(result.ok, false, `${JSON.stringify(runAs)} must be refused as runAs`);
    }
  });
});

describe('idp config (SSO)', () => {
  const base = {
    providerId: 'okta',
    issuer: 'https://idp.example.com',
    clientId: 'client-abc',
    redirectUri: 'https://console.example.com/auth/v1/okta/callback',
  };

  test('fills OIDC-standard claim defaults', () => {
    const result = parse(idpConfigSchema, base);
    assert.ok(result.ok);
    assert.equal(result.value.subjectClaim, 'sub');
    assert.equal(result.value.emailClaim, 'email');
    assert.equal(result.value.nameClaim, 'name');
    assert.equal(result.value.groupsClaim, 'groups');
    assert.deepEqual(result.value.scopes, ['openid', 'profile', 'email']);
    // Auto-provisioning is the point of SSO, so it defaults on; admin is never
    // conferred, and there is no domain gate by default (a single-tenant IdP).
    assert.equal(result.value.autoCreatePrincipals, true);
    assert.deepEqual(result.value.groupRoleMappings, []);
    assert.deepEqual(result.value.allowedEmailDomains, []);
  });

  test('rejects an http issuer but allows loopback http for dev', () => {
    // A network attacker can serve a forged discovery/JWKS over plain http, so a
    // public issuer must be https; loopback has no network to attack.
    assert.equal(parse(idpConfigSchema, { ...base, issuer: 'http://idp.example.com' }).ok, false);
    assert.equal(parse(idpConfigSchema, { ...base, issuer: 'https://idp.example.com' }).ok, true);
    assert.equal(parse(idpConfigSchema, { ...base, issuer: 'http://localhost:8080' }).ok, true);
    assert.equal(parse(idpConfigSchema, { ...base, issuer: 'http://127.0.0.1:8080' }).ok, true);
  });

  test('rejects a provider id that is not a url-safe slug', () => {
    for (const providerId of ['Okta', 'my provider', 'a/b', '', 'has_underscore_ok?']) {
      const result = parse(idpConfigSchema, { ...base, providerId });
      assert.equal(result.ok, false, `${JSON.stringify(providerId)} must be refused as a provider id`);
    }
  });

  test('validates a group→role mapping', () => {
    const ok = parse(idpConfigSchema, {
      ...base,
      groupRoleMappings: [
        { group: 'eng', workspaceId: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV', role: 'developer' },
      ],
    });
    assert.ok(ok.ok);
    assert.equal(ok.value.groupRoleMappings[0]!.role, 'developer');

    // A bad role or a non-workspace id is refused.
    assert.equal(
      parse(idpConfigSchema, {
        ...base,
        groupRoleMappings: [{ group: 'eng', workspaceId: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV', role: 'superuser' }],
      }).ok,
      false,
    );
    assert.equal(
      parse(idpConfigSchema, {
        ...base,
        groupRoleMappings: [{ group: 'eng', workspaceId: 'not-a-workspace', role: 'developer' }],
      }).ok,
      false,
    );
  });

  test('bounds the session TTL', () => {
    assert.equal(parse(idpConfigSchema, { ...base, sessionTtlSeconds: 30 }).ok, false, 'too short');
    assert.equal(parse(idpConfigSchema, { ...base, sessionTtlSeconds: 3600 }).ok, true);
  });

  test('isSecureOrLoopbackUrl rejects loopback-lookalike hosts', () => {
    // The check must inspect the real host, not match the raw string.
    assert.equal(isSecureOrLoopbackUrl('http://127.0.0.1.evil.com'), false);
    assert.equal(isSecureOrLoopbackUrl('http://localhost.evil.com'), false);
    assert.equal(isSecureOrLoopbackUrl('http://127.0.0.1'), true);
    assert.equal(isSecureOrLoopbackUrl('https://anything.example.com'), true);
  });

  test('isSecureOrLoopbackUrl rejects the userinfo bypass (real host is elsewhere)', () => {
    // `http://127.0.0.1:1@evil.com` looks loopback but its real host is evil.com;
    // a substring/regex check accepts it, a URL-parsing check must not. This was
    // an SSRF + plaintext-secret-leak vector when it gated the OIDC endpoints.
    assert.equal(isSecureOrLoopbackUrl('http://127.0.0.1:1@evil.com/jwks'), false);
    assert.equal(isSecureOrLoopbackUrl('http://localhost:@evil.com'), false);
    assert.equal(isSecureOrLoopbackUrl('http://127.0.0.1:80@169.254.169.254/latest/meta-data/'), false);
    // Userinfo is rejected even on an otherwise-legitimate https host.
    assert.equal(isSecureOrLoopbackUrl('https://user:pass@idp.example.com'), false);
    // A garbage string is not a URL, so it is refused rather than throwing.
    assert.equal(isSecureOrLoopbackUrl('not a url'), false);
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

describe('event query (searchable run logs)', () => {
  test('accepts a text query and a time-range window', () => {
    const result = parse(eventQuerySchema, { q: 'login failed', fromTs: 1000, toTs: 2000 });
    assert.ok(result.ok);
    assert.equal(result.value.q, 'login failed');
    assert.equal(result.value.fromTs, 1000);
    assert.equal(result.value.toTs, 2000);
  });

  test('leaves the search/time fields absent when not supplied (optional, no default)', () => {
    // optional() not withDefault(): an absent q must stay undefined so callers can
    // distinguish "no search" from "search for empty", and so existing query
    // literals are unaffected.
    const result = parse(eventQuerySchema, {});
    assert.ok(result.ok);
    assert.equal(result.value.q, undefined);
    assert.equal(result.value.fromTs, undefined);
    assert.equal(result.value.toTs, undefined);
  });

  test('bounds the query length so it cannot become an unbounded scan input', () => {
    const result = parse(eventQuerySchema, { q: 'x'.repeat(1025) });
    assert.equal(result.ok, false, 'a q over 1024 chars is rejected');
  });

  test('rejects a negative time bound', () => {
    assert.equal(parse(eventQuerySchema, { fromTs: -1 }).ok, false);
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
