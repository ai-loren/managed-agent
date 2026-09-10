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

  test('surfaces an API error rather than returning empty text', async () => {
    const provider = new OpenRouterProvider({
      apiKey: 'k',
      model: 'm',
      fetch: fakeFetch(() => ({ status: 429, body: { error: { message: 'rate limited' } } })),
    });
    await assert.rejects(
      provider.complete({ modelId: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] }),
      /rate limited/,
    );
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
});

describe('echoProvider', () => {
  test('echoes the last user message', async () => {
    const result = await echoProvider.complete({
      modelId: 'stub/echo',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      tools: [],
    });
    assert.equal(result.text, 'echo: second');
    assert.equal(result.stopReason, 'end_turn');
  });
});
