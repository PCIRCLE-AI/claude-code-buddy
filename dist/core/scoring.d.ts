export interface ScoringWeights {
    searchRelevance: number;
    recency: number;
    frequency: number;
    confidence: number;
    impact: number;
}
export declare const DEFAULT_WEIGHTS: ScoringWeights;
export declare const SESSION_START_WEIGHT_RATIO: {
    recency: number;
    frequency: number;
    confidence: number;
};
export declare function recencyScore(lastAccessedAt: string | null | undefined): number;
export declare function frequencyScore(accessCount: number, maxAccessCount: number): number;
export declare function impactScore(recallHits: number, recallMisses: number): number;
export declare function scoreEntity(entity: {
    access_count?: number;
    last_accessed_at?: string;
    confidence?: number;
    recall_hits?: number;
    recall_misses?: number;
}, searchRelevanceValue: number, maxAccessCount: number, weights?: ScoringWeights): number;
export declare function rankEntities<T extends {
    name: string;
    access_count?: number;
    last_accessed_at?: string;
    confidence?: number;
    recall_hits?: number;
    recall_misses?: number;
}>(entities: T[], searchRelevanceValues: Map<string, number>, weights?: ScoringWeights): T[];
//# sourceMappingURL=scoring.d.ts.map