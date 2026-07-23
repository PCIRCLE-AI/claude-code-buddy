import type { RememberInput, RememberResult, RecallInput, ForgetInput, ForgetResult, LearnInput, LearnResult, Entity } from './types.js';
export declare function remember(args: RememberInput): RememberResult;
export declare function recall(args: RecallInput): Entity[];
export declare function recallEnhanced(args: RecallInput): Promise<Entity[]>;
export { consolidate } from './consolidator.js';
export { exportMemories, importMemories } from './serializer.js';
export declare function learn(args: LearnInput): LearnResult;
export declare function forget(args: ForgetInput): ForgetResult;
export declare function setPinned(name: string, pinned: boolean): {
    name: string;
    pinned: boolean;
    found: boolean;
};
export declare function reindex(opts?: {
    namespace?: string;
}): Promise<{
    processed: number;
    embedded: number;
    skipped: number;
}>;
//# sourceMappingURL=operations.d.ts.map