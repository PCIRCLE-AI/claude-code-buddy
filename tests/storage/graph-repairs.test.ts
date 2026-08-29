/**
 * The two one-shot repairs for data 4.8.1 wrote wrongly (#240, #241).
 *
 * Every case seeds the exact rows the defect produced — not a caricature —
 * into a real graph, reopens it so `migrateToCurrentSchema` runs, and then
 * asks three questions the diff cannot answer: does the invariant detector
 * go green, does search still find the text where it now lives, and does a
 * second open leave everything alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { FUSED_LESSON_SPLIT_KEY, SESSION_DEDUPE_KEY, ZERO_EDIT_RETRACT_KEY } from '../../src/storage/graph-repairs.js';
import { lessonSlug } from '../../src/core/lesson-slug.js';

const invariants = path.resolve('scripts/audit/memory-invariants.mjs');

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-repair-'));
  dbPath = path.join(dir, 'kg.db');
});
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  removeTempDir(dir);
});

/** Open, seed through `fn`, clear the repair markers, close — the pre-upgrade state. */
function seed(fn: (db: ReturnType<typeof openDatabase>) => void): void {
  const db = openDatabase(dbPath);
  fn(db);
  db.prepare("DELETE FROM memesh_metadata WHERE key LIKE ? OR key LIKE ? OR key LIKE ?")
    .run(`${SESSION_DEDUPE_KEY}%`, `${ZERO_EDIT_RETRACT_KEY}%`, `${FUSED_LESSON_SPLIT_KEY}%`);
  closeDatabase();
}

function entityId(db: ReturnType<typeof openDatabase>, name: string): number {
  return Number((db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id);
}

function insertEntity(db: ReturnType<typeof openDatabase>, name: string, type: string, tags: string[] = []): number {
  db.prepare("INSERT INTO entities (name, type, status) VALUES (?, ?, 'active')").run(name, type);
  const id = entityId(db, name);
  for (const t of tags) db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, t);
  return id;
}

function observations(db: ReturnType<typeof openDatabase>, name: string): string[] {
  return (db.prepare(
    'SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
  ).all(name) as Array<{ content: string }>).map((r) => r.content);
}

function runInvariants(): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [invariants, '--db', dbPath], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout + r.stderr };
}

const LESSON_A = ['Error: fake did not echo the write', 'Root cause: a', 'Fix: b', 'Prevention: c'];
const LESSON_B = ['Error: shared pattern list has three consumers', 'Root cause: d', 'Fix: e', 'Prevention: f'];
const LESSON_C = ['Error: zebra-token watcher grep exit is not a verdict', 'Root cause: g', 'Fix: h', 'Prevention: i'];

describe('#240 — duplicate session observations are removed once', () => {
  it('keeps one of each and the invariant detector goes green', () => {
    seed((db) => {
      const id = insertEntity(db, 'session-abc-summary', 'session-insight');
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (let stop = 0; stop < 4; stop++) {
        ins.run(id, 'Significant session: 40 tool calls, 3 files edited');
        ins.run(id, 'Command: git status --short');
        ins.run(id, 'Command: npm view @pcircle/memesh version');
      }
      // A non-session entity with repeats is NOT the hook's defect and is left alone.
      const other = insertEntity(db, 'plain-note', 'note');
      ins.run(other, 'same'); ins.run(other, 'same');
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);

    const db = openDatabase(dbPath); // the repair runs here
    expect(observations(db, 'session-abc-summary')).toEqual([
      'Significant session: 40 tool calls, 3 files edited',
      'Command: git status --short',
      'Command: npm view @pcircle/memesh version',
    ]);
    expect(observations(db, 'plain-note')).toEqual(['same', 'same']);
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(SESSION_DEDUPE_KEY)).toEqual({ value: '1' });
    // FTS was re-derived: the entity is still findable, exactly once.
    const kg = new KnowledgeGraph(db);
    expect(kg.search('Significant').map((e) => e.name)).toEqual(['session-abc-summary']);
    closeDatabase();

    expect(runInvariants().status).toBe(0);
  });

  it('is idempotent: a second open changes nothing', () => {
    seed((db) => {
      const id = insertEntity(db, 'session-def-summary', 'session-insight');
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      ins.run(id, 'x'); ins.run(id, 'x');
    });
    const count = (): number => {
      const n = (openDatabase(dbPath).prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
      closeDatabase();
      return n;
    };
    expect(count(), 'first open repairs').toBe(1);
    expect(count(), 'second open finds nothing to do').toBe(1);
  });
});

describe('#240 — a false "0 files edited" beside a Bash write is retracted', () => {
  it('rewrites the claim to what is known and leaves honest summaries alone', () => {
    seed((db) => {
      const bash = insertEntity(db, 'session-bash-summary', 'session-insight');
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      ins.run(bash, 'Significant session: 25 tool calls, 0 files edited');
      ins.run(bash, "Command: cat > src/core/paths.ts <<'EOF'");
      const honest = insertEntity(db, 'session-honest-summary', 'session-insight');
      ins.run(honest, 'Significant session: 9 tool calls, 0 files edited');
      ins.run(honest, 'Command: git status --short');
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);

    const db = openDatabase(dbPath);
    expect(observations(db, 'session-bash-summary')[0])
      .toBe('Significant session: 25 tool calls, files edited through Bash (count not recorded before 4.8.2)');
    expect(observations(db, 'session-honest-summary')[0]).toBe('Significant session: 9 tool calls, 0 files edited');
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(ZERO_EDIT_RETRACT_KEY)).toEqual({ value: '1' });
    const kg = new KnowledgeGraph(db);
    expect(kg.search('Bash').map((e) => e.name)).toEqual(['session-bash-summary']);
    closeDatabase();

    expect(runInvariants().status).toBe(0);
  });
});

describe('#241 — lessons fused into one -other bucket are split apart', () => {
  it('moves every lesson after the first to its own slug-named entity, rows intact', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'severity:critical', 'severity:minor', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)');
      for (const [i, line] of [...LESSON_A, ...LESSON_B, ...LESSON_C].entries()) {
        ins.run(id, line, `2026-08-0${1 + Math.floor(i / 4)} 10:00:0${i % 4}`);
      }
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);

    const db = openDatabase(dbPath);
    const nameB = `lesson-proj-${lessonSlug('shared pattern list has three consumers')}`;
    const nameC = `lesson-proj-${lessonSlug('zebra-token watcher grep exit is not a verdict')}`;

    expect(observations(db, 'lesson-proj-other')).toEqual(LESSON_A);
    expect(observations(db, nameB)).toEqual(LESSON_B);
    expect(observations(db, nameC)).toEqual(LESSON_C);

    // Moved, not copied: the original row ids and timestamps survive.
    const cRow = db.prepare(
      'SELECT o.id, o.created_at FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id LIMIT 1',
    ).get(nameC) as { id: number; created_at: string };
    expect(cRow.id).toBe(9);
    expect(cRow.created_at).toBe('2026-08-03 10:00:00');

    // Tags: project / pattern / source carried; severity NOT, because the
    // bucket had two and which lesson was critical is not recorded anywhere.
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(entityId(db, nameC)) as Array<{ tag: string }>)
      .map((t) => t.tag);
    expect(tags).toEqual(['error-pattern:other', 'project:proj', 'source:explicit']);

    // The split-out entity records where it came from and is titled like any other.
    const row = db.prepare('SELECT metadata, title, created_at FROM entities WHERE name = ?').get(nameC) as
      { metadata: string; title: string | null; created_at: string };
    expect(JSON.parse(row.metadata).split_from).toBe('lesson-proj-other');
    expect(row.title).toBe('zebra-token watcher grep exit is not a verdict');
    expect(row.created_at).toBe('2026-08-03 10:00:00');

    // Search follows the move: the bucket no longer answers for C's words, C does.
    const kg = new KnowledgeGraph(db);
    expect(kg.search('zebra').map((e) => e.name)).toEqual([nameC]);
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SPLIT_KEY)).toEqual({ value: '1' });
    // Vectors for the moved text are stale wherever they exist, so a rebuild is
    // owed whether or not sqlite-vec loaded in this process — but only when the
    // graph records a dimension at all (a keyword-only graph owes nothing).
    const dim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
    const owed = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get();
    expect(Boolean(owed)).toBe(Boolean(dim && parseInt(dim.value, 10) > 0));
    closeDatabase();

    expect(runInvariants().status).toBe(0);
  });

  it('appends onto a slug entity that already exists instead of creating a twin', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(id, line);
      // The same lesson B was re-learned AFTER the upgrade, so its slug entity already exists.
      const nameB = `lesson-proj-${lessonSlug('shared pattern list has three consumers')}`;
      const existing = insertEntity(db, nameB, 'lesson_learned', ['project:proj', 'source:explicit']);
      ins.run(existing, 'Error: shared pattern list has three consumers');
    });
    const db = openDatabase(dbPath);
    const nameB = `lesson-proj-${lessonSlug('shared pattern list has three consumers')}`;
    // Rows keep their ids, so the moved (older) lesson sorts before the re-learned line.
    expect(observations(db, nameB)).toEqual([...LESSON_B, 'Error: shared pattern list has three consumers']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities WHERE name = ?').get(nameB)).toEqual({ n: 1 });
  });

  it('carries a single severity tag onto a created entity', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [...LESSON_A, ...LESSON_C]) ins.run(id, line);
    });
    const db = openDatabase(dbPath);
    const nameC = `lesson-proj-${lessonSlug('zebra-token watcher grep exit is not a verdict')}`;
    const tags = (db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(entityId(db, nameC)) as Array<{ tag: string }>)
      .map((t) => t.tag);
    expect(tags).toEqual(['error-pattern:other', 'project:proj', 'severity:major', 'source:explicit']);
  });

  it('leaves a bucket holding a single lesson, and one without a project tag, alone', () => {
    seed((db) => {
      const one = insertEntity(db, 'lesson-proj-other', 'lesson_learned', ['project:proj', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of LESSON_A) ins.run(one, line);
      const orphan = insertEntity(db, 'lesson-x-other', 'lesson_learned', ['source:explicit']);
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(orphan, line);
    });
    const db = openDatabase(dbPath);
    expect(observations(db, 'lesson-proj-other')).toEqual(LESSON_A);
    expect(observations(db, 'lesson-x-other')).toEqual([...LESSON_A, ...LESSON_B]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n).toBe(2);
  });
});
