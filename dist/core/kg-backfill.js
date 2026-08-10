import { getDatabase } from '../db.js';
const SYSTEM_TAG_PREFIXES = [
    'project:', 'week:', 'cluster:', 'severity:', 'scope:', 'source:', 'date:',
    'type:', 'urgency:', 'host:', 'session:', 'release:',
];
const SYSTEM_TAG_LITERALS = new Set([
    'session_end', 'auto_saved', 'commit', 'auto-tracked',
    'session-summary', 'session-insight', 'session_keypoint',
    'workflow_checkpoint', 'auto', 'auto-captured',
    'completed', 'plan-completion', 'lesson', 'verification',
    'engineering-judgment', 'reference', 'plan',
]);
const DATE_TAG_RE = /^\d{4}-\d{2}-\d{2}/;
const NAME_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'has',
    'fix', 'add', 'get', 'set', 'use', 'via', 'not', 'new', 'old', 'update',
    'into', 'onto', 'when', 'then', 'also', 'both', 'each', 'more', 'about',
    'best', 'practices', 'pattern', 'applied', 'standards', 'professional',
    'using', 'based', 'related', 'general', 'common', 'basic', 'simple',
    'verification', 'cleanup', 'refactoring', 'implementation', 'migration',
    'summary', 'overview', 'analysis', 'review', 'report', 'notes',
    'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);
const NUMERIC_RE = /^\d+$/;
export function tokenizeName(name) {
    return new Set(name.toLowerCase()
        .split(/[\W_]+/)
        .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t) && !NUMERIC_RE.test(t)));
}
export function jaccardSimilarity(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let intersection = 0;
    for (const t of a) {
        if (b.has(t))
            intersection++;
    }
    return intersection / (a.size + b.size - intersection);
}
export function isTopicalTag(tag) {
    if (!tag)
        return false;
    const lower = tag.toLowerCase();
    if (DATE_TAG_RE.test(lower))
        return false;
    if (SYSTEM_TAG_LITERALS.has(lower))
        return false;
    for (const prefix of SYSTEM_TAG_PREFIXES) {
        if (lower.startsWith(prefix)) {
            if (prefix === 'topic:' || prefix === 'tech:')
                return true;
            return false;
        }
    }
    if (lower.length < 2)
        return false;
    return true;
}
const IDEMPOTENCY_KEY = 'kg_backfill_processed_v1';
function readProcessedSet(conn) {
    try {
        const row = conn.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(IDEMPOTENCY_KEY);
        if (!row)
            return new Set();
        const parsed = JSON.parse(row.value);
        if (!Array.isArray(parsed))
            return new Set();
        return new Set(parsed.filter((id) => typeof id === 'number'));
    }
    catch {
        return new Set();
    }
}
function writeProcessedSet(conn, ids) {
    const payload = JSON.stringify([...ids]);
    conn.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(IDEMPOTENCY_KEY, payload);
}
function clearProcessedSet(conn) {
    conn.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(IDEMPOTENCY_KEY);
}
export function resetBackfillIdempotencyCache(db) {
    clearProcessedSet(db ?? getDatabase());
}
export function backfillRelations(opts = {}, db) {
    const conn = db ?? getDatabase();
    const { candidates, consideredOrphanIds, skippedOrphanIds } = proposeBackfillCandidates(opts, conn);
    const result = {
        candidatesProposed: candidates.length,
        edgesWritten: 0,
        dryRun: !!opts.dryRun,
        byRule: { tagCooccurrence: 0, projectClustering: 0, sessionCooccurrence: 0, nameTokenSimilarity: 0 },
        orphansSkippedIdempotent: skippedOrphanIds.length,
        orphansMarkedProcessed: 0,
    };
    if (opts.dryRun)
        return result;
    const insert = conn.prepare('INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)');
    const tx = conn.transaction((rows) => {
        for (const c of rows) {
            const r = insert.run(c.fromEntityId, c.toEntityId, c.relationType);
            if (r.changes > 0) {
                result.edgesWritten++;
                if (c.relationType === 'related-to')
                    result.byRule.tagCooccurrence++;
                else if (c.relationType === 'belongs-to-project')
                    result.byRule.projectClustering++;
                else if (c.relationType === 'co-created')
                    result.byRule.sessionCooccurrence++;
                else if (c.relationType === 'shares-name-tokens')
                    result.byRule.nameTokenSimilarity++;
            }
        }
    });
    tx(candidates);
    if (!opts.ignoreIdempotency && consideredOrphanIds.length > 0) {
        const processedBefore = readProcessedSet(conn);
        const next = new Set(processedBefore);
        for (const id of consideredOrphanIds)
            next.add(id);
        writeProcessedSet(conn, next);
        result.orphansMarkedProcessed = next.size - processedBefore.size;
    }
    return result;
}
export function proposeBackfillCandidates(opts = {}, db) {
    const conn = db ?? getDatabase();
    const maxPerSource = opts.maxEdgesPerSource ?? 3;
    const minShared = opts.minSharedTags ?? 2;
    const statusFilter = opts.includeArchived ? "" : "AND e.status = 'active'";
    const projectClause = opts.project ? "AND EXISTS (SELECT 1 FROM tags t2 WHERE t2.entity_id = e.id AND t2.tag = ?)" : "";
    const projectArgs = opts.project ? [`project:${opts.project}`] : [];
    if (opts.resetIdempotency && !opts.ignoreIdempotency) {
        clearProcessedSet(conn);
    }
    const allOrphans = conn.prepare(`
    SELECT e.id, e.name, e.type, e.metadata
    FROM entities e
    WHERE 1=1 ${statusFilter}
      ${projectClause}
      AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id)
  `).all(...projectArgs);
    const processed = opts.ignoreIdempotency ? new Set() : readProcessedSet(conn);
    const orphans = processed.size === 0
        ? allOrphans
        : allOrphans.filter((o) => !processed.has(o.id));
    const skippedOrphanIds = processed.size === 0
        ? []
        : allOrphans.filter((o) => processed.has(o.id)).map((o) => o.id);
    const consideredOrphanIds = orphans.map((o) => o.id);
    if (orphans.length === 0) {
        return { candidates: [], consideredOrphanIds, skippedOrphanIds };
    }
    const allTagRows = conn.prepare(`
    SELECT t.entity_id, t.tag
    FROM tags t
    JOIN entities e ON e.id = t.entity_id
    WHERE 1=1 ${statusFilter}
  `).all();
    const tagsByEntity = new Map();
    const entitiesByTag = new Map();
    for (const row of allTagRows) {
        if (!isTopicalTag(row.tag))
            continue;
        let set = tagsByEntity.get(row.entity_id);
        if (!set) {
            set = new Set();
            tagsByEntity.set(row.entity_id, set);
        }
        set.add(row.tag);
        let list = entitiesByTag.get(row.tag);
        if (!list) {
            list = [];
            entitiesByTag.set(row.tag, list);
        }
        list.push(row.entity_id);
    }
    const candidates = [];
    const orphanById = new Map();
    for (const o of orphans)
        orphanById.set(o.id, o);
    const allEntities = conn.prepare(`SELECT e.id, e.name, e.type, e.metadata FROM entities e WHERE 1=1 ${statusFilter}`).all();
    const entityById = new Map();
    for (const e of allEntities)
        entityById.set(e.id, e);
    for (const orphan of orphans) {
        const orphanTags = tagsByEntity.get(orphan.id);
        if (!orphanTags || orphanTags.size < minShared)
            continue;
        const overlapByPeer = new Map();
        for (const tag of orphanTags) {
            const peerIds = entitiesByTag.get(tag) ?? [];
            for (const peerId of peerIds) {
                if (peerId === orphan.id)
                    continue;
                overlapByPeer.set(peerId, (overlapByPeer.get(peerId) ?? 0) + 1);
            }
        }
        const ranked = [...overlapByPeer.entries()]
            .filter(([_, n]) => n >= minShared)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxPerSource);
        for (const [peerId, sharedCount] of ranked) {
            const peer = entityById.get(peerId);
            if (!peer)
                continue;
            candidates.push({
                fromEntityId: orphan.id,
                fromName: orphan.name,
                toEntityId: peer.id,
                toName: peer.name,
                relationType: 'related-to',
                reason: `shares ${sharedCount} topical tag${sharedCount > 1 ? 's' : ''}`,
                strength: sharedCount,
            });
        }
    }
    const consumerTypes = new Set(['lesson_learned', 'lesson', 'decision', 'bug_fix', 'pattern', 'mistake', 'best_practice']);
    const anchorTypes = new Set(['release', 'feature', 'architecture', 'plan']);
    const anchorsByProject = new Map();
    const projectAnchorRows = conn.prepare(`
    SELECT e.id, e.name, e.type, e.created_at, t.tag AS project_tag
    FROM entities e
    JOIN tags t ON t.entity_id = e.id AND t.tag LIKE 'project:%'
    WHERE 1=1 ${statusFilter}
      AND e.type IN (${[...anchorTypes].map(() => '?').join(',')})
  `).all(...anchorTypes);
    for (const r of projectAnchorRows) {
        const project = r.project_tag.slice('project:'.length);
        let list = anchorsByProject.get(project);
        if (!list) {
            list = [];
            anchorsByProject.set(project, list);
        }
        list.push({ id: r.id, name: r.name, type: r.type, created_at: r.created_at });
    }
    for (const list of anchorsByProject.values()) {
        list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    const orphanProjectRows = conn.prepare(`
    SELECT t.entity_id, t.tag
    FROM tags t
    JOIN entities e ON e.id = t.entity_id
    WHERE 1=1 ${statusFilter}
      AND t.tag LIKE 'project:%'
      AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id)
  `).all();
    const orphanProject = new Map();
    for (const r of orphanProjectRows)
        orphanProject.set(r.entity_id, r.tag.slice('project:'.length));
    for (const orphan of orphans) {
        if (!consumerTypes.has(orphan.type))
            continue;
        const project = orphanProject.get(orphan.id);
        if (!project)
            continue;
        const anchors = anchorsByProject.get(project);
        if (!anchors || anchors.length === 0)
            continue;
        const anchor = anchors[0];
        if (anchor.id === orphan.id)
            continue;
        candidates.push({
            fromEntityId: orphan.id,
            fromName: orphan.name,
            toEntityId: anchor.id,
            toName: anchor.name,
            relationType: 'belongs-to-project',
            reason: `same-project anchor (${anchor.type})`,
            strength: 1,
        });
    }
    if (opts.includeSessionCooccurrence) {
        const minScore = opts.minSessionSignalScore ?? 0.6;
        const sessionEligibleTypes = new Set([
            'lesson_learned', 'lesson', 'decision', 'architecture', 'architecture_decision',
            'plan', 'feature', 'bug_fix', 'pattern', 'best_practice', 'release',
        ]);
        const getSignalScore = (meta) => {
            try {
                const parsed = JSON.parse(meta ?? '{}');
                const s = parsed?.signal_score;
                return typeof s === 'number' ? s : 1.0;
            }
            catch {
                return 1.0;
            }
        };
        const sessionTagRows = conn.prepare(`
      SELECT t.entity_id, t.tag
      FROM tags t
      JOIN entities e ON e.id = t.entity_id
      WHERE 1=1 ${statusFilter}
        AND t.tag LIKE 'session:%'
    `).all();
        const entitiesBySession = new Map();
        for (const row of sessionTagRows) {
            const ent = entityById.get(row.entity_id);
            if (!ent || !sessionEligibleTypes.has(ent.type))
                continue;
            if (getSignalScore(ent.metadata) < minScore)
                continue;
            let list = entitiesBySession.get(row.tag);
            if (!list) {
                list = [];
                entitiesBySession.set(row.tag, list);
            }
            list.push(row.entity_id);
        }
        const sessionTagsByOrphan = new Map();
        for (const row of sessionTagRows) {
            if (!orphanById.has(row.entity_id))
                continue;
            let list = sessionTagsByOrphan.get(row.entity_id);
            if (!list) {
                list = [];
                sessionTagsByOrphan.set(row.entity_id, list);
            }
            list.push(row.tag);
        }
        for (const orphan of orphans) {
            if (!sessionEligibleTypes.has(orphan.type))
                continue;
            if (getSignalScore(orphan.metadata) < minScore)
                continue;
            const sessionTags = sessionTagsByOrphan.get(orphan.id) ?? [];
            let added = 0;
            const proposedPeers = new Set();
            for (const stag of sessionTags) {
                const peers = (entitiesBySession.get(stag) ?? []).filter((id) => id !== orphan.id);
                for (const peerId of peers) {
                    if (added >= maxPerSource)
                        break;
                    if (proposedPeers.has(peerId))
                        continue;
                    const peer = entityById.get(peerId);
                    if (!peer)
                        continue;
                    candidates.push({
                        fromEntityId: orphan.id,
                        fromName: orphan.name,
                        toEntityId: peer.id,
                        toName: peer.name,
                        relationType: 'co-created',
                        reason: `co-created in same session (${stag})`,
                        strength: 2,
                    });
                    proposedPeers.add(peerId);
                    added++;
                }
                if (added >= maxPerSource)
                    break;
            }
        }
    }
    if (opts.includeNameTokenSimilarity) {
        const minJaccard = opts.minNameJaccard ?? 0.50;
        const minSharedTokens = opts.minSharedNameTokens ?? 3;
        const tokensByEntity = new Map();
        for (const e of allEntities) {
            const tokens = tokenizeName(e.name);
            if (tokens.size >= 2)
                tokensByEntity.set(e.id, tokens);
        }
        const proposedNamePairs = new Set();
        for (const orphan of orphans) {
            const orphanTokens = tokensByEntity.get(orphan.id);
            if (!orphanTokens)
                continue;
            const scored = [];
            for (const [candidateId, candidateTokens] of tokensByEntity) {
                if (candidateId === orphan.id)
                    continue;
                const pairKey = `${Math.min(orphan.id, candidateId)}-${Math.max(orphan.id, candidateId)}`;
                if (proposedNamePairs.has(pairKey))
                    continue;
                let shared = 0;
                for (const t of orphanTokens) {
                    if (candidateTokens.has(t))
                        shared++;
                }
                if (shared === 0)
                    continue;
                const jaccard = jaccardSimilarity(orphanTokens, candidateTokens);
                if (shared >= minSharedTokens || jaccard >= minJaccard) {
                    scored.push({ id: candidateId, shared, jaccard });
                }
            }
            scored.sort((a, b) => b.shared - a.shared || b.jaccard - a.jaccard);
            for (const { id: peerId, shared, jaccard } of scored.slice(0, maxPerSource)) {
                const peer = entityById.get(peerId);
                if (!peer)
                    continue;
                const pairKey = `${Math.min(orphan.id, peerId)}-${Math.max(orphan.id, peerId)}`;
                proposedNamePairs.add(pairKey);
                candidates.push({
                    fromEntityId: orphan.id,
                    fromName: orphan.name,
                    toEntityId: peer.id,
                    toName: peer.name,
                    relationType: 'shares-name-tokens',
                    reason: `${shared} shared name token(s), Jaccard=${jaccard.toFixed(2)}`,
                    strength: shared,
                });
            }
        }
    }
    return { candidates, consideredOrphanIds, skippedOrphanIds };
}
//# sourceMappingURL=kg-backfill.js.map