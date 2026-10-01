/**
 * Free-model discovery tests.
 *
 * The projection is pure, so it is tested against a fixture rather than the live
 * endpoint (which changes over time and would make the suite flaky). The one
 * property that must never break is the free-only guarantee: a model with any
 * non-zero price must never be offered, because the whole point of the guard is
 * that a misconfiguration cannot spend money.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MaError } from '@ma/core';

import {
  ModelDiscovery,
  isFreeModel,
  projectFreeModels,
  supportsTools,
  toCatalogueModel,
  toPricedCatalogueModel,
  type FreeModel,
} from '../src/model-discovery.ts';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'vendor/model:free',
    name: 'Vendor Model',
    context_length: 128_000,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools', 'temperature'],
    architecture: { input_modalities: ['text'] },
    ...overrides,
  };
}

describe('isFreeModel', () => {
  test('accepts a model priced exactly zero for both directions', () => {
    assert.equal(isFreeModel(entry()), true);
    assert.equal(isFreeModel(entry({ pricing: { prompt: '0', completion: '0.0' } })), true);
  });

  test('refuses a model with ANY non-zero price, whatever its id says', () => {
    // The safety property: a paid model must never be classified free, even if
    // its id carries the `:free` convention.
    assert.equal(isFreeModel(entry({ pricing: { prompt: '0', completion: '0.000001' } })), false);
    assert.equal(isFreeModel(entry({ pricing: { prompt: '0.0000015', completion: '0' } })), false);
    assert.equal(isFreeModel(entry({ pricing: { prompt: '1', completion: '2' } })), false);
  });

  test('refuses a :free id whose pricing is missing/unknown', () => {
    // Unknown pricing is treated as paid: the conservative direction.
    assert.equal(isFreeModel(entry({ pricing: {} })), false);
    assert.equal(isFreeModel(entry({ pricing: undefined })), false);
    assert.equal(isFreeModel(entry({ pricing: { prompt: '', completion: '' } })), false);
    assert.equal(isFreeModel(entry({ pricing: { prompt: 'free', completion: '0' } })), false);
  });

  test('refuses a model whose token prices are zero but which charges another way', () => {
    // OpenRouter prices more than tokens: a per-request fee, images, web search,
    // reasoning tokens, cache reads and writes. Any of them non-zero costs money.
    for (const field of ['request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write']) {
      assert.equal(
        isFreeModel(entry({ pricing: { prompt: '0', completion: '0', [field]: '0.005' } })),
        false,
        `a non-zero '${field}' price is not free`,
      );
    }
    assert.equal(
      isFreeModel(entry({ pricing: { prompt: '0', completion: '0', request: '0', image: '0', web_search: '0' } })),
      true,
      'zero in every priced dimension is free',
    );
  });

  test('refuses a price field that is not a number, whatever it is called', () => {
    assert.equal(isFreeModel(entry({ pricing: { prompt: '0', completion: '0', request: 'n/a' } })), false);
    assert.equal(isFreeModel(entry({ pricing: { prompt: '0', completion: '0', discount: '-0.5' } })), false);
  });
});

describe('supportsTools', () => {
  test('reads the tools parameter from supported_parameters', () => {
    assert.equal(supportsTools(entry()), true);
    assert.equal(supportsTools(entry({ supported_parameters: ['temperature'] })), false);
    assert.equal(supportsTools(entry({ supported_parameters: undefined })), false);
    assert.equal(supportsTools(entry({ supported_parameters: 'tools' })), false);
  });
});

describe('projectFreeModels', () => {
  test('keeps only free models, tools-capable first then by context size', () => {
    const projected = projectFreeModels([
      entry({ id: 'a/small:free', context_length: 8_000 }),
      entry({ id: 'b/paid', pricing: { prompt: '1', completion: '1' } }),
      entry({ id: 'c/big-no-tools:free', context_length: 500_000, supported_parameters: [] }),
      entry({ id: 'd/big:free', context_length: 400_000 }),
      entry({ id: 'e/no-context:free', context_length: undefined }),
    ]);

    assert.deepEqual(
      projected.map((m) => m.id),
      ['d/big:free', 'a/small:free', 'e/no-context:free', 'c/big-no-tools:free'],
      'paid excluded; tools first (context descending), then the non-tools model',
    );
    assert.equal(projected[0]!.tools, true);
    assert.equal(projected[3]!.tools, false);
  });

  test('drops entries with no usable id and normalises missing fields', () => {
    const projected = projectFreeModels([
      { pricing: { prompt: '0', completion: '0' } }, // no id
      { id: '', pricing: { prompt: '0', completion: '0' } },
      entry({ id: 'x/y:free', name: undefined, context_length: undefined, architecture: undefined }),
    ]);
    assert.deepEqual(projected.map((m) => m.id), ['x/y:free']);
    assert.equal(projected[0]!.name, 'x/y:free', 'missing name falls back to the id');
    assert.equal(projected[0]!.contextLength, 0);
    assert.deepEqual(projected[0]!.modalities, []);
  });

  test('carries modalities through for the vision capability', () => {
    const projected = projectFreeModels([
      entry({ id: 'v/vl:free', architecture: { input_modalities: ['text', 'image'] } }),
    ]);
    assert.deepEqual(projected[0]!.modalities, ['text', 'image']);
  });
});

describe('toCatalogueModel', () => {
  test('maps a free model to a zero-priced catalogue row', () => {
    const free: FreeModel = {
      id: 'vendor/model:free',
      name: 'Vendor Model',
      contextLength: 200_000,
      tools: true,
      modalities: ['text', 'image'],
    };
    const model = toCatalogueModel(free);
    assert.equal(model.id, 'vendor/model:free');
    assert.equal(model.provider, 'openrouter');
    assert.equal(model.model, 'model:free');
    assert.equal(model.contextWindowTokens, 200_000);
    assert.equal(model.capabilities.tools, true);
    assert.equal(model.capabilities.vision, true);
    // Free means free: the catalogue row must not carry a price.
    assert.equal(model.pricing.inputMicrosPerMillion, 0);
    assert.equal(model.pricing.outputMicrosPerMillion, 0);
    // An empty allowlist means every workspace may use it.
    assert.deepEqual(model.allowedWorkspaceIds, []);
  });
});

describe('toPricedCatalogueModel', () => {
  test('prices a paid model from its per-token USD prices, in micro-dollars per million tokens', () => {
    const priced = toPricedCatalogueModel(
      entry({
        id: 'vendor/paid',
        pricing: { prompt: '0.0000015', completion: '0.000006', input_cache_read: '0.00000015', input_cache_write: '0.000001875' },
      }),
    );
    assert.ok(!('refused' in priced), 'a token-priced model can be catalogued');
    assert.deepEqual(priced.pricing, {
      inputMicrosPerMillion: 1_500_000,
      outputMicrosPerMillion: 6_000_000,
      cacheReadMicrosPerMillion: 150_000,
      cacheWriteMicrosPerMillion: 1_875_000,
    });
    assert.equal(priced.id, 'vendor/paid');
    assert.equal(priced.enabled, true);
  });

  test('refuses a model with a charge the catalogue cannot meter, so a spend cap would not see it', () => {
    for (const field of ['request', 'image', 'web_search']) {
      const priced = toPricedCatalogueModel(
        entry({ id: 'vendor/paid', pricing: { prompt: '0.000001', completion: '0.000002', [field]: '0.01' } }),
      );
      assert.ok('refused' in priced, `a non-zero '${field}' fee is refused`);
      assert.match(priced.refused, new RegExp(field));
    }
  });

  test('accepts reasoning tokens priced no higher than output tokens, which output metering covers', () => {
    const same = toPricedCatalogueModel(
      entry({ pricing: { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000002' } }),
    );
    assert.ok(!('refused' in same));
    const dearer = toPricedCatalogueModel(
      entry({ pricing: { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000004' } }),
    );
    assert.ok('refused' in dearer, 'reasoning dearer than output would be under-metered');
  });

  test('refuses missing or non-numeric token prices rather than reading them as zero', () => {
    assert.ok('refused' in toPricedCatalogueModel(entry({ pricing: {} })));
    assert.ok('refused' in toPricedCatalogueModel(entry({ pricing: { prompt: '', completion: '0.000002' } })));
    assert.ok('refused' in toPricedCatalogueModel(entry({ pricing: { prompt: 'n/a', completion: '0.000002' } })));
    assert.ok('refused' in toPricedCatalogueModel(entry({ pricing: { prompt: '-1', completion: '0.000002' } })));
  });
});

describe('ModelDiscovery', () => {
  const body = { data: [entry({ id: 'a/b:free' }), entry({ id: 'p/q', pricing: { prompt: '1', completion: '1' } })] };

  function fakeFetch(): { fetch: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = (() => {
      calls++;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch;
    return { fetch: impl, calls: () => calls };
  }

  test('lists free models and caches the fetch', async () => {
    const { fetch, calls } = fakeFetch();
    const discovery = new ModelDiscovery({ apiKey: 'k', fetch, clock: { now: () => 1000 } });
    const first = await discovery.listFreeModels();
    const second = await discovery.listFreeModels();
    assert.deepEqual(first.map((m) => m.id), ['a/b:free']);
    assert.equal(second.length, 1);
    assert.equal(calls(), 1, 'the second call is served from cache');
  });

  test('re-fetches once the cache expires', async () => {
    const { fetch, calls } = fakeFetch();
    let now = 1000;
    const discovery = new ModelDiscovery({
      apiKey: 'k',
      fetch,
      clock: { now: () => now },
      cacheMs: 500,
    });
    await discovery.listFreeModels();
    now = 1200;
    await discovery.listFreeModels();
    assert.equal(calls(), 1, 'still cached at +200ms');
    now = 2000;
    await discovery.listFreeModels();
    assert.equal(calls(), 2, 'expired at +1000ms');
  });

  test('catalogueModelFor refuses an id the provider does not offer free', async () => {
    const { fetch } = fakeFetch();
    const discovery = new ModelDiscovery({ apiKey: 'k', fetch, clock: { now: () => 1000 } });
    assert.ok(await discovery.catalogueModelFor('a/b:free'), 'a free id resolves');
    assert.equal(
      await discovery.catalogueModelFor('p/q'),
      undefined,
      'a paid id must not resolve to a catalogue row',
    );
    assert.equal(await discovery.catalogueModelFor('nope/nope:free'), undefined);
  });

  test('a non-OK provider response surfaces rather than reporting "no models"', async () => {
    // An empty picker and "the provider is down" are different facts; a caller
    // must be able to tell them apart.
    const failing = (() =>
      Promise.resolve(new Response('nope', { status: 503 }))) as unknown as typeof fetch;
    const discovery = new ModelDiscovery({ apiKey: 'k', fetch: failing, clock: { now: () => 1000 } });
    await assert.rejects(discovery.listFreeModels(), /503/);
  });

  test('an unusable upstream answer is a 503 "unavailable", never an internal error', async () => {
    // A captive portal answering 200 with HTML, a JSON null, a reshaped payload,
    // a refused connection: each is "the provider catalogue is unavailable right
    // now", which the API must say as such rather than as a 500.
    const answers: (() => Promise<Response>)[] = [
      () => Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })),
      () => Promise.resolve(new Response('null', { status: 200 })),
      () => Promise.resolve(new Response('{"data":{"id":"x"}}', { status: 200 })),
      () => Promise.resolve(new Response('nope', { status: 502 })),
      () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    ];
    for (const [index, answer] of answers.entries()) {
      const discovery = new ModelDiscovery({
        apiKey: 'sk-or-secret',
        fetch: answer as unknown as typeof fetch,
        clock: { now: () => 1000 },
      });
      await assert.rejects(discovery.listFreeModels(), (error: unknown) => {
        assert.ok(MaError.is(error), `answer ${index}: a classified MaError`);
        assert.equal(error.status, 503, `answer ${index}: unavailable, not internal`);
        assert.equal(error.code, 'MODEL_DISCOVERY_UNAVAILABLE');
        assert.doesNotMatch(error.message, /sk-or-secret/);
        return true;
      });
    }
  });

  test('a malformed entry is skipped, not allowed to fail the whole list', async () => {
    const payload = { data: [null, 7, 'x', { id: 'a/b:free', pricing: { prompt: '0', completion: '0' } }] };
    const discovery = new ModelDiscovery({
      apiKey: 'k',
      fetch: (() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))) as unknown as typeof fetch,
      clock: { now: () => 1000 },
    });
    assert.deepEqual((await discovery.listFreeModels()).map((m) => m.id), ['a/b:free']);
  });

  test('prices a list of models in one fetch, and says why one cannot be used', async () => {
    const payload = {
      data: [
        entry({ id: 'p/q', pricing: { prompt: '0.000001', completion: '0.000002' } }),
        entry({ id: 'p/fee', pricing: { prompt: '0.000001', completion: '0.000002', request: '0.02' } }),
      ],
    };
    let calls = 0;
    const discovery = new ModelDiscovery({
      apiKey: 'k',
      fetch: (() => {
        calls++;
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }) as unknown as typeof fetch,
      clock: { now: () => 1000 },
    });
    const priced = await discovery.pricedModelsFor(['p/q', 'p/fee', 'p/missing']);
    assert.equal(calls, 1);
    const q = priced.get('p/q');
    assert.ok(q && !('refused' in q) && q.pricing.inputMicrosPerMillion === 1_000_000);
    const fee = priced.get('p/fee');
    assert.ok(fee && 'refused' in fee && /request/.test(fee.refused));
    const missing = priced.get('p/missing');
    assert.ok(missing && 'refused' in missing && /not offered/.test(missing.refused));
  });

  test('registration checks the live catalogue, not the cached list', async () => {
    // A model that stopped being free inside the cache window must not be
    // catalogued at a price of zero on the strength of a ten-minute-old answer.
    let priced = false;
    const discovery = new ModelDiscovery({
      apiKey: 'k',
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [entry({ id: 'a/b:free', pricing: priced ? { prompt: '1', completion: '1' } : { prompt: '0', completion: '0' } })],
            }),
            { status: 200 },
          ),
        )) as unknown as typeof fetch,
      clock: { now: () => 1000 },
    });
    assert.deepEqual((await discovery.listFreeModels()).map((m) => m.id), ['a/b:free'], 'cached as free');
    priced = true;
    assert.equal(await discovery.catalogueModelFor('a/b:free'), undefined, 'the live catalogue says it is paid now');
  });
});
