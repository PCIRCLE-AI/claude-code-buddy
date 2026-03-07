import type { UnifiedMemory, SearchOptions } from './types/unified-memory.js';
export declare class MemorySearchEngine {
    private readonly smartQuery;
    constructor();
    filterByQuery(memories: UnifiedMemory[], query: string): UnifiedMemory[];
    applySearchFilters(memories: UnifiedMemory[], options?: SearchOptions): UnifiedMemory[];
    deduplicateResults(memories: UnifiedMemory[]): UnifiedMemory[];
    rankByRelevance(query: string, memories: UnifiedMemory[], options?: SearchOptions & {
        projectPath?: string;
        techStack?: string[];
    }): UnifiedMemory[];
    processSearchResults(query: string, candidates: UnifiedMemory[], options?: SearchOptions & {
        projectPath?: string;
        techStack?: string[];
    }, finalLimit?: number): UnifiedMemory[];
}
//# sourceMappingURL=MemorySearchEngine.d.ts.map