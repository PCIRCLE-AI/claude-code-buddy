import { MemeshDatabase } from './storage/sqlite.js';
import { runOnceMigration, FTS_SEGMENTATION_VERSION } from './storage/schema.js';
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
export declare function openDatabase(dbPath?: string): MemeshDatabase;
export declare function reindexFts(): {
    entities: number;
};
export interface VectorGenerationInfo {
    dimension: number;
    provider: string;
    startedAt: string;
}
export declare function getVectorGenerationInfo(): VectorGenerationInfo | null;
export declare function generationRowIds(): Set<number>;
export declare function beginVectorGeneration(dimension: number, provider: string): {
    resumed: boolean;
};
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
export declare function markReindexOwed(from: number, to: number, reason: PendingReindexInfo['reason']): void;
export declare function clearPendingReindexFlag(): void;
export declare function closeDatabase(): void;
export declare function getDatabase(): MemeshDatabase;
export declare function isDatabaseOpen(): boolean;
//# sourceMappingURL=db.d.ts.map