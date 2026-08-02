import { createRequire } from 'node:module';
import { existsSync } from 'fs';
import { getDatabase } from '../db.js';
import { join } from 'path';
import { detectCapabilities, getEmbeddingDimension } from './config.js';
import { memeshDir } from './paths.js';
let onnxPipelineInstance = null;
let onnxPipelineLoading = null;
let onnxAvailableChecked = false;
let onnxAvailableResult = false;
export const MAX_VECTOR_DISTANCE = 1.30;
export function vectorSimilarity(distance) {
    return Math.max(0, 1 - distance / 2);
}
const ONNX_TRANSFORMERS_PACKAGE = '@huggingface/transformers';
const ONNX_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const ONNX_CACHE_SUBDIR = 'models';
const pendingEmbeddingWrites = new Set();
export function isOnnxModelCached() {
    try {
        const [org, name] = ONNX_MODEL_ID.split('/');
        return existsSync(join(memeshDir(), ONNX_CACHE_SUBDIR, org, name, 'onnx', 'model.onnx'));
    }
    catch {
        return false;
    }
}
export function isEmbeddingAvailable() {
    const caps = detectCapabilities();
    if (caps.embeddings === 'openai')
        return true;
    if (caps.embeddings === 'ollama')
        return true;
    if (caps.embeddings === 'onnx')
        return isOnnxAvailable();
    return false;
}
export async function canRefillVectorIndex() {
    const target = getEmbeddingDimension();
    if (!Number.isInteger(target) || target <= 0)
        return false;
    try {
        const probe = await embedText('memesh vector index rebuild probe');
        return probe !== null && probe.length === target;
    }
    catch {
        return false;
    }
}
export { getEmbeddingDimension } from './config.js';
export function resetEmbeddingState() {
    onnxAvailableChecked = false;
    onnxAvailableResult = false;
    onnxPipelineInstance = null;
    onnxPipelineLoading = null;
}
export function scheduleEmbedAndStore(entityId, text) {
    const pending = embedAndStore(entityId, text);
    const tracked = pending.finally(() => {
        pendingEmbeddingWrites.delete(tracked);
    });
    pendingEmbeddingWrites.add(tracked);
}
export async function flushPendingEmbeddings() {
    while (pendingEmbeddingWrites.size > 0) {
        await Promise.allSettled([...pendingEmbeddingWrites]);
    }
}
function toVectorRowId(entityId) {
    if (!Number.isSafeInteger(entityId) || entityId <= 0) {
        throw new Error(`Invalid entity id for vector storage: ${entityId}`);
    }
    return BigInt(entityId);
}
function toVectorBlob(embedding) {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
function isDatabaseLifecycleError(err) {
    if (!err || typeof err !== 'object' || !('message' in err))
        return false;
    const message = String(err.message);
    return message === 'Database not opened' || message.includes('database connection is not open');
}
export async function embedText(text) {
    const caps = detectCapabilities();
    if (caps.embeddings === 'openai' || caps.embeddings === 'ollama') {
        const sharedKey = caps.llm?.provider === caps.embeddings ? caps.llm.apiKey : undefined;
        const cfg = { provider: caps.embeddings, model: undefined, apiKey: sharedKey };
        const result = await embedWithProvider(text, cfg);
        if (result)
            return result;
    }
    return embedWithOnnx(text);
}
export async function embedAndStore(entityId, text) {
    try {
        const embedding = await embedText(text);
        if (!embedding)
            return 'no_embedding';
        const db = getDatabase();
        const storedDim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
        const expectedDim = storedDim ? parseInt(storedDim.value, 10) : 0;
        const actualDim = embedding.length;
        if (expectedDim > 0 && actualDim !== expectedDim) {
            process.stderr.write(`MeMesh: Embedding dimension mismatch (got ${actualDim}, expected ${expectedDim}). ` +
                `Skipping vector write for entity ${entityId}. ` +
                `If the configured provider failed and a fallback was used, fix the provider and run ` +
                `'memesh reindex'. If you meant to switch embedders, the vector index has to be ` +
                `rebuilt at the new dimension: 'memesh reindex --vectors'.\n`);
            return 'dimension_mismatch';
        }
        const rowId = toVectorRowId(entityId);
        const entity = db.prepare('SELECT status FROM entities WHERE id = ?').get(entityId);
        if (!entity || entity.status === 'archived') {
            db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(rowId);
            return 'removed';
        }
        const writeVector = db.transaction(() => {
            db.prepare('DELETE FROM entities_vec WHERE rowid = ?').run(rowId);
            db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(rowId, toVectorBlob(embedding));
        });
        writeVector();
        return 'stored';
    }
    catch (err) {
        if (isDatabaseLifecycleError(err))
            return 'database_closed';
        if (err && typeof err === 'object' && 'message' in err) {
            process.stderr.write(`MeMesh: Vector write failed for entity ${entityId}: ${err.message}\n`);
        }
        return 'write_failed';
    }
}
export function vectorSearch(queryEmbedding, limit = 20) {
    try {
        const db = getDatabase();
        const rows = db
            .prepare('SELECT rowid AS id, distance FROM entities_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
            .all(toVectorBlob(queryEmbedding), limit);
        return rows.filter((hit) => hit.distance < MAX_VECTOR_DISTANCE);
    }
    catch {
        return [];
    }
}
async function embedWithProvider(text, config) {
    try {
        if (config.provider === 'openai')
            return await embedWithOpenAI(text, config);
        if (config.provider === 'ollama')
            return await embedWithOllama(text, config);
        return null;
    }
    catch {
        return null;
    }
}
async function embedWithOpenAI(text, config) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey)
        return null;
    const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: text.slice(0, 8000),
        }),
    });
    if (!res.ok)
        return null;
    const data = await res.json();
    const embedding = data.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding))
        return null;
    return new Float32Array(embedding);
}
async function embedWithOllama(text, config) {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const model = config.model || 'nomic-embed-text';
    const res = await fetch(`${host}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text.slice(0, 8000) }),
    });
    if (!res.ok)
        return null;
    const data = await res.json();
    const embedding = data.embeddings?.[0];
    if (!embedding || !Array.isArray(embedding))
        return null;
    return new Float32Array(embedding);
}
function isOnnxAvailable() {
    if (onnxAvailableChecked)
        return onnxAvailableResult;
    onnxAvailableChecked = true;
    try {
        const require = createRequire(import.meta.url);
        require.resolve(ONNX_TRANSFORMERS_PACKAGE);
        onnxAvailableResult = true;
    }
    catch {
        onnxAvailableResult = false;
    }
    return onnxAvailableResult;
}
async function getOnnxPipeline() {
    if (onnxPipelineInstance)
        return onnxPipelineInstance;
    if (onnxPipelineLoading)
        return onnxPipelineLoading;
    onnxPipelineLoading = (async () => {
        try {
            const mod = await import(ONNX_TRANSFORMERS_PACKAGE);
            const createPipeline = mod.pipeline;
            const env = mod.env;
            if (env) {
                env.cacheDir = join(memeshDir(), ONNX_CACHE_SUBDIR);
                env.allowLocalModels = true;
            }
            onnxPipelineInstance = await createPipeline('feature-extraction', ONNX_MODEL_ID);
            return onnxPipelineInstance;
        }
        catch (err) {
            onnxPipelineLoading = null;
            throw err;
        }
    })();
    return onnxPipelineLoading;
}
async function embedWithOnnx(text) {
    if (!isOnnxAvailable())
        return null;
    try {
        const pipe = await getOnnxPipeline();
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return new Float32Array(output.data);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=embedder.js.map