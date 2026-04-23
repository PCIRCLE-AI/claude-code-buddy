import Database from 'better-sqlite3';
export type { Entity, Relation, CreateEntityInput, SearchOptions } from './core/types.js';
import type { Entity, Relation, CreateEntityInput, SearchOptions, EntityRow } from './core/types.js';

export class KnowledgeGraph {
  constructor(private db: Database.Database) {}

  createEntity(
    name: string,
    type: string,
    opts?: { observations?: string[]; tags?: string[]; metadata?: any; namespace?: string }
  ): number {
    // INSERT OR IGNORE — if entity already exists, get its id
    // namespace is set on creation only; existing entities keep their original namespace
    const insertResult = this.db
      .prepare(
        'INSERT OR IGNORE INTO entities (name, type, metadata, namespace) VALUES (?, ?, ?, ?)'
      )
      .run(name, type, opts?.metadata ? JSON.stringify(opts.metadata) : null, opts?.namespace ?? 'personal');
    const isNewEntity = insertResult.changes > 0;

    const row = this.db
      .prepare('SELECT id, status FROM entities WHERE name = ?')
      .get(name) as { id: number; status: string };
    const entityId = row.id;

    // Reactivate archived entities on re-remember
    const wasArchived = !isNewEntity && row.status === 'archived';
    if (wasArchived) {
      this.db
        .prepare("UPDATE entities SET status = 'active' WHERE name = ?")
        .run(name);
    }

    // For existing entities, capture current obs text to delete old FTS entry before rebuild.
    // For new entities, no prior FTS entry exists — pass undefined to skip delete.
    // For previously archived entities, the FTS entry was already removed by archiveEntity — also pass undefined.
    const prevObs = isNewEntity || wasArchived
      ? []
      : (this.db
          .prepare('SELECT content FROM observations WHERE entity_id = ?')
          .all(entityId) as { content: string }[]);
    const prevObsText = isNewEntity || wasArchived
      ? undefined
      : prevObs.map((o) => o.content).join(' ');

    // Add observations
    if (opts?.observations?.length) {
      const insertObs = this.db.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      );
      for (const obs of opts.observations) {
        insertObs.run(entityId, obs);
      }
    }

    // Always rebuild FTS so the entity name is indexed (even without observations)
    this.rebuildFts(entityId, name, prevObsText);

    // Add tags
    if (opts?.tags?.length) {
      const insertTag = this.db.prepare(
        'INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)'
      );
      for (const tag of opts.tags) {
        insertTag.run(entityId, tag);
      }
    }

    return entityId;
  }

  createEntitiesBatch(entities: CreateEntityInput[]): void {
    const txn = this.db.transaction(() => {
      for (const e of entities) {
        this.createEntity(e.name, e.type, {
          observations: e.observations,
          tags: e.tags,
          metadata: e.metadata,
          namespace: e.namespace,
        });
      }
    });
    txn();
  }

  createRelation(
    fromName: string,
    toName: string,
    relationType: string,
    metadata?: any
  ): void {
    const fromRow = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(fromName) as { id: number } | undefined;
    const toRow = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(toName) as { id: number } | undefined;

    if (!fromRow) {
      throw new Error(`Entity not found: ${fromName}`);
    }
    if (!toRow) {
      throw new Error(`Entity not found: ${toName}`);
    }

    this.db
      .prepare(
        'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type, metadata) VALUES (?, ?, ?, ?)'
      )
      .run(
        fromRow.id,
        toRow.id,
        relationType,
        metadata ? JSON.stringify(metadata) : null
      );
  }

  getEntity(name: string): Entity | null {
    const row = this.db
      .prepare(
        'SELECT id, name, type, created_at, metadata, status, access_count, last_accessed_at, confidence, valid_from, valid_until, namespace FROM entities WHERE name = ?'
      )
      .get(name) as EntityRow | undefined;

    if (!row) return null;

    const observations = (this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
      .all(row.id) as Array<{ content: string }>)
      .map((o) => o.content);

    const tags = (this.db
      .prepare('SELECT tag FROM tags WHERE entity_id = ?')
      .all(row.id) as Array<{ tag: string }>)
      .map((t) => t.tag);

    const relations = this.getRelations(name);

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      created_at: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      observations,
      tags,
      relations: relations.length > 0 ? relations : undefined,
      ...(row.status === 'archived' ? { archived: true } : {}),
      access_count: row.access_count ?? 0,
      last_accessed_at: row.last_accessed_at ?? undefined,
      confidence: row.confidence ?? 1.0,
      valid_from: row.valid_from ?? undefined,
      valid_until: row.valid_until ?? undefined,
      namespace: row.namespace ?? 'personal',
    };
  }

  getEntitiesByIds(
    ids: number[],
    opts?: { includeArchived?: boolean; namespace?: string; tag?: string }
  ): Entity[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const params: any[] = [...ids];

    // Build dynamic filters
    // Default behavior: include all (archived + active) unless explicitly excluded
    const statusFilter = opts?.includeArchived === false ? "AND status != 'archived'" : '';
    const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
    if (opts?.namespace) params.push(opts.namespace);

    // Batch query 1: entities
    const entityRows = this.db
      .prepare(
        `SELECT id, name, type, created_at, metadata, status, access_count, last_accessed_at, confidence, valid_from, valid_until, namespace
         FROM entities WHERE id IN (${placeholders}) ${statusFilter} ${namespaceFilter}`
      )
      .all(...params) as EntityRow[];

    // Index entity rows by id for fast lookup
    const entityMap = new Map<number, EntityRow>();
    for (const row of entityRows) {
      entityMap.set(row.id, row);
    }

    // Batch query 2: observations (ordered by id to match getEntity behavior)
    const obsRows = this.db
      .prepare(
        `SELECT entity_id, content FROM observations WHERE entity_id IN (${placeholders}) ORDER BY id`
      )
      .all(...ids) as Array<{ entity_id: number; content: string }>;

    const obsMap = new Map<number, string[]>();
    for (const row of obsRows) {
      if (!obsMap.has(row.entity_id)) obsMap.set(row.entity_id, []);
      obsMap.get(row.entity_id)!.push(row.content);
    }

    // Batch query 3: tags
    const tagRows = this.db
      .prepare(
        `SELECT entity_id, tag FROM tags WHERE entity_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ entity_id: number; tag: string }>;

    const tagMap = new Map<number, string[]>();
    for (const row of tagRows) {
      if (!tagMap.has(row.entity_id)) tagMap.set(row.entity_id, []);
      tagMap.get(row.entity_id)!.push(row.tag);
    }

    // Batch query 4: relations (from_entity_id perspective, matching getRelations)
    const relRows = this.db
      .prepare(
        `SELECT r.from_entity_id, e_from.name AS "from", e_to.name AS "to",
                r.relation_type AS type, r.metadata
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE r.from_entity_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ from_entity_id: number; from: string; to: string; type: string; metadata: string | null }>;

    const relMap = new Map<number, Relation[]>();
    for (const row of relRows) {
      if (!relMap.has(row.from_entity_id)) relMap.set(row.from_entity_id, []);
      relMap.get(row.from_entity_id)!.push({
        from: row.from,
        to: row.to,
        type: row.type,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    }

    // Build Entity objects in input order, skipping missing ids
    const results: Entity[] = [];
    for (const id of ids) {
      const row = entityMap.get(id);
      if (!row) continue;

      const observations = obsMap.get(id) ?? [];
      const tags = tagMap.get(id) ?? [];
      const relations = relMap.get(id) ?? [];
      if (opts?.tag && !tags.includes(opts.tag)) continue;

      results.push({
        id: row.id,
        name: row.name,
        type: row.type,
        created_at: row.created_at,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        observations,
        tags,
        relations: relations.length > 0 ? relations : undefined,
        ...(row.status === 'archived' ? { archived: true } : {}),
        access_count: row.access_count ?? 0,
        last_accessed_at: row.last_accessed_at ?? undefined,
        confidence: row.confidence ?? 1.0,
        valid_from: row.valid_from ?? undefined,
        valid_until: row.valid_until ?? undefined,
        namespace: row.namespace ?? 'personal',
      });
    }

    return results;
  }

  getRelations(entityName: string): Relation[] {
    const rows = this.db
      .prepare(
        `SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type, r.metadata
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE e_from.name = ?`
      )
      .all(entityName) as Array<{ from: string; to: string; type: string; metadata: string | null }>;

    return rows.map((r) => ({
      from: r.from,
      to: r.to,
      type: r.type,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  search(query?: string, opts?: SearchOptions): Entity[] {
    const limit = opts?.limit ?? 20;

    if (!query || query.trim() === '') {
      if (opts?.tag) {
        return this.listRecentByTag(opts.tag, limit, opts?.includeArchived, opts?.namespace);
      }
      return this.listRecent(limit, opts?.includeArchived, opts?.namespace);
    }

    // Use FTS5 MATCH to find entity names
    // Escape double quotes and wrap each token in quotes for safe FTS5 matching
    const sanitized = query.replace(/"/g, '""').trim();
    const tokens = sanitized.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return this.listRecent(limit, opts?.includeArchived, opts?.namespace);
    const ftsQuery = tokens.map((token) => `"${token}"`).join(' ');
    // Contentless FTS5: columns return null, so join via rowid → entities.id
    // Archived entities are removed from FTS5 by archiveEntity(), so status filter is a safety net.
    const statusFilter = opts?.includeArchived ? '' : "AND e.status = 'active'";
    const namespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
    let ftsRows: Array<{ id: number; name: string }>;
    try {
      if (opts?.tag) {
        const params: any[] = [ftsQuery, opts.tag];
        if (opts?.namespace) params.push(opts.namespace);
        params.push(limit);
        ftsRows = this.db
          .prepare(
            `SELECT DISTINCT e.id, e.name FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             JOIN tags t ON t.entity_id = e.id
             WHERE entities_fts MATCH ?
               AND t.tag = ?
               ${statusFilter}
               ${namespaceFilter}
             ORDER BY e.id DESC
             LIMIT ?`
          )
          .all(...params) as Array<{ id: number; name: string }>;
      } else {
        const params: any[] = [ftsQuery];
        if (opts?.namespace) params.push(opts.namespace);
        params.push(limit);
        ftsRows = this.db
          .prepare(
            `SELECT e.id, e.name FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             WHERE entities_fts MATCH ?
               ${statusFilter}
               ${namespaceFilter}
             ORDER BY e.id DESC
             LIMIT ?`
          )
          .all(...params) as Array<{ id: number; name: string }>;
      }
    } catch (err: any) {
      // FTS5 syntax error from user query — return empty results
      if (err.message?.includes('fts5')) return [];
      throw err;
    }

    // Fetch full entities from FTS results (batch hydration)
    const ftsIds = ftsRows.map(r => r.id);
    const results = this.getEntitiesByIds(ftsIds, {
      includeArchived: opts?.includeArchived,
      namespace: opts?.namespace,
    });
    const seenIds = new Set(ftsIds);

    // When includeArchived is true, archived entities are not in FTS5 (removed by archiveEntity).
    // Supplement with a direct SQL search over archived entities' observations and names.
    if (opts?.includeArchived) {
      const tagJoin = opts?.tag ? 'JOIN tags t ON t.entity_id = e.id' : '';
      const tagFilter = opts?.tag ? 'AND t.tag = ?' : '';
      const archivedNamespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
      const archivedParams: any[] = [`%${query}%`, `%${query}%`];
      if (opts?.tag) archivedParams.push(opts.tag);
      if (opts?.namespace) archivedParams.push(opts.namespace);

      const archivedRows = this.db
        .prepare(
          `SELECT DISTINCT e.id, e.name
           FROM entities e
           LEFT JOIN observations o ON o.entity_id = e.id
           ${tagJoin}
           WHERE e.status = 'archived'
             AND (e.name LIKE ? OR o.content LIKE ?)
             ${tagFilter}
             ${archivedNamespaceFilter}
           ORDER BY e.id DESC
           LIMIT ?`
        )
        .all(...archivedParams, limit) as Array<{ id: number; name: string }>;

      const archivedIds = archivedRows.map(r => r.id).filter(id => !seenIds.has(id));
      const archivedEntities = this.getEntitiesByIds(archivedIds, {
        includeArchived: true,
        namespace: opts?.namespace,
      });
      results.push(...archivedEntities);
    }

    const entityIds = results.map((e) => e.id);
    this.trackAccess(entityIds);
    return results;
  }

  /**
   * Increment access_count and update last_accessed_at for entities.
   * Called after search/recall returns results.
   */
  trackAccess(entityIds: number[]): void {
    if (entityIds.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE entities SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?'
    );
    const txn = this.db.transaction(() => {
      for (const id of entityIds) {
        stmt.run(now, id);
      }
    });
    txn();
  }

  /**
   * Find contradicting entity pairs in a set of results.
   * Returns array of conflict descriptions.
   */
  findConflicts(entityNames: string[]): string[] {
    if (entityNames.length < 2) return [];

    const conflicts: string[] = [];
    const placeholders = entityNames.map(() => '?').join(',');

    const rows = this.db.prepare(`
      SELECT e_from.name AS from_name, e_to.name AS to_name
      FROM relations r
      JOIN entities e_from ON r.from_entity_id = e_from.id
      JOIN entities e_to ON r.to_entity_id = e_to.id
      WHERE r.relation_type = 'contradicts'
        AND e_from.name IN (${placeholders})
        AND e_to.name IN (${placeholders})
    `).all(...entityNames, ...entityNames) as Array<{ from_name: string; to_name: string }>;

    for (const row of rows) {
      conflicts.push(`"${row.from_name}" contradicts "${row.to_name}"`);
    }

    return conflicts;
  }

  listRecent(limit?: number, includeArchived?: boolean, namespace?: string): Entity[] {
    const statusFilter = includeArchived ? '' : "AND status = 'active'";
    const namespaceFilter = namespace ? 'AND namespace = ?' : '';
    const params: any[] = [];
    if (namespace) params.push(namespace);
    params.push(limit ?? 20);
    const rows = this.db
      .prepare(`SELECT name FROM entities WHERE 1=1 ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
      .all(...params) as { name: string }[];

    const results = rows
      .map((r) => this.getEntity(r.name))
      .filter((e): e is Entity => e !== null);

    const entityIds = results.map((e) => e.id);
    this.trackAccess(entityIds);
    return results;
  }

  private listRecentByTag(tag: string, limit: number, includeArchived?: boolean, namespace?: string): Entity[] {
    const statusFilter = includeArchived ? '' : "AND e.status = 'active'";
    const namespaceFilter = namespace ? 'AND e.namespace = ?' : '';
    const params: any[] = [tag];
    if (namespace) params.push(namespace);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.name
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
         WHERE t.tag = ?
         ${statusFilter}
         ${namespaceFilter}
         ORDER BY e.id DESC
         LIMIT ?`
      )
      .all(...params) as { name: string }[];

    const results = rows
      .map((r) => this.getEntity(r.name))
      .filter((e): e is Entity => e !== null);

    const entityIds = results.map((e) => e.id);
    this.trackAccess(entityIds);
    return results;
  }

  /**
   * Clear all observations and tags for an entity without deleting the entity row.
   * Used by overwrite import to start fresh before re-adding data.
   */
  clearEntityData(name: string): void {
    const row = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(name) as EntityRow | undefined;
    if (!row) return;

    // Capture current observations text for FTS delete before clearing
    const prevObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(row.id) as { content: string }[];
    const prevObsText = prevObs.length > 0
      ? prevObs.map((o) => o.content).join(' ')
      : undefined;

    this.db.prepare('DELETE FROM observations WHERE entity_id = ?').run(row.id);
    this.db.prepare('DELETE FROM tags WHERE entity_id = ?').run(row.id);
    // Rebuild FTS with empty content (removes old indexed text)
    this.rebuildFts(row.id, name, prevObsText);
  }

  archiveEntity(name: string): { archived: boolean; name?: string; previousStatus?: string } {
    const row = this.db
      .prepare('SELECT id, status FROM entities WHERE name = ?')
      .get(name) as { id: number; status: string } | undefined;

    if (!row) return { archived: false };

    // Remove from FTS5 index (archived entities should not be searchable)
    const allObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(row.id) as { content: string }[];
    const obsText = allObs.map((o) => o.content).join(' ');

    try {
      this.db
        .prepare(
          "INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)"
        )
        .run(row.id, name, obsText);
    } catch {
      // FTS entry may not exist if already archived — ignore
    }

    // CRITICAL: Remove from vector index (archived entities should not be retrievable via vector search)
    try {
      this.db
        .prepare('DELETE FROM entities_vec WHERE rowid = ?')
        .run(BigInt(row.id));
    } catch {
      // Vector entry may not exist if embeddings not enabled — ignore
    }

    // Set status to archived
    this.db
      .prepare("UPDATE entities SET status = 'archived' WHERE id = ?")
      .run(row.id);

    return { archived: true, name, previousStatus: row.status };
  }

  removeObservation(
    entityName: string,
    observationContent: string
  ): { removed: boolean; remainingObservations: number } {
    const row = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(entityName) as { id: number } | undefined;

    if (!row) return { removed: false, remainingObservations: 0 };

    const prevObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(row.id) as { content: string }[];
    const prevObsText = prevObs.map((o) => o.content).join(' ');

    const deleteResult = this.db
      .prepare('DELETE FROM observations WHERE entity_id = ? AND content = ?')
      .run(row.id, observationContent);

    if (deleteResult.changes === 0) {
      return { removed: false, remainingObservations: prevObs.length };
    }

    this.rebuildFts(row.id, entityName, prevObsText);

    const remaining = this.db
      .prepare('SELECT COUNT(*) as c FROM observations WHERE entity_id = ?')
      .get(row.id) as { c: number };

    return { removed: true, remainingObservations: remaining.c };
  }

  /** @deprecated Use archiveEntity() instead. Retained for admin/testing only. */
  private deleteEntity(name: string): { deleted: boolean } {
    const row = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(name) as { id: number } | undefined;

    if (!row) return { deleted: false };

    // Delete FTS entry first (contentless FTS5 requires special delete syntax)
    // Need to supply the original indexed values for the delete to work
    const allObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(row.id) as { content: string }[];
    const obsText = allObs.map((o) => o.content).join(' ');
    this.db
      .prepare(
        "INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)"
      )
      .run(row.id, name, obsText);

    // Delete entity (CASCADE handles observations, relations, tags)
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(row.id);

    return { deleted: true };
  }

  private rebuildFts(
    entityId: number,
    entityName: string,
    previousObsText?: string
  ): void {
    // Contentless FTS5 requires supplying original values for delete.
    // If there was a previous entry, delete it first.
    if (previousObsText !== undefined) {
      this.db
        .prepare(
          "INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)"
        )
        .run(entityId, entityName, previousObsText);
    }
    const allObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(entityId) as { content: string }[];
    const obsText = allObs.map((o) => o.content).join(' ');
    this.db
      .prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)')
      .run(entityId, entityName, obsText);
  }
}
