// =============================================================================
// Embedder — local neural embedding generation via ONNX
// Uses @xenova/transformers (Xenova/all-MiniLM-L6-v2, 384 dimensions)
// Gracefully no-ops if package is not installed or model unavailable
// =============================================================================

import { createRequire } from 'node:module';
import { getDatabase } from '../db.js';
import { homedir } from 'os';
import { join } from 'path';

let pipelineInstance: any = null;
let pipelineLoading: Promise<any> | null = null;
let availableChecked = false;
let availableResult = false;

/**
 * Check if @xenova/transformers can be imported.
 * Cached after first check.
 */
export function isEmbeddingAvailable(): boolean {
  if (availableChecked) return availableResult;
  availableChecked = true;
  try {
    // ESM project — use createRequire for synchronous resolution check
    const require = createRequire(import.meta.url);
    require.resolve('@xenova/transformers');
    availableResult = true;
  } catch {
    availableResult = false;
  }
  return availableResult;
}

/**
 * Reset the cached availability check (for testing).
 */
export function resetEmbeddingState(): void {
  availableChecked = false;
  availableResult = false;
  pipelineInstance = null;
  pipelineLoading = null;
}

/**
 * Get or create the embedding pipeline (singleton).
 * First call downloads the model (~30MB) to ~/.memesh/models/.
 */
async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    // Dynamic import — type as any to avoid TS errors with optional dependency
    const mod: any = await import('@xenova/transformers');
    const createPipeline = mod.pipeline;
    const env = mod.env;
    if (env) {
      env.cacheDir = join(homedir(), '.memesh', 'models');
      env.allowLocalModels = true;
    }
    pipelineInstance = await createPipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );
    return pipelineInstance;
  })();

  return pipelineLoading;
}

/**
 * Generate a 384-dim embedding for the given text.
 * Returns null if embedding is unavailable or fails.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (!isEmbeddingAvailable()) return null;
  try {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  } catch {
    return null;
  }
}

/**
 * Generate embedding for entity text and store in entities_vec.
 * Silently skips if embedding generation fails.
 */
export async function embedAndStore(
  entityId: number,
  text: string
): Promise<void> {
  const embedding = await embedText(text);
  if (!embedding) return;

  try {
    const db = getDatabase();
    db.prepare(
      'INSERT OR REPLACE INTO entities_vec (rowid, embedding) VALUES (?, ?)'
    ).run(entityId, Buffer.from(embedding.buffer));
  } catch {
    // DB write failed — skip silently
  }
}

/**
 * Search entities_vec for similar embeddings by cosine distance.
 * Returns entity IDs sorted by distance (lower = more similar).
 */
export function vectorSearch(
  queryEmbedding: Float32Array,
  limit: number = 20
): Array<{ id: number; distance: number }> {
  try {
    const db = getDatabase();
    return db
      .prepare(
        'SELECT rowid AS id, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
      )
      .all(
        Buffer.from(queryEmbedding.buffer),
        limit
      ) as Array<{ id: number; distance: number }>;
  } catch {
    return [];
  }
}
