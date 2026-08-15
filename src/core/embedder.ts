// =============================================================================
// Embedder — multi-provider embedding generation
// Supports: OpenAI API, Ollama, none (FTS5 keyword-only)
// Provider selection: config.embedder.provider → API/local-server embeddings
// if configured; graceful no-op (keyword-only recall) if nothing is available.
// =============================================================================

import { getDatabase } from '../db.js';
import { detectCapabilities, getEmbeddingDimension, type Capabilities, type LLMConfig } from './config.js';
import { hasVectorIndex } from '../storage/vector-index.js';

/**
 * Cut-off for a vector hit, in the units `entities_vec` actually returns.
 *
 * `entities_vec` is declared as `vec0(embedding float[N])` with no
 * `distance_metric`, so sqlite-vec uses **L2**. Embeddings are unit vectors
 * (both supported providers return normalised vectors), which puts L2 in the
 * range 0…2 and relates it to cosine by `cos = 1 - d²/2`. √2 is therefore
 * exactly cosine 0 — "no relationship" — and everything above it is
 * negatively correlated.
 *
 * This used to be `1`, a value that only makes sense if the distance were
 * cosine *distance* on a 0…1 scale. Against real L2 numbers it discarded
 * essentially every hit, so the vector half of "hybrid search" was doing
 * nothing at all, silently.
 *
 * It was then 1.30, calibrated on the local ONNX MiniLM-L6 embedder memesh used
 * to ship (signal <~1.27, noise >~1.37). That embedder has been removed; memesh
 * now standardises on ollama (nomic-embed-text, 768-dim), whose space is far
 * tighter — 1.30 on nomic admitted 100% of measured noise (every nonsense query
 * returned unrelated memories as "semantic hits").
 *
 * 1.00 is re-derived for nomic-embed-text, MEASURED on a real 575-entity graph
 * (L2 over unit vectors; nearest-hit distance per query):
 *
 *   SIGNAL (queries paraphrasing real memories)  n=12  0.858 … 1.010  (11/12 ≤ 0.988)
 *   NOISE  (queries unrelated to the graph)       n=12  0.983 … 1.104  (11/12 ≥ 1.020)
 *
 * The classes TOUCH in a narrow ~0.98–1.02 band (one signal straggler at 1.010,
 * one noise outlier at 0.983) — there is no clean gap, so no single cut is
 * perfect. 1.00 sits in that crossover: it keeps the signal body and rejects the
 * noise body (≥1.02), erring toward recall because FTS5 keyword search supplies
 * the precision half of hybrid recall and a semantic-only hit is never certified
 * relevant anyway (see Entity.match). The number belongs to the model, not the
 * algorithm — re-derive it (scripts/measure or the calibrate harness against a
 * real graph) if the embedder changes.
 */
export const MAX_VECTOR_DISTANCE = 1.00;

/**
 * Map a distance from `entities_vec` onto the 0…1 relevance scale the scorer
 * expects. Lives next to `MAX_VECTOR_DISTANCE` because both encode the same
 * fact — that these are L2 distances over unit vectors, ranging 0…2 — and
 * keeping them apart is how they drifted: the cut-off assumed 0…1 and the
 * conversion assumed 0…1, against numbers that are neither.
 *
 * `1 - d` (the previous form) sends every distance above 1.0 to zero, and real
 * distances for related text sit at 1.0–1.44: 98.8% of hits collapsed to 0.
 */
export function vectorSimilarity(distance: number): number {
  return Math.max(0, 1 - distance / 2);
}
const pendingEmbeddingWrites = new Set<Promise<unknown>>();

// --- Public API ---

/**
 * Check if any embedding method is available.
 *
 * Reads from `caps.embeddings` (which now respects `config.embedder`
 * separately from `config.llm`, per #36) — pre-#36 this incorrectly
 * tied embedding availability to the LLM provider.
 */
export function isEmbeddingAvailable(caps: Capabilities = detectCapabilities()): boolean {
  if (caps.embeddings === 'openai') return true;
  if (caps.embeddings === 'ollama') return true;
  // 'tfidf' (keyword-only) and 'anthropic' (no embedding API) have no neural
  // embedder: recall degrades to FTS5. Every vector path checks this first.
  return false;
}

/**
 * Prove that this machine can produce a vector of the width the index will be
 * rebuilt to — by producing one.
 *
 * {@link isEmbeddingAvailable} is not enough to authorise a rebuild, and the
 * difference is the difference between a claim and a proof. It answers "which
 * provider did the config select", and for `openai` and `ollama` it answers
 * `true` unconditionally: no key is checked, no endpoint is reached, no
 * dimension is compared. A user whose key has expired, or who typed the
 * provider name before pasting the key, or whose Ollama is not running, gets
 * `true` — and `memesh reindex --vectors` then drops every embedding in the
 * database and finds it cannot write a single one back. That is the
 * unrecoverable loss the refusal exists to prevent, caused by the command
 * offered as the safe way through it.
 *
 * One real embedding call answers both halves that matter: whether anything
 * responds, and whether what it returns is the width `entities_vec` is about to
 * be declared with. A provider that answers at the wrong width would leave the
 * rebuilt index just as empty as no provider at all.
 *
 * Deliberately not cached: it is called once, immediately before a destructive
 * step, and a stale yes is exactly what must not happen here.
 */
export async function canRefillVectorIndex(): Promise<boolean> {
  const target = getEmbeddingDimension();
  if (!Number.isInteger(target) || target <= 0) return false;
  try {
    const probe = await embedText('memesh vector index rebuild probe');
    return probe !== null && probe.length === target;
  } catch {
    // A thrown provider error is a "no" like any other. Letting it propagate
    // would abort the command with a stack trace instead of the refusal
    // message that tells the user what to fix.
    return false;
  }
}

// getEmbeddingDimension() is in config.ts to avoid circular dependency with db.ts
export { getEmbeddingDimension } from './config.js';

export function scheduleEmbedAndStore(entityId: number, text: string, caps?: Capabilities): void {
  const pending = embedAndStore(entityId, text, caps);
  const tracked = pending.finally(() => {
    pendingEmbeddingWrites.delete(tracked);
  });
  pendingEmbeddingWrites.add(tracked);
}

export async function flushPendingEmbeddings(): Promise<void> {
  while (pendingEmbeddingWrites.size > 0) {
    await Promise.allSettled([...pendingEmbeddingWrites]);
  }
}

function toVectorRowId(entityId: number): bigint {
  if (!Number.isSafeInteger(entityId) || entityId <= 0) {
    throw new Error(`Invalid entity id for vector storage: ${entityId}`);
  }
  return BigInt(entityId);
}

function toVectorBlob(embedding: Float32Array): Buffer {
  // Normalize to unit length before the bytes ever reach sqlite — this is
  // the single point every stored vector AND every query vector passes
  // through, and every distance constant in the codebase
  // (MAX_VECTOR_DISTANCE, vectorSimilarity, conflict-candidates' d²/2
  // conversion) is derived under "embeddings are unit vectors". Both shipped
  // providers already return unit vectors, so for them this is an epsilon
  // no-op; it exists so a future provider — or Ollama's legacy
  // /api/embeddings endpoint, which does NOT normalize — cannot silently
  // invalidate the whole distance stack. A zero or non-finite norm is left
  // untouched: upstream validation owns rejecting degenerate vectors, and
  // dividing by it would manufacture NaNs here.
  let sumSquares = 0;
  for (let i = 0; i < embedding.length; i++) sumSquares += embedding[i] * embedding[i];
  const norm = Math.sqrt(sumSquares);
  if (Number.isFinite(norm) && norm > 0 && Math.abs(norm - 1) > 1e-6) {
    const unit = new Float32Array(embedding.length);
    for (let i = 0; i < embedding.length; i++) unit[i] = embedding[i] / norm;
    embedding = unit;
  }
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function isDatabaseLifecycleError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('message' in err)) return false;
  const message = String(err.message);
  return message === 'Database not opened' || message.includes('database connection is not open');
}

/**
 * The exact text an entity's vector is built from — the one definition, so
 * every writer agrees.
 *
 * This has to be shared rather than inlined per call site, because a vector
 * index only answers honestly when every row in it was built the same way.
 * `reindex()` used to embed observations alone while `remember()`, the dreamer
 * digest and the transcript-accept path all embedded name + observations, so an
 * entity's vector depended on which code last touched it: reindex a database
 * and every distance in it shifted, silently, against a dedup threshold
 * (`TRANSCRIPT_DEDUP_MAX_DISTANCE`) and a published recall figure that were both
 * measured on the name + observations form.
 *
 * Note for existing databases: this changes what NEW writes embed. Rows already
 * embedded by an older `reindex` keep their observations-only vector until the
 * next `memesh reindex` rebuilds them — which is a paid call on a cloud
 * provider, so it is left to the operator rather than triggered here.
 */
export function entityEmbedText(name: string, observations: string[]): string {
  return `${name} ${observations.join(' ')}`;
}

/**
 * Generate an embedding for the given text.
 *
 * Provider routing comes from `caps.embeddings` (driven by
 * `config.embedder.provider`, #36), NOT from `caps.llm`. This is
 * the fix for the cascade bug where switching LLM provider used to
 * silently re-route embeddings to a different dimension.
 *
 * The provider's API key (when needed for openai/ollama) is read
 * from the matching LLMConfig — they share credentials by provider.
 */
export async function embedText(
  text: string,
  caps: Capabilities = detectCapabilities(),
): Promise<Float32Array | null> {
  if (caps.embeddings === 'openai' || caps.embeddings === 'ollama') {
    // Reuse the LLM credential for the same provider, if present.
    // Otherwise pass a minimal config — a failed provider call returns
    // null, which callers treat as "no embedding" (recall stays on FTS5).
    const sharedKey = caps.llm?.provider === caps.embeddings ? caps.llm.apiKey : undefined;
    const cfg = { provider: caps.embeddings, model: undefined, apiKey: sharedKey } as LLMConfig;
    return rejectNonFinite(await embedWithProvider(text, cfg), caps.embeddings);
  }

  // No neural embedder configured (keyword-only / anthropic): FTS5 alone.
  return null;
}

/**
 * Refuse a vector with a non-finite component, here rather than at each writer.
 *
 * `new Float32Array([...])` coerces silently, and the coercions it does are not
 * the ones you would guess. Measured, for the value at one position:
 *
 *   undefined → NaN        "NaN"  → NaN        {} → NaN        "abc" → NaN
 *   null      → 0          ""     → 0          [1] → 1         1e999 → Infinity
 *
 * So a JSON `null` is NOT the dangerous case (it silently becomes a legitimate
 * 0), while a short array, a stringified `NaN` from a Python-backed server, or
 * a magnitude past float64 range all land as non-finite. sqlite-vec then stores
 * and returns that just as quietly — measured: `[0.1, NaN, 0.3]` inserts and
 * reads back unchanged. Downstream, `NaN` breaks the comparisons that are
 * supposed to bound it: `NaN >= limit` is false, so a distance test written as
 * an early exit calls the pair a match, and one corrupt vector joins every
 * cluster and every search result it is compared against.
 *
 * Guarding in `embedText` rather than in `embedAndStore` covers the query side
 * too — a corrupt QUERY vector matches everything just as readily as a corrupt
 * stored one, and `vectorSearch` never passes through the store path.
 *
 * Returning `null` puts it on the path callers already handle ("no embedding —
 * keyword search alone"). The warning is what keeps that from being silent: a
 * provider emitting NaN is broken, and the operator has to hear about it.
 */
function rejectNonFinite(vector: Float32Array | null, provider: string): Float32Array | null {
  if (!vector) return null;
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      process.stderr.write(
        `MeMesh: the ${provider} embedder returned a non-finite value at position ${i} ` +
        `(${vector[i]}). Refusing the vector — it would have matched every entity it was ` +
        `compared against. This text stays on keyword search; check the embedding model.\n`
      );
      return null;
    }
  }
  return vector;
}

/**
 * What `embedAndStore` actually did.
 *
 * The function has six exits and exactly one of them leaves a vector in the
 * table, but it used to return `void` from all six — so the only signal a
 * caller got was "it didn't throw". `reindex` read that as success and counted
 * every one of them as embedded, then cleared `pending_reindex` and printed
 * `✅ Reindex complete` over an index it had written nothing to. Naming the
 * outcome is the fix; counting it is the caller's job.
 */
export type EmbedOutcome =
  /** A vector for this entity is now in entities_vec. */
  | 'stored'
  /** Entity archived or gone — its stale vector was deleted. Correct end state. */
  | 'removed'
  /** No embedder produced a vector (empty text, provider down, or keyword-only). */
  | 'no_embedding'
  /** Provider dimension ≠ the table's. Nothing written, on purpose. */
  | 'dimension_mismatch'
  /** The database write threw. */
  | 'write_failed'
  /** The database is closing. Nothing written, and nothing wrong. */
  | 'database_closed'
  /** sqlite-vec is not loaded, so there is no entities_vec to write to. */
  | 'no_vector_index';

/**
 * Generate an embedding and store it in entities_vec.
 * Validates dimension matches before writing to prevent silent failures.
 *
 * Returns what happened — see {@link EmbedOutcome}. Callers that report
 * progress MUST branch on it; treating a non-throw as a write is the defect
 * this return value exists to remove.
 */
export async function embedAndStore(entityId: number, text: string, caps?: Capabilities): Promise<EmbedOutcome> {
  try {
    const embedding = await embedText(text, caps);
    if (!embedding) return 'no_embedding';

    const db = getDatabase();
    // Asked before the dimension check, because without the extension there is
    // no table and no stored dimension either — the dimension branch would
    // report `dimension_mismatch` for a database that simply has no index.
    if (!hasVectorIndex(db)) return 'no_vector_index';

    // CRITICAL: Validate embedding dimension matches DB schema
    // Prevents silent write failures when the configured provider emits a
    // width the table was not built for (e.g. a table built at 384 for an
    // older embedder, now fed 768-dim ollama vectors).
    const storedDim = db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'"
    ).get() as { value: string } | undefined;

    const expectedDim = storedDim ? parseInt(storedDim.value, 10) : 0;
    const actualDim = embedding.length;

    if (expectedDim > 0 && actualDim !== expectedDim) {
      // A deliberate embedder switch (e.g. onto ollama at 768-dim against a
      // table built at 384) lands here: plain `reindex` cannot change the
      // table's dimension, so it would keep hitting this same branch forever.
      // That is what `--vectors` is for.
      process.stderr.write(
        `MeMesh: Embedding dimension mismatch (got ${actualDim}, expected ${expectedDim}). ` +
        `Skipping vector write for entity ${entityId}. ` +
        `If you switched embedders, the vector index has to be rebuilt at the new ` +
        `dimension: 'memesh reindex --vectors'.\n`
      );
      return 'dimension_mismatch';
    }

    const rowId = toVectorRowId(entityId);
    const entity = db.prepare(
      'SELECT status FROM entities WHERE id = ?'
    ).get(entityId) as { status: string } | undefined;

    if (!entity || entity.status === 'archived') {
      db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(rowId);
      return 'removed';
    }

    const writeVector = db.transaction(() => {
      // sqlite-vec does not reliably honor INSERT OR REPLACE for vec0 primary keys.
      db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(rowId);
      db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
        rowId,
        toVectorBlob(embedding)
      );
    });
    writeVector();
    return 'stored';
  } catch (err) {
    if (isDatabaseLifecycleError(err)) return 'database_closed';

    // DB write failed — log and skip
    if (err && typeof err === 'object' && 'message' in err) {
      process.stderr.write(`MeMesh: Vector write failed for entity ${entityId}: ${err.message}\n`);
    }
    return 'write_failed';
  }
}

/**
 * Search entities_vec for similar embeddings by cosine distance.
 */
export function vectorSearch(
  queryEmbedding: Float32Array,
  limit: number = 20
): Array<{ id: number; distance: number }> {
  try {
    const db = getDatabase();
    // Without sqlite-vec there is no index to search. The blanket catch below
    // would swallow the "no such table" too, but only by accident — and an
    // accident that also hides real query errors.
    if (!hasVectorIndex(db)) return [];
    const rows = db
      .prepare(
        'SELECT rowid AS id, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
      )
      .all(
        toVectorBlob(queryEmbedding),
        limit
      ) as Array<{ id: number; distance: number }>;
    return rows.filter((hit) => hit.distance < MAX_VECTOR_DISTANCE);
  } catch {
    return [];
  }
}

// --- Provider Implementations ---

async function embedWithProvider(text: string, config: LLMConfig): Promise<Float32Array | null> {
  try {
    if (config.provider === 'openai') return await embedWithOpenAI(text, config);
    if (config.provider === 'ollama') return await embedWithOllama(text, config);
    // Anthropic has no embedding API — no vector, recall stays on FTS5.
    return null;
  } catch {
    return null;
  }
}

async function embedWithOpenAI(text: string, config: LLMConfig): Promise<Float32Array | null> {
  // SECURITY (CodeQL js/file-access-to-http): this function intentionally
  // sends entity text content to the OpenAI embeddings API. That data flow
  // is a designed BYOK behaviour, not an information leak: it only fires
  // when the user has explicitly configured `llm.provider = 'openai'` in
  // ~/.memesh/config.json (or set MEMESH_AUTO_DETECT_LLM=1 + OPENAI_API_KEY).
  // Default fresh-install behaviour is keyword-only (FTS5) embeddings; cloud
  // providers are opt-in. The text body is bounded at 8000 chars by the
  // API contract and JSON-encoded with no shell/eval interpolation.
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000), // API input limit
    }),
  });
  if (!res.ok) return null;

  const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
  const embedding = data.data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding)) return null;

  return new Float32Array(embedding);
}

async function embedWithOllama(text: string, config: LLMConfig): Promise<Float32Array | null> {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = config.model || 'nomic-embed-text';

  const res = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text.slice(0, 8000) }),
  });
  if (!res.ok) return null;

  const data = await res.json() as { embeddings?: number[][] };
  const embedding = data.embeddings?.[0];
  if (!embedding || !Array.isArray(embedding)) return null;

  return new Float32Array(embedding);
}
