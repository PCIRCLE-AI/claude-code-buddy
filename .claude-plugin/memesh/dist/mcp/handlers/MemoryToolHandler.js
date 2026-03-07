import { z } from 'zod';
import { ValidationError, OperationError } from '../../errors/index.js';
import { RateLimiter } from '../../utils/RateLimiter.js';
import { MistakePatternEngine } from '../../memory/MistakePatternEngine.js';
import { UserPreferenceEngine } from '../../memory/UserPreferenceEngine.js';
import { recallMemoryTool } from '../tools/recall-memory.js';
import { createEntitiesTool } from '../tools/create-entities.js';
import { addObservationsTool } from '../tools/add-observations.js';
import { createRelationsTool } from '../tools/create-relations.js';
import { handleBuddyRecordMistake } from './BuddyRecordMistake.js';
import { handleError, logError } from '../../utils/errorHandler.js';
import { RecallMemoryInputSchema, CreateEntitiesInputSchema, AddObservationsInputSchema, CreateRelationsInputSchema, formatValidationError, } from '../validation.js';
export class MemoryToolHandler {
    knowledgeGraph;
    projectMemoryManager;
    unifiedMemoryStore;
    memoryRateLimiter;
    mistakePatternEngine;
    userPreferenceEngine;
    constructor(knowledgeGraph, projectMemoryManager, unifiedMemoryStore) {
        this.knowledgeGraph = knowledgeGraph;
        this.projectMemoryManager = projectMemoryManager;
        this.unifiedMemoryStore = unifiedMemoryStore;
        this.memoryRateLimiter = new RateLimiter({ requestsPerMinute: 10 });
        this.mistakePatternEngine = unifiedMemoryStore ? new MistakePatternEngine(unifiedMemoryStore) : undefined;
        this.userPreferenceEngine = unifiedMemoryStore ? new UserPreferenceEngine(unifiedMemoryStore) : undefined;
    }
    isCloudOnlyMode() {
        return this.knowledgeGraph === undefined || this.projectMemoryManager === undefined;
    }
    cloudOnlyModeError(toolName) {
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
    async handleRecallMemory(args) {
        if (this.isCloudOnlyMode()) {
            return this.cloudOnlyModeError('recall-memory');
        }
        if (!this.memoryRateLimiter.consume()) {
            throw new OperationError('Memory operation rate limit exceeded. Please try again later.', {
                component: 'ToolHandlers',
                method: 'handleRecallMemory',
                rateLimitStatus: this.memoryRateLimiter.getStatus(),
            });
        }
        try {
            let validatedInput;
            try {
                validatedInput = RecallMemoryInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleRecallMemory',
                        schema: 'RecallMemoryInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            const result = await recallMemoryTool.handler(validatedInput, this.projectMemoryManager);
            let text = 'Project Memory Recall\n';
            text += '='.repeat(60) + '\n\n';
            if (result.memories.length === 0) {
                text += 'No memories found.\n\n';
                text += 'Memories will be created as you work on the project.\n';
            }
            else {
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
                        type: 'text',
                        text,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleRecallMemory',
                operation: 'recalling project memory',
                data: { query: args?.query, limit: args?.limit },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleRecallMemory',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to recall memory: ${handled.message}`,
                    },
                ],
            };
        }
    }
    async handleCreateEntities(args) {
        if (this.isCloudOnlyMode()) {
            return this.cloudOnlyModeError('create-entities');
        }
        if (!this.memoryRateLimiter.consume()) {
            throw new OperationError('Memory operation rate limit exceeded. Please try again later.', {
                component: 'ToolHandlers',
                method: 'handleCreateEntities',
                rateLimitStatus: this.memoryRateLimiter.getStatus(),
            });
        }
        try {
            let validatedInput;
            try {
                validatedInput = CreateEntitiesInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleCreateEntities',
                        schema: 'CreateEntitiesInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            const result = await createEntitiesTool.handler(validatedInput, this.knowledgeGraph);
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
            }
            else {
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
            }
            text += '\n' + '='.repeat(60) + '\n';
            return {
                content: [
                    {
                        type: 'text',
                        text,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleCreateEntities',
                operation: 'creating knowledge graph entities',
                data: { entityCount: args?.entities?.length ?? 0 },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleCreateEntities',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to create entities: ${handled.message}`,
                    },
                ],
            };
        }
    }
    async handleAddObservations(args) {
        if (this.isCloudOnlyMode()) {
            return this.cloudOnlyModeError('add-observations');
        }
        if (!this.memoryRateLimiter.consume()) {
            throw new OperationError('Memory operation rate limit exceeded. Please try again later.', {
                component: 'ToolHandlers',
                method: 'handleAddObservations',
                rateLimitStatus: this.memoryRateLimiter.getStatus(),
            });
        }
        try {
            let validatedInput;
            try {
                validatedInput = AddObservationsInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleAddObservations',
                        schema: 'AddObservationsInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            const result = await addObservationsTool.handler(validatedInput, this.knowledgeGraph);
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
            }
            else {
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
                        type: 'text',
                        text,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleAddObservations',
                operation: 'adding observations to entities',
                data: { observationCount: args?.observations?.length ?? 0 },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleAddObservations',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to add observations: ${handled.message}`,
                    },
                ],
            };
        }
    }
    async handleCreateRelations(args) {
        if (this.isCloudOnlyMode()) {
            return this.cloudOnlyModeError('create-relations');
        }
        if (!this.memoryRateLimiter.consume()) {
            throw new OperationError('Memory operation rate limit exceeded. Please try again later.', {
                component: 'ToolHandlers',
                method: 'handleCreateRelations',
                rateLimitStatus: this.memoryRateLimiter.getStatus(),
            });
        }
        try {
            let validatedInput;
            try {
                validatedInput = CreateRelationsInputSchema.parse(args);
            }
            catch (error) {
                if (error instanceof z.ZodError) {
                    throw new ValidationError(formatValidationError(error), {
                        component: 'ToolHandlers',
                        method: 'handleCreateRelations',
                        schema: 'CreateRelationsInputSchema',
                        providedArgs: args,
                    });
                }
                throw error;
            }
            const result = await createRelationsTool.handler(validatedInput, this.knowledgeGraph);
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
            }
            else {
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
                        type: 'text',
                        text,
                    },
                ],
            };
        }
        catch (error) {
            logError(error, {
                component: 'ToolHandlers',
                method: 'handleCreateRelations',
                operation: 'creating entity relations',
                data: { relationCount: args?.relations?.length ?? 0 },
            });
            const handled = handleError(error, {
                component: 'ToolHandlers',
                method: 'handleCreateRelations',
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to create relations: ${handled.message}`,
                    },
                ],
            };
        }
    }
    async handleBuddyRecordMistake(args) {
        if (this.isCloudOnlyMode()) {
            return this.cloudOnlyModeError('buddy-record-mistake');
        }
        if (!this.memoryRateLimiter.consume()) {
            throw new OperationError('Memory operation rate limit exceeded. Please try again later.', {
                component: 'ToolHandlers',
                method: 'handleBuddyRecordMistake',
                rateLimitStatus: this.memoryRateLimiter.getStatus(),
            });
        }
        if (!args || typeof args !== 'object') {
            throw new ValidationError('Invalid input: expected object', {
                component: 'ToolHandlers',
                method: 'handleBuddyRecordMistake',
                providedArgs: args,
            });
        }
        const input = args;
        const requiredFields = ['action', 'errorType', 'userCorrection', 'correctMethod', 'impact', 'preventionMethod'];
        for (const field of requiredFields) {
            if (!(field in input) || !input[field]) {
                throw new ValidationError(`Missing required field: ${field}`, {
                    component: 'ToolHandlers',
                    method: 'handleBuddyRecordMistake',
                    missingField: field,
                });
            }
        }
        return handleBuddyRecordMistake(input, this.unifiedMemoryStore, this.mistakePatternEngine, this.userPreferenceEngine);
    }
}
//# sourceMappingURL=MemoryToolHandler.js.map