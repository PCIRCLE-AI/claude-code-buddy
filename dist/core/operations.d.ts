import type { EmbedOutcome } from './embedder.js';
import type { RememberInput, RememberResult, RecallInput, ForgetInput, ForgetResult, LearnInput, LearnResult, Entity } from './types.js';
export declare function remember(args: RememberInput): RememberResult;
export declare function recall(args: RecallInput): Entity[];
export declare function recallEnhanced(args: RecallInput): Promise<Entity[]>;
export declare function recallWithConflicts(args: RecallInput): Promise<{
    entities: Entity[];
    conflicts: string[];
}>;
export { consolidate } from './consolidator.js';
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
    outcomes: Record<EmbedOutcome | 'entity_missing' | 'nothing_to_embed', number>;
    failed: number;
    missingVectors: number;
    missingVectorsDatabaseWide: number;
    pendingReindexCleared: boolean;
}
export declare function reindex(opts?: {
    namespace?: string;
}): Promise<ReindexResult>;
//# sourceMappingURL=operations.d.ts.map