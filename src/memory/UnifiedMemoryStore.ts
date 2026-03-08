/**
 * UnifiedMemoryStore
 *
 * The foundation for Phase 0.7.0 memory system upgrade.
 *
 * This fixes the FATAL FLAW where:
 * - buddy-record-mistake stores to FeedbackCollector
 * - buddy-remember searches KnowledgeGraph
 * - They don't communicate!
 *
 * UnifiedMemoryStore provides a single storage layer using KnowledgeGraph
 * for ALL memory types, ensuring consistent storage and retrieval.
 */

import { KnowledgeGraph } from '../knowledge-graph/index.js';
import type { Entity, EntityType } from '../knowledge-graph/types.js';
import type {
  UnifiedMemory,
  MemoryType,
  SearchOptions,
} from './types/unified-memory.js';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { ValidationError, OperationError } from '../errors/index.js';
import { AutoTagger } from './AutoTagger.js';
import { MemorySearchEngine } from './MemorySearchEngine.js';

/**
 * Extract error message safely from unknown error type
 *
 * @param error - Unknown error object
 * @returns Error message string and type information
 */
function extractErrorInfo(error: unknown): { message: string; type: string } {
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

/**
 * Mapping from MemoryType to KnowledgeGraph EntityType
 */
const MEMORY_TYPE_MAPPING: Record<MemoryType, EntityType> = {
  mistake: 'lesson_learned',
  conversation: 'session_snapshot',
  knowledge: 'best_practice',
  decision: 'decision',
  experience: 'learning_experience',
  'prevention-rule': 'prevention_rule',
  'user-preference': 'user_preference',
};

/**
 * Reverse mapping from EntityType to MemoryType
 */
const ENTITY_TYPE_MAPPING: Record<string, MemoryType> = {
  lesson_learned: 'mistake',
  session_snapshot: 'conversation',
  best_practice: 'knowledge',
  decision: 'decision',
  learning_experience: 'experience',
  prevention_rule: 'prevention-rule',
  user_preference: 'user-preference',
};

/**
 * Prefix for unified memory entities to avoid collisions
 */
const MEMORY_ID_PREFIX = 'unified-memory-';

/**
 * Maximum metadata size in bytes (1MB)
 */
const MAX_METADATA_SIZE = 1024 * 1024;

/**
 * UnifiedMemoryStore - Single storage layer for all memory types
 *
 * Uses KnowledgeGraph as the underlying storage, ensuring all memory
 * operations (store, search, update, delete) work through a single
 * consistent interface.
 */
export class UnifiedMemoryStore {
  private readonly searchEngine: MemorySearchEngine;

  constructor(private knowledgeGraph: KnowledgeGraph) {
    // AutoTagger generates tags, MemorySearchEngine handles filtering/ranking/dedup
    this.searchEngine = new MemorySearchEngine();
  }

  /**
   * Create a new UnifiedMemoryStore instance (async factory method)
   *
   * @param dbPath - Optional database path for the underlying KnowledgeGraph
   * @returns Promise<UnifiedMemoryStore> Initialized memory store instance
   * @throws {OperationError} If initialization fails
   *
   * @example
   * ```typescript
   * // Create with default path
   * const store = await UnifiedMemoryStore.create();
   *
   * // Create with custom path
   * const customStore = await UnifiedMemoryStore.create('/tmp/memory.db');
   * ```
   */
  static async create(dbPath?: string): Promise<UnifiedMemoryStore> {
    try {
      // Initialize KnowledgeGraph with provided path or use default
      const knowledgeGraph = await KnowledgeGraph.create(dbPath);

      // Create and return UnifiedMemoryStore instance
      const instance = new UnifiedMemoryStore(knowledgeGraph);

      logger.info(`[UnifiedMemoryStore] Initialized with database at: ${dbPath || 'default'}`);
      return instance;
    } catch (error: unknown) {
      const errorInfo = extractErrorInfo(error);
      logger.error(
        `[UnifiedMemoryStore] Initialization failed: ${errorInfo.message} (type: ${errorInfo.type})`
      );
      throw new OperationError(`Failed to create UnifiedMemoryStore: ${errorInfo.message}`, {
        component: 'UnifiedMemoryStore',
        method: 'create',
        dbPath,
        errorType: errorInfo.type,
        cause: error,
      });
    }
  }

  /**
   * Store a memory entry
   *
   * @param memory - The memory to store
   * @param context - Optional context for auto-tagging (projectPath, techStack)
   * @returns The unique ID of the stored memory
   * @throws {ValidationError} If memory type is invalid or content is missing
   * @throws {OperationError} If entity creation or relation creation fails
   */
  async store(
    memory: UnifiedMemory,
    context?: { projectPath?: string; techStack?: string[] }
  ): Promise<string> {
    try {
      // Validate input
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

      // Validate importance (CRITICAL: prevents NaN, Infinity, negative values)
      if (memory.importance !== undefined) {
        if (!Number.isFinite(memory.importance)) {
          throw new ValidationError(
            `Importance must be a finite number, got ${memory.importance}`,
            {
              component: 'UnifiedMemoryStore',
              method: 'store',
              data: { importance: memory.importance, type: typeof memory.importance },
            }
          );
        }
        if (memory.importance < 0 || memory.importance > 1) {
          throw new ValidationError(
            `Importance must be between 0 and 1, got ${memory.importance}`,
            {
              component: 'UnifiedMemoryStore',
              method: 'store',
              data: { importance: memory.importance },
            }
          );
        }
      }

      // Validate and generate memory ID
      let id: string;
      if (memory.id !== undefined) {
        // External ID provided - validate (including empty string check)
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
      } else {
        // Auto-generate ID
        id = `${MEMORY_ID_PREFIX}${uuidv4()}`;
      }

      // CRITICAL-1: Calculate content hash for database-level deduplication
      // Database UNIQUE constraint on content_hash provides atomic deduplication
      const contentHash = createHash('sha256').update(memory.content).digest('hex');

      // Ensure timestamp is provided (default to now if missing)
      const timestamp = memory.timestamp || new Date();

      // Generate tags: combine user-provided + auto-generated
      const autoTagger = new AutoTagger();
      const tagsToUse = autoTagger.generateTags(memory.content, memory.tags, context);

      if (context) {
        logger.info(`[UnifiedMemoryStore] Storing memory with tags: ${tagsToUse.join(', ')}`);
      }

      // Map memory type to entity type
      const entityType = MEMORY_TYPE_MAPPING[memory.type];
      if (!entityType) {
        throw new ValidationError(`Invalid memory type: ${memory.type}`, {
          component: 'UnifiedMemoryStore',
          method: 'store',
          memoryType: memory.type,
          validTypes: Object.keys(MEMORY_TYPE_MAPPING),
        });
      }

      // ✅ FIX MAJOR-4: Default importance to 0.5 if undefined before building observations
      // This prevents "importance: undefined" from being stored as a string observation
      const normalizedImportance = memory.importance ?? 0.5;

      // Build observations array with structured data
      const observations: string[] = [
        `content: ${memory.content}`,
        `importance: ${normalizedImportance}`,
        `timestamp: ${timestamp.toISOString()}`,
      ];

      if (memory.context) {
        observations.push(`context: ${memory.context}`);
      }

      // Store metadata as observation with size validation
      if (memory.metadata) {
        try {
          const metadataJson = JSON.stringify(memory.metadata);

          // Validate metadata size (1MB limit)
          // Use Buffer for accurate byte size (Node.js compatible, works in all versions)
          const sizeInBytes = Buffer.byteLength(metadataJson, 'utf8');

          if (sizeInBytes >= MAX_METADATA_SIZE) {
            throw new ValidationError(
              `Metadata size exceeds limit: ${(sizeInBytes / 1024).toFixed(2)}KB / ${(MAX_METADATA_SIZE / 1024).toFixed(2)}KB`,
              {
                component: 'UnifiedMemoryStore',
                method: 'store',
                data: {
                  metadataSize: sizeInBytes,
                  limit: MAX_METADATA_SIZE,
                  sizeMB: (sizeInBytes / (1024 * 1024)).toFixed(2),
                },
              }
            );
          }

          observations.push(`metadata: ${metadataJson}`);
        } catch (error) {
          // Re-throw ValidationError
          if (error instanceof ValidationError) {
            throw error;
          }
          logger.warn(`[UnifiedMemoryStore] Failed to serialize metadata: ${error}`);
        }
      }

      // Create entity in KnowledgeGraph
      // CRITICAL-1: Include contentHash for deduplication
      const entity: Entity = {
        name: id,
        entityType,
        observations,
        tags: tagsToUse,
        contentHash,  // CRITICAL-1: Pass content hash for atomic deduplication
        metadata: {
          memoryType: memory.type,
          importance: normalizedImportance,  // ✅ FIX MAJOR-4: Use normalized importance
          timestamp: timestamp.toISOString(),
          ...(memory.metadata || {}),
        },
      };

      // Create entity and relations atomically within a transaction
      // This ensures data consistency: either all succeed or all fail together
      // CRITICAL-1: actualId may differ from id if deduplication occurred
      let actualId: string = id;  // Initialize to id, will be updated if deduplicated
      try {
        this.knowledgeGraph.transaction(() => {
          // Step 1: Create entity (returns actual name, may be existing if deduplicated)
          actualId = this.knowledgeGraph.createEntity(entity);

          // CRITICAL-1: Log if deduplication occurred
          if (actualId !== id) {
            logger.info(
              `[UnifiedMemoryStore] Deduplicated: generated id ${id}, using existing ${actualId}`
            );
          }

          // Step 2: Create all relations (if any)
          // CRITICAL-4: Collect all failures and throw at end to prevent partial success
          if (memory.relations && memory.relations.length > 0) {
            const relationFailures: Array<{ relatedId: string; error: string }> = [];

            for (const relatedId of memory.relations) {
              // Check if target entity exists before creating relation
              const targetEntity = this.knowledgeGraph.getEntity(relatedId);
              if (!targetEntity) {
                relationFailures.push({
                  relatedId,
                  error: 'Target entity does not exist',
                });
                logger.warn(
                  `[UnifiedMemoryStore] Cannot create relation to non-existent entity: ${relatedId}`
                );
                continue;
              }

              try {
                this.knowledgeGraph.createRelation({
                  from: actualId,  // CRITICAL-1: Use actualId (may be deduplicated)
                  to: relatedId,
                  relationType: 'depends_on',
                  metadata: { createdAt: new Date().toISOString() },
                });
              } catch (error: unknown) {
                const errorInfo = extractErrorInfo(error);
                relationFailures.push({
                  relatedId,
                  error: errorInfo.message,
                });
                logger.error(
                  `[UnifiedMemoryStore] Failed to create relation to ${relatedId}: ${errorInfo.message}`
                );
              }
            }

            // If any relations failed, throw to rollback entire transaction
            // This ensures atomicity: all succeed or all fail together
            if (relationFailures.length > 0) {
              throw new Error(
                `Failed to create ${relationFailures.length} relation(s): ` +
                relationFailures.map(f => `${f.relatedId} (${f.error})`).join(', ')
              );
            }
          }

          // Transaction succeeds - all operations committed together
        });
      } catch (error: unknown) {
        // Transaction failed - all operations rolled back automatically
        const errorInfo = extractErrorInfo(error);
        logger.error(
          `[UnifiedMemoryStore] Failed to create memory (transaction rolled back): ${errorInfo.message} (type: ${errorInfo.type})`
        );
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
      return actualId;  // CRITICAL-1: Return actual ID (may be deduplicated)
    } catch (error) {
      // Re-throw custom errors as-is
      if (error instanceof ValidationError || error instanceof OperationError) {
        throw error;
      }

      // Wrap unexpected errors
      logger.error(`[UnifiedMemoryStore] Unexpected error in store: ${error}`);
      throw new OperationError(
        `Unexpected error storing memory: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'store',
          memoryType: memory.type,
          cause: error,
        }
      );
    }
  }

  /**
   * Get a memory by ID
   *
   * @param id - The memory ID
   * @returns The memory or null if not found
   * @throws {ValidationError} If id is invalid
   * @throws {OperationError} If entity retrieval fails
   */
  async get(id: string): Promise<UnifiedMemory | null> {
    try {
      // Validate input
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
    } catch (error) {
      // Re-throw custom errors as-is
      if (error instanceof ValidationError) {
        throw error;
      }

      // Wrap unexpected errors
      logger.error(`[UnifiedMemoryStore] Error retrieving memory: ${error}`);
      throw new OperationError(
        `Failed to get memory: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'get',
          memoryId: id,
          cause: error,
        }
      );
    }
  }

  /**
   * Search memories by query string
   *
   * Uses SmartMemoryQuery for intelligent multi-level search when context is provided.
   * Falls back to traditional search when no context is available.
   *
   * @param query - The search query
   * @param options - Search options (can include projectPath and techStack for smart search)
   * @returns Array of matching memories
   * @throws {OperationError} If search operation fails
   */
  async search(
    query: string,
    options?: SearchOptions & { projectPath?: string; techStack?: string[] }
  ): Promise<UnifiedMemory[]> {
    try {
      // Normalize and validate limit
      let finalLimit = options?.limit ?? 50; // DEFAULT_SEARCH_LIMIT
      if (finalLimit <= 0) {
        finalLimit = 50;
      }
      if (finalLimit > 1000) {
        // MAX_SEARCH_LIMIT
        logger.warn(
          `[UnifiedMemoryStore] Limit ${finalLimit} exceeds maximum 1000, capping to 1000`
        );
        finalLimit = 1000;
      }

      // Create modified options with "soft limit" for fetching candidates
      // Fetch 10x the final limit to ensure we have enough candidates for ranking
      const candidateOptions = {
        ...options,
        limit: Math.min(finalLimit * 10, 1000),
      };

      // Step 1: Use KnowledgeGraph search (FTS5 full-text + LIKE fallback) to get base results
      // Using soft limit to get more candidates for better ranking
      const baseResults = await this.traditionalSearch(query, candidateOptions);

      // Step 2-4: Delegate deduplication, ranking, and limiting to MemorySearchEngine
      return this.searchEngine.processSearchResults(query, baseResults, options, finalLimit);
    } catch (error) {
      logger.error(`[UnifiedMemoryStore] Search failed: ${error}`);
      throw new OperationError(
        `Memory search failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'search',
          query,
          options,
          cause: error,
        }
      );
    }
  }

  /**
   * Traditional search implementation (for backward compatibility)
   *
   * @param query - The search query
   * @param options - Search options
   * @returns Array of matching memories
   * @throws {OperationError} If entity search fails
   */
  private async traditionalSearch(query: string, options?: SearchOptions): Promise<UnifiedMemory[]> {
    try {
      // Get all entities that match the criteria
      const searchQuery: { entityType?: EntityType; tag?: string; namePattern?: string; limit?: number } = {};

      // Apply type filter if single type specified
      if (options?.types && options.types.length === 1) {
        searchQuery.entityType = MEMORY_TYPE_MAPPING[options.types[0]];
      }

      // Apply tag filter if single tag specified
      if (options?.tags && options.tags.length === 1) {
        searchQuery.tag = options.tags[0];
      }

      // Apply limit
      if (options?.limit) {
        searchQuery.limit = options.limit;
      }

      // Get entities with error handling
      let entities: Entity[];
      try {
        entities = this.knowledgeGraph.searchEntities(searchQuery);
      } catch (error) {
        logger.error(`[UnifiedMemoryStore] Entity search failed: ${error}`);
        throw new OperationError(
          `Entity search failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            component: 'UnifiedMemoryStore',
            method: 'traditionalSearch',
            searchQuery,
            cause: error,
          }
        );
      }

      // Filter by memory prefix (only get unified memories)
      entities = entities.filter((e) => e.name.startsWith(MEMORY_ID_PREFIX));

      // Filter by multiple types if specified
      if (options?.types && options.types.length > 1) {
        const entityTypes = options.types.map((t) => MEMORY_TYPE_MAPPING[t]);
        entities = entities.filter((e) => entityTypes.includes(e.entityType));
      }

      // Filter by multiple tags if specified (OR logic)
      if (options?.tags && options.tags.length > 1) {
        entities = entities.filter((e) => e.tags && options.tags!.some((t) => e.tags!.includes(t)));
      }

      // Convert to memories
      let memories = entities.map((e) => this.entityToMemory(e)).filter((m): m is UnifiedMemory => m !== null);

      // Apply query filter (search in content) - delegated to MemorySearchEngine
      memories = this.searchEngine.filterByQuery(memories, query);

      // Apply filters
      memories = this.applySearchFilters(memories, options);

      return memories;
    } catch (error) {
      // Re-throw OperationError as-is
      if (error instanceof OperationError) {
        throw error;
      }

      // Wrap unexpected errors
      logger.error(`[UnifiedMemoryStore] Traditional search failed: ${error}`);
      throw new OperationError(
        `Traditional search failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'traditionalSearch',
          query,
          options,
          cause: error,
        }
      );
    }
  }

  /**
   * Apply common search filters (time range, importance, limit)
   *
   * Delegates to MemorySearchEngine.
   *
   * @param memories - Memories to filter
   * @param options - Search options
   * @returns Filtered memories
   */
  private applySearchFilters(memories: UnifiedMemory[], options?: SearchOptions): UnifiedMemory[] {
    return this.searchEngine.applySearchFilters(memories, options);
  }

  /**
   * Deduplicate memory search results by content
   *
   * Delegates to MemorySearchEngine.
   *
   * @param memories - Array of memories that may contain duplicates
   * @returns Deduplicated array preserving the best entry per unique content
   */
  private deduplicateResults(memories: UnifiedMemory[]): UnifiedMemory[] {
    return this.searchEngine.deduplicateResults(memories);
  }

  /**
   * Search memories by type
   *
   * Retrieves all memories of a specific type. Useful for getting all mistakes,
   * decisions, knowledge entries, or conversation snapshots.
   *
   * @param type - The memory type to filter by ('mistake' | 'conversation' | 'knowledge' | 'decision')
   * @param options - Additional search options
   * @param options.limit - Maximum number of results (default: 50)
   * @param options.minImportance - Minimum importance score (0-1)
   * @param options.tags - Additional tag filters
   * @param options.timeRange - Filter by time range ('last-24h', 'last-7-days', 'last-30-days', 'all')
   * @returns Promise<UnifiedMemory[]> Array of memories of the specified type
   *
   * @example
   * ```typescript
   * // Get all recorded mistakes
   * const mistakes = await store.searchByType('mistake');
   *
   * // Get recent important decisions
   * const decisions = await store.searchByType('decision', {
   *   minImportance: 0.7,
   *   timeRange: 'last-7-days'
   * });
   *
   * // Get knowledge entries with specific tags
   * const apiKnowledge = await store.searchByType('knowledge', {
   *   tags: ['api', 'rest']
   * });
   * ```
   */
  async searchByType(type: MemoryType, options?: SearchOptions): Promise<UnifiedMemory[]> {
    return this.search('', { ...options, types: [type] });
  }

  /**
   * Search memories by tags using OR logic
   *
   * Returns memories that match ANY of the provided tags. This is useful for
   * finding related memories across different categories or topics.
   *
   * @param tags - Array of tags to filter by (OR logic - matches any tag)
   * @param options - Additional search options
   * @param options.limit - Maximum number of results (default: 50)
   * @param options.minImportance - Minimum importance score (0-1)
   * @param options.types - Filter by memory types
   * @param options.timeRange - Filter by time range ('last-24h', 'last-7-days', 'last-30-days', 'all')
   * @returns Promise<UnifiedMemory[]> Array of matching memories, sorted by importance
   *
   * @example
   * ```typescript
   * // Find memories tagged with either 'security' or 'api'
   * const memories = await store.searchByTags(['security', 'api']);
   *
   * // With options - find important critical memories
   * const important = await store.searchByTags(['critical'], {
   *   minImportance: 0.8,
   *   limit: 10
   * });
   *
   * // Filter by type and tags
   * const mistakes = await store.searchByTags(['production', 'bug'], {
   *   types: ['mistake']
   * });
   * ```
   */
  async searchByTags(tags: string[], options?: SearchOptions): Promise<UnifiedMemory[]> {
    return this.search('', { ...options, tags });
  }

  /**
   * Update a memory
   *
   * @param id - The memory ID
   * @param updates - Partial updates to apply
   * @returns true if updated, false if not found
   * @throws {ValidationError} If id or updates are invalid
   * @throws {OperationError} If update operation fails
   */
  async update(id: string, updates: Partial<UnifiedMemory>): Promise<boolean> {
    try {
      // Validate input
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

      // Merge updates with existing memory
      const updatedMemory: UnifiedMemory = {
        ...existing,
        ...updates,
        id, // Preserve ID
        timestamp: existing.timestamp, // Preserve original timestamp
      };

      // ✅ FIX MAJOR-3: Delete the old entity before re-storing to avoid dedup conflicts
      // The store() method has deduplication logic (based on content hash) that can
      // conflict with update semantics. By deleting first, we ensure the re-store
      // creates a clean entry without triggering deduplication against the old entry.
      // This is safe because we already have the existing data merged into updatedMemory.
      const deleted = this.knowledgeGraph.deleteEntity(id);
      if (!deleted) {
        // Entity was concurrently deleted between get() and deleteEntity()
        // Return false to honor the update contract — caller expects
        // true (updated) or false (not found), not silent re-creation
        logger.warn(
          `[UnifiedMemoryStore] Entity ${id} was concurrently deleted during update, treating as not found`
        );
        return false;
      }

      // Re-store with same ID (now creates a new entry since old was deleted)
      await this.store(updatedMemory);

      logger.info(`[UnifiedMemoryStore] Updated memory: ${id}`);
      return true;
    } catch (error) {
      // Re-throw custom errors as-is
      if (error instanceof ValidationError || error instanceof OperationError) {
        throw error;
      }

      // Wrap unexpected errors
      logger.error(`[UnifiedMemoryStore] Update failed: ${error}`);
      throw new OperationError(
        `Failed to update memory: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'update',
          memoryId: id,
          cause: error,
        }
      );
    }
  }

  /**
   * Delete a memory
   *
   * @param id - The memory ID
   * @returns true if deleted, false if not found
   * @throws {ValidationError} If id is invalid
   * @throws {OperationError} If deletion fails
   */
  async delete(id: string): Promise<boolean> {
    try {
      // Validate input
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
    } catch (error) {
      // Re-throw custom errors as-is
      if (error instanceof ValidationError) {
        throw error;
      }

      // Wrap unexpected errors
      logger.error(`[UnifiedMemoryStore] Delete failed: ${error}`);
      throw new OperationError(
        `Failed to delete memory: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'delete',
          memoryId: id,
          cause: error,
        }
      );
    }
  }

  // Methods autoTagMemory() and detectProjectTechStack() removed.
  // Tag generation and tech stack detection delegated to Claude via MCP tool descriptions.

  /**
   * Close the database connection and cleanup resources
   *
   * Must be called to properly shut down the memory store and release
   * all database connections.
   *
   * @throws {OperationError} If shutdown fails
   *
   * @example
   * ```typescript
   * const store = await UnifiedMemoryStore.create();
   * // ... use the store ...
   * await store.close(); // Cleanup when done
   * ```
   */
  async close(): Promise<void> {
    try {
      await this.knowledgeGraph.close();
      logger.info('[UnifiedMemoryStore] Database connection closed');
    } catch (error) {
      logger.error(`[UnifiedMemoryStore] Error closing database: ${error}`);
      throw new OperationError(
        `Failed to close memory store: ${error instanceof Error ? error.message : String(error)}`,
        {
          component: 'UnifiedMemoryStore',
          method: 'close',
          cause: error,
        }
      );
    }
  }

  /**
   * Convert a KnowledgeGraph Entity to UnifiedMemory
   */
  private entityToMemory(entity: Entity): UnifiedMemory | null {
    // Parse content from observations
    let content = '';
    let context: string | undefined;
    let importance = 0.5;
    let timestamp = entity.createdAt || new Date();
    let metadata: Record<string, unknown> | undefined;

    for (const obs of entity.observations) {
      if (obs.startsWith('content: ')) {
        content = obs.substring('content: '.length);
      } else if (obs.startsWith('context: ')) {
        context = obs.substring('context: '.length);
      } else if (obs.startsWith('importance: ')) {
        importance = parseFloat(obs.substring('importance: '.length)) || 0.5;
      } else if (obs.startsWith('timestamp: ')) {
        // ✅ FIX MINOR-4: Validate parsed Date to handle invalid timestamp strings
        const parsedTimestamp = new Date(obs.substring('timestamp: '.length));
        if (!isNaN(parsedTimestamp.getTime())) {
          timestamp = parsedTimestamp;
        } else {
          // Invalid timestamp string - fall back to entity.createdAt or current time
          timestamp = entity.createdAt || new Date();
          logger.warn(
            `[UnifiedMemoryStore] Invalid timestamp in entity ${entity.name}, using fallback: ${timestamp.toISOString()}`
          );
        }
      } else if (obs.startsWith('metadata: ')) {
        try {
          const metadataStr = obs.substring('metadata: '.length);

          // Validate size before parsing to prevent DoS attacks (max 1MB)
          const sizeInBytes = Buffer.byteLength(metadataStr, 'utf8');
          if (sizeInBytes > MAX_METADATA_SIZE) {
            logger.warn(
              `Metadata too large on retrieval: ${sizeInBytes} bytes (max: ${MAX_METADATA_SIZE})`
            );
            // Skip parsing oversized metadata
            continue;
          }

          metadata = JSON.parse(metadataStr);
        } catch (parseError) {
          logger.warn(`[UnifiedMemoryStore] Failed to parse metadata for entity ${entity.name}`, {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            entityName: entity.name,
          });
        }
      }
    }

    // Get importance from metadata if available
    if (entity.metadata?.importance !== undefined) {
      importance = entity.metadata.importance as number;
    }

    // Get memory type from entity type
    const memoryType = ENTITY_TYPE_MAPPING[entity.entityType] || 'knowledge';

    // Validate tags is an array (defense against data corruption)
    let validatedTags: string[] = [];
    if (Array.isArray(entity.tags)) {
      // Filter out non-string tags for extra safety
      validatedTags = entity.tags.filter((tag): tag is string => typeof tag === 'string');
    } else if (entity.tags !== undefined && entity.tags !== null) {
      // Log warning if tags is not an array (potential data corruption)
      logger.warn(
        `[UnifiedMemoryStore] Invalid tags type for entity ${entity.name}: ${typeof entity.tags}`
      );
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
