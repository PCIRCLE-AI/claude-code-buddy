// =============================================================================
// task-state — the one "where we are" per project
// =============================================================================
//
// A runtime leaf with no imports, so scripts/generate-hook-core.mjs can copy it
// next to the hooks (they must not import dist/). Same constraint, and same
// reason, as work-topology.ts.
//
// WHY THIS IS NOT DERIVED FROM A TRANSCRIPT
// -----------------------------------------
// The handoff plan had the Stop hook write this. It cannot, honestly. A
// transcript mechanically yields "edited 6 files, hit 2 errors" — turning that
// into "the goal is X" or "next is Y" is a machine guessing intent, and this
// repository has audited that exact shape three times (see the fake-working
// audits). `done` is no better: a session that edited files is not a session
// that finished anything.
//
// So all four fields are EXPLICIT. Something that actually knows — the agent
// being told by a human, or the human at the CLI — states them. The hook's job
// is to read this back at session start, not to invent it.
//
// STORAGE
// -------
// Current state lives in `metadata.task_state`; the observation trail records
// each change in a human-readable line. Metadata-as-state is the convention
// this repo already settled on for new fields (cf. `signal_score`,
// `work_status`) and it buys two things here: the read is O(1) with no
// ordering ambiguity, and the injected block cannot be wrong because two
// observations disagreed about which is newer.
//
// Observation growth is bounded by CHANGES, not by sessions: `mergeTaskState`
// reports nothing changed when a caller re-states the same value, and callers
// skip the write. A project that genuinely changes direction a few hundred
// times has a few hundred lines here, which is the history a human wants
// anyway.

/** The entity type. Already listed in work-topology's WORK_LAYER_TYPES. */
export const TASK_STATE_TYPE = 'task-state';

/**
 * The four fields, in the order a session needs to read them: what we are
 * aiming at, what to do next, what stands in the way, what is already behind
 * us.
 */
export const TASK_STATE_FIELDS = ['goal', 'next', 'blocked', 'done'] as const;

export type TaskStateField = (typeof TASK_STATE_FIELDS)[number];

export type TaskState = Partial<Record<TaskStateField, string>> & {
  /** ISO timestamp of the last field CHANGE (not the last write attempt). */
  updated_at?: string;
};

/** Longest a single field may be. Past this it is a memory, not a state. */
export const MAX_FIELD_CHARS = 300;

/**
 * Entity names are globally UNIQUE in this schema, so the project has to be in
 * the name — otherwise two projects' states would collide into one row and
 * every session would read someone else's goal.
 */
export function taskStateName(project: string): string {
  return `${TASK_STATE_TYPE}:${project}`;
}

/**
 * Read the current state out of an entity's parsed metadata.
 *
 * Tolerant by necessity — metadata is free-form JSON that older versions and
 * other writers also touch. Anything that is not a usable string for a known
 * field is dropped rather than surfaced: a half-parsed goal shown to an agent
 * as fact is worse than no goal.
 */
export function parseTaskState(metadata: unknown): TaskState {
  const state: TaskState = {};
  if (!metadata || typeof metadata !== 'object') return state;
  const raw = (metadata as Record<string, unknown>).task_state;
  if (!raw || typeof raw !== 'object') return state;
  const bag = raw as Record<string, unknown>;
  for (const field of TASK_STATE_FIELDS) {
    const value = bag[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) state[field] = trimmed;
  }
  const updated = bag.updated_at;
  if (typeof updated === 'string' && updated.trim()) state.updated_at = updated.trim();
  return state;
}

/**
 * Normalise one incoming field value.
 *
 * An explicit empty string CLEARS the field and returns null — that is the
 * whole point of having it: a blocker that got resolved must be removable, and
 * a state that can only ever grow would keep injecting a blocker that is gone.
 * `undefined` means "not mentioned", which is different from "cleared".
 */
export function normalizeFieldValue(value: string): string | null {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > MAX_FIELD_CHARS ? `${flat.slice(0, MAX_FIELD_CHARS - 1).trimEnd()}…` : flat;
}

export interface TaskStateMerge {
  /** The state to persist. Identical object content to `previous` when nothing changed. */
  state: TaskState;
  /** Fields whose value actually differs from `previous`. */
  changed: TaskStateField[];
  /** One human-readable line per change, for the observation trail. */
  observations: string[];
}

/**
 * Apply a patch, reporting what genuinely changed.
 *
 * The `changed` list is what makes the storage bounded: a caller that writes
 * only when this is non-empty adds a row per real change, not per session. It
 * is also what keeps `updated_at` truthful — re-stating today's goal tomorrow
 * must not make the state look fresher than the thinking behind it.
 */
export function mergeTaskState(
  previous: TaskState,
  patch: Partial<Record<TaskStateField, string>>,
  now: string,
): TaskStateMerge {
  const state: TaskState = { ...previous };
  const changed: TaskStateField[] = [];
  const observations: string[] = [];

  for (const field of TASK_STATE_FIELDS) {
    const incoming = patch[field];
    if (incoming === undefined) continue;
    const normalized = normalizeFieldValue(incoming);
    const current = state[field];
    if (normalized === (current ?? null)) continue;
    changed.push(field);
    if (normalized === null) {
      delete state[field];
      observations.push(`${field} cleared`);
    } else {
      state[field] = normalized;
      observations.push(`${field}: ${normalized}`);
    }
  }

  if (changed.length > 0) state.updated_at = now;
  return { state, changed, observations };
}

/** True when there is nothing worth showing. */
export function isEmptyTaskState(state: TaskState): boolean {
  return TASK_STATE_FIELDS.every((field) => !state[field]);
}

const FIELD_LABELS: Record<TaskStateField, string> = {
  goal: 'Goal',
  next: 'Next',
  blocked: 'Blocked',
  done: 'Just finished',
};

/** Whole days between two instants, floored; null when the stamp is unusable. */
function ageInDays(updatedAt: string | undefined, now: Date): number | null {
  if (!updatedAt) return null;
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  return days >= 0 ? days : null;
}

/**
 * The block injected at session start.
 *
 * The age is part of the heading, not decoration. "Where you left off" reads
 * as *yesterday* whatever the truth is, and a goal that was written six weeks
 * ago is likely finished or abandoned — an agent that knows the age can weigh
 * it; one that does not will act on a stale goal with full confidence.
 */
export function taskStateLines(
  state: TaskState,
  project: string,
  now: Date = new Date(),
): string[] {
  if (isEmptyTaskState(state)) return [];
  const days = ageInDays(state.updated_at, now);
  const age = days === null ? '' : days === 0 ? ' (today)' : days === 1 ? ' (yesterday)' : ` (${days} days ago)`;
  const lines = [`Where "${project}" was left off${age}:`];
  for (const field of TASK_STATE_FIELDS) {
    const value = state[field];
    if (value) lines.push(`- ${FIELD_LABELS[field]}: ${value}`);
  }
  return lines;
}
