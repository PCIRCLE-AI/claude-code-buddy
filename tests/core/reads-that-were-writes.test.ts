/**
 * Two reads that quietly changed the ranking of the memories they touched.
 *
 * `access_count` and `last_accessed_at` are 20% of the score. Every recall
 * bumps them, and that is correct — a recall IS a use. These two were not
 * recalls.
 *
 *   `export`   `exportMemories` calls `kg.search`, so taking a backup bumped
 *              the counter and stamped "used just now" on up to a thousand
 *              memories. The act of copying the graph re-sorted it.
 *
 *   `createLesson`  asked "does a lesson with this exact name exist?" with
 *              `recall({ query: name, limit: 1 })` — a fuzzy search against an
 *              exact key. When the lesson did NOT exist it matched some other
 *              memory (the old `existing[0].name !== name` clause is its
 *              author's evidence for that), and bumped THAT memory. So every
 *              LLM-generated lesson manufactured one "memory reused this
 *              week" — the dashboard's headline number.
 *
 * `listByType` already drew this line by simply never calling `trackAccess`
 * ("a type browse is a catalogue read"). These paths share a query with real
 * recalls, so they say so with a flag instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { exportMemories } from '../../src/core/serializer.js';
import { createLesson } from '../../src/core/lesson-engine.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { trackAccess } from '../../src/storage/conflicts.js';

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-readwrite-'));
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

interface Accounting { access_count: number; last_accessed_at: string | null }

function accountingFor(name: string): Accounting {
  return getDatabase()
    .prepare('SELECT access_count, last_accessed_at FROM entities WHERE name = ?')
    .get(name) as unknown as Accounting;
}

describe('export is a backup, not a use', () => {
  it('leaves access_count and last_accessed_at untouched', () => {
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('backed-up', 'note', { observations: ['a fact worth keeping'] });
    const before = accountingFor('backed-up');

    const result = exportMemories({});

    // Fixture first: an export that returned nothing would leave the
    // counters alone for the wrong reason.
    expect(result.entity_count, 'fixture: the export found no memories').toBe(1);

    const after = accountingFor('backed-up');
    expect(after.access_count, 'the backup counted itself as a use').toBe(before.access_count);
    expect(after.last_accessed_at, 'the backup restamped the memory as freshly used')
      .toBe(before.last_accessed_at);
  });

  it('a real recall DOES still count — the anti-vacuity half', () => {
    // If `trackAccess` had simply stopped working, the test above would pass
    // and 20% of the ranking would be dead.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('recalled', 'note', { observations: ['a searchable fact'] });
    const before = accountingFor('recalled');

    const found = kg.search('searchable');
    expect(found, 'fixture: the search found nothing').toHaveLength(1);

    expect(accountingFor('recalled').access_count).toBeGreaterThan(before.access_count);
  });

  it('exports the same memories either way', () => {
    // The flag must change the accounting and nothing else.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('one', 'note', { observations: ['first'] });
    kg.createEntity('two', 'note', { observations: ['second'] });

    const names = exportMemories({}).entities.map((e) => e.name).sort();
    expect(names).toEqual(['one', 'two']);
  });
});

describe('recall access accounting is best-effort only for read-only SQLite', () => {
  it('returns matching memories through a real read-only database handle', () => {
    const writable = new KnowledgeGraph(getDatabase());
    writable.createEntity('sandbox-memory', 'note', {
      observations: ['sandbox searchable payload'],
    });
    const expectedPayload = writable.search('searchable', { countAsAccess: false });
    expect(expectedPayload).toHaveLength(1);
    const before = accountingFor('sandbox-memory');

    closeDatabase();
    const reader = new MemeshDatabase(path.join(dir, 'kg.db'), {
      readOnly: true,
      allowExtension: true,
    });
    try {
      const found = new KnowledgeGraph(reader).search('searchable');
      expect(found).toEqual(expectedPayload);

      const after = reader
        .prepare('SELECT access_count, last_accessed_at FROM entities WHERE name = ?')
        .get('sandbox-memory') as unknown as Accounting;
      expect(after).toEqual(before);
    } finally {
      reader.close();
    }
  });

  it('does not hide non-readonly accounting failures', () => {
    const failure = new Error('database is locked');
    const failingDb = {
      prepare: () => ({ run: () => { throw failure; } }),
    } as unknown as MemeshDatabase;

    expect(() => trackAccess(failingDb, [1])).toThrow(failure);
  });
});

describe('a lesson existence check does not touch another memory', () => {
  const LESSON = {
    error: 'the build failed',
    rootCause: 'a missing dependency',
    fix: 'install it',
    prevention: 'pin the version',
    errorPattern: 'missing-dep',
    fixPattern: 'install',
    severity: 'minor' as const,
  };

  it('leaves an unrelated memory alone when the lesson is new', () => {
    // The exact live shape: nothing named `lesson-*` exists, so the old fuzzy
    // search fell through to whatever else the query happened to match.
    const kg = new KnowledgeGraph(getDatabase());
    kg.createEntity('lesson-notes-about-the-build', 'note', {
      observations: ['unrelated notes that a fuzzy search for the lesson name would match'],
    });
    const before = accountingFor('lesson-notes-about-the-build');

    const created = createLesson(LESSON, 'someproject');

    expect(created.isNew, 'a brand-new lesson was reported as an update').toBe(true);
    const after = accountingFor('lesson-notes-about-the-build');
    expect(after.access_count, 'writing a lesson counted a use of an unrelated memory')
      .toBe(before.access_count);
    expect(after.last_accessed_at).toBe(before.last_accessed_at);
  });

  it('still reports isNew=false on the second write — the anti-vacuity half', () => {
    // A check hardwired to "new" would satisfy the test above and break the
    // dashboard's new-vs-updated accounting instead.
    createLesson(LESSON, 'someproject');
    expect(createLesson(LESSON, 'someproject').isNew).toBe(false);
  });
});
