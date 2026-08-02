// =============================================================================
// Embedder — multi-provider embedding generation
// Supports: OpenAI API, Ollama, ONNX (@huggingface/transformers), none
// Provider selection: config.llm.provider → API embeddings if available,
// ONNX fallback, graceful no-op if nothing available
// =============================================================================

import { createRequire } from 'node:module';
import { existsSync } from 'fs';
import { getDatabase } from '../db.js';
import { join } from 'path';

// Opaque type for the @huggingface/transformers pipeline — no published types
type OnnxPipeline = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>;
import { detectCapabilities, getEmbeddingDimension, type LLMConfig } from './config.js';
import { memeshDir } from './paths.js';

let onnxPipelineInstance: OnnxPipeline | null = null;
let onnxPipelineLoading: Promise<OnnxPipeline> | null = null;
let onnxAvailableChecked = false;
let onnxAvailableResult = false;
/**
 * Cut-off for a vector hit, in the units `entities_vec` actually returns.
 *
 * `entities_vec` is declared as `vec0(embedding float[N])` with no
 * `distance_metric`, so sqlite-vec uses **L2**. Embeddings are unit vectors
 * (`normalize: true` in `embedWithOnnx`, and both API providers return
 * normalised vectors), which puts L2 in the range 0…2 and relates it to cosine
 * by `cos = 1 - d²/2`. √2 is therefore exactly cosine 0 — "no relationship" —
 * and everything above it is negatively correlated.
 *
 * This used to be `1`, a value that only makes sense if the distance were
 * cosine *distance* on a 0…1 scale. Against real L2 numbers it discarded
 * essentially every hit: measured over 50 LongMemEval questions, 5 of 1000
 * vector hits survived it (0.5%), and the correct session sat at a median
 * distance of 1.187 — above the cut. The vector half of "hybrid search" was
 * doing nothing at all, silently, while the README advertised it.
 *
 * 1.30 is calibrated against two independent measurements, not derived. The
 * geometric cut — √2, exactly cosine 0 — turned out to sit in the middle of the
 * noise, because MiniLM's space is roughly isotropic and unrelated text lands
 * *at* cosine 0 rather than below it:
 *
 *   LongMemEval, distance of the CORRECT session   min 0.864  p50 1.187  p75 1.269
 *   LongMemEval, distance of ALL returned hits                p50 1.357
 *   nonsense query ("nonexistent-xyz-123")         nearest    1.413
 *   random letters                                 nearest    1.371
 *   unrelated English sentence                     nearest    1.430
 *   genuinely related question                     nearest    0.872 / 1.157
 *
 * Signal sits below ~1.27, noise above ~1.37. A cut at √2 lets every one of
 * those noise cases through, which means a query matching nothing lexically
 * comes back with an unrelated memory instead of an honest "no results".
 *
 * The recall cost is nil: R@5 measured identical (95.0%) at thresholds 1.20,
 * 1.35, 1.50 and 2.00 over 100 questions, so the tight end of that range trades
 * no recall for the precision. Re-derive it if the embedding model changes —
 * the number belongs to MiniLM-L6, not to the algorithm.
 */
export const MAX_VECTOR_DISTANCE = 1.30;

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
const ONNX_TRANSFORMERS_PACKAGE = '@huggingface/transformers';
// The local ONNX model id + on-disk cache layout. These are the ONE authoritative
// home for "which model, cached where" — getOnnxPipeline() and isOnnxModelCached()
// both derive from them, so a caller (e.g. `memesh doctor`) never has to
// reconstruct the path and can't drift from what the embedder actually loads.
const ONNX_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const ONNX_CACHE_SUBDIR = 'models';
const pendingEmbeddingWrites = new Set<Promise<unknown>>();

/**
 * Is the local ONNX model already downloaded (so an embed call would NOT
 * trigger a ~90 MB download)? Owned here because this module owns the model id
 * and cache dir. Callers ask the embedder rather than hardcoding its layout.
 *
 * Points at the leaf weights file: a half-finished download (dir present,
 * weights absent) correctly reads as NOT cached.
 */
export function isOnnxModelCached(): boolean {
  try {
    const [org, name] = ONNX_MODEL_ID.split('/');
    return existsSync(join(memeshDir(), ONNX_CACHE_SUBDIR, org, name, 'onnx', 'model.onnx'));
  } catch {
    return false;
  }
}

// --- Public API ---

/**
 * Check if any embedding method is available.
 *
 * Reads from `caps.embeddings` (which now respects `config.embedder`
 * separately from `config.llm`, per #36) — pre-#36 this incorrectly
 * tied embedding availability to the LLM provider.
 */
export function isEmbeddingAvailable(): boolean {
  const caps = detectCapabilities();
  if (caps.embeddings === 'openai') return true;
  if (caps.embeddings === 'ollama') return true;
  if (caps.embeddings === 'onnx') return isOnnxAvailable();
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

/**
 * Reset cached state (for testing).
 */
export function resetEmbeddingState(): void {
  onnxAvailableChecked = false;
  onnxAvailableResult = false;
  onnxPipelineInstance = null;
  onnxPipelineLoading = null;
}

export function scheduleEmbedAndStore(entityId: number, text: string): void {
  const pending = embedAndStore(entityId, text);
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
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function isDatabaseLifecycleError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('message' in err)) return false;
  const message = String(err.message);
  return message === 'Database not opened' || message.includes('database connection is not open');
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
export async function embedText(text: string): Promise<Float32Array | null> {
  const caps = detectCapabilities();

  if (caps.embeddings === 'openai' || caps.embeddings === 'ollama') {
    // Reuse the LLM credential for the same provider, if present.
    // Otherwise pass a minimal config — the embedder API call will
    // fail and we fall through to ONNX below.
    const sharedKey = caps.llm?.provider === caps.embeddings ? caps.llm.apiKey : undefined;
    const cfg = { provider: caps.embeddings, model: undefined, apiKey: sharedKey } as LLMConfig;
    const result = await embedWithProvider(text, cfg);
    if (result) return result;
  }

  // Fallback to ONNX (default for fresh installs and Anthropic LLM users).
  return embedWithOnnx(text);
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
  /** The provider returned nothing (empty text, provider down, ONNX absent). */
  | 'no_embedding'
  /** Provider dimension ≠ the table's. Nothing written, on purpose. */
  | 'dimension_mismatch'
  /** The database write threw. */
  | 'write_failed'
  /** The database is closing. Nothing written, and nothing wrong. */
  | 'database_closed';

/**
 * Generate an embedding and store it in entities_vec.
 * Validates dimension matches before writing to prevent silent failures.
 *
 * Returns what happened — see {@link EmbedOutcome}. Callers that report
 * progress MUST branch on it; treating a non-throw as a write is the defect
 * this return value exists to remove.
 */
export async function embedAndStore(entityId: number, text: string): Promise<EmbedOutcome> {
  try {
    const embedding = await embedText(text);
    if (!embedding) return 'no_embedding';

    const db = getDatabase();

    // CRITICAL: Validate embedding dimension matches DB schema
    // Prevents silent write failures when provider fallback changes dimension
    // (e.g., Ollama 768-dim → ONNX 384-dim fallback)
    const storedDim = db.prepare(
      "SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'"
    ).get() as { value: string } | undefined;

    const expectedDim = storedDim ? parseInt(storedDim.value, 10) : 0;
    const actualDim = embedding.length;

    if (expectedDim > 0 && actualDim !== expectedDim) {
      // Two different causes land here and they need different instructions.
      // A transient provider fallback (Ollama down → ONNX) is fixed by
      // repairing the provider and re-running `memesh reindex`. A deliberate
      // embedder switch is NOT: plain `reindex` cannot change the table's
      // dimension, so it would keep hitting this same branch forever. That is
      // what `--vectors` is for.
      process.stderr.write(
        `MeMesh: Embedding dimension mismatch (got ${actualDim}, expected ${expectedDim}). ` +
        `Skipping vector write for entity ${entityId}. ` +
        `If the configured provider failed and a fallback was used, fix the provider and run ` +
        `'memesh reindex'. If you meant to switch embedders, the vector index has to be ` +
        `rebuilt at the new dimension: 'memesh reindex --vectors'.\n`
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
    // Anthropic has no embedding API — fall through to ONNX
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
  // Default fresh-install behaviour is local ONNX embeddings; cloud
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

// --- ONNX (local, @huggingface/transformers) ---

function isOnnxAvailable(): boolean {
  if (onnxAvailableChecked) return onnxAvailableResult;
  onnxAvailableChecked = true;
  try {
    const require = createRequire(import.meta.url);
    require.resolve(ONNX_TRANSFORMERS_PACKAGE);
    onnxAvailableResult = true;
  } catch {
    onnxAvailableResult = false;
  }
  return onnxAvailableResult;
}

async function getOnnxPipeline(): Promise<OnnxPipeline> {
  if (onnxPipelineInstance) return onnxPipelineInstance;
  if (onnxPipelineLoading) return onnxPipelineLoading;

  onnxPipelineLoading = (async () => {
    try {
      const mod = await import(ONNX_TRANSFORMERS_PACKAGE) as { pipeline: (task: string, model: string) => Promise<OnnxPipeline>; env?: { cacheDir?: string; allowLocalModels?: boolean } };
      const createPipeline = mod.pipeline;
      const env = mod.env;
      if (env) {
        env.cacheDir = join(memeshDir(), ONNX_CACHE_SUBDIR);
        env.allowLocalModels = true;
      }
      onnxPipelineInstance = await createPipeline(
        'feature-extraction',
        ONNX_MODEL_ID,
      );
      return onnxPipelineInstance;
    } catch (err) {
      // Reset so next call retries instead of returning cached rejected promise
      onnxPipelineLoading = null;
      throw err;
    }
  })();

  return onnxPipelineLoading;
}

async function embedWithOnnx(text: string): Promise<Float32Array | null> {
  if (!isOnnxAvailable()) return null;
  try {
    const pipe = await getOnnxPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  } catch {
    return null;
  }
}
