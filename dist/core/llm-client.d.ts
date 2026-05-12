import type { LLMConfig } from './config.js';
export type LLMErrorClass = 'auth' | 'rate_limit' | 'upstream' | 'bad_request' | 'network' | 'parse' | 'unknown';
export declare class LLMResponseParseError extends Error {
    constructor(provider: LLMConfig['provider'], detail: string);
}
export interface LLMAttempt {
    provider: LLMConfig['provider'];
    model?: string;
    status: 'ok' | 'fail';
    latencyMs: number;
    errorClass?: LLMErrorClass;
    errorMessage?: string;
    index: number;
}
export interface CallLLMOptions {
    maxTokens?: number;
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
}
export declare function callLLM(prompt: string, config: LLMConfig, opts?: CallLLMOptions): Promise<string>;
export declare function classifyError(e: Error): LLMErrorClass;
//# sourceMappingURL=llm-client.d.ts.map