/**
 * Memory Tool Handler
 *
 * Handles all memory-related MCP tool operations:
 * - Recall memory
 * - Create entities
 * - Add observations
 * - Create relations
 * - Record mistakes
 *
 * @module MemoryToolHandler
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ValidationError, OperationError } from '../../errors/index.js';
import { RateLimiter } from '../../utils/RateLimiter.js';
import { ProjectMemoryManager } from '../../memory/ProjectMemoryManager.js';
import { UnifiedMemoryStore } from '../../memory/UnifiedMemoryStore.js';
import { MistakePatternEngine } from '../../memory/MistakePatternEngine.js';
import { UserPreferenceEngine } from '../../memory/UserPreferenceEngine.js';
import { KnowledgeGraph } from '../../knowledge-graph/index.js';
import { recallMemoryTool } from '../tools/recall-memory.js';
import { createEntitiesTool } from '../tools/create-entities.js';
import { addObservationsTool } from '../tools/add-observations.js';
import { createRelationsTool } from '../tools/create-relations.js';
import { handleBuddyRecordMistake, type BuddyRecordMistakeInput } from './BuddyRecordMistake.js';
import { handleError, logError } from '../../utils/errorHandler.js';
import {
  RecallMemoryInputSchema,
  CreateEntitiesInputSchema,
  AddObservationsInputSchema,
  CreateRelationsInputSchema,
  formatValidationError,
  type ValidatedRecallMemoryInput,
  type ValidatedCreateEntitiesInput,
  type ValidatedAddObservationsInput,
  type ValidatedCreateRelationsInput,
} from '../validation.js';

/**
 * Memory Tool Handler
 *
 * Handles memory CRUD operations including knowledge graph entities,
 * observations, relations, and mistake recording.
 */
export class MemoryToolHandler {
  /** Rate limiter for memory operations (10 req/min) */
  private memoryRateLimiter: RateLimiter;

  /** Pattern engine for auto-extracting prevention rules */
  private mistakePatternEngine: MistakePatternEngine | undefined;

  /** Preference engine for auto-learning user preferences */
  private userPreferenceEngine: UserPreferenceEngine | undefined;

  constructor(
    private knowledgeGraph: KnowledgeGraph | undefined,
    private projectMemoryManager: ProjectMemoryManager | undefined,
    private unifiedMemoryStore: UnifiedMemoryStore | undefined
  ) {
    this.memoryRateLimiter = new RateLimiter({ requestsPerMinute: 10 });

    // Initialize memory engines only if unified store is available
    this.mistakePatternEngine = unifiedMemoryStore ? new MistakePatternEngine(unifiedMemoryStore) : undefined;
    this.userPreferenceEngine = unifiedMemoryStore ? new UserPreferenceEngine(unifiedMemoryStore) : undefined;
  }

  /**
   * Check if local memory systems are available
   */
  isCloudOnlyMode(): boolean {
    return this.knowledgeGraph === undefined || this.projectMemoryManager === undefined;
  }

  /**
   * Return cloud-only mode error message
   */
  cloudOnlyModeError(toolName: string): CallToolResult {
    return {
      content: [
        {
          type: 'text',
          text: `\u274C Tool '${toolName}' is not available in cloud-only mode.\n\n` +
                `This MCP server is running without local SQLite storage (better-sqlite3 unavailable).\n\n` +
                `To use local memory tools:\n` +
                `1. Install better-sqlite3: npm install better-sqlite3\n` +
                `2. Restart the MCP server\n\n` +
                `Local SQLite storage is required for memory features.`,
        },
      ],
      isError: true,
    };
  }

  /**
   * Handle recall-memory tool
   */
  async handleRecallMemory(args: unknown): Promise<CallToolResult> {
    if (this.isCloudOnlyMode()) {
      return this.cloudOnlyModeError('recall-memory');
    }

    if (!this.memoryRateLimiter.consume()) {
      throw new OperationError(
        'Memory operation rate limit exceeded. Please try again later.',
        {
          component: 'ToolHandlers',
          method: 'handleRecallMemory',
          rateLimitStatus: this.memoryRateLimiter.getStatus(),
        }
      );
    }

    try {
      let validatedInput: ValidatedRecallMemoryInput;
      try {
        validatedInput = RecallMemoryInputSchema.parse(args);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ValidationError(
            formatValidationError(error),
            {
              component: 'ToolHandlers',
              method: 'handleRecallMemory',
              schema: 'RecallMemoryInputSchema',
              providedArgs: args,
            }
          );
        }
        throw error;
      }

      const result = await recallMemoryTool.handler(
        validatedInput,
        this.projectMemoryManager!
      );

      let text = 'Project Memory Recall\n';
      text += '='.repeat(60) + '\n\n';

      if (result.memories.length === 0) {
        text += 'No memories found.\n\n';
        text += 'Memories will be created as you work on the project.\n';
      } else {
        text += `Found ${result.memories.length} recent memories:\n\n`;

        result.memories.forEach((memory, index) => {
          text += `${index + 1}. ${memory.type}\n`;
          if (memory.timestamp) {
            text += `   Timestamp: ${memory.timestamp}\n`;
          }
          if (memory.observations && memory.observations.length > 0) {
            text += '   Observations:\n';
            memory.observations.forEach(obs => {
              text += `   - ${obs}\n`;
            });
          }
          text += '\n';
        });
      }

      text += '='.repeat(60) + '\n';

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      };
    } catch (error) {
      logError(error, {
        component: 'ToolHandlers',
        method: 'handleRecallMemory',
        operation: 'recalling project memory',
        data: { query: (args as { query?: string } | null)?.query, limit: (args as { limit?: number } | null)?.limit },
      });

      const handled = handleError(error, {
        component: 'ToolHandlers',
        method: 'handleRecallMemory',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to recall memory: ${handled.message}`,
          },
        ],
      };
    }
  }

  /**
   * Handle create-entities tool
   */
  async handleCreateEntities(args: unknown): Promise<CallToolResult> {
    if (this.isCloudOnlyMode()) {
      return this.cloudOnlyModeError('create-entities');
    }

    if (!this.memoryRateLimiter.consume()) {
      throw new OperationError(
        'Memory operation rate limit exceeded. Please try again later.',
        {
          component: 'ToolHandlers',
          method: 'handleCreateEntities',
          rateLimitStatus: this.memoryRateLimiter.getStatus(),
        }
      );
    }

    try {
      let validatedInput: ValidatedCreateEntitiesInput;
      try {
        validatedInput = CreateEntitiesInputSchema.parse(args);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ValidationError(
            formatValidationError(error),
            {
              component: 'ToolHandlers',
              method: 'handleCreateEntities',
              schema: 'CreateEntitiesInputSchema',
              providedArgs: args,
            }
          );
        }
        throw error;
      }

      const result = await createEntitiesTool.handler(
        validatedInput,
        this.knowledgeGraph!
      );

      let text = 'Knowledge Graph Entity Creation\n';
      text += '='.repeat(60) + '\n\n';

      if (result.count === 0) {
        text += 'No entities were created.\n\n';
        if (result.errors && result.errors.length > 0) {
          text += 'Errors encountered:\n';
          result.errors.forEach(error => {
            text += `  - ${error.name}: ${error.error}\n`;
          });
        }
      } else {
        text += `Successfully created ${result.count} ${result.count === 1 ? 'entity' : 'entities'}:\n\n`;
        result.created.forEach((name, index) => {
          text += `${index + 1}. ${name}\n`;
        });

        if (result.errors && result.errors.length > 0) {
          text += '\nSome entities failed:\n';
          result.errors.forEach(error => {
            text += `  - ${error.name}: ${error.error}\n`;
          });
        }
        if (result.autoRelationsCreated && result.autoRelationsCreated > 0) {
          text += `\nAuto-created ${result.autoRelationsCreated} ${result.autoRelationsCreated === 1 ? 'relation' : 'relations'} based on topic matching.\n`;
        }
      }

      text += '\n' + '='.repeat(60) + '\n';

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      };
    } catch (error) {
      logError(error, {
        component: 'ToolHandlers',
        method: 'handleCreateEntities',
        operation: 'creating knowledge graph entities',
        data: { entityCount: (args as { entities?: unknown[] } | null)?.entities?.length ?? 0 },
      });

      const handled = handleError(error, {
        component: 'ToolHandlers',
        method: 'handleCreateEntities',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to create entities: ${handled.message}`,
          },
        ],
      };
    }
  }

  /**
   * Handle add-observations tool
   */
  async handleAddObservations(args: unknown): Promise<CallToolResult> {
    if (this.isCloudOnlyMode()) {
      return this.cloudOnlyModeError('add-observations');
    }

    if (!this.memoryRateLimiter.consume()) {
      throw new OperationError(
        'Memory operation rate limit exceeded. Please try again later.',
        {
          component: 'ToolHandlers',
          method: 'handleAddObservations',
          rateLimitStatus: this.memoryRateLimiter.getStatus(),
        }
      );
    }

    try {
      let validatedInput: ValidatedAddObservationsInput;
      try {
        validatedInput = AddObservationsInputSchema.parse(args);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ValidationError(
            formatValidationError(error),
            {
              component: 'ToolHandlers',
              method: 'handleAddObservations',
              schema: 'AddObservationsInputSchema',
              providedArgs: args,
            }
          );
        }
        throw error;
      }

      const result = await addObservationsTool.handler(
        validatedInput,
        this.knowledgeGraph!
      );

      let text = 'Knowledge Graph Observation Update\n';
      text += '='.repeat(60) + '\n\n';

      if (result.count === 0) {
        text += 'No observations were added.\n\n';
        if (result.notFound && result.notFound.length > 0) {
          text += 'Entities not found:\n';
          result.notFound.forEach(name => {
            text += `  - ${name}\n`;
          });
        }
        if (result.errors && result.errors.length > 0) {
          text += '\nErrors encountered:\n';
          result.errors.forEach(error => {
            text += `  - ${error.entityName}: ${error.error}\n`;
          });
        }
      } else {
        text += `Successfully updated ${result.count} ${result.count === 1 ? 'entity' : 'entities'}:\n\n`;
        result.updated.forEach((name, index) => {
          text += `${index + 1}. ${name}\n`;
        });

        if (result.notFound && result.notFound.length > 0) {
          text += '\nSome entities were not found:\n';
          result.notFound.forEach(name => {
            text += `  - ${name}\n`;
          });
        }

        if (result.errors && result.errors.length > 0) {
          text += '\nSome updates failed:\n';
          result.errors.forEach(error => {
            text += `  - ${error.entityName}: ${error.error}\n`;
          });
        }
      }

      text += '\n' + '='.repeat(60) + '\n';

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      };
    } catch (error) {
      logError(error, {
        component: 'ToolHandlers',
        method: 'handleAddObservations',
        operation: 'adding observations to entities',
        data: { observationCount: (args as { observations?: unknown[] } | null)?.observations?.length ?? 0 },
      });

      const handled = handleError(error, {
        component: 'ToolHandlers',
        method: 'handleAddObservations',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to add observations: ${handled.message}`,
          },
        ],
      };
    }
  }

  /**
   * Handle create-relations tool
   */
  async handleCreateRelations(args: unknown): Promise<CallToolResult> {
    if (this.isCloudOnlyMode()) {
      return this.cloudOnlyModeError('create-relations');
    }

    if (!this.memoryRateLimiter.consume()) {
      throw new OperationError(
        'Memory operation rate limit exceeded. Please try again later.',
        {
          component: 'ToolHandlers',
          method: 'handleCreateRelations',
          rateLimitStatus: this.memoryRateLimiter.getStatus(),
        }
      );
    }

    try {
      let validatedInput: ValidatedCreateRelationsInput;
      try {
        validatedInput = CreateRelationsInputSchema.parse(args);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ValidationError(
            formatValidationError(error),
            {
              component: 'ToolHandlers',
              method: 'handleCreateRelations',
              schema: 'CreateRelationsInputSchema',
              providedArgs: args,
            }
          );
        }
        throw error;
      }

      const result = await createRelationsTool.handler(
        validatedInput,
        this.knowledgeGraph!
      );

      let text = 'Knowledge Graph Relation Creation\n';
      text += '='.repeat(60) + '\n\n';

      if (result.count === 0) {
        text += 'No relations were created.\n\n';
        if (result.missingEntities && result.missingEntities.length > 0) {
          text += 'Entities not found:\n';
          result.missingEntities.forEach(name => {
            text += `  - ${name}\n`;
          });
        }
        if (result.errors && result.errors.length > 0) {
          text += '\nErrors encountered:\n';
          result.errors.forEach(error => {
            text += `  - ${error.from} -> ${error.to}: ${error.error}\n`;
          });
        }
      } else {
        text += `Successfully created ${result.count} ${result.count === 1 ? 'relation' : 'relations'}:\n\n`;
        result.created.forEach((rel, index) => {
          text += `${index + 1}. ${rel.from} --[${rel.type}]--> ${rel.to}\n`;
        });

        if (result.missingEntities && result.missingEntities.length > 0) {
          text += '\nSome entities were not found:\n';
          result.missingEntities.forEach(name => {
            text += `  - ${name}\n`;
          });
        }

        if (result.errors && result.errors.length > 0) {
          text += '\nSome relations failed:\n';
          result.errors.forEach(error => {
            text += `  - ${error.from} -> ${error.to}: ${error.error}\n`;
          });
        }
      }

      text += '\n' + '='.repeat(60) + '\n';

      return {
        content: [
          {
            type: 'text' as const,
            text,
          },
        ],
      };
    } catch (error) {
      logError(error, {
        component: 'ToolHandlers',
        method: 'handleCreateRelations',
        operation: 'creating entity relations',
        data: { relationCount: (args as { relations?: unknown[] } | null)?.relations?.length ?? 0 },
      });

      const handled = handleError(error, {
        component: 'ToolHandlers',
        method: 'handleCreateRelations',
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to create relations: ${handled.message}`,
          },
        ],
      };
    }
  }

  /**
   * Handle buddy-record-mistake tool
   */
  async handleBuddyRecordMistake(args: unknown): Promise<CallToolResult> {
    if (this.isCloudOnlyMode()) {
      return this.cloudOnlyModeError('buddy-record-mistake');
    }

    if (!this.memoryRateLimiter.consume()) {
      throw new OperationError(
        'Memory operation rate limit exceeded. Please try again later.',
        {
          component: 'ToolHandlers',
          method: 'handleBuddyRecordMistake',
          rateLimitStatus: this.memoryRateLimiter.getStatus(),
        }
      );
    }

    if (!args || typeof args !== 'object') {
      throw new ValidationError('Invalid input: expected object', {
        component: 'ToolHandlers',
        method: 'handleBuddyRecordMistake',
        providedArgs: args,
      });
    }

    const input = args as BuddyRecordMistakeInput;

    const requiredFields = ['action', 'errorType', 'userCorrection', 'correctMethod', 'impact', 'preventionMethod'];
    for (const field of requiredFields) {
      if (!(field in input) || !input[field as keyof BuddyRecordMistakeInput]) {
        throw new ValidationError(`Missing required field: ${field}`, {
          component: 'ToolHandlers',
          method: 'handleBuddyRecordMistake',
          missingField: field,
        });
      }
    }

    return handleBuddyRecordMistake(
      input,
      this.unifiedMemoryStore!,
      this.mistakePatternEngine!,
      this.userPreferenceEngine!
    );
  }
}
