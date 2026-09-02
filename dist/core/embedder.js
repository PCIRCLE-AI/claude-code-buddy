import { getDatabase } from '../db.js';
import { detectCapabilities, getEmbeddingDimension } from './config.js';
import { hasVectorIndex } from '../storage/vector-index.js';
export const MAX_VECTOR_DISTANCE = 1.00;
export function vectorSimilarity(distance) {
    return Math.max(0, 1 - distance / 2);
}
const pendingEmbeddingWrites = new Set();
export function isEmbeddingAvailable(caps = detectCapabilities()) {
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
export function scheduleEmbedAndStore(entityId, text, caps) {
    const pending = embedAndStore(entityId, text, caps);
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
export async function embedText(text, caps = detectCapabilities()) {
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
export async function embedAndStore(entityId, text, caps, target) {
    try {
        const embedding = await embedText(text, caps);
        if (!embedding)
            return 'no_embedding';
        const db = getDatabase();
        if (!hasVectorIndex(db))
            return 'no_vector_index';
        const storedDim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
        const expectedDim = target ? target.dimension : (storedDim ? parseInt(storedDim.value, 10) : 0);
        const actualDim = embedding.length;
        if (expectedDim > 0 && actualDim !== expectedDim) {
            process.stderr.write(`MeMesh: Embedding dimension mismatch (got ${actualDim}, expected ${expectedDim}). ` +
                `Skipping vector write for entity ${entityId}. ` +
                `If you switched embedders, the vector index has to be rebuilt at the new ` +
                `dimension: run 'memesh reindex' with no --namespace.\n`);
            return 'dimension_mismatch';
        }
        const rowId = toVectorRowId(entityId);
        const entity = db.prepare('SELECT status FROM entities WHERE id = ?').get(entityId);
        const table = target?.table ?? 'entities_vec';
        if (!entity || entity.status === 'archived') {
            db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowId);
            return 'removed';
        }
        const writeVector = db.transaction(() => {
            db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowId);
            db.prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, ?)`).run(rowId, toVectorBlob(embedding));
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
            .prepare(`SELECT rowid AS id, distance FROM entities_vec
          WHERE embedding MATCH ?
            AND rowid IN (SELECT id FROM entities WHERE status = 'active')
          ORDER BY distance LIMIT ?`)
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
            return await embedWithOllama(text);
        return null;
    }
    catch {
        return null;
    }
}
const PROVIDER_TIMEOUT_MS = 30_000;
const PROVIDER_MAX_ATTEMPTS = 3;
const PROVIDER_BASE_BACKOFF_MS = 500;
const PROVIDER_MAX_BACKOFF_MS = 30_000;
async function providerFetch(url, init, label) {
    for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt++) {
        const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
        let res;
        let parsed;
        try {
            res = await fetch(url, { ...init, signal: timeout, redirect: 'error' });
            if (res.ok)
                parsed = await res.json();
        }
        catch (err) {
            const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
            if (attempt === PROVIDER_MAX_ATTEMPTS) {
                process.stderr.write(`MeMesh: ${label} embedding request ${timedOut ? `timed out after ${PROVIDER_TIMEOUT_MS}ms` : 'failed'} `
                    + `on attempt ${attempt}/${PROVIDER_MAX_ATTEMPTS}`
                    + `${!timedOut && err instanceof Error ? `: ${err.message}` : ''}.\n`);
                return null;
            }
            await sleep(backoffFor(attempt));
            continue;
        }
        if (res.ok)
            return parsed ?? null;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) {
            process.stderr.write(`MeMesh: ${label} embedding request refused with HTTP ${res.status}.\n`);
            return null;
        }
        if (attempt === PROVIDER_MAX_ATTEMPTS) {
            process.stderr.write(`MeMesh: ${label} embedding request still failing with HTTP ${res.status} `
                + `after ${PROVIDER_MAX_ATTEMPTS} attempts.\n`);
            return null;
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, PROVIDER_MAX_BACKOFF_MS)
            : backoffFor(attempt);
        await sleep(waitMs);
    }
    return null;
}
function backoffFor(attempt) {
    return Math.min(PROVIDER_BASE_BACKOFF_MS * 2 ** (attempt - 1), PROVIDER_MAX_BACKOFF_MS);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function embedWithOpenAI(text, config) {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey)
        return null;
    const data = await providerFetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'text-embedding-3-small',
            input: text.slice(0, 8000),
        }),
    }, 'OpenAI');
    if (!data)
        return null;
    const embedding = data.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding))
        return null;
    return new Float32Array(embedding);
}
async function embedWithOllama(text) {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const model = 'nomic-embed-text';
    const data = await providerFetch(`${host}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text.slice(0, 8000) }),
    }, 'Ollama');
    if (!data)
        return null;
    const embedding = data.embeddings?.[0];
    if (!embedding || !Array.isArray(embedding))
        return null;
    return new Float32Array(embedding);
}
//# sourceMappingURL=embedder.js.map