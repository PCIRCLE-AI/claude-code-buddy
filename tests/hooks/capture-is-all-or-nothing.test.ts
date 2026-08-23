/**
 * `captureEntity` performs six writes that only mean anything together: the
 * entity row, its observations, its tags, and the contentless-FTS delete +
 * insert that make them findable. They were not in a transaction.
 *
 * A throw in the middle — a lock lost to the CLI, a full disk, an FTS
 * corruption — committed the prefix and dropped the rest. Both likely resting
 * places are invisible:
 *
 *   observations written, FTS row not  → a memory that exists and can never
 *                                        be recalled
 *   old FTS row deleted, new not written → a memory that simply stopped being
 *                                        findable
 *
 * And neither is ever retried, because every caller dedupes on the entity
 * NAME: `INSERT OR IGNORE` reports "already there" on the next session and
 * the half-written state is permanent.
 *
 * The failure is injected by wrapping the handle rather than by corrupting a
 * database, because the point is the ROLLBACK, and a real corruption would
 * also break the assertions that check it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { captureEntity, openHookDb } = require('../../scripts/hooks/_shared.js');

interface Row { c: number }

describe('a capture is all or nothing', () => {
  let dir: string;
  let dbPath: string;
  let handle: ReturnType<typeof openHookDb>['db'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-capture-atomic-'));
    dbPath = path.join(dir, 'kg.db');
    handle = openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true }).db;
  });

  afterEach(() => {
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function count(table: string): number {
    return (handle.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as Row).c;
  }

  /**
   * The same handle, except that preparing a statement matching `failOn`
   * throws. Everything else — including `transaction` — delegates, so the
   * rollback under test is the real one.
   */
  function failingAt(failOn: RegExp) {
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (failOn.test(sql)) throw new Error('injected: the write lock was lost');
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  const CAPTURE = {
    name: 'session-1-summary',
    type: 'session-insight',
    observations: ['the first fact', 'the second fact'],
    tags: ['source:auto-capture'],
    title: 'a captured session',
  };

  it('writes everything on the happy path — the anti-vacuity half', () => {
    // First, because every assertion below is about absence and this is the
    // one that says the writes happen at all.
    const result = captureEntity(handle, CAPTURE);

    expect(result?.isNew).toBe(true);
    expect(count('entities')).toBe(1);
    expect(count('observations')).toBe(2);
    expect(count('tags')).toBe(1);
    // The index too: every rollback assertion below is about rows, and a
    // capture that wrote rows but no FTS entry would satisfy all of them.
    expect(count('entities_fts'), 'nothing was indexed').toBeGreaterThan(0);
  });

  it('leaves no entity behind when the TAG insert throws', () => {
    expect(() => captureEntity(failingAt(/INSERT OR IGNORE INTO tags/), CAPTURE)).toThrow(/injected/);

    expect(count('entities'), 'an entity survived a failed capture').toBe(0);
    expect(count('observations'), 'observations survived a failed capture').toBe(0);
  });

  it('leaves no entity behind when the OBSERVATION insert throws', () => {
    expect(() => captureEntity(failingAt(/INSERT INTO observations/), CAPTURE)).toThrow(/injected/);

    expect(count('entities'), 'an entity with no observations was committed').toBe(0);
  });

  it('does not strand a SECOND capture half-applied on an existing entity', () => {
    // The worse shape: the entity already exists, so the FTS delete has real
    // indexed text to remove. A throw after that delete used to leave the
    // memory present and unfindable — and the next run's `INSERT OR IGNORE`
    // says "already there", so nothing ever repairs it.
    captureEntity(handle, CAPTURE);
    const observationsBefore = count('observations');

    expect(() => captureEntity(failingAt(/INSERT INTO entities_fts/), {
      ...CAPTURE,
      observations: ['a third fact'],
    })).toThrow(/injected/);

    expect(count('observations'), 'the failed re-capture kept its observations').toBe(observationsBefore);

    // The memory must still be findable: the FTS delete has to have rolled
    // back with everything else.
    const found = handle
      .prepare('SELECT e.name FROM entities_fts f JOIN entities e ON e.id = f.rowid WHERE entities_fts MATCH ?')
      .all('first') as Array<{ name: string }>;
    expect(found, 'the memory lost its index and cannot be recalled').toHaveLength(1);
    expect(found.map((r) => r.name)).toEqual(['session-1-summary']);
  });
});
