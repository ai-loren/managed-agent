import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeEnv, reservedKeys, mergeEnvVars, isPlainObject } from '../src/index.ts';

describe('env trust helpers', () => {
  test('sanitizeEnv strips reserved keys, keeps the rest', () => {
    const env = {
      PROJECT: 'ok',
      MA_RUNTIME_TOKEN: 'stolen', // ours
      PATH: '/evil', // shadows the platform PATH
      LD_PRELOAD: '/x.so', // loader code execution
      NODE_OPTIONS: '--require /x', // loader code execution
      HTTP_PROXY: 'http://attacker', // egress redirect
      no_proxy: '', // egress hole, lowercase
    };
    assert.deepEqual(sanitizeEnv(env), { PROJECT: 'ok' }, 'only the safe key survives');
  });

  test('reservedKeys reports exactly what sanitizeEnv would remove', () => {
    const env = { PROJECT: 'ok', MA_X: '1', FTP_PROXY: 'p', HOME: '/h' };
    assert.deepEqual(reservedKeys(env).sort(), ['FTP_PROXY', 'HOME', 'MA_X'].sort());
  });

  test('mergeEnvVars copies keys as inert own data, resisting prototype pollution', () => {
    const env: Record<string, string> = {};
    // A malicious env_vars credential value, already parsed.
    const parsed = JSON.parse('{"GOOD":"v","__proto__":{"polluted":"yes"}}') as Record<string, string>;
    mergeEnvVars(env, parsed);

    assert.equal(env.GOOD, 'v', 'a legitimate key is merged');
    // The object-valued __proto__ must NOT reparent env: against an
    // Object.assign build, env.polluted would inherit 'yes'.
    assert.equal((env as Record<string, unknown>).polluted, undefined, 'no inherited pollution');
    assert.ok(Object.hasOwn(env, '__proto__'), '__proto__ stays an inert own key');
    assert.equal(
      ({} as Record<string, unknown>).polluted,
      undefined,
      'Object.prototype must not be polluted',
    );
  });

  test('mergeEnvVars output remains safe to sanitize (own-enumerable only)', () => {
    const env: Record<string, string> = {};
    mergeEnvVars(env, { OK: 'keep', MA_SNEAK: 'drop' });
    assert.deepEqual(sanitizeEnv(env), { OK: 'keep' }, 'sanitizeEnv still strips a reserved merged key');
  });

  test('isPlainObject accepts only a non-null, non-array object', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject([1, 2]), false);
    assert.equal(isPlainObject('str'), false);
    assert.equal(isPlainObject(123), false);
    assert.equal(isPlainObject(true), false);
    assert.equal(isPlainObject(undefined), false);
  });

  test('mergeEnvVars ignores a non-object without throwing (defense in depth)', () => {
    // Object.entries(null) throws TypeError; a string spreads as numeric keys.
    // mergeEnvVars must no-op on any non-object so a caller that forgot to
    // shape-check cannot crash. (JSON.parse produces these from valid JSON.)
    const env: Record<string, string> = { KEEP: 'v' };
    for (const bad of [null, 'a string', 123, true, ['x', 'y']] as unknown as Record<string, string>[]) {
      mergeEnvVars(env, bad);
    }
    assert.deepEqual(env, { KEEP: 'v' }, 'no numeric-keyed garbage, no crash, existing keys intact');
  });
});
