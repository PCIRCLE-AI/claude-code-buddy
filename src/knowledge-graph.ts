import Database from 'better-sqlite3';

export interface Entity {
  id: number;
  name: string;
  type: string;
  created_at: string;
  metadata?: any;
  observations: string[];
  tags: string[];
  relations?: Relation[];
}

export interface Relation {
  from: string;
  to: string;
  type: string;
  metadata?: any;
}

export interface CreateEntityInput {
  name: string;
  type: string;
  observations?: string[];
  tags?: string[];
  metadata?: any;
}

export interface SearchOptions {
  tag?: string;
  limit?: number;
}

export class KnowledgeGraph {
  constructor(private db: Database.Database) {}

  createEntity(
    name: string,
    type: string,
    opts?: { observations?: string[]; tags?: string[]; metadata?: any }
  ): number {
    // INSERT OR IGNORE — if entity already exists, get its id
    const insertResult = this.db
      .prepare(
        'INSERT OR IGNORE INTO entities (name, type, metadata) VALUES (?, ?, ?)'
      )
      .run(name, type, opts?.metadata ? JSON.stringify(opts.metadata) : null);
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
      .prepare('SELECT id, name, type, created_at, metadata FROM entities WHERE name = ?')
      .get(name) as any | undefined;

    if (!row) return null;

    const observations = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
      .all(row.id)
      .map((o: any) => o.content);

    const tags = this.db
      .prepare('SELECT tag FROM tags WHERE entity_id = ?')
      .all(row.id)
      .map((t: any) => t.tag);

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
    };
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
      .all(entityName) as any[];

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
        return this.listRecentByTag(opts.tag, limit);
      }
      return this.listRecent(limit);
    }

    // Use FTS5 MATCH to find entity names
    // Escape double quotes and wrap each token in quotes for safe FTS5 matching
    const sanitized = query.replace(/"/g, '""').trim();
    const tokens = sanitized.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return this.listRecent(limit);
    const ftsQuery = tokens.map((token) => `"${token}"`).join(' ');
    // Contentless FTS5: columns return null, so join via rowid → entities.id
    let ftsRows: Array<{ id: number; name: string }>;
    try {
      if (opts?.tag) {
        ftsRows = this.db
          .prepare(
            `SELECT DISTINCT e.id, e.name FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             JOIN tags t ON t.entity_id = e.id
             WHERE entities_fts MATCH ?
               AND t.tag = ?
             ORDER BY e.id DESC
             LIMIT ?`
          )
          .all(ftsQuery, opts.tag, limit) as Array<{ id: number; name: string }>;
      } else {
        ftsRows = this.db
          .prepare(
            `SELECT e.id, e.name FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             WHERE entities_fts MATCH ?
             ORDER BY e.id DESC
             LIMIT ?`
          )
          .all(ftsQuery, limit) as Array<{ id: number; name: string }>;
      }
    } catch (err: any) {
      // FTS5 syntax error from user query — return empty results
      if (err.message?.includes('fts5')) return [];
      throw err;
    }

    if (ftsRows.length === 0) return [];

    // Fetch full entities, optionally filtering by tag
    const results: Entity[] = [];
    for (const ftsRow of ftsRows) {
      const entity = this.getEntity(ftsRow.name);
      if (!entity) continue;

      results.push(entity);
    }

    return results;
  }

  listRecent(limit?: number): Entity[] {
    const rows = this.db
      .prepare('SELECT name FROM entities ORDER BY id DESC LIMIT ?')
      .all(limit ?? 20) as { name: string }[];

    return rows
      .map((r) => this.getEntity(r.name))
      .filter((e): e is Entity => e !== null);
  }

  private listRecentByTag(tag: string, limit: number): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.name
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
         WHERE t.tag = ?
         ORDER BY e.id DESC
         LIMIT ?`
      )
      .all(tag, limit) as { name: string }[];

    return rows
      .map((r) => this.getEntity(r.name))
      .filter((e): e is Entity => e !== null);
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
