import type { LLMConfig } from './config.js';
import { type LLMAttempt } from './llm-client.js';
import type { LessonSeverity } from './types.js';
export interface StructuredLesson {
    error: string;
    rootCause: string;
    fix: string;
    prevention: string;
    errorPattern: string;
    fixPattern: string;
    severity: LessonSeverity;
}
export interface AnalyzeFailureOptions {
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
}
export declare function analyzeFailure(errors: string[], filesEdited: string[], llmConfig: LLMConfig, opts?: AnalyzeFailureOptions): Promise<StructuredLesson | null>;
export declare function parseLesson(text: string): StructuredLesson | null;
//# sourceMappingURL=failure-analyzer.d.ts.map