/**
 * The sandbox's side of an approval: ask once, then keep asking until a person
 * answers — through a restart or a dropped connection — and let only a
 * decision, a refusal the control plane means, or the turn's own signal end it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MaError, nullLogger, type Clock } from '@ma/core';
import type { ModelToolCall } from '@ma/runtime';

import { bridgeApprover, type ApprovalAnswer } from '../src/main.ts';

const CALL: ModelToolCall = { id: 'call_1', name: 'shell', arguments: { command: 'rm -rf build' } };

function answer(status: ApprovalAnswer['status'], reason = ''): ApprovalAnswer {
  return { approvalId: 'ap_1', status, expiresAt: 0, reason };
}

/** A clock whose sleeps return at once and are recorded, or reject when the signal aborts. */
function recordingClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => 0,
    monotonic: () => 0,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return signal?.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();
    },
  };
}

/** A control plane that answers from scripts, recording what it was asked. */
function scriptedControl(script: { request: (() => Promise<ApprovalAnswer>)[]; poll: (() => Promise<ApprovalAnswer>)[] }) {
  const asked: unknown[] = [];
  const polled: { approvalId: string; waitMs: number }[] = [];
  return {
    asked,
    polled,
    requestApproval: (call: unknown) => {
      asked.push(call);
      const next = script.request.shift();
      assert.ok(next, 'asked more often than scripted');
      return next();
    },
    awaitApproval: (approvalId: string, waitMs: number) => {
      polled.push({ approvalId, waitMs });
      const next = script.poll.shift();
      assert.ok(next, 'polled more often than scripted');
      return next();
    },
  };
}

const passing = (message: string) => () => Promise.reject(new MaError({ code: 'CONTROL_PLANE_ERROR', category: 'unavailable', message, retryable: true }));

describe('bridgeApprover', () => {
  test('asks once with the turn it belongs to, waits until someone decides, and runs the call on a yes', async () => {
    const control = scriptedControl({
      request: [() => Promise.resolve(answer('pending'))],
      poll: [() => Promise.resolve(answer('pending')), () => Promise.resolve(answer('approved'))],
    });
    const approve = bridgeApprover(control, () => 7, recordingClock(), nullLogger);

    const outcome = await approve(CALL, 'shell needs approval', new AbortController().signal);
    assert.deepEqual(outcome, { approved: true });
    assert.deepEqual(control.asked, [
      { toolCallId: 'call_1', toolName: 'shell', input: { command: 'rm -rf build' }, reason: 'shell needs approval', turn: 7 },
    ]);
    assert.deepEqual(control.polled, [
      { approvalId: 'ap_1', waitMs: 20_000 },
      { approvalId: 'ap_1', waitMs: 20_000 },
    ]);
  });

  test("the turn's buffered events are sent before asking, so the log shows the call first", async () => {
    const order: string[] = [];
    const control = scriptedControl({ request: [() => (order.push('ask'), Promise.resolve(answer('approved')))], poll: [] });
    const flush = (): Promise<void> => {
      order.push('flush');
      return Promise.resolve();
    };
    await bridgeApprover(control, () => 1, recordingClock(), nullLogger, flush)(CALL, '', new AbortController().signal);
    assert.deepEqual(order, ['flush', 'ask']);

    const failing = scriptedControl({ request: [() => Promise.resolve(answer('approved'))], poll: [] });
    const outcome = await bridgeApprover(failing, () => 1, recordingClock(), nullLogger, () => Promise.reject(new Error('reporter down')))(CALL, '', new AbortController().signal);
    assert.deepEqual(outcome, { approved: true }, 'a flush that fails does not stop the ask');
  });

  test("a no carries the person's reason", async () => {
    const control = scriptedControl({ request: [() => Promise.resolve(answer('denied', 'not on production'))], poll: [] });
    const outcome = await bridgeApprover(control, () => 1, recordingClock(), nullLogger)(CALL, '', new AbortController().signal);
    assert.deepEqual(outcome, { approved: false, reason: 'not on production' });
    assert.equal(control.polled.length, 0, 'an answer already given needs no wait');
  });

  test('an ending with no reason still says what happened', async () => {
    const control = scriptedControl({
      request: [() => Promise.resolve(answer('pending'))],
      poll: [() => Promise.resolve(answer('cancelled'))],
    });
    const outcome = await bridgeApprover(control, () => 1, recordingClock(), nullLogger)(CALL, '', new AbortController().signal);
    assert.deepEqual(outcome, { approved: false, reason: 'The approval was cancelled' });
  });

  test('a poll that fails for a reason that can pass is asked again, backing off, and the wait resumes', async () => {
    const clock = recordingClock();
    const control = scriptedControl({
      request: [passing('POST /approvals answered 503'), () => Promise.resolve(answer('pending'))],
      poll: [
        () => Promise.reject(new TypeError('fetch failed')),
        passing('GET /approvals/ap_1 answered 502'),
        passing('GET /approvals/ap_1 answered 502'),
        passing('GET /approvals/ap_1 answered 502'),
        passing('GET /approvals/ap_1 answered 502'),
        () => Promise.resolve(answer('approved')),
      ],
    });
    const outcome = await bridgeApprover(control, () => 1, clock, nullLogger)(CALL, '', new AbortController().signal);
    assert.deepEqual(outcome, { approved: true });
    assert.equal(control.asked.length, 2);
    assert.deepEqual(clock.sleeps, [500, 500, 1_000, 2_000, 5_000, 5_000], 'one backoff per failure, capped');
  });

  test('a refusal the control plane means is a denial that says why, not a retry', async () => {
    const control = scriptedControl({
      request: [
        () =>
          Promise.reject(
            new MaError({ code: 'CONTROL_PLANE_ERROR', category: 'precondition', message: 'POST /approvals answered 412: prompt mode only', retryable: false }),
          ),
      ],
      poll: [],
    });
    const outcome = await bridgeApprover(control, () => 1, recordingClock(), nullLogger)(CALL, '', new AbortController().signal);
    assert.ok(typeof outcome === 'object');
    assert.equal(outcome.approved, false);
    assert.match(outcome.reason ?? '', /refused to ask anyone about this call: POST \/approvals answered 412: prompt mode only/);
    assert.equal(control.asked.length, 1);
  });

  test("the turn's signal ends the wait, even between failed polls", async () => {
    const abort = new AbortController();
    const control = scriptedControl({
      request: [() => Promise.resolve(answer('pending'))],
      poll: [
        () => {
          abort.abort();
          return Promise.reject(new TypeError('fetch failed'));
        },
      ],
    });
    await assert.rejects(bridgeApprover(control, () => 1, recordingClock(), nullLogger)(CALL, '', abort.signal));
    assert.equal(control.polled.length, 1, 'not asked again once the turn is over');
  });
});
