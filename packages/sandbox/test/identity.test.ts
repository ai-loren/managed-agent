/**
 * confineServiceAccount tests — the workspace-isolation boundary for identity.
 *
 * This is the one place a requested `runAs` becomes a Kubernetes ServiceAccount
 * name, so it is where a workspace naming another workspace's identity — or a
 * cluster account like `default` — is refused. The name it produces is what the
 * pod runs as, and through IRSA / Workload Identity, what cloud IAM role it
 * assumes; confinement that only holds against a mock is no confinement at all,
 * so these assert on the concrete string.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MaError } from '@ma/core';

import { confineServiceAccount } from '../src/index.ts';

const WS_A = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const WS_B = 'ws_01BXYZ3NDEKTSV4RRFFQ69G5FB';

// A DNS-1123 subdomain, Kubernetes' rule for a ServiceAccount name.
const DNS_1123_SUBDOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

describe('confineServiceAccount', () => {
  test('confines an identity to a workspace-prefixed name', () => {
    const name = confineServiceAccount(WS_A, 's3-reader');
    // The workspace ULID, lower-cased with its `_` turned into a dash, then the
    // requested label — so the account a workspace names always begins with its
    // own prefix.
    assert.equal(name, 'ws-01arz3ndektsv4rrffq69g5fav-s3-reader');
    assert.ok(name.startsWith('ws-01arz3ndektsv4rrffq69g5fav-'));
  });

  test('always produces a valid DNS-1123 subdomain', () => {
    for (const runAs of ['a', 's3-reader', 'x'.repeat(63), '9lives']) {
      const name = confineServiceAccount(WS_A, runAs);
      assert.ok(DNS_1123_SUBDOMAIN.test(name), `${name} must be a valid ServiceAccount name`);
      assert.ok(name.length <= 253, 'a ServiceAccount name is at most 253 chars');
    }
  });

  test('two workspaces naming the same identity get disjoint names', () => {
    // The core isolation property: `runAs: 'admin'` in workspace A and in
    // workspace B must never resolve to the same ServiceAccount, or one could
    // assume the other's cloud role.
    const a = confineServiceAccount(WS_A, 'admin');
    const b = confineServiceAccount(WS_B, 'admin');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('ws-01arz3ndektsv4rrffq69g5fav-'));
    assert.ok(b.startsWith('ws-01bxyz3ndektsv4rrffq69g5fb-'));
  });

  test('the workspace prefix is exactly 29 chars, so the mapping cannot collide', () => {
    // Collision-freedom rests on the workspace segment being fixed-width: the
    // prefix is always `ws-` + 26 lower-cased ULID chars = 29 chars, so `runAs`
    // always begins at index 30. That makes (workspace, runAs) → name injective
    // even when runAs contains dashes — there is no split ambiguity. Guard it:
    // if a future change made workspace ids variable-length, this fails loudly.
    const name = confineServiceAccount(WS_A, 'a-b-c');
    assert.equal(name.slice(0, 29), 'ws-01arz3ndektsv4rrffq69g5fav');
    assert.equal(name.charAt(29), '-');
    assert.equal(name.slice(30), 'a-b-c');

    // A dash-containing runAs in one workspace can never be re-read as a
    // different (workspace, runAs) split of another workspace's name.
    const x = confineServiceAccount(WS_A, 'b-c');
    const y = confineServiceAccount(WS_B, 'b-c');
    assert.notEqual(x, y);
  });

  test('a workspace cannot name a bare cluster account', () => {
    // 'default', 'kube-system:...', etc. all still come out prefixed, so naming
    // one reaches only the workspace's own `...-default`, never the real one.
    const name = confineServiceAccount(WS_A, 'default');
    assert.equal(name, 'ws-01arz3ndektsv4rrffq69g5fav-default');
    assert.notEqual(name, 'default');
  });

  test('rejects a non-ULID workspace id', () => {
    for (const bad of ['..', 'ws_short', '../../etc', 'ws_' + 'x'.repeat(26), '', 'default']) {
      assert.throws(
        () => confineServiceAccount(bad, 's3-reader'),
        (error: unknown) => {
          assert.ok(error instanceof MaError);
          assert.equal(error.code, 'IDENTITY_BAD_WORKSPACE');
          return true;
        },
        `${JSON.stringify(bad)} must be refused as a workspace id`,
      );
    }
  });

  test('rejects a runAs that is not a single DNS-1123 label', () => {
    // Defence in depth: the spec schema already enforces this, but the helper is
    // the function that turns a string into a cluster identity, so it must be
    // safe on any caller — an empty value, upper-case, a namespace separator, a
    // path, or an over-long label.
    for (const bad of ['', 'Admin', 'ns/sa', 'default:admin', '-lead', 'trail-', 'x'.repeat(64)]) {
      assert.throws(
        () => confineServiceAccount(WS_A, bad),
        (error: unknown) => {
          assert.ok(error instanceof MaError);
          assert.equal(error.code, 'IDENTITY_BAD_RUN_AS');
          return true;
        },
        `${JSON.stringify(bad)} must be refused as runAs`,
      );
    }
  });
});
