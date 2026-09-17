/**
 * Dataset ingestion and retrieval.
 *
 * A knowledge base is only useful if the agent can decide *when* to consult it.
 * So retrieval is exposed as a tool the harness may call, not as text stuffed
 * into every prompt — which would burn context on documents the agent did not
 * need and crowd out the ones it did.
 *
 * The embedding and index interfaces are pluggable, and a keyword implementation
 * ships so the platform works with no external service. That is a real trade:
 * BM25-style scoring finds documents that share words with the query, not
 * documents that mean the same thing. For many operational corpora — runbooks,
 * error codes, API names — shared vocabulary is exactly the signal, and a
 * dependency-free default that works beats a better one nobody can run.
 */

import { sha256Hex, type Clock, type Logger } from '@ma/core';
import { documentMachine, type Document } from '@ma/contracts';
import type { Store } from '@ma/store';
import { MAX_PAGE_LIMIT } from '@ma/store';

import type { BlobStore } from './artifacts.ts';

/** A slice of a document, with enough context to be useful on its own. */
export interface Chunk {
  documentId: string;
  datasetId: string;
  /** Position within the document, so results can be ordered and de-duplicated. */
  index: number;
  text: string;
  /** Document name, carried so a result can cite its source. */
  source: string;
}

export interface SearchResult extends Chunk {
  score: number;
}

/** Turns text into vectors. Absent means keyword search only. */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Stores and searches chunks. */
export interface ChunkIndex {
  add(chunks: readonly Chunk[], vectors?: readonly number[][]): Promise<void>;
  search(
    datasetIds: readonly string[],
    query: string,
    limit: number,
    vector?: readonly number[],
  ): Promise<SearchResult[]>;
  removeDocument(documentId: string): Promise<void>;
  size(): number;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  /** Target characters per chunk. */
  size?: number;
  /** Characters repeated between adjacent chunks. */
  overlap?: number;
}

/**
 * Split text into overlapping chunks on paragraph boundaries.
 *
 * Boundaries matter more than exact size: a chunk cut mid-sentence retrieves
 * badly and reads worse when the agent quotes it. Overlap exists so a fact
 * spanning a boundary is present, whole, in at least one chunk.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? 1200;
  const overlap = options.overlap ?? 150;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= size) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.trim().length === 0) return;
    chunks.push(current.trim());
    // Carry the tail forward so a fact straddling the boundary survives intact.
    current = overlap > 0 ? current.slice(Math.max(0, current.length - overlap)) : '';
  };

  for (const paragraph of paragraphs) {
    // A single oversized paragraph is split on sentences rather than mid-word.
    if (paragraph.length > size) {
      flush();
      for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
        if (current.length + sentence.length > size) flush();
        current += (current.length > 0 ? ' ' : '') + sentence;
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > size) flush();
    current += (current.length > 0 ? '\n\n' : '') + paragraph;
  }
  flush();

  return chunks.filter((chunk) => chunk.length > 0);
}

// ---------------------------------------------------------------------------
// Keyword index
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'he', 'she',
]);

/**
 * Split text into search terms.
 *
 * Dots, underscores and hyphens are kept *inside* tokens, because operational
 * corpora are full of identifiers — `api.getUser`, `payment-service`,
 * `MAX_RETRY_COUNT` — and splitting those into fragments loses exactly the
 * terms someone would search for. They are then trimmed from the *edges*, so a
 * word ending a sentence still matches the same word written bare: without
 * that, `telnet.` and `telnet` are different terms and the query silently
 * returns nothing.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((token) => token.replace(/^[.\-_]+|[.\-_]+$/g, ''))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * An in-process BM25 index.
 *
 * BM25 rather than raw term frequency because it does the two things that
 * matter for retrieval: it discounts words that appear everywhere, and it stops
 * a long document from winning simply by being long.
 *
 * In-memory, so it is rebuilt at startup from the store. For the corpus sizes a
 * single deployment holds — runbooks, docs, a few thousand chunks — that costs
 * a few hundred milliseconds and saves an external dependency.
 */
export class KeywordIndex implements ChunkIndex {
  readonly #chunks: Chunk[] = [];
  readonly #tokens: string[][] = [];

  add(chunks: readonly Chunk[]): Promise<void> {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      this.#chunks.push(chunk);
      this.#tokens.push(tokens);
    }
    return Promise.resolve();
  }

  search(
    datasetIds: readonly string[],
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    const terms = tokenize(query);
    if (terms.length === 0 || this.#chunks.length === 0) return Promise.resolve([]);

    const allowed = new Set(datasetIds);

    // BM25 corpus statistics scoped to the ALLOWED datasets, not the whole index.
    // The index is process-wide (every workspace's chunks share it), but a query
    // only ever returns chunks from its own datasets — so the corpus stats that
    // drive scoring (N, average chunk length, and per-term document frequency)
    // must be computed over that same subset. Using the global stats let one
    // tenant's corpus skew another's ranking: a term common platform-wide but
    // rare in the queried datasets got an unfairly low IDF, and a foreign average
    // length distorted the length normalization. One pass over the allowed chunks
    // rebuilds the stats; the index is small (a few thousand chunks) by design.
    const allowedIndices: number[] = [];
    let allowedTotalLength = 0;
    const allowedDf = new Map<string, number>();
    for (let index = 0; index < this.#chunks.length; index++) {
      if (!allowed.has(this.#chunks[index]!.datasetId)) continue;
      const tokens = this.#tokens[index]!;
      allowedIndices.push(index);
      allowedTotalLength += tokens.length;
      for (const term of new Set(tokens)) {
        allowedDf.set(term, (allowedDf.get(term) ?? 0) + 1);
      }
    }
    const n = allowedIndices.length;
    if (n === 0) return Promise.resolve([]);
    const averageLength = allowedTotalLength / n;
    // Standard BM25 constants: k1 controls term-frequency saturation, b how
    // strongly length is normalized.
    const k1 = 1.5;
    const b = 0.75;

    const scored: SearchResult[] = [];
    for (const index of allowedIndices) {
      const chunk = this.#chunks[index]!;
      const tokens = this.#tokens[index]!;
      if (tokens.length === 0) continue;

      let score = 0;
      for (const term of terms) {
        const frequency = tokens.filter((token) => token === term).length;
        if (frequency === 0) continue;

        const containing = allowedDf.get(term) ?? 0;
        // A term in almost every allowed chunk carries almost no signal.
        const idf = Math.log(1 + (n - containing + 0.5) / (containing + 0.5));
        const norm = frequency * (k1 + 1);
        const denom = frequency + k1 * (1 - b + (b * tokens.length) / averageLength);
        score += idf * (norm / denom);
      }

      if (score > 0) scored.push({ ...chunk, score });
    }

    scored.sort((a, b2) => b2.score - a.score);
    return Promise.resolve(scored.slice(0, limit));
  }

  removeDocument(documentId: string): Promise<void> {
    for (let index = this.#chunks.length - 1; index >= 0; index--) {
      if (this.#chunks[index]!.documentId !== documentId) continue;
      this.#chunks.splice(index, 1);
      this.#tokens.splice(index, 1);
    }
    return Promise.resolve();
  }

  size(): number {
    return this.#chunks.length;
  }
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export interface IngestionOptions {
  store: Store;
  clock: Clock;
  index: ChunkIndex;
  /**
   * Durable, workspace-scoped storage for document content, keyed by digest —
   * the same blob store artifacts and context snapshots use. A document's bytes
   * are written here when it is ingested, so the in-memory index can be rebuilt
   * from durable storage after a restart. Without it, content would live only in
   * the process and vanish on restart, leaving `search` blind to every document
   * ingested before the restart.
   */
  blobs: BlobStore;
  embedder?: Embedder;
  logger?: Logger;
  chunk?: ChunkOptions;
}

export class IngestionPipeline {
  readonly #options: IngestionOptions;
  /**
   * A write-through cache of document content, keyed by id. `stage` fills it so
   * the create→process path in a single process needs no blob round-trip; the
   * durable copy lives in the blob store (`#loadContent` falls back to it, which
   * is what makes content survive a restart).
   */
  readonly #content = new Map<string, string>();

  constructor(options: IngestionOptions) {
    this.#options = options;
  }

  /**
   * Stage a document's content ahead of processing, durably.
   *
   * Writes the bytes to the blob store and records the staged digest in
   * `metadata.stagedDigest`, then keeps an in-memory write-through copy for the
   * fast create→process path. The durable write is what makes the content
   * survive a restart in the window between the upload's `202` and the first
   * processing tick: without it the bytes lived only in `#content`, so a
   * deploy/OOM/SIGKILL before the first tick lost the content server-side and
   * `process()` dead-ended the row `failed` with no way to recover the
   * never-persisted bytes. `#loadContent` falls back to `metadata.stagedDigest`,
   * so a fresh process reloads and ingests it.
   *
   * Deliberately does NOT stamp `document.digest`: that field means "the digest
   * that was last *processed* to `ready`", and the unchanged-digest skip in
   * `process()` relies on it — stamping a not-yet-processed digest there would
   * make a re-stage of changed content wrongly take the skip and never re-index.
   * The staged digest lives in metadata instead. Idempotent on digest.
   */
  async stage(documentId: string, content: string): Promise<void> {
    const { store, blobs, clock, logger } = this.#options;
    this.#content.set(documentId, content);
    try {
      const document = await store.documents.get(documentId);
      if (!document) return;
      const digest = sha256Hex(content);
      await blobs.put(document.workspaceId, digest, Buffer.from(content, 'utf8'));
      if ((document.metadata as Record<string, unknown>).stagedDigest !== digest) {
        await store.documents.update(documentId, {
          metadata: { ...document.metadata, stagedDigest: digest },
          updatedAt: clock.now(),
        });
      }
    } catch (error) {
      logger?.warn('failed to durably stage document content; will retry at process time', {
        documentId,
        error,
      });
    }
  }

  /**
   * Load a document's content: the in-process cache first, then the durable blob
   * store. Prefers `metadata.stagedDigest` (the most recently *staged* content,
   * what this ingest intends to process) over the row's processed `digest` (the
   * last content that reached `ready`). Precedence matters on a changed re-sync:
   * after a doc is `ready` at digest A, staging new content B then losing the
   * in-memory copy to a restart must reload B, not the stale A the row's `digest`
   * still names. `document.digest` is the fallback for a document ingested before
   * `stagedDigest` existed, or never re-staged. Returns `undefined` when none has
   * it: a freshly-created document never staged, or a document whose blob is gone.
   */
  async #loadContent(document: Document): Promise<string | undefined> {
    const cached = this.#content.get(document.id);
    if (cached !== undefined) return cached;
    const stagedDigest = (document.metadata as Record<string, unknown>).stagedDigest;
    const digest =
      (typeof stagedDigest === 'string' && stagedDigest) || document.digest || undefined;
    if (!digest) return undefined;
    const bytes = await this.#options.blobs.get(document.workspaceId, digest);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
  }

  /**
   * Process one pending document.
   *
   * Returns `false` when there is nothing to do, so a worker loop backs off
   * rather than spinning.
   */
  async processNext(): Promise<boolean> {
    const pending = await this.#options.store.documents.findPending(1);
    const document = pending[0];
    if (!document) return false;

    await this.process(document);
    return true;
  }

  /**
   * Requeue documents stuck in `processing`.
   *
   * `process()` flips a document to `processing`, then does blob-write, chunk and
   * embed before reaching a terminal `ready`/`failed`. A worker killed anywhere in
   * between (SIGKILL, OOM, deploy restart — routine during a long corpus ingest)
   * leaves the row stuck `processing` with no worker owning it: `findPending`
   * never selects it again, so it never finishes and never fails. This returns
   * any document sitting `processing` longer than `staleMs` back to `pending` so
   * the next `processNext` picks it up. Returns how many it requeued.
   */
  async recoverStuckProcessing(staleMs = 5 * 60 * 1000, limit = 20): Promise<number> {
    const { store, clock, logger } = this.#options;
    const stale = await store.documents.findStaleProcessing(clock.now() - staleMs, limit);
    let recovered = 0;
    for (const document of stale) {
      try {
        await store.documents.update(document.id, { status: 'pending', updatedAt: clock.now() });
        recovered++;
      } catch (error) {
        logger?.warn('failed to requeue a stuck document', { documentId: document.id, error });
      }
    }
    return recovered;
  }

  /**
   * Requeue documents that ended `failed` with a retryable error.
   *
   * Without this, `error.retryable: true` on an ingestion failure was a dead
   * flag — no code ever reprocessed a `failed` document (`findPending`/
   * `findStaleProcessing` never select it), so a transient failure (an embedder
   * blip, a lost blob later restored) dead-ended the document forever. This
   * returns such documents to `pending` so the ingestion loop retries them,
   * bounded by an attempt counter in `metadata.ingestAttempts` so a genuinely
   * broken document (bad content, a permanent config error) is not retried
   * forever: past `maxAttempts` it is left `failed` for an operator to inspect.
   * A non-retryable failure is never requeued. Returns how many it requeued.
   */
  async reprocessFailed(maxAttempts = 5, limit = 20): Promise<number> {
    const { store, clock, logger } = this.#options;
    const failed = await store.documents.findFailed(limit);
    let requeued = 0;
    for (const document of failed) {
      if (document.error && document.error.retryable === false) continue;
      const attempts = Number((document.metadata as Record<string, unknown>).ingestAttempts ?? 0);
      if (attempts >= maxAttempts) continue; // give up: leave it failed for an operator
      try {
        await store.documents.update(document.id, {
          status: 'pending',
          metadata: { ...document.metadata, ingestAttempts: attempts + 1 },
          updatedAt: clock.now(),
        });
        requeued++;
      } catch (error) {
        logger?.warn('failed to requeue a failed document', { documentId: document.id, error });
      }
    }
    return requeued;
  }

  async process(document: Document): Promise<void> {
    const { store, clock, index, logger } = this.#options;
    const now = clock.now();

    // Re-read rather than trusting the caller's copy. A scheduler holding a row
    // it fetched a minute ago would otherwise make decisions — particularly the
    // unchanged-digest skip below — from state that has since moved on.
    const current = (await store.documents.get(document.id)) ?? document;

    documentMachine.assert(current.status, 'processing');
    await store.documents.update(current.id, { status: 'processing', updatedAt: now });

    try {
      const content = await this.#loadContent(current);
      if (content === undefined) {
        throw new Error('No content was staged for this document');
      }

      const digest = sha256Hex(content);

      // Persist the bytes durably first, keyed by their digest and scoped to the
      // workspace — the same blob store artifacts use. Doing this *before* the
      // unchanged-digest skip below is load-bearing: it guarantees the invariant
      // the startup rebuild depends on — a `ready` document always has a
      // retrievable blob. A document that reached `ready` without one (ingested
      // before content was persisted, or a blob lost when the store moved) would
      // otherwise never self-heal, because an unchanged re-sync takes the skip
      // forever and never reaches a `put`. Idempotent on digest, so re-persisting
      // identical bytes is a cheap, no-op-shaped write.
      await this.#options.blobs.put(current.workspaceId, digest, Buffer.from(content, 'utf8'));
      // Record the digest on the row NOW, before chunk/embed. It used to be
      // written only in the success update far below, so a crash or transient
      // error between here and there (an embedder throwing — the error is even
      // recorded retryable) left the bytes durable in the blob store but with no
      // digest on the row pointing at them: the blob was orphaned and its content
      // permanently unrecoverable (nothing else records the digest). Persisting it
      // here keeps the row and the blob store in step whatever happens next. The
      // unchanged-digest skip below stays safe because it also requires
      // chunkCount > 0, which a not-yet-succeeded document does not have.
      if (digest !== current.digest) {
        await store.documents.update(current.id, { digest, updatedAt: clock.now() });
      }
      // The durable copy exists now, so drop the in-memory staging copy. Without
      // this the full text of every document ever ingested would live in the
      // process for its whole lifetime; `#loadContent` falls back to the blob.
      this.#content.delete(current.id);

      // An unchanged document on a re-sync costs nothing more: the bytes are
      // already durable above, and re-embedding identical content would be waste.
      if (digest === current.digest && current.chunkCount > 0) {
        await store.documents.update(current.id, {
          status: 'ready',
          lastSyncedAt: clock.now(),
          updatedAt: clock.now(),
        });
        return;
      }

      // Replace rather than append, so a re-sync does not leave the previous
      // version's chunks answering queries alongside the new ones.
      await index.removeDocument(current.id);

      const texts = chunkText(content, this.#options.chunk);
      const chunks: Chunk[] = texts.map((text, position) => ({
        documentId: current.id,
        datasetId: current.datasetId,
        index: position,
        text,
        source: current.name,
      }));

      const vectors = this.#options.embedder
        ? await this.#options.embedder.embed(texts)
        : undefined;
      await index.add(chunks, vectors);

      const completedAt = clock.now();
      await store.documents.update(current.id, {
        status: 'ready',
        digest,
        chunkCount: chunks.length,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        lastSyncedAt: completedAt,
        updatedAt: completedAt,
        error: undefined,
      });

      const dataset = await store.datasets.get(current.datasetId);
      if (dataset) {
        await store.datasets.update(current.datasetId, {
          // Counted as a delta against what this document previously
          // contributed, so a re-sync adjusts the total rather than inflating
          // it by the whole document again.
          chunkCount: dataset.chunkCount - current.chunkCount + chunks.length,
          sizeBytes: dataset.sizeBytes - current.sizeBytes + Buffer.byteLength(content, 'utf8'),
          updatedAt: completedAt,
        });
      }
    } catch (error) {
      // A failed document is recorded as failed with its reason, not retried
      // silently: an operator needs to see which document is broken and why.
      const failedAt = clock.now();
      await store.documents.update(current.id, {
        status: 'failed',
        error: {
          code: 'INGESTION_FAILED',
          message: error instanceof Error ? error.message : String(error),
          details: {},
          occurredAt: failedAt,
          retryable: true,
        },
        updatedAt: failedAt,
      });
      logger?.error('document ingestion failed', { documentId: current.id, error });
    }
  }

  /**
   * Rebuild the in-memory index from durable storage, at startup.
   *
   * The index is in-memory, so a fresh process starts blind to every document
   * ingested before it. This pages through every `ready` document across all
   * datasets, loads each one's content from the blob store by its digest, and
   * re-chunks and re-indexes it. Idempotent: `index.removeDocument` before
   * `add` means calling rebuild twice does not double-index.
   *
   * A document whose blob is missing is logged and skipped rather than aborting
   * the whole rebuild — one lost blob must not leave the rest of the corpus
   * unsearchable. Returns how many documents were re-indexed.
   */
  async rebuild(): Promise<number> {
    const { store, index, logger } = this.#options;
    let rebuilt = 0;
    let afterId: string | undefined;

    for (;;) {
      // Page at the store's own max page size, so a full page reliably means
      // "there may be more". A literal here would silently under-read the corpus
      // if MAX_PAGE_LIMIT were ever lowered below it: findReady clamps to the
      // max, page.length would be < the literal after the first page, and rebuild
      // would stop early — dropping every document beyond page one from the index.
      const page = await store.documents.findReady(MAX_PAGE_LIMIT, afterId);
      if (page.length === 0) break;

      for (const document of page) {
        const content = await this.#loadContent(document);
        if (content === undefined) {
          logger?.warn('skipping a document with no retrievable content during index rebuild', {
            documentId: document.id,
            digest: document.digest,
          });
          continue;
        }
        const texts = chunkText(content, this.#options.chunk);
        // Idempotent: drop any prior copy so a second rebuild does not duplicate.
        await index.removeDocument(document.id);
        await index.add(
          texts.map((text, position) => ({
            documentId: document.id,
            datasetId: document.datasetId,
            index: position,
            text,
            source: document.name,
          })),
        );
        rebuilt++;
      }

      if (page.length < MAX_PAGE_LIMIT) break;
      afterId = page[page.length - 1]!.id;
    }

    return rebuilt;
  }

  /**
   * Delete a dataset: evict every one of its documents' chunks from the
   * in-memory index, then delete the dataset row (which cascade-deletes the
   * document rows via the FK).
   *
   * The eviction is the load-bearing half. The `documents` table cascades on
   * `datasets.delete`, so the durable rows go automatically — but the keyword
   * index is a process-local structure with no database FK, so a dataset deleted
   * without evicting first would leave its chunks searchable forever (and, worse,
   * still returned by `search` under the now-dangling dataset id). Pages through
   * the dataset's documents at the store's max page size, mirroring `rebuild`.
   * Returns how many documents were evicted.
   */
  async deleteDataset(datasetId: string): Promise<number> {
    const { store, index } = this.#options;
    let evicted = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await store.documents.list({
        datasetId,
        limit: MAX_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      for (const document of page.items) {
        await index.removeDocument(document.id);
        this.#content.delete(document.id);
        evicted++;
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // Cascade-deletes the document rows via the FK; the index is already clear.
    await store.datasets.delete(datasetId);
    return evicted;
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface RetrievalOptions {
  index: ChunkIndex;
  embedder?: Embedder;
  /** Results returned per query. */
  defaultLimit?: number;
  /** Characters of each result handed to the model. */
  maxChunkChars?: number;
}

/**
 * Search a session's bound datasets.
 *
 * Scoped to the ids the *pinned version* declares, so widening an agent's
 * datasets never retroactively widens a session already running.
 */
export class RetrievalService {
  readonly #options: RetrievalOptions;

  constructor(options: RetrievalOptions) {
    this.#options = options;
  }

  async search(
    datasetIds: readonly string[],
    query: string,
    limit?: number,
  ): Promise<SearchResult[]> {
    if (datasetIds.length === 0) return [];

    const vector = this.#options.embedder
      ? (await this.#options.embedder.embed([query]))[0]
      : undefined;

    const results = await this.#options.index.search(
      datasetIds,
      query,
      limit ?? this.#options.defaultLimit ?? 5,
      vector,
    );

    const max = this.#options.maxChunkChars ?? 2000;
    return results.map((result) => ({
      ...result,
      text: result.text.length > max ? `${result.text.slice(0, max)}…` : result.text,
    }));
  }

  /** Format results for a model, with citations so it can attribute claims. */
  format(results: readonly SearchResult[]): string {
    if (results.length === 0) return 'No relevant documents were found.';
    return results
      .map(
        (result, position) =>
          `[${position + 1}] ${result.source} (chunk ${result.index}, score ${result.score.toFixed(2)})\n${result.text}`,
      )
      .join('\n\n---\n\n');
  }
}
