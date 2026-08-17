import type { MemeshDatabase } from '../storage/sqlite.js';
import type { Entity } from './types.js';
export type GraphRelation = {
    from: string;
    to: string;
    type: string;
};
export interface GraphResult {
    entities: Entity[];
    relations: GraphRelation[];
    noiseTypes: string[];
}
export declare function computeGraph(db: MemeshDatabase): GraphResult;
export interface WorkGraphResult {
    entities: Entity[];
    relations: GraphRelation[];
    evidenceCounts: Record<string, number>;
}
export declare function computeWorkGraph(db: MemeshDatabase): WorkGraphResult;
export interface NodeEvidenceResult {
    entities: Entity[];
    relations: GraphRelation[];
    truncated: boolean;
}
export declare function computeNodeEvidence(db: MemeshDatabase, nodeName: string): NodeEvidenceResult | null;
//# sourceMappingURL=graph.d.ts.map