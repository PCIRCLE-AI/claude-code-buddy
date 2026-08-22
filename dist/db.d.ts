import { MemeshDatabase } from './storage/sqlite.js';
import { runOnceMigration, FTS_SEGMENTATION_VERSION } from './storage/schema.js';
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
export declare function openDatabase(dbPath?: string): MemeshDatabase;
export declare function reindexFts(): {
    entities: number;
};
export declare const GENERATION_TABLE = "entities_vec_next";
export interface VectorGenerationInfo {
    dimension: number;
    provider: string;
    startedAt: string;
}
export type VectorGenerationRead = {
    state: 'none';
} | {
    state: 'unreadable';
    detail: string;
} | {
    state: 'open';
    info: VectorGenerationInfo;
};
export declare function readVectorGeneration(): VectorGenerationRead;
export declare function generationRowIds(): Set<number>;
export declare function beginVectorGeneration(dimension: number, provider: string): {
    resumed: boolean;
};
export declare function generationRowHashes(): Map<number, string>;
export declare function recordGenerationRow(entityId: number, textHash: string): void;
export declare function discardVectorGeneration(): void;
export declare function swapVectorGeneration(dimension: number): void;
export declare function getStoredEmbeddingDimension(): number;
export interface PendingReindexInfo {
    from: number;
    to: number;
    noticedAt: string;
    reason: 'dimension-change' | 'vectors-missing';
}
export declare function getPendingReindexInfo(): PendingReindexInfo | null;
export declare function markReindexOwed(from: number, to: number, reason: PendingReindexInfo['reason'], conn?: MemeshDatabase | null): void;
export declare function clearPendingReindexFlag(): void;
export declare function closeDatabase(): void;
export declare function getDatabase(): MemeshDatabase;
export declare function isDatabaseOpen(): boolean;
//# sourceMappingURL=db.d.ts.map