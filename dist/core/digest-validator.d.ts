import { type LLMAttempt } from './llm-client.js';
import type { LLMConfig } from './config.js';
export interface SuspiciousClaim {
    claim: string;
    reason: string;
}
export interface ValidationResult {
    status: 'pass' | 'soften' | 'reject';
    suspiciousClaims: SuspiciousClaim[];
    rawResponse: string;
}
export interface ValidateDigestOptions {
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
}
export declare function validateDigest(digestObservations: string[], sourceObservations: string[], llm: LLMConfig, opts?: ValidateDigestOptions): Promise<ValidationResult>;
export declare function parseValidatorResponse(text: string): ValidationResult;
//# sourceMappingURL=digest-validator.d.ts.map