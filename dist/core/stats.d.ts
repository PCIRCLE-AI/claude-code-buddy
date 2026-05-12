import type Database from 'better-sqlite3';
export interface StatsResult {
    totalEntities: number;
    totalObservations: number;
    totalRelations: number;
    totalTags: number;
    typeDistribution: unknown[];
    tagDistribution: unknown[];
    statusDistribution: unknown[];
}
export declare function computeStats(db: Database.Database): StatsResult;
//# sourceMappingURL=stats.d.ts.map