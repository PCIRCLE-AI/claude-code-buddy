import { KnowledgeGraph } from '../knowledge-graph/index.js';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { ValidationError, OperationError } from '../errors/index.js';
import { AutoTagger } from './AutoTagger.js';
import { MemorySearchEngine } from './MemorySearchEngine.js';
function extractErrorInfo(error) {
    if (error instanceof Error) {
        return {
            message: error.message,
            type: error.constructor.name,
        };
    }
    if (typeof error === 'string') {
        return {
            message: error,
            type: 'string',
        };
    }
    return {
        message: String(error),
        type: typeof error,
    };
}
const MEMORY_TYPE_MAPPING = {
    mistake: 'lesson_learned',
    conversation: 'session_snapshot',
    knowledge: 'best_practice',
    decision: 'decision',
    experience: 'learning_experience',
    'prevention-rule': 'prevention_rule',
    'user-preference': 'user_preference',
};
const ENTITY_TYPE_MAPPING = {
    lesson_learned: 'mistake',
    session_snapshot: 'conversation',
    best_practice: 'knowledge',
    decision: 'decision',
    learning_experience: 'experience',
    prevention_rule: 'prevention-rule',
    user_preference: 'user-preference',
};
const MEMORY_ID_PREFIX = 'unified-memory-';
const MAX_METADATA_SIZE = 1024 * 1024;
export class UnifiedMemoryStore {
    knowledgeGraph;
    searchEngine;
    constructor(knowledgeGraph) {
        this.knowledgeGraph = knowledgeGraph;
        this.searchEngine = new MemorySearchEngine();
    }
    static async create(dbPath) {
        try {
            const knowledgeGraph = await KnowledgeGraph.create(dbPath);
            const instance = new UnifiedMemoryStore(knowledgeGraph);
            logger.info(`[UnifiedMemoryStore] Initialized with database at: ${dbPath || 'default'}`);
            return instance;
        }
        catch (error) {
            const errorInfo = extractErrorInfo(error);
            logger.error(`[UnifiedMemoryStore] Initialization failed: ${errorInfo.message} (type: ${errorInfo.type})`);
            throw new OperationError(`Failed to create UnifiedMemoryStore: ${errorInfo.message}`, {
                component: 'UnifiedMemoryStore',
                method: 'create',
                dbPath,
                errorType: errorInfo.type,
                cause: error,
            });
        }
    }
    async store(memory, context) {
        try {
            if (!memory.content || memory.content.trim() === '') {
                throw new ValidationError('Memory content cannot be empty', {
                    component: 'UnifiedMemoryStore',
                    method: 'store',
                    memoryType: memory.type,
                });
            }
            if (!memory.type) {
                throw new ValidationError('Memory type is required', {
                    component: 'UnifiedMemoryStore',
                    method: 'store',
                });
            }
            if (memory.importance !== undefined) {
                if (!Number.isFinite(memory.importance)) {
                    throw new ValidationError(`Importance must be a finite number, got ${memory.importance}`, {
                        component: 'UnifiedMemoryStore',
                        method: 'store',
                        data: { importance: memory.importance, type: typeof memory.importance },
                    });
                }
                if (memory.importance < 0 || memory.importance > 1) {
                    throw new ValidationError(`Importance must be between 0 and 1, got ${memory.importance}`, {
                        component: 'UnifiedMemoryStore',
                        method: 'store',
                        data: { importance: memory.importance },
                    });
                }
            }
            let id;
            if (memory.id !== undefined) {
                if (memory.id.trim() === '') {
                    throw new ValidationError('Memory ID cannot be empty', {
                        component: 'UnifiedMemoryStore',
                        method: 'store',
                        data: { providedId: memory.id },
                    });
                }
                if (!memory.id.startsWith(MEMORY_ID_PREFIX)) {
                    throw new ValidationError(`Memory ID must start with prefix: ${MEMORY_ID_PREFIX}`, {
                        component: 'UnifiedMemoryStore',
                        method: 'store',
                        data: {
                            providedId: memory.id,
                            requiredPrefix: MEMORY_ID_PREFIX,
                        },
                    });
                }
                id = memory.id;
            }
            else {
                id = `${MEMORY_ID_PREFIX}${uuidv4()}`;
            }
            const contentHash = createHash('sha256').update(memory.content).digest('hex');
            const timestamp = memory.timestamp || new Date();
            const autoTagger = new AutoTagger();
            const tagsToUse = autoTagger.generateTags(memory.content, memory.tags, context);
            if (context) {
                logger.info(`[UnifiedMemoryStore] Storing memory with tags: ${tagsToUse.join(', ')}`);
            }
            const entityType = MEMORY_TYPE_MAPPING[memory.type];
            if (!entityType) {
                throw new ValidationError(`Invalid memory type: ${memory.type}`, {
                    component: 'UnifiedMemoryStore',
                    method: 'store',
                    memoryType: memory.type,
                    validTypes: Object.keys(MEMORY_TYPE_MAPPING),
                });
            }
            const normalizedImportance = memory.importance ?? 0.5;
            const observations = [
                `content: ${memory.content}`,
                `importance: ${normalizedImportance}`,
                `timestamp: ${timestamp.toISOString()}`,
            ];
            if (memory.context) {
                observations.push(`context: ${memory.context}`);
            }
            if (memory.metadata) {
                try {
                    const metadataJson = JSON.stringify(memory.metadata);
                    const sizeInBytes = Buffer.byteLength(metadataJson, 'utf8');
                    if (sizeInBytes >= MAX_METADATA_SIZE) {
                        throw new ValidationError(`Metadata size exceeds limit: ${(sizeInBytes / 1024).toFixed(2)}KB / ${(MAX_METADATA_SIZE / 1024).toFixed(2)}KB`, {
                            component: 'UnifiedMemoryStore',
                            method: 'store',
                            data: {
                                metadataSize: sizeInBytes,
                                limit: MAX_METADATA_SIZE,
                                sizeMB: (sizeInBytes / (1024 * 1024)).toFixed(2),
                            },
                        });
                    }
                    observations.push(`metadata: ${metadataJson}`);
                }
                catch (error) {
                    if (error instanceof ValidationError) {
                        throw error;
                    }
                    logger.warn(`[UnifiedMemoryStore] Failed to serialize metadata: ${error}`);
                }
            }
            const entity = {
                name: id,
                entityType,
                observations,
                tags: tagsToUse,
                contentHash,
                metadata: {
                    memoryType: memory.type,
                    importance: normalizedImportance,
                    timestamp: timestamp.toISOString(),
                    ...(memory.metadata || {}),
                },
            };
            let actualId = id;
            try {
                this.knowledgeGraph.transaction(() => {
                    actualId = this.knowledgeGraph.createEntity(entity);
                    if (actualId !== id) {
                        logger.info(`[UnifiedMemoryStore] Deduplicated: generated id ${id}, using existing ${actualId}`);
                    }
                    if (memory.relations && memory.relations.length > 0) {
                        const relationFailures = [];
                        for (const relatedId of memory.relations) {
                            const targetEntity = this.knowledgeGraph.getEntity(relatedId);
                            if (!targetEntity) {
                                relationFailures.push({
                                    relatedId,
                                    error: 'Target entity does not exist',
                                });
                                logger.warn(`[UnifiedMemoryStore] Cannot create relation to non-existent entity: ${relatedId}`);
                                continue;
                            }
                            try {
                                this.knowledgeGraph.createRelation({
                                    from: actualId,
                                    to: relatedId,
                                    relationType: 'depends_on',
                                    metadata: { createdAt: new Date().toISOString() },
                                });
                            }
                            catch (error) {
                                const errorInfo = extractErrorInfo(error);
                                relationFailures.push({
                                    relatedId,
                                    error: errorInfo.message,
                                });
                                logger.error(`[UnifiedMemoryStore] Failed to create relation to ${relatedId}: ${errorInfo.message}`);
                            }
                        }
                        if (relationFailures.length > 0) {
                            throw new Error(`Failed to create ${relationFailures.length} relation(s): ` +
                                relationFailures.map(f => `${f.relatedId} (${f.error})`).join(', '));
                        }
                    }
                });
            }
            catch (error) {
                const errorInfo = extractErrorInfo(error);
                logger.error(`[UnifiedMemoryStore] Failed to create memory (transaction rolled back): ${errorInfo.message} (type: ${errorInfo.type})`);
                throw new OperationError(`Failed to store memory: ${errorInfo.message}`, {
                    component: 'UnifiedMemoryStore',
                    method: 'store',
                    operation: 'createEntityWithRelations',
                    memoryId: id,
                    memoryType: memory.type,
                    relationCount: memory.relations?.length || 0,
                    errorType: errorInfo.type,
                    cause: error,
                });
            }
            logger.info(`[UnifiedMemoryStore] Stored memory: ${actualId} (type: ${memory.type})`);
            return actualId;
        }
        catch (error) {
            if (error instanceof ValidationError || error instanceof OperationError) {
                throw error;
            }
            logger.error(`[UnifiedMemoryStore] Unexpected error in store: ${error}`);
            throw new OperationError(`Unexpected error storing memory: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'store',
                memoryType: memory.type,
                cause: error,
            });
        }
    }
    async get(id) {
        try {
            if (!id || id.trim() === '') {
                throw new ValidationError('Memory ID cannot be empty', {
                    component: 'UnifiedMemoryStore',
                    method: 'get',
                });
            }
            const entity = this.knowledgeGraph.getEntity(id);
            if (!entity) {
                return null;
            }
            return this.entityToMemory(entity);
        }
        catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            logger.error(`[UnifiedMemoryStore] Error retrieving memory: ${error}`);
            throw new OperationError(`Failed to get memory: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'get',
                memoryId: id,
                cause: error,
            });
        }
    }
    async search(query, options) {
        try {
            let finalLimit = options?.limit ?? 50;
            if (finalLimit <= 0) {
                finalLimit = 50;
            }
            if (finalLimit > 1000) {
                logger.warn(`[UnifiedMemoryStore] Limit ${finalLimit} exceeds maximum 1000, capping to 1000`);
                finalLimit = 1000;
            }
            const candidateOptions = {
                ...options,
                limit: Math.min(finalLimit * 10, 1000),
            };
            const baseResults = await this.traditionalSearch(query, candidateOptions);
            return this.searchEngine.processSearchResults(query, baseResults, options, finalLimit);
        }
        catch (error) {
            logger.error(`[UnifiedMemoryStore] Search failed: ${error}`);
            throw new OperationError(`Memory search failed: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'search',
                query,
                options,
                cause: error,
            });
        }
    }
    async traditionalSearch(query, options) {
        try {
            const searchQuery = {};
            if (options?.types && options.types.length === 1) {
                searchQuery.entityType = MEMORY_TYPE_MAPPING[options.types[0]];
            }
            if (options?.tags && options.tags.length === 1) {
                searchQuery.tag = options.tags[0];
            }
            if (options?.limit) {
                searchQuery.limit = options.limit;
            }
            let entities;
            try {
                entities = this.knowledgeGraph.searchEntities(searchQuery);
            }
            catch (error) {
                logger.error(`[UnifiedMemoryStore] Entity search failed: ${error}`);
                throw new OperationError(`Entity search failed: ${error instanceof Error ? error.message : String(error)}`, {
                    component: 'UnifiedMemoryStore',
                    method: 'traditionalSearch',
                    searchQuery,
                    cause: error,
                });
            }
            entities = entities.filter((e) => e.name.startsWith(MEMORY_ID_PREFIX));
            if (options?.types && options.types.length > 1) {
                const entityTypes = options.types.map((t) => MEMORY_TYPE_MAPPING[t]);
                entities = entities.filter((e) => entityTypes.includes(e.entityType));
            }
            if (options?.tags && options.tags.length > 1) {
                entities = entities.filter((e) => e.tags && options.tags.some((t) => e.tags.includes(t)));
            }
            let memories = entities.map((e) => this.entityToMemory(e)).filter((m) => m !== null);
            memories = this.searchEngine.filterByQuery(memories, query);
            memories = this.applySearchFilters(memories, options);
            return memories;
        }
        catch (error) {
            if (error instanceof OperationError) {
                throw error;
            }
            logger.error(`[UnifiedMemoryStore] Traditional search failed: ${error}`);
            throw new OperationError(`Traditional search failed: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'traditionalSearch',
                query,
                options,
                cause: error,
            });
        }
    }
    applySearchFilters(memories, options) {
        return this.searchEngine.applySearchFilters(memories, options);
    }
    deduplicateResults(memories) {
        return this.searchEngine.deduplicateResults(memories);
    }
    async searchByType(type, options) {
        return this.search('', { ...options, types: [type] });
    }
    async searchByTags(tags, options) {
        return this.search('', { ...options, tags });
    }
    async update(id, updates) {
        try {
            if (!id || id.trim() === '') {
                throw new ValidationError('Memory ID cannot be empty', {
                    component: 'UnifiedMemoryStore',
                    method: 'update',
                });
            }
            if (!updates || Object.keys(updates).length === 0) {
                throw new ValidationError('Updates cannot be empty', {
                    component: 'UnifiedMemoryStore',
                    method: 'update',
                    memoryId: id,
                });
            }
            const existing = await this.get(id);
            if (!existing) {
                return false;
            }
            const updatedMemory = {
                ...existing,
                ...updates,
                id,
                timestamp: existing.timestamp,
            };
            const deleted = this.knowledgeGraph.deleteEntity(id);
            if (!deleted) {
                logger.warn(`[UnifiedMemoryStore] Entity ${id} was concurrently deleted during update, treating as not found`);
                return false;
            }
            await this.store(updatedMemory);
            logger.info(`[UnifiedMemoryStore] Updated memory: ${id}`);
            return true;
        }
        catch (error) {
            if (error instanceof ValidationError || error instanceof OperationError) {
                throw error;
            }
            logger.error(`[UnifiedMemoryStore] Update failed: ${error}`);
            throw new OperationError(`Failed to update memory: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'update',
                memoryId: id,
                cause: error,
            });
        }
    }
    async delete(id) {
        try {
            if (!id || id.trim() === '') {
                throw new ValidationError('Memory ID cannot be empty', {
                    component: 'UnifiedMemoryStore',
                    method: 'delete',
                });
            }
            const deleted = this.knowledgeGraph.deleteEntity(id);
            if (deleted) {
                logger.info(`[UnifiedMemoryStore] Deleted memory: ${id}`);
            }
            return deleted;
        }
        catch (error) {
            if (error instanceof ValidationError) {
                throw error;
            }
            logger.error(`[UnifiedMemoryStore] Delete failed: ${error}`);
            throw new OperationError(`Failed to delete memory: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'delete',
                memoryId: id,
                cause: error,
            });
        }
    }
    async close() {
        try {
            await this.knowledgeGraph.close();
            logger.info('[UnifiedMemoryStore] Database connection closed');
        }
        catch (error) {
            logger.error(`[UnifiedMemoryStore] Error closing database: ${error}`);
            throw new OperationError(`Failed to close memory store: ${error instanceof Error ? error.message : String(error)}`, {
                component: 'UnifiedMemoryStore',
                method: 'close',
                cause: error,
            });
        }
    }
    entityToMemory(entity) {
        let content = '';
        let context;
        let importance = 0.5;
        let timestamp = entity.createdAt || new Date();
        let metadata;
        for (const obs of entity.observations) {
            if (obs.startsWith('content: ')) {
                content = obs.substring('content: '.length);
            }
            else if (obs.startsWith('context: ')) {
                context = obs.substring('context: '.length);
            }
            else if (obs.startsWith('importance: ')) {
                importance = parseFloat(obs.substring('importance: '.length)) || 0.5;
            }
            else if (obs.startsWith('timestamp: ')) {
                const parsedTimestamp = new Date(obs.substring('timestamp: '.length));
                if (!isNaN(parsedTimestamp.getTime())) {
                    timestamp = parsedTimestamp;
                }
                else {
                    timestamp = entity.createdAt || new Date();
                    logger.warn(`[UnifiedMemoryStore] Invalid timestamp in entity ${entity.name}, using fallback: ${timestamp.toISOString()}`);
                }
            }
            else if (obs.startsWith('metadata: ')) {
                try {
                    const metadataStr = obs.substring('metadata: '.length);
                    const sizeInBytes = Buffer.byteLength(metadataStr, 'utf8');
                    if (sizeInBytes > MAX_METADATA_SIZE) {
                        logger.warn(`Metadata too large on retrieval: ${sizeInBytes} bytes (max: ${MAX_METADATA_SIZE})`);
                        continue;
                    }
                    metadata = JSON.parse(metadataStr);
                }
                catch (parseError) {
                    logger.warn(`[UnifiedMemoryStore] Failed to parse metadata for entity ${entity.name}`, {
                        error: parseError instanceof Error ? parseError.message : String(parseError),
                        entityName: entity.name,
                    });
                }
            }
        }
        if (entity.metadata?.importance !== undefined) {
            importance = entity.metadata.importance;
        }
        const memoryType = ENTITY_TYPE_MAPPING[entity.entityType] || 'knowledge';
        let validatedTags = [];
        if (Array.isArray(entity.tags)) {
            validatedTags = entity.tags.filter((tag) => typeof tag === 'string');
        }
        else if (entity.tags !== undefined && entity.tags !== null) {
            logger.warn(`[UnifiedMemoryStore] Invalid tags type for entity ${entity.name}: ${typeof entity.tags}`);
        }
        return {
            id: entity.name,
            type: memoryType,
            content,
            context,
            tags: validatedTags,
            importance,
            timestamp,
            metadata,
        };
    }
}
//# sourceMappingURL=UnifiedMemoryStore.js.map