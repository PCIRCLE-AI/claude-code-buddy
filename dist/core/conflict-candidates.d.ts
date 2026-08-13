import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const CONFLICT_SIGNAL_TYPES: readonly string[];
export declare const CONFLICT_MAX_COSINE_DISTANCE = 0.35;
export declare const CONFLICT_NEIGHBORS_PER_ENTITY = 3;
export interface ConflictCandidate {
    aId: number;
    aName: string;
    aType: string;
    bId: number;
    bName: string;
    bType: string;
    cosineDistance: number;
}
export declare function pairKey(idA: number, idB: number): string;
export declare function findConflictCandidates(db: MemeshDatabase, opts?: {
    maxCosineDistance?: number;
    neighborsPerEntity?: number;
    limit?: number;
}): ConflictCandidate[];
//# sourceMappingURL=conflict-candidates.d.ts.map