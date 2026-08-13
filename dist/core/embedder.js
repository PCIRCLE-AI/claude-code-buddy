import { getDatabase } from '../db.js';
import { detectCapabilities, getEmbeddingDimension } from './config.js';
import { hasVectorIndex } from '../storage/vector-index.js';
export const MAX_VECTOR_DISTANCE = 1.00;
export function vectorSimilarity(distance) {
    return Math.max(0, 1 - distance / 2);
}
const pendingEmbeddingWrites = new Set();
export function isEmbeddingAvailable() {
    const caps = detectCapabilities();
    if (caps.embeddings === 'openai')
        return true;
    if (caps.embeddings === 'ollama')
        return true;
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
    let sumSquares = 0;
    for (let i = 0; i < embedding.length; i++)
        sumSquares += embedding[i] * embedding[i];
    const norm = Math.sqrt(sumSquares);
    if (Number.isFinite(norm) && norm > 0 && Math.abs(norm - 1) > 1e-6) {
        const unit = new Float32Array(embedding.length);
        for (let i = 0; i < embedding.length; i++)
            unit[i] = embedding[i] / norm;
        embedding = unit;
    }
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
function isDatabaseLifecycleError(err) {
    if (!err || typeof err !== 'object' || !('message' in err))
        return false;
    const message = String(err.message);
    return message === 'Database not opened' || message.includes('database connection is not open');
}
export function entityEmbedText(name, observations) {
    return `${name} ${observations.join(' ')}`;
}
export async function embedText(text) {
    const caps = detectCapabilities();
    if (caps.embeddings === 'openai' || caps.embeddings === 'ollama') {
        const sharedKey = caps.llm?.provider === caps.embeddings ? caps.llm.apiKey : undefined;
        const cfg = { provider: caps.embeddings, model: undefined, apiKey: sharedKey };
        return rejectNonFinite(await embedWithProvider(text, cfg), caps.embeddings);
    }
    return null;
}
function rejectNonFinite(vector, provider) {
    if (!vector)
        return null;
    for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) {
            process.stderr.write(`MeMesh: the ${provider} embedder returned a non-finite value at position ${i} ` +
                `(${vector[i]}). Refusing the vector — it would have matched every entity it was ` +
                `compared against. This text stays on keyword search; check the embedding model.\n`);
            return null;
        }
    }
    return vector;
}
export async function embedAndStore(entityId, text) {
    try {
        const embedding = await embedText(text);
        if (!embedding)
            return 'no_embedding';
        const db = getDatabase();
        if (!hasVectorIndex(db))
            return 'no_vector_index';
        const storedDim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
        const expectedDim = storedDim ? parseInt(storedDim.value, 10) : 0;
        const actualDim = embedding.length;
        if (expectedDim > 0 && actualDim !== expectedDim) {
            process.stderr.write(`MeMesh: Embedding dimension mismatch (got ${actualDim}, expected ${expectedDim}). ` +
                `Skipping vector write for entity ${entityId}. ` +
                `If you switched embedders, the vector index has to be rebuilt at the new ` +
                `dimension: 'memesh reindex --vectors'.\n`);
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
        if (!hasVectorIndex(db))
            return [];
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
//# sourceMappingURL=embedder.js.map