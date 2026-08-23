import type { MemeshDatabase } from '../storage/sqlite.js';
import { type LLMAttempt } from './llm-client.js';
import type { LLMConfig } from './config.js';
export declare const CONFLICT_JUDGE_PROMPT_VERSION = "conflict-judge-v1";
export declare const CONFLICT_JUDGE_MAX_PAIRS = 20;
declare const VERDICTS: readonly ["CONTRADICTS", "SUPERSEDES", "DUPLICATE", "UNRELATED"];
export type ConflictVerdict = (typeof VERDICTS)[number];
export interface RelationProposal {
    verdict: Exclude<ConflictVerdict, 'UNRELATED'>;
    relation_type: 'contradicts' | 'supersedes' | 'duplicates';
    a: {
        id: number;
        name: string;
    };
    b: {
        id: number;
        name: string;
    };
    direction?: 'a_supersedes_b' | 'b_supersedes_a';
    rationale: string;
    severity: 'low' | 'medium' | 'high';
    recommended_action: string;
    excerpts: {
        a: string;
        b: string;
    };
    cosine_distance: number;
}
export interface ConflictJudgeResult {
    candidatesAvailable: number;
    judged: number;
    staged: number;
    unrelated: number;
    llmFailures: number;
    llmCalls: number;
    durationMs: number;
    aborted?: string;
}
export interface ConflictJudgeOptions {
    maxPairs?: number;
    dryRun?: boolean;
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
}
interface EntityRow {
    id: number;
    name: string;
    type: string;
    created_at: string;
}
export declare function buildPrompt(a: EntityRow & {
    observations: string[];
}, b: EntityRow & {
    observations: string[];
}): string;
export declare function judgeConflicts(db: MemeshDatabase, llm: LLMConfig, opts?: ConflictJudgeOptions): Promise<ConflictJudgeResult>;
export {};
//# sourceMappingURL=conflict-judge.d.ts.map