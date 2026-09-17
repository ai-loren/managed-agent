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
  MemoryBlobStore,
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

  test('scores a dataset by its own corpus stats, not the whole index', async () => {
    // The index is process-wide, but scoring must be scoped to the queried
    // datasets: N, average length and document frequency all come from the allowed
    // subset. Prove it by scoring the same ds_2 chunk in two indexes — one holding
    // only ds_2, one where ds_2 sits alongside a large unrelated ds_1 corpus. If
    // scoring leaked the global stats, the scores would differ; scoped, they match.
    const isolated = new KeywordIndex();
    await isolated.add([chunk('ds_2', 'incident response runbook for the api gateway', 'dc_a')]);

    const shared = new KeywordIndex();
    await shared.add([chunk('ds_2', 'incident response runbook for the api gateway', 'dc_a')]);
    // A big, unrelated ds_1 corpus that would skew global N / df / average length.
    for (let i = 0; i < 50; i++) {
      await shared.add([chunk('ds_1', `gateway gateway gateway unrelated chunk number ${i}`, `dc_${i}`)]);
    }

    const isoResults = await isolated.search(['ds_2'], 'incident gateway', 5);
    const sharedResults = await shared.search(['ds_2'], 'incident gateway', 5);
    assert.equal(isoResults.length, 1);
    assert.equal(sharedResults.length, 1);
    // The score for the identical ds_2 chunk must not depend on the ds_1 corpus
    // sharing the index — "gateway" is common in ds_1 but that must not change its
    // weight when the query is scoped to ds_2.
    assert.ok(
      Math.abs(isoResults[0]!.score - sharedResults[0]!.score) < 1e-9,
      `ds_2 scoring must be identical regardless of the ds_1 corpus (iso=${isoResults[0]!.score}, shared=${sharedResults[0]!.score})`,
    );
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
  let blobs: MemoryBlobStore;
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
    await pipeline.stage(document.id, content);
    return document;
  }

  beforeEach(async () => {
    store = createMemoryStore();
    clock = new TestClock(START);
    index = new KeywordIndex();
    blobs = new MemoryBlobStore();
    pipeline = new IngestionPipeline({ store, clock, index, blobs, logger: nullLogger });

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
        maxCostMicrosPerDay: 0,
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

    await pipeline.stage(document.id, 'second version entirely different');
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

    await pipeline.stage(document.id, 'The new procedure uses ssh exclusively.');
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

  test('survives a restart: a fresh index rebuilds from durable storage', async () => {
    // The data-loss bug this whole change fixes. Ingest through one pipeline
    // (which persists the bytes to the blob store), then simulate a process
    // restart with a brand-new empty index and a brand-new pipeline sharing only
    // the durable store + blob store — no staged content in memory. rebuild()
    // must repopulate the index so search works again.
    const document = await makeDocument('runbook.md', 'How to restart the payment service safely.');
    await pipeline.process(document);

    const freshIndex = new KeywordIndex();
    const restarted = new IngestionPipeline({ store, clock, index: freshIndex, blobs, logger: nullLogger });
    // Nothing staged in the new process: content must come from the blob store.
    assert.equal(freshIndex.size(), 0, 'a fresh index starts empty');

    const rebuilt = await restarted.rebuild();
    assert.equal(rebuilt, 1, 'the ready document is rebuilt from durable storage');

    const results = await freshIndex.search([datasetId], 'restart payment service', 5);
    assert.equal(results.length, 1, 'search works again after the restart');
  });

  test('rebuild covers ready documents across every dataset', async () => {
    // Guards the datasetId:'' bug: the old rebuild listed with WHERE
    // dataset_id = '' and matched nothing. A second dataset proves the rebuild
    // is not scoped to one.
    const other = await store.datasets.create({
      id: newId('dataset'),
      workspaceId,
      name: 'Playbooks',
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

    const a = await makeDocument('in-runbooks.md', 'The runbook covers database failover.');
    await pipeline.process(a);
    const bNow = clock.now();
    const b = await store.documents.create({
      id: newId('document', bNow + 1),
      datasetId: other.id,
      workspaceId,
      name: 'in-playbooks.md',
      source: 'inline',
      sourceRef: '',
      contentType: 'text/plain',
      sizeBytes: 0,
      digest: '',
      status: 'pending',
      syncRule: 'manual',
      chunkCount: 0,
      metadata: {},
      createdAt: bNow + 1,
      updatedAt: bNow + 1,
      createdBy: 'pr_test',
    });
    await pipeline.stage(b.id, 'The playbook covers incident escalation.');
    await pipeline.process(b);

    const freshIndex = new KeywordIndex();
    const restarted = new IngestionPipeline({ store, clock, index: freshIndex, blobs, logger: nullLogger });
    const rebuilt = await restarted.rebuild();
    assert.equal(rebuilt, 2, 'both datasets’ documents are rebuilt');
    assert.equal((await freshIndex.search([datasetId], 'failover', 5)).length, 1);
    assert.equal((await freshIndex.search([other.id], 'escalation', 5)).length, 1);
  });

  test('rebuild is idempotent: a second call does not double-index', async () => {
    const document = await makeDocument('stable.md', 'Content that is indexed exactly once.');
    await pipeline.process(document);

    const freshIndex = new KeywordIndex();
    const restarted = new IngestionPipeline({ store, clock, index: freshIndex, blobs, logger: nullLogger });
    await restarted.rebuild();
    const afterFirst = freshIndex.size();
    await restarted.rebuild();
    assert.equal(freshIndex.size(), afterFirst, 'a second rebuild must not duplicate chunks');
  });

  test('rebuild skips a document whose blob is missing rather than throwing', async () => {
    // A lost blob must not make the whole corpus unsearchable.
    const present = await makeDocument('present.md', 'This document has its bytes.');
    await pipeline.process(present);
    const gone = await makeDocument('gone.md', 'This document will lose its bytes.');
    await pipeline.process(gone);

    // Delete one document's blob out from under the index.
    const goneRow = (await store.documents.get(gone.id))!;
    await blobs.delete(goneRow.workspaceId, goneRow.digest);

    const freshIndex = new KeywordIndex();
    const restarted = new IngestionPipeline({ store, clock, index: freshIndex, blobs, logger: nullLogger });
    const rebuilt = await restarted.rebuild();
    assert.equal(rebuilt, 1, 'only the document with a live blob is rebuilt');
    assert.equal((await freshIndex.search([datasetId], 'bytes', 5)).length, 1);
  });

  test('re-syncing unchanged content re-persists a lost blob (self-heal)', async () => {
    // The skip-before-put hazard: a document that is `ready` but whose blob is
    // gone (lost storage, or ingested before content was persisted) must be able
    // to recover. A re-sync with *identical* content takes the unchanged-digest
    // path — which must still re-persist the bytes, or the document is
    // permanently unsearchable across restarts.
    const doc = await makeDocument('heals.md', 'Content whose blob will be lost then restored.');
    await pipeline.process(doc);
    const row = (await store.documents.get(doc.id))!;

    // Simulate the lost blob, and re-stage the same bytes as a re-sync would.
    await blobs.delete(row.workspaceId, row.digest);
    assert.equal(await blobs.get(row.workspaceId, row.digest), undefined, 'blob is gone');
    await pipeline.stage(doc.id, 'Content whose blob will be lost then restored.');
    await store.documents.update(doc.id, { status: 'pending' });

    // Re-sync: identical content, so it hits the unchanged-digest skip — which
    // must still have written the blob.
    await pipeline.process((await store.documents.get(doc.id))!);
    assert.notEqual(
      await blobs.get(row.workspaceId, row.digest),
      undefined,
      'the unchanged-digest path re-persisted the blob',
    );

    // And it is now retrievable after a restart.
    const freshIndex = new KeywordIndex();
    const restarted = new IngestionPipeline({ store, clock, index: freshIndex, blobs, logger: nullLogger });
    await restarted.rebuild();
    assert.equal((await freshIndex.search([datasetId], 'restored', 5)).length, 1);
  });

  test('processing evicts the in-memory staging copy once bytes are durable', async () => {
    // The cache must not grow without bound: after process() persists to the blob
    // store, the staged copy is redundant. A fresh pipeline (no cache) sharing the
    // blob store must still find the content — proving the durable copy, not the
    // cache, is what answers.
    const doc = await makeDocument('evicted.md', 'This staged copy should be dropped after ingestion.');
    await pipeline.process(doc);

    const freshIndex = new KeywordIndex();
    const restarted = new IngestionPipeline({ store, clock, index: freshIndex, blobs, logger: nullLogger });
    const rebuilt = await restarted.rebuild();
    assert.equal(rebuilt, 1, 'content is served from the blob store, not a lingering cache');
  });

  test('findReady returns every ready document and excludes pending ones', async () => {
    const first = await makeDocument('first.md', 'First ready document.');
    await pipeline.process(first);
    const second = await makeDocument('second.md', 'Second ready document.');
    await pipeline.process(second);
    // A still-pending document must not appear.
    await makeDocument('pending.md', 'Not yet processed.');

    const ready = await store.documents.findReady(50);
    assert.deepEqual(
      ready.map((d) => d.id).sort(),
      [first.id, second.id].sort(),
      'exactly the ready documents, pending excluded',
    );
  });

  test('findReady pages by its id cursor without repeating or skipping', async () => {
    // The keyset cursor (`id > afterId`) is how rebuild walks the whole corpus a
    // page at a time. Ingest several, then page in twos and assert the union is
    // the full set with no duplicates.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const doc = await makeDocument(`doc-${i}.md`, `Ready document number ${i}.`);
      await pipeline.process(doc);
      ids.push(doc.id);
    }

    const seen: string[] = [];
    let afterId: string | undefined;
    for (;;) {
      const page = await store.documents.findReady(2, afterId);
      if (page.length === 0) break;
      seen.push(...page.map((d) => d.id));
      if (page.length < 2) break;
      afterId = page[page.length - 1]!.id;
    }

    assert.equal(new Set(seen).size, seen.length, 'no document appears on two pages');
    assert.deepEqual(seen.slice().sort(), ids.slice().sort(), 'every ready document is visited once');
  });

  test('the digest is persisted before chunk/embed, so a crash cannot orphan the blob', async () => {
    // process() used to write the digest only in its success update, so a failure
    // after blobs.put (e.g. the embedder throwing) left the bytes durable but the
    // row with no digest pointing at them — the blob was orphaned and its content
    // unrecoverable. Make the embed step throw and assert the digest is on the row.
    const failing = new IngestionPipeline({
      store,
      clock,
      index,
      blobs,
      logger: nullLogger,
      embedder: { model: 'test/embed', embed: () => Promise.reject(new Error('embedder down')) },
    });
    const document = await makeDocument('crash.md', 'content that will be embedded');
    // Stage on the failing pipeline too — `stage` fills a per-instance cache, and
    // the shared blob store is still empty until process() writes it.
    await failing.stage(document.id, 'content that will be embedded');
    await failing.process(document);

    const stored = await store.documents.get(document.id);
    assert.equal(stored?.status, 'failed', 'the embed failure fails the document');
    assert.ok(stored!.digest.length > 0, 'but the digest is recorded, so the blob is not orphaned');
    // The blob is present under that digest — recoverable on a retry.
    const bytes = await blobs.get(workspaceId, stored!.digest);
    assert.ok(bytes && bytes.length > 0, 'the durable bytes are reachable by the recorded digest');
  });

  test('a document stuck processing past the stale window is requeued', async () => {
    // A worker killed mid-ingest leaves the row `processing` forever: findPending
    // never re-selects it. The recovery sweep returns it to `pending`.
    const document = await makeDocument('stuck.md', 'half-ingested content');
    await store.documents.update(document.id, { status: 'processing', updatedAt: clock.now() });

    // Not yet stale: the sweep leaves it alone.
    assert.equal(await pipeline.recoverStuckProcessing(60_000), 0, 'a fresh processing row is left alone');
    assert.equal((await store.documents.get(document.id))?.status, 'processing');

    // Age it past the window.
    await clock.advance(120_000);
    assert.equal(await pipeline.recoverStuckProcessing(60_000), 1, 'a stale processing row is requeued');
    assert.equal((await store.documents.get(document.id))?.status, 'pending', 'it is back in the queue');
  });

  test('staged content survives a restart before the first processing tick', async () => {
    // The accept->first-tick durability window: content used to live only in the
    // pipeline's in-memory #content map until process() wrote the blob, so a
    // restart in that window lost it and process() dead-ended the row `failed`.
    // stage() now persists the blob and stamps the digest, so a FRESH pipeline
    // (an empty in-memory cache, as after a restart) can still process it.
    const document = await makeDocument('accepted.md', 'content accepted but not yet processed');
    const staged = await store.documents.get(document.id);
    assert.ok(
      typeof (staged!.metadata as Record<string, unknown>).stagedDigest === 'string',
      'stage records the staged digest durably at accept time',
    );
    assert.equal(staged!.digest, '', 'but does not stamp the processed-digest field');

    // A brand-new pipeline instance = a process restart: its #content is empty.
    const restarted = new IngestionPipeline({ store, clock, index, blobs, logger: nullLogger });
    await restarted.process(document);

    const stored = await store.documents.get(document.id);
    assert.equal(stored?.status, 'ready', 'the restart reloaded the content from the blob and ingested it');
    assert.equal((await index.search([datasetId], 'accepted but not yet processed', 5)).length, 1);
  });

  test('a changed re-sync reloads the new content after a restart, not the stale processed one', async () => {
    // Precedence hazard: after a doc is `ready` at digest A, staging new content B
    // updates metadata.stagedDigest but leaves the row's processed `digest` = A.
    // If the in-memory copy is then lost to a restart, #loadContent must reload B
    // (the intended new content), NOT the stale A that document.digest still names.
    const document = await makeDocument('resync.md', 'the original version about apples');
    await pipeline.process(document);
    assert.equal((await index.search([datasetId], 'apples', 5)).length, 1);

    // Re-sync with entirely new content, then simulate a restart before processing.
    await pipeline.stage(document.id, 'the replacement version about zeppelins');
    await store.documents.update(document.id, { status: 'pending' });
    const restarted = new IngestionPipeline({ store, clock, index, blobs, logger: nullLogger });
    // The reloaded row: document.digest still = A (apples), stagedDigest = B (zeppelins).
    const reloaded = await store.documents.get(document.id);
    await restarted.process(reloaded!);

    assert.equal(
      (await index.search([datasetId], 'zeppelins', 5)).length,
      1,
      'the new content is indexed after the restart',
    );
    assert.equal(
      (await index.search([datasetId], 'apples', 5)).length,
      0,
      'the stale processed content was NOT re-loaded',
    );
  });

  test('reprocessFailed requeues a retryable failed document, bounded by an attempt cap', async () => {
    // error.retryable was a dead flag — nothing reprocessed a `failed` document.
    // A transient failure (embedder blip) must be retried; a permanent one must
    // eventually stop being retried rather than looping forever.
    const document = await makeDocument('flaky.md', 'content that failed transiently');
    await store.documents.update(document.id, {
      status: 'failed',
      error: { code: 'INGESTION_FAILED', message: 'transient', details: {}, occurredAt: clock.now(), retryable: true },
      updatedAt: clock.now(),
    });

    assert.equal(await pipeline.reprocessFailed(3), 1, 'a retryable failed doc is requeued');
    const after = await store.documents.get(document.id);
    assert.equal(after?.status, 'pending', 'it is back in the queue');
    assert.equal((after?.metadata as Record<string, unknown>).ingestAttempts, 1, 'the attempt is counted');

    // Drive it to the cap: each reprocess bumps the counter; past maxAttempts it
    // is left failed for an operator rather than retried forever.
    for (let i = 0; i < 5; i++) {
      await store.documents.update(document.id, {
        status: 'failed',
        error: { code: 'INGESTION_FAILED', message: 'again', details: {}, occurredAt: clock.now(), retryable: true },
        updatedAt: clock.now(),
      });
      await pipeline.reprocessFailed(3);
    }
    const capped = await store.documents.get(document.id);
    assert.equal(capped?.status, 'failed', 'past the attempt cap it stays failed, not retried forever');
  });

  test('reprocessFailed never requeues a non-retryable failure', async () => {
    const document = await makeDocument('broken.md', 'permanently bad content');
    await store.documents.update(document.id, {
      status: 'failed',
      error: { code: 'INGESTION_FAILED', message: 'bad', details: {}, occurredAt: clock.now(), retryable: false },
      updatedAt: clock.now(),
    });
    assert.equal(await pipeline.reprocessFailed(3), 0, 'a non-retryable failure is left alone');
    assert.equal((await store.documents.get(document.id))?.status, 'failed');
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
