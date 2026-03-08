import type { KnowledgeGraph } from '../knowledge-graph/index.js';
export type RecallTrigger = 'session-start' | 'test-failure' | 'error-detection';
export interface RecallContext {
    projectName?: string;
    recentCommits?: string[];
    testName?: string;
    errorMessage?: string;
    errorType?: string;
}
export interface RecallResult {
    entityName: string;
    observations: string[];
    similarity: number;
}
export declare class ProactiveRecaller {
    private readonly knowledgeGraph;
    constructor(knowledgeGraph: KnowledgeGraph);
    buildQuery(trigger: RecallTrigger, context: RecallContext): string;
    recall(trigger: RecallTrigger, context: RecallContext): Promise<RecallResult[]>;
    static formatForHookOutput(results: RecallResult[]): string;
    private buildSessionStartQuery;
    private buildTestFailureQuery;
    private buildErrorDetectionQuery;
    private mapToRecallResult;
}
//# sourceMappingURL=ProactiveRecaller.d.ts.map