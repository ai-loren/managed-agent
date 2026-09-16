import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MaError } from '@ma/core';

import {
  array,
  boolean,
  discriminatedUnion,
  enumOf,
  id,
  integer,
  literal,
  number,
  object,
  optional,
  parse,
  parseOrThrow,
  record,
  refine,
  sha256,
  string,
  withDefault,
  type Infer,
} from '../src/schema.ts';

describe('primitives', () => {
  test('validates string constraints', () => {
    const s = string({ minLength: 2, maxLength: 5, nonBlank: true });
    assert.equal(parse(s, 'abc').ok, true);
    assert.equal(parse(s, 'a').ok, false);
    assert.equal(parse(s, 'abcdef').ok, false);
    assert.equal(parse(s, '   ').ok, false);
    assert.equal(parse(s, 42).ok, false);
  });

  test('coerces only when asked, so JSON bodies stay strict', () => {
    const n = integer({ min: 1, max: 50 });
    assert.equal(parse(n, '20').ok, false, 'a JSON body must not silently coerce');
    const coerced = parse(n, '20', { coerce: true });
    assert.equal(coerced.ok, true);
    assert.equal(coerced.ok && coerced.value, 20);
    assert.equal(parse(n, 'abc', { coerce: true }).ok, false);
    assert.equal(parse(n, '1.5', { coerce: true }).ok, false, 'still must be an integer');
  });

  test('coerces booleans from query-string forms', () => {
    const b = boolean();
    const yes = parse(b, 'true', { coerce: true });
    assert.ok(yes.ok && yes.value === true);
    const no = parse(b, '0', { coerce: true });
    assert.ok(no.ok && no.value === false);
    assert.equal(parse(b, 'yes', { coerce: true }).ok, false);
  });

  test('rejects non-finite numbers', () => {
    assert.equal(parse(number(), Number.NaN).ok, false);
    assert.equal(parse(number(), Number.POSITIVE_INFINITY).ok, false);
  });

  test('enforces enum membership', () => {
    const status = enumOf(['active', 'disabled'] as const);
    assert.equal(parse(status, 'active').ok, true);
    assert.equal(parse(status, 'archived').ok, false);
    const issues = parse(status, 'archived');
    assert.ok(!issues.ok && issues.issues[0]?.message.includes('active, disabled'));
  });

  test('validates ids and sha256 digests', () => {
    assert.equal(parse(id('session'), 'sn_01ARZ3NDEKTSV4RRFFQ69G5FAV').ok, true);
    assert.equal(parse(id('session'), 'not-an-id').ok, false);
    assert.equal(parse(sha256(), 'a'.repeat(64)).ok, true);
    assert.equal(parse(sha256(), 'A'.repeat(64)).ok, false, 'digests must be lowercase');
    assert.equal(parse(sha256(), 'a'.repeat(63)).ok, false);
  });

  test('an id of the wrong kind is rejected, not just any structural id', () => {
    // A structurally-valid id whose prefix names a *different* resource must be
    // rejected: `id('agent')` accepting a `ws_…` id let a cross-entity id flow
    // into a field typed to one resource, an authorization hazard.
    const agentBody = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    assert.equal(parse(id('agent'), `ag_${agentBody}`).ok, true, 'the right kind passes');
    const wrongKind = parse(id('agent'), `ws_${agentBody}`);
    assert.equal(wrongKind.ok, false, 'a workspace id must not pass where an agent id is required');
    assert.ok(
      !wrongKind.ok && wrongKind.issues[0]?.message.includes('agent id'),
      'the message names the required kind',
    );
    // An unknown prefix is rejected too (it maps to no kind).
    assert.equal(parse(id('agent'), `zz_${agentBody}`).ok, false, 'an unknown-kind prefix is rejected');
  });
});

describe('objects', () => {
  const Workspace = object({
    name: string({ minLength: 1, maxLength: 64 }),
    description: optional(string({ maxLength: 500 })),
    memberIds: withDefault(array(string()), () => []),
  });

  test('infers required and optional keys correctly', () => {
    type W = Infer<typeof Workspace>;
    const value: W = { name: 'team', memberIds: [] };
    assert.equal(value.name, 'team');
  });

  test('applies defaults for absent fields', () => {
    const result = parse(Workspace, { name: 'team' });
    assert.ok(result.ok);
    assert.deepEqual(result.value.memberIds, []);
    assert.equal(result.value.description, undefined);
  });

  test('reports every problem at once rather than the first', () => {
    const result = parse(Workspace, { description: 'x'.repeat(600), memberIds: 'nope' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    const paths = result.issues.map((i) => i.path).sort();
    assert.deepEqual(paths, ['description', 'memberIds', 'name']);
  });

  test('strips unknown keys by default so they never reach storage', () => {
    const result = parse(Workspace, { name: 'team', injected: 'evil' });
    assert.ok(result.ok);
    assert.equal('injected' in result.value, false);
  });

  test('strict mode rejects unknown keys', () => {
    const Strict = object({ name: string() }, { strict: true });
    const result = parse(Strict, { name: 'x', typo: 1 });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues[0]?.message.includes('not a known property'));
  });

  test('treats null like absent for optional fields', () => {
    const result = parse(Workspace, { name: 'team', description: null });
    assert.ok(result.ok);
    assert.equal(result.value.description, undefined);
  });
});

describe('prototype pollution safety', () => {
  // JSON.parse produces a real `__proto__` own-key (unlike an object literal,
  // where `__proto__:` sets the prototype), so it is how a malicious request body
  // smuggles the key past a validator. `parse` must neither drop it silently nor
  // let it mutate a prototype.
  const withProto = (json: string): unknown => JSON.parse(json);

  test('record keeps a __proto__ key as data without polluting the prototype', () => {
    const schema = record(string());
    const result = parse(schema, withProto('{"normal":"a","__proto__":"evil"}'));
    assert.ok(result.ok);
    // The key is preserved as a real own property (not silently dropped).
    assert.ok(Object.hasOwn(result.value, '__proto__'), '__proto__ must survive as an own key');
    assert.equal((result.value as Record<string, string>)['__proto__'], 'evil');
    // The prototype is intact, and nothing leaked onto Object.prototype.
    assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
    assert.equal(({} as Record<string, unknown>).evil, undefined);
  });

  test('record with an object-valued __proto__ does not replace the prototype', () => {
    const schema = record(object({ role: string() }, { passthrough: true }));
    const result = parse(schema, withProto('{"__proto__":{"role":"admin"}}'));
    assert.ok(result.ok);
    assert.equal(Object.getPrototypeOf(result.value), Object.prototype, 'prototype must not be replaced');
    assert.ok(Object.hasOwn(result.value, '__proto__'));
  });

  test('object passthrough keeps a __proto__ key as data without polluting', () => {
    const schema = object({ name: string() }, { passthrough: true });
    const result = parse(schema, withProto('{"name":"x","__proto__":{"polluted":true}}'));
    assert.ok(result.ok);
    assert.ok(Object.hasOwn(result.value, '__proto__'), '__proto__ must survive passthrough as an own key');
    assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype was polluted');
  });

  test('strict mode still rejects a __proto__ key as unknown', () => {
    // Belt-and-suspenders: a strict object without passthrough treats __proto__
    // like any other unknown key — reported, not accepted.
    const schema = object({ name: string() }, { strict: true });
    const result = parse(schema, withProto('{"name":"x","__proto__":{"a":1}}'));
    assert.equal(result.ok, false);
  });
});

describe('nested structures', () => {
  const Version = object({
    version: integer({ min: 1 }),
    skills: array(
      object({
        skillId: string({ nonBlank: true }),
        digest: sha256(),
      }),
    ),
    metadata: record(string()),
  });

  test('reports precise paths into arrays and records', () => {
    const result = parse(Version, {
      version: 1,
      skills: [
        { skillId: 'ok', digest: 'a'.repeat(64) },
        { skillId: '', digest: 'bad' },
      ],
      metadata: { key: 42 },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    const paths = result.issues.map((i) => i.path).sort();
    assert.deepEqual(paths, ['metadata.key', 'skills[1].digest', 'skills[1].skillId']);
  });
});

describe('discriminated unions', () => {
  const Event = discriminatedUnion('type', {
    'user.message': object({ type: literal('user.message'), text: string({ nonBlank: true }) }),
    'user.interrupt': object({ type: literal('user.interrupt'), reason: optional(string()) }),
  });

  test('routes to the matching variant', () => {
    const result = parse(Event, { type: 'user.message', text: 'hi' });
    assert.ok(result.ok);
    assert.equal((result.value as { text: string }).text, 'hi');
  });

  test('reports the variant error once the tag matches', () => {
    const result = parse(Event, { type: 'user.message', text: '' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.issues[0]?.path === 'text');
  });

  test('rejects an unknown tag with the list of valid ones', () => {
    const result = parse(Event, { type: 'nope' });
    assert.ok(!result.ok);
    assert.equal(result.issues[0]?.path, 'type');
    assert.ok(result.issues[0]?.message.includes('user.message'));
  });
});

describe('refinement', () => {
  const CronExpr = refine(string(), (value) =>
    value.trim().split(/\s+/).length === 5 ? true : 'must have five fields',
  );

  test('runs the predicate after the inner schema passes', () => {
    assert.equal(parse(CronExpr, '0 9 * * 1').ok, true);
    const bad = parse(CronExpr, '0 9 * *');
    assert.ok(!bad.ok && bad.issues[0]?.message === 'must have five fields');
    assert.equal(parse(CronExpr, 42).ok, false);
  });
});

describe('parseOrThrow', () => {
  test('throws a validation MaError listing every issue', () => {
    const S = object({ a: string(), b: integer() });
    assert.throws(
      () => parseOrThrow(S, { b: 'x' }),
      (error: unknown) => {
        assert.ok(MaError.is(error));
        assert.equal(error.code, 'VALIDATION_FAILED');
        assert.equal(error.status, 400);
        const issues = error.details.issues as { path: string }[];
        assert.equal(issues.length, 2);
        return true;
      },
    );
  });

  test('returns the parsed value on success', () => {
    const S = object({ a: string() });
    assert.deepEqual(parseOrThrow(S, { a: 'x' }), { a: 'x' });
  });
});

describe('json schema generation', () => {
  test('emits properties, required and enums for OpenAPI', () => {
    const S = object({
      name: string({ minLength: 1 }),
      status: enumOf(['active', 'disabled'] as const),
      count: optional(integer({ min: 0 })),
    });
    const json = S.toJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    assert.equal(json.type, 'object');
    assert.deepEqual(json.required.sort(), ['name', 'status']);
    assert.deepEqual(json.properties.status?.enum, ['active', 'disabled']);
    assert.equal(json.properties.count?.type, 'integer');
  });
});
