import type Database from 'better-sqlite3';
export interface KnnSearchResult {
    entityName: string;
    distance: number;
}
export declare const DEFAULT_EMBEDDING_DIMENSIONS = 384;
export interface VectorSearchAdapter {
    loadExtension(db: Database.Database): void;
    createVectorTable(db: Database.Database, dimensions?: number): void;
    insertEmbedding(db: Database.Database, entityName: string, embedding: Float32Array, dimensions?: number): void;
    deleteEmbedding(db: Database.Database, entityName: string): void;
    knnSearch(db: Database.Database, queryEmbedding: Float32Array, k: number, dimensions?: number): KnnSearchResult[];
    getEmbedding(db: Database.Database, entityName: string): Float32Array | null;
    hasEmbedding(db: Database.Database, entityName: string): boolean;
    getEmbeddingCount(db: Database.Database): number;
}
//# sourceMappingURL=VectorSearchAdapter.d.ts.map