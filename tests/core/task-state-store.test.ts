/**
 * task-state against a real database and through the real MCP tool.
 *
 * The unit tests in task-state.test.ts pin the field rules. These pin the
 * things only a database can be wrong about: that two projects do not share
 * one state, that the state survives a round trip through metadata, that a
 * re-statement writes nothing, and that the tool's read path is told apart
 * from its write path by which KEYS arrived rather than by their truthiness —
 * because `blocked: ""` is a write that clears, and reading it as "nothing to
 * do" would make a resolved blocker permanent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { handleTool } from '../../src/mcp/tools.js';
import { getTaskState, setTaskState } from '../../src/core/task-state-store.js';
import { taskStateName } from '../../src/core/task-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-taskstate-'));
  openDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const payload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

describe('task-state store', () => {
  it('keeps each project’s state separate', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    setTaskState({ project: 'beta', patch: { goal: 'ship beta' } });

    expect(getTaskState('alpha').state.goal).toBe('ship alpha');
    expect(getTaskState('beta').state.goal).toBe('ship beta');
  });

  it('survives the round trip through metadata, not through observation order', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'first goal' } });
    setTaskState({ project: 'alpha', patch: { goal: 'second goal', next: 'a step' } });

    // The current answer is one value in metadata. Reading it out of the
    // observation trail would mean guessing which line is newest.
    expect(getTaskState('alpha').state).toMatchObject({ goal: 'second goal', next: 'a step' });

    // The trail is still there — it is the history, and it holds BOTH goals.
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { id: number };
    const observations = getDatabase()
      .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
      .all(row.id) as Array<{ content: string }>;
    expect(observations.map((o) => o.content)).toEqual([
      'goal: first goal',
      'goal: second goal',
      'next: a step',
    ]);
  });

  it('writes nothing when a value is re-stated', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    const before = getTaskState('alpha').state.updated_at;

    const again = setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    expect(again.changed).toEqual([]);
    expect(getTaskState('alpha').state.updated_at).toBe(before);

    // No second observation either — this is what bounds the row's growth.
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { id: number };
    const count = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM observations WHERE entity_id = ?')
      .get(row.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('creates nothing at all when the write turns out to be a no-op', () => {
    // Clearing a field that was never set changes nothing, so nothing should
    // exist afterwards. Without the early return this still reaches
    // `remember()`, which creates the row — and every project an agent merely
    // *asked* about would accumulate an empty task-state memory.
    const result = setTaskState({ project: 'ghost', patch: { blocked: '' } });
    expect(result.changed).toEqual([]);

    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('ghost'));
    expect(row).toBeUndefined();
  });

  it('carries the project tag, so session-start’s project query finds it', () => {
    // Without this tag the state exists but the hook that injects it never
    // sees it — a read path with an invisible writer.
    setTaskState({ project: 'alpha', patch: { goal: 'ship alpha' } });
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { id: number };
    const tags = getDatabase()
      .prepare('SELECT tag FROM tags WHERE entity_id = ?')
      .all(row.id) as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toContain('project:alpha');
  });

  it('titles the memory with the goal instead of the machine key', () => {
    setTaskState({ project: 'alpha', patch: { goal: 'ship the topology injection' } });
    const row = getDatabase()
      .prepare('SELECT title FROM entities WHERE name = ?')
      .get(taskStateName('alpha')) as { title: string | null };
    expect(row.title).toBe('ship the topology injection');
  });
});

describe('task_state MCP tool', () => {
  it('reads with no arguments instead of writing an empty state', async () => {
    const read = payload(await handleTool('task_state', { project: 'alpha' }));
    expect(read.state).toEqual({});
    // A read must not create the row — otherwise every session start would
    // leave an empty task-state memory behind.
    const row = getDatabase()
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(taskStateName('alpha'));
    expect(row).toBeUndefined();
  });

  it('records what it was given and reads it back', async () => {
    await handleTool('task_state', { project: 'alpha', goal: 'ship A1b', next: 'open the PR' });
    const read = payload(await handleTool('task_state', { project: 'alpha' }));
    expect(read.state).toMatchObject({ goal: 'ship A1b', next: 'open the PR' });
  });

  it('treats an empty string as a clear, not as an absent field', async () => {
    // The whole reason the field exists: blockers get resolved. If `""` were
    // read as "nothing passed", this tool could add a blocker and never
    // remove it, and every future session would work around a phantom.
    await handleTool('task_state', { project: 'alpha', goal: 'ship A1b', blocked: 'CI is red' });
    expect(payload(await handleTool('task_state', { project: 'alpha' })).state.blocked).toBe('CI is red');

    const cleared = payload(await handleTool('task_state', { project: 'alpha', blocked: '' }));
    expect(cleared.changed).toEqual(['blocked']);

    const after = payload(await handleTool('task_state', { project: 'alpha' })).state;
    expect(after.blocked).toBeUndefined();
    expect(after.goal).toBe('ship A1b');
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    // additionalProperties: false — a model inventing `priority` must be told,
    // not quietly ignored while it believes the value was stored.
    const result = await handleTool('task_state', { project: 'alpha', priority: 'high' });
    expect(JSON.stringify(result)).toMatch(/priority|unrecognized|invalid/i);
  });
});
