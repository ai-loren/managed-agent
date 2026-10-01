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

import {
  ModelDiscovery,
  isFreeModel,
  projectFreeModels,
  supportsTools,
  toCatalogueModel,
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
});
