import type { MemeshDatabase } from '../storage/sqlite.js';
export interface StatsResult {
    totalEntities: number;
    totalObservations: number;
    totalRelations: number;
    totalTags: number;
    typeDistribution: unknown[];
    tagDistribution: unknown[];
    statusDistribution: unknown[];
}
export declare function computeStats(db: MemeshDatabase): StatsResult;
//# sourceMappingURL=stats.d.ts.map