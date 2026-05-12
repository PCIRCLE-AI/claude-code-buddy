import type { LLMConfig } from './config.js';
import { type LLMAttempt } from './llm-client.js';
export interface AutoTagOptions {
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
}
export declare function autoTag(name: string, type: string, observations: string[], llmConfig: LLMConfig, opts?: AutoTagOptions): Promise<string[]>;
export declare function autoTagAndApply(entityId: number, name: string, type: string, observations: string[], llmConfig: LLMConfig, opts?: AutoTagOptions): Promise<void>;
export declare function parseTags(text: string): string[];
//# sourceMappingURL=auto-tagger.d.ts.map