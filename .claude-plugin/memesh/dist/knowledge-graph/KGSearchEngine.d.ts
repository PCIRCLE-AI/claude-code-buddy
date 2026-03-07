import type Database from 'better-sqlite3';
import type { Entity, SearchQuery } from './types.js';
import type { VectorSearchAdapter } from '../embeddings/VectorSearchAdapter.js';
import { QueryCache } from '../db/QueryCache.js';
export interface SemanticSearchResult {
    entity: Entity;
    similarity: number;
}
export interface KGSearchEngineContext {
    db: Database.Database;
    getVectorAdapter: () => VectorSearchAdapter | null;
    isVectorEnabled: () => boolean;
    getVectorInitPromise: () => Promise<void> | null;
    getEntity: (name: string) => Entity | null;
    queryCache: QueryCache<string, any>;
}
export declare class KGSearchEngine {
    private readonly ctx;
    constructor(context: KGSearchEngineContext);
    escapeLikePattern(pattern: string): string;
    searchFTS5(query: string, limit: number): number[];
    prepareFTS5Query(query: string): string;
    searchEntities(query: SearchQuery): Entity[];
    semanticSearch(query: string, options?: {
        limit?: number;
        minSimilarity?: number;
        entityTypes?: string[];
    }): Promise<SemanticSearchResult[]>;
    hybridSearch(query: string, options?: {
        limit?: number;
        minSimilarity?: number;
    }): Promise<SemanticSearchResult[]>;
    keywordSearchAsSemanticResults(query: string, limit: number): SemanticSearchResult[];
}
//# sourceMappingURL=KGSearchEngine.d.ts.map