export declare const MAX_VECTOR_DISTANCE = 1.3;
export declare function vectorSimilarity(distance: number): number;
export declare function isOnnxModelCached(): boolean;
export declare function isEmbeddingAvailable(): boolean;
export declare function canRefillVectorIndex(): Promise<boolean>;
export { getEmbeddingDimension } from './config.js';
export declare function resetEmbeddingState(): void;
export declare function scheduleEmbedAndStore(entityId: number, text: string): void;
export declare function flushPendingEmbeddings(): Promise<void>;
export declare function embedText(text: string): Promise<Float32Array | null>;
export type EmbedOutcome = 'stored' | 'removed' | 'no_embedding' | 'dimension_mismatch' | 'write_failed' | 'database_closed';
export declare function embedAndStore(entityId: number, text: string): Promise<EmbedOutcome>;
export declare function vectorSearch(queryEmbedding: Float32Array, limit?: number): Array<{
    id: number;
    distance: number;
}>;
export declare function onnxCacheDir(): string;
//# sourceMappingURL=embedder.d.ts.map