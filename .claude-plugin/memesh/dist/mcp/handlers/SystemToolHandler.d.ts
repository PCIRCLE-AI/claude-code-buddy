import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SkillManager } from '../../skills/index.js';
import { UninstallManager } from '../../management/index.js';
import { SamplingClient } from '../SamplingClient.js';
export declare class SystemToolHandler {
    private skillManager;
    private uninstallManager;
    private samplingClient;
    constructor(skillManager: SkillManager, uninstallManager: UninstallManager, samplingClient: SamplingClient);
    handleListSkills(args: unknown): Promise<CallToolResult>;
    handleUninstall(args: unknown): Promise<CallToolResult>;
    handleGenerateTests(args: unknown): Promise<CallToolResult>;
}
//# sourceMappingURL=SystemToolHandler.d.ts.map