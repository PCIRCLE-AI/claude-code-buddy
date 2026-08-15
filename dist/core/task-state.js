export const TASK_STATE_TYPE = 'task-state';
export const TASK_STATE_FIELDS = ['goal', 'next', 'blocked', 'done'];
export const MAX_FIELD_CHARS = 300;
export function taskStateName(project) {
    return `${TASK_STATE_TYPE}:${project}`;
}
export function projectOfTaskStateName(name) {
    const prefix = `${TASK_STATE_TYPE}:`;
    if (!name.startsWith(prefix))
        return null;
    const project = name.slice(prefix.length);
    return project.length > 0 ? project : null;
}
export function isTaskStateField(value) {
    return TASK_STATE_FIELDS.includes(value);
}
export function parseTaskState(metadata) {
    const state = {};
    if (!metadata || typeof metadata !== 'object')
        return state;
    const raw = metadata.task_state;
    if (!raw || typeof raw !== 'object')
        return state;
    const bag = raw;
    for (const field of TASK_STATE_FIELDS) {
        const value = bag[field];
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (trimmed)
            state[field] = trimmed;
    }
    const updated = bag.updated_at;
    if (typeof updated === 'string' && updated.trim())
        state.updated_at = updated.trim();
    return state;
}
export function normalizeFieldValue(value) {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat)
        return null;
    return flat.length > MAX_FIELD_CHARS ? `${flat.slice(0, MAX_FIELD_CHARS - 1).trimEnd()}…` : flat;
}
export function mergeTaskState(previous, patch, now) {
    const state = { ...previous };
    const changed = [];
    const observations = [];
    for (const field of TASK_STATE_FIELDS) {
        const incoming = patch[field];
        if (incoming === undefined)
            continue;
        const normalized = normalizeFieldValue(incoming);
        const current = state[field];
        if (normalized === (current ?? null))
            continue;
        changed.push(field);
        if (normalized === null) {
            delete state[field];
            observations.push(`${field} cleared`);
        }
        else {
            state[field] = normalized;
            observations.push(`${field}: ${normalized}`);
        }
    }
    if (changed.length > 0)
        state.updated_at = now;
    return { state, changed, observations };
}
export function isEmptyTaskState(state) {
    return TASK_STATE_FIELDS.every((field) => !state[field]);
}
const FIELD_LABELS = {
    goal: 'Goal',
    next: 'Next',
    blocked: 'Blocked',
    done: 'Just finished',
};
function ageInDays(updatedAt, now) {
    if (!updatedAt)
        return null;
    const then = Date.parse(updatedAt);
    if (Number.isNaN(then))
        return null;
    const days = Math.floor((now.getTime() - then) / 86_400_000);
    return days >= 0 ? days : null;
}
export function taskStateLines(state, project, now = new Date()) {
    if (isEmptyTaskState(state))
        return [];
    const days = ageInDays(state.updated_at, now);
    const age = days === null ? '' : days === 0 ? ' (today)' : days === 1 ? ' (yesterday)' : ` (${days} days ago)`;
    const lines = [`Where "${project}" was left off${age}:`];
    for (const field of TASK_STATE_FIELDS) {
        const value = state[field];
        if (value)
            lines.push(`- ${FIELD_LABELS[field]}: ${value}`);
    }
    return lines;
}
//# sourceMappingURL=task-state.js.map