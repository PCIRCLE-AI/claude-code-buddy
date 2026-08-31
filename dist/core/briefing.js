import { getDatabase } from '../db.js';
import { getProjectName } from './paths.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { rankEntities } from './scoring.js';
import { getTaskState } from './task-state-store.js';
import { unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { taskStateLines } from './task-state.js';
import { SNIPPET_FETCH_CHARS, TOPOLOGY_CANDIDATE_CAP, assembleTopologyBlock, buildReferenceContext, isAutoInjectable, } from './work-topology.js';
const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;
const CANDIDATE_COLUMNS = 'e.id, e.name, e.type, e.title, e.metadata, e.access_count, e.last_accessed_at, e.confidence, e.recall_hits, e.recall_misses';
function parseMetadata(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
function selectPool(rows, cap) {
    const withMeta = rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        title: row.title,
        meta: parseMetadata(row.metadata),
        access_count: row.access_count ?? undefined,
        last_accessed_at: row.last_accessed_at ?? undefined,
        confidence: row.confidence ?? undefined,
        recall_hits: row.recall_hits ?? undefined,
        recall_misses: row.recall_misses ?? undefined,
    }));
    return rankEntities(withMeta, new Map())
        .filter((row) => isAutoInjectable(row.meta))
        .slice(0, cap);
}
function toTopologyEntity(row, snippet) {
    const signal = row.meta?.signal_score;
    return {
        name: row.name,
        type: row.type || 'memory',
        id: row.id,
        title: row.title,
        snippet,
        signalScore: typeof signal === 'number' ? signal : null,
    };
}
export function assembleBriefing(project, recipient) {
    const projectName = project ?? getProjectName();
    const db = getDatabase();
    const repoLines = (project === undefined || project === getProjectName())
        ? repoStateLines(readRepoState())
        : [];
    const { state } = getTaskState(projectName);
    const stateLines = [
        ...taskStateLines(state, projectName),
        ...unreadInboxLines(unreadDeliveryCount(db, projectName, recipient), projectName, recipient),
    ];
    const projectRows = db.prepare(`SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active'
     ORDER BY e.id DESC
     LIMIT ?`).all(`project:${projectName}`, TOPOLOGY_CANDIDATE_CAP);
    const projectPool = selectPool(projectRows, PROJECT_LIMIT);
    const recentRows = db.prepare(`SELECT ${CANDIDATE_COLUMNS}
     FROM entities e
     WHERE e.status = 'active'
     ORDER BY e.id DESC
     LIMIT ?`).all(TOPOLOGY_CANDIDATE_CAP);
    const recentPool = selectPool(recentRows, RECENT_LIMIT);
    const survivorIds = [...new Set([...projectPool, ...recentPool].map((row) => row.id))];
    const snippets = new Map();
    if (survivorIds.length > 0) {
        const placeholders = survivorIds.map(() => '?').join(',');
        const obsRows = db.prepare(`SELECT entity_id, substr(content, 1, ${SNIPPET_FETCH_CHARS}) AS content
       FROM observations WHERE entity_id IN (${placeholders})
       ORDER BY id ASC`).all(...survivorIds);
        for (const row of obsRows) {
            if (snippets.has(row.entity_id))
                continue;
            const text = String(row.content ?? '').trim();
            if (text)
                snippets.set(row.entity_id, text);
        }
    }
    const toEntities = (pool) => pool.map((row) => toTopologyEntity(row, snippets.get(row.id) ?? null));
    const lines = assembleTopologyBlock(stateLines, [
        { entities: toEntities(projectPool), foreign: false },
        { entities: toEntities(recentPool), foreign: true },
    ], projectName);
    const withRepo = lines.length > 0 && repoLines.length > 0
        ? [...repoLines, '', ...lines]
        : lines;
    return {
        project: projectName,
        text: lines.length > 0 ? buildReferenceContext(withRepo) : '',
        entityCount: lines.filter((l) => l.startsWith('- [')).length,
        hasTaskState: stateLines.length > 0,
    };
}
//# sourceMappingURL=briefing.js.map