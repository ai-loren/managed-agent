/**
 * OpenRouter provider tests.
 *
 * A fake `fetch` stands in for the network, so these assert the driver's own
 * logic — the request it builds and how it maps the response — without a real
 * OpenRouter account, exactly as the k8s client's pure helpers are tested.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterProvider, echoProvider } from '../src/providers/openrouter.ts';
import { MaError } from '@ma/core';

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): typeof fetch {
  return ((url: string, init: RequestInit) => {
    const { status, body } = handler(url, init);
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;
}

describe('OpenRouterProvider', () => {
  test('sends an OpenAI-shaped request and maps the reply', async () => {
    let seen: { url: string; body: Record<string, unknown> } | undefined;
    const provider = new OpenRouterProvider({
      apiKey: 'sk-test',
      model: 'vendor/model:free',
      fetch: fakeFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        return {
          status: 200,
          body: {
            choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 4 },
          },
        };
      }),
    });

    const result = await provider.complete({
      modelId: 'vendor/model:free',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 256,
    });

    assert.match(seen!.url, /\/chat\/completions$/);
    assert.equal((seen!.body as { model: string }).model, 'vendor/model:free');
    assert.equal((seen!.body as { max_tokens: number }).max_tokens, 256);
    assert.equal(result.text, 'hello there');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage.inputTokens, 11);
    assert.equal(result.usage.outputTokens, 4);
  });

  test('maps finish_reason length and tool_calls', async () => {
    const make = (finish: string) =>
      new OpenRouterProvider({
        apiKey: 'k',
        model: 'm',
        fetch: fakeFetch(() => ({
          status: 200,
          body: { choices: [{ message: { content: '' }, finish_reason: finish }] },
        })),
      }).complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] });

    assert.equal((await make('length')).stopReason, 'max_tokens');
    assert.equal((await make('tool_calls')).stopReason, 'tool_use');
    assert.equal((await make('stop')).stopReason, 'end_turn');
  });

  test('a 429 is a retryable MaError, so withRetry backs off and failover advances', async () => {
    // A plain Error coerces to category `internal` (not retryable), which made the
    // bridge give up on the first attempt and skip every fallback model. A 429 must
    // be a retryable MaError so the retry+failover machinery engages.
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(() => ({ status: 429, body: { error: { message: 'rate limited' } } })),
    });
    await assert.rejects(
      provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }),
      (error: unknown) => {
        assert.ok(MaError.is(error), 'the error is a classified MaError, not a plain Error');
        assert.equal(error.category, 'quota', 'a 429 maps to quota');
        assert.equal(error.retryable, true, 'a 429 is retryable so withRetry/failover engage');
        return true;
      },
    );
  });

  test('a 5xx is a retryable MaError; a 4xx is not', async () => {
    const make = (status: number) =>
      new OpenRouterProvider({
        apiKey: 'k',
        model: 'm',
        fetch: fakeFetch(() => ({ status, body: { error: { message: `status ${status}` } } })),
      });
    const call = (p: OpenRouterProvider) =>
      p.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] });

    await assert.rejects(call(make(503)), (e: unknown) => MaError.is(e) && e.category === 'unavailable' && e.retryable === true);
    await assert.rejects(call(make(504)), (e: unknown) => MaError.is(e) && e.category === 'timeout' && e.retryable === true);
    await assert.rejects(call(make(400)), (e: unknown) => MaError.is(e) && e.retryable === false);
    await assert.rejects(call(make(401)), (e: unknown) => MaError.is(e) && e.category === 'unauthenticated' && e.retryable === false);
  });

  test('a missing content field yields empty text, not a crash', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(() => ({ status: 200, body: { choices: [{ message: {} }] } })),
    });
    const result = await provider.complete({
      modelId: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
    });
    assert.equal(result.text, '');
  });

  test('forwards tools and maps a function-call round trip', async () => {
    // This is what makes the harness's whole tool-dispatch half reachable through
    // a real OpenAI-compatible model: the tools are advertised, an assistant's
    // prior tool calls + the tool result are serialised correctly, and the model's
    // tool_calls come back as structured {id,name,arguments}.
    let seen: Record<string, unknown> | undefined;
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch((_url, init) => {
        seen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'search', arguments: '{"q":"weather"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 3 },
          },
        };
      }),
    });

    const result = await provider.complete({
      modelId: 'm',
      messages: [
        { role: 'system', content: 'you use tools' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_0', name: 'search', arguments: { q: 'old' } }],
        },
        { role: 'tool', content: 'sunny', toolCallId: 'call_0' },
        { role: 'user', content: 'again' },
      ],
      tools: [
        { name: 'search', description: 'search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
      ],
    });

    // Tools advertised in OpenAI form.
    const tools = seen!.tools as { type: string; function: { name: string } }[];
    assert.equal(seen!.tool_choice, 'auto');
    assert.equal(tools[0]!.type, 'function');
    assert.equal(tools[0]!.function.name, 'search');

    // The prior assistant tool call and the tool result survive the mapping.
    const wire = seen!.messages as Record<string, unknown>[];
    assert.deepEqual(wire[1]!.tool_calls, [
      { id: 'call_0', type: 'function', function: { name: 'search', arguments: '{"q":"old"}' } },
    ]);
    assert.deepEqual(wire[2], { role: 'tool', tool_call_id: 'call_0', content: 'sunny' });

    // The model's requested call comes back structured.
    assert.equal(result.stopReason, 'tool_use');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'search', arguments: { q: 'weather' } }]);
  });

  test('survives malformed tool-call arguments JSON instead of failing the turn', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(() => ({
        status: 200,
        body: {
          choices: [
            {
              message: { content: '', tool_calls: [{ id: 'c', function: { name: 't', arguments: '{not json' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })),
    });
    const result = await provider.complete({
      modelId: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    });
    assert.deepEqual(result.toolCalls, [{ id: 'c', name: 't', arguments: {} }]);
  });

  test('an error inside a 200 is classified by its own code, not by the 200', async () => {
    // OpenRouter reports a failure after generation started as HTTP 200 with
    // `error.code`; reading the 200 made a 502 non-retryable, so retry, the
    // breaker and failover never saw it.
    const call = (error: Record<string, unknown>) =>
      new OpenRouterProvider({
        apiKey: 'k',
        model: 'm',
        fetch: fakeFetch(() => ({ status: 200, body: { error } })),
      }).complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] });

    await assert.rejects(call({ code: 502, message: 'upstream died' }), (e: unknown) => MaError.is(e) && e.category === 'unavailable' && e.retryable);
    await assert.rejects(call({ code: 429, message: 'busy' }), (e: unknown) => MaError.is(e) && e.category === 'quota' && e.retryable);
    await assert.rejects(call({ code: 400, message: 'bad' }), (e: unknown) => MaError.is(e) && e.retryable === false);
    await assert.rejects(call({ message: 'no code at all' }), (e: unknown) => MaError.is(e) && e.retryable, 'an unexplained failure is treated as transient');
  });

  test('a 408 request timeout is retryable', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'm', fetch: fakeFetch(() => ({ status: 408, body: { error: { message: 'timed out' } } })) });
    await assert.rejects(
      provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }),
      (e: unknown) => MaError.is(e) && e.category === 'timeout' && e.retryable,
    );
  });

  test('a 200 with no usable answer is a retryable failure, not a finished turn', async () => {
    const call = (body: unknown) =>
      new OpenRouterProvider({ apiKey: 'k', model: 'm', fetch: fakeFetch(() => ({ status: 200, body })) }).complete({
        modelId: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      });
    await assert.rejects(call({ choices: [] }), (e: unknown) => MaError.is(e) && e.retryable, 'no choices');
    await assert.rejects(call({}), (e: unknown) => MaError.is(e) && e.retryable, 'no choices field');
    await assert.rejects(
      call({ choices: [{ message: { content: 'Step 1: open the fi' }, finish_reason: 'error', error: { code: 502, message: 'cut off' } }] }),
      (e: unknown) => MaError.is(e) && e.retryable,
      'a choice that ended in error does not become the answer',
    );
  });

  test('a filtered response says so instead of passing off what was left as the answer', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'Partial' }, finish_reason: 'content_filter' }] } })),
    });
    await assert.rejects(
      provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }),
      (e: unknown) => MaError.is(e) && e.code === 'OPENROUTER_CONTENT_FILTERED' && /filter/.test(e.message),
    );
  });

  test('tool-call ids are unique and bounded, and names fit what the bridge accepts back', async () => {
    // The harness keeps each call in its context and sends it back on the next
    // request, where the bridge rejects a name or id over 128 characters — so one
    // over-long value from the model failed every later request of the session.
    const longName = 'n'.repeat(300);
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(() => ({
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  { function: { name: 'a', arguments: '{}' } },
                  { id: '', function: { name: 'b', arguments: '{}' } },
                  { id: 'dup', function: { name: 'c', arguments: '{}' } },
                  { id: 'dup', function: { name: 'd', arguments: '{}' } },
                  { id: 'x'.repeat(400), function: { name: longName, arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      })),
    });
    const first = await provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] });
    // The next request carries the first answer's calls in its history, as the
    // harness sends it; the model answers with the very same ids again.
    const second = await provider.complete({
      modelId: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls ?? [] },
        ...(first.toolCalls ?? []).map((call) => ({ role: 'tool', content: 'ok', toolCallId: call.id })),
      ],
      tools: [],
    });
    const ids = [...(first.toolCalls ?? []), ...(second.toolCalls ?? [])].map((call) => call.id);
    assert.equal(new Set(ids).size, ids.length, 'no two calls share an id, within or across responses');
    assert.ok(ids.every((id) => id.length > 0 && id.length <= 128));
    assert.equal(first.toolCalls?.[2]?.id, 'dup', 'a usable id from the model is kept');
    assert.ok((first.toolCalls?.[4]?.name.length ?? 0) <= 128);
  });

  test('a connection that fails before any response is retryable, and names no secret', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    });
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-secret-value',
      model: 'm',
      fetch: (() => Promise.reject(refused)) as unknown as typeof fetch,
    });
    await assert.rejects(
      provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }),
      (error: unknown) => {
        assert.ok(MaError.is(error), 'a network failure is a classified MaError, not a plain Error');
        assert.equal(error.category, 'unavailable');
        assert.equal(error.retryable, true, 'retry and failover must engage for a reset/refused connection');
        assert.match(error.message, /ECONNREFUSED/, 'the cause is named so an operator can act on it');
        assert.doesNotMatch(error.message, /sk-or-secret-value/);
        return true;
      },
    );
  });

  test('a body cut off mid-read is retryable too', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          text: () => Promise.reject(new TypeError('terminated')),
        } as unknown as Response)) as unknown as typeof fetch,
    });
    await assert.rejects(
      provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }),
      (error: unknown) => MaError.is(error) && error.category === 'unavailable' && error.retryable === true,
    );
  });

  test('an abort requested by the caller surfaces the caller reason, not a retryable provider failure', async () => {
    const reason = new MaError({ code: 'CALLER_GAVE_UP', category: 'timeout', message: 'deadline', retryable: false });
    const controller = new AbortController();
    controller.abort(reason);
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: ((_url: string, init: RequestInit) => Promise.reject(init.signal?.reason)) as unknown as typeof fetch,
    });
    await assert.rejects(
      provider.complete({
        modelId: 'm',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
  });
});
