import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName } from './paths.js';
import { remember } from './operations.js';
import { TASK_STATE_TYPE, taskStateName, parseTaskState, mergeTaskState, } from './task-state.js';
function readState(name) {
    const row = getDatabase()
        .prepare('SELECT metadata FROM entities WHERE name = ?')
        .get(name);
    if (!row?.metadata)
        return {};
    try {
        return parseTaskState(JSON.parse(row.metadata));
    }
    catch {
        return {};
    }
}
export function getTaskState(project) {
    const resolved = project ?? getProjectName();
    return { project: resolved, state: readState(taskStateName(resolved)) };
}
export function setTaskState(input) {
    const project = input.project ?? getProjectName();
    const name = taskStateName(project);
    const previous = readState(name);
    const { state, changed, observations } = mergeTaskState(previous, input.patch, new Date().toISOString());
    if (changed.length === 0)
        return { project, state, changed };
    const title = state.goal ?? state.next ?? state.blocked ?? state.done ?? `Task state for ${project}`;
    remember({
        name,
        type: TASK_STATE_TYPE,
        observations,
        tags: [`project:${project}`],
        title,
        sourceHost: input.sourceHost,
    });
    new KnowledgeGraph(getDatabase()).updateEntityMetadata(name, (current) => ({
        ...current,
        task_state: state,
    }));
    return { project, state, changed };
}
//# sourceMappingURL=task-state-store.js.map