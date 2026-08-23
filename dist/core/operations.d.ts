import { getDatabase } from '../db.js';
import type { EmbedOutcome } from './embedder.js';
import type { RememberInput, RememberResult, RecallInput, ForgetInput, ForgetResult, LearnInput, LearnResult, Entity } from './types.js';
export declare function remember(args: RememberInput): RememberResult;
export declare function recall(args: RecallInput): Entity[];
export interface RetrievalMeta {
    mode: 'fts' | 'hybrid';
    degraded: boolean;
    truncated: boolean;
}
export declare function recallEnhanced(args: RecallInput): Promise<{
    entities: Entity[];
    retrieval: RetrievalMeta;
}>;
export declare function recallWithConflicts(args: RecallInput): Promise<{
    entities: Entity[];
    conflicts: string[];
    retrieval: RetrievalMeta;
}>;
export { exportMemories, importMemories } from './serializer.js';
export declare function learn(args: LearnInput): LearnResult;
export declare function forget(args: ForgetInput): ForgetResult;
export declare function setPinned(name: string, pinned: boolean): {
    name: string;
    pinned: boolean;
    found: boolean;
};
export interface ReindexResult {
    processed: number;
    embedded: number;
    skipped: number;
    outcomes: Record<EmbedOutcome | 'entity_missing' | 'nothing_to_embed' | 'already_staged', number>;
    failed: number;
    missingVectors: number;
    missingVectorsDatabaseWide: number;
    pendingReindexCleared: boolean;
    generationSwapped: boolean | null;
    abortedAfter: number | null;
}
export declare function countMissingVectors(db: ReturnType<typeof getDatabase>, namespace?: string): number;
export declare function reindex(opts?: {
    namespace?: string;
}): Promise<ReindexResult>;
//# sourceMappingURL=operations.d.ts.map