import { type TaskState, type TaskStateField } from './task-state.js';
export interface SetTaskStateInput {
    project?: string;
    patch: Partial<Record<TaskStateField, string>>;
    sourceHost?: string;
}
export interface SetTaskStateResult {
    project: string;
    state: TaskState;
    changed: TaskStateField[];
}
export declare function getTaskState(project?: string): {
    project: string;
    state: TaskState;
};
export declare function setTaskState(input: SetTaskStateInput): SetTaskStateResult;
//# sourceMappingURL=task-state-store.d.ts.map