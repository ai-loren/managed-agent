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
  /** How many chunks contain each term, for the IDF component. */
  readonly #documentFrequency = new Map<string, number>();
  #totalLength = 0;

  add(chunks: readonly Chunk[]): Promise<void> {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      this.#chunks.push(chunk);
      this.#tokens.push(tokens);
      this.#totalLength += tokens.length;
      for (const term of new Set(tokens)) {
        this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
      }
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
    const averageLength = this.#totalLength / this.#chunks.length;
    // Standard BM25 constants: k1 controls term-frequency saturation, b how
    // strongly length is normalized.
    const k1 = 1.5;
    const b = 0.75;

    const scored: SearchResult[] = [];
    for (let index = 0; index < this.#chunks.length; index++) {
      const chunk = this.#chunks[index]!;
      if (!allowed.has(chunk.datasetId)) continue;

      const tokens = this.#tokens[index]!;
      if (tokens.length === 0) continue;

      let score = 0;
      for (const term of terms) {
        const frequency = tokens.filter((token) => token === term).length;
        if (frequency === 0) continue;

        const containing = this.#documentFrequency.get(term) ?? 0;
        // A term in almost every chunk carries almost no signal.
        const idf = Math.log(1 + (this.#chunks.length - containing + 0.5) / (containing + 0.5));
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

      const tokens = this.#tokens[index]!;
      this.#totalLength -= tokens.length;
      for (const term of new Set(tokens)) {
        const count = (this.#documentFrequency.get(term) ?? 1) - 1;
        if (count <= 0) this.#documentFrequency.delete(term);
        else this.#documentFrequency.set(term, count);
      }
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

  /** Stage a document's content ahead of processing. */
  stage(documentId: string, content: string): void {
    this.#content.set(documentId, content);
  }

  /**
   * Load a document's content: the in-process cache first, then the durable blob
   * store keyed by the row's digest. Returns `undefined` when neither has it —
   * a freshly-created document not yet staged, or a document whose blob is gone.
   */
  async #loadContent(document: Document): Promise<string | undefined> {
    const cached = this.#content.get(document.id);
    if (cached !== undefined) return cached;
    if (!document.digest) return undefined;
    const bytes = await this.#options.blobs.get(document.workspaceId, document.digest);
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
