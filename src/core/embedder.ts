// =============================================================================
// Embedder — multi-provider embedding generation
// Supports: OpenAI API, Ollama, ONNX (@xenova/transformers), none
// Provider selection: config.llm.provider → API embeddings if available,
// ONNX fallback, graceful no-op if nothing available
// =============================================================================

import { createRequire } from 'node:module';
import { getDatabase } from '../db.js';
import { homedir } from 'os';
import { join } from 'path';
import { detectCapabilities, type LLMConfig } from './config.js';

let onnxPipelineInstance: any = null;
let onnxPipelineLoading: Promise<any> | null = null;
let onnxAvailableChecked = false;
let onnxAvailableResult = false;

// --- Public API ---

/**
 * Check if any embedding method is available.
 * Returns true if ONNX or a provider API is configured.
 */
export function isEmbeddingAvailable(): boolean {
  const caps = detectCapabilities();
  if (caps.llm?.provider === 'openai') return true;
  if (caps.llm?.provider === 'ollama') return true;
  return isOnnxAvailable();
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

/**
 * Generate an embedding for the given text.
 * Tries providers in order: OpenAI API → Ollama → ONNX → null.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  const caps = detectCapabilities();

  // Try provider API first
  if (caps.llm) {
    const result = await embedWithProvider(text, caps.llm);
    if (result) return result;
  }

  // Fallback to ONNX
  return embedWithOnnx(text);
}

/**
 * Generate embedding and store in entities_vec.
 * Silently skips if embedding generation fails.
 * Validates dimension matches before writing to prevent silent failures.
 */
export async function embedAndStore(entityId: number, text: string): Promise<void> {
  const embedding = await embedText(text);
  if (!embedding) return;

  try {
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
      process.stderr.write(
        `MeMesh: Embedding dimension mismatch (got ${actualDim}, expected ${expectedDim}). ` +
        `This usually means the configured provider failed and fallback was used. ` +
        `Skipping vector write for entity ${entityId}. ` +
        `Run 'memesh reindex' after fixing provider configuration.\n`
      );
      return;
    }

    db.prepare(
      'INSERT OR REPLACE INTO entities_vec (rowid, embedding) VALUES (?, ?)'
    ).run(entityId, Buffer.from(embedding.buffer));
  } catch (err) {
    // DB write failed — log and skip
    if (err && typeof err === 'object' && 'message' in err) {
      process.stderr.write(`MeMesh: Vector write failed for entity ${entityId}: ${err.message}\n`);
    }
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

// --- ONNX (local, @xenova/transformers) ---

function isOnnxAvailable(): boolean {
  if (onnxAvailableChecked) return onnxAvailableResult;
  onnxAvailableChecked = true;
  try {
    const require = createRequire(import.meta.url);
    require.resolve('@xenova/transformers');
    onnxAvailableResult = true;
  } catch {
    onnxAvailableResult = false;
  }
  return onnxAvailableResult;
}

async function getOnnxPipeline(): Promise<any> {
  if (onnxPipelineInstance) return onnxPipelineInstance;
  if (onnxPipelineLoading) return onnxPipelineLoading;

  onnxPipelineLoading = (async () => {
    try {
      const mod: any = await import('@xenova/transformers');
      const createPipeline = mod.pipeline;
      const env = mod.env;
      if (env) {
        env.cacheDir = join(homedir(), '.memesh', 'models');
        env.allowLocalModels = true;
      }
      onnxPipelineInstance = await createPipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
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
