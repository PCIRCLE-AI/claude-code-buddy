import * as sqliteVec from 'sqlite-vec';
import { logger } from '../utils/logger.js';
import { DEFAULT_EMBEDDING_DIMENSIONS } from './VectorSearchAdapter.js';
function bufferToFloat32Array(buffer) {
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return new Float32Array(arrayBuffer);
}
export class SqliteVecAdapter {
    extensionLoaded = new WeakSet();
    loadExtension(db) {
        if (this.extensionLoaded.has(db)) {
            return;
        }
        try {
            sqliteVec.load(db);
            this.extensionLoaded.add(db);
            logger.debug('sqlite-vec extension loaded successfully');
        }
        catch (error) {
            logger.error('Failed to load sqlite-vec extension', { error });
            throw new Error(`Failed to load sqlite-vec: ${error instanceof Error ? error.message : error}`);
        }
    }
    createVectorTable(db, dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
        this.ensureExtensionLoaded(db);
        db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
        entity_name TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine
      )
    `);
        logger.debug('Vector table created', { dimensions });
    }
    insertEmbedding(db, entityName, embedding, dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
        if (embedding.length !== dimensions) {
            throw new Error(`Invalid embedding dimensions: expected ${dimensions}, got ${embedding.length}. ` +
                `Entity: ${entityName}`);
        }
        this.ensureExtensionLoaded(db);
        const deleteStmt = db.prepare('DELETE FROM entity_embeddings WHERE entity_name = ?');
        deleteStmt.run(entityName);
        const insertStmt = db.prepare(`
      INSERT INTO entity_embeddings (entity_name, embedding)
      VALUES (?, ?)
    `);
        const vectorJson = JSON.stringify(Array.from(embedding));
        insertStmt.run(entityName, vectorJson);
    }
    deleteEmbedding(db, entityName) {
        this.ensureExtensionLoaded(db);
        const stmt = db.prepare('DELETE FROM entity_embeddings WHERE entity_name = ?');
        stmt.run(entityName);
    }
    knnSearch(db, queryEmbedding, k, dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {
        if (queryEmbedding.length !== dimensions) {
            throw new Error(`Invalid query embedding dimensions: expected ${dimensions}, got ${queryEmbedding.length}`);
        }
        this.ensureExtensionLoaded(db);
        const queryJson = JSON.stringify(Array.from(queryEmbedding));
        const stmt = db.prepare(`
      SELECT
        entity_name,
        distance
      FROM entity_embeddings
      WHERE embedding MATCH ?
        AND k = ?
    `);
        const rows = stmt.all(queryJson, k);
        return rows.map(row => ({
            entityName: row.entity_name,
            distance: row.distance
        }));
    }
    getEmbedding(db, entityName) {
        this.ensureExtensionLoaded(db);
        const stmt = db.prepare('SELECT embedding FROM entity_embeddings WHERE entity_name = ?');
        const row = stmt.get(entityName);
        if (!row) {
            return null;
        }
        if (Buffer.isBuffer(row.embedding)) {
            return bufferToFloat32Array(row.embedding);
        }
        if (typeof row.embedding === 'string') {
            return new Float32Array(JSON.parse(row.embedding));
        }
        logger.warn('Unexpected embedding format for entity', { entityName });
        return null;
    }
    hasEmbedding(db, entityName) {
        this.ensureExtensionLoaded(db);
        const stmt = db.prepare('SELECT 1 FROM entity_embeddings WHERE entity_name = ? LIMIT 1');
        const row = stmt.get(entityName);
        return row !== undefined;
    }
    getEmbeddingCount(db) {
        const stmt = db.prepare('SELECT COUNT(*) as cnt FROM entity_embeddings');
        const row = stmt.get();
        return row.cnt;
    }
    ensureExtensionLoaded(db) {
        if (!this.extensionLoaded.has(db)) {
            this.loadExtension(db);
        }
    }
}
//# sourceMappingURL=SqliteVecAdapter.js.map