/**
 * The three one-shot repairs for data 4.8.1 wrote wrongly (#240, #241).
 *
 * Every case seeds the exact rows the defect produced — not a caricature —
 * into a real graph, reopens it so `migrateToCurrentSchema` runs, and then
 * asks three questions the diff cannot answer: does the invariant detector
 * go green, does search still find the text where it now lives, and does a
 * second open leave everything alone. The negative cases are the ones an
 * adversarial review found missing: a two-digit file count that ends in 0, a
 * heredoc that only feeds stdin, an archived target, a bucket with no
 * project tag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { createExplicitLesson } from '../../src/core/lesson-engine.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import {
  FUSED_LESSON_SPLIT_KEY,
  SESSION_DEDUPE_KEY,
  ZERO_EDIT_RETRACT_KEY,
  bashWritesFiles,
} from '../../src/storage/graph-repairs.js';
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

type Db = ReturnType<typeof openDatabase>;

/** Open, seed through `fn`, clear the repair markers, close — the pre-upgrade state. */
function seed(fn: (db: Db) => void): void {
  const db = openDatabase(dbPath);
  fn(db);
  db.prepare('DELETE FROM memesh_metadata WHERE key LIKE ? OR key LIKE ? OR key LIKE ?')
    .run(`${SESSION_DEDUPE_KEY}%`, `${ZERO_EDIT_RETRACT_KEY}%`, `${FUSED_LESSON_SPLIT_KEY}%`);
  closeDatabase();
}

function entityId(db: Db, name: string): number {
  return Number((db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id);
}

function insertEntity(db: Db, name: string, type: string, tags: string[] = [], status = 'active'): number {
  db.prepare('INSERT INTO entities (name, type, status) VALUES (?, ?, ?)').run(name, type, status);
  const id = entityId(db, name);
  for (const t of tags) db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, t);
  return id;
}

function observations(db: Db, name: string): string[] {
  return (db.prepare(
    'SELECT o.content FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id',
  ).all(name) as Array<{ content: string }>).map((r) => r.content);
}

function tagsOf(db: Db, name: string): string[] {
  return (db.prepare('SELECT tag FROM tags WHERE entity_id = ? ORDER BY tag').all(entityId(db, name)) as Array<{ tag: string }>)
    .map((t) => t.tag);
}

function statusOf(db: Db, name: string): string {
  return (db.prepare('SELECT status FROM entities WHERE name = ?').get(name) as { status: string }).status;
}

function runInvariants(): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [invariants, '--db', dbPath], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout + r.stderr };
}

/** Open once (the repair runs), return the handle; caller closes. */
function repaired(): Db {
  return openDatabase(dbPath);
}

const LESSON_A = ['Error: fake did not echo the write', 'Root cause: a', 'Fix: b', 'Prevention: c'];
const LESSON_B = ['Error: shared pattern list has three consumers', 'Root cause: d', 'Fix: e', 'Prevention: f'];
const LESSON_C = ['Error: zebra-token watcher grep exit is not a verdict', 'Root cause: g', 'Fix: h', 'Prevention: i'];
const nameA = `lesson-proj-${lessonSlug('fake did not echo the write')}`;
const nameB = `lesson-proj-${lessonSlug('shared pattern list has three consumers')}`;
const nameC = `lesson-proj-${lessonSlug('zebra-token watcher grep exit is not a verdict')}`;

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

    const db = repaired();
    expect(observations(db, 'session-abc-summary')).toEqual([
      'Significant session: 40 tool calls, 3 files edited',
      'Command: git status --short',
      'Command: npm view @pcircle/memesh version',
    ]);
    expect(observations(db, 'plain-note')).toEqual(['same', 'same']);
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(SESSION_DEDUPE_KEY)).toEqual({ value: '1' });
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
      const n = (repaired().prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
      closeDatabase();
      return n;
    };
    expect(count(), 'first open repairs').toBe(1);
    expect(count(), 'second open finds nothing to do').toBe(1);
  });
});

describe('#240 — a false "0 files edited" beside a Bash write is retracted', () => {
  it('rewrites the claim to what is known and leaves true summaries alone', () => {
    seed((db) => {
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      const bash = insertEntity(db, 'session-bash-summary', 'session-insight');
      ins.run(bash, 'Significant session: 25 tool calls, 0 files edited');
      ins.run(bash, "Command: cat > src/core/paths.ts <<'EOF'");
      // True sentences that share the suffix or the marks: none may change.
      const tenFiles = insertEntity(db, 'session-ten-summary', 'session-insight');
      ins.run(tenFiles, 'Significant session: 45 tool calls, 10 files edited');
      ins.run(tenFiles, "Command: cat > notes.md <<'EOF'");
      const stdinOnly = insertEntity(db, 'session-stdin-summary', 'session-insight');
      ins.run(stdinOnly, 'Significant session: 12 tool calls, 0 files edited');
      ins.run(stdinOnly, "Command: python3 - <<'PY'");
      ins.run(stdinOnly, 'Command: npm test 2>&1 | tee /tmp/t.log');
      const honest = insertEntity(db, 'session-honest-summary', 'session-insight');
      ins.run(honest, 'Significant session: 9 tool calls, 0 files edited');
      ins.run(honest, 'Command: git status --short');
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);

    const db = repaired();
    expect(observations(db, 'session-bash-summary')[0])
      .toBe('Significant session: 25 tool calls, files edited through Bash (count not recorded before 4.8.2)');
    expect(observations(db, 'session-ten-summary')[0]).toBe('Significant session: 45 tool calls, 10 files edited');
    expect(observations(db, 'session-stdin-summary')[0]).toBe('Significant session: 12 tool calls, 0 files edited');
    expect(observations(db, 'session-honest-summary')[0]).toBe('Significant session: 9 tool calls, 0 files edited');
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(ZERO_EDIT_RETRACT_KEY)).toEqual({ value: '1' });
    const kg = new KnowledgeGraph(db);
    expect(kg.search('Bash').map((e) => e.name)).toEqual(['session-bash-summary']);
    closeDatabase();

    expect(runInvariants().status).toBe(0);
  });

  it('recognises the write shapes the hook recognises, and nothing looser', () => {
    for (const cmd of [
      // The FIRST target is excluded (/tmp, /dev); the second is a real write.
      'Command: npm test 2>&1 | tee /tmp/t.log && echo done | tee CHANGELOG.md',
      "Command: cat > /dev/null <<EOF && cat > src/real.ts <<EOF",
      "Command: sed -i '' 's/a/b/' /tmp/x && sed -i '' 's/c/d/' src/real.ts",
      "Command: cat > src/a.ts <<'EOF'",
      "Command: sed -i 's/a/b/' src/a.ts",
      'Command: echo x | tee CHANGELOG.md',
      "Command: python3 -c \"from pathlib import Path; Path('x.py').write_text('y')\"",
      "Command: node -e \"require('fs').writeFileSync('x.json', '{}')\"",
    ]) expect(bashWritesFiles(cmd), cmd).toBe(true);
    for (const cmd of [
      "Command: python3 - <<'PY'",
      'Command: psql <<EOF',
      'Command: npm test 2>&1 | tee /tmp/t.log',
      'Command: cat > /dev/null',
      'Command: git diff | tee',
      'Command: echo "a << b"',
    ]) expect(bashWritesFiles(cmd), cmd).toBe(false);
  });
});

describe('#241 — lessons fused into one -other bucket are split apart', () => {
  it('moves every lesson to its own slug-named entity, rows intact, and archives the empty bucket', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'severity:critical', 'severity:minor', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)');
      for (const [i, line] of [...LESSON_A, ...LESSON_B, ...LESSON_C].entries()) {
        ins.run(id, line, `2026-08-0${1 + Math.floor(i / 4)} 10:00:0${i % 4}`);
      }
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);

    const db = repaired();
    expect(observations(db, 'lesson-proj-other')).toEqual([]);
    expect(statusOf(db, 'lesson-proj-other')).toBe('archived');
    expect(tagsOf(db, 'lesson-proj-other')).not.toContain('source:explicit');
    expect(observations(db, nameA)).toEqual(LESSON_A);
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
    expect(tagsOf(db, nameC)).toEqual(['error-pattern:other', 'project:proj', 'source:explicit']);

    // The split-out entity records where it came from and is titled like any other.
    const row = db.prepare('SELECT metadata, title, created_at FROM entities WHERE name = ?').get(nameC) as
      { metadata: string; title: string | null; created_at: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.split_from).toBe('lesson-proj-other');
    expect(typeof meta.signal_score, 'scored at insert — the backfill already ran this open').toBe('number');
    expect(row.title).toBe('zebra-token watcher grep exit is not a verdict');
    expect(row.created_at).toBe('2026-08-03 10:00:00');

    // Search follows the move: the bucket no longer answers for C's words, C does.
    const kg = new KnowledgeGraph(db);
    expect(kg.search('zebra').map((e) => e.name)).toEqual([nameC]);
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SPLIT_KEY)).toEqual({ value: '2' });
    // A rebuild is owed whenever anything moved and the graph records a
    // dimension at all (a keyword-only graph owes nothing).
    const dim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
    const owed = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get();
    expect(Boolean(owed)).toBe(Boolean(dim && parseInt(dim.value, 10) > 0));
    closeDatabase();

    expect(runInvariants().status).toBe(0);
  });

  it('appends onto an active slug entity, and revives an archived one instead of hiding the lesson in it', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(id, line);
      // A was re-learned after the upgrade and then forgotten (archived); B was re-learned and is active.
      const a = insertEntity(db, nameA, 'lesson_learned', ['project:proj', 'source:explicit'], 'archived');
      ins.run(a, 'Error: fake did not echo the write');
      const b = insertEntity(db, nameB, 'lesson_learned', ['project:proj', 'source:explicit']);
      ins.run(b, 'Error: shared pattern list has three consumers');
    });
    const db = repaired();
    // Rows keep their ids, so the moved (older) lesson sorts before the re-learned line.
    expect(observations(db, nameA)).toEqual([...LESSON_A, 'Error: fake did not echo the write']);
    expect(statusOf(db, nameA)).toBe('active');
    expect(observations(db, nameB)).toEqual([...LESSON_B, 'Error: shared pattern list has three consumers']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entities WHERE name IN (?, ?)').get(nameA, nameB) as { n: number }).n).toBe(2);
    const kg = new KnowledgeGraph(db);
    expect(kg.search('echo').map((e) => e.name)).toEqual([nameA]);
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('carries a single severity tag, and takes the project from the name when the tag is missing', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of LESSON_C) ins.run(id, line);
      const untagged = insertEntity(db, 'lesson-my-app-other', 'lesson_learned', ['source:explicit']);
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(untagged, line);
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);
    const db = repaired();
    expect(tagsOf(db, nameC)).toEqual(['error-pattern:other', 'project:proj', 'severity:major', 'source:explicit']);
    expect(observations(db, `lesson-my-app-${lessonSlug('shared pattern list has three consumers')}`)).toEqual(LESSON_B);
    expect(statusOf(db, 'lesson-my-app-other')).toBe('archived');
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('keeps the tag and stays active when a stray row keeps the bucket non-empty', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'source:explicit']);
      db.prepare("UPDATE entities SET metadata = ? WHERE id = ?").run(JSON.stringify({
        trust: 'untrusted',
        guard: { tool: 'Bash', pattern: 'rm -rf', enabled: true, proposal_id: 7, fires: 3 },
        evidence_for: [42],
        previous_namespace: 'team',
      }), id);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      ins.run(id, 'Note: this bucket picked up a stray line');
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(id, line);
    });
    const db = repaired();
    expect(observations(db, 'lesson-proj-other')).toEqual(['Note: this bucket picked up a stray line']);
    expect(statusOf(db, 'lesson-proj-other')).toBe('active');
    expect(tagsOf(db, 'lesson-proj-other')).toContain('source:explicit');
    // The bucket's metadata travels with the lessons it described — except the
    // facts that are one-per-entity: ONE accepted guard must not become two
    // guards firing twice, and back-pointers to relations the new row lacks.
    const meta = JSON.parse((db.prepare('SELECT metadata FROM entities WHERE name = ?').get(nameA) as { metadata: string }).metadata);
    expect(meta.trust).toBe('untrusted');
    expect(meta.guard, 'a guard is one acceptance, on one entity').toBeUndefined();
    expect(meta.evidence_for).toBeUndefined();
    expect(meta.previous_namespace).toBeUndefined();
    closeDatabase();
  });

  it('still splits a bucket whose metadata is unreadable, carrying nothing from it', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned', ['project:proj', 'source:explicit']);
      db.prepare('UPDATE entities SET metadata = ? WHERE id = ?').run('{not json', id);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(id, line);
    });
    const db = repaired();
    // A parse failure must not abort the migration (runOnceMigration would
    // swallow it and leave the bucket fused for 24h, silently).
    expect(observations(db, nameA)).toEqual(LESSON_A);
    const meta = JSON.parse((db.prepare('SELECT metadata FROM entities WHERE name = ?').get(nameA) as { metadata: string }).metadata);
    expect(Object.keys(meta).sort()).toEqual(['signal_score', 'split_from', 'title_source']);
    closeDatabase();
  });

  it('a lesson whose error merely ENDS with the word "other" still splits out', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned', ['project:proj', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of ['Error: could not reach the other', 'Root cause: a', 'Fix: b', 'Prevention: c', ...LESSON_A]) ins.run(id, line);
    });
    const db = repaired();
    expect(observations(db, `lesson-proj-${lessonSlug('could not reach the other')}`))
      .toEqual(['Error: could not reach the other', 'Root cause: a', 'Fix: b', 'Prevention: c']);
    expect(observations(db, nameA)).toEqual(LESSON_A);
    expect(statusOf(db, 'lesson-proj-other')).toBe('archived');
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('after a project rename, even a literal "other" lesson gets a digest-named entity', () => {
    seed((db) => {
      // renameProjectTag rewrites tags, never names: the bucket is still
      // lesson-old-other but carries project:new.
      const id = insertEntity(db, 'lesson-old-other', 'lesson_learned', ['project:new', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of ['Error: other', 'Root cause: ?', 'Fix: ?', 'Prevention: ?', ...LESSON_A]) ins.run(id, line);
      // A second bucket proves the literal text cannot alias any bucket.
      const idle = insertEntity(db, 'lesson-z-other', 'lesson_learned', ['project:z', 'source:explicit']);
      for (const line of ['Error: other', 'Root cause: ?', 'Fix: ?', 'Prevention: ?']) ins.run(idle, line);
    });
    const notes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { notes.push(String(chunk)); return true; });
    let db: Db;
    try { db = repaired(); } finally { spy.mockRestore(); }
    expect(notes.join('')).toContain('moved 3 lesson(s) out of 2 "-other" bucket(s)');
    expect(db.prepare('SELECT id FROM entities WHERE name = ?').get('lesson-new-other')).toBeUndefined();
    expect(observations(db, `lesson-new-${lessonSlug('other')}`)).toEqual(['Error: other', 'Root cause: ?', 'Fix: ?', 'Prevention: ?']);
    expect(statusOf(db, 'lesson-old-other')).toBe('archived');
    expect(statusOf(db, 'lesson-z-other')).toBe('archived');
    expect(observations(db, `lesson-new-${lessonSlug('fake did not echo the write')}`)).toEqual(LESSON_A);
    closeDatabase();
  });

  it('the digest prevents a bucket-shaped readable prefix from targeting itself', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-the-other', 'lesson_learned', ['project:proj', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of ['Error: the other', 'Root cause: a', 'Fix: b', 'Prevention: c']) ins.run(id, line);
    });
    const notes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { notes.push(String(chunk)); return true; });
    let db: Db;
    try { db = repaired(); } finally { spy.mockRestore(); }
    expect(notes.join('')).toContain('moved 1 lesson(s)');
    expect(observations(db, `lesson-proj-${lessonSlug('the other')}`)).toEqual(['Error: the other', 'Root cause: a', 'Fix: b', 'Prevention: c']);
    expect(statusOf(db, 'lesson-proj-the-other')).toBe('archived');
    expect(db.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get()).toBeDefined();
    closeDatabase();
  });

  it('reruns once from marker 1, canonicalizes a legacy readable-only lesson, and appends future learns to the digest entity', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-null-pointer-in-the-auth-path', 'lesson_learned',
        ['project:proj', 'error-pattern:null-reference', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)');
      for (const [i, line] of [
        'Error: Null pointer in the auth path',
        'Root cause: original',
        'Fix: add a null guard',
        'Prevention: cover the null path',
      ].entries()) ins.run(id, line, `2026-08-0${1 + Math.floor(i / 4)} 10:00:0${i % 4}`);
      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(FUSED_LESSON_SPLIT_KEY, '1');
    });

    const activeLessonNames = (): string[] => {
      const db = repaired();
      const names = (db.prepare(
        "SELECT name FROM entities WHERE type = 'lesson_learned' AND status = 'active' ORDER BY name",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      closeDatabase();
      return names;
    };

    const legacyName = 'lesson-proj-null-pointer-in-the-auth-path';
    const canonicalName = `lesson-proj-${lessonSlug('Null pointer in the auth path')}`;
    const db = repaired();
    expect(observations(db, canonicalName)).toEqual([
      'Error: Null pointer in the auth path',
      'Root cause: original',
      'Fix: add a null guard',
      'Prevention: cover the null path',
    ]);
    const firstRow = db.prepare(
      'SELECT o.id, o.created_at FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = ? ORDER BY o.id LIMIT 1',
    ).get(canonicalName) as { id: number; created_at: string };
    expect(firstRow).toEqual({ id: 1, created_at: '2026-08-01 10:00:00' });
    expect(observations(db, legacyName)).toEqual([]);
    expect(statusOf(db, legacyName)).toBe('archived');
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SPLIT_KEY)).toEqual({ value: '2' });

    const learned = createExplicitLesson('Null pointer in the auth path', 'keep the guard and assert it', 'proj');
    expect(learned.name).toBe(canonicalName);
    expect(observations(db, canonicalName)).toEqual([
      'Error: Null pointer in the auth path',
      'Root cause: original',
      'Fix: add a null guard',
      'Prevention: cover the null path',
      'Error: Null pointer in the auth path',
      'Root cause: Not specified',
      'Fix: keep the guard and assert it',
      'Prevention: Review similar code paths',
    ]);
    closeDatabase();

    expect(activeLessonNames()).toEqual([canonicalName]);
    expect(activeLessonNames()).toEqual([canonicalName]);
  });

  it('leaves caller-supplied recurring errorPattern identities alone when marker 1 reruns', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-null-reference', 'lesson_learned',
        ['project:proj', 'error-pattern:null-reference', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)');
      for (const [i, line] of [
        'Error: Null pointer in the auth path',
        'Root cause: original',
        'Fix: add a null guard',
        'Prevention: cover the null path',
      ].entries()) ins.run(id, line, `2026-08-0${1 + Math.floor(i / 4)} 10:00:0${i % 4}`);
      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(FUSED_LESSON_SPLIT_KEY, '1');
    });

    const db = repaired();
    expect(observations(db, 'lesson-proj-null-reference')).toEqual([
      'Error: Null pointer in the auth path',
      'Root cause: original',
      'Fix: add a null guard',
      'Prevention: cover the null path',
    ]);
    expect(statusOf(db, 'lesson-proj-null-reference')).toBe('active');
    expect(db.prepare('SELECT id FROM entities WHERE name = ?').get(`lesson-proj-${lessonSlug('Null pointer in the auth path')}`)).toBeUndefined();
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SPLIT_KEY)).toEqual({ value: '2' });
    closeDatabase();
  });

  it('does not rewrite a recurring test-failure identity that resembles a legacy readable name', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-test-failure', 'lesson_learned',
        ['project:proj', 'error-pattern:test-failure', 'severity:major', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [
        'Error: Test failure',
        'Root cause: assertion drift',
        'Fix: restore the expected fixture',
        'Prevention: run the focused test first',
      ]) ins.run(id, line);
      db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(FUSED_LESSON_SPLIT_KEY, '1');
    });

    const db = repaired();
    expect(observations(db, 'lesson-proj-test-failure')).toEqual([
      'Error: Test failure',
      'Root cause: assertion drift',
      'Fix: restore the expected fixture',
      'Prevention: run the focused test first',
    ]);
    expect(statusOf(db, 'lesson-proj-test-failure')).toBe('active');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities WHERE name LIKE ?').get('lesson-proj-test-failure-%')).toEqual({ n: 0 });
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SPLIT_KEY)).toEqual({ value: '2' });
    closeDatabase();
  });

  it('does not carry source:explicit when the bucket also holds auto-learned lessons', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'source:explicit', 'source:auto-learned']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(id, line);
    });
    const db = repaired();
    expect(tagsOf(db, nameA)).toEqual(['error-pattern:other', 'project:proj']);
    // The bucket keeps its auto-learned identity so the Stop hook's next
    // unclassified lesson lands in a bucket the explicit-lesson invariant ignores.
    expect(tagsOf(db, 'lesson-proj-other')).toEqual(['error-pattern:other', 'project:proj', 'source:auto-learned']);
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });
});
