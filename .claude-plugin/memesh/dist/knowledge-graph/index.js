import { promises as fsPromises, existsSync, mkdirSync } from 'fs';
import { NotFoundError, ValidationError } from '../errors/index.js';
import { SimpleDatabaseFactory } from '../config/simple-config.js';
import { logger } from '../utils/logger.js';
import { QueryCache } from '../db/QueryCache.js';
import { safeJsonParse, safeJsonStringify } from '../utils/json.js';
import { getDataPath, getDataDirectory } from '../utils/PathResolver.js';
import { validateNonEmptyString } from '../utils/validation.js';
import { KGSearchEngine } from './KGSearchEngine.js';
import { ContentHasher } from './ContentHasher.js';
const MAX_ENTITY_NAME_LENGTH = 512;
const VALID_RELATION_TYPE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
import { CONTROL_CHAR_PATTERN } from './KGSearchEngine.js';
export class KnowledgeGraph {
    db;
    queryCache;
    vectorEnabled = false;
    vectorAdapter = null;
    vectorInitPromise = null;
    pendingEmbeddings = new Set();
    searchEngine;
    constructor(_dbPath, db) {
        this.db = db;
        this.queryCache = new QueryCache({
            maxSize: 1000,
            defaultTTL: 5 * 60 * 1000,
            debug: false,
        });
        this.searchEngine = new KGSearchEngine({
            db: this.db,
            getVectorAdapter: () => this.vectorAdapter,
            isVectorEnabled: () => this.vectorEnabled,
            getVectorInitPromise: () => this.vectorInitPromise,
            getEntity: (name) => this.getEntity(name),
            queryCache: this.queryCache,
        });
    }
    validateEntityName(name) {
        validateNonEmptyString(name, 'Entity name');
        if (name.length > MAX_ENTITY_NAME_LENGTH) {
            throw new ValidationError(`Entity name exceeds maximum length of ${MAX_ENTITY_NAME_LENGTH} characters (got ${name.length})`, {
                component: 'KnowledgeGraph',
                method: 'validateEntityName',
                nameLength: name.length,
                maxLength: MAX_ENTITY_NAME_LENGTH,
            });
        }
        if (CONTROL_CHAR_PATTERN.test(name)) {
            throw new ValidationError('Entity name must not contain control characters', {
                component: 'KnowledgeGraph',
                method: 'validateEntityName',
                name: name.slice(0, 100),
            });
        }
    }
    validateRelationType(relationType) {
        validateNonEmptyString(relationType, 'Relation type');
        if (!VALID_RELATION_TYPE_PATTERN.test(relationType)) {
            throw new ValidationError(`Relation type must contain only alphanumeric characters, underscores, and hyphens, ` +
                `and must start with a letter or underscore. Got: "${relationType}"`, {
                component: 'KnowledgeGraph',
                method: 'validateRelationType',
                relationType,
                pattern: VALID_RELATION_TYPE_PATTERN.source,
            });
        }
    }
    static async create(dbPath) {
        const defaultPath = getDataPath('knowledge-graph.db');
        const resolvedPath = dbPath || defaultPath;
        const dataDir = getDataDirectory();
        try {
            await fsPromises.access(dataDir);
        }
        catch {
            await fsPromises.mkdir(dataDir, { recursive: true });
        }
        const db = SimpleDatabaseFactory.getInstance(resolvedPath);
        const instance = new KnowledgeGraph(resolvedPath, db);
        instance.initialize();
        logger.info(`[KnowledgeGraph] Initialized at: ${resolvedPath}`);
        return instance;
    }
    static createSync(dbPath) {
        const defaultPath = getDataPath('knowledge-graph.db');
        const resolvedPath = dbPath || defaultPath;
        const dataDir = getDataDirectory();
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }
        const db = SimpleDatabaseFactory.getInstance(resolvedPath);
        const instance = new KnowledgeGraph(resolvedPath, db);
        instance.initialize();
        logger.info(`[KnowledgeGraph] Initialized at: ${resolvedPath}`);
        return instance;
    }
    initialize() {
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
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_hashes (
        entity_name TEXT PRIMARY KEY,
        hash TEXT NOT NULL
      );
    `);
        this.runMigrations();
        this.initVectorSearch();
    }
    initVectorSearch() {
        this.vectorInitPromise = import('../embeddings/SqliteVecAdapter.js')
            .then(({ SqliteVecAdapter }) => {
            const adapter = new SqliteVecAdapter();
            adapter.loadExtension(this.db);
            adapter.createVectorTable(this.db, 384);
            this.vectorAdapter = adapter;
            this.vectorEnabled = true;
            logger.info('[KG] Vector search enabled (sqlite-vec loaded)');
        })
            .catch((error) => {
            this.vectorEnabled = false;
            logger.debug('[KG] Vector search unavailable, using FTS5-only search', {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    runMigrations() {
        try {
            const tableInfo = this.db.pragma('table_info(entities)');
            const hasContentHash = tableInfo.some((col) => col.name === 'content_hash');
            if (!hasContentHash) {
                logger.info('[KG] Running migration: Adding content_hash column to entities table');
                this.db.exec(`
          ALTER TABLE entities ADD COLUMN content_hash TEXT;
        `);
                this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_content_hash
          ON entities(content_hash)
          WHERE content_hash IS NOT NULL;
        `);
                logger.info('[KG] Migration complete: content_hash column added with unique index');
            }
        }
        catch (error) {
            logger.error('[KG] Migration failed:', {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        try {
            const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM entities_fts').get().count;
            const entityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities').get().count;
            if (ftsCount === 0 && entityCount > 0) {
                logger.info('[KG] Running migration: Populating FTS5 index from existing entities');
                const CHUNK_SIZE = 500;
                const MAX_OBSERVATIONS_PER_ENTITY = 500;
                const MAX_OBSERVATION_LENGTH = 2000;
                const MAX_TOTAL_LENGTH = 500000;
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
                const idRange = this.db.prepare('SELECT MIN(id) as minId, MAX(id) as maxId FROM entities').get();
                let processedCount = 0;
                for (let startId = idRange.minId - 1; startId < idRange.maxId; startId += CHUNK_SIZE) {
                    const endId = startId + CHUNK_SIZE;
                    const result = insertStmt.run(MAX_OBSERVATION_LENGTH, MAX_OBSERVATIONS_PER_ENTITY, MAX_TOTAL_LENGTH, startId, endId);
                    processedCount += result.changes;
                }
                logger.info(`[KG] Migration complete: Populated FTS5 index with ${processedCount} entities`);
            }
        }
        catch (error) {
            logger.error('[KG] FTS5 population migration failed:', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    escapeLikePattern(pattern) {
        return this.searchEngine.escapeLikePattern(pattern);
    }
    searchFTS5(query, limit) {
        return this.searchEngine.searchFTS5(query, limit);
    }
    prepareFTS5Query(query) {
        return this.searchEngine.prepareFTS5Query(query);
    }
    createEntity(entity, skipEmbedding = false) {
        this.validateEntityName(entity.name);
        try {
            if (entity.contentHash) {
                const existing = this.db
                    .prepare('SELECT name FROM entities WHERE content_hash = ?')
                    .get(entity.contentHash);
                if (existing && existing.name !== entity.name) {
                    logger.info(`[KG] Deduplicated: content_hash match, using existing entity ${existing.name}`);
                    return existing.name;
                }
            }
            const result = this.db.transaction(() => {
                const stmt = this.db.prepare(`
          INSERT INTO entities (name, type, metadata, content_hash)
          VALUES (?, ?, json(?), ?)
          ON CONFLICT(name) DO UPDATE SET
            type = excluded.type,
            metadata = excluded.metadata,
            content_hash = excluded.content_hash
        `);
                stmt.run(entity.name, entity.entityType, safeJsonStringify(entity.metadata || {}, '{}'), entity.contentHash || null);
                const actualEntity = this.db
                    .prepare('SELECT id FROM entities WHERE name = ?')
                    .get(entity.name);
                const actualId = actualEntity.id;
                this.db.prepare('DELETE FROM observations WHERE entity_id = ?').run(actualId);
                this.db.prepare('DELETE FROM tags WHERE entity_id = ?').run(actualId);
                if (entity.observations && entity.observations.length > 0) {
                    const obsStmt = this.db.prepare(`
            INSERT INTO observations (entity_id, content)
            VALUES (?, ?)
          `);
                    for (const obs of entity.observations) {
                        obsStmt.run(actualId, obs);
                    }
                }
                if (entity.tags && entity.tags.length > 0) {
                    const tagStmt = this.db.prepare(`
            INSERT INTO tags (entity_id, tag)
            VALUES (?, ?)
          `);
                    for (const tag of entity.tags) {
                        tagStmt.run(actualId, tag);
                    }
                }
                const observationsText = entity.observations ? entity.observations.join(' ') : '';
                const existingFtsContent = this.db
                    .prepare('SELECT name, observations FROM entities_fts WHERE rowid = ?')
                    .get(actualId);
                if (existingFtsContent) {
                    this.db.prepare(`
            INSERT INTO entities_fts(entities_fts, rowid, name, observations)
            VALUES('delete', ?, ?, ?)
          `).run(actualId, existingFtsContent.name, existingFtsContent.observations);
                }
                this.db.prepare(`
          INSERT INTO entities_fts(rowid, name, observations)
          VALUES (?, ?, ?)
        `).run(actualId, entity.name, observationsText);
                return entity.name;
            })();
            this.queryCache.invalidatePattern(/^entities:/);
            if (this.vectorEnabled && !skipEmbedding) {
                this.generateEmbeddingAsync(entity.name, entity.observations);
            }
            logger.info(`[KG] Created entity: ${entity.name} (type: ${entity.entityType})`);
            return result;
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.includes('UNIQUE constraint failed') &&
                error.message.includes('content_hash')) {
                const existing = this.db
                    .prepare('SELECT name FROM entities WHERE content_hash = ?')
                    .get(entity.contentHash);
                if (existing) {
                    logger.warn(`[KG] Race condition detected: content_hash conflict, using existing entity ${existing.name}`);
                    return existing.name;
                }
            }
            throw error;
        }
    }
    createEntitiesBatch(entities) {
        const results = [];
        if (entities.length === 0) {
            return results;
        }
        const transaction = this.db.transaction(() => {
            for (const entity of entities) {
                try {
                    this.createEntity({
                        name: entity.name,
                        entityType: entity.entityType,
                        observations: entity.observations,
                        tags: entity.tags,
                        metadata: entity.metadata,
                        contentHash: entity.contentHash,
                    }, true);
                    results.push({ name: entity.name, success: true });
                }
                catch (error) {
                    results.push({
                        name: entity.name,
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });
        transaction();
        this.queryCache.invalidatePattern(/^entities:/);
        this.queryCache.invalidatePattern(/^stats:/);
        if (this.vectorEnabled) {
            this.generateBatchEmbeddingsAsync(entities, results);
        }
        return results;
    }
    createRelation(relation) {
        this.validateEntityName(relation.from);
        this.validateEntityName(relation.to);
        this.validateRelationType(relation.relationType);
        const getEntityId = this.db.prepare('SELECT id FROM entities WHERE name = ?');
        const fromEntity = getEntityId.get(relation.from);
        const toEntity = getEntityId.get(relation.to);
        if (!fromEntity) {
            throw new NotFoundError(`Entity not found: ${relation.from}`, 'entity', relation.from, { relationContext: 'from entity in relation creation' });
        }
        if (!toEntity) {
            throw new NotFoundError(`Entity not found: ${relation.to}`, 'entity', relation.to, { relationContext: 'to entity in relation creation' });
        }
        const stmt = this.db.prepare(`
      INSERT INTO relations (from_entity_id, to_entity_id, relation_type, metadata)
      VALUES (?, ?, ?, json(?))
      ON CONFLICT(from_entity_id, to_entity_id, relation_type) DO UPDATE SET
        metadata = excluded.metadata
    `);
        stmt.run(fromEntity.id, toEntity.id, relation.relationType, safeJsonStringify(relation.metadata || {}, '{}'));
        this.queryCache.invalidatePattern(/^relations:/);
        this.queryCache.invalidatePattern(/^trace:/);
        logger.info(`[KG] Created relation: ${relation.from} -[${relation.relationType}]-> ${relation.to}`);
    }
    searchEntities(query) {
        return this.searchEngine.searchEntities(query);
    }
    getEntity(name) {
        this.validateEntityName(name);
        const row = this.db.prepare(`
      SELECT e.*,
        (SELECT json_group_array(content) FROM observations o WHERE o.entity_id = e.id) as observations_json,
        (SELECT json_group_array(tag) FROM tags t WHERE t.entity_id = e.id) as tags_json
      FROM entities e
      WHERE e.name = ?
    `).get(name);
        if (!row)
            return null;
        return {
            id: row.id,
            name: row.name,
            entityType: row.type,
            observations: safeJsonParse(row.observations_json, []).filter(value => value),
            tags: safeJsonParse(row.tags_json, []).filter(value => value),
            metadata: row.metadata ? safeJsonParse(row.metadata, {}) : {},
            createdAt: new Date(row.created_at)
        };
    }
    traceRelations(entityName, depth = 2) {
        this.validateEntityName(entityName);
        const cacheKey = `trace:${entityName}:${depth}`;
        const cached = this.queryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const getEntityId = this.db.prepare('SELECT id FROM entities WHERE name = ?');
        const entity = getEntityId.get(entityName);
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
    `).all(entity.id, entity.id);
        const relations = new Array(relationRows.length);
        for (let i = 0; i < relationRows.length; i++) {
            const r = relationRows[i];
            relations[i] = {
                from: r.from_name,
                to: r.to_name,
                relationType: r.relation_type,
                metadata: r.metadata ? safeJsonParse(r.metadata, {}) : {}
            };
        }
        const result = {
            entity: entityName,
            relations,
            depth
        };
        this.queryCache.set(cacheKey, result);
        return result;
    }
    getStats() {
        const cacheKey = 'stats:all';
        const cached = this.queryCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const totalEntities = this.db
            .prepare('SELECT COUNT(*) as count FROM entities')
            .get();
        const totalRelations = this.db
            .prepare('SELECT COUNT(*) as count FROM relations')
            .get();
        const byType = this.db
            .prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type')
            .all();
        const entitiesByType = {};
        byType.forEach(row => {
            entitiesByType[row.type] = row.count;
        });
        const result = {
            totalEntities: totalEntities.count,
            totalRelations: totalRelations.count,
            entitiesByType
        };
        this.queryCache.set(cacheKey, result, 60 * 1000);
        return result;
    }
    deleteEntity(name) {
        this.validateEntityName(name);
        const result = this.db.transaction(() => {
            const entity = this.db.prepare('SELECT id FROM entities WHERE name = ?')
                .get(name);
            if (!entity) {
                return { changes: 0 };
            }
            const existingFts = this.db.prepare('SELECT name, observations FROM entities_fts WHERE rowid = ?').get(entity.id);
            if (existingFts) {
                this.db.prepare(`
          INSERT INTO entities_fts(entities_fts, rowid, name, observations)
          VALUES('delete', ?, ?, ?)
        `).run(entity.id, existingFts.name, existingFts.observations);
            }
            if (this.vectorEnabled && this.vectorAdapter) {
                try {
                    this.vectorAdapter.deleteEmbedding(this.db, name);
                }
                catch (error) {
                    logger.warn('[KG] Failed to delete embedding during entity removal', {
                        entity: name,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            try {
                this.db.prepare('DELETE FROM embedding_hashes WHERE entity_name = ?').run(name);
            }
            catch {
            }
            const stmt = this.db.prepare('DELETE FROM entities WHERE name = ?');
            return stmt.run(name);
        })();
        this.queryCache.invalidatePattern(/^entities:/);
        this.queryCache.invalidatePattern(/^relations:/);
        this.queryCache.invalidatePattern(/^trace:/);
        this.queryCache.invalidatePattern(/^stats:/);
        logger.info(`[KG] Deleted entity: ${name}`);
        return result.changes > 0;
    }
    generateEmbeddingAsync(entityName, observations) {
        if (!this.vectorAdapter)
            return;
        const text = [entityName, ...(observations || [])].join(' ');
        const adapter = this.vectorAdapter;
        const newHash = ContentHasher.hashEmbeddingSource(entityName, observations || []);
        try {
            const existing = this.db
                .prepare('SELECT hash FROM embedding_hashes WHERE entity_name = ?')
                .get(entityName);
            if (existing && existing.hash === newHash) {
                logger.debug(`[KG] Embedding hash unchanged, skipping: ${entityName}`);
                return;
            }
        }
        catch {
        }
        const task = (async () => {
            try {
                const { LazyEmbeddingService } = await import('../embeddings/EmbeddingService.js');
                const service = await LazyEmbeddingService.get();
                const embedding = await service.encode(text);
                adapter.insertEmbedding(this.db, entityName, embedding);
                this.db.prepare('INSERT OR REPLACE INTO embedding_hashes (entity_name, hash) VALUES (?, ?)').run(entityName, newHash);
                logger.debug(`[KG] Embedding generated for: ${entityName}`);
            }
            catch (error) {
                logger.warn('[KG] Embedding generation failed', {
                    entity: entityName,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        })();
        this.pendingEmbeddings.add(task);
        task.finally(() => this.pendingEmbeddings.delete(task));
    }
    generateBatchEmbeddingsAsync(entities, results) {
        if (!this.vectorAdapter)
            return;
        const adapter = this.vectorAdapter;
        const toEmbed = [];
        for (let i = 0; i < entities.length; i++) {
            if (!results[i]?.success)
                continue;
            const entity = entities[i];
            const newHash = ContentHasher.hashEmbeddingSource(entity.name, entity.observations);
            try {
                const existing = this.db
                    .prepare('SELECT hash FROM embedding_hashes WHERE entity_name = ?')
                    .get(entity.name);
                if (existing && existing.hash === newHash) {
                    logger.debug(`[KG] Batch: embedding hash unchanged, skipping: ${entity.name}`);
                    continue;
                }
            }
            catch {
            }
            toEmbed.push({
                name: entity.name,
                text: [entity.name, ...entity.observations].join(' '),
                hash: newHash,
            });
        }
        if (toEmbed.length === 0)
            return;
        const task = (async () => {
            try {
                const { LazyEmbeddingService } = await import('../embeddings/EmbeddingService.js');
                const service = await LazyEmbeddingService.get();
                const embeddings = await service.encodeBatch(toEmbed.map(e => e.text));
                for (let i = 0; i < toEmbed.length; i++) {
                    try {
                        adapter.insertEmbedding(this.db, toEmbed[i].name, embeddings[i]);
                        this.db.prepare('INSERT OR REPLACE INTO embedding_hashes (entity_name, hash) VALUES (?, ?)').run(toEmbed[i].name, toEmbed[i].hash);
                    }
                    catch (error) {
                        logger.warn('[KG] Batch embedding insert failed', {
                            entity: toEmbed[i].name,
                            reason: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                logger.debug(`[KG] Batch embeddings generated for ${toEmbed.length} entities`);
            }
            catch (error) {
                logger.warn('[KG] Batch embedding generation failed', {
                    count: toEmbed.length,
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        })();
        this.pendingEmbeddings.add(task);
        task.finally(() => this.pendingEmbeddings.delete(task));
    }
    async semanticSearch(query, options = {}) {
        return this.searchEngine.semanticSearch(query, options);
    }
    async hybridSearch(query, options = {}) {
        return this.searchEngine.hybridSearch(query, options);
    }
    isVectorSearchEnabled() {
        return this.vectorEnabled;
    }
    async close() {
        if (this.pendingEmbeddings.size > 0) {
            logger.debug(`[KG] Waiting for ${this.pendingEmbeddings.size} pending embedding tasks...`);
            await Promise.allSettled([...this.pendingEmbeddings]);
        }
        this.queryCache.destroy();
        this.db.close();
        logger.info('[KG] Database connection and cache closed');
    }
    transaction(fn) {
        try {
            const transactionFn = this.db.transaction(fn);
            return transactionFn();
        }
        catch (error) {
            logger.error('[KG] Transaction failed and rolled back:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
        }
    }
    getCacheStats() {
        return this.queryCache.getStats();
    }
    clearCache() {
        this.queryCache.clear();
        logger.info('[KG] Cache cleared manually');
    }
}
//# sourceMappingURL=index.js.map