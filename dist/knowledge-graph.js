import { findConflicts, trackAccess } from './storage/conflicts.js';
import { insertFtsRow, removeFromFts, segmentUnspacedScripts } from './storage/fts-index.js';
import { computeSignalScore } from './core/signal-scorer.js';
const MAX_QUERY_TERMS = 32;
function buildMatchExpression(query) {
    const terms = (segmentUnspacedScripts(query).normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])
        .slice(0, MAX_QUERY_TERMS);
    if (terms.length === 0)
        return null;
    return terms.map((term) => (isLoneUnspacedChar(term) ? `"${term}"*` : `"${term}"`)).join(' OR ');
}
function isLoneUnspacedChar(term) {
    return [...term].length === 1 && /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/u.test(term);
}
export class KnowledgeGraph {
    db;
    constructor(db) {
        this.db = db;
    }
    updateEntityMetadata(name, updater) {
        const row = this.db
            .prepare('SELECT metadata FROM entities WHERE name = ?')
            .get(name);
        if (!row)
            return;
        const currentMetadata = this.parseMetadata(row.metadata);
        const nextMetadata = updater(currentMetadata);
        this.db
            .prepare('UPDATE entities SET metadata = ? WHERE name = ?')
            .run(nextMetadata ? JSON.stringify(nextMetadata) : null, name);
    }
    createEntity(name, type, opts) {
        const incomingMetadata = (opts?.metadata && typeof opts.metadata === 'object') ? { ...opts.metadata } : {};
        if (incomingMetadata.signal_score === undefined) {
            incomingMetadata.signal_score = computeSignalScore({
                type,
                name,
                observations: opts?.observations ?? [],
                tags: opts?.tags ?? [],
            });
        }
        const insertResult = this.db
            .prepare('INSERT OR IGNORE INTO entities (name, type, metadata, namespace) VALUES (?, ?, ?, ?)')
            .run(name, type, JSON.stringify(incomingMetadata), opts?.namespace ?? 'personal');
        const isNewEntity = insertResult.changes > 0;
        const row = this.db
            .prepare('SELECT id, status FROM entities WHERE name = ?')
            .get(name);
        const entityId = row.id;
        const wasArchived = !isNewEntity && row.status === 'archived';
        if (wasArchived) {
            this.db
                .prepare("UPDATE entities SET status = 'active' WHERE name = ?")
                .run(name);
        }
        const prevObs = isNewEntity || wasArchived
            ? []
            : this.db
                .prepare('SELECT content FROM observations WHERE entity_id = ?')
                .all(entityId);
        if (!isNewEntity && !wasArchived) {
            const prevSet = new Set(prevObs.map((o) => o.content));
            const introducesNewObservation = (opts?.observations ?? []).some((o) => !prevSet.has(o));
            const trustFromMetadata = opts?.metadata && typeof opts.metadata === 'object'
                ? opts.metadata.trust
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
        if (opts?.observations?.length) {
            const insertObs = this.db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
            for (const obs of opts.observations) {
                insertObs.run(entityId, obs);
            }
        }
        this.rebuildFts(entityId, name, prevObsText);
        if (opts?.tags?.length) {
            const insertTag = this.db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)');
            for (const tag of opts.tags) {
                insertTag.run(entityId, tag);
            }
        }
        return entityId;
    }
    createEntitiesBatch(entities) {
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
    createRelation(fromName, toName, relationType) {
        const fromRow = this.db
            .prepare('SELECT id FROM entities WHERE name = ?')
            .get(fromName);
        const toRow = this.db
            .prepare('SELECT id FROM entities WHERE name = ?')
            .get(toName);
        if (!fromRow) {
            throw new Error(`Entity not found: ${fromName}`);
        }
        if (!toRow) {
            throw new Error(`Entity not found: ${toName}`);
        }
        this.db
            .prepare('INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)')
            .run(fromRow.id, toRow.id, relationType);
    }
    getEntity(name) {
        const row = this.db
            .prepare('SELECT id, name, type, created_at, metadata, status, access_count, last_accessed_at, confidence, namespace FROM entities WHERE name = ?')
            .get(name);
        if (!row)
            return null;
        const observations = this.db
            .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
            .all(row.id)
            .map((o) => o.content);
        const tags = this.db
            .prepare('SELECT tag FROM tags WHERE entity_id = ?')
            .all(row.id)
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
    getEntitiesByIds(ids, opts) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => '?').join(',');
        const params = [...ids];
        const statusFilter = opts?.includeArchived === false ? "AND status != 'archived'" : '';
        const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
        if (opts?.namespace)
            params.push(opts.namespace);
        const entityRows = this.db
            .prepare(`SELECT id, name, type, created_at, metadata, status, access_count, last_accessed_at, confidence, namespace
         FROM entities WHERE id IN (${placeholders}) ${statusFilter} ${namespaceFilter}`)
            .all(...params);
        const entityMap = new Map();
        for (const row of entityRows) {
            entityMap.set(row.id, row);
        }
        const obsRows = this.db
            .prepare(`SELECT entity_id, content FROM observations WHERE entity_id IN (${placeholders}) ORDER BY id`)
            .all(...ids);
        const obsMap = new Map();
        for (const row of obsRows) {
            if (!obsMap.has(row.entity_id))
                obsMap.set(row.entity_id, []);
            obsMap.get(row.entity_id).push(row.content);
        }
        const tagRows = this.db
            .prepare(`SELECT entity_id, tag FROM tags WHERE entity_id IN (${placeholders})`)
            .all(...ids);
        const tagMap = new Map();
        for (const row of tagRows) {
            if (!tagMap.has(row.entity_id))
                tagMap.set(row.entity_id, []);
            tagMap.get(row.entity_id).push(row.tag);
        }
        const relRows = this.db
            .prepare(`SELECT r.from_entity_id, e_from.name AS "from", e_to.name AS "to",
                r.relation_type AS type
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE r.from_entity_id IN (${placeholders})`)
            .all(...ids);
        const relMap = new Map();
        for (const row of relRows) {
            if (!relMap.has(row.from_entity_id))
                relMap.set(row.from_entity_id, []);
            relMap.get(row.from_entity_id).push({
                from: row.from,
                to: row.to,
                type: row.type,
            });
        }
        const results = [];
        for (const id of ids) {
            const row = entityMap.get(id);
            if (!row)
                continue;
            const observations = obsMap.get(id) ?? [];
            const tags = tagMap.get(id) ?? [];
            const relations = relMap.get(id) ?? [];
            if (opts?.tag && !tags.includes(opts.tag))
                continue;
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
    getRelations(entityName) {
        const rows = this.db
            .prepare(`SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE e_from.name = ?`)
            .all(entityName);
        return rows.map((r) => ({
            from: r.from,
            to: r.to,
            type: r.type,
        }));
    }
    search(query, opts) {
        const limit = opts?.limit ?? 20;
        if (!query || query.trim() === '') {
            if (opts?.tag) {
                return this.listRecentByTag(opts.tag, limit, opts?.includeArchived, opts?.namespace);
            }
            return this.listRecent(limit, opts?.includeArchived, opts?.namespace);
        }
        const ftsQuery = buildMatchExpression(query);
        if (ftsQuery === null)
            return this.listRecent(limit, opts?.includeArchived, opts?.namespace);
        const statusFilter = opts?.includeArchived ? '' : "AND e.status = 'active'";
        const namespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
        const tagFilter = opts?.tag
            ? 'AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?)'
            : '';
        const params = [ftsQuery];
        if (opts?.tag)
            params.push(opts.tag);
        if (opts?.namespace)
            params.push(opts.namespace);
        params.push(limit);
        let ftsRows;
        try {
            ftsRows = this.db
                .prepare(`SELECT e.id FROM entities_fts f
           JOIN entities e ON e.id = f.rowid
           WHERE entities_fts MATCH ?
             ${tagFilter}
             ${statusFilter}
             ${namespaceFilter}
           ORDER BY f.rank
           LIMIT ?`)
                .all(...params);
        }
        catch (err) {
            if (err instanceof Error && err.message?.includes('fts5'))
                return [];
            throw err;
        }
        const ftsIds = ftsRows.map(r => r.id);
        const results = this.getEntitiesByIds(ftsIds, {
            includeArchived: opts?.includeArchived,
            namespace: opts?.namespace,
        });
        const seenIds = new Set(ftsIds);
        if (opts?.includeArchived) {
            const tagJoin = opts?.tag ? 'JOIN tags t ON t.entity_id = e.id' : '';
            const tagFilter = opts?.tag ? 'AND t.tag = ?' : '';
            const archivedNamespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
            const archivedParams = [`%${query}%`, `%${query}%`];
            if (opts?.tag)
                archivedParams.push(opts.tag);
            if (opts?.namespace)
                archivedParams.push(opts.namespace);
            const archivedRows = this.db
                .prepare(`SELECT DISTINCT e.id, e.name
           FROM entities e
           LEFT JOIN observations o ON o.entity_id = e.id
           ${tagJoin}
           WHERE e.status = 'archived'
             AND (e.name LIKE ? OR o.content LIKE ?)
             ${tagFilter}
             ${archivedNamespaceFilter}
           ORDER BY e.id DESC
           LIMIT ?`)
                .all(...archivedParams, limit);
            const archivedIds = archivedRows.map(r => r.id).filter(id => !seenIds.has(id));
            const archivedEntities = this.getEntitiesByIds(archivedIds, {
                includeArchived: true,
                namespace: opts?.namespace,
            });
            results.push(...archivedEntities);
        }
        const entityIds = results.map((e) => e.id);
        this.trackAccess(entityIds, { incrementHits: true });
        return results;
    }
    trackAccess(entityIds, opts = {}) {
        trackAccess(this.db, entityIds, opts);
    }
    findConflicts(entityNames) {
        return findConflicts(this.db, entityNames);
    }
    listRecent(limit, includeArchived, namespace) {
        const statusFilter = includeArchived ? '' : "AND status = 'active'";
        const namespaceFilter = namespace ? 'AND namespace = ?' : '';
        const params = [];
        if (namespace)
            params.push(namespace);
        params.push(limit ?? 20);
        const rows = this.db
            .prepare(`SELECT id FROM entities WHERE 1=1 ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
            .all(...params);
        const results = this.getEntitiesByIds(rows.map((r) => r.id), { includeArchived, namespace });
        this.trackAccess(results.map((e) => e.id));
        return results;
    }
    listByType(type, limit, includeArchived, namespace) {
        const statusFilter = includeArchived ? '' : "AND status = 'active'";
        const namespaceFilter = namespace ? 'AND namespace = ?' : '';
        const params = [type];
        if (namespace)
            params.push(namespace);
        params.push(limit ?? 20);
        const rows = this.db
            .prepare(`SELECT id FROM entities WHERE type = ? ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
            .all(...params);
        return this.getEntitiesByIds(rows.map((r) => r.id), { includeArchived, namespace });
    }
    listRecentByTag(tag, limit, includeArchived, namespace) {
        const statusFilter = includeArchived ? '' : "AND e.status = 'active'";
        const namespaceFilter = namespace ? 'AND e.namespace = ?' : '';
        const params = [tag];
        if (namespace)
            params.push(namespace);
        params.push(limit);
        const rows = this.db
            .prepare(`SELECT DISTINCT e.id
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
         WHERE t.tag = ?
         ${statusFilter}
         ${namespaceFilter}
         ORDER BY e.id DESC
         LIMIT ?`)
            .all(...params);
        const results = this.getEntitiesByIds(rows.map((r) => r.id), { includeArchived, namespace });
        this.trackAccess(results.map((e) => e.id), { incrementHits: true });
        return results;
    }
    clearEntityData(name) {
        const row = this.db
            .prepare('SELECT id FROM entities WHERE name = ?')
            .get(name);
        if (!row)
            return;
        const prevObs = this.db
            .prepare('SELECT content FROM observations WHERE entity_id = ?')
            .all(row.id);
        const prevObsText = prevObs.length > 0
            ? prevObs.map((o) => o.content).join(' ')
            : undefined;
        this.db.prepare('DELETE FROM observations WHERE entity_id = ?').run(row.id);
        this.db.prepare('DELETE FROM tags WHERE entity_id = ?').run(row.id);
        this.rebuildFts(row.id, name, prevObsText);
    }
    archiveEntity(name) {
        const row = this.db
            .prepare('SELECT id, status FROM entities WHERE name = ?')
            .get(name);
        if (!row)
            return { archived: false };
        const allObs = this.db
            .prepare('SELECT content FROM observations WHERE entity_id = ?')
            .all(row.id);
        const obsText = allObs.map((o) => o.content).join(' ');
        removeFromFts(this.db, row.id, name, obsText);
        try {
            this.db
                .prepare('DELETE FROM entities_vec WHERE rowid = ?')
                .run(BigInt(row.id));
        }
        catch {
        }
        this.db
            .prepare("UPDATE entities SET status = 'archived' WHERE id = ?")
            .run(row.id);
        return { archived: true, name, previousStatus: row.status };
    }
    removeObservation(entityName, observationContent) {
        const row = this.db
            .prepare('SELECT id FROM entities WHERE name = ?')
            .get(entityName);
        if (!row)
            return { removed: false, remainingObservations: 0 };
        const prevObs = this.db
            .prepare('SELECT content FROM observations WHERE entity_id = ?')
            .all(row.id);
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
            .get(row.id);
        return { removed: true, remainingObservations: remaining.c };
    }
    deleteEntity(name) {
        const row = this.db
            .prepare('SELECT id FROM entities WHERE name = ?')
            .get(name);
        if (!row)
            return { deleted: false };
        const allObs = this.db
            .prepare('SELECT content FROM observations WHERE entity_id = ?')
            .all(row.id);
        const obsText = allObs.map((o) => o.content).join(' ');
        removeFromFts(this.db, row.id, name, obsText);
        try {
            this.db
                .prepare('DELETE FROM entities_vec WHERE rowid = ?')
                .run(BigInt(row.id));
        }
        catch {
        }
        this.db.prepare('DELETE FROM entities WHERE id = ?').run(row.id);
        return { deleted: true };
    }
    parseMetadata(rawMetadata) {
        if (!rawMetadata)
            return {};
        try {
            const parsed = JSON.parse(rawMetadata);
            return parsed && typeof parsed === 'object' ? parsed : {};
        }
        catch {
            return {};
        }
    }
    rebuildFts(entityId, entityName, previousObsText) {
        if (previousObsText !== undefined) {
            removeFromFts(this.db, entityId, entityName, previousObsText);
        }
        const allObs = this.db
            .prepare('SELECT content FROM observations WHERE entity_id = ?')
            .all(entityId);
        const obsText = allObs.map((o) => o.content).join(' ');
        insertFtsRow(this.db, entityId, entityName, obsText);
    }
}
//# sourceMappingURL=knowledge-graph.js.map