import { type Capabilities } from './config.js';
export declare const MAX_VECTOR_DISTANCE = 1;
export declare function vectorSimilarity(distance: number): number;
export declare function isEmbeddingAvailable(caps?: Capabilities): boolean;
export declare function canRefillVectorIndex(): Promise<boolean>;
export { getEmbeddingDimension } from './config.js';
export declare function scheduleEmbedAndStore(entityId: number, text: string, caps?: Capabilities): void;
export declare function flushPendingEmbeddings(): Promise<void>;
export declare function entityEmbedText(name: string, observations: string[]): string;
export declare function embedText(text: string, caps?: Capabilities): Promise<Float32Array | null>;
export type EmbedOutcome = 'stored' | 'removed' | 'no_embedding' | 'dimension_mismatch' | 'write_failed' | 'database_closed' | 'no_vector_index';
export declare function embedAndStore(entityId: number, text: string, caps?: Capabilities, target?: {
    table: string;
    dimension: number;
}): Promise<EmbedOutcome>;
export declare function vectorSearch(queryEmbedding: Float32Array, limit?: number): Array<{
    id: number;
    distance: number;
}>;
//# sourceMappingURL=embedder.d.ts.map