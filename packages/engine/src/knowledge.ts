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

import { MaError, notFound, quotaExceeded, randomToken, sha256Hex, type Clock, type Logger } from '@ma/core';
import { type Document } from '@ma/contracts';
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
  /**
   * How many chunks the index currently holds for one document. O(1). The
   * ingestion pipeline's unchanged-digest skip consults this to confirm the index
   * actually holds the document's chunks before skipping re-embedding: the index
   * is in-memory and not transactional, and the digest is persisted before the
   * index and rollup commit, so a crash can leave the row `ready` with its digest
   * while the index lost the chunks. Without this check the skip would fire and the
   * content would silently stay out of search forever.
   */
  documentChunkCount(documentId: string): number;
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
        // A "sentence" with no internal punctuation can itself exceed `size` (a
        // minified blob, a base64 payload, or hostile input with no `.!?`). Left
        // whole it would become one unbounded chunk, and since search cost and the
        // stored frequency map scale with chunk length, that is a persistent
        // event-loop stall on every later query. So hard-split an oversized
        // sentence into size-bounded pieces on a character boundary — retrieval
        // quality on such content is already poor, but availability is not
        // negotiable.
        for (const piece of splitToSize(sentence, size)) {
          if (current.length + piece.length > size) flush();
          current += (current.length > 0 ? ' ' : '') + piece;
        }
      }
      continue;
    }
    if (current.length + paragraph.length + 2 > size) flush();
    current += (current.length > 0 ? '\n\n' : '') + paragraph;
  }
  flush();

  return chunks.filter((chunk) => chunk.length > 0);
}

/** Break a string into pieces no longer than `size` characters. */
function splitToSize(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    pieces.push(text.slice(start, start + size));
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Keyword index
// ---------------------------------------------------------------------------

/**
 * Upper bound on distinct query terms that drive scoring. A retrieval query is a
 * short natural-language question — a few dozen words at most — so anything beyond
 * this is not a real query but a work-amplification attempt. Capping the distinct
 * terms bounds the per-chunk scoring cost regardless of the raw query length.
 */
const MAX_QUERY_TERMS = 64;

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
/** One indexed chunk plus the derived data `search` needs, kept together. */
interface ChunkEntry {
  chunk: Chunk;
  /** term → count in this chunk, precomputed at `add` time. */
  tf: Map<string, number>;
  /** token count, for BM25 length normalization. */
  length: number;
}

export class KeywordIndex implements ChunkIndex {
  /**
   * Chunks grouped BY DATASET, not one flat array. Each entry carries its chunk
   * plus the per-chunk term-frequency map and token length computed once at `add`
   * time (storing the frequency MAP rather than the raw tokens keeps `search`
   * cost independent of chunk length — scoring and document-frequency both probe
   * `tf.get(term)` in O(1) per query term).
   *
   * Grouping by dataset is what bounds a query's cost to the caller's OWN corpus.
   * The index is process-wide (every workspace's chunks share it), but a query
   * only ever scores chunks from its granted datasets — and `maxKnowledgeChunks`
   * is a PER-WORKSPACE cap, with no global chunk cap anywhere. A flat array forced
   * `search` to scan every tenant's chunks to find the caller's, so one tenant's
   * corpus growth made every other tenant's query an O(global) synchronous stall
   * on the shared event loop — the per-workspace cap did not bound it. Iterating
   * only the allowed datasets' buckets restores the O(allowedChunks × queryTerms)
   * cost the cap is meant to bound.
   */
  readonly #byDataset = new Map<string, ChunkEntry[]>();
  /**
   * documentId → number of chunks the index currently holds for it. Maintained in
   * lockstep with the buckets above so `documentChunkCount` is O(1) — the
   * unchanged-digest skip consults it on every daily re-sync, so it must not become
   * an O(chunks) scan (that is the very event-loop-stall class the chunk frequency-
   * map design and the ingestion quota exist to avoid).
   */
  readonly #docChunks = new Map<string, number>();
  /** documentId → its dataset, so `removeDocument` touches only that bucket. */
  readonly #docDataset = new Map<string, string>();
  #total = 0;

  add(chunks: readonly Chunk[]): Promise<void> {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      let bucket = this.#byDataset.get(chunk.datasetId);
      if (!bucket) {
        bucket = [];
        this.#byDataset.set(chunk.datasetId, bucket);
      }
      bucket.push({ chunk, tf, length: tokens.length });
      this.#docChunks.set(chunk.documentId, (this.#docChunks.get(chunk.documentId) ?? 0) + 1);
      this.#docDataset.set(chunk.documentId, chunk.datasetId);
      this.#total++;
    }
    return Promise.resolve();
  }

  search(
    datasetIds: readonly string[],
    query: string,
    limit: number,
  ): Promise<SearchResult[]> {
    // Dedup the query terms, and cap how many distinct ones drive scoring. Terms
    // fold into BM25 additively, so a term named twice would score twice —
    // corrupting the ranking — and, worse, a model-controlled query repeating one
    // term drives the O(terms x chunks x chunkLen) scoring loop that many times on
    // the control-plane event loop. A retrieval query is a short question; more
    // than MAX_QUERY_TERMS distinct terms is not a real query, so the excess is
    // dropped rather than allowed to blow up the work. `RetrievalService` also
    // bounds the raw query length before this; this is the defense a direct caller
    // of the index still gets.
    const terms = [...new Set(tokenize(query))].slice(0, MAX_QUERY_TERMS);
    if (terms.length === 0 || this.#total === 0) return Promise.resolve([]);

    // Iterate ONLY the allowed datasets' buckets — never the whole index. This is
    // what keeps the cost O(allowedChunks × queryTerms) and bounded by the
    // per-workspace `maxKnowledgeChunks` cap, rather than O(global corpus). A
    // dataset the caller was not granted contributes nothing and is never visited,
    // so one tenant's corpus size cannot slow another tenant's query. Dedup the
    // dataset ids so a repeated grant does not double-score its chunks.
    const allowedEntries: ChunkEntry[] = [];
    for (const datasetId of new Set(datasetIds)) {
      const bucket = this.#byDataset.get(datasetId);
      if (bucket) allowedEntries.push(...bucket);
    }
    if (allowedEntries.length === 0) return Promise.resolve([]);

    // BM25 corpus statistics scoped to the ALLOWED datasets, not the whole index.
    // A query only ever returns chunks from its own datasets, so the corpus stats
    // that drive scoring (N, average chunk length, and per-term document frequency)
    // must be computed over that same subset. Using the global stats let one
    // tenant's corpus skew another's ranking: a term common platform-wide but
    // rare in the queried datasets got an unfairly low IDF, and a foreign average
    // length distorted the length normalization.
    //
    // Document frequency is computed by probing only the (bounded) query terms
    // against each chunk's precomputed frequency map — O(allowedChunks x queryTerms),
    // NOT O(allowedChunks x chunkLength). Only the query terms affect scoring, so
    // there is no need to walk every distinct term in every chunk.
    let allowedTotalLength = 0;
    const allowedDf = new Map<string, number>();
    for (const entry of allowedEntries) {
      allowedTotalLength += entry.length;
      for (const term of terms) {
        if (entry.tf.has(term)) allowedDf.set(term, (allowedDf.get(term) ?? 0) + 1);
      }
    }
    const n = allowedEntries.length;
    const averageLength = allowedTotalLength / n;
    // Standard BM25 constants: k1 controls term-frequency saturation, b how
    // strongly length is normalized.
    const k1 = 1.5;
    const b = 0.75;

    const scored: SearchResult[] = [];
    for (const entry of allowedEntries) {
      const length = entry.length;
      if (length === 0) continue;
      const tf = entry.tf;

      let score = 0;
      for (const term of terms) {
        const frequency = tf.get(term) ?? 0;
        if (frequency === 0) continue;

        const containing = allowedDf.get(term) ?? 0;
        // A term in almost every allowed chunk carries almost no signal.
        const idf = Math.log(1 + (n - containing + 0.5) / (containing + 0.5));
        const norm = frequency * (k1 + 1);
        const denom = frequency + k1 * (1 - b + (b * length) / averageLength);
        score += idf * (norm / denom);
      }

      if (score > 0) scored.push({ ...entry.chunk, score });
    }

    scored.sort((a, b2) => b2.score - a.score);
    return Promise.resolve(scored.slice(0, limit));
  }

  removeDocument(documentId: string): Promise<void> {
    // Touch only the document's own dataset bucket — never scan the whole index.
    const datasetId = this.#docDataset.get(documentId);
    if (datasetId !== undefined) {
      const bucket = this.#byDataset.get(datasetId);
      if (bucket) {
        const kept = bucket.filter((entry) => entry.chunk.documentId !== documentId);
        this.#total -= bucket.length - kept.length;
        if (kept.length === 0) this.#byDataset.delete(datasetId);
        else this.#byDataset.set(datasetId, kept);
      }
      this.#docDataset.delete(documentId);
    }
    this.#docChunks.delete(documentId);
    return Promise.resolve();
  }

  size(): number {
    return this.#total;
  }

  documentChunkCount(documentId: string): number {
    return this.#docChunks.get(documentId) ?? 0;
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
  /** Document id → the digest of the content this process's index holds for it. */
  readonly #indexed = new Map<string, string>();
  /** The documents fingerprint `sync` last reconciled against. */
  #lastFingerprint: string | undefined;

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
    const staleBefore = clock.now() - staleMs;
    const stale = await store.documents.findStaleProcessing(staleBefore, limit);
    let recovered = 0;
    for (const document of stale) {
      try {
        // Requeue to `pending` and clear the ownership token, but only if the row is
        // STILL `processing` AND still stale (a compare-and-set re-asserting the same
        // `updated_at < staleBefore` filter `findStaleProcessing` used at read time).
        // Three things this buys: (a) clearing the token makes recovery safe against
        // the still-running slow worker — its terminal `finalizeIfOwnedSync` checks
        // `processing_token = <its token>`, which no longer matches, so its
        // (possibly already-embedded) commit is discarded rather than double-counting
        // the rollup; (b) the `status='processing'` predicate means a row the owner
        // finished (→ `ready`) is left alone, not clobbered back to `pending`; (c) the
        // `updated_at < staleBefore` predicate means a row that cycled through to a
        // FRESH claim (a new worker, new `updated_at`) between the scan and here is
        // also left alone — a status-only CAS would disown that new worker and cause
        // a wasted re-ingest. The next processNext re-claims a genuinely-stale row.
        if (store.documents.requeueIfProcessingSync(document.id, staleBefore, clock.now())) {
          recovered++;
        }
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
    // `findFailed` excludes permanently-dead rows (non-retryable, or past
    // `maxAttempts`) at the query, so the capped oldest-first window holds only
    // rows this sweep can act on — dead rows can no longer fill it and starve a
    // genuinely-transient failure. The per-row guards below stay as defense in
    // depth (they also cover a caller that passes no `maxAttempts`).
    const failed = await store.documents.findFailed(limit, maxAttempts);
    let requeued = 0;
    for (const document of failed) {
      if (document.error && document.error.retryable === false) continue;
      const attempts = Number((document.metadata as Record<string, unknown>).ingestAttempts ?? 0);
      if (attempts >= maxAttempts) continue; // give up: leave it failed for an operator
      try {
        // Compare-and-set on `status = 'failed'`, not a blind update: overlapping
        // sweeps (across replicas) both read this row from `findFailed`, and a
        // status-only update would let both requeue it — double-incrementing
        // `ingestAttempts` (a transient doc then burns its budget in a fraction of
        // the real retries) — or clobber a row another sweep already carried
        // failed→pending→claimed→ready back to `pending`. Only the sweep that finds
        // the row still `failed` wins; a lost CAS is not counted and does not bump
        // the attempt counter (the bump rides in the same guarded write).
        const requeuedRow = store.documents.requeueFailedSync(
          document.id,
          { ...document.metadata, ingestAttempts: attempts + 1 },
          clock.now(),
        );
        if (requeuedRow) requeued++;
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

    // Atomically claim the row: flip pending→processing in a single CAS and
    // proceed only if THIS worker won. Previously this was a re-read + an
    // unconditional update, so two workers (two control-plane replicas, or a
    // retry) both saw `pending`, both flipped, and both ingested — each applying
    // the chunk-rollup delta, permanently double-counting the maxKnowledgeChunks
    // quota basis (the unchanged-digest skip then makes the overcount stick). The
    // claim's `WHERE status='pending'` is the one serialization point. Every
    // production (re)process routes the row through `pending` first (create,
    // reprocessFailed, recoverStuckProcessing), so the claim covers them all; the
    // loser simply returns and lets the winner finish.
    //
    // The claim stamps a fresh `token` so the terminal write can verify continued
    // ownership: if this worker outruns the stuck-processing recovery window, the
    // reaper requeues the row (clearing the token) and another worker re-claims it
    // (new token) — this worker's `finalizeIfOwnedSync` then matches 0 rows and its
    // (possibly already-embedded) result is discarded rather than double-committed.
    const token = randomToken(16);
    if (!store.documents.claimForProcessing(current.id, token, now)) {
      logger?.debug('document already claimed by another worker; skipping', { documentId: current.id });
      return;
    }

    let lostOwnership = false;
    // Whether this run has mutated the (per-replica, non-transactional) in-memory
    // index via `index.add`. If a later step throws — a lost-ownership commit, or
    // the in-transaction chunk-budget rejection that rolls the finalize back — the
    // index still holds this run's chunks while the DB does not, so the catch must
    // drop them to keep the index in step with the row (and to not leave the
    // over-cap chunks the budget check just refused sitting in the searched index).
    let indexed = false;
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
      // But only skip when the in-memory index actually still holds this document's
      // chunks. The index is not transactional and the digest was persisted above
      // before the index+rollup commit together, so a crash on a prior re-sync can
      // leave the row `ready` with this digest while the index lost the chunks
      // (or a fresh process has not rebuilt them yet). Skipping then would leave the
      // content invisible to search forever — every future unchanged re-sync takes
      // the skip. `documentChunkCount` is O(1), so this stays cheap on the hot path;
      // when it disagrees with the row we fall through and re-index, repairing the
      // divergence.
      if (
        digest === current.digest &&
        current.chunkCount > 0 &&
        index.documentChunkCount(current.id) === current.chunkCount
      ) {
        // A terminal write like the commit below, so it too is ownership-gated:
        // route it through finalizeIfOwnedSync so a worker requeued+re-claimed
        // mid-skip does not clobber the new owner's row, and so the claim token is
        // cleared (a plain update would leave it dangling on the ready row). No
        // rollup delta — an unchanged re-sync adds no chunks.
        await store.transaction((tx) => {
          tx.documents.finalizeIfOwnedSync(current.id, token, {
            status: 'ready',
            lastSyncedAt: clock.now(),
            updatedAt: clock.now(),
          });
        });
        return;
      }
      const texts = chunkText(content, this.#options.chunk);
      const chunks: Chunk[] = texts.map((text, position) => ({
        documentId: current.id,
        datasetId: current.datasetId,
        index: position,
        text,
        source: current.name,
      }));

      // Chunk-quota admission, BEFORE anything mutates the index. The in-process
      // BM25 search is an O(chunks) synchronous scan on the shared control-plane
      // event loop, so the per-workspace `maxKnowledgeChunks` cap bounds the total
      // indexed chunks. The projection subtracts this document's own prior chunks
      // (`current.chunkCount`, still counted in the rollup this reads) because a
      // re-sync REPLACES them — the same delta the rollup update applies below.
      //
      // Checked before `index.removeDocument` on purpose: rejecting AFTER the
      // eviction would drop a `ready` document's already-searchable chunks from the
      // index over a NEW oversized version, and — because the rejection is
      // non-retryable — never re-add them, leaving the content unsearchable and the
      // rollup overcounting the removed chunks forever. Rejecting first leaves the
      // existing indexed version and its rollup exactly as they were.
      const workspace = await store.workspaces.get(current.workspaceId);
      if (workspace) {
        const existing = await store.datasets.knowledgeChunksForWorkspace(current.workspaceId);
        const projected = existing - current.chunkCount + chunks.length;
        if (projected > workspace.quota.maxKnowledgeChunks) {
          throw quotaExceeded('knowledgeChunks', workspace.quota.maxKnowledgeChunks, projected);
        }
      }

      // Replace rather than append, so a re-sync does not leave the previous
      // version's chunks answering queries alongside the new ones. Only after
      // admission has passed, so a rejected re-sync leaves the old chunks intact.
      await index.removeDocument(current.id);
      this.#indexed.delete(current.id);

      const vectors = this.#options.embedder
        ? await this.#options.embedder.embed(texts)
        : undefined;

      await index.add(chunks, vectors);
      this.#indexed.set(current.id, digest);
      indexed = true;

      const completedAt = clock.now();
      const newBytes = Buffer.byteLength(content, 'utf8');
      // Mark the document ready AND apply its dataset-rollup delta in ONE
      // transaction, so on the store side the row and the rollup can never
      // diverge. Two things this buys:
      //
      // (1) The delta is signed (`new - old`) and applied by `applyRollupDeltaSync`
      //     as a single in-SQL `col = MAX(0, col + ?)`, so it COMPOSES with a
      //     concurrent deleteDocument's atomic decrement rather than clobbering it
      //     the way the old `get()`-then-`update(absolute)` pair did — `chunkCount`
      //     is the basis the maxKnowledgeChunks quota sums, so a lost update there
      //     lets the corpus index past the cap.
      // (2) If the rollup write throws, the ready/chunkCount row write rolls back
      //     with it, instead of leaving the row committed `ready` with the new
      //     chunkCount while the rollup never accrued — the two-transaction shape
      //     could diverge there. A FIRST ingest then self-heals on retry (chunkCount
      //     rolled back to 0, so the unchanged-digest skip's `chunkCount > 0` guard
      //     is false and it re-processes).
      // Commit the ready row AND the dataset-rollup delta in ONE transaction, but
      // only if this worker STILL OWNS the row under its claim token. If this
      // worker outran the stuck-processing recovery window, the reaper requeued the
      // row (clearing the token) and another worker re-claimed it — then
      // `finalizeIfOwnedSync` matches 0 rows and we apply NO rollup delta, so the
      // (now-redundant) work this worker did is discarded rather than
      // double-counting the chunk rollup. Both the row write and the delta are
      // inside the transaction gated on ownership, so they commit or skip together.
      await store.transaction((tx) => {
        const owned = tx.documents.finalizeIfOwnedSync(current.id, token, {
          status: 'ready',
          digest,
          chunkCount: chunks.length,
          sizeBytes: newBytes,
          lastSyncedAt: completedAt,
          updatedAt: completedAt,
          error: undefined,
        });
        if (!owned) {
          lostOwnership = true;
          logger?.debug('lost document ownership before commit; discarding this run', {
            documentId: current.id,
          });
          return;
        }
        // Re-check the chunk budget INSIDE the finalize transaction, not only in
        // the cheap pre-embed reject above. That earlier check is a read-then-act:
        // it reads the workspace SUM, then a wide await window (removeDocument,
        // embed, add) passes before this commit, so two concurrent ingests of
        // DIFFERENT documents in one workspace (across replicas — the deployment
        // model the claim-token machinery is built for) both pass the same
        // under-cap snapshot and both apply their rollup delta, racing the corpus
        // past `maxKnowledgeChunks` and reintroducing the O(chunks) BM25 stall the
        // cap exists to prevent. Under BEGIN IMMEDIATE this re-read sees every
        // committed rollup, so the check-and-increment is atomic across replicas —
        // the same admit-and-reserve discipline the token/cost budget uses
        // (`UsageRepository.reserveDaily`). On breach, throw to roll the whole
        // finalize back; the catch records it as a non-retryable quota failure,
        // exactly as the pre-embed reject does. `existingAfter` already includes
        // this document's OLD chunkCount (still in the rollup until the delta
        // below), so subtract it — a re-sync REPLACES its chunks.
        if (workspace) {
          const existingAfter = tx.datasets.knowledgeChunksForWorkspaceSync(current.workspaceId);
          const projectedAfter = existingAfter - current.chunkCount + chunks.length;
          if (projectedAfter > workspace.quota.maxKnowledgeChunks) {
            throw quotaExceeded('knowledgeChunks', workspace.quota.maxKnowledgeChunks, projectedAfter);
          }
        }
        tx.datasets.applyRollupDeltaSync(
          current.datasetId,
          {
            chunkCount: chunks.length - current.chunkCount,
            sizeBytes: newBytes - current.sizeBytes,
          },
          completedAt,
        );
      });
      if (lostOwnership) {
        // The DB is owned by another worker, but this replica's in-memory index
        // was already mutated by `index.add` above (a per-replica, non-
        // transactional structure the ownership gate cannot roll back). Drop this
        // document's chunks from the local index so it does not serve this worker's
        // discarded version — desyncing the index from the row (split-brain search,
        // and a `documentChunkCount` that disagrees with `chunkCount`). The winning
        // worker's chunks live in ITS replica's index; this replica re-indexes on
        // its next successful (re)sync of the document.
        await index.removeDocument(current.id);
        this.#indexed.delete(current.id);
      }
    } catch (error) {
      // A failed document is recorded as failed with its reason, not retried
      // silently: an operator needs to see which document is broken and why.
      //
      // A quota rejection (the chunk-budget check above throws a QUOTA_EXCEEDED
      // MaError) is preserved verbatim and marked NON-retryable: retrying it
      // against a still-full corpus would fail identically forever, and
      // `reprocessFailed` honours `retryable === false` to leave it alone. Every
      // other failure keeps the generic retryable INGESTION_FAILED shape.
      const failedAt = clock.now();
      const quota = MaError.is(error) && error.code === 'QUOTA_EXCEEDED';
      // Record `failed` only if this worker still owns the row. A worker that lost
      // ownership to the reaper+re-claim must not stamp `failed` over a row another
      // worker is legitimately (re)processing or has already completed. The
      // token-gated write clears the token as it lands (or no-ops if ownership was
      // lost); either way the row is left correct.
      await store.transaction((tx) => {
        const owned = tx.documents.finalizeIfOwnedSync(current.id, token, {
          status: 'failed',
          error: {
            code: quota ? 'QUOTA_EXCEEDED' : 'INGESTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
            details: {},
            occurredAt: failedAt,
            retryable: !quota,
          },
          updatedAt: failedAt,
        });
        if (!owned) lostOwnership = true;
      });
      if (lostOwnership || indexed) {
        // Two cases need the local index cleaned. (1) lostOwnership: a reaper+
        // re-claim took the row, so this replica's speculative `index.add` must not
        // serve a version the DB no longer owns. (2) indexed: this run added chunks
        // to the index but the commit did not land a `ready` row — the
        // in-transaction chunk-budget rejection rolled the finalize back, or any
        // other throw after `index.add` did — so those chunks would otherwise stay
        // searchable with no backing row (an index/DB divergence, and exactly the
        // over-cap corpus the budget check refused). `removeDocument` is idempotent,
        // so covering both with one call is safe.
        await index.removeDocument(current.id);
        this.#indexed.delete(current.id);
      }
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
        // Idempotent: drop any prior copy so a second rebuild does not duplicate.
        await this.#replace(document, content);
        rebuilt++;
      }

      if (page.length < MAX_PAGE_LIMIT) break;
      afterId = page[page.length - 1]!.id;
    }

    return rebuilt;
  }

  /**
   * Bring this process's index level with the store, if any document changed
   * since it last looked (`documents.fingerprint`). Returns what `reconcile`
   * did, or `undefined` when nothing had changed.
   */
  async sync(): Promise<{ indexed: number; evicted: number } | undefined> {
    const fingerprint = await this.#options.store.documents.fingerprint();
    if (fingerprint === this.#lastFingerprint) return undefined;
    const outcome = await this.reconcile();
    this.#lastFingerprint = fingerprint;
    return outcome;
  }

  /**
   * Bring this process's index level with the store. The index lives in each
   * process, while a document is ingested, re-synced or deleted by one replica;
   * without this the others answer from what they built at startup.
   *
   * Each `ready` document is indexed at the content its row names, when this
   * process holds another version or none. A document that no longer exists is
   * evicted. One that exists but is not ready — a re-sync failed or under way —
   * keeps what this process holds, as on the replica whose re-sync failed. A
   * document re-synced while this runs may stay at its previous content until
   * the next pass.
   */
  async reconcile(): Promise<{ indexed: number; evicted: number }> {
    const { store, index, blobs, logger } = this.#options;
    const ready = new Set<string>();
    let indexed = 0;
    let afterId: string | undefined;
    for (;;) {
      const page = await store.documents.findReady(MAX_PAGE_LIMIT, afterId);
      for (const document of page) {
        ready.add(document.id);
        if (this.#indexed.get(document.id) === document.digest) continue;
        const bytes = document.digest ? await blobs.get(document.workspaceId, document.digest) : undefined;
        if (bytes === undefined) {
          logger?.warn("a ready document's content is not in the blob store; it stays out of this replica's index", {
            documentId: document.id,
            digest: document.digest,
          });
          continue;
        }
        await this.#replace(document, Buffer.from(bytes).toString('utf8'));
        indexed++;
      }
      if (page.length < MAX_PAGE_LIMIT) break;
      afterId = page[page.length - 1]!.id;
    }

    let evicted = 0;
    for (const id of [...this.#indexed.keys()]) {
      if (ready.has(id)) continue;
      if (await store.documents.get(id)) continue;
      await index.removeDocument(id);
      this.#indexed.delete(id);
      this.#content.delete(id);
      evicted++;
    }
    return { indexed, evicted };
  }

  /** Index `content` as this document's chunks, in place of any this process holds. */
  async #replace(document: Document, content: string): Promise<void> {
    const { index } = this.#options;
    const texts = chunkText(content, this.#options.chunk);
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
    this.#indexed.set(document.id, sha256Hex(content));
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
        this.#indexed.delete(document.id);
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

  /**
   * Delete one document: evict its chunks from the in-memory index, drop any
   * staged content, decrement the dataset's counts, and delete the row.
   *
   * Scoped to `(datasetId, documentId)`: a document whose `datasetId` does not
   * match the path is reported not-found rather than deleted, so a caller cannot
   * reach across into another dataset by naming a document id they learned out of
   * band (the IDOR guard the grant-revoke and connector-secret fixes established).
   *
   * The index eviction and staging-cache drop happen first and are in-memory (no
   * transaction covers them); the row delete and the count decrements then commit
   * together in ONE store transaction, so a crash cannot leave the counts
   * overstated relative to the rows — the exact drift #252 is about. Evict-then-
   * delete is the safe order: a transaction rollback leaves the durable row intact,
   * and the next `rebuild()` re-indexes it, whereas delete-then-evict could drop
   * the row while leaving orphaned chunks answering queries. Counts are clamped at
   * 0 because pre-fix datasets accrued `documentCount` with no matching decrement,
   * so a workspace's stored count may already exceed its live rows — a delete must
   * not drive it negative. Returns the number of chunks evicted.
   */
  async deleteDocument(datasetId: string, documentId: string): Promise<number> {
    const { store, index } = this.#options;
    const document = await store.documents.get(documentId);
    if (!document || document.datasetId !== datasetId) {
      throw notFound('Document', documentId);
    }

    await index.removeDocument(documentId);
    this.#indexed.delete(documentId);
    this.#content.delete(documentId);

    await store.transaction((tx) => {
      // Read the row's counts INSIDE the transaction, then delete, then decrement
      // by exactly what the freshly-read row held. Two hazards this closes:
      //   • Two concurrent deletes of the same id both saw it present before the
      //     transaction; `removeSync` reports whether THIS call removed a row, so
      //     the loser (0 rows) skips the decrement — no double-decrement (the #252
      //     read-then-act CAS on the claimed field).
      //   • The magnitude must come from the row as it stands now, not from the
      //     `document` copy read before the transaction opened: a re-sync that
      //     changed this document's chunkCount could have committed in between, and
      //     decrementing by the stale copy would drift the rollup off the true live
      //     sum (the under-count direction lets the corpus index past the quota).
      const fresh = tx.documents.findById(documentId);
      const removed = tx.documents.removeSync(documentId);
      if (removed && fresh) {
        tx.datasets.applyDocumentRemovalSync(
          datasetId,
          fresh.chunkCount,
          fresh.sizeBytes,
          this.#options.clock.now(),
        );
      }
    });

    return document.chunkCount;
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
  /** Hard upper bound on results per query, so a caller cannot request an unbounded set. */
  maxLimit?: number;
  /** Characters of each result handed to the model. */
  maxChunkChars?: number;
  /**
   * Hard upper bound on the raw query length before tokenizing/embedding. The
   * query is model-controlled and arrives up to the HTTP body limit; scoring is a
   * synchronous pass on the control-plane event loop proportional to the query's
   * term count, so an unbounded query is a denial of service against every tenant.
   * A real retrieval query is a short question, so the excess is truncated.
   */
  maxQueryChars?: number;
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

    // Bound the model-controlled query BEFORE it reaches tokenizing, embedding, or
    // scoring. This is the load-bearing DoS guard: every caller converges here, and
    // scoring is a synchronous pass on the control-plane event loop whose cost
    // scales with the query's term count. A real retrieval query is a short
    // question; truncating the raw text caps both the term count and the embedder
    // input regardless of how the query reached us.
    const maxQueryChars = this.#options.maxQueryChars ?? 1024;
    const boundedQuery = query.length > maxQueryChars ? query.slice(0, maxQueryChars) : query;

    // Clamp the result count to a hard ceiling so a caller cannot force an
    // unbounded copy/sort/return, independent of the default.
    const maxLimit = this.#options.maxLimit ?? 50;
    const requested = limit ?? this.#options.defaultLimit ?? 5;
    const boundedLimit = Math.min(Math.max(1, requested), maxLimit);

    const vector = this.#options.embedder
      ? (await this.#options.embedder.embed([boundedQuery]))[0]
      : undefined;

    const results = await this.#options.index.search(
      datasetIds,
      boundedQuery,
      boundedLimit,
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
