/**
 * VectorExtension - SQLite-vec integration for vector similarity search
 *
 * This module provides a wrapper around the sqlite-vec extension for
 * efficient K-nearest-neighbor (KNN) vector search in SQLite.
 *
 * Features:
 * - Loads sqlite-vec extension into better-sqlite3
 * - Creates virtual tables for vector storage with cosine distance metric
 * - Insert/update/delete embeddings
 * - KNN search with configurable k parameter
 *
 * @example
 * ```typescript
 * import { VectorExtension } from './VectorExtension.js';
 * import Database from 'better-sqlite3';
 *
 * const db = new Database(':memory:');
 * VectorExtension.loadExtension(db);
 * VectorExtension.createVectorTable(db, 384);
 *
 * const embedding = new Float32Array(384).fill(0.1);
 * VectorExtension.insertEmbedding(db, 'my-entity', embedding);
 *
 * const query = new Float32Array(384).fill(0.15);
 * const results = VectorExtension.knnSearch(db, query, 10);
 * ```
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { logger } from '../utils/logger.js';

// Re-export from canonical source for backward compatibility
import type { KnnSearchResult } from './VectorSearchAdapter.js';
export type { KnnSearchResult } from './VectorSearchAdapter.js';

/**
 * Default embedding dimensions for all-MiniLM-L6-v2 model
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

/**
 * Convert Buffer to Float32Array
 * Handles byte alignment by slicing the underlying ArrayBuffer
 */
function bufferToFloat32Array(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}

/**
 * Handles sqlite-vec extension loading and vector operations
 *
 * Uses a WeakSet to track which databases have the extension loaded,
 * preventing double-loading which would cause errors.
 */
export class VectorExtension {
  /** Track databases that have already loaded the extension */
  private static extensionLoaded = new WeakSet<Database.Database>();

  /**
   * Load sqlite-vec extension into database
   *
   * This must be called before any vector operations. The extension
   * is loaded only once per database instance.
   *
   * @param db - better-sqlite3 database instance
   * @throws Error if extension loading fails
   */
  static loadExtension(db: Database.Database): void {
    if (this.extensionLoaded.has(db)) {
      return; // Already loaded
    }

    try {
      sqliteVec.load(db);
      this.extensionLoaded.add(db);
      logger.debug('sqlite-vec extension loaded successfully');
    } catch (error) {
      logger.error('Failed to load sqlite-vec extension', { error });
      throw new Error(`Failed to load sqlite-vec: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Create virtual table for vector storage
   *
   * Creates a vec0 virtual table with cosine distance metric.
   * The table uses entity_name as primary key and stores float32 vectors.
   *
   * @param db - better-sqlite3 database instance
   * @param dimensions - Number of dimensions for vectors (default: 384 for all-MiniLM-L6-v2)
   */
  static createVectorTable(db: Database.Database, dimensions: number = 384): void {
    this.ensureExtensionLoaded(db);

    // Create vec0 virtual table with cosine distance metric
    // Note: vec0 virtual tables use a specific syntax
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
        entity_name TEXT PRIMARY KEY,
        embedding float[${dimensions}] distance_metric=cosine
      )
    `);

    logger.debug('Vector table created', { dimensions });
  }

  /**
   * Insert or update embedding for an entity
   *
   * If an embedding already exists for the entity, it will be replaced.
   * The Float32Array is serialized for storage in the virtual table.
   *
   * @param db - better-sqlite3 database instance
   * @param entityName - Unique name for the entity
   * @param embedding - Float32Array of embedding values
   * @param expectedDimensions - Expected embedding dimensions (default: 384 for all-MiniLM-L6-v2)
   * @throws Error if embedding dimensions don't match expected
   */
  static insertEmbedding(
    db: Database.Database,
    entityName: string,
    embedding: Float32Array,
    expectedDimensions: number = DEFAULT_EMBEDDING_DIMENSIONS
  ): void {
    // Validate embedding dimensions
    if (embedding.length !== expectedDimensions) {
      throw new Error(
        `Invalid embedding dimensions: expected ${expectedDimensions}, got ${embedding.length}. ` +
        `Entity: ${entityName}`
      );
    }

    this.ensureExtensionLoaded(db);

    // For vec0 virtual tables, we need to delete first then insert
    // because REPLACE is not directly supported
    const deleteStmt = db.prepare('DELETE FROM entity_embeddings WHERE entity_name = ?');
    deleteStmt.run(entityName);

    const insertStmt = db.prepare(`
      INSERT INTO entity_embeddings (entity_name, embedding)
      VALUES (?, ?)
    `);

    // Convert Float32Array to vec_f32 format using JSON array
    // sqlite-vec accepts JSON arrays for vector input
    const vectorJson = JSON.stringify(Array.from(embedding));
    insertStmt.run(entityName, vectorJson);
  }

  /**
   * Delete embedding for an entity
   *
   * @param db - better-sqlite3 database instance
   * @param entityName - Name of the entity to delete
   */
  static deleteEmbedding(db: Database.Database, entityName: string): void {
    this.ensureExtensionLoaded(db);
    const stmt = db.prepare('DELETE FROM entity_embeddings WHERE entity_name = ?');
    stmt.run(entityName);
  }

  /**
   * K-nearest neighbor search using cosine distance
   *
   * Finds the k closest vectors to the query embedding using the
   * MATCH operator with the virtual table's configured distance metric.
   *
   * @param db - better-sqlite3 database instance
   * @param queryEmbedding - Query vector as Float32Array
   * @param k - Number of nearest neighbors to return
   * @param expectedDimensions - Expected embedding dimensions (default: 384 for all-MiniLM-L6-v2)
   * @returns Array of KnnSearchResult sorted by distance (ascending)
   * @throws Error if query embedding dimensions don't match expected
   */
  static knnSearch(
    db: Database.Database,
    queryEmbedding: Float32Array,
    k: number,
    expectedDimensions: number = DEFAULT_EMBEDDING_DIMENSIONS
  ): KnnSearchResult[] {
    // Validate query embedding dimensions
    if (queryEmbedding.length !== expectedDimensions) {
      throw new Error(
        `Invalid query embedding dimensions: expected ${expectedDimensions}, got ${queryEmbedding.length}`
      );
    }

    this.ensureExtensionLoaded(db);

    // Convert query to JSON array format
    const queryJson = JSON.stringify(Array.from(queryEmbedding));

    // Use KNN query with MATCH operator
    // The virtual table returns entity_name and distance columns
    const stmt = db.prepare(`
      SELECT
        entity_name,
        distance
      FROM entity_embeddings
      WHERE embedding MATCH ?
        AND k = ?
    `);

    const rows = stmt.all(queryJson, k) as Array<{ entity_name: string; distance: number }>;

    return rows.map(row => ({
      entityName: row.entity_name,
      distance: row.distance
    }));
  }

  /**
   * Get embedding for a specific entity
   *
   * @param db - better-sqlite3 database instance
   * @param entityName - Name of the entity
   * @returns Float32Array embedding or null if not found
   */
  static getEmbedding(db: Database.Database, entityName: string): Float32Array | null {
    this.ensureExtensionLoaded(db);

    const stmt = db.prepare('SELECT embedding FROM entity_embeddings WHERE entity_name = ?');
    const row = stmt.get(entityName) as { embedding: Buffer | string } | undefined;

    if (!row) {
      return null;
    }

    // sqlite-vec returns embedding as Buffer or JSON string
    if (Buffer.isBuffer(row.embedding)) {
      return bufferToFloat32Array(row.embedding);
    }

    if (typeof row.embedding === 'string') {
      return new Float32Array(JSON.parse(row.embedding));
    }

    logger.warn('Unexpected embedding format for entity', { entityName });
    return null;
  }

  /**
   * Check if an entity has an embedding
   *
   * @param db - better-sqlite3 database instance
   * @param entityName - Name of the entity
   * @returns true if embedding exists
   */
  static hasEmbedding(db: Database.Database, entityName: string): boolean {
    this.ensureExtensionLoaded(db);
    const stmt = db.prepare('SELECT 1 FROM entity_embeddings WHERE entity_name = ? LIMIT 1');
    const row = stmt.get(entityName);
    return row !== undefined;
  }

  /**
   * Get total count of stored embeddings
   *
   * @param db - better-sqlite3 database instance
   * @returns Number of embeddings in the table
   */
  static getEmbeddingCount(db: Database.Database): number {
    const stmt = db.prepare('SELECT COUNT(*) as cnt FROM entity_embeddings');
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Ensure extension is loaded for the database
   *
   * @param db - better-sqlite3 database instance
   * @private
   */
  private static ensureExtensionLoaded(db: Database.Database): void {
    if (!this.extensionLoaded.has(db)) {
      this.loadExtension(db);
    }
  }
}
