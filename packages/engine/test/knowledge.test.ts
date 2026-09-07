/**
 * Knowledge tests.
 *
 * Chunking and scoring are where retrieval quietly goes wrong: a chunk cut
 * mid-sentence retrieves badly, and a scorer that rewards length returns the
 * longest document to every query.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TestClock, newId, nullLogger } from '@ma/core';
import type { Document } from '@ma/contracts';
import { createMemoryStore, type SqliteStore } from '@ma/store';

import {
  IngestionPipeline,
  KeywordIndex,
  RetrievalService,
  chunkText,
  type Chunk,
} from '../src/index.ts';

const START = 1_700_000_000_000;

describe('chunking', () => {
  test('returns short text whole', () => {
    assert.deepEqual(chunkText('a short note'), ['a short note']);
  });

  test('returns nothing for empty input', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n\n  '), []);
  });

  test('splits on paragraph boundaries rather than mid-sentence', () => {
    // A chunk cut mid-sentence retrieves badly and reads worse when quoted.
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}. `.repeat(20));
    const chunks = chunkText(paragraphs.join('\n\n'), { size: 600, overlap: 0 });

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.equal(chunk, chunk.trim(), 'chunks must not carry ragged whitespace');
    }
  });

  test('overlaps so a fact spanning a boundary survives whole', () => {
    const text = Array.from({ length: 10 }, (_, index) => `Section ${index} content here.`.repeat(10)).join(
      '\n\n',
    );
    const withOverlap = chunkText(text, { size: 500, overlap: 120 });
    const without = chunkText(text, { size: 500, overlap: 0 });

    const overlapChars = withOverlap.join('').length;
    const plainChars = without.join('').length;
    assert.ok(overlapChars > plainChars, 'overlap must actually duplicate the boundary text');
  });

  test('splits an oversized paragraph on sentences', () => {
    const long = Array.from({ length: 40 }, (_, index) => `Sentence number ${index}.`).join(' ');
    const chunks = chunkText(long, { size: 200, overlap: 0 });

    assert.ok(chunks.length > 1);
    // Not a hard guarantee for every chunk, but a mid-word split would show up
    // as a trailing fragment on most of them.
    assert.ok(chunks.filter((chunk) => /\.$|\.\s*$/.test(chunk)).length >= chunks.length - 1);
  });
});

describe('keyword index', () => {
  let index: KeywordIndex;

  function chunk(datasetId: string, text: string, documentId = 'dc_1', position = 0): Chunk {
    return { datasetId, documentId, index: position, text, source: 'doc.md' };
  }

  beforeEach(async () => {
    index = new KeywordIndex();
    await index.add([
      chunk('ds_1', 'The deployment runbook describes how to roll back a release safely.'),
      chunk('ds_1', 'Database migrations run automatically during deployment.', 'dc_2'),
      chunk('ds_1', 'Contact the on-call engineer for production incidents.', 'dc_3'),
      chunk('ds_2', 'A completely unrelated document about gardening and tomatoes.', 'dc_4'),
    ]);
  });

  test('finds chunks that share the query’s vocabulary', async () => {
    const results = await index.search(['ds_1'], 'rollback deployment runbook', 5);
    assert.ok(results.length > 0);
    assert.ok(results[0]!.text.includes('runbook'));
  });

  test('never returns a chunk from a dataset the caller cannot see', async () => {
    // Dataset scoping is an isolation boundary, not a filter for convenience.
    const results = await index.search(['ds_1'], 'gardening tomatoes', 5);
    assert.equal(results.length, 0);

    const scoped = await index.search(['ds_2'], 'gardening tomatoes', 5);
    assert.equal(scoped.length, 1);
  });

  test('ranks the better match first', async () => {
    const results = await index.search(['ds_1'], 'database migrations', 5);
    assert.ok(results[0]!.text.includes('migrations'));
  });

  test('discounts terms that appear everywhere', async () => {
    const common = new KeywordIndex();
    await common.add([
      chunk('ds_1', 'deployment deployment deployment rare-term-xyz'),
      chunk('ds_1', 'deployment deployment deployment', 'dc_2'),
      chunk('ds_1', 'deployment deployment deployment', 'dc_3'),
    ]);

    // "deployment" is in every chunk and so carries almost no signal; the rare
    // term is what should decide the ranking.
    const results = await common.search(['ds_1'], 'rare-term-xyz', 5);
    assert.equal(results.length, 1);
    assert.ok(results[0]!.text.includes('rare-term-xyz'));
  });

  test('does not let a long chunk win on length alone', async () => {
    const lengths = new KeywordIndex();
    await lengths.add([
      chunk('ds_1', 'incident response'),
      chunk('ds_1', 'incident response ' + 'padding words here '.repeat(200), 'dc_2'),
    ]);

    const results = await lengths.search(['ds_1'], 'incident response', 5);
    assert.ok(
      results[0]!.text.length < 100,
      'the concise chunk answers the query; the padded one merely contains it',
    );
  });

  test('ignores stop words and single characters', async () => {
    assert.deepEqual(await index.search(['ds_1'], 'the a of', 5), []);
  });

  test('matches a word regardless of the punctuation around it', async () => {
    // Sentence-final punctuation must not make `telnet.` a different term from
    // `telnet`, or the obvious query silently returns nothing.
    const punctuated = new KeywordIndex();
    await punctuated.add([chunk('ds_1', 'The old procedure used telnet.')]);
    assert.equal((await punctuated.search(['ds_1'], 'telnet', 5)).length, 1);
    assert.equal((await punctuated.search(['ds_1'], 'telnet.', 5)).length, 1);
  });

  test('keeps identifiers intact', async () => {
    // Operational corpora are full of these, and splitting them loses exactly
    // the terms someone would search for.
    const identifiers = new KeywordIndex();
    await identifiers.add([
      chunk('ds_1', 'Call api.getUser when MAX_RETRY_COUNT is exceeded in payment-service.'),
    ]);

    for (const query of ['api.getuser', 'max_retry_count', 'payment-service']) {
      assert.equal((await identifiers.search(['ds_1'], query, 5)).length, 1, query);
    }
  });

  test('removes a document’s chunks completely', async () => {
    const before = index.size();
    await index.removeDocument('dc_2');
    assert.equal(index.size(), before - 1);
    assert.equal((await index.search(['ds_1'], 'migrations', 5)).length, 0);
  });

  test('respects the result limit', async () => {
    const results = await index.search(['ds_1'], 'deployment production database', 2);
    assert.ok(results.length <= 2);
  });
});

describe('ingestion', () => {
  let store: SqliteStore;
  let clock: TestClock;
  let index: KeywordIndex;
  let pipeline: IngestionPipeline;
  let datasetId: string;
  let workspaceId: string;

  async function makeDocument(name: string, content: string): Promise<Document> {
    const now = clock.now();
    const document = await store.documents.create({
      id: newId('document', now),
      datasetId,
      workspaceId,
      name,
      source: 'inline',
      sourceRef: '',
      contentType: 'text/plain',
      sizeBytes: 0,
      digest: '',
      status: 'pending',
      syncRule: 'manual',
      chunkCount: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'pr_test',
    });
    pipeline.stage(document.id, content);
    return document;
  }

  beforeEach(async () => {
    store = createMemoryStore();
    clock = new TestClock(START);
    index = new KeywordIndex();
    pipeline = new IngestionPipeline({ store, clock, index, logger: nullLogger });

    const workspace = await store.workspaces.create({
      id: newId('workspace'),
      slug: 'knowledge-team',
      name: 'Knowledge',
      description: '',
      status: 'active',
      members: [],
      quota: {
        maxConcurrentSessions: 20,
        maxSandboxes: 20,
        maxTokensPerDay: 1_000_000,
        maxStorageMb: 1024,
        maxAgents: 100,
        eventRetentionDays: 90,
      },
      systemPrompt: '',
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'pr_test',
    });
    workspaceId = workspace.id;

    const dataset = await store.datasets.create({
      id: newId('dataset'),
      workspaceId,
      name: 'Runbooks',
      description: '',
      status: 'active',
      documentCount: 0,
      chunkCount: 0,
      sizeBytes: 0,
      embeddingModel: '',
      metadata: {},
      createdAt: START,
      updatedAt: START,
      createdBy: 'pr_test',
    });
    datasetId = dataset.id;
  });

  afterEach(async () => {
    await store.close();
  });

  test('ingests a document and makes it searchable', async () => {
    const document = await makeDocument('runbook.md', 'How to restart the payment service safely.');
    await pipeline.process(document);

    const stored = await store.documents.get(document.id);
    assert.equal(stored?.status, 'ready');
    assert.ok(stored!.chunkCount > 0);
    assert.ok(stored!.digest.length > 0);

    const results = await index.search([datasetId], 'restart payment service', 5);
    assert.equal(results.length, 1);
  });

  test('updates the dataset’s totals', async () => {
    const document = await makeDocument('a.md', 'Some indexed content about caching.');
    await pipeline.process(document);

    const dataset = await store.datasets.get(datasetId);
    assert.ok(dataset!.chunkCount > 0);
    assert.ok(dataset!.sizeBytes > 0);
  });

  test('reads current state rather than trusting a stale copy', async () => {
    // A scheduler may hold a row it fetched a minute ago. Deciding from that —
    // particularly the unchanged-digest skip — would silently drop an update.
    const document = await makeDocument('drifting.md', 'first version');
    await pipeline.process(document);

    pipeline.stage(document.id, 'second version entirely different');
    await store.documents.update(document.id, { status: 'pending' });
    // Deliberately the *original* object, whose digest and chunkCount are stale.
    await pipeline.process(document);

    assert.equal((await index.search([datasetId], 'entirely different', 5)).length, 1);
  });

  test('skips re-embedding unchanged content', async () => {
    // A daily re-sync of an unchanged document should cost nothing.
    const document = await makeDocument('stable.md', 'This content does not change.');
    await pipeline.process(document);

    const first = await store.documents.get(document.id);
    await store.documents.update(document.id, { status: 'pending' });
    await pipeline.process(first!);

    const second = await store.documents.get(document.id);
    assert.equal(second?.status, 'ready');
    assert.equal(second?.chunkCount, first?.chunkCount);
    assert.equal(index.size(), first!.chunkCount, 'chunks must not be duplicated');
  });

  test('replaces old chunks when content changes', async () => {
    // Otherwise the previous version keeps answering queries alongside the new.
    const document = await makeDocument('changing.md', 'The old procedure used telnet.');
    await pipeline.process(document);
    assert.equal((await index.search([datasetId], 'telnet', 5)).length, 1);

    pipeline.stage(document.id, 'The new procedure uses ssh exclusively.');
    await store.documents.update(document.id, { status: 'pending' });
    await pipeline.process((await store.documents.get(document.id))!);

    assert.equal((await index.search([datasetId], 'telnet', 5)).length, 0, 'stale content must go');
    assert.equal((await index.search([datasetId], 'ssh', 5)).length, 1);
  });

  test('records a failure with its reason rather than retrying silently', async () => {
    const now = clock.now();
    const orphan = await store.documents.create({
      id: newId('document', now),
      datasetId,
      workspaceId,
      name: 'missing.md',
      source: 'inline',
      sourceRef: '',
      contentType: 'text/plain',
      sizeBytes: 0,
      digest: '',
      status: 'pending',
      syncRule: 'manual',
      chunkCount: 0,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      createdBy: 'pr_test',
    });

    // No content staged, so ingestion cannot proceed.
    await pipeline.process(orphan);

    const stored = await store.documents.get(orphan.id);
    assert.equal(stored?.status, 'failed');
    assert.equal(stored?.error?.code, 'INGESTION_FAILED');
    assert.ok(stored?.error?.retryable, 'an operator can fix the source and retry');
  });

  test('processNext reports when there is nothing to do', async () => {
    assert.equal(await pipeline.processNext(), false);
    await makeDocument('queued.md', 'Pending content.');
    assert.equal(await pipeline.processNext(), true);
    assert.equal(await pipeline.processNext(), false);
  });
});

describe('retrieval', () => {
  test('returns nothing when no datasets are bound', async () => {
    const service = new RetrievalService({ index: new KeywordIndex() });
    assert.deepEqual(await service.search([], 'anything'), []);
  });

  test('truncates a long chunk before handing it to a model', async () => {
    const index = new KeywordIndex();
    await index.add([
      {
        datasetId: 'ds_1',
        documentId: 'dc_1',
        index: 0,
        text: 'incident ' + 'x'.repeat(5000),
        source: 'big.md',
      },
    ]);

    const service = new RetrievalService({ index, maxChunkChars: 100 });
    const results = await service.search(['ds_1'], 'incident');
    assert.ok(results[0]!.text.length <= 101);
    assert.ok(results[0]!.text.endsWith('…'), 'truncation must be visible');
  });

  test('formats results with citations', async () => {
    const index = new KeywordIndex();
    await index.add([
      {
        datasetId: 'ds_1',
        documentId: 'dc_1',
        index: 3,
        text: 'Restart with systemctl.',
        source: 'runbook.md',
      },
    ]);

    const service = new RetrievalService({ index });
    const formatted = service.format(await service.search(['ds_1'], 'restart systemctl'));

    // An agent that can attribute a claim is one an operator can check.
    assert.ok(formatted.includes('runbook.md'));
    assert.ok(formatted.includes('[1]'));
    assert.ok(formatted.includes('systemctl'));
  });

  test('says so plainly when nothing matched', async () => {
    const service = new RetrievalService({ index: new KeywordIndex() });
    assert.equal(service.format([]), 'No relevant documents were found.');
  });
});
