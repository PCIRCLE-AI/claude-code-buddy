import type { MemeshDatabase } from '../storage/sqlite.js';
export declare function tokenizeName(name: string): Set<string>;
export declare function jaccardSimilarity(a: Set<string>, b: Set<string>): number;
export declare function isTopicalTag(tag: string): boolean;
export declare const DERIVED_RELATION_TYPES: readonly ["related-to", "belongs-to-project", "co-created", "shares-name-tokens", "evidences"];
export type DerivedRelationType = (typeof DERIVED_RELATION_TYPES)[number];
export interface RelationCandidate {
    fromEntityId: number;
    fromName: string;
    toEntityId: number;
    toName: string;
    relationType: DerivedRelationType;
    reason: string;
    strength: number;
}
export interface BackfillOptions {
    project?: string;
    maxEdgesPerSource?: number;
    minSharedTags?: number;
    includeArchived?: boolean;
    dryRun?: boolean;
    includeSessionCooccurrence?: boolean;
    minSessionSignalScore?: number;
    includeNameTokenSimilarity?: boolean;
    minNameJaccard?: number;
    minSharedNameTokens?: number;
    includeEvidenceLinks?: boolean;
    resetIdempotency?: boolean;
    ignoreIdempotency?: boolean;
}
export interface BackfillResult {
    candidatesProposed: number;
    edgesWritten: number;
    dryRun: boolean;
    byRule: {
        tagCooccurrence: number;
        projectClustering: number;
        sessionCooccurrence: number;
        nameTokenSimilarity: number;
        evidenceLinks: number;
    };
    orphansSkippedIdempotent: number;
    orphansMarkedProcessed: number;
}
export interface BackfillProposalResult {
    candidates: RelationCandidate[];
    consideredOrphanIds: number[];
    skippedOrphanIds: number[];
}
export declare function backfillRelations(opts?: BackfillOptions, db?: MemeshDatabase): BackfillResult;
export declare function proposeBackfillCandidates(opts?: BackfillOptions, db?: MemeshDatabase): BackfillProposalResult;
//# sourceMappingURL=kg-backfill.d.ts.map