/**
 * KGSearchEngine - Dedicated search engine for KnowledgeGraph
 *
 * Encapsulates FTS5, semantic (vector), and hybrid search logic.
 * Extracted from KnowledgeGraph to separate search concerns from CRUD.
 *
 * Design: Receives dependencies via constructor to avoid circular imports.
 * Does NOT import KnowledgeGraph.
 */

import type Database from 'better-sqlite3';
import type { Entity, SearchQuery, EntityType } from './types.js';
import type { VectorSearchAdapter } from '../embeddings/VectorSearchAdapter.js';
import { ValidationError } from '../errors/index.js';
import { logger } from '../utils/logger.js';
import { QueryCache } from '../db/QueryCache.js';
import { safeJsonParse } from '../utils/json.js';
import { validateNonEmptyString } from '../utils/validation.js';

/** Valid SQL parameter types for better-sqlite3 */
type SQLParam = string | number | null | Buffer;
type SQLParams = SQLParam[];

/**
 * Result from semantic/hybrid search
 */
export interface SemanticSearchResult {
  entity: Entity;
  similarity: number;
}

/**
 * Regex to detect control characters (C0 and C1 control codes, excluding
 * common whitespace like \t, \n, \r which may appear in legitimate content).
 */
export const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/;

/**
 * Context object providing KGSearchEngine access to KnowledgeGraph internals
 * without creating a circular dependency.
 */
export interface KGSearchEngineContext {
  /** The SQLite database instance */
  db: Database.Database;
  /** Get the vector adapter (may be null if not loaded) */
  getVectorAdapter: () => VectorSearchAdapter | null;
  /** Whether vector search is enabled */
  isVectorEnabled: () => boolean;
  /** Promise that resolves when vector init completes */
  getVectorInitPromise: () => Promise<void> | null;
  /** Look up an entity by name (needed by semanticSearch) */
  getEntity: (name: string) => Entity | null;
  /** Query cache for search results */
  queryCache: QueryCache<string, any>;
}

export class KGSearchEngine {
  private readonly ctx: KGSearchEngineContext;

  constructor(context: KGSearchEngineContext) {
    this.ctx = context;
  }

  // ===========================================================================
  // FTS5 Helpers
  // ===========================================================================

  /**
   * Escape special characters in LIKE patterns to prevent SQL injection.
   * Uses '!' as the ESCAPE character.
   */
  escapeLikePattern(pattern: string): string {
    if (typeof pattern !== 'string') {
      throw new Error(`Pattern must be a string, got ${typeof pattern}`);
    }

    return pattern
      .replace(/!/g, '!!')     // Exclamation first (our escape character)
      .replace(/%/g, '!%')     // Percent (matches any sequence)
      .replace(/_/g, '!_')     // Underscore (matches single character)
      .replace(/\[/g, '![')    // Left bracket (character class start)
      .replace(/\]/g, '!]');   // Right bracket (character class end)
  }

  /**
   * Search using FTS5 full-text search.
   * Returns entity IDs matching the query, ranked by BM25.
   *
   * BM25 weighted ranking - name matches rank higher than observations.
   * bm25(entities_fts, 10.0, 5.0) gives name column 2x the weight of observations.
   */
  searchFTS5(query: string, limit: number): number[] {
    if (!query || query.trim() === '') {
      return [];
    }

    const ftsQuery = this.prepareFTS5Query(query);
    if (!ftsQuery) {
      return [];
    }

    try {
      const results = this.ctx.db.prepare(`
        SELECT rowid, bm25(entities_fts, 10.0, 5.0) as rank
        FROM entities_fts
        WHERE entities_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as Array<{ rowid: number; rank: number }>;

      return results.map(r => r.rowid);
    } catch (error) {
      logger.warn('[KG] FTS5 search failed, will use LIKE fallback:', {
        query,
        ftsQuery,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  /**
   * Prepare query string for FTS5 MATCH.
   * Converts user query to FTS5 query syntax.
   *
   * Escapes FTS5 operators to prevent query injection.
   * Validates query length and token count to prevent DoS.
   */
  prepareFTS5Query(query: string): string {
    const MAX_QUERY_LENGTH = 10000;
    const MAX_TOKENS = 100;

    let normalized = query.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return '';
    }

    if (normalized.length > MAX_QUERY_LENGTH) {
      logger.warn(`[KG] FTS5 query too long (${normalized.length} chars), truncating to ${MAX_QUERY_LENGTH}`);
      normalized = normalized.substring(0, MAX_QUERY_LENGTH);
    }

    let tokens = normalized.split(' ').filter(t => t.length > 0);
    if (tokens.length === 0) {
      return '';
    }

    if (tokens.length > MAX_TOKENS) {
      logger.warn(`[KG] FTS5 query has too many tokens (${tokens.length}), using first ${MAX_TOKENS}`);
      tokens = tokens.slice(0, MAX_TOKENS);
    }

    const ftsTokens = tokens
      .filter(token => {
        const upper = token.toUpperCase();
        return upper !== 'AND' && upper !== 'OR' && upper !== 'NOT' && upper !== 'NEAR';
      })
      .map(token => {
        const escaped = token
          .replace(/"/g, '""')
          .replace(/\*/g, '')
          .replace(/\^/g, '')
          .replace(/:/g, '')
          .replace(/[(){}[\]]/g, '');
        if (!escaped) {
          return null;
        }
        return `"${escaped}"*`;
      })
      .filter((t): t is string => t !== null);

    if (ftsTokens.length === 0) {
      return '';
    }

    return ftsTokens.join(' OR ');
  }

  // ===========================================================================
  // Keyword Search (searchEntities)
  // ===========================================================================

  /**
   * Search entities by type, tag, and/or name pattern.
   * Uses FTS5 for tokenized matching with LIKE fallback.
   *
   * Security: SQL-injection-safe - all user inputs use parameterized queries.
   */
  searchEntities(query: SearchQuery): Entity[] {
    const MAX_LIMIT = 1000;

    if (query.limit === 0) {
      return [];
    }

    let effectiveLimit: number | undefined = query.limit;

    if (query.limit !== undefined) {
      if (query.limit < 0) {
        throw new ValidationError('Limit must be non-negative', {
          component: 'KGSearchEngine',
          method: 'searchEntities',
          providedLimit: query.limit,
        });
      }
      if (query.limit > MAX_LIMIT) {
        logger.warn(`Limit ${query.limit} exceeds maximum, capping to ${MAX_LIMIT}`);
        effectiveLimit = MAX_LIMIT;
      }
    }

    if (query.offset !== undefined && query.offset < 0) {
      throw new ValidationError('Offset must be non-negative', {
        component: 'KGSearchEngine',
        method: 'searchEntities',
        providedOffset: query.offset,
      });
    }

    if (query.namePattern !== undefined && query.namePattern !== '') {
      validateNonEmptyString(query.namePattern, 'Name pattern');
      if (CONTROL_CHAR_PATTERN.test(query.namePattern)) {
        throw new ValidationError(
          'Name pattern must not contain control characters',
          {
            component: 'KGSearchEngine',
            method: 'searchEntities',
            namePattern: query.namePattern.slice(0, 100),
          }
        );
      }
    }

    const cacheKeyQuery = { ...query, limit: effectiveLimit };
    const cacheKey = `entities:${JSON.stringify(cacheKeyQuery)}`;

    const cached = this.ctx.queryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let sql = `
      SELECT e.*,
        (SELECT json_group_array(content) FROM observations o WHERE o.entity_id = e.id) as observations_json,
        (SELECT json_group_array(tag) FROM tags t WHERE t.entity_id = e.id) as tags_json
      FROM entities e
      WHERE 1=1
    `;

    const params: SQLParams = [];

    if (query.entityType) {
      sql += ' AND e.type = ?';
      params.push(query.entityType);
    }

    if (query.tag) {
      sql += ' AND e.id IN (SELECT entity_id FROM tags WHERE tag = ?)';
      params.push(query.tag);
    }

    if (query.namePattern) {
      const ftsResults = this.searchFTS5(query.namePattern, effectiveLimit || 100);

      if (ftsResults.length > 0) {
        sql += ' AND e.id IN (' + ftsResults.map(() => '?').join(',') + ')';
        params.push(...ftsResults);
      } else {
        sql += " AND (e.name LIKE ? ESCAPE '!' OR e.id IN (SELECT entity_id FROM observations WHERE content LIKE ? ESCAPE '!'))";
        const escapedPattern = `%${this.escapeLikePattern(query.namePattern)}%`;
        params.push(escapedPattern);
        params.push(escapedPattern);
      }
    }

    sql += ' ORDER BY e.created_at DESC';

    if (effectiveLimit !== undefined) {
      sql += ' LIMIT ?';
      params.push(effectiveLimit);
    }

    if (query.offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(query.offset);
    }

    const stmt = this.ctx.db.prepare(sql);
    const rows = stmt.all(...params) as unknown[];

    const entities: Entity[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as {
        id: number;
        name: string;
        type: string;
        observations_json: string | null;
        tags_json: string | null;
        metadata: string | null;
        created_at: string;
      };

      const observations = safeJsonParse<string[]>(r.observations_json, [])
        .filter(value => value);
      const tags = safeJsonParse<string[]>(r.tags_json, [])
        .filter(value => value);

      entities[i] = {
        id: r.id,
        name: r.name,
        entityType: r.type as EntityType,
        observations,
        tags,
        metadata: r.metadata ? safeJsonParse<Record<string, unknown>>(r.metadata, {}) : {},
        createdAt: new Date(r.created_at)
      };
    }

    this.ctx.queryCache.set(cacheKey, entities);

    return entities;
  }

  // ===========================================================================
  // Semantic Search (vector-based)
  // ===========================================================================

  /**
   * Semantic search using vector embeddings.
   * Falls back to keyword search if embeddings are unavailable.
   */
  async semanticSearch(
    query: string,
    options: { limit?: number; minSimilarity?: number; entityTypes?: string[] } = {}
  ): Promise<SemanticSearchResult[]> {
    const { limit = 10, minSimilarity = 0.3 } = options;

    const vectorInitPromise = this.ctx.getVectorInitPromise();
    if (vectorInitPromise) {
      await vectorInitPromise;
    }

    const vectorAdapter = this.ctx.getVectorAdapter();
    if (!this.ctx.isVectorEnabled() || !vectorAdapter) {
      return this.keywordSearchAsSemanticResults(query, limit);
    }

    try {
      const { LazyEmbeddingService } = await import('../embeddings/EmbeddingService.js');
      const service = await LazyEmbeddingService.get();
      const queryEmbedding = await service.encode(query);

      const knnResults = vectorAdapter.knnSearch(this.ctx.db, queryEmbedding, limit * 2);

      const results: SemanticSearchResult[] = [];
      for (const knn of knnResults) {
        const similarity = 1 - knn.distance;
        if (similarity < minSimilarity) continue;

        const entity = this.ctx.getEntity(knn.entityName);
        if (!entity) continue;

        results.push({ entity, similarity });
      }

      return results.slice(0, limit);
    } catch (error) {
      logger.warn('[KG] Semantic search failed, falling back to keyword', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.keywordSearchAsSemanticResults(query, limit);
    }
  }

  // ===========================================================================
  // Hybrid Search (keyword + semantic)
  // ===========================================================================

  /**
   * Hybrid search combining FTS5 keyword results with semantic vector results.
   * Merges and deduplicates results from both approaches.
   */
  async hybridSearch(
    query: string,
    options: { limit?: number; minSimilarity?: number } = {}
  ): Promise<SemanticSearchResult[]> {
    const { limit = 10, minSimilarity = 0.3 } = options;

    const keywordResults = this.keywordSearchAsSemanticResults(query, limit);

    const vectorInitPromise = this.ctx.getVectorInitPromise();
    if (vectorInitPromise) {
      await vectorInitPromise;
    }

    if (!this.ctx.isVectorEnabled()) {
      return keywordResults;
    }

    const semanticResults = await this.semanticSearch(query, { limit, minSimilarity });

    const merged = new Map<string, SemanticSearchResult>();
    for (const r of keywordResults) {
      merged.set(r.entity.name, r);
    }
    for (const r of semanticResults) {
      const existing = merged.get(r.entity.name);
      if (!existing || r.similarity > existing.similarity) {
        merged.set(r.entity.name, r);
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Convert keyword search results to SemanticSearchResult format.
   * Uses 0.5 similarity for keyword matches to distinguish from real semantic matches.
   */
  keywordSearchAsSemanticResults(query: string, limit: number): SemanticSearchResult[] {
    const entities = this.searchEntities({ namePattern: query, limit });
    return entities.map(entity => ({ entity, similarity: 0.5 }));
  }
}
