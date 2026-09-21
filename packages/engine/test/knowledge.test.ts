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

  test('hard-caps a chunk even with no sentence punctuation (DoS guard)', () => {
    // A document with no `.!?` and no blank lines is one giant "sentence". Left
    // whole it becomes a single unbounded chunk, and search cost + the stored
    // frequency map scale with chunk length — so one such document turns every
    // later query into a synchronous event-loop stall. Every emitted chunk must
    // respect `size` regardless of punctuation.
    const size = 500;
    const blob = 'token '.repeat(20_000); // ~120K chars, no .!?, no blank lines
    const chunks = chunkText(blob, { size, overlap: 0 });
    assert.ok(chunks.length > 100, 'the blob is broken into many bounded chunks, not one');
    for (const chunk of chunks) {
      assert.ok(chunk.length <= size, `every chunk is <= size (${chunk.length} > ${size})`);
    }
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
        maxKnowledgeChunks: 100_000,
        eventRetentionDays: 90,
      },
      systemPrompt: '',
      version: 1,
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

  test('claimForProcessing lets exactly one worker claim a pending document', async () => {
    // The pending→processing edge is the ingestion serialization point. Two
    // workers (two replicas, or a retry) both find the pending row; the atomic
    // claim must let exactly one advance, or both would ingest and each apply the
    // chunk-rollup delta, permanently double-counting the quota basis.
    const document = await makeDocument('claimed.md', 'Content about the deploy pipeline.');
    const first = store.documents.claimForProcessing(document.id, 'tok-a', START + 1);
    const second = store.documents.claimForProcessing(document.id, 'tok-b', START + 2);
    assert.equal(first, true, 'the first worker claims the pending document');
    assert.equal(second, false, 'the second worker finds it no longer pending and loses the claim');
  });

  test('process() on a document another worker already claimed does not ingest or count it', async () => {
    // The real race, made deterministic: the row is `pending`; a concurrent worker
    // claims it (flips it to `processing`) BEFORE this worker's process() runs its
    // own claim. This worker must lose the claim and return without chunking,
    // indexing, or applying the rollup delta — otherwise both workers ingest and
    // the dataset chunk_count becomes 2N, a permanent overcount the unchanged-digest
    // skip then locks in. (A plain sequential double-process() can't show this: the
    // second call re-reads the row as already `ready` and takes the skip; only a
    // stale `pending` copy racing a concurrent claim exercises the guard.)
    const document = await makeDocument('raced.md', 'Content about failover and recovery drills.');
    const datasetBefore = await store.datasets.get(datasetId);
    assert.equal(datasetBefore!.chunkCount, 0, 'no chunks counted yet');

    // A concurrent worker wins the claim.
    assert.equal(store.documents.claimForProcessing(document.id, 'other-worker', START + 1), true);

    // This worker processes its stale `pending` copy — it must lose and no-op.
    await pipeline.process(document);

    const datasetAfter = await store.datasets.get(datasetId);
    assert.equal(datasetAfter!.chunkCount, 0, 'the losing worker applied no rollup delta');
    assert.equal(index.size(), 0, 'the losing worker indexed nothing');
    const doc = await store.documents.get(document.id);
    assert.equal(doc!.chunkCount, 0, 'the document row was not written by the loser');
  });

  test('a worker requeued by the reaper mid-ingest does not double-commit the rollup', async () => {
    // The residual race the claim-token closes: Worker A claims a document and
    // starts embedding; A outruns the stuck-processing recovery window; the reaper
    // requeues the row to `pending` (clearing A's token); Worker B claims and
    // ingests it fully; THEN A finishes and tries to commit. Without an ownership
    // re-check A commits a second `+N` and the dataset chunk_count becomes 2N — a
    // permanent overcount. A's commit must be discarded because it no longer owns
    // the row.
    //
    // We pause A deterministically with a controllable embedder: A blocks at embed
    // (before index.add and before the commit), we run the reaper + a full Worker B
    // ingest, then release A and let it attempt its commit.
    let releaseA: () => void = () => {};
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
    let firstEmbed = true;
    const workerA = new IngestionPipeline({
      store, clock, index, blobs, logger: nullLogger,
      embedder: {
        model: 'test/embed',
        embed: async (texts) => {
          if (firstEmbed) { firstEmbed = false; await aBlocked; }
          return texts.map(() => [0]);
        },
      },
    });
    const workerB = new IngestionPipeline({ store, clock, index, blobs, logger: nullLogger });

    const document = await makeDocument('slow.md', 'Content about slow embedding and recovery.');
    await workerA.stage(document.id, 'Content about slow embedding and recovery.');
    await workerB.stage(document.id, 'Content about slow embedding and recovery.');

    // A starts and blocks inside embed (it has claimed the row with its token).
    const aRun = workerA.process(document);
    await Promise.resolve(); // let A reach the awaited embed
    // The reaper considers the row stuck and requeues it (clearing A's token).
    const requeued = await workerB.recoverStuckProcessing(-1); // staleMs -1 => everything processing is stale
    assert.equal(requeued, 1, 'the reaper requeued the stuck document');
    // B claims and fully ingests it.
    await workerB.process((await store.documents.get(document.id))!);
    const afterB = await store.datasets.get(datasetId);
    const trueChunks = afterB!.chunkCount;
    assert.ok(trueChunks > 0, 'worker B ingested and counted the document');

    // Now release A; its late commit must be discarded (it lost ownership).
    releaseA();
    await aRun;

    const afterA = await store.datasets.get(datasetId);
    assert.equal(afterA!.chunkCount, trueChunks, 'A’s stale commit did not double-count the rollup');
    const finalDoc = await store.documents.get(document.id);
    assert.equal(finalDoc!.status, 'ready', 'the document is ready (from B), not clobbered by A');
  });

  test('a worker that lost ownership drops its speculative chunks from its own index', async () => {
    // The index-side sibling of the ownership gate: the in-memory index is
    // per-replica and NOT transactional. A lost-ownership worker discards its DB
    // commit, but its `index.add` already ran on its own replica's index. It must
    // remove those chunks, or that replica serves a version the DB no longer owns
    // (split-brain search; documentChunkCount disagreeing with the row). Give A its
    // OWN index so we can assert it ends empty for the document.
    const { KeywordIndex } = await import('../src/knowledge.ts');
    const indexA = new KeywordIndex();
    const indexB = new KeywordIndex();
    let releaseA: () => void = () => {};
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
    let firstEmbed = true;
    const workerA = new IngestionPipeline({
      store, clock, index: indexA, blobs, logger: nullLogger,
      embedder: {
        model: 'test/embed',
        embed: async (texts) => {
          if (firstEmbed) { firstEmbed = false; await aBlocked; }
          return texts.map(() => [0]);
        },
      },
    });
    const workerB = new IngestionPipeline({ store, clock, index: indexB, blobs, logger: nullLogger });

    const document = await makeDocument('split.md', 'Content whose ingest is raced by two replicas.');
    await workerA.stage(document.id, 'Content whose ingest is raced by two replicas.');
    await workerB.stage(document.id, 'Content whose ingest is raced by two replicas.');

    const aRun = workerA.process(document);
    await Promise.resolve();
    await workerB.recoverStuckProcessing(-1);
    await workerB.process((await store.documents.get(document.id))!);
    assert.ok(indexB.documentChunkCount(document.id) > 0, 'B (the owner) indexed the document');

    // Release A: it lost ownership, so it must drop its speculative chunks from
    // ITS index rather than leaving them to serve a discarded version.
    releaseA();
    await aRun;

    assert.equal(
      indexA.documentChunkCount(document.id),
      0,
      'the losing worker removed its speculative chunks from its own index',
    );
    assert.equal(indexA.size(), 0, 'A’s index holds nothing for the discarded run');
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
    // Every terminal write clears the ownership token, including the
    // unchanged-digest skip path — a `ready` row must never carry a dangling
    // processing token (both the first ingest and the skip go through
    // finalizeIfOwnedSync).
    assert.equal(first?.processingToken, undefined, 'the first ingest cleared the claim token');
    assert.equal(second?.processingToken, undefined, 'the unchanged-digest skip cleared the claim token');
  });

  test('a re-sync re-indexes a document whose chunks are missing from the index', async () => {
    // The index is in-memory and not transactional, and the digest is persisted
    // before the index+rollup are committed together — so a crash on a re-sync can
    // leave the row `ready` with its digest while the index has lost (or never
    // gained) this document's chunks. The unchanged-digest skip must not fire in
    // that state: it also requires the index to actually hold `chunkCount` chunks
    // for the document, or the content silently vanishes from search forever (every
    // future unchanged re-sync takes the skip). Here we simulate the divergence by
    // evicting the chunks from the index behind the row's back, then re-process.
    const document = await makeDocument('recover.md', 'Content about failover and recovery drills.');
    await pipeline.process(document);
    const ready = await store.documents.get(document.id);
    assert.ok((ready?.chunkCount ?? 0) > 0);
    assert.equal((await index.search([datasetId], 'failover recovery', 5)).length, 1, 'indexed initially');

    // The index loses this document's chunks (a crash after a rollback, a lost
    // in-memory index), but the row still says ready with the same digest.
    await index.removeDocument(document.id);
    assert.equal(index.size(), 0, 'the index no longer holds the document');

    // A daily re-sync of the same (unchanged) content must NOT take the skip — it
    // must notice the index is out of step and re-index.
    await store.documents.update(document.id, { status: 'pending' });
    await pipeline.process((await store.documents.get(document.id))!);

    assert.equal(
      (await index.search([datasetId], 'failover recovery', 5)).length,
      1,
      'the re-sync re-indexed the document instead of skipping it into permanent invisibility',
    );
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

    // rebuild must repopulate the per-document chunk count too, or the
    // unchanged-digest skip would see the index as empty for this document and
    // needlessly re-index every document on the first re-sync after a restart.
    const ready = await store.documents.get(document.id);
    assert.equal(
      freshIndex.documentChunkCount(document.id),
      ready!.chunkCount,
      'rebuild restores the per-document chunk count, so an unchanged re-sync still fast-skips',
    );
    const sizeBefore = freshIndex.size();
    await store.documents.update(document.id, { status: 'pending' });
    await restarted.process((await store.documents.get(document.id))!);
    assert.equal(freshIndex.size(), sizeBefore, 'an unchanged re-sync after rebuild does not re-index (fast skip taken)');
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

  test('the reaper does not requeue a row the owner already completed', async () => {
    // findStaleProcessing reads a snapshot; between that read and the requeue write
    // the owning worker can finish (→ ready). The requeue is a compare-and-set on
    // status='processing', so a completed row is left alone rather than clobbered
    // back to pending (which would force a needless re-ingest and re-count).
    const document = await makeDocument('completed.md', 'Content that finished just in time.');
    await pipeline.process(document);
    const ready = await store.documents.get(document.id);
    assert.equal(ready?.status, 'ready', 'the document completed');

    // The reaper's CAS finds it no longer `processing` and does nothing. A large
    // staleBefore (everything counts as stale) isolates the status predicate.
    const requeued = store.documents.requeueIfProcessingSync(document.id, START + 10_000_000, START + 999);
    assert.equal(requeued, false, 'a ready row is not requeued');
    assert.equal((await store.documents.get(document.id))?.status, 'ready', 'it stays ready, not clobbered to pending');
  });

  test('the reaper does not requeue a processing row that was freshly re-claimed since the stale scan', async () => {
    // Cross-replica TOCTOU: findStaleProcessing captures a row that was stale at
    // read time, but before the reaper's write the owner finishes, a re-sync flips
    // it to pending, and a fresh worker re-claims it (a NEW updated_at). The requeue
    // CAS re-asserts `updated_at < staleBefore`, so the freshly-claimed row (updated
    // AFTER the scan threshold) is left alone rather than disowned — which would
    // clobber the new worker and force a wasted re-ingest.
    const document = await makeDocument('reclaimed.md', 'Content re-claimed by a fresh worker.');
    // The row is `processing` with a RECENT updated_at (a fresh claim).
    store.documents.claimForProcessing(document.id, 'fresh-token', START + 5_000);

    // The reaper computed its threshold BEFORE that fresh claim (staleBefore < the
    // row's updated_at), so the CAS must not requeue it.
    const staleBefore = START + 1_000;
    const requeued = store.documents.requeueIfProcessingSync(document.id, staleBefore, START + 6_000);
    assert.equal(requeued, false, 'a row updated since the stale scan is not requeued');
    const row = await store.documents.get(document.id);
    assert.equal(row?.status, 'processing', 'the freshly-claimed row stays processing');
    assert.equal(row?.processingToken, 'fresh-token', 'the fresh worker keeps its ownership token');
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

  test('permanently-dead failed docs do not starve a transient failure out of the capped window', async () => {
    // reprocessFailed takes a capped, oldest-first window of failed docs. If dead
    // rows (non-retryable, or attempt-exhausted) were only SKIPPED in the engine
    // after the fetch, then once >= limit dead rows exist the window is full of
    // them every tick — requeued=0 forever — and a genuinely-transient failure
    // that is NEWER never enters the window and dead-ends `failed`. The fix
    // excludes dead rows at the QUERY, so the window holds only actionable rows.
    const limit = 3;
    // Seed `limit` OLD non-retryable (permanently dead) failures — enough to fill
    // the whole oldest-first window on their own.
    for (let i = 0; i < limit; i++) {
      const dead = await makeDocument(`dead-${i}.md`, `permanently bad content ${i}`);
      await store.documents.update(dead.id, {
        status: 'failed',
        error: { code: 'INGESTION_FAILED', message: 'bad', details: {}, occurredAt: clock.now(), retryable: false },
        updatedAt: clock.now(), // oldest
      });
    }
    // A NEWER transient failure — the one that must still get retried.
    await clock.advance(10_000);
    const transient = await makeDocument('transient.md', 'content that failed transiently');
    await store.documents.update(transient.id, {
      status: 'failed',
      error: { code: 'INGESTION_FAILED', message: 'blip', details: {}, occurredAt: clock.now(), retryable: true },
      updatedAt: clock.now(), // newest, so it sorts AFTER the dead rows
    });

    const requeued = await pipeline.reprocessFailed(3, limit);
    assert.equal(requeued, 1, 'the transient failure is requeued despite the older dead rows');
    assert.equal(
      (await store.documents.get(transient.id))?.status,
      'pending',
      'the transient doc is back in the queue, not starved by the dead window',
    );
  });

  test('a document that would exceed the workspace chunk quota is failed, not indexed', async () => {
    // The corpus-side DoS guard: BM25 search is an O(chunks) synchronous scan on
    // the shared event loop, so a workspace's indexed chunks are capped. A document
    // whose chunks would push the workspace past `maxKnowledgeChunks` must be
    // recorded `failed` (non-retryable) and add ZERO chunks — the index and the
    // dataset rollup are untouched, so the quota actually holds.
    await store.workspaces.update(workspaceId, {
      quota: {
        maxConcurrentSessions: 20, maxSandboxes: 20, maxTokensPerDay: 1_000_000,
        maxCostMicrosPerDay: 0, maxStorageMb: 1024, maxAgents: 100,
        maxKnowledgeChunks: 2, eventRetentionDays: 90,
      },
    });
    // Content that chunks into clearly more than 2 chunks at the default size
    // (~1200 chars/chunk), so the projected total (>2) exceeds the limit of 2.
    const big = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} with enough words to matter here.`).join('\n\n');
    const document = await makeDocument('over-budget.md', big);
    const indexBefore = index.size();

    await pipeline.process(document);

    const failed = await store.documents.get(document.id);
    assert.equal(failed?.status, 'failed', 'the over-budget document is failed');
    assert.equal(failed?.error?.code, 'QUOTA_EXCEEDED', 'failed for the quota reason, legibly');
    assert.equal(failed?.error?.retryable, false, 'a quota rejection is not retried forever');
    assert.equal(index.size(), indexBefore, 'no chunks were added to the index');
    const dataset = await store.datasets.get(datasetId);
    assert.equal(dataset?.chunkCount, 0, 'the dataset chunk rollup was not inflated');
    // And reprocessFailed leaves it alone (non-retryable), so it does not churn.
    assert.equal(await pipeline.reprocessFailed(3), 0, 'the quota failure is not requeued');
  });

  test('deleteDocument evicts chunks, decrements the dataset counts, and deletes the row', async () => {
    // Documents were created with documentCount++ but never decremented, and there
    // was no per-document delete at all. deleteDocument closes both: it removes the
    // row, evicts its chunks from the index (releasing chunk-quota usage), and
    // decrements the dataset rollup.
    const doc = await makeDocument('deletable.md', 'Content about the deployment pipeline and rollbacks.');
    await pipeline.process(doc);
    // Simulate the create-time documentCount bump the route applies (the pipeline
    // does not touch documentCount; the HTTP route does).
    const seeded = await store.datasets.get(datasetId);
    await store.datasets.update(datasetId, { documentCount: seeded!.documentCount + 1 });

    const before = await store.datasets.get(datasetId);
    const ready = await store.documents.get(doc.id);
    assert.ok(before!.chunkCount > 0 && before!.documentCount >= 1 && (ready?.chunkCount ?? 0) > 0);
    assert.equal((await index.search([datasetId], 'deployment rollbacks', 5)).length, 1, 'indexed before delete');

    const evicted = await pipeline.deleteDocument(datasetId, doc.id);
    assert.equal(evicted, ready!.chunkCount, 'returns the chunks it evicted');

    assert.equal(await store.documents.get(doc.id), undefined, 'the row is gone');
    const after = await store.datasets.get(datasetId);
    assert.equal(after!.documentCount, before!.documentCount - 1, 'documentCount decremented');
    assert.equal(after!.chunkCount, before!.chunkCount - ready!.chunkCount, 'chunkCount decremented by the doc');
    assert.equal((await index.search([datasetId], 'deployment rollbacks', 5)).length, 0, 'evicted from the index');
  });

  test('deleteDocument is scoped to its dataset (a mismatched dataset id is not-found)', async () => {
    // IDOR guard: a document id addressed under the wrong dataset must not be
    // deletable — a caller cannot reach a document in another dataset by naming it.
    const doc = await makeDocument('scoped.md', 'Some content.');
    await pipeline.process(doc);
    await assert.rejects(
      pipeline.deleteDocument('ds_01ARZ3NDEKTSV4RRFFQ69G5FAV', doc.id),
      (error: unknown) => error instanceof Error && /Document/.test(error.message),
    );
    // The document is untouched — the mismatch did not delete it.
    assert.ok(await store.documents.get(doc.id), 'the document still exists after a mismatched delete');
  });

  test('deleteDocument gates its count decrement on the row actually being removed', async () => {
    // deleteDocument reads the row OUTSIDE the transaction, so a double-click /
    // retry / two replicas can both observe it present. The decrement must be
    // gated on removeSync actually deleting a row (its boolean return), or the
    // loser — whose removeSync affects 0 rows — would decrement the dataset rollup
    // a second time, dropping it by 2× for one real deletion and under-counting the
    // chunk-quota basis. Verify (a) the store primitive reports the delete outcome,
    // the mechanism the gate depends on, and (b) a redundant delete does not
    // double-decrement.
    const doc = await makeDocument('raced.md', 'Content about the deploy pipeline and its rollbacks.');
    await pipeline.process(doc);
    const seeded = await store.datasets.get(datasetId);
    await store.datasets.update(datasetId, { documentCount: seeded!.documentCount + 1 });
    const before = await store.datasets.get(datasetId);

    // (a) removeSync tells the caller whether it removed a row — true then false.
    await store.transaction((tx) => {
      assert.equal(tx.documents.removeSync(doc.id), true, 'first removeSync deletes the row');
      assert.equal(tx.documents.removeSync(doc.id), false, 'a second removeSync of the same id removes nothing');
    });
    // Re-create and re-run through the real deleteDocument to confirm the decrement
    // lands exactly once for a real delete.
    const doc2 = await makeDocument('raced2.md', 'More content about deploys and rollbacks.');
    await pipeline.process(doc2);
    const mid = await store.datasets.get(datasetId);
    await store.datasets.update(datasetId, { documentCount: mid!.documentCount + 1 });
    const beforeReal = await store.datasets.get(datasetId);
    const ready2 = await store.documents.get(doc2.id);

    await pipeline.deleteDocument(datasetId, doc2.id);
    // A redundant second delete finds no row → not-found, and must not decrement.
    await assert.rejects(pipeline.deleteDocument(datasetId, doc2.id));

    const after = await store.datasets.get(datasetId);
    assert.equal(after!.documentCount, beforeReal!.documentCount - 1, 'documentCount dropped by exactly one');
    assert.equal(after!.chunkCount, beforeReal!.chunkCount - ready2!.chunkCount, 'chunkCount dropped by one document');
    void before;
  });

  test('the dataset chunk rollup equals the true live sum after an ingest interleaved with a delete', async () => {
    // Caller-level regression for the rollup-delta rewiring: process() must apply
    // its chunk contribution as a signed delta that COMPOSES with a concurrent
    // deleteDocument's atomic decrement, so the dataset chunkCount stays equal to
    // the sum of its live documents' chunkCounts — the basis the maxKnowledgeChunks
    // quota sums. Guards the real process() path, not just the store primitive: a
    // revert of the wiring back to get()-then-update(absolute) would drift the
    // rollup above the live sum here (the delete's decrement would be clobbered).
    const a = await makeDocument('a.md', 'Alpha content about deployment and rollback runbooks.');
    const b = await makeDocument('b.md', 'Bravo content covering caching and eviction policies.');
    await pipeline.process(a);
    await pipeline.process(b);

    const readyA = (await store.documents.get(a.id))!;
    const readyB = (await store.documents.get(b.id))!;
    const afterBoth = (await store.datasets.get(datasetId))!;
    assert.equal(
      afterBoth.chunkCount,
      readyA.chunkCount + readyB.chunkCount,
      'rollup equals the live sum after two ingests',
    );

    // Delete A, then re-sync B with changed content (a fresh ingest of the same
    // row). The rollup must track the live sum throughout — B's delta must not
    // resurrect A's evicted chunks.
    await pipeline.deleteDocument(datasetId, a.id);
    await pipeline.stage(b.id, 'Bravo content, entirely rewritten and now much longer: ' + 'cache '.repeat(40));
    await store.documents.update(b.id, { status: 'pending' });
    await pipeline.process((await store.documents.get(b.id))!);

    const liveDocs = await store.documents.list({ datasetId, limit: 100 });
    const liveSum = liveDocs.items.reduce((sum, d) => sum + d.chunkCount, 0);
    const finalDataset = (await store.datasets.get(datasetId))!;
    assert.equal(finalDataset.chunkCount, liveSum, 'rollup equals the live sum after delete + re-sync');
    assert.equal(await store.datasets.knowledgeChunksForWorkspace(workspaceId), liveSum, 'quota basis matches too');
  });

  test('a shrink re-sync (fewer chunks than before) decrements the dataset rollup', async () => {
    // The delta is `new - old`; a re-sync that SHRINKS (new < old) applies a
    // negative delta. The old absolute write handled this too, but the delta form
    // must not under- or over-shoot, and must compose with the MAX(0,...) clamp.
    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with enough words in it to matter for chunking.`).join('\n\n');
    const doc = await makeDocument('shrinks.md', long);
    await pipeline.process(doc);
    const big = (await store.documents.get(doc.id))!;
    const datasetBig = (await store.datasets.get(datasetId))!;
    assert.ok(big.chunkCount > 1, 'the long version produced multiple chunks');
    assert.equal(datasetBig.chunkCount, big.chunkCount, 'rollup holds the large count');

    // Re-sync with much shorter content — fewer chunks.
    await pipeline.stage(doc.id, 'one short line.');
    await store.documents.update(doc.id, { status: 'pending' });
    await pipeline.process((await store.documents.get(doc.id))!);

    const small = (await store.documents.get(doc.id))!;
    const datasetSmall = (await store.datasets.get(datasetId))!;
    assert.ok(small.chunkCount < big.chunkCount, 'the shrink produced fewer chunks');
    assert.equal(
      datasetSmall.chunkCount,
      small.chunkCount,
      'rollup decremented to exactly the new live count (delta = new - old, negative)',
    );
  });

  test('a re-sync rejected by the chunk quota leaves the old chunks indexed and the rollup intact', async () => {
    // The quota check runs BEFORE index.removeDocument, so rejecting a changed
    // re-sync must not evict the already-indexed version: its chunks stay
    // searchable and the dataset rollup is unchanged (rejecting after eviction
    // would drop the content permanently and overcount the rollup, since the
    // rejection is non-retryable and never re-adds them).
    const doc = await makeDocument('resync.md', 'Original content about caching strategies.');
    await pipeline.process(doc);
    const ready = await store.documents.get(doc.id);
    const before = await store.datasets.get(datasetId);
    assert.ok((ready?.chunkCount ?? 0) > 0);
    assert.equal((await index.search([datasetId], 'caching strategies', 5)).length, 1, 'indexed before re-sync');

    // Tighten the cap so the (larger) new content would overflow, then re-stage
    // changed content and re-process.
    await store.workspaces.update(workspaceId, {
      quota: {
        maxConcurrentSessions: 20, maxSandboxes: 20, maxTokensPerDay: 1_000_000,
        maxCostMicrosPerDay: 0, maxStorageMb: 1024, maxAgents: 100,
        maxKnowledgeChunks: ready!.chunkCount, eventRetentionDays: 90,
      },
    });
    const big = Array.from({ length: 200 }, (_, i) => `New paragraph ${i} with plenty of words here.`).join('\n\n');
    await pipeline.stage(doc.id, big);
    // Re-queue to `pending` before re-processing, as every production re-sync does
    // (a re-upload creates a fresh pending row; recover/reprocess requeue to
    // pending). process() now claims the pending→processing edge atomically, so a
    // document left `ready` would never be re-claimed.
    await store.documents.update(doc.id, { status: 'pending' });
    await pipeline.process(await store.documents.get(doc.id) as Document);

    const failed = await store.documents.get(doc.id);
    assert.equal(failed?.status, 'failed', 'the oversized re-sync is rejected');
    assert.equal(failed?.error?.code, 'QUOTA_EXCEEDED');
    // The OLD version is still searchable — the rejection did not evict it.
    assert.equal(
      (await index.search([datasetId], 'caching strategies', 5)).length,
      1,
      'the previously-indexed content is still searchable after a rejected re-sync',
    );
    const after = await store.datasets.get(datasetId);
    assert.equal(after!.chunkCount, before!.chunkCount, 'the dataset chunk rollup is unchanged, not overcounting');
  });

  test('a commit whose workspace budget was consumed mid-ingest is rejected at the transaction, not just pre-embed', async () => {
    // The chunk-budget admission used to be read-then-act: process() reads the
    // workspace chunk SUM and projects BEFORE embedding, but the rollup COMMIT is a
    // separate, later transaction with a wide await window (removeDocument, embed,
    // add) between. Two workers ingesting DIFFERENT documents in one workspace (the
    // multi-replica model the claim-token machinery is built for —
    // claimForProcessing only serializes the SAME document) both pass the pre-embed
    // check on the same under-cap snapshot, then both commit their rollup delta,
    // racing the corpus past maxKnowledgeChunks and reintroducing the O(chunks) BM25
    // stall the cap exists to prevent. The fix re-checks the cap INSIDE the finalize
    // transaction (BEGIN IMMEDIATE), so the check-and-increment is atomic.
    //
    // Made deterministic with cap=1 and a controllable embedder: Worker B reads the
    // empty snapshot (SUM 0) at its pre-embed check and passes (0 + 1 <= 1), then
    // blocks inside embed. While B is parked, Worker A ingests its own document and
    // commits, taking the durable SUM to 1. B then resumes: its pre-embed admission
    // already passed against the stale snapshot, so ONLY the in-transaction re-read
    // can catch that 1 + 1 > 1 — which is exactly the guard under test.
    await store.workspaces.update(workspaceId, {
      quota: {
        maxConcurrentSessions: 20, maxSandboxes: 20, maxTokensPerDay: 1_000_000,
        maxCostMicrosPerDay: 0, maxStorageMb: 1024, maxAgents: 100,
        maxKnowledgeChunks: 1, eventRetentionDays: 90,
      },
    });
    const oneChunk = 'A single short chunk about deploys.';
    const docA = await makeDocument('a.md', oneChunk);
    const docB = await makeDocument('b.md', oneChunk);

    let releaseB: () => void = () => {};
    const bBlocked = new Promise<void>((resolve) => { releaseB = resolve; });
    let firstEmbed = true;
    const workerB = new IngestionPipeline({
      store, clock, index, blobs, logger: nullLogger,
      embedder: {
        model: 'test/embed',
        embed: async (texts) => {
          if (firstEmbed) { firstEmbed = false; await bBlocked; }
          return texts.map(() => [0]);
        },
      },
    });

    // B starts and blocks inside embed — it has already passed its pre-embed
    // admission against the empty workspace (SUM 0, projection 0 + 1 <= 1).
    const bRun = workerB.process(docB);
    await Promise.resolve(); // let B reach the awaited embed

    // While B is parked, A ingests fully and commits: the durable SUM is now 1/1.
    await pipeline.process(docA);
    assert.equal((await store.datasets.get(datasetId))!.chunkCount, 1, 'A consumed the whole budget');

    // Release B; its commit must be rejected by the in-transaction re-read (1 + 1 >
    // 1), even though its pre-embed check passed against the stale snapshot.
    releaseB();
    await bRun;

    const dataset = await store.datasets.get(datasetId);
    assert.equal(dataset!.chunkCount, 1, 'the corpus never exceeds the cap — B did not race past it');
    const bDoc = await store.documents.get(docB.id);
    assert.equal(bDoc?.status, 'failed', 'B is failed, not committed over the cap');
    assert.equal(bDoc?.error?.code, 'QUOTA_EXCEEDED', 'B failed for the quota reason');
    assert.equal(index.size(), 1, 'the index holds only A’s chunk — B’s speculative chunk was dropped');
    assert.equal((await store.documents.get(docA.id))?.status, 'ready', 'A is ready');
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

  test('a query term repeated many times does not inflate the score (deduped)', async () => {
    // Query terms drive an O(terms x chunks x chunkLen) scoring loop and are folded
    // into BM25 additively. A model-controlled query that repeats one term a
    // million times would (a) blow up the work and (b) count the term N times,
    // corrupting the ranking. Terms are deduped, so a repeated term scores exactly
    // once — same result as naming it once.
    const index = new KeywordIndex();
    await index.add([
      { datasetId: 'ds_1', documentId: 'dc_1', index: 0, text: 'incident response runbook', source: 'a.md' },
    ]);
    const once = await index.search(['ds_1'], 'incident', 5);
    const repeated = await index.search(['ds_1'], ('incident ').repeat(100_000), 5);
    assert.equal(repeated.length, 1);
    assert.ok(
      Math.abs(repeated[0]!.score - once[0]!.score) < 1e-9,
      `a repeated term must score once (once=${once[0]!.score}, repeated=${repeated[0]!.score})`,
    );
  });

  test('an oversized query is bounded before it reaches scoring (DoS guard)', async () => {
    // A sandbox can POST a query up to the 10MB body limit. Without a bound the
    // control-plane event loop runs a synchronous scoring pass proportional to the
    // query length across every allowed chunk — wedging the whole multi-tenant
    // control plane. RetrievalService truncates the query to maxQueryChars first,
    // so a distinctive term placed PAST the cap is never seen: it neither matches
    // nor contributes work.
    const index = new KeywordIndex();
    await index.add([
      { datasetId: 'ds_1', documentId: 'dc_1', index: 0, text: 'zzsentinel appears here', source: 'a.md' },
    ]);
    const service = new RetrievalService({ index, maxQueryChars: 64 });
    // 64 chars of filler, then the sentinel — which sits beyond the cap.
    const query = 'a '.repeat(40) + 'zzsentinel';
    const results = await service.search(['ds_1'], query);
    assert.equal(
      results.length,
      0,
      'the sentinel past the cap was truncated away, so it matched nothing',
    );
    // And the same sentinel WITHIN the cap does match — proving it is the cap, not
    // a tokenizer quirk, that dropped it.
    const withinCap = await service.search(['ds_1'], 'zzsentinel');
    assert.equal(withinCap.length, 1, 'the sentinel within the cap matches');
  });
});
