import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ValidationError } from '../../errors/index.js';
import { handleError, logError } from '../../utils/errorHandler.js';
import { HookToolUseInputSchema, formatValidationError, } from '../validation.js';
export class HookToolHandler {
    checkpointDetector;
    hookIntegration;
    constructor(checkpointDetector, hookIntegration) {
        this.checkpointDetector = checkpointDetector;
        this.hookIntegration = hookIntegration;
    }
    async handleHookToolUse(args, isCloudOnlyMode, cloudOnlyModeError) {
        if (isCloudOnlyMode) {
            return cloudOnlyModeError('hook-tool-use');
        }
        try {
            let validatedInput;
            try {
                validatedInput = HookToolUseInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleHookToolUse',
                        schema: 'HookToolUseInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            await this.hookIntegration.processToolUse({
                toolName: validatedInput.toolName,
                arguments: validatedInput.arguments,
                success: validatedInput.success,
                duration: validatedInput.duration,
                tokensUsed: validatedInput.tokensUsed,
                output: validatedInput.output,
            });
            let recallContext = '';
            try {
                const recallFile = path.join(os.homedir(), '.claude', 'state', 'proactive-recall.json');
                if (fs.existsSync(recallFile)) {
                    const raw = fs.readFileSync(recallFile, 'utf-8');
                    const recallData = JSON.parse(raw);
                    if (Date.now() - recallData.timestamp < 30_000 && recallData.results?.length > 0) {
                        const lines = recallData.results.map((r) => {
                            const obs = r.observations.slice(0, 2).join('; ');
                            return `  - ${r.name}: ${obs}`;
                        });
                        recallContext = `\n\n[Proactive Recall - ${recallData.trigger}]\n${lines.join('\n')}`;
                        fs.unlinkSync(recallFile);
                    }
                }
            }
            catch {
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true }, null, 2) + recallContext,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleHookToolUse',
                operation: 'processing hook tool use',
                data: { toolName: args?.toolName },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleHookToolUse',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Hook processing failed: ${handled.message}`,
                    },
                ],
            };
        }
    }
}
//# sourceMappingURL=HookToolHandler.js.map