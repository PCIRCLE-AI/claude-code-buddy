/**
 * Knowledge Graph - SQLite-based implementation
 *
 * Lightweight, standalone knowledge graph with no external dependencies
 * Perfect for personal AI assistants and code intelligence
 */

import Database from 'better-sqlite3';
import { promises as fsPromises, existsSync, mkdirSync } from 'fs';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { SimpleDatabaseFactory } from '../config/simple-config.js';
import type { Entity, Relation, SearchQuery, RelationTrace, EntityType, RelationType } from './types.js';
import { logger } from '../utils/logger.js';
import { QueryCache } from '../db/QueryCache.js';
import { safeJsonParse, safeJsonStringify } from '../utils/json.js';
import { getDataPath, getDataDirectory } from '../utils/PathResolver.js';
import { validateNonEmptyString } from '../utils/validation.js';
import { KGSearchEngine } from './KGSearchEngine.js';
import type { SemanticSearchResult } from './KGSearchEngine.js';
import { ContentHasher } from './ContentHasher.js';

// Re-export for backward compatibility
export type { SemanticSearchResult } from './KGSearchEngine.js';

/**
 * Maximum allowed length for entity names.
 * Prevents excessively long names that could degrade search/index performance.
 */
const MAX_ENTITY_NAME_LENGTH = 512;

/**
 * Regex pattern for valid relation types.
 * Allows alphanumeric characters, underscores, and hyphens.
 * Must start with a letter or underscore (no leading hyphens or numbers).
 */
const VALID_RELATION_TYPE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/**
 * Regex to detect control characters (C0 and C1 control codes, excluding
 * common whitespace like \t, \n, \r which may appear in legitimate content).
 * Matches: U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F, U+0080-U+009F
 */
// Import shared constant from KGSearchEngine to avoid duplication
import { CONTROL_CHAR_PATTERN } from './KGSearchEngine.js';

export class KnowledgeGraph {
  private db: Database.Database;
  private queryCache: QueryCache<string, any>;
  /** Whether sqlite-vec extension loaded successfully */
  private vectorEnabled = false;
  /** Vector search adapter instance (loaded once during init) */
  private vectorAdapter: import('../embeddings/VectorSearchAdapter.js').VectorSearchAdapter | null = null;
  /** Promise tracking vector search initialization (resolved when init completes or fails) */
  private vectorInitPromise: Promise<void> | null = null;
  /** Pending embedding generation tasks — tracked for clean shutdown */
  private pendingEmbeddings: Set<Promise<void>> = new Set();
  /** Dedicated search engine (FTS5, semantic, hybrid) */
  private searchEngine: KGSearchEngine;

  /**
   * Private constructor - use KnowledgeGraph.create() instead
   */
  private constructor(_dbPath: string, db: Database.Database) {
    this.db = db;

    // Initialize query cache with 1000 entries, 5 minute TTL
    this.queryCache = new QueryCache({
      maxSize: 1000,
      defaultTTL: 5 * 60 * 1000,
      debug: false,
    });

    // Initialize search engine with context callbacks (avoids circular dependency)
    this.searchEngine = new KGSearchEngine({
      db: this.db,
      getVectorAdapter: () => this.vectorAdapter,
      isVectorEnabled: () => this.vectorEnabled,
      getVectorInitPromise: () => this.vectorInitPromise,
      getEntity: (name: string) => this.getEntity(name),
      queryCache: this.queryCache,
    });
  }

  /**
   * Validate an entity name for safe storage and search.
   *
   * Checks:
   * 1. Non-empty (uses existing validateNonEmptyString utility)
   * 2. Reasonable length (max MAX_ENTITY_NAME_LENGTH characters)
   * 3. No control characters that could cause display/search issues
   *
   * @param name - Entity name to validate
   * @throws {ValidationError} If the name is invalid
   */
  private validateEntityName(name: string): void {
    validateNonEmptyString(name, 'Entity name');

    if (name.length > MAX_ENTITY_NAME_LENGTH) {
      throw new ValidationError(
        `Entity name exceeds maximum length of ${MAX_ENTITY_NAME_LENGTH} characters (got ${name.length})`,
        {
          component: 'KnowledgeGraph',
          method: 'validateEntityName',
          nameLength: name.length,
          maxLength: MAX_ENTITY_NAME_LENGTH,
        }
      );
    }

    if (CONTROL_CHAR_PATTERN.test(name)) {
      throw new ValidationError(
        'Entity name must not contain control characters',
        {
          component: 'KnowledgeGraph',
          method: 'validateEntityName',
          // Truncate name to 100 chars to prevent log injection from overly long input
          name: name.slice(0, 100),
        }
      );
    }
  }

  /**
   * Validate a relation type for safe storage and search.
   *
   * Relation types must be alphanumeric with underscores and hyphens,
   * starting with a letter or underscore. This prevents issues with
   * special characters in search queries and ensures consistent naming.
   *
   * @param relationType - Relation type string to validate
   * @throws {ValidationError} If the relation type is invalid
   */
  private validateRelationType(relationType: string): void {
    validateNonEmptyString(relationType, 'Relation type');

    if (!VALID_RELATION_TYPE_PATTERN.test(relationType)) {
      throw new ValidationError(
        `Relation type must contain only alphanumeric characters, underscores, and hyphens, ` +
        `and must start with a letter or underscore. Got: "${relationType}"`,
        {
          component: 'KnowledgeGraph',
          method: 'validateRelationType',
          relationType,
          pattern: VALID_RELATION_TYPE_PATTERN.source,
        }
      );
    }
  }

  /**
   * Create a new KnowledgeGraph instance (async factory method)
   *
   * @param dbPath - Optional database path (defaults to data/knowledge-graph.db)
   * @returns Promise<KnowledgeGraph> Initialized knowledge graph instance
   *
   * @example
   * ```typescript
   * // Create with default path
   * const kg = await KnowledgeGraph.create();
   *
   * // Create with custom path
   * const customKg = await KnowledgeGraph.create('./custom/path/kg.db');
   * ```
   */
  static async create(dbPath?: string): Promise<KnowledgeGraph> {
    // Use PathResolver for automatic fallback to legacy location
    const defaultPath = getDataPath('knowledge-graph.db');
    const resolvedPath = dbPath || defaultPath;

    // Ensure data directory exists (handles both new and legacy paths)
    const dataDir = getDataDirectory();
    try {
      await fsPromises.access(dataDir);
    } catch {
      // Directory doesn't exist, create it
      await fsPromises.mkdir(dataDir, { recursive: true });
    }

    // Get database instance
    const db = SimpleDatabaseFactory.getInstance(resolvedPath);

    // Create instance
    const instance = new KnowledgeGraph(resolvedPath, db);

    // Initialize schema
    instance.initialize();

    logger.info(`[KnowledgeGraph] Initialized at: ${resolvedPath}`);

    return instance;
  }

  /**
   * Create a KnowledgeGraph instance synchronously (legacy compatibility)
   *
   * **Deprecated**: Use `await KnowledgeGraph.create()` instead for async file operations.
   * This method is kept for backward compatibility but uses synchronous directory creation.
   *
   * @param dbPath - Optional database path (defaults to data/knowledge-graph.db)
   * @returns KnowledgeGraph instance
   */
  static createSync(dbPath?: string): KnowledgeGraph {
    // Use PathResolver for automatic fallback to legacy location
    const defaultPath = getDataPath('knowledge-graph.db');
    const resolvedPath = dbPath || defaultPath;

    // Ensure data directory exists (handles both new and legacy paths)
    const dataDir = getDataDirectory();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Get database instance
    const db = SimpleDatabaseFactory.getInstance(resolvedPath);

    // Create instance
    const instance = new KnowledgeGraph(resolvedPath, db);

    // Initialize schema
    instance.initialize();

    logger.info(`[KnowledgeGraph] Initialized at: ${resolvedPath}`);

    return instance;
  }

  private initialize() {

    // Create schema
    // Note: DB column is named `type` for brevity, but maps to TypeScript `entityType`
    // to avoid confusion with reserved keywords and improve type safety
    const schema = `
      -- Entities table
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,  -- Maps to TypeScript 'entityType' field
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSON
      );

      -- Observations table
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );

      -- Relations table
      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_entity_id INTEGER NOT NULL,
        to_entity_id INTEGER NOT NULL,
        relation_type TEXT NOT NULL,
        metadata JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        UNIQUE(from_entity_id, to_entity_id, relation_type)
      );

      -- Tags table
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type_created ON entities(type, created_at);

      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
      CREATE INDEX IF NOT EXISTS idx_observations_entity_created ON observations(entity_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
      CREATE INDEX IF NOT EXISTS idx_relations_from_type ON relations(from_entity_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_relations_to_type ON relations(to_entity_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_relations_created ON relations(created_at);

      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
      CREATE INDEX IF NOT EXISTS idx_tags_entity ON tags(entity_id);
      CREATE INDEX IF NOT EXISTS idx_tags_entity_tag ON tags(entity_id, tag);
    `;

    this.db.exec(schema);

    // Add FTS5 virtual table for full-text search
    // Uses unicode61 tokenizer for proper Unicode handling
    // remove_diacritics=1 for accent-insensitive search
    const fts5Schema = `
      -- FTS5 virtual table for entities full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name,
        observations,
        content='',
        tokenize='unicode61 remove_diacritics 1'
      );
    `;

    this.db.exec(fts5Schema);

    // Embedding hash table for dedup (skip re-embedding unchanged entities)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_hashes (
        entity_name TEXT PRIMARY KEY,
        hash TEXT NOT NULL
      );
    `);

    // Run schema migrations
    this.runMigrations();

    // Load sqlite-vec for vector search asynchronously (optional - degrades to FTS5-only)
    this.initVectorSearch();
  }

  /**
   * Initialize vector search capability.
   * Loads sqlite-vec extension and creates vector table.
   * Fails silently - vector search is an optional enhancement over FTS5.
   * The returned promise is tracked so search methods can await initialization.
   */
  private initVectorSearch(): void {
    this.vectorInitPromise = import('../embeddings/SqliteVecAdapter.js')
      .then(({ SqliteVecAdapter }) => {
        const adapter = new SqliteVecAdapter();
        adapter.loadExtension(this.db);
        adapter.createVectorTable(this.db, 384);
        this.vectorAdapter = adapter;
        this.vectorEnabled = true;
        logger.info('[KG] Vector search enabled (sqlite-vec loaded)');
      })
      .catch((error: unknown) => {
        this.vectorEnabled = false;
        logger.debug('[KG] Vector search unavailable, using FTS5-only search', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Run schema migrations
   *
   * ✅ CRITICAL-1: Add content_hash column for deduplication
   *
   * Migrations are idempotent and safe to run multiple times.
   * Each migration checks if it's needed before applying changes.
   */
  private runMigrations(): void {
    // Migration 1: Add content_hash column to entities table
    // This enables database-level deduplication and prevents TOCTOU race conditions
    try {
      // Check if content_hash column exists
      const tableInfo = this.db.pragma('table_info(entities)') as Array<{ name: string }>;
      const hasContentHash = tableInfo.some(
        (col) => col.name === 'content_hash'
      );

      if (!hasContentHash) {
        logger.info('[KG] Running migration: Adding content_hash column to entities table');

        // Add content_hash column
        this.db.exec(`
          ALTER TABLE entities ADD COLUMN content_hash TEXT;
        `);

        // Create unique index on content_hash
        // This prevents duplicate entities with same content at database level
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_content_hash
          ON entities(content_hash)
          WHERE content_hash IS NOT NULL;
        `);

        logger.info('[KG] Migration complete: content_hash column added with unique index');
      }
    } catch (error) {
      logger.error('[KG] Migration failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Migration 2: Populate FTS5 index from existing entities
    // ✅ CRITICAL-3 FIX: Use chunked migration to handle large datasets
    // ✅ MAJOR-3 FIX: Add SUBSTR limits to prevent GROUP_CONCAT overflow
    try {
      // Check if FTS5 table is empty but entities exist
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as count FROM entities_fts').get() as { count: number }).count;
      const entityCount = (this.db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number }).count;

      if (ftsCount === 0 && entityCount > 0) {
        logger.info('[KG] Running migration: Populating FTS5 index from existing entities');

        // CRITICAL-3 FIX: Process in chunks to avoid memory issues with large datasets
        // MAJOR-3 FIX: Limit observation length to prevent GROUP_CONCAT overflow
        const CHUNK_SIZE = 500;
        const MAX_OBSERVATIONS_PER_ENTITY = 500;
        const MAX_OBSERVATION_LENGTH = 2000; // Characters per observation
        const MAX_TOTAL_LENGTH = 500000; // Total observations text per entity (500KB)

        const insertStmt = this.db.prepare(`
          INSERT INTO entities_fts(rowid, name, observations)
          SELECT
            e.id,
            e.name,
            COALESCE(
              SUBSTR(
                (SELECT GROUP_CONCAT(SUBSTR(content, 1, ?), ' ') FROM (
                  SELECT content FROM observations o
                  WHERE o.entity_id = e.id
                  ORDER BY o.created_at DESC
                  LIMIT ?
                )),
                1,
                ?
              ),
              ''
            )
          FROM entities e
          WHERE e.id > ? AND e.id <= ?
        `);

        // Get min/max IDs for chunking
        const idRange = this.db.prepare(
          'SELECT MIN(id) as minId, MAX(id) as maxId FROM entities'
        ).get() as { minId: number; maxId: number };

        let processedCount = 0;
        for (let startId = idRange.minId - 1; startId < idRange.maxId; startId += CHUNK_SIZE) {
          const endId = startId + CHUNK_SIZE;
          // Parameters: maxObsLength, maxObsCount, maxTotalLength, startId, endId
          const result = insertStmt.run(
            MAX_OBSERVATION_LENGTH,
            MAX_OBSERVATIONS_PER_ENTITY,
            MAX_TOTAL_LENGTH,
            startId,
            endId
          );
          processedCount += result.changes;
        }

        logger.info(`[KG] Migration complete: Populated FTS5 index with ${processedCount} entities`);
      }
    } catch (error) {
      logger.error('[KG] FTS5 population migration failed:', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-fatal: search will fall back to LIKE
    }
  }

  /**
   * Escape special characters in LIKE patterns to prevent SQL injection.
   * Delegates to KGSearchEngine.
   */
  private escapeLikePattern(pattern: string): string {
    return this.searchEngine.escapeLikePattern(pattern);
  }

  /**
   * Search using FTS5 full-text search. Delegates to KGSearchEngine.
   */
  private searchFTS5(query: string, limit: number): number[] {
    return this.searchEngine.searchFTS5(query, limit);
  }

  /**
   * Prepare query string for FTS5 MATCH. Delegates to KGSearchEngine.
   */
  private prepareFTS5Query(query: string): string {
    return this.searchEngine.prepareFTS5Query(query);
  }

  /**
   * Create a new entity in the knowledge graph
   *
   * CRITICAL-1 FIX: Uses content_hash for atomic deduplication
   * ✅ MAJOR-1 FIX: Entire operation wrapped in single transaction for atomicity
   *    (entity CRUD + FTS5 sync are atomic - no race conditions)
   *
   * Returns the actual entity name (may differ from input if deduplicated)
   *
   * @param entity Entity to create
   * @returns Actual entity name (same as input if new, existing name if deduplicated)
   */
  createEntity(entity: Entity, skipEmbedding = false): string {
    // Validate entity name before any database operations
    this.validateEntityName(entity.name);

    try {
      // CRITICAL-1: Check content_hash first for deduplication
      // This prevents most duplicate cases before attempting INSERT
      // IMPORTANT: Only deduplicate if name is DIFFERENT (real duplicate)
      // If name is same, this is an update operation, not a duplicate
      if (entity.contentHash) {
        const existing = this.db
          .prepare('SELECT name FROM entities WHERE content_hash = ?')
          .get(entity.contentHash) as { name: string } | undefined;

        if (existing && existing.name !== entity.name) {
          // Different name + same content = real deduplication
          logger.info(
            `[KG] Deduplicated: content_hash match, using existing entity ${existing.name}`
          );
          return existing.name;
        }
        // If existing.name === entity.name, this is an update (same entity)
        // Continue to INSERT ... ON CONFLICT(name) DO UPDATE
      }

      // ✅ MAJOR-1 FIX: Wrap ENTIRE createEntity operation in a single transaction
      // This ensures entity CRUD + FTS5 sync are atomic, preventing race conditions
      const result = this.db.transaction(() => {
        // CRITICAL-1: INSERT with content_hash to prevent race conditions
        // Database UNIQUE constraint provides atomic deduplication
        const stmt = this.db.prepare(`
          INSERT INTO entities (name, type, metadata, content_hash)
          VALUES (?, ?, json(?), ?)
          ON CONFLICT(name) DO UPDATE SET
            type = excluded.type,
            metadata = excluded.metadata,
            content_hash = excluded.content_hash
        `);

        stmt.run(
          entity.name,
          entity.entityType,
          // CRITICAL-3: Use safeJsonStringify to handle circular references
          safeJsonStringify(entity.metadata || {}, '{}'),
          entity.contentHash || null
        );

        // Get actual entity ID
        const actualEntity = this.db
          .prepare('SELECT id FROM entities WHERE name = ?')
          .get(entity.name) as { id: number };

        const actualId = actualEntity.id;

        // Clear old observations/tags if updating
        this.db.prepare('DELETE FROM observations WHERE entity_id = ?').run(actualId);
        this.db.prepare('DELETE FROM tags WHERE entity_id = ?').run(actualId);

        // Add observations
        if (entity.observations && entity.observations.length > 0) {
          const obsStmt = this.db.prepare(`
            INSERT INTO observations (entity_id, content)
            VALUES (?, ?)
          `);

          for (const obs of entity.observations) {
            obsStmt.run(actualId, obs);
          }
        }

        // Add tags
        if (entity.tags && entity.tags.length > 0) {
          const tagStmt = this.db.prepare(`
            INSERT INTO tags (entity_id, tag)
            VALUES (?, ?)
          `);

          for (const tag of entity.tags) {
            tagStmt.run(actualId, tag);
          }
        }

        // Sync to FTS5 index (within same transaction for atomicity)
        // For contentless FTS5 tables, we need to handle updates specially
        const observationsText = entity.observations ? entity.observations.join(' ') : '';

        // Query existing FTS entry to get old content for proper deletion
        const existingFtsContent = this.db
          .prepare('SELECT name, observations FROM entities_fts WHERE rowid = ?')
          .get(actualId) as { name: string; observations: string } | undefined;

        if (existingFtsContent) {
          // For contentless FTS5, delete requires exact original content
          this.db.prepare(`
            INSERT INTO entities_fts(entities_fts, rowid, name, observations)
            VALUES('delete', ?, ?, ?)
          `).run(actualId, existingFtsContent.name, existingFtsContent.observations);
        }

        // Insert into FTS5 with concatenated observations
        this.db.prepare(`
          INSERT INTO entities_fts(rowid, name, observations)
          VALUES (?, ?, ?)
        `).run(actualId, entity.name, observationsText);

        return entity.name;
      })();

      // Invalidate cache for entity queries
      this.queryCache.invalidatePattern(/^entities:/);

      // Generate embedding asynchronously (fire-and-forget, never blocks entity creation)
      // skipEmbedding=true when called from createEntitiesBatch (batch generates after transaction)
      if (this.vectorEnabled && !skipEmbedding) {
        this.generateEmbeddingAsync(entity.name, entity.observations);
      }

      logger.info(`[KG] Created entity: ${entity.name} (type: ${entity.entityType})`);
      return result;
    } catch (error) {
      // CRITICAL-1: Handle race condition - if UNIQUE constraint on content_hash fails
      // This can happen if two concurrent requests pass the initial check
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed') &&
        error.message.includes('content_hash')
      ) {
        // Query existing entity by content_hash
        const existing = this.db
          .prepare('SELECT name FROM entities WHERE content_hash = ?')
          .get(entity.contentHash) as { name: string } | undefined;

        if (existing) {
          logger.warn(
            `[KG] Race condition detected: content_hash conflict, using existing entity ${existing.name}`
          );
          return existing.name;
        }
      }

      // Re-throw if not a content_hash conflict or couldn't find existing entity
      throw error;
    }
  }

  /**
   * Create multiple entities in a single SQLite transaction.
   *
   * Wraps all entity creations in one transaction for significantly better
   * write performance (1 transaction instead of N). Individual entity failures
   * are caught and reported without aborting the entire batch.
   *
   * @param entities - Array of entities to create
   * @returns Array of results indicating success/failure per entity
   */
  createEntitiesBatch(
    entities: Array<{
      name: string;
      entityType: string;
      observations: string[];
      tags?: string[];
      metadata?: Record<string, unknown>;
      contentHash?: string;
    }>
  ): Array<{ name: string; success: boolean; error?: string }> {
    const results: Array<{ name: string; success: boolean; error?: string }> = [];

    if (entities.length === 0) {
      return results;
    }

    const transaction = this.db.transaction(() => {
      for (const entity of entities) {
        try {
          this.createEntity({
            name: entity.name,
            entityType: entity.entityType as EntityType,
            observations: entity.observations,
            tags: entity.tags,
            metadata: entity.metadata,
            contentHash: entity.contentHash,
          }, true); // skipEmbedding: batch generates after transaction
          results.push({ name: entity.name, success: true });
        } catch (error) {
          results.push({
            name: entity.name,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    transaction();

    // Invalidate cache once after all entities are created (instead of per-entity)
    this.queryCache.invalidatePattern(/^entities:/);
    this.queryCache.invalidatePattern(/^stats:/);

    // Batch-generate embeddings for successfully created entities (after transaction commits)
    if (this.vectorEnabled) {
      this.generateBatchEmbeddingsAsync(entities, results);
    }

    return results;
  }

  /**
   * Create a relation between two entities
   */
  createRelation(relation: Relation): void {
    // Validate entity names and relation type before database operations
    this.validateEntityName(relation.from);
    this.validateEntityName(relation.to);
    this.validateRelationType(relation.relationType);

    const getEntityId = this.db.prepare('SELECT id FROM entities WHERE name = ?');

    const fromEntity = getEntityId.get(relation.from) as { id: number } | undefined;
    const toEntity = getEntityId.get(relation.to) as { id: number } | undefined;

    if (!fromEntity) {
      throw new NotFoundError(
        `Entity not found: ${relation.from}`,
        'entity',
        relation.from,
        { relationContext: 'from entity in relation creation' }
      );
    }
    if (!toEntity) {
      throw new NotFoundError(
        `Entity not found: ${relation.to}`,
        'entity',
        relation.to,
        { relationContext: 'to entity in relation creation' }
      );
    }

    const stmt = this.db.prepare(`
      INSERT INTO relations (from_entity_id, to_entity_id, relation_type, metadata)
      VALUES (?, ?, ?, json(?))
      ON CONFLICT(from_entity_id, to_entity_id, relation_type) DO UPDATE SET
        metadata = excluded.metadata
    `);

    stmt.run(
      fromEntity.id,
      toEntity.id,
      relation.relationType,
      // CRITICAL-3: Use safeJsonStringify to handle circular references
      safeJsonStringify(relation.metadata || {}, '{}')
    );

    // Invalidate cache for relation queries
    this.queryCache.invalidatePattern(/^relations:/);
    this.queryCache.invalidatePattern(/^trace:/);

    logger.info(`[KG] Created relation: ${relation.from} -[${relation.relationType}]-> ${relation.to}`);
  }

  /**
   * Search entities by type, tag, and/or name pattern.
   * Delegates to KGSearchEngine.
   */
  searchEntities(query: SearchQuery): Entity[] {
    return this.searchEngine.searchEntities(query);
  }

  /**
   * Get a specific entity by name
   * @throws {ValidationError} If the name is invalid
   */
  getEntity(name: string): Entity | null {
    // Validate entity name before any database operations
    this.validateEntityName(name);

    // Use exact match lookup instead of fuzzy search to prevent
    // incorrect matches (e.g., "auth" matching "authentication")
    const row = this.db.prepare(`
      SELECT e.*,
        (SELECT json_group_array(content) FROM observations o WHERE o.entity_id = e.id) as observations_json,
        (SELECT json_group_array(tag) FROM tags t WHERE t.entity_id = e.id) as tags_json
      FROM entities e
      WHERE e.name = ?
    `).get(name) as {
      id: number;
      name: string;
      type: string;
      observations_json: string | null;
      tags_json: string | null;
      metadata: string | null;
      created_at: string;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      entityType: row.type as EntityType,
      observations: safeJsonParse<string[]>(row.observations_json, []).filter(value => value),
      tags: safeJsonParse<string[]>(row.tags_json, []).filter(value => value),
      metadata: row.metadata ? safeJsonParse<Record<string, unknown>>(row.metadata, {}) : {},
      createdAt: new Date(row.created_at)
    };
  }

  /**
   * Trace relations from an entity
   * @throws {ValidationError} If the entity name is invalid
   */
  traceRelations(entityName: string, depth: number = 2): RelationTrace | null {
    // Validate entity name before any database operations
    this.validateEntityName(entityName);

    // Generate cache key
    const cacheKey = `trace:${entityName}:${depth}`;

    // Check cache first
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss - execute query
    const getEntityId = this.db.prepare('SELECT id FROM entities WHERE name = ?');
    const entity = getEntityId.get(entityName) as { id: number } | undefined;

    if (!entity) {
      return null;
    }

    const relationRows = this.db.prepare(`
      SELECT
        e1.name as from_name,
        e2.name as to_name,
        r.relation_type,
        r.metadata
      FROM relations r
      JOIN entities e1 ON r.from_entity_id = e1.id
      JOIN entities e2 ON r.to_entity_id = e2.id
      WHERE r.from_entity_id = ? OR r.to_entity_id = ?
    `).all(entity.id, entity.id) as unknown[];

    // Optimized: Pre-allocate array and use for loop
    const relations: Relation[] = new Array(relationRows.length);
    for (let i = 0; i < relationRows.length; i++) {
      const r = relationRows[i] as {
        from_name: string;
        to_name: string;
        relation_type: string;
        metadata: string | null;
      };
      relations[i] = {
        from: r.from_name,
        to: r.to_name,
        relationType: r.relation_type as RelationType,
        // ✅ MAJOR-4: Use safeJsonParse instead of raw JSON.parse to prevent crash on malformed data
        metadata: r.metadata ? safeJsonParse<Record<string, unknown>>(r.metadata, {}) : {}
      };
    }

    const result = {
      entity: entityName,
      relations,
      depth
    };

    // Cache the result
    this.queryCache.set(cacheKey, result);

    return result;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalEntities: number;
    totalRelations: number;
    entitiesByType: Record<string, number>;
  } {
    // Generate cache key
    const cacheKey = 'stats:all';

    // Check cache first
    const cached = this.queryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss - execute queries
    const totalEntities = this.db
      .prepare('SELECT COUNT(*) as count FROM entities')
      .get() as { count: number };

    const totalRelations = this.db
      .prepare('SELECT COUNT(*) as count FROM relations')
      .get() as { count: number };

    const byType = this.db
      .prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type')
      .all() as Array<{ type: string; count: number }>;

    const entitiesByType: Record<string, number> = {};
    byType.forEach(row => {
      entitiesByType[row.type] = row.count;
    });

    const result = {
      totalEntities: totalEntities.count,
      totalRelations: totalRelations.count,
      entitiesByType
    };

    // Cache the result (shorter TTL since stats change frequently)
    this.queryCache.set(cacheKey, result, 60 * 1000); // 1 minute TTL

    return result;
  }

  /**
   * Delete an entity and all its relations (cascade delete)
   * ✅ MAJOR-1 FIX: Entire operation wrapped in single transaction for atomicity
   *
   * @param name - Entity name to delete
   * @returns true if entity was deleted, false if not found
   * @throws {ValidationError} If the name is invalid
   */
  deleteEntity(name: string): boolean {
    // Validate entity name before any database operations
    this.validateEntityName(name);

    // ✅ MAJOR-1 FIX: Wrap ENTIRE deleteEntity operation in a single transaction
    // This ensures entity lookup + FTS5 delete + entity delete are atomic
    const result = this.db.transaction(() => {
      // Get entity ID (inside transaction for atomicity)
      const entity = this.db.prepare('SELECT id FROM entities WHERE name = ?')
        .get(name) as { id: number } | undefined;

      if (!entity) {
        return { changes: 0 };
      }

      // Delete from FTS5 index first (contentless table requires special syntax)
      // Must be done before entity deletion since we need the entity data
      const existingFts = this.db.prepare(
        'SELECT name, observations FROM entities_fts WHERE rowid = ?'
      ).get(entity.id) as { name: string; observations: string } | undefined;

      if (existingFts) {
        this.db.prepare(`
          INSERT INTO entities_fts(entities_fts, rowid, name, observations)
          VALUES('delete', ?, ?, ?)
        `).run(entity.id, existingFts.name, existingFts.observations);
      }

      // Delete embedding if vector search is enabled
      if (this.vectorEnabled && this.vectorAdapter) {
        try {
          this.vectorAdapter.deleteEmbedding(this.db, name);
        } catch (error: unknown) {
          logger.warn('[KG] Failed to delete embedding during entity removal', {
            entity: name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Clean up embedding hash for dedup tracking
      try {
        this.db.prepare('DELETE FROM embedding_hashes WHERE entity_name = ?').run(name);
      } catch {
        // Non-critical — orphaned hash entry is harmless
      }

      // Delete the entity (cascade will handle observations, tags, and relations)
      const stmt = this.db.prepare('DELETE FROM entities WHERE name = ?');
      return stmt.run(name);
    })();

    // Invalidate all caches since entity deletion affects multiple queries
    this.queryCache.invalidatePattern(/^entities:/);
    this.queryCache.invalidatePattern(/^relations:/);
    this.queryCache.invalidatePattern(/^trace:/);
    this.queryCache.invalidatePattern(/^stats:/);

    logger.info(`[KG] Deleted entity: ${name}`);
    return result.changes > 0;
  }

  /**
   * Generate embedding for an entity asynchronously.
   * Never throws - failures are logged and silently ignored.
   * All pending tasks are tracked for clean shutdown via close().
   */
  private generateEmbeddingAsync(entityName: string, observations?: string[]): void {
    if (!this.vectorAdapter) return;
    const text = [entityName, ...(observations || [])].join(' ');
    const adapter = this.vectorAdapter;

    // Hash-based dedup: skip ONNX inference if content unchanged
    const newHash = ContentHasher.hashEmbeddingSource(entityName, observations || []);
    try {
      const existing = this.db
        .prepare('SELECT hash FROM embedding_hashes WHERE entity_name = ?')
        .get(entityName) as { hash: string } | undefined;
      if (existing && existing.hash === newHash) {
        logger.debug(`[KG] Embedding hash unchanged, skipping: ${entityName}`);
        return;
      }
    } catch {
      // Table might not exist in older DBs — proceed with generation
    }

    const task = (async () => {
      try {
        const { LazyEmbeddingService } = await import('../embeddings/EmbeddingService.js');
        const service = await LazyEmbeddingService.get();
        const embedding = await service.encode(text);
        adapter.insertEmbedding(this.db, entityName, embedding);

        // Store hash for future dedup
        this.db.prepare(
          'INSERT OR REPLACE INTO embedding_hashes (entity_name, hash) VALUES (?, ?)'
        ).run(entityName, newHash);

        logger.debug(`[KG] Embedding generated for: ${entityName}`);
      } catch (error) {
        logger.warn('[KG] Embedding generation failed', {
          entity: entityName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    // Track the task and auto-remove when it settles
    this.pendingEmbeddings.add(task);
    task.finally(() => this.pendingEmbeddings.delete(task));
  }

  /**
   * Generate embeddings for a batch of entities using encodeBatch().
   * Skips entities that failed creation or whose content hash is unchanged.
   */
  private generateBatchEmbeddingsAsync(
    entities: Array<{ name: string; observations: string[] }>,
    results: Array<{ name: string; success: boolean }>
  ): void {
    if (!this.vectorAdapter) return;
    const adapter = this.vectorAdapter;

    // Filter to successfully created entities with hash-based dedup
    // ContentHasher imported at top of file
    const toEmbed: Array<{ name: string; text: string; hash: string }> = [];

    for (let i = 0; i < entities.length; i++) {
      if (!results[i]?.success) continue;

      const entity = entities[i];
      const newHash = ContentHasher.hashEmbeddingSource(entity.name, entity.observations);

      try {
        const existing = this.db
          .prepare('SELECT hash FROM embedding_hashes WHERE entity_name = ?')
          .get(entity.name) as { hash: string } | undefined;
        if (existing && existing.hash === newHash) {
          logger.debug(`[KG] Batch: embedding hash unchanged, skipping: ${entity.name}`);
          continue;
        }
      } catch {
        // Table might not exist — proceed
      }

      toEmbed.push({
        name: entity.name,
        text: [entity.name, ...entity.observations].join(' '),
        hash: newHash,
      });
    }

    if (toEmbed.length === 0) return;

    const task = (async () => {
      try {
        const { LazyEmbeddingService } = await import('../embeddings/EmbeddingService.js');
        const service = await LazyEmbeddingService.get();
        const embeddings = await service.encodeBatch(toEmbed.map(e => e.text));

        for (let i = 0; i < toEmbed.length; i++) {
          try {
            adapter.insertEmbedding(this.db, toEmbed[i].name, embeddings[i]);
            this.db.prepare(
              'INSERT OR REPLACE INTO embedding_hashes (entity_name, hash) VALUES (?, ?)'
            ).run(toEmbed[i].name, toEmbed[i].hash);
          } catch (error) {
            logger.warn('[KG] Batch embedding insert failed', {
              entity: toEmbed[i].name,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }

        logger.debug(`[KG] Batch embeddings generated for ${toEmbed.length} entities`);
      } catch (error) {
        logger.warn('[KG] Batch embedding generation failed', {
          count: toEmbed.length,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    this.pendingEmbeddings.add(task);
    task.finally(() => this.pendingEmbeddings.delete(task));
  }

  /**
   * Semantic search using vector embeddings. Delegates to KGSearchEngine.
   */
  async semanticSearch(
    query: string,
    options: { limit?: number; minSimilarity?: number; entityTypes?: string[] } = {}
  ): Promise<SemanticSearchResult[]> {
    return this.searchEngine.semanticSearch(query, options);
  }

  /**
   * Hybrid search combining FTS5 keyword results with semantic vector results.
   * Delegates to KGSearchEngine.
   */
  async hybridSearch(
    query: string,
    options: { limit?: number; minSimilarity?: number } = {}
  ): Promise<SemanticSearchResult[]> {
    return this.searchEngine.hybridSearch(query, options);
  }

  /**
   * Check if vector search is enabled
   */
  isVectorSearchEnabled(): boolean {
    return this.vectorEnabled;
  }

  /**
   * Close the database connection.
   * Waits for pending embedding tasks to complete before closing.
   */
  async close() {
    // Wait for any pending embedding tasks to finish
    if (this.pendingEmbeddings.size > 0) {
      logger.debug(`[KG] Waiting for ${this.pendingEmbeddings.size} pending embedding tasks...`);
      await Promise.allSettled([...this.pendingEmbeddings]);
    }

    // Cleanup cache
    this.queryCache.destroy();

    // Close database
    this.db.close();

    logger.info('[KG] Database connection and cache closed');
  }

  /**
   * Execute operations within a transaction
   *
   * Provides atomic operations with automatic rollback on error.
   * This ensures data consistency when performing multiple operations.
   *
   * @param fn - Callback function containing operations to execute
   * @returns Result from the callback function
   * @throws Error if transaction fails (automatically rolls back)
   *
   * @example
   * ```typescript
   * await kg.transaction(() => {
   *   kg.createEntity(entity);
   *   kg.createRelation(relation1);
   *   kg.createRelation(relation2);
   *   // All succeed or all fail together
   * });
   * ```
   */
  transaction<T>(fn: () => T): T {
    // CRITICAL-10: Proper transaction error handling with logging
    try {
      // better-sqlite3 transaction method handles begin/commit/rollback automatically
      const transactionFn = this.db.transaction(fn);
      return transactionFn();
    } catch (error) {
      // Log transaction failure with context
      logger.error('[KG] Transaction failed and rolled back:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Re-throw to propagate error to caller
      throw error;
    }
  }

  /**
   * Get cache statistics (for monitoring and debugging)
   */
  getCacheStats() {
    return this.queryCache.getStats();
  }

  /**
   * Clear cache manually (useful after bulk operations)
   */
  clearCache() {
    this.queryCache.clear();
    logger.info('[KG] Cache cleared manually');
  }
}

// Export types
export type { Entity, Relation, SearchQuery, RelationTrace, EntityType, RelationType } from './types.js';
