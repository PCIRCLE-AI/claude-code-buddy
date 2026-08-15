export declare const WORK_LAYER_TYPES: ReadonlySet<string>;
export declare const EVIDENCE_LAYER_TYPES: ReadonlySet<string>;
export type TopologyLayer = 'work' | 'knowledge' | 'evidence';
export declare function layerOf(type: string): TopologyLayer;
export interface TopologyEntity {
    name: string;
    type: string;
    title?: string | null;
    snippet?: string | null;
    signalScore?: number | null;
    foreign?: boolean;
}
export declare function topologyLine(entity: TopologyEntity, maxChars: number): string;
export interface TopologySection {
    heading: string;
    entities: TopologyEntity[];
}
export declare function groupTopology(entities: TopologyEntity[], projectName: string): TopologySection[];
export interface TopologyBudget {
    maxChars: number;
    maxLineChars?: number;
    maxPerSection?: number;
}
export declare function buildTopologyLines(entities: TopologyEntity[], projectName: string, budget: TopologyBudget): string[];
//# sourceMappingURL=work-topology.d.ts.map