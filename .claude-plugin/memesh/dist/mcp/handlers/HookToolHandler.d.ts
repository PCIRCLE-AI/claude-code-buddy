import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CheckpointDetector } from '../../core/CheckpointDetector.js';
import { HookIntegration } from '../../core/HookIntegration.js';
export declare class HookToolHandler {
    private checkpointDetector;
    private hookIntegration;
    constructor(checkpointDetector: CheckpointDetector, hookIntegration: HookIntegration);
    handleHookToolUse(args: unknown, isCloudOnlyMode: boolean, cloudOnlyModeError: (toolName: string) => CallToolResult): Promise<CallToolResult>;
}
//# sourceMappingURL=HookToolHandler.d.ts.map