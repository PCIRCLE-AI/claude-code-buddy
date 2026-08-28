export interface LLMConfig {
    provider: 'anthropic' | 'openai' | 'ollama';
    model?: string;
    apiKey?: string;
}
export interface EmbedderConfig {
    provider: 'openai' | 'ollama';
}
export interface MeMeshConfig {
    llm?: LLMConfig;
    llmFallbacks?: LLMConfig[];
    embedder?: EmbedderConfig;
    autoCapture?: boolean;
    sessionLimit?: number;
    autoUpdate?: 'off' | 'patch' | 'minor' | 'major';
    language?: string;
    transcriptMining?: boolean;
    setupCompleted?: boolean;
}
export interface Capabilities {
    fts5: true;
    vectorSearch: true;
    scoring: true;
    knowledgeEvolution: true;
    embeddings: 'ollama' | 'anthropic' | 'openai' | 'tfidf';
    llm: LLMConfig | null;
    llmSource: 'config' | 'environment' | 'none';
    llmFallbacks: LLMConfig[];
    searchLevel: 0 | 1;
}
export type ConfigReadState = 'ok' | 'absent' | 'unreadable';
export interface ConfigReadResult {
    config: MeMeshConfig;
    state: ConfigReadState;
}
export declare function readConfigResult(): ConfigReadResult;
export declare function readConfig(): MeMeshConfig;
export declare function writeConfig(config: MeMeshConfig): void;
export declare class ConfigUnreadableError extends Error {
    constructor(p: string);
}
export declare function updateConfig(partial: Omit<Partial<MeMeshConfig>, 'llm' | 'embedder'> & {
    llm?: LLMConfig | null;
    embedder?: EmbedderConfig | null;
}): MeMeshConfig;
export declare function maskApiKey(key: string): string;
export declare function detectCapabilities(config?: MeMeshConfig): Capabilities;
export declare function getEmbeddingDimension(config?: MeMeshConfig): number;
export declare function isTranscriptMiningEnabled(config?: MeMeshConfig): boolean;
export declare function resolveEmbeddingDimension(): {
    dimension: number;
    confident: boolean;
    configured: boolean;
};
export declare function logCapabilities(config?: MeMeshConfig): void;
export declare function getConfigDir(): string;
export declare function getConfigPath(): string;
//# sourceMappingURL=config.d.ts.map