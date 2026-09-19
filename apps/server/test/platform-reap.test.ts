/**
 * `reapAndMaintain` ordering invariant.
 *
 * The periodic sweep reaps lapsed sandboxes and runs best-effort maintenance
 * (artifact retention, document ingestion) on the same loop. The reaped ids are
 * the sweep's contract: the scheduler recovers each stranded session from them,
 * so dropping them leaves a session `ready` against a sandbox that no longer
 * exists. The regression this guards: the maintenance steps used to be a bare
 * `await` chain ending in `return reaped`, so a single throwing step (a poison
 * ingest document, a transient artifact-store fault) threw past the return and
 * stranded every session reaped in that tick.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nullLogger } from '@ma/core';

import { reapAndMaintain, type ReapAndMaintainDeps } from '../src/platform.ts';

function deps(overrides: Partial<ReapAndMaintainDeps> = {}): ReapAndMaintainDeps {
  return {
    broker: {
      reapExpiredLeases: () => Promise.resolve({ reaped: ['sb_reaped_1', 'sb_reaped_2'] }),
      reapIdleSandboxes: () => Promise.resolve(['sb_idle_1']),
    } as ReapAndMaintainDeps['broker'],
    ingestion: {
      recoverStuckProcessing: () => Promise.resolve(0),
      reprocessFailed: () => Promise.resolve(0),
      processNext: () => Promise.resolve(false),
    } as ReapAndMaintainDeps['ingestion'],
    forgetSandbox: () => {},
    logger: nullLogger,
    ...overrides,
  };
}

describe('reapAndMaintain ordering', () => {
  test('returns the reaped ids for recovery', async () => {
    const reaped = await reapAndMaintain(deps());
    assert.deepEqual([...reaped], ['sb_reaped_1', 'sb_reaped_2'], 'lapsed-lease ids are returned');
  });

  test('forgets runtime state for both lapsed and idle-reaped sandboxes', async () => {
    const forgotten: string[] = [];
    await reapAndMaintain(deps({ forgetSandbox: (id) => forgotten.push(id) }));
    assert.deepEqual(
      forgotten.sort(),
      ['sb_idle_1', 'sb_reaped_1', 'sb_reaped_2'],
      'every destroyed sandbox has its cached runtime state forgotten',
    );
  });

  test('a throwing artifact purge does not drop the reaped ids', async () => {
    // The bug: retention purge threw before `return reaped`, so the scheduler
    // never recovered the sessions holding the just-reaped sandboxes.
    const reaped = await reapAndMaintain(
      deps({ purgeArtifacts: () => Promise.reject(new Error('storage fault')) }),
    );
    assert.deepEqual(
      [...reaped],
      ['sb_reaped_1', 'sb_reaped_2'],
      'a failed retention purge must not strand the reaped sessions',
    );
  });

  test('a throwing idle sweep does not drop the lapsed-lease reaped ids', async () => {
    // `reaped` (lapsed leases, the ids needing session recovery) is captured
    // before the idle sweep runs, so a throw in reapIdleSandboxes must not lose
    // it — that would strand the same sessions the maintenance-step isolation
    // protects. The idle sweep is best-effort: its failure just leaves the warm
    // sandboxes for the next tick.
    const reaped = await reapAndMaintain(
      deps({
        broker: {
          reapExpiredLeases: () => Promise.resolve({ reaped: ['sb_reaped_1', 'sb_reaped_2'] }),
          reapIdleSandboxes: () => Promise.reject(new Error('idle sweep failed')),
        } as ReapAndMaintainDeps['broker'],
      }),
    );
    assert.deepEqual(
      [...reaped],
      ['sb_reaped_1', 'sb_reaped_2'],
      'a failed idle sweep must not strand the lapsed-lease sessions',
    );
  });

  test('a poison document (processNext throws) does not drop the reaped ids', async () => {
    const reaped = await reapAndMaintain(
      deps({
        ingestion: {
          recoverStuckProcessing: () => Promise.resolve(0),
          reprocessFailed: () => Promise.resolve(0),
          processNext: () => Promise.reject(new Error('poison document')),
        } as ReapAndMaintainDeps['ingestion'],
      }),
    );
    assert.deepEqual(
      [...reaped],
      ['sb_reaped_1', 'sb_reaped_2'],
      'a poison ingest document must not strand the reaped sessions',
    );
  });

  test('one failing maintenance step does not skip the others', async () => {
    // Each step is isolated, so a throw in retention still lets ingestion run —
    // otherwise a poison artifact would silently halt ingestion for the tick.
    const ran: string[] = [];
    await reapAndMaintain(
      deps({
        purgeArtifacts: () => {
          ran.push('purge');
          return Promise.reject(new Error('storage fault'));
        },
        ingestion: {
          recoverStuckProcessing: () => {
            ran.push('recover');
            return Promise.resolve(0);
          },
          reprocessFailed: () => {
            ran.push('reprocess');
            return Promise.resolve(0);
          },
          processNext: () => {
            ran.push('processNext');
            return Promise.resolve(false);
          },
        } as ReapAndMaintainDeps['ingestion'],
      }),
    );
    assert.deepEqual(
      ran,
      ['purge', 'recover', 'reprocess', 'processNext'],
      'a failed step is logged and skipped; the later steps still run',
    );
  });

  test('a failing reap propagates (there is nothing to recover from)', async () => {
    // The reap produces the ids; if it cannot even be determined what was reaped,
    // there is no safe id set to return, so that failure is not swallowed.
    await assert.rejects(
      reapAndMaintain(
        deps({
          broker: {
            reapExpiredLeases: () => Promise.reject(new Error('db down')),
            reapIdleSandboxes: () => Promise.resolve([]),
          } as ReapAndMaintainDeps['broker'],
        }),
      ),
      /db down/,
    );
  });
});
