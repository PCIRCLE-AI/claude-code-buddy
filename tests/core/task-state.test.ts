/**
 * The one "where we are" per project, and the four ways it could quietly lie.
 *
 * This state is injected at the top of every session, so a wrong value here is
 * more expensive than a missing one: an agent acts on a stale goal with full
 * confidence. Each test pins one property that keeps it honest — it belongs to
 * exactly one project, a resolved blocker can actually be removed, re-stating
 * something does not make it look fresher than it is, and unusable stored data
 * is dropped rather than shown.
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_STATE_FIELDS,
  taskStateName,
  parseTaskState,
  normalizeFieldValue,
  mergeTaskState,
  isEmptyTaskState,
  taskStateLines,
  MAX_FIELD_CHARS,
  type TaskState,
} from '../../src/core/task-state.js';

const NOW = '2026-08-16T00:00:00.000Z';

describe('task-state', () => {
  it('keys the state by project, because entity names are globally unique', () => {
    // Without the project in the name, two repos share one row and every
    // session reads someone else's goal.
    expect(taskStateName('memesh')).not.toBe(taskStateName('other-repo'));
    expect(taskStateName('memesh')).toBe('task-state:memesh');
  });

  it('clears a field on an explicit empty string', () => {
    // The reason this exists: a blocker gets resolved. A state that can only
    // ever grow would keep injecting a blocker that is gone, and the agent
    // would keep working around it.
    const previous: TaskState = { goal: 'ship A1b', blocked: 'waiting on CI' };
    const { state, changed, observations } = mergeTaskState(previous, { blocked: '' }, NOW);

    expect(changed).toEqual(['blocked']);
    expect(state.blocked).toBeUndefined();
    expect(state.goal).toBe('ship A1b');
    expect(observations).toEqual(['blocked cleared']);
  });

  it('distinguishes "not mentioned" from "cleared"', () => {
    // undefined must leave a field alone — a caller setting only `next` must
    // not wipe the goal.
    const previous: TaskState = { goal: 'ship A1b', next: 'write tests' };
    const { state, changed } = mergeTaskState(previous, { next: 'open the PR' }, NOW);

    expect(changed).toEqual(['next']);
    expect(state.goal).toBe('ship A1b');
    expect(state.next).toBe('open the PR');
  });

  it('reports no change when a value is re-stated, and leaves the age alone', () => {
    // This is what bounds the storage: callers write only when something
    // changed, so the observation trail grows per CHANGE, not per session.
    // It is also what keeps the age honest — re-stating yesterday's goal today
    // must not make the thinking behind it look fresh.
    const previous: TaskState = { goal: 'ship A1b', updated_at: '2026-08-01T00:00:00.000Z' };
    const { state, changed, observations } = mergeTaskState(previous, { goal: 'ship A1b' }, NOW);

    expect(changed).toEqual([]);
    expect(observations).toEqual([]);
    expect(state.updated_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('normalises whitespace and bounds a single field', () => {
    expect(normalizeFieldValue('  ship   A1b\n  today ')).toBe('ship A1b today');
    expect(normalizeFieldValue('   ')).toBeNull();

    const long = 'x'.repeat(MAX_FIELD_CHARS + 50);
    const clipped = normalizeFieldValue(long)!;
    expect(clipped.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('drops stored values it cannot use instead of showing them', () => {
    // metadata is free-form JSON that older versions and other writers touch.
    // A half-parsed goal presented to an agent as fact is worse than no goal.
    expect(isEmptyTaskState(parseTaskState(null))).toBe(true);
    expect(isEmptyTaskState(parseTaskState('not an object'))).toBe(true);
    expect(isEmptyTaskState(parseTaskState({ task_state: 'nope' }))).toBe(true);

    const mixed = parseTaskState({ task_state: { goal: 'real goal', next: 42, blocked: '   ' } });
    expect(mixed.goal).toBe('real goal');
    expect(mixed.next).toBeUndefined();
    expect(mixed.blocked).toBeUndefined();
  });

  it('states how old it is, so a stale goal is not read as a fresh one', () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    const heading = (updated: string) =>
      taskStateLines({ goal: 'g', updated_at: updated }, 'memesh', now)[0];

    expect(heading('2026-08-16T01:00:00.000Z')).toContain('today');
    expect(heading('2026-08-15T01:00:00.000Z')).toContain('yesterday');
    expect(heading('2026-07-16T12:00:00.000Z')).toContain('31 days ago');

    // An unusable stamp must not produce a wrong age — it produces none.
    expect(heading('not-a-date')).not.toMatch(/days ago|today|yesterday/);
  });

  it('renders the fields in the order a session needs to read them', () => {
    const lines = taskStateLines(
      { done: 'landed A1a', blocked: 'CI red on Windows', next: 'open the PR', goal: 'ship A1b' },
      'memesh',
      new Date('2026-08-16T12:00:00.000Z'),
    );
    const fields = lines.slice(1).map((l) => l.replace(/^- ([^:]+):.*$/, '$1'));
    expect(fields).toEqual(['Goal', 'Next', 'Blocked', 'Had just finished']);
    // Every declared field is renderable — a field added to the constant
    // without a label would silently never show up.
    expect(fields).toHaveLength(TASK_STATE_FIELDS.length);
  });

  it('says nothing at all when there is nothing to say', () => {
    // An empty heading promising state that is not there costs tokens and
    // reads as "memesh lost it".
    expect(taskStateLines({}, 'memesh')).toEqual([]);
    expect(taskStateLines({ updated_at: NOW }, 'memesh')).toEqual([]);
  });
});
