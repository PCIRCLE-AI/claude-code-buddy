import { DEFAULT_EMBEDDING_DIMENSIONS } from './VectorSearchAdapter.js';
export class InMemoryVectorAdapter {
    vectors = new Map();
    loadExtension(_db) {
    }
    createVectorTable(_db, _dimensions) {
    }
    insertEmbedding(_db, entityName, embedding, dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
        if (embedding.length !== dimensions) {
            throw new Error(`Invalid embedding dimensions: expected ${dimensions}, got ${embedding.length}. Entity: ${entityName}`);
        }
        this.vectors.set(entityName, new Float32Array(embedding));
    }
    deleteEmbedding(_db, entityName) {
        this.vectors.delete(entityName);
    }
    knnSearch(_db, queryEmbedding, k, dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
        if (queryEmbedding.length !== dimensions) {
            throw new Error(`Invalid query embedding dimensions: expected ${dimensions}, got ${queryEmbedding.length}`);
        }
        const results = [];
        for (const [name, vec] of this.vectors) {
            results.push({
                entityName: name,
                distance: this.cosineDistance(queryEmbedding, vec),
            });
        }
        results.sort((a, b) => a.distance - b.distance);
        return results.slice(0, k);
    }
    getEmbedding(_db, entityName) {
        const vec = this.vectors.get(entityName);
        if (!vec)
            return null;
        return new Float32Array(vec);
    }
    hasEmbedding(_db, entityName) {
        return this.vectors.has(entityName);
    }
    getEmbeddingCount(_db) {
        return this.vectors.size;
    }
    cosineDistance(a, b) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        if (denom === 0)
            return 1;
        return 1 - dot / denom;
    }
}
//# sourceMappingURL=InMemoryVectorAdapter.js.map