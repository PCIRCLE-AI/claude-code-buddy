import type { MemeshDatabase } from '../storage/sqlite.js';
import { type LLMAttempt } from './llm-client.js';
import type { LLMConfig } from './config.js';
export interface DreamerOptions {
    project?: string;
    dryRun?: boolean;
    maxLlmCalls?: number;
    windowDays?: number;
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
    validateBeforeStage?: boolean;
}
export interface DreamerResult {
    proposalsCreated: number;
    clustersScanned: number;
    llmCalls: number;
    skipped: Array<{
        reason: string;
        project?: string;
        clusterKey?: string;
    }>;
    durationMs: number;
    clusteringMode?: 'semantic' | 'calendar';
    clusteringNote?: string;
}
interface ProposedDigest {
    name: string;
    type: string;
    observations: string[];
    tags: string[];
}
export declare function runDreamer(db: MemeshDatabase, llm: LLMConfig | null | undefined, opts?: DreamerOptions): Promise<DreamerResult>;
export interface PatternDetectorOptions {
    project?: string;
    dryRun?: boolean;
    maxLlmCalls?: number;
    windowDays?: number;
    fallbacks?: LLMConfig[];
    onAttempt?: (attempts: LLMAttempt[]) => void;
    minSignal?: number;
}
export interface PatternDetectorResult {
    proposalsCreated: number;
    entitiesScanned: number;
    llmCalls: number;
    skipped: Array<{
        reason: string;
        project?: string;
    }>;
    durationMs: number;
}
export declare function runPatternDetector(db: MemeshDatabase, llm: LLMConfig | null | undefined, opts?: PatternDetectorOptions): Promise<PatternDetectorResult>;
export interface ApplyResult {
    proposalId: number;
    digestEntityName: string;
    sourcesArchived: number;
    sourcesLinked: number;
    kind: 'digest' | 'pattern_emergent';
}
export declare function applyProposal(db: MemeshDatabase, proposalId: number, kg: {
    createEntity: (name: string, type: string, opts: {
        observations: string[];
        tags: string[];
        metadata: Record<string, unknown>;
        trustOverride?: 'trusted' | 'untrusted';
    }) => number;
}): ApplyResult;
export declare function rejectProposal(db: MemeshDatabase, proposalId: number, reason?: string): void;
export interface ProposalSummary {
    id: number;
    project: string;
    cluster_key: string;
    source_count: number;
    digest_name: string;
    digest_observations_preview: string | null;
    status: string;
    created_at: string;
    kind: 'digest' | 'pattern_emergent';
    source_kind: string;
}
export declare function listProposals(db: MemeshDatabase, status?: string): ProposalSummary[];
export interface ProposalDetail {
    id: number;
    project: string;
    cluster_key: string;
    source_kind: string;
    status: string;
    created_at: string;
    source: unknown;
    digest: ProposedDigest;
}
export declare function getProposalDetail(db: MemeshDatabase, id: number): ProposalDetail | null;
export {};
//# sourceMappingURL=dreamer.d.ts.map