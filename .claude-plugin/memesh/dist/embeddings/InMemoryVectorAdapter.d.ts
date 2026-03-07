import type Database from 'better-sqlite3';
import type { VectorSearchAdapter, KnnSearchResult } from './VectorSearchAdapter.js';
export declare class InMemoryVectorAdapter implements VectorSearchAdapter {
    private vectors;
    loadExtension(_db: Database.Database): void;
    createVectorTable(_db: Database.Database, _dimensions?: number): void;
    insertEmbedding(_db: Database.Database, entityName: string, embedding: Float32Array, dimensions?: number): void;
    deleteEmbedding(_db: Database.Database, entityName: string): void;
    knnSearch(_db: Database.Database, queryEmbedding: Float32Array, k: number, dimensions?: number): KnnSearchResult[];
    getEmbedding(_db: Database.Database, entityName: string): Float32Array | null;
    hasEmbedding(_db: Database.Database, entityName: string): boolean;
    getEmbeddingCount(_db: Database.Database): number;
    private cosineDistance;
}
//# sourceMappingURL=InMemoryVectorAdapter.d.ts.map