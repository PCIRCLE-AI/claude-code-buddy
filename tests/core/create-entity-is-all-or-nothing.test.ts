/**
 * `KnowledgeGraph.createEntity` is all or nothing.
 *
 * `tests/hooks/capture-is-all-or-nothing.test.ts` proves this for the hooks'
 * `captureEntity`. This is the same property for the writer that every OTHER
 * surface uses — `remember`, `import`, `dream accept`, the weekly summary,
 * the HTTP and MCP routes — and it was the one left in autocommit while the
 * three lowest-traffic writers (`archiveEntity`, `deleteEntity`,
 * `clearEntityData`) got transactions.
 *
 * The failure it prevents is invisible in both of its likely resting places:
 * observations written with no FTS row (a memory that exists and can never be
 * recalled), or the old FTS row deleted and the new one not written. And
 * neither is retried, because `INSERT OR IGNORE` on the entity name means the
 * next write reports "already there".
 *
 * The failure is injected by wrapping the handle rather than by corrupting a
 * database, because the point under test is the ROLLBACK.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-create-atomic-'));
  saved = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = dir;
  try { closeDatabase(); } catch { /* none open */ }
  openDatabase(path.join(dir, 'kg.db'));
});

afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (saved === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = saved;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function count(table: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

/**
 * The live handle, except that preparing a statement matching `failOn` throws.
 * Everything else — including `transaction` — delegates, so the rollback under
 * test is the real one.
 */
function graphFailingAt(failOn: RegExp): KnowledgeGraph {
  const real = getDatabase();
  const proxy = new Proxy(real, {
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
  return new KnowledgeGraph(proxy as unknown as ReturnType<typeof getDatabase>);
}

describe('createEntity is all or nothing', () => {
  it('writes everything on the happy path — the anti-vacuity half', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('a-memory', 'note', {
      observations: ['the first fact', 'the second fact'],
      tags: ['project:test'],
    });

    expect(count('entities')).toBe(1);
    expect(count('observations')).toBe(2);
    expect(count('tags')).toBe(1);
    expect(count('entities_fts'), 'nothing was indexed').toBeGreaterThan(0);
  });

  it('leaves no entity behind when the TAG insert throws', () => {
    expect(() => graphFailingAt(/INSERT OR IGNORE INTO tags/).createEntity('doomed', 'note', {
      observations: ['a fact'],
      tags: ['project:test'],
    })).toThrow(/injected/);

    expect(count('entities'), 'an entity survived a failed create').toBe(0);
    expect(count('observations'), 'observations survived a failed create').toBe(0);
  });

  it('leaves no entity behind when the FTS insert throws', () => {
    // The worst resting place: the row and its observations committed, and
    // nothing indexed — a memory that exists and can never be recalled.
    expect(() => graphFailingAt(/INSERT INTO entities_fts/).createEntity('doomed', 'note', {
      observations: ['a fact'],
    })).toThrow(/injected/);

    expect(count('entities')).toBe(0);
    expect(count('observations')).toBe(0);
  });

  it('leaves an entity that was ALREADY there exactly as it was', () => {
    // `createEntity` on an existing name appends. A throw part-way through
    // that append must not take the memory that was already stored.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('existing', 'note', { observations: ['the original fact'], tags: ['keep:me'] });
    const before = count('observations');

    expect(() => graphFailingAt(/INSERT OR IGNORE INTO tags/).createEntity('existing', 'note', {
      observations: ['a second fact'],
      tags: ['project:test'],
    })).toThrow(/injected/);

    expect(count('observations'), 'the failed append kept its observation').toBe(before);
    const found = new KnowledgeGraph(getDatabase()).search('original');
    expect(found.map((e) => e.name), 'the memory lost its index').toEqual(['existing']);
  });
});
