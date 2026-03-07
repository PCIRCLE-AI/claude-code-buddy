import type { Entity, Relation, SearchQuery, RelationTrace } from './types.js';
import type { SemanticSearchResult } from './KGSearchEngine.js';
export type { SemanticSearchResult } from './KGSearchEngine.js';
export declare class KnowledgeGraph {
    private db;
    private queryCache;
    private vectorEnabled;
    private vectorAdapter;
    private vectorInitPromise;
    private pendingEmbeddings;
    private searchEngine;
    private constructor();
    private validateEntityName;
    private validateRelationType;
    static create(dbPath?: string): Promise<KnowledgeGraph>;
    static createSync(dbPath?: string): KnowledgeGraph;
    private initialize;
    private initVectorSearch;
    private runMigrations;
    private escapeLikePattern;
    private searchFTS5;
    private prepareFTS5Query;
    createEntity(entity: Entity): string;
    createEntitiesBatch(entities: Array<{
        name: string;
        entityType: string;
        observations: string[];
        tags?: string[];
        metadata?: Record<string, unknown>;
        contentHash?: string;
    }>): Array<{
        name: string;
        success: boolean;
        error?: string;
    }>;
    createRelation(relation: Relation): void;
    searchEntities(query: SearchQuery): Entity[];
    getEntity(name: string): Entity | null;
    traceRelations(entityName: string, depth?: number): RelationTrace | null;
    getStats(): {
        totalEntities: number;
        totalRelations: number;
        entitiesByType: Record<string, number>;
    };
    deleteEntity(name: string): boolean;
    private generateEmbeddingAsync;
    semanticSearch(query: string, options?: {
        limit?: number;
        minSimilarity?: number;
        entityTypes?: string[];
    }): Promise<SemanticSearchResult[]>;
    hybridSearch(query: string, options?: {
        limit?: number;
        minSimilarity?: number;
    }): Promise<SemanticSearchResult[]>;
    isVectorSearchEnabled(): boolean;
    close(): Promise<void>;
    transaction<T>(fn: () => T): T;
    getCacheStats(): import("../db/QueryCache.js").CacheStats;
    clearCache(): void;
}
export type { Entity, Relation, SearchQuery, RelationTrace, EntityType, RelationType } from './types.js';
//# sourceMappingURL=index.d.ts.map