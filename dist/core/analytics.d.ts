import type Database from 'better-sqlite3';
export interface HealthFactor {
    score: number;
    weight: number;
    detail: string;
}
export interface RecallEffectiveness {
    overallHitRate: number;
    totalHits: number;
    totalMisses: number;
    trackedEntities: number;
    topEffective: Array<{
        name: string;
        type: string;
        hits: number;
        misses: number;
        hitRate: number;
    }>;
    mostIgnored: Array<{
        name: string;
        type: string;
        hits: number;
        misses: number;
        hitRate: number;
    }>;
}
export declare const NOISE_TYPES: Set<string>;
export type AgeBucket = 'week' | 'month' | 'quarter' | 'older';
export interface AgeMatrixEntry {
    type: string;
    bucket: AgeBucket;
    count: number;
}
export interface KnowledgeRadarEntry {
    axis: string;
    count: number;
    types: string[];
}
export interface LoopMetric {
    reusedThisWeek: number;
    trend: Array<{
        date: string;
        count: number;
    }>;
    computedFrom: 'recall_hits' | 'last_accessed_at_approximation';
}
export interface AnalyticsResult {
    healthScore: number;
    healthFactors: {
        activity: HealthFactor;
        quality: HealthFactor;
        freshness: HealthFactor;
        lessons: HealthFactor;
    };
    loopMetric: LoopMetric;
    timeline: Array<{
        date: string;
        created: number;
        recalled: number;
    }>;
    valueMetrics: {
        totalRecalls: number;
        lessonCount: number;
        lessonsWithWarnings: number;
        typeDistribution: unknown[];
    };
    recallEffectiveness: RecallEffectiveness | null;
    cleanup: {
        staleEntities: unknown[];
        duplicateCandidates: unknown[];
    };
    ageMatrix: AgeMatrixEntry[];
    knowledgeRadar: KnowledgeRadarEntry[];
}
export declare function computeAnalytics(db: Database.Database): AnalyticsResult;
export interface PmAnalyticsResult {
    velocity: {
        decisionsPerWeek: number;
        releasesPerMonth: number;
        windowDays: number;
    };
    staleness: {
        stalePlanCount: number;
        openDecisionCount: number;
    };
    connectedness: {
        orphanRate: number;
        totalRelations: number;
        activeEntities: number;
    };
}
export declare function computePmAnalytics(db: Database.Database, windowDays?: number): PmAnalyticsResult;
//# sourceMappingURL=analytics.d.ts.map