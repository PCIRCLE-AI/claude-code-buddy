import type Database from 'better-sqlite3';
import type { Entity } from './types.js';
export interface GraphRelation {
    from: string;
    to: string;
    type: string;
}
export interface GraphResult {
    entities: Entity[];
    relations: GraphRelation[];
    noiseTypes: string[];
}
export declare function computeGraph(db: Database.Database): GraphResult;
//# sourceMappingURL=graph.d.ts.map