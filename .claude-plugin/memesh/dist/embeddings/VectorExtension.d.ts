import Database from 'better-sqlite3';
import type { KnnSearchResult } from './VectorSearchAdapter.js';
export type { KnnSearchResult } from './VectorSearchAdapter.js';
export declare const DEFAULT_EMBEDDING_DIMENSIONS = 384;
export declare class VectorExtension {
    private static extensionLoaded;
    static loadExtension(db: Database.Database): void;
    static createVectorTable(db: Database.Database, dimensions?: number): void;
    static insertEmbedding(db: Database.Database, entityName: string, embedding: Float32Array, expectedDimensions?: number): void;
    static deleteEmbedding(db: Database.Database, entityName: string): void;
    static knnSearch(db: Database.Database, queryEmbedding: Float32Array, k: number, expectedDimensions?: number): KnnSearchResult[];
    static getEmbedding(db: Database.Database, entityName: string): Float32Array | null;
    static hasEmbedding(db: Database.Database, entityName: string): boolean;
    static getEmbeddingCount(db: Database.Database): number;
    private static ensureExtensionLoaded;
}
//# sourceMappingURL=VectorExtension.d.ts.map