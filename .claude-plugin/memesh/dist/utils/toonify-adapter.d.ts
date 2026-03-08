import type { LanguageProfile } from '../types/toonify.js';
export interface ToonifyConfig {
    enabled: boolean;
    minTokensThreshold: number;
    minSavingsThreshold: number;
    skipToolPatterns: string[];
    cacheEnabled: boolean;
    showStats: boolean;
    multilingualEnabled: boolean;
}
export interface OptimizationResult {
    original: string;
    optimized: string;
    originalTokens: number;
    optimizedTokens: number;
    savings: number;
    savingsTokens: number;
    language?: LanguageProfile;
    confidence?: number;
    isMixed?: boolean;
    skipped: boolean;
    skipReason?: string;
}
export interface OptimizationStats {
    totalOptimizations: number;
    totalOriginalTokens: number;
    totalOptimizedTokens: number;
    totalSavings: number;
    averageSavingsPercent: number;
    languageBreakdown: Record<string, number>;
    cacheHits: number;
    cacheMisses: number;
    lastReset: Date;
}
export declare class ToonifyAdapter {
    private static instance;
    private config;
    private cache;
    private stats;
    private constructor();
    static getInstance(config?: Partial<ToonifyConfig>): ToonifyAdapter;
    static resetInstance(): void;
    updateConfig(config: Partial<ToonifyConfig>): void;
    getConfig(): ToonifyConfig;
    optimize(content: string | object, toolName: string, options?: {
        force?: boolean;
        skipCache?: boolean;
        language?: string;
    }): Promise<OptimizationResult>;
    optimizeBatch(items: Array<{
        content: string | object;
        toolName: string;
    }>, options?: {
        parallel?: boolean;
    }): Promise<OptimizationResult[]>;
    getStats(): OptimizationStats;
    generateReport(): string;
    resetStats(): void;
    clearCache(): void;
    estimateSavings(content: string | object, toolName: string): Promise<{
        estimatedSavings: number;
        estimatedSavingsPercent: number;
        shouldOptimize: boolean;
        reason?: string;
    }>;
    private callToonifyMCP;
    private shouldSkipTool;
    private isStructuredData;
    private createSkippedResult;
    private updateStats;
    private getCacheHitRate;
}
export declare function optimizeContent(content: string | object, toolName?: string): Promise<OptimizationResult>;
export declare function getOptimizationStats(): OptimizationStats;
export declare function generateOptimizationReport(): string;
export declare function estimateSavings(content: string | object, toolName?: string): Promise<ReturnType<ToonifyAdapter['estimateSavings']>>;
//# sourceMappingURL=toonify-adapter.d.ts.map