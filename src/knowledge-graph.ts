import Database from 'better-sqlite3';
export type { Entity, Relation, CreateEntityInput, SearchOptions } from './core/types.js';
import type { Entity, Relation, CreateEntityInput, SearchOptions, EntityRow } from './core/types.js';
import { findConflicts, trackAccess, type TrackAccessOptions } from './storage/conflicts.js';
import { insertFtsRow, removeFromFts } from './storage/fts-index.js';
import { computeSignalScore } from './core/signal-scorer.js';

/**
 * Upper bound on how many terms of a query reach the FTS5 MATCH expression.
 *
 * Terms are OR-ed, so an unbounded query would build an arbitrarily large
 * disjunction — a pasted stack trace or log dump is a cheap way to make one
 * search scan the whole index. Real questions are well under this; the cap only
 * truncates pathological input.
 */
const MAX_QUERY_TERMS = 32;

export class KnowledgeGraph {
  constructor(private db: Database.Database) {}

  updateEntityMetadata(
    name: string,
    updater: (currentMetadata: Record<string, unknown>) => Record<string, unknown> | null | undefined
  ): void {
    const row = this.db
      .prepare('SELECT metadata FROM entities WHERE name = ?')
      .get(name) as { metadata: string | null } | undefined;

    if (!row) return;

    const currentMetadata = this.parseMetadata(row.metadata);
    const nextMetadata = updater(currentMetadata);
    this.db
      .prepare('UPDATE entities SET metadata = ? WHERE name = ?')
      .run(nextMetadata ? JSON.stringify(nextMetadata) : null, name);
  }

  createEntity(
    name: string,
    type: string,
    opts?: {
      observations?: string[];
      tags?: string[];
      metadata?: Record<string, unknown>;
      namespace?: string;
      /**
       * Trust signal for the confidence-bump gate. Must arrive at
       * `createEntity()` time rather than via a later
       * `updateEntityMetadata()` call, because the bump decision
       * happens inside this function. The default ('trusted') matches
       * what `buildLocalMetadata()` writes for explicit user
       * remembers; importer / failure-analyzer paths pass
       * `'untrusted'` to opt out of the bump.
       */
      trustOverride?: 'trusted' | 'untrusted';
    }
  ): number {
    // Phase-1 of #39 (signal scorer): every entity gets a rule-based
    // signal_score at creation time so the dashboard can default-hide
    // empty session_keypoints, mechanical commits, and other captured
    // noise without depending on an LLM round-trip. Stamping in
    // metadata at write-time is cheaper than computing on every
    // dashboard read.
    const incomingMetadata = (opts?.metadata && typeof opts.metadata === 'object') ? { ...opts.metadata } : {};
    if (incomingMetadata.signal_score === undefined) {
      incomingMetadata.signal_score = computeSignalScore({
        type,
        name,
        observations: opts?.observations ?? [],
        tags: opts?.tags ?? [],
      });
    }

    // INSERT OR IGNORE — if entity already exists, get its id
    // namespace is set on creation only; existing entities keep their original namespace
    const insertResult = this.db
      .prepare(
        'INSERT OR IGNORE INTO entities (name, type, metadata, namespace) VALUES (?, ?, ?, ?)'
      )
      .run(name, type, JSON.stringify(incomingMetadata), opts?.namespace ?? 'personal');
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

    // Confidence policy on re-assertion. Three takes, each driven by
    // review feedback:
    //
    //   1. First take: bump on every re-call. Codex caught it as a
    //      pump-attack — every internal caller (auto-tagger, verifier,
    //      importer, tight loop) would inflate confidence with no
    //      truth value added.
    //   2. Second take: never bump from createEntity, only from
    //      explicit `learn` and successful consolidate. Codex caught
    //      THAT as a one-way decay regression for LLM-free installs.
    //   3. Third take: bump on new observations only. Codex caught
    //      THAT as still permitting untrusted sources (importer,
    //      auto-learned lessons) to lift confidence.
    //
    // Resolved: bump only when (a) the entity already exists and is
    // not being reactivated from archive, (b) the call introduces a
    // brand-new observation string, AND (c) the metadata trust signal
    // is 'trusted' (the default for explicit MCP/HTTP/CLI remember
    // calls). Untrusted sources — `importMemories(append/overwrite)`,
    // `createLesson` (failure-analyzer auto-learned), and any future
    // caller that sets `trustOverride: 'untrusted'` — explicitly
    // opt out of confidence lift.
    if (!isNewEntity && !wasArchived) {
      const prevSet = new Set(prevObs.map((o) => o.content));
      const introducesNewObservation = (opts?.observations ?? []).some(
        (o) => !prevSet.has(o),
      );
      // Trust signal lookup. Direct callers may set
      // `opts.trustOverride` (the canonical channel — used by
      // `operations.remember()` after Codex flagged the original
      // metadata-only path). Some callers still pass the trust value
      // inside `opts.metadata.trust`; honor that as a fallback so
      // `kg.createEntity({ metadata: { trust: 'untrusted' } })` still
      // works for direct test fixtures.
      const trustFromMetadata =
        opts?.metadata && typeof opts.metadata === 'object'
          ? (opts.metadata as { trust?: unknown }).trust
          : undefined;
      const incomingTrust = opts?.trustOverride ?? trustFromMetadata;
      const isTrusted = incomingTrust === undefined || incomingTrust === 'trusted';
      if (introducesNewObservation && isTrusted) {
        this.db
          .prepare('UPDATE entities SET confidence = MIN(confidence + 0.05, 1.0) WHERE id = ?')
          .run(entityId);
      }
    }
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

    // The relations.metadata column was never written by any caller and
    // has been retired (SDD G3). The column itself stays in the SQLite
    // schema for compatibility with older databases; we just stop binding
    // anything to it.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      )
      .run(fromRow.id, toRow.id, relationType);
  }

  getEntity(name: string): Entity | null {
    const row = this.db
      .prepare(
        'SELECT id, name, type, created_at, metadata, status, access_count, last_accessed_at, confidence, namespace FROM entities WHERE name = ?'
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
      metadata: row.metadata ? this.parseMetadata(row.metadata) : undefined,
      observations,
      tags,
      relations: relations.length > 0 ? relations : undefined,
      ...(row.status === 'archived' ? { archived: true } : {}),
      access_count: row.access_count ?? 0,
      last_accessed_at: row.last_accessed_at ?? undefined,
      confidence: row.confidence ?? 1.0,
      namespace: row.namespace ?? 'personal',
    };
  }

  getEntitiesByIds(
    ids: number[],
    opts?: { includeArchived?: boolean; namespace?: string; tag?: string }
  ): Entity[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const params: (string | number)[] = [...ids];

    // Build dynamic filters
    // Default behavior: include all (archived + active) unless explicitly excluded
    const statusFilter = opts?.includeArchived === false ? "AND status != 'archived'" : '';
    const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
    if (opts?.namespace) params.push(opts.namespace);

    // Batch query 1: entities
    const entityRows = this.db
      .prepare(
        `SELECT id, name, type, created_at, metadata, status, access_count, last_accessed_at, confidence, namespace
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
                r.relation_type AS type
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE r.from_entity_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ from_entity_id: number; from: string; to: string; type: string }>;

    const relMap = new Map<number, Relation[]>();
    for (const row of relRows) {
      if (!relMap.has(row.from_entity_id)) relMap.set(row.from_entity_id, []);
      relMap.get(row.from_entity_id)!.push({
        from: row.from,
        to: row.to,
        type: row.type,
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
        metadata: row.metadata ? this.parseMetadata(row.metadata) : undefined,
        observations,
        tags,
        relations: relations.length > 0 ? relations : undefined,
        ...(row.status === 'archived' ? { archived: true } : {}),
        access_count: row.access_count ?? 0,
        last_accessed_at: row.last_accessed_at ?? undefined,
        confidence: row.confidence ?? 1.0,
        namespace: row.namespace ?? 'personal',
      });
    }

    return results;
  }

  getRelations(entityName: string): Relation[] {
    const rows = this.db
      .prepare(
        `SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE e_from.name = ?`
      )
      .all(entityName) as Array<{ from: string; to: string; type: string }>;

    return rows.map((r) => ({
      from: r.from,
      to: r.to,
      type: r.type,
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
    // Escape double quotes and wrap each token in quotes for safe FTS5 matching.
    //
    // Terms are joined with OR, not with a bare space. A space is FTS5's
    // implicit AND, which required EVERY word of the query — including "what",
    // "did", "with" — to appear in the same memory. A question asked in the
    // user's own words therefore matched nothing: measured over LongMemEval-S,
    // recall fell from 62.5% R@5 at one keyword to 18% at five, and 473 of 500
    // natural-language questions returned zero rows. OR + BM25 ranking is the
    // standard behaviour: memories matching more of the query score higher and
    // surface first, instead of being excluded outright.
    // Split on the same boundaries FTS5's `unicode61` tokenizer uses — anything
    // that is not a letter or a digit — rather than on whitespace alone.
    // Whitespace splitting left punctuation inside the quotes, so `"kitchen's"`
    // and `"gardening-related"` became multi-word PHRASES that only matched a
    // memory containing those words adjacent and in order: a memory saying
    // "kitchen" or "gardening" was missed entirely. The \p{L}/\p{N} classes
    // keep this correct for non-Latin scripts — a plain [^a-zA-Z0-9] strip
    // would erase CJK queries completely.
    const tokens = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0)
      .slice(0, MAX_QUERY_TERMS);
    if (tokens.length === 0) return this.listRecent(limit, opts?.includeArchived, opts?.namespace);
    const ftsQuery = tokens.map((token) => `"${token}"`).join(' OR ');
    // Contentless FTS5: columns return null, so join via rowid → entities.id
    // Archived entities are removed from FTS5 by archiveEntity(), so status filter is a safety net.
    //
    // Ordering is FTS5's `rank` (BM25), not `e.id DESC`. LIMIT decides which
    // rows survive to the multi-factor scorer, so ordering by id meant the
    // NEWEST matches survived and the best match was discarded before it could
    // ever be scored: with 26+ memories mentioning a term, the most relevant one
    // was unreachable at any database size. Recency still counts — it is one of
    // the five scoring factors — but it no longer decides what gets scored.
    const statusFilter = opts?.includeArchived ? '' : "AND e.status = 'active'";
    const namespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
    let ftsRows: Array<{ id: number; name: string }>;
    try {
      if (opts?.tag) {
        const params: (string | number)[] = [ftsQuery, opts.tag];
        if (opts?.namespace) params.push(opts.namespace);
        params.push(limit);
        ftsRows = this.db
          .prepare(
            `SELECT DISTINCT e.id, e.name, f.rank AS fts_rank FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             JOIN tags t ON t.entity_id = e.id
             WHERE entities_fts MATCH ?
               AND t.tag = ?
               ${statusFilter}
               ${namespaceFilter}
             ORDER BY fts_rank
             LIMIT ?`
          )
          .all(...params) as Array<{ id: number; name: string }>;
      } else {
        const params: (string | number)[] = [ftsQuery];
        if (opts?.namespace) params.push(opts.namespace);
        params.push(limit);
        ftsRows = this.db
          .prepare(
            `SELECT e.id, e.name, f.rank AS fts_rank FROM entities_fts f
             JOIN entities e ON e.id = f.rowid
             WHERE entities_fts MATCH ?
               ${statusFilter}
               ${namespaceFilter}
             ORDER BY fts_rank
             LIMIT ?`
          )
          .all(...params) as Array<{ id: number; name: string }>;
      }
    } catch (err) {
      // FTS5 syntax error from user query — return empty results
      if (err instanceof Error && err.message?.includes('fts5')) return [];
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
      const archivedParams: (string | number)[] = [`%${query}%`, `%${query}%`];
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
    // search() is an intentional retrieval — bump recall_hits so
    // analytics can show which memories the user actually pulled.
    this.trackAccess(entityIds, { incrementHits: true });
    return results;
  }

  /**
   * Increment access_count and update last_accessed_at for entities.
   * Called after search/recall returns results.
   * Delegates to storage/conflicts.ts::trackAccess for shared use.
   */
  trackAccess(entityIds: number[], opts: TrackAccessOptions = {}): void {
    trackAccess(this.db, entityIds, opts);
  }

  /**
   * Find contradicting entity pairs in a set of results.
   * Delegates to storage/conflicts.ts::findConflicts.
   */
  findConflicts(entityNames: string[]): string[] {
    return findConflicts(this.db, entityNames);
  }

  listRecent(limit?: number, includeArchived?: boolean, namespace?: string): Entity[] {
    const statusFilter = includeArchived ? '' : "AND status = 'active'";
    const namespaceFilter = namespace ? 'AND namespace = ?' : '';
    const params: (string | number)[] = [];
    if (namespace) params.push(namespace);
    params.push(limit ?? 20);
    const rows = this.db
      .prepare(`SELECT id FROM entities WHERE 1=1 ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
      .all(...params) as { id: number }[];

    // Batch-hydrate instead of getEntity()-in-a-loop (4 queries per row →
    // 4 queries total). getEntitiesByIds preserves input order, so the
    // ORDER BY id DESC above is retained.
    const results = this.getEntitiesByIds(
      rows.map((r) => r.id),
      { includeArchived, namespace }
    );

    this.trackAccess(results.map((e) => e.id));
    return results;
  }

  /**
   * List active (or all) entities of one type, most-recent first. The storage
   * counterpart of the raw `SELECT ... WHERE type = ?` the HTTP transport used
   * to hand-roll — keeps the status/ordering semantics in one place and batch-
   * hydrates via getEntitiesByIds. Does NOT trackAccess (a type browse is a
   * catalogue read, matching the prior transport behavior).
   */
  listByType(type: string, limit?: number, includeArchived?: boolean, namespace?: string): Entity[] {
    const statusFilter = includeArchived ? '' : "AND status = 'active'";
    const namespaceFilter = namespace ? 'AND namespace = ?' : '';
    const params: (string | number)[] = [type];
    if (namespace) params.push(namespace);
    params.push(limit ?? 20);
    const rows = this.db
      .prepare(`SELECT id FROM entities WHERE type = ? ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
      .all(...params) as { id: number }[];
    return this.getEntitiesByIds(
      rows.map((r) => r.id),
      { includeArchived, namespace }
    );
  }

  private listRecentByTag(tag: string, limit: number, includeArchived?: boolean, namespace?: string): Entity[] {
    const statusFilter = includeArchived ? '' : "AND e.status = 'active'";
    const namespaceFilter = namespace ? 'AND e.namespace = ?' : '';
    const params: (string | number)[] = [tag];
    if (namespace) params.push(namespace);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.id
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
         WHERE t.tag = ?
         ${statusFilter}
         ${namespaceFilter}
         ORDER BY e.id DESC
         LIMIT ?`
      )
      .all(...params) as { id: number }[];

    // Batch-hydrate (see listRecent) — order-preserving, same fields/filters.
    const results = this.getEntitiesByIds(
      rows.map((r) => r.id),
      { includeArchived, namespace }
    );

    // listRecentByTag() is an intentional tag-filtered query — count it.
    this.trackAccess(results.map((e) => e.id), { incrementHits: true });
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

    removeFromFts(this.db, row.id, name, obsText);

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

  /**
   * Hard-delete an entity by name. Cleans the FTS5 entry, the
   * sqlite-vec embedding row, then DELETE FROM entities — the
   * foreign-key cascade handles observations, tags, and relations.
   *
   * Prefer `archiveEntity()` for user-facing forget flows: archiving
   * preserves the row for restore + analytics. This hard delete is
   * the right tool only when the entity should not exist at all
   * (e.g. demo cleanup after `memesh demo --reset`).
   *
   * Both index sides matter: FTS5 is contentless and needs the
   * original observations to locate its row, and `entities_vec` is
   * a separate virtual table whose rows are not cascaded by the
   * `entities` FK — leaving them behind shows up as orphan
   * embeddings on later vector searches.
   */
  deleteEntity(name: string): { deleted: boolean } {
    const row = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(name) as { id: number } | undefined;

    if (!row) return { deleted: false };

    // Delete FTS entry first (contentless FTS5 requires the original
    // indexed values to find the row — see storage/fts-index.ts).
    const allObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(row.id) as { content: string }[];
    const obsText = allObs.map((o) => o.content).join(' ');
    removeFromFts(this.db, row.id, name, obsText);

    // Delete vec entry — mirror archiveEntity's cleanup so hard
    // delete doesn't leak orphan embeddings.
    try {
      this.db
        .prepare('DELETE FROM entities_vec WHERE rowid = ?')
        .run(BigInt(row.id));
    } catch {
      // Vector entry may not exist if embeddings not enabled — ignore.
    }

    // Delete entity (CASCADE handles observations, relations, tags)
    this.db.prepare('DELETE FROM entities WHERE id = ?').run(row.id);

    return { deleted: true };
  }

  private parseMetadata(rawMetadata: string | null): Record<string, unknown> {
    if (!rawMetadata) return {};
    try {
      const parsed = JSON.parse(rawMetadata);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private rebuildFts(
    entityId: number,
    entityName: string,
    previousObsText?: string
  ): void {
    if (previousObsText !== undefined) {
      removeFromFts(this.db, entityId, entityName, previousObsText);
    }
    const allObs = this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ?')
      .all(entityId) as { content: string }[];
    const obsText = allObs.map((o) => o.content).join(' ');
    insertFtsRow(this.db, entityId, entityName, obsText);
  }
}
