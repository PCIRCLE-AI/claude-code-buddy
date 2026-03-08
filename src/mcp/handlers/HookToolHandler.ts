/**
 * Hook Tool Handler
 *
 * Handles hook-related MCP tool operations:
 * - Tool use tracking via hook integration
 *
 * @module HookToolHandler
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ValidationError } from '../../errors/index.js';
import { CheckpointDetector } from '../../core/CheckpointDetector.js';
import { HookIntegration } from '../../core/HookIntegration.js';
import { handleError, logError } from '../../utils/errorHandler.js';
import {
  HookToolUseInputSchema,
  formatValidationError,
  type ValidatedHookToolUseInput,
} from '../validation.js';

/**
 * Hook Tool Handler
 *
 * Handles hook tool use tracking for monitoring and checkpoint detection.
 */
export class HookToolHandler {
  constructor(
    private checkpointDetector: CheckpointDetector,
    private hookIntegration: HookIntegration
  ) {}

  /**
   * Handle hook-tool-use tool
   *
   * @param isCloudOnlyMode - Whether the server is running in cloud-only mode
   * @param cloudOnlyModeError - Function to generate cloud-only mode error response
   */
  async handleHookToolUse(
    args: unknown,
    isCloudOnlyMode: boolean,
    cloudOnlyModeError: (toolName: string) => CallToolResult
  ): Promise<CallToolResult> {
    if (isCloudOnlyMode) {
      return cloudOnlyModeError('hook-tool-use');
    }

    try {
      let validatedInput: ValidatedHookToolUseInput;
      try {
        validatedInput = HookToolUseInputSchema.parse(args);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ValidationError(
            formatValidationError(error),
            {
              component: 'ToolHandlers',
              method: 'handleHookToolUse',
              schema: 'HookToolUseInputSchema',
              providedArgs: args,
            }
          );
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

      // Read proactive recall results if available
      let recallContext = '';
      try {
        const recallFile = path.join(os.homedir(), '.claude', 'state', 'proactive-recall.json');
        if (fs.existsSync(recallFile)) {
          const raw = fs.readFileSync(recallFile, 'utf-8');
          const recallData = JSON.parse(raw);
          // Only use if fresh (< 30 seconds old)
          if (Date.now() - recallData.timestamp < 30_000 && recallData.results?.length > 0) {
            const lines = recallData.results.map((r: { name: string; observations: string[] }) => {
              const obs = r.observations.slice(0, 2).join('; ');
              return `  - ${r.name}: ${obs}`;
            });
            recallContext = `\n\n[Proactive Recall - ${recallData.trigger}]\n${lines.join('\n')}`;
            // Delete after reading to prevent stale data
            fs.unlinkSync(recallFile);
          }
        }
      } catch {
        // Non-critical
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true }, null, 2) + recallContext,
          },
        ],
      };
    } catch (error) {
      logError(error, {
        component: 'ToolHandlers',
        method: 'handleHookToolUse',
        operation: 'processing hook tool use',
        data: { toolName: (args as { toolName?: string } | null)?.toolName },
      });

      const handled = handleError(error, {
        component: 'ToolHandlers',
        method: 'handleHookToolUse',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Hook processing failed: ${handled.message}`,
          },
        ],
      };
    }
  }
}
