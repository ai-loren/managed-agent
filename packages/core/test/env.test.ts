import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  credentialOccupiedEnvKey,
  findCredentialEnvKeyCollision,
  isPlainObject,
  mergeEnvVars,
  reservedKeys,
  sanitizeEnv,
} from '../src/index.ts';

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

  test('sanitizeEnv strips every interpreter loader-exec var, not just Node/Python', () => {
    // The denylist exists to strip anything an interpreter reads before our code
    // runs — code execution dressed as configuration. Ruby's RUBYOPT (-I/-r),
    // Perl's PERL5OPT (-M), and NODE_PATH all load code at startup, exactly like
    // NODE_OPTIONS/PYTHONPATH which were already covered.
    const env = {
      KEEP: 'ok',
      RUBYOPT: '-I/tmp -rpayload',
      PERL5OPT: '-Mevil',
      NODE_PATH: '/tmp/mods',
      NODE_OPTIONS: '--require /x', // regression: still stripped
      PYTHONPATH: '/tmp', // regression: still stripped
    };
    assert.deepEqual(sanitizeEnv(env), { KEEP: 'ok' }, 'all interpreter loader vars are stripped');
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

describe('credential env-key collision', () => {
  test('the occupied key is type-aware (value vs path)', () => {
    assert.equal(credentialOccupiedEnvKey('api_key', 'foo'), 'MA_CRED_FOO');
    assert.equal(credentialOccupiedEnvKey('bearer_token', 'foo'), 'MA_CRED_FOO');
    assert.equal(credentialOccupiedEnvKey('file', 'foo'), 'MA_CRED_FOO_FILE');
    assert.equal(credentialOccupiedEnvKey('ssh_key', 'foo'), 'MA_CRED_FOO_FILE');
    assert.equal(credentialOccupiedEnvKey('env_vars', 'foo'), undefined);
  });

  test('detects same-key credentials across owners (the owner label is not a boundary)', () => {
    const collision = findCredentialEnvKeyCollision([
      { type: 'api_key', name: 'shared-name', status: 'active' },
      { type: 'api_key', name: 'shared_name', status: 'active' },
    ]);
    assert.ok(collision);
    assert.equal(collision!.envKey, 'MA_CRED_SHARED_NAME');
  });

  test('detects a value-vs-path collision (file foo vs api_key foo_file)', () => {
    const collision = findCredentialEnvKeyCollision([
      { type: 'file', name: 'foo' },
      { type: 'api_key', name: 'foo_file' },
    ]);
    assert.ok(collision);
    assert.equal(collision!.envKey, 'MA_CRED_FOO_FILE');
  });

  test('distinct names do not collide; revoked and env_vars credentials are ignored', () => {
    assert.equal(
      findCredentialEnvKeyCollision([
        { type: 'api_key', name: 'alpha' },
        { type: 'api_key', name: 'beta' },
      ]),
      undefined,
    );
    assert.equal(
      findCredentialEnvKeyCollision([
        { type: 'api_key', name: 'token', status: 'revoked' },
        { type: 'bearer_token', name: 'token', status: 'active' },
      ]),
      undefined,
      'a revoked credential is never materialised, so it cannot collide',
    );
    assert.equal(
      findCredentialEnvKeyCollision([
        { type: 'env_vars', name: 'token' },
        { type: 'api_key', name: 'token' },
      ]),
      undefined,
      'env_vars emits no MA_CRED_ key',
    );
  });
});
