export interface ModelInfo {
    id: string;
    created?: string;
}
export interface ValidationResult {
    valid: boolean;
    error?: string;
    models?: ModelInfo[];
    suggested?: string;
}
export declare function pickSuggestedModel(models: ModelInfo[]): string | undefined;
export declare function probeAnthropic(apiKey: string): Promise<ValidationResult>;
export declare function probeOpenAI(apiKey: string): Promise<ValidationResult>;
export declare function probeOllama(host?: string): Promise<ValidationResult>;
export declare function probeProvider(provider: 'anthropic' | 'openai' | 'ollama', apiKey?: string, host?: string): Promise<ValidationResult>;
//# sourceMappingURL=llm-validator.d.ts.map