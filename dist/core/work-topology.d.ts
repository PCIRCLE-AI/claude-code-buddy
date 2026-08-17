export declare const WORK_LAYER_TYPES: ReadonlySet<string>;
export declare const EVIDENCE_LAYER_TYPES: ReadonlySet<string>;
export declare function isAutoInjectable(metadata: unknown): boolean;
export type TopologyLayer = 'work' | 'knowledge' | 'evidence';
export declare function layerOf(type: string): TopologyLayer;
export interface TopologyEntity {
    name: string;
    type: string;
    id?: number;
    title?: string | null;
    snippet?: string | null;
    signalScore?: number | null;
    foreign?: boolean;
}
export declare function topologyLine(entity: TopologyEntity, maxChars: number): string;
export declare function extractCitedMemoryIds(text: string): Set<number>;
export interface TopologySection {
    heading: string;
    entities: TopologyEntity[];
}
export declare function groupTopology(entities: TopologyEntity[], projectName: string): TopologySection[];
export interface TopologyBudget {
    maxChars: number;
    maxLineChars?: number;
}
export declare const DEFAULT_TOPOLOGY_BUDGET: Readonly<Required<TopologyBudget>>;
export declare const TOPOLOGY_CANDIDATE_CAP = 400;
export declare const SNIPPET_FETCH_CHARS: number;
export declare function buildTopologyLines(entities: TopologyEntity[], projectName: string, budget: TopologyBudget): string[];
export interface TopologyPool {
    entities: TopologyEntity[];
    foreign: boolean;
}
export declare function assembleTopologyBlock(stateLines: readonly string[], pools: readonly TopologyPool[], projectName: string, budget?: TopologyBudget): string[];
export declare function buildReferenceContext(memoryLines: ReadonlyArray<string | null | undefined>): string;
//# sourceMappingURL=work-topology.d.ts.map