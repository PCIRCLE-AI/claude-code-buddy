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
//# sourceMappingURL=graph.d.ts.map