import { MemoryToolHandler } from './MemoryToolHandler.js';
import { SystemToolHandler } from './SystemToolHandler.js';
import { HookToolHandler } from './HookToolHandler.js';
export class ToolHandlers {
    memoryHandler;
    systemHandler;
    hookHandler;
    constructor(skillManager, uninstallManager, checkpointDetector, hookIntegration, projectMemoryManager, knowledgeGraph, _ui, samplingClient, unifiedMemoryStore) {
        this.memoryHandler = new MemoryToolHandler(knowledgeGraph, projectMemoryManager, unifiedMemoryStore);
        this.systemHandler = new SystemToolHandler(skillManager, uninstallManager, samplingClient);
        this.hookHandler = new HookToolHandler(checkpointDetector, hookIntegration);
    }
    async handleListSkills(args) {
        return this.systemHandler.handleListSkills(args);
    }
    async handleUninstall(args) {
        return this.systemHandler.handleUninstall(args);
    }
    async handleHookToolUse(args) {
        return this.hookHandler.handleHookToolUse(args, this.memoryHandler.isCloudOnlyMode(), (toolName) => this.memoryHandler.cloudOnlyModeError(toolName));
    }
    async handleRecallMemory(args) {
        return this.memoryHandler.handleRecallMemory(args);
    }
    async handleCreateEntities(args) {
        return this.memoryHandler.handleCreateEntities(args);
    }
    async handleBuddyRecordMistake(args) {
        return this.memoryHandler.handleBuddyRecordMistake(args);
    }
    async handleAddObservations(args) {
        return this.memoryHandler.handleAddObservations(args);
    }
    async handleCreateRelations(args) {
        return this.memoryHandler.handleCreateRelations(args);
    }
    async handleGenerateTests(args) {
        return this.systemHandler.handleGenerateTests(args);
    }
}
//# sourceMappingURL=ToolHandlers.js.map