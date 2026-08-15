import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName } from './paths.js';
import { rankEntities } from './scoring.js';
import { getTaskState } from './task-state-store.js';
import { taskStateLines, taskStateName } from './task-state.js';
import { buildReferenceContext, buildTopologyLines, isAutoInjectable, } from './work-topology.js';
const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;
const CANDIDATE_CAP = 400;
const MAX_CONTEXT_CHARS = 4000;
const MAX_LINE_CHARS = 160;
function toTopologyEntity(entity, foreign) {
    const signal = entity.metadata?.signal_score;
    return {
        name: entity.name,
        type: entity.type || 'memory',
        title: entity.title ?? null,
        snippet: entity.observations[0]?.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS) || null,
        signalScore: typeof signal === 'number' ? signal : null,
        foreign,
    };
}
export function assembleBriefing(project) {
    const projectName = project ?? getProjectName();
    const kg = new KnowledgeGraph(getDatabase());
    const { state } = getTaskState(projectName);
    const stateLines = taskStateLines(state, projectName);
    const projectPool = rankEntities(kg.search(undefined, { tag: `project:${projectName}`, limit: CANDIDATE_CAP }), new Map())
        .filter((e) => isAutoInjectable(e.metadata))
        .slice(0, PROJECT_LIMIT);
    const recentPool = rankEntities(kg.listRecent(CANDIDATE_CAP), new Map())
        .filter((e) => isAutoInjectable(e.metadata))
        .slice(0, RECENT_LIMIT);
    const taskEntity = taskStateName(projectName);
    const seen = new Set();
    const candidates = [];
    const addAll = (rows, foreign) => {
        for (const e of rows) {
            if (seen.has(e.id))
                continue;
            if (e.name === taskEntity)
                continue;
            seen.add(e.id);
            candidates.push(toTopologyEntity(e, foreign));
        }
    };
    addAll(projectPool, false);
    addAll(recentPool, true);
    const lines = [];
    if (stateLines.length > 0)
        lines.push(...stateLines, '');
    const topologyLines = buildTopologyLines(candidates, projectName, {
        maxChars: MAX_CONTEXT_CHARS,
        maxLineChars: MAX_LINE_CHARS,
    });
    lines.push(...topologyLines);
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return {
        project: projectName,
        text: lines.length > 0 ? buildReferenceContext(lines) : '',
        entityCount: topologyLines.filter((l) => l.startsWith('- [')).length,
        hasTaskState: stateLines.length > 0,
    };
}
//# sourceMappingURL=briefing.js.map