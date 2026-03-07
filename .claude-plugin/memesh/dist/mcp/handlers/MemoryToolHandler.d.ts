import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ProjectMemoryManager } from '../../memory/ProjectMemoryManager.js';
import { UnifiedMemoryStore } from '../../memory/UnifiedMemoryStore.js';
import { KnowledgeGraph } from '../../knowledge-graph/index.js';
export declare class MemoryToolHandler {
    private knowledgeGraph;
    private projectMemoryManager;
    private unifiedMemoryStore;
    private memoryRateLimiter;
    private mistakePatternEngine;
    private userPreferenceEngine;
    constructor(knowledgeGraph: KnowledgeGraph | undefined, projectMemoryManager: ProjectMemoryManager | undefined, unifiedMemoryStore: UnifiedMemoryStore | undefined);
    isCloudOnlyMode(): boolean;
    cloudOnlyModeError(toolName: string): CallToolResult;
    handleRecallMemory(args: unknown): Promise<CallToolResult>;
    handleCreateEntities(args: unknown): Promise<CallToolResult>;
    handleAddObservations(args: unknown): Promise<CallToolResult>;
    handleCreateRelations(args: unknown): Promise<CallToolResult>;
    handleBuddyRecordMistake(args: unknown): Promise<CallToolResult>;
}
//# sourceMappingURL=MemoryToolHandler.d.ts.map