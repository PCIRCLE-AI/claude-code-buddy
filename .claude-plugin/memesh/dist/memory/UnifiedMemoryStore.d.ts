import { KnowledgeGraph } from '../knowledge-graph/index.js';
import type { UnifiedMemory, MemoryType, SearchOptions } from './types/unified-memory.js';
export declare class UnifiedMemoryStore {
    private knowledgeGraph;
    private readonly searchEngine;
    constructor(knowledgeGraph: KnowledgeGraph);
    static create(dbPath?: string): Promise<UnifiedMemoryStore>;
    store(memory: UnifiedMemory, context?: {
        projectPath?: string;
        techStack?: string[];
    }): Promise<string>;
    get(id: string): Promise<UnifiedMemory | null>;
    search(query: string, options?: SearchOptions & {
        projectPath?: string;
        techStack?: string[];
    }): Promise<UnifiedMemory[]>;
    private traditionalSearch;
    private applySearchFilters;
    private deduplicateResults;
    searchByType(type: MemoryType, options?: SearchOptions): Promise<UnifiedMemory[]>;
    searchByTags(tags: string[], options?: SearchOptions): Promise<UnifiedMemory[]>;
    update(id: string, updates: Partial<UnifiedMemory>): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    close(): Promise<void>;
    private entityToMemory;
}
//# sourceMappingURL=UnifiedMemoryStore.d.ts.map