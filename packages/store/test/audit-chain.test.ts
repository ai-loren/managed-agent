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

import { createMemoryStore, auditEntryHash, type SqliteStore } from '../src/index.ts';

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

  test('an empty-string workspaceId verifies (it is the same "no workspace" as absent)', async () => {
    // The optional-column round-trip trap: append binds '' verbatim and hashes
    // `'' ?? null` as '', while readOptionalString maps the stored '' back to
    // undefined, so verify hashed `undefined ?? null` as null — a legitimately
    // written row was reported as tampered, permanently, poisoning every later
    // verification. '' and undefined must be one value ("no workspace") at every
    // layer: storage, append-time hash, verify-time hash.
    await store.audit.append(entry({ workspaceId: '' }));
    await appendMany(2);
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true, JSON.stringify(result));

    // It is stored as NULL, the canonical absent value — not as a distinct ''.
    const stored = store.database.get('SELECT workspace_id FROM audit_entries ORDER BY seq ASC LIMIT 1');
    assert.equal(stored?.workspace_id, null);
  });

  test('the entry hash is identical for "" and absent workspaceId', async () => {
    // The normalization is in the hash material itself (the chokepoint both
    // append and verify go through), not only at one call site.
    const a = entry({ workspaceId: '' });
    const b = { ...a, workspaceId: undefined };
    assert.equal(auditEntryHash(a, ''), auditEntryHash(b, ''));
  });

  test('prunes by seq-prefix so a clock-skewed retained row is never stranded below the watermark', async () => {
    // `at` is caller-supplied and can be out of order with seq (an NTP step / DST
    // / manual clock set). Pruning is by seq-PREFIX, not a raw `at < before` sweep:
    // deleting only the maximal all-expired oldest run keeps the watermark a true
    // deleted-prefix boundary, so no RETAINED row is ever stranded below it (where
    // verifyChain would exempt it from linkage checks and it would become silently
    // deletable/forgeable — the tamper-evidence hole this closes).
    await store.audit.append(entry({ at: 1000 })); // seq 1 — expired
    await store.audit.append(entry({ at: 5000 })); // seq 2 — retained (first live)
    const skewed = await store.audit.append(entry({ at: 2000 })); // seq 3 — expired by time, but AFTER a retained row
    await store.audit.append(entry({ at: 6000 })); // seq 4 — retained

    // Prune everything before at=3000. Only seq 1 is a fully-expired prefix: seq 2
    // (at=5000) is the first live row, so the prefix stops at seq 1. seq 3 lingers
    // (skewed) rather than being carved out of the middle and stranding seq 2.
    const pruned = await store.audit.prune(3000);
    assert.equal(pruned, 1, 'only the all-expired prefix (seq 1) is deleted, not the skewed middle row');

    // seq 3 is still present and inside the live, linkage-verified zone.
    const skewedStill = store.database.get('SELECT seq FROM audit_entries WHERE id = ?', [skewed.id]);
    assert.ok(skewedStill, 'the skewed row is retained, not stranded-and-exempt');
    const result = await store.audit.verifyChain();
    assert.equal(result.ok, true, result.reason ?? '');

    // The formerly-strandable row is now linkage-protected: deleting it breaks the
    // chain (before the fix it sat below the watermark and its deletion was
    // undetected).
    store.database.run('DELETE FROM audit_entries WHERE id = ?', [skewed.id]);
    const afterDelete = await store.audit.verifyChain();
    assert.equal(afterDelete.ok, false, 'deleting the (previously strandable) row is now caught');
  });

  test('a forged retained row below a time cutoff is caught (no linkage exemption)', async () => {
    // The forgery half of the tamper-evidence hole: rewrite a retained row's
    // business fields and recompute a self-consistent entry_hash via the exported
    // auditEntryHash(). With prefix pruning the row stays in the live zone, so the
    // NEXT row's prev_hash no longer links — the forgery is caught.
    await store.audit.append(entry({ at: 1000 })); // seq 1 — expired prefix
    const victim = await store.audit.append(entry({ at: 5000, outcome: 'denied' })); // seq 2 — retained
    await store.audit.append(entry({ at: 2000 })); // seq 3 — skewed, retained
    await store.audit.append(entry({ at: 6000 })); // seq 4 — retained
    await store.audit.prune(3000); // deletes only seq 1

    // Forge seq 2: flip denied→allowed and recompute a matching entry_hash so the
    // row is self-consistent (the content check alone would pass).
    const row = store.database.get('SELECT * FROM audit_entries WHERE id = ?', [victim.id]);
    const forged = { ...victim, outcome: 'allowed' as const };
    const prevHash = String(row!.prev_hash ?? '');
    const forgedHash = auditEntryHash(forged, prevHash);
    store.database.run('UPDATE audit_entries SET outcome = ?, entry_hash = ? WHERE id = ?', [
      'allowed',
      forgedHash,
      victim.id,
    ]);

    const result = await store.audit.verifyChain();
    assert.equal(result.ok, false, 'a self-consistent forgery of a retained row must still break linkage');
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
