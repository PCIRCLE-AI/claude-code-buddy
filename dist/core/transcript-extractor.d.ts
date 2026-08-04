import type Database from 'better-sqlite3';
import { type LLMAttempt } from './llm-client.js';
import type { LLMConfig } from './config.js';
import type { ExtractedMemory } from './extractor.js';
export declare const TRANSCRIPT_PROMPT_VERSION = "transcript-v1";
export declare const ORDERING_INSTRUCTION: string;
export declare function containsSecret(text: string): boolean;
export declare function scrubSecrets(text: string): string;
export interface ConversationTurn {
    role: 'user' | 'assistant';
    text: string;
}
export declare function parseConversation(transcriptPath: string): ConversationTurn[];
export declare function countConversationTurns(transcriptPath: string): number;
export declare function buildExtractionPrompt(turns: ConversationTurn[], projectLabel: string, priorDecisions?: string[]): string;
export interface ExtractOptions {
    maxLlmCalls?: number;
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
    project?: string;
    chunkCharBudget?: number;
}
export interface ExtractResult {
    memories: ExtractedMemory[];
    llmCalls: number;
    secretsDropped: number;
    llmFailures: number;
    truncatedTurns: number;
}
export declare function extractMemoriesFromTranscript(transcriptPath: string, llm: LLMConfig, opts?: ExtractOptions): Promise<ExtractResult>;
export interface StageResult {
    created: number;
    skippedDuplicate: number;
}
export declare function stageTranscriptProposals(db: Database.Database, session: {
    sessionId: string;
    path: string;
    lineCount: number;
}, memories: ExtractedMemory[], llm: LLMConfig, projectLabel: string): StageResult;
export interface TranscriptSourceOptions {
    cwd?: string;
    windowDays?: number;
    maxLlmCalls?: number;
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
    chunkCharBudget?: number;
}
export interface TranscriptSourceResult {
    sessionsScanned: number;
    candidatesExtracted: number;
    proposalsCreated: number;
    duplicatesSkipped: number;
    secretsDropped: number;
    llmFailures: number;
    llmCalls: number;
    skipped: Array<{
        reason: string;
        sessionId?: string;
    }>;
    truncatedTurns: number;
    truncatedSessions: Array<{
        sessionId: string;
        truncatedTurns: number;
    }>;
    durationMs: number;
}
export declare function runTranscriptSource(db: Database.Database, llm: LLMConfig | null | undefined, opts?: TranscriptSourceOptions): Promise<TranscriptSourceResult>;
//# sourceMappingURL=transcript-extractor.d.ts.map