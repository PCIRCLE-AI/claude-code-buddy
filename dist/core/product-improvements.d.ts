import type { MemeshDatabase } from '../storage/sqlite.js';
export declare const PRODUCT_IMPROVEMENT_KIND: "product_improvement";
export type ImprovementPriority = 'p0' | 'p1' | 'p2' | 'p3';
export interface ProductImprovementPayload {
    name: string;
    title: string;
    type: typeof PRODUCT_IMPROVEMENT_KIND;
    observations: string[];
    tags: string[];
    improvement: {
        problem: string;
        proposed_change: string;
        verification_scenario: string;
        success_criteria: string[];
        priority: ImprovementPriority;
        source_names: string[];
        source_host?: string;
    };
}
export interface StageProductImprovementInput {
    project: string;
    source_names: string[];
    title: string;
    problem: string;
    proposed_change: string;
    verification_scenario: string;
    success_criteria: string[];
    priority?: ImprovementPriority;
    sourceHost?: string;
}
export interface ProductImprovementProposalResult {
    proposal_id: number;
    status: string;
    created: boolean;
    title: string;
    source_ids: number[];
    review: {
        required: true;
        authority: 'human';
        state: 'pending' | 'settled';
        inspect: string;
        accept?: string;
        reject?: string;
    };
}
export interface ProductImprovementStatus {
    proposal_id: number;
    status: string;
    title: string;
    project: string;
    source_ids: number[];
    reason: string | null;
    created_at: string;
    reviewed_at: string | null;
    accepted_entity_name: string | null;
}
export declare function stageProductImprovement(db: MemeshDatabase, input: StageProductImprovementInput): ProductImprovementProposalResult;
export declare function getProductImprovementStatus(db: MemeshDatabase, proposalId: number): ProductImprovementStatus;
export declare function readProductImprovementPayload(raw: string): ProductImprovementPayload;
export declare function readProductImprovementSourceIds(raw: string): number[];
//# sourceMappingURL=product-improvements.d.ts.map