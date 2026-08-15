// =============================================================================
// task-state store — reading and writing the one "where we are" per project
// =============================================================================
//
// The pure half (field rules, name convention, rendering) lives in
// `task-state.ts`, which is a runtime leaf so the hooks can copy it. This file
// is the half that needs a database.
//
// It deliberately writes THROUGH `remember()` rather than touching the tables
// itself. That is not indirection for its own sake: `remember()` is where
// FTS indexing, auto-tagging, project tagging, signal scoring and embedding
// happen, and a second write path that skipped them is exactly how this
// repository shipped the P0 where session memories were unrecallable.

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName } from './paths.js';
import { remember } from './operations.js';
import {
  TASK_STATE_TYPE,
  taskStateName,
  parseTaskState,
  mergeTaskState,
  type TaskState,
  type TaskStateField,
} from './task-state.js';

export interface SetTaskStateInput {
  /** Defaults to the current working directory's project. */
  project?: string;
  patch: Partial<Record<TaskStateField, string>>;
  sourceHost?: string;
}

export interface SetTaskStateResult {
  project: string;
  state: TaskState;
  /** Fields that actually changed. Empty means nothing was written. */
  changed: TaskStateField[];
}

function readState(name: string): TaskState {
  const row = getDatabase()
    .prepare('SELECT metadata FROM entities WHERE name = ?')
    .get(name) as { metadata: string | null } | undefined;
  if (!row?.metadata) return {};
  try {
    return parseTaskState(JSON.parse(row.metadata));
  } catch {
    // Unparseable metadata is treated as "no state recorded" — the same
    // decision parseTaskState makes for a value it cannot use. Showing an
    // agent a goal reconstructed from corrupted JSON is worse than showing
    // none, and a throw here would take down whatever asked.
    return {};
  }
}

/** The state currently recorded for a project. Empty object when there is none. */
export function getTaskState(project?: string): { project: string; state: TaskState } {
  const resolved = project ?? getProjectName();
  return { project: resolved, state: readState(taskStateName(resolved)) };
}

/**
 * Record where the work stands.
 *
 * Writes only what changed. A caller re-stating the same goal every session
 * produces no row and no new observation — that is what keeps this entity from
 * becoming the fastest-growing row in the database, and what keeps its
 * `updated_at` an honest answer to "how old is this thinking".
 */
export function setTaskState(input: SetTaskStateInput): SetTaskStateResult {
  const project = input.project ?? getProjectName();
  const name = taskStateName(project);
  const previous = readState(name);
  const { state, changed, observations } = mergeTaskState(
    previous,
    input.patch,
    new Date().toISOString(),
  );

  if (changed.length === 0) return { project, state, changed };

  // The headline a human (or an injected block) sees. The goal is what the
  // work is FOR, so it leads; a state with no goal yet is still worth naming
  // by whatever it does have.
  const title = state.goal ?? state.next ?? state.blocked ?? state.done ?? `Task state for ${project}`;

  remember({
    name,
    type: TASK_STATE_TYPE,
    observations,
    tags: [`project:${project}`],
    title,
    sourceHost: input.sourceHost,
  });

  // Metadata is the state's home; the observations above are its history.
  // Written after `remember()` because `updateEntityMetadata` is a no-op on a
  // row that does not exist yet, and on a first call it does not.
  new KnowledgeGraph(getDatabase()).updateEntityMetadata(name, (current) => ({
    ...current,
    task_state: state,
  }));

  return { project, state, changed };
}
