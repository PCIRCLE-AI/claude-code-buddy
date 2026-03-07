import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SkillManager } from '../../skills/index.js';
import { UninstallManager } from '../../management/index.js';
import { CheckpointDetector } from '../../core/CheckpointDetector.js';
import { HookIntegration } from '../../core/HookIntegration.js';
import { ProjectMemoryManager } from '../../memory/ProjectMemoryManager.js';
import { UnifiedMemoryStore } from '../../memory/UnifiedMemoryStore.js';
import { KnowledgeGraph } from '../../knowledge-graph/index.js';
import { HumanInLoopUI } from '../HumanInLoopUI.js';
import { SamplingClient } from '../SamplingClient.js';
export declare class ToolHandlers {
    private memoryHandler;
    private systemHandler;
    private hookHandler;
    constructor(skillManager: SkillManager, uninstallManager: UninstallManager, checkpointDetector: CheckpointDetector, hookIntegration: HookIntegration, projectMemoryManager: ProjectMemoryManager | undefined, knowledgeGraph: KnowledgeGraph | undefined, _ui: HumanInLoopUI, samplingClient: SamplingClient, unifiedMemoryStore: UnifiedMemoryStore | undefined);
    handleListSkills(args: unknown): Promise<CallToolResult>;
    handleUninstall(args: unknown): Promise<CallToolResult>;
    handleHookToolUse(args: unknown): Promise<CallToolResult>;
    handleRecallMemory(args: unknown): Promise<CallToolResult>;
    handleCreateEntities(args: unknown): Promise<CallToolResult>;
    handleBuddyRecordMistake(args: unknown): Promise<CallToolResult>;
    handleAddObservations(args: unknown): Promise<CallToolResult>;
    handleCreateRelations(args: unknown): Promise<CallToolResult>;
    handleGenerateTests(args: unknown): Promise<CallToolResult>;
}
//# sourceMappingURL=ToolHandlers.d.ts.map