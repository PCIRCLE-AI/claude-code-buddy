export declare const TASK_STATE_TYPE = "task-state";
export declare const TASK_STATE_FIELDS: readonly ["goal", "next", "blocked", "done"];
export type TaskStateField = (typeof TASK_STATE_FIELDS)[number];
export type TaskState = Partial<Record<TaskStateField, string>> & {
    updated_at?: string;
};
export declare const MAX_FIELD_CHARS = 300;
export declare function taskStateName(project: string): string;
export declare function projectOfTaskStateName(name: string): string | null;
export declare function isTaskStateField(value: string): value is TaskStateField;
export declare function parseTaskState(metadata: unknown): TaskState;
export declare function normalizeFieldValue(value: string): string | null;
export interface TaskStateMerge {
    state: TaskState;
    changed: TaskStateField[];
    observations: string[];
}
export declare function mergeTaskState(previous: TaskState, patch: Partial<Record<TaskStateField, string>>, now: string): TaskStateMerge;
export declare function isEmptyTaskState(state: TaskState): boolean;
export declare function taskStateLines(state: TaskState, project: string, now?: Date): string[];
//# sourceMappingURL=task-state.d.ts.map