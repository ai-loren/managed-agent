/**
 * Tamper-evident audit hash-chain tests.
 *
 * The guarantee is that any edit, insert, deletion or reordering of a historical
 * audit row breaks the chain and `verifyChain` reports where. So the tests do the
 * tampering — reaching past the repository to the raw database, exactly as an
 * attacker with database access would — and assert detection. A green chain over
 * an untouched log proves nothing without these.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { newId } from '@ma/core';
import type { AuditEntry } from '@ma/contracts';

import { createMemoryStore, type SqliteStore } from '../src/index.ts';

let store: SqliteStore;
let seq = 0;

beforeEach(() => {
  store = createMemoryStore();
  seq = 0;
});

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  const at = 1_700_000_000_000 + seq * 1000;
  return {
    id: newId('auditEntry', at),
    principalId: 'pr_test',
    action: `action.${++seq}`,
    resourceKind: 'resource',
    resourceId: `rc_${seq}`,
    outcome: 'allowed',
    reason: '',
    requestId: '',
    sourceIp: '',
    details: {},
    at,
    ...overrides,
  };
}

async function appendMany(n: number): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for (let i = 0; i < n; i++) out.push(await store.audit.append(entry()));
  return out;
}

describe('audit hash chain', () => {
  test('verifies an untouched chain', async () => {
    await appendMany(5);
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 5);
  });

  test('verifies an empty log', async () => {
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true);
    assert.equal(result.checked, 0);
  });

  test('detects an edited field in a middle row', async () => {
    const entries = await appendMany(5);
    const target = entries[2]!;
    // Tamper: change the action of the third row directly in the database, as
    // someone with DB access covering their tracks would.
    store.database.run('UPDATE audit_entries SET action = ? WHERE id = ?', ['action.TAMPERED', target.id]);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, target.id);
    assert.ok(result.reason?.includes('modified'), result.reason ?? "");
    // It caught it at the tampered row, having verified the two before it.
    assert.equal(result.checked, 2);
  });

  test('detects an edited outcome (denied → allowed, the classic cover-up)', async () => {
    const entries = await appendMany(3);
    const target = entries[1]!;
    store.database.run('UPDATE audit_entries SET outcome = ? WHERE id = ?', ['allowed', target.id]);
    // (the row was appended as 'allowed'; flip it to prove any content change trips)
    store.database.run('UPDATE audit_entries SET outcome = ? WHERE id = ?', ['denied', target.id]);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, target.id);
  });

  test('detects an edited details blob', async () => {
    const entries = await appendMany(3);
    const target = entries[0]!;
    store.database.run('UPDATE audit_entries SET details = ? WHERE id = ?', ['{"escalated":true}', target.id]);
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, target.id);
  });

  test('detects a deleted middle row (a gap in the chain)', async () => {
    const entries = await appendMany(5);
    const removed = entries[2]!;
    store.database.run('DELETE FROM audit_entries WHERE id = ?', [removed.id]);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    // The gap surfaces at the seq that is now missing.
    assert.ok(result.reason?.includes('deleted') || result.reason?.includes('reorder'), result.reason ?? "");
  });

  test('detects a tail truncation (deleting the newest rows)', async () => {
    // The attack the endpoint check exists for: delete the most recent entries to
    // erase recent actions, touching nothing else. Every surviving row still
    // links cleanly, so only the head comparison catches it.
    await appendMany(6);
    store.database.run('DELETE FROM audit_entries WHERE seq > 3');
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes('truncated'), result.reason ?? '');
  });

  test('detects a full wipe of the log', async () => {
    // Deleting every row but leaving the head pointing at seq 5 must not verify.
    await appendMany(5);
    store.database.run('DELETE FROM audit_entries');
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
  });

  test('detects a forged inserted row', async () => {
    await appendMany(3);
    // Forge a row appended after the chain with a fresh seq (4) but a fabricated
    // hash — an attacker adding a fake record. The unique seq index forbids
    // reusing an existing seq, so the forger must extend the chain; without the
    // real prior hash the link cannot be valid, and the head no longer matches.
    const forged = entry({ action: 'access.granted.forged' });
    store.database.run(
      `INSERT INTO audit_entries (id, workspace_id, principal_id, action, resource_kind,
                                  resource_id, outcome, reason, request_id, source_ip, details, at,
                                  seq, prev_hash, entry_hash)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        forged.id, forged.principalId, forged.action, forged.resourceKind, forged.resourceId,
        forged.outcome, forged.reason, forged.requestId, forged.sourceIp, '{}', forged.at,
        4, 'deadbeef', 'forgedhash',
      ],
    );
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
  });

  test('the unique seq index rejects a duplicate-seq forgery outright', async () => {
    await appendMany(3);
    // Reusing an existing seq is refused at the database layer — a forged row
    // cannot silently overwrite or shadow a real one.
    const forged = entry();
    assert.throws(() =>
      store.database.run(
        `INSERT INTO audit_entries (id, workspace_id, principal_id, action, resource_kind,
                                    resource_id, outcome, reason, request_id, source_ip, details, at,
                                    seq, prev_hash, entry_hash)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          forged.id, forged.principalId, forged.action, forged.resourceKind, forged.resourceId,
          forged.outcome, forged.reason, forged.requestId, forged.sourceIp, '{}', forged.at,
          2, 'x', 'y',
        ],
      ),
    );
  });

  test('detects tampering with the very first (genesis) row', async () => {
    const entries = await appendMany(3);
    const first = entries[0]!;
    store.database.run('UPDATE audit_entries SET principal_id = ? WHERE id = ?', ['pr_attacker', first.id]);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, first.id);
    assert.equal(result.checked, 0, 'the break is at the genesis row, before any verified');
  });

  test('detects reordering via swapped prev_hash links', async () => {
    const entries = await appendMany(4);
    // Swap the entry_hash of row 2 to a wrong-but-real value — simulating a
    // reorder. The next row's prev_hash no longer matches.
    store.database.run('UPDATE audit_entries SET entry_hash = ? WHERE id = ?', ['0'.repeat(64), entries[1]!.id]);
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
  });

  test('a details value that JSON.stringify transforms still verifies (no false positive)', async () => {
    // The MEDIUM the review caught: a Date (or anything with toJSON) is stored as
    // its stringified form, so the hash must be computed over the same reparsed
    // form at append and verify — otherwise a legitimately-written row reads as
    // tampered.
    const withDate = entry();
    (withDate.details as Record<string, unknown>).when = new Date(1_700_000_000_000);
    (withDate.details as Record<string, unknown>).missing = undefined;
    await store.audit.append(withDate);
    await appendMany(2);
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true, result.reason ?? '');
  });

  test('prunes expired rows by time and still verifies when timestamps are non-monotonic', async () => {
    // `at` is caller-supplied and can be out of order with seq (clock skew). A
    // prune by time deletes every expired row, and verification must not read the
    // resulting non-prefix deletion as tampering.
    await store.audit.append(entry({ at: 1000 })); // seq 1
    await store.audit.append(entry({ at: 5000 })); // seq 2
    await store.audit.append(entry({ at: 2000 })); // seq 3 — skewed: older than seq 2
    await store.audit.append(entry({ at: 6000 })); // seq 4
    // Prune everything before at=3000: seq 1 (1000) and seq 3 (2000) qualify by
    // time and are both deleted, even though seq 3 sits after the retained seq 2.
    const pruned = await store.audit.prune(3000);
    assert.equal(pruned, 2, 'both expired rows are deleted, prefix or not');

    // The chain still verifies: survivors are content-verified, and the live zone
    // above the prune checkpoint links cleanly.
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true, result.reason ?? '');

    // And a survivor edit is still caught after such a prune.
    const survivor = store.database.get('SELECT id FROM audit_entries ORDER BY seq DESC LIMIT 1');
    store.database.run('UPDATE audit_entries SET action = ? WHERE id = ?', ['x.TAMPERED', String(survivor!.id)]);
    const tampered = await store.audit.verifyChain();
    assert.equal(tampered.ok, false, 'tampering after a skewed prune is still detected');
  });

  test('survives legitimate retention pruning (re-anchors at the checkpoint)', async () => {
    // Append 6, then prune the oldest 3 by timestamp. Pruning is legitimate and
    // must NOT read as tampering: the chain re-anchors at the pruned checkpoint.
    const entries = await appendMany(6);
    const cutoff = entries[3]!.at; // deletes entries 0,1,2 (at < cutoff)
    const pruned = await store.audit.prune(cutoff);
    assert.equal(pruned, 3);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.checked, 3, 'the three surviving rows verify against the checkpoint');
  });

  test('still detects tampering AFTER a prune', async () => {
    const entries = await appendMany(6);
    await store.audit.prune(entries[3]!.at);
    // Tamper with a surviving row.
    store.database.run('UPDATE audit_entries SET action = ? WHERE id = ?', ['x.TAMPERED', entries[4]!.id]);
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.brokenId, entries[4]!.id);
  });

  test('the chain head advances monotonically and links each row to the last', async () => {
    await appendMany(3);
    const rows = store.database.all('SELECT seq, prev_hash, entry_hash FROM audit_entries ORDER BY seq ASC');
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.seq, 1);
    assert.equal(rows[1]!.seq, 2);
    assert.equal(rows[2]!.seq, 3);
    // Each row's prev_hash is the previous row's entry_hash.
    assert.equal(rows[1]!.prev_hash, rows[0]!.entry_hash);
    assert.equal(rows[2]!.prev_hash, rows[1]!.entry_hash);
    // Genesis links to the empty anchor.
    assert.equal(rows[0]!.prev_hash, '');
  });

  test('a pre-migration-10 legacy prefix does not read as tampering', async () => {
    // Migration 10 gave rows that pre-dated the hash chain a real seq but empty
    // (never-computed, never-computable) hashes, and anchored the head's
    // pruned_through_seq past them so verification begins at the first chained
    // row. verifyChain must skip these legacy rows entirely: recomputing a content
    // hash for one and comparing it to '' would falsely fail on any install that
    // upgraded across migration 10. Simulate one legacy row, then real chained
    // appends on top.
    store.database.run(
      `INSERT INTO audit_entries
         (id, workspace_id, principal_id, action, resource_kind, resource_id, outcome, reason, request_id, source_ip, details, at, seq, prev_hash, entry_hash)
       VALUES (?, NULL, 'pr_legacy', 'legacy.action', 'resource', 'rc_legacy', 'allowed', '', '', '', '{}', ?, 1, '', '')`,
      [newId('auditEntry'), 1_600_000_000_000],
    );
    // Anchor the head past the legacy prefix, exactly as migration 10 does.
    store.database.run(
      `UPDATE audit_chain_head SET last_seq = 1, pruned_through_seq = 1 WHERE id = 1`,
    );

    // Now append real chained entries; they get seq 2, 3, … with real hashes.
    seq = 1; // so the next appended row is seq 2
    await appendMany(3);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true, `a legacy prefix must verify clean, got: ${JSON.stringify(result)}`);

    // And tampering with a real chained row is still caught.
    store.database.run('UPDATE audit_entries SET outcome = ? WHERE seq = 3', ['denied']);
    const tampered = await store.audit.verifyChain();
    assert.equal(tampered.ok, false, 'a chained row edit is still detected');
  });
});
