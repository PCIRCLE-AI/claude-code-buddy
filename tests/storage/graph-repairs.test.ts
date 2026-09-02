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
  AGENT_SCOPE_PATH_KEY,
  ARCHIVED_FTS_ROWS_KEY,
  ARCHIVED_VECTOR_ROWS_KEY,
  FUSED_LESSON_SHELL_HISTORY_RESET_KEY,
  FUSED_LESSON_SPLIT_KEY,
  SESSION_DEDUPE_KEY,
  ZERO_EDIT_RETRACT_KEY,
  bashWritesFiles,
  dropArchivedIndexRows,
  normalizeAgentScopePaths,
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
  db.prepare(
    'DELETE FROM memesh_metadata WHERE key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ? OR key LIKE ?',
  ).run(
    `${SESSION_DEDUPE_KEY}%`,
    `${ZERO_EDIT_RETRACT_KEY}%`,
    `${FUSED_LESSON_SPLIT_KEY}%`,
    `${ARCHIVED_FTS_ROWS_KEY}%`,
    `${ARCHIVED_VECTOR_ROWS_KEY}%`,
    `${FUSED_LESSON_SHELL_HISTORY_RESET_KEY}%`,
    `${AGENT_SCOPE_PATH_KEY}%`,
  );
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

function recallOf(db: Db, name: string): { hits: number; misses: number } {
  const row = db.prepare('SELECT recall_hits AS hits, recall_misses AS misses FROM entities WHERE name = ?')
    .get(name) as { hits: number | null; misses: number | null };
  return { hits: row.hits ?? 0, misses: row.misses ?? 0 };
}

function metadataOf(db: Db, name: string): Record<string, unknown> {
  const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: string | null };
  return row.metadata ? JSON.parse(row.metadata) : {};
}

function setRecall(db: Db, name: string, hits: number, misses: number): void {
  db.prepare('UPDATE entities SET recall_hits = ?, recall_misses = ? WHERE name = ?').run(hits, misses, name);
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

describe('#240 — duplicate observations are removed once, on ANY entity', () => {
  it('keeps one of each and the invariant detector goes green', () => {
    seed((db) => {
      const id = insertEntity(db, 'session-abc-summary', 'session-insight');
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (let stop = 0; stop < 4; stop++) {
        ins.run(id, 'Significant session: 40 tool calls, 3 files edited');
        ins.run(id, 'Command: git status --short');
        ins.run(id, 'Command: npm view @pcircle/memesh version');
      }
      // Version 1 of this pass filtered `e.name LIKE 'session-%'`, so the two
      // families below — the ones that actually held 2,202 duplicate rows on
      // the maintainer's graph — were unreachable by it. They are the reason
      // the scope is now every entity.
      const pre = insertEntity(db, 'pre-compact-019ff9f6-6b8f', 'session-summary');
      for (let compaction = 0; compaction < 3; compaction++) {
        ins.run(pre, 'Compaction reason: auto');
        ins.run(pre, 'Tool calls: 0');
      }
      const commit = insertEntity(db, 'commit-32e98b8', 'commit');
      for (let capture = 0; capture < 2; capture++) {
        ins.run(commit, 'fix(memory): stop re-appending the same observation');
        ins.run(commit, 'Branch: main');
        ins.run(commit, 'Diff stats: 3 files changed, 45 insertions(+), 12 deletions(-)');
      }
      // A name nothing in this project writes, to pin that the pass is keyed
      // to the QUESTION and not to a third name pattern.
      const other = insertEntity(db, 'plain-note', 'note');
      ins.run(other, 'same'); ins.run(other, 'same');
      // A history log: the duplicate is unreachable (no reader selects
      // observations.created_at) so it is repaired like any other.
      const task = insertEntity(db, 'task-state:proj', 'task-state');
      ins.run(task, 'next cleared'); ins.run(task, 'done: shipped'); ins.run(task, 'next cleared');
    });
    expect(runInvariants().status, 'fixture must reproduce the defect before repair').toBe(1);

    const db = repaired();
    expect(observations(db, 'session-abc-summary')).toEqual([
      'Significant session: 40 tool calls, 3 files edited',
      'Command: git status --short',
      'Command: npm view @pcircle/memesh version',
    ]);
    expect(observations(db, 'pre-compact-019ff9f6-6b8f')).toEqual([
      'Compaction reason: auto',
      'Tool calls: 0',
    ]);
    expect(observations(db, 'commit-32e98b8')).toEqual([
      'fix(memory): stop re-appending the same observation',
      'Branch: main',
      'Diff stats: 3 files changed, 45 insertions(+), 12 deletions(-)',
    ]);
    expect(observations(db, 'plain-note')).toEqual(['same']);
    expect(observations(db, 'task-state:proj')).toEqual(['next cleared', 'done: shipped']);
    expect(db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(SESSION_DEDUPE_KEY)).toEqual({ value: '2' });
    const kg = new KnowledgeGraph(db);
    expect(kg.search('Significant').map((e) => e.name)).toEqual(['session-abc-summary']);
    expect(kg.search('Compaction').map((e) => e.name)).toEqual(['pre-compact-019ff9f6-6b8f']);
    closeDatabase();

    expect(runInvariants().status).toBe(0);
  });

  it('leaves a lesson bucket alone: a repeated line there is a BLOCK field, not a duplicate fact', () => {
    // The one exception, and the reason it is not an allowlist: `groupLessons`
    // (graph-repairs.ts) cuts a lesson entity's observations into lessons at
    // each `Error: ` line, so the list is ORDERED BLOCKS and a repeat is
    // positional. Two lessons in one bucket sharing "Root cause: a" is
    // ordinary; deleting the second copy merges them, and the split that runs
    // right after this pass would then write one lesson where there were two.
    // Every other reader selects `content` and never `created_at`, which is
    // why a repeat is unreachable everywhere else.
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned', ['project:proj', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [
        'Error: first thing', 'Root cause: a', 'Fix: b', 'Prevention: c',
        'Error: second thing', 'Root cause: a', 'Fix: b', 'Prevention: c',
      ]) ins.run(id, line);
    });
    // Exit 1 here is #241's verdict on the fused bucket, which is correct and
    // is what the split below repairs. The point of this case is the OTHER
    // invariant: shared block fields must not read as duplicate observations.
    const before = runInvariants();
    expect(before.status).toBe(1);
    expect(before.stdout).toContain('ok   no-entity-carries-the-same-observation-twice');
    expect(before.stdout).not.toContain('FAIL no-entity-carries-the-same-observation-twice');

    const db = repaired();
    // The split ran (that IS this bucket's defect, #241) and every field
    // followed its own lesson — nothing was merged by a dedupe.
    expect(observations(db, `lesson-proj-${lessonSlug('first thing')}`))
      .toEqual(['Error: first thing', 'Root cause: a', 'Fix: b', 'Prevention: c']);
    expect(observations(db, `lesson-proj-${lessonSlug('second thing')}`))
      .toEqual(['Error: second thing', 'Root cause: a', 'Fix: b', 'Prevention: c']);
    closeDatabase();
  });

  it('leaves the same field-sharing repeat alone on type=lesson and type=mistake, not only lesson_learned', () => {
    // `groupLessons` and the dashboard's `parseStructuredBlocks`
    // (dashboard/src/components/LessonCards.tsx) key their positional read
    // on CONTENT shape, not on `type === 'lesson_learned'`, and the rest of
    // this repository already treats `lesson_learned`, `lesson` and
    // `mistake` as one family (src/core/analytics.ts,
    // src/core/work-topology.ts, src/core/doctor.ts,
    // scripts/hooks/_shared.js). A name that does NOT end in `-other` keeps
    // #241's fusion-split pass out of this case, so only the dedupe pass
    // under test is exercised.
    for (const type of ['lesson', 'mistake']) {
      seed((db) => {
        const id = insertEntity(db, `${type}-proj-shared-fields`, type, [`project:${type}`]);
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        for (const line of [
          'Error: first thing', 'Root cause: a', 'Fix: b', 'Prevention: c',
          'Error: second thing', 'Root cause: a', 'Fix: b', 'Prevention: c',
        ]) ins.run(id, line);
      });
      const before = runInvariants();
      expect(before.status, before.stdout).toBe(0);
      expect(before.stdout).toContain('ok   no-entity-carries-the-same-observation-twice');

      const db = repaired();
      expect(observations(db, `${type}-proj-shared-fields`)).toEqual([
        'Error: first thing', 'Root cause: a', 'Fix: b', 'Prevention: c',
        'Error: second thing', 'Root cause: a', 'Fix: b', 'Prevention: c',
      ]);
      closeDatabase();
    }
  });

  it('removes no DISTINCT observation: an entity whose lines all differ is untouched', () => {
    seed((db) => {
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      // Two real compactions of one session that recorded different work.
      // A per-session EXISTENCE guard would have thrown the second away; the
      // content guard keeps every line that says something new.
      const pre = insertEntity(db, 'pre-compact-two-real', 'session-summary');
      ins.run(pre, 'Compaction reason: auto');
      ins.run(pre, 'Tool calls: 0');
      ins.run(pre, 'Compaction reason: manual');
      ins.run(pre, 'Tool calls: 47');
      ins.run(pre, 'Files edited: graph-repairs.ts, pre-compact.js');
    });
    expect(runInvariants().status, 'nothing here is a duplicate').toBe(0);

    const db = repaired();
    expect(observations(db, 'pre-compact-two-real')).toEqual([
      'Compaction reason: auto',
      'Tool calls: 0',
      'Compaction reason: manual',
      'Tool calls: 47',
      'Files edited: graph-repairs.ts, pre-compact.js',
    ]);
    closeDatabase();
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

describe('dropArchivedIndexRows — archived rows leave both indexes (D11/D12)', () => {
  function marker(db: Db, key: string): string | undefined {
    return (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined)?.value;
  }

  function ftsRows(db: Db, id: number): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM entities_fts WHERE rowid = ?').get(id) as { c: number }).c;
  }

  function vecRows(db: Db, id: number): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM entities_vec WHERE rowid = ?').get(BigInt(id)) as { c: number }).c;
  }

  function seedVector(db: Db, id: number): void {
    const width = parseInt(
      (db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'")
        .get() as { value: string }).value,
      10,
    );
    const v = new Float32Array(width);
    v[0] = 1;
    db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)')
      .run(BigInt(id), Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  }

  /** The damage: archived with a bare status UPDATE, both index rows left behind. */
  function seedLeakedArchive(): void {
    seed((db) => {
      const kg = new KnowledgeGraph(db);
      kg.createEntity('commit-leaked', 'commit', { observations: ['leakedtoken touched the parser'] });
      kg.createEntity('decision-active', 'decision', { observations: ['activetoken SQLite over Postgres'] });
      seedVector(db, entityId(db, 'commit-leaked'));
      seedVector(db, entityId(db, 'decision-active'));
      db.prepare("UPDATE entities SET status = 'archived' WHERE name = 'commit-leaked'").run();
    });
  }

  it('removes both index rows for the archived entity and neither for the active one', () => {
    seedLeakedArchive();
    const db = repaired();
    const leaked = entityId(db, 'commit-leaked');
    const active = entityId(db, 'decision-active');

    expect(ftsRows(db, leaked)).toBe(0);
    expect(vecRows(db, leaked)).toBe(0);
    // Nothing belonging to an active entity is touched — the property the
    // repair is only trustworthy with.
    expect(ftsRows(db, active)).toBe(1);
    expect(vecRows(db, active)).toBe(1);
    expect(new KnowledgeGraph(db).search('activetoken').map((e) => e.name)).toEqual(['decision-active']);
    expect(new KnowledgeGraph(db).search('leakedtoken')).toHaveLength(0);

    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('is one-shot: a second open changes nothing', () => {
    seedLeakedArchive();
    let db = repaired();
    expect(marker(db, ARCHIVED_FTS_ROWS_KEY)).toBe('1');
    expect(marker(db, ARCHIVED_VECTOR_ROWS_KEY)).toBe('1');
    const active = entityId(db, 'decision-active');
    closeDatabase();

    db = openDatabase(dbPath);
    expect(ftsRows(db, active)).toBe(1);
    expect(vecRows(db, active)).toBe(1);
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('without a vector index: repairs FTS and leaves the vector marker UNSET', () => {
    // A platform sqlite-vec publishes no binary for. The vector half can never
    // run there, and stamping its marker anyway would mark the repair done on
    // the one machine that never performed it — so the leaked row would still
    // be waiting when the file is opened somewhere that HAS the binary, with
    // the marker saying it had been handled. Two keys is what prevents that;
    // this is the test that keeps them two.
    //
    // Called directly rather than through `openDatabase`, because
    // `ensureVecTable` recreates `entities_vec` on every open — going through
    // the opener would test a machine that HAS sqlite-vec and pass for the
    // wrong reason.
    seedLeakedArchive();
    const db = repaired();
    db.exec('DROP TABLE entities_vec');
    db.prepare('DELETE FROM memesh_metadata WHERE key LIKE ? OR key LIKE ?')
      .run(`${ARCHIVED_FTS_ROWS_KEY}%`, `${ARCHIVED_VECTOR_ROWS_KEY}%`);
    // Re-leak the FTS row the first open's repair already cleaned, so the FTS
    // half has real work to do on this run.
    const leaked = entityId(db, 'commit-leaked');
    db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)')
      .run(leaked, 'commit-leaked', 'leakedtoken touched the parser');
    expect(ftsRows(db, leaked)).toBe(1);

    const result = dropArchivedIndexRows(db);

    expect(result.ftsRows).toBe(1);
    expect(result.vectorRows).toBe(-1); // the half that did not run
    expect(ftsRows(db, leaked)).toBe(0);
    expect(ftsRows(db, entityId(db, 'decision-active'))).toBe(1);
    expect(marker(db, ARCHIVED_FTS_ROWS_KEY)).toBe('1');
    expect(marker(db, ARCHIVED_VECTOR_ROWS_KEY)).toBeUndefined();
    closeDatabase();
  });

  it('F1: rebuilds even when stale.n reads zero, because stale.n only ever asks about archived rows', () => {
    // Independent review of PR #292 (F1). The FTS half used to be gated on
    // `stale.n === 0`, and `stale.n`'s query joins on `e.status = 'archived'`
    // — it can only ever prove something about a rowid that is CURRENTLY
    // archived. It has nothing to say about a rowid whose FTS document has
    // drifted from `entities`/`observations` for any other reason, and an
    // ACTIVE entity is exactly that: never counted by `stale.n`, regardless
    // of what its FTS document actually holds.
    //
    // This seeds that drift directly with a raw SQL insert rather than
    // reconstructing the exact archive/re-remember/archive-again sequence a
    // leaky path is claimed to produce — that sequence could not be
    // re-derived from the code actually read here (`createEntityInner` reads
    // `prevObs` unconditionally on re-remember, and `rebuildFts` always takes
    // the previous text explicitly), so this fixture is a synthetic probe of
    // the GATE's blind spot, not a state any current-code path is known to
    // reach. The discriminating fact it proves is only ever "does the
    // unconditional rebuild run regardless of what stale.n reads" — which is
    // exactly what the fix changed, independent of how any real graph could
    // arrive at a mismatched document.
    seed((db) => {
      const id = insertEntity(db, 'note-drifted', 'note', [], 'active');
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)')
        .run(id, 'the real content, correctlytoken');
      // A document that disagrees with the source of truth it is supposed to
      // mirror. No archived row anywhere holds an FTS document, so `stale.n`
      // reads exactly 0 — the value that used to skip the rebuild entirely.
      db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)')
        .run(id, 'note-drifted', 'staleleakedtoken');
    });

    const db = repaired();

    // The unconditional rebuild ran and reconstructed this rowid purely from
    // `entities` + `observations`, discarding the drifted document — `n=0`
    // was a note-only number, not the rebuild's gate.
    expect(new KnowledgeGraph(db).search('staleleakedtoken')).toHaveLength(0);
    expect(new KnowledgeGraph(db).search('correctlytoken').map((e) => e.name)).toEqual(['note-drifted']);
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });
});

describe('D15 — a split shell does not keep recall history that belongs to no lesson', () => {
  it('zeroes the bucket\'s recall_hits/recall_misses when it empties, and leaves the split-out lessons at 0/0', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of [...LESSON_A, ...LESSON_B]) ins.run(id, line);
      // The measured real shape: a bucket injected 64 times, cited 3.
      setRecall(db, 'lesson-proj-other', 3, 61);
    });
    const db = repaired();
    expect(statusOf(db, 'lesson-proj-other')).toBe('archived');
    expect(recallOf(db, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(db, 'lesson-proj-other').retired_recall).toEqual({ hits: 3, misses: 61 });
    // Neither successor inherited any share of it — no double counting.
    expect(recallOf(db, nameA)).toEqual({ hits: 0, misses: 0 });
    expect(recallOf(db, nameB)).toEqual({ hits: 0, misses: 0 });
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('leaves recall history alone when a stray row keeps the bucket non-empty', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      // Before any `Error:` line, so groupLessons leaves it un-grouped and
      // it never moves — the same shape as the existing "stray row" test.
      ins.run(id, 'Note: this bucket picked up a stray line');
      for (const line of LESSON_A) ins.run(id, line);
      setRecall(db, 'lesson-proj-other', 3, 61);
    });
    const db = repaired();
    expect(statusOf(db, 'lesson-proj-other')).toBe('active');
    // Still represents live content (the stray row), so its history is still
    // its own business — the same reasoning that keeps `source:explicit` on
    // a bucket that did not fully empty.
    expect(recallOf(db, 'lesson-proj-other')).toEqual({ hits: 3, misses: 61 });
    expect(metadataOf(db, 'lesson-proj-other').retired_recall).toBeUndefined();
    closeDatabase();
  });

  it('does not write metadata.retired_recall when the bucket had no history to retire', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of LESSON_A) ins.run(id, line);
      // No setRecall call: stays at the schema default (0, 0).
    });
    const db = repaired();
    expect(recallOf(db, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(db, 'lesson-proj-other').retired_recall).toBeUndefined();
    closeDatabase();
  });

  it('retires history on the legacy readable-only split path too', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-null-pointer-in-the-auth-path', 'lesson_learned',
        ['project:proj', 'error-pattern:null-reference', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of ['Error: Null pointer in the auth path', 'Root cause: x', 'Fix: y', 'Prevention: z']) ins.run(id, line);
      setRecall(db, 'lesson-proj-null-pointer-in-the-auth-path', 1, 9);
    });
    const db = repaired();
    const legacyName = 'lesson-proj-null-pointer-in-the-auth-path';
    const canonicalName = `lesson-proj-${lessonSlug('Null pointer in the auth path')}`;
    expect(statusOf(db, legacyName)).toBe('archived');
    expect(recallOf(db, legacyName)).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(db, legacyName).retired_recall).toEqual({ hits: 1, misses: 9 });
    expect(recallOf(db, canonicalName)).toEqual({ hits: 0, misses: 0 });
    closeDatabase();
  });

  it('is idempotent: a second open changes nothing further', () => {
    seed((db) => {
      const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned',
        ['project:proj', 'error-pattern:other', 'source:explicit']);
      const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const line of LESSON_A) ins.run(id, line);
      setRecall(db, 'lesson-proj-other', 3, 61);
    });
    const first = repaired();
    expect(recallOf(first, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    closeDatabase();
    const second = openDatabase(dbPath);
    expect(recallOf(second, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(second, 'lesson-proj-other').retired_recall).toEqual({ hits: 3, misses: 61 });
    closeDatabase();
  });
});

describe('D15 — repairFusedLessonShellHistory: shells split before this fix existed', () => {
  /**
   * The state 4.8.2-and-later already produced on the maintainer's own
   * graph: `splitFusedLessons` has already run to completion (the bucket is
   * archived, empty, and a successor names it via `split_from`), from before
   * this fix existed — so `splitFusedLessons`'s own migrate() has nothing
   * left to do on this row; only the new standalone pass can reach it.
   */
  function seedAlreadySplitShell(db: Db, hits: number, misses: number): void {
    insertEntity(db, 'lesson-proj-other', 'lesson_learned', [], 'archived');
    setRecall(db, 'lesson-proj-other', hits, misses);
    const successorId = insertEntity(db, nameA, 'lesson_learned', ['project:proj', 'source:explicit']);
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(successorId, LESSON_A[0]);
    db.prepare('UPDATE entities SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ split_from: 'lesson-proj-other' }), successorId);
    // splitFusedLessons's own live pass cannot re-touch either row: the
    // bucket carries no `source:explicit` tag (already stripped by the
    // split that produced this fixture), and the successor's digest-shaped
    // name never matches `legacyReadableLessonSlug`, so its legacy-readable
    // branch skips it too. Only the new standalone pass can reach this shape.
  }

  it('retires a pre-existing shell\'s history the first time it opens under the new code', () => {
    seed((db) => seedAlreadySplitShell(db, 3, 61));
    const db = repaired();
    expect(recallOf(db, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(db, 'lesson-proj-other').retired_recall).toEqual({ hits: 3, misses: 61 });
    expect(recallOf(db, nameA)).toEqual({ hits: 0, misses: 0 });
    closeDatabase();
    expect(runInvariants().status).toBe(0);
  });

  it('does not touch an archived, empty lesson with no split_from referrer', () => {
    seed((db) => {
      insertEntity(db, 'lesson-proj-forgotten', 'lesson_learned', [], 'archived');
      setRecall(db, 'lesson-proj-forgotten', 4, 4);
    });
    const db = repaired();
    expect(recallOf(db, 'lesson-proj-forgotten')).toEqual({ hits: 4, misses: 4 });
    expect(metadataOf(db, 'lesson-proj-forgotten').retired_recall).toBeUndefined();
    closeDatabase();
  });

  it('is idempotent: a second open finds nothing left to retire', () => {
    seed((db) => seedAlreadySplitShell(db, 3, 61));
    const first = repaired();
    expect(first.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SHELL_HISTORY_RESET_KEY))
      .toEqual({ value: '1' });
    closeDatabase();
    const second = openDatabase(dbPath);
    expect(recallOf(second, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(second, 'lesson-proj-other').retired_recall).toEqual({ hits: 3, misses: 61 });
    closeDatabase();
  });
});

describe('the split path retires history on its own, not by leaning on the one-shot repair', () => {
  // Both wirings run in the same `openDatabase`, and the one-shot repair runs
  // SECOND — so on a fresh database it silently rescues anything the archive
  // point in `splitFusedLessons` failed to retire, and a test that opens once
  // cannot tell the two apart. Break-testing found exactly that: removing
  // `retireRecallHistory` from BOTH archive points left every existing test
  // green.
  //
  // But the repair is a `runOnceMigration`, already stamped at its current
  // version (1) — it will not fire again as-is. That is not what protects
  // an ordinary bucket the runtime fuses today: the current code no longer
  // creates new `-other` buckets at all, so this state only matters for the
  // next time `FUSED_LESSON_SPLIT_KEY` bumps past 2 (this split logic
  // changing again) while the shell repair stays stamped and can no longer
  // rescue what it misses — the archive points then have to retire the
  // history on their own.
  // This seeds that state: the repair already done, the split still owed.
  function seedWithShellRepairAlreadyDone(bucketName: string, extraTags: string[] = []): void {
    const db = openDatabase(dbPath);
    const id = insertEntity(db, bucketName, 'lesson_learned',
      ['project:proj', 'error-pattern:other', 'source:explicit', ...extraTags]);
    const ins = db.prepare('INSERT INTO observations (entity_id, content, created_at) VALUES (?, ?, ?)');
    for (const [i, line] of [...LESSON_A, ...LESSON_B].entries()) {
      ins.run(id, line, `2026-08-0${1 + Math.floor(i / 4)} 10:00:0${i % 4}`);
    }
    setRecall(db, bucketName, 4, 37);
    // The split is owed (version 2 > the stamped 1); the shell repair is not.
    const stamp = db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
    stamp.run(FUSED_LESSON_SPLIT_KEY, '1');
    stamp.run(FUSED_LESSON_SHELL_HISTORY_RESET_KEY, '1');
    closeDatabase();
  }

  it('zeroes the emptied bucket even when the one-shot repair has already stamped and cannot rescue it', () => {
    seedWithShellRepairAlreadyDone('lesson-proj-other');

    const db = repaired();
    // Guard the guard: if the one-shot repair DID run, this test proves
    // nothing about the archive point, so assert it stayed stamped at 1.
    expect(
      db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SHELL_HISTORY_RESET_KEY),
      'the one-shot repair ran after all — this test can no longer isolate the archive point',
    ).toEqual({ value: '1' });
    expect(statusOf(db, 'lesson-proj-other'), 'setup: the bucket did not empty and archive').toBe('archived');
    expect(recallOf(db, 'lesson-proj-other')).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(db, 'lesson-proj-other').retired_recall).toEqual({ hits: 4, misses: 37 });
    closeDatabase();
  });

  it('does the same on the legacy readable-only path, which is a second archive point', () => {
    // `lesson-<project>-<readable slug>` rather than `-other`: the second loop
    // in `splitFusedLessons`, with its own `archive.run(...)`. It had the
    // identical gap and the identical rescue hiding it.
    const legacy = 'lesson-proj-null-pointer-in-the-auth-path';
    const db0 = openDatabase(dbPath);
    const id = insertEntity(db0, legacy, 'lesson_learned',
      ['project:proj', 'error-pattern:null-reference', 'source:explicit']);
    const ins = db0.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
    for (const line of ['Error: Null pointer in the auth path', 'Root cause: x', 'Fix: y', 'Prevention: z']) ins.run(id, line);
    setRecall(db0, legacy, 2, 11);
    const stamp = db0.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)');
    stamp.run(FUSED_LESSON_SPLIT_KEY, '1');
    stamp.run(FUSED_LESSON_SHELL_HISTORY_RESET_KEY, '1');
    closeDatabase();

    const db = repaired();
    expect(
      db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(FUSED_LESSON_SHELL_HISTORY_RESET_KEY),
      'the one-shot repair ran after all — this test can no longer isolate the archive point',
    ).toEqual({ value: '1' });
    expect(statusOf(db, legacy), 'setup: the legacy entity did not archive').toBe('archived');
    expect(recallOf(db, legacy)).toEqual({ hits: 0, misses: 0 });
    expect(metadataOf(db, legacy).retired_recall).toEqual({ hits: 2, misses: 11 });
    closeDatabase();
  });
});

/**
 * The fourth pass: durable-message scope identities spelled as filesystem
 * paths. Seeded with the exact rows measured on the maintainer's graph —
 * `/root` beside `root`, one absolute-path `project`, the `claude-code:`
 * session pair, and the `memesh` / `memesh-llm-memory` project pair — because
 * what this pass must NOT touch is as much of the contract as what it must.
 */
describe('normalizeAgentScopePaths — message scope identities spelled as paths', () => {
  function message(db: Db, id: string, project: string, recipient: string): void {
    db.prepare(
      `INSERT INTO agent_messages (message_id, project, sender, recipient, content_type, privacy, payload_json, provenance_json)
       VALUES (?, ?, 'author', ?, 'text/plain', 'private', '"x"', '{}')`,
    ).run(id, project, recipient);
    db.prepare(
      `INSERT INTO agent_message_deliveries (delivery_id, message_id, project, recipient, target_kind)
       VALUES (?, ?, ?, ?, 'principal')`,
    ).run(`d-${id}`, id, project, recipient);
    db.prepare(
      `INSERT INTO agent_message_events (event_id, message_id, delivery_id, project, recipient, event_kind)
       VALUES (?, ?, ?, ?, ?, 'message_available')`,
    ).run(`e-${id}`, id, `d-${id}`, project, recipient);
  }

  function recipients(db: Db): Array<{ recipient: string; project: string; n: number }> {
    return db.prepare(
      'SELECT project, recipient, COUNT(*) AS n FROM agent_message_deliveries GROUP BY project, recipient ORDER BY project, recipient',
    ).all() as unknown as Array<{ recipient: string; project: string; n: number }>;
  }

  it('rewrites a path-shaped project, recipient and actor to the identity name, once', () => {
    seed((db) => {
      message(db, 'm1', 'memesh-llm-memory', '/root');
      message(db, 'm2', 'memesh-llm-memory', 'root');
      message(db, 'm3', '/Users/ktseng/Developer/Projects/memesh-llm-memory', '/root');
      db.prepare(
        `INSERT INTO agent_message_receipts
           (receipt_id, message_id, project, recipient, receipt_kind, actor, idempotency_key, request_hash, detail_json)
         VALUES ('r1', 'm1', 'memesh-llm-memory', '/root', 'ack', '/root', 'k1', 'h1', '{}')`,
      ).run();
    });

    const db = openDatabase(dbPath);
    expect(recipients(db)).toEqual([
      { project: 'memesh-llm-memory', recipient: 'root', n: 3 },
    ]);
    const receipt = db.prepare('SELECT project, recipient, actor FROM agent_message_receipts').get() as
      { project: string; recipient: string; actor: string };
    expect(receipt).toEqual({ project: 'memesh-llm-memory', recipient: 'root', actor: 'root' });
    // Every message survives: this moves identities, it does not delete mail.
    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_messages').get() as { c: number }).c).toBe(3);

    // Idempotent: a second open changes nothing.
    closeDatabase();
    const again = openDatabase(dbPath);
    expect(recipients(again)).toEqual([
      { project: 'memesh-llm-memory', recipient: 'root', n: 3 },
    ]);
  });

  it('leaves `claude-code:session_X` and `session_X` apart, and `memesh` apart from `memesh-llm-memory`', () => {
    // Both pairs are in the real graph and neither is a mechanical spelling
    // variant. `claude-code:` exists nowhere in this repository, so there is
    // no convention to normalise against; `memesh` vs `memesh-llm-memory` IS
    // one project, but only a network call against one owner's GitHub account
    // proves it, and a migration running from an arbitrary directory cannot.
    seed((db) => {
      message(db, 'm1', 'memesh', 'session_01PDMer3P4cVYeHr4KRen3Un');
      message(db, 'm2', 'memesh', 'claude-code:session_01PDMer3P4cVYeHr4KRen3Un');
      message(db, 'm3', 'memesh-llm-memory', 'root');
    });
    const db = openDatabase(dbPath);
    expect(recipients(db)).toEqual([
      { project: 'memesh', recipient: 'claude-code:session_01PDMer3P4cVYeHr4KRen3Un', n: 1 },
      { project: 'memesh', recipient: 'session_01PDMer3P4cVYeHr4KRen3Un', n: 1 },
      { project: 'memesh-llm-memory', recipient: 'root', n: 1 },
    ]);
  });

  it('drops a poll cursor that collides, and only a cursor', () => {
    // `idx_agent_message_cursors_unique_scope_sequence` is UNIQUE on
    // (project, recipient, event_sequence). When the canonical identity
    // already holds that position, the path-spelled token is unreachable —
    // `poll` refuses the path spelling it is bound to — so it is dropped.
    seed((db) => {
      message(db, 'm1', 'opencae-hpc', 'root');
      const ins = db.prepare(
        'INSERT INTO agent_message_cursors (cursor_token, project, recipient, event_sequence) VALUES (?, ?, ?, ?)',
      );
      ins.run('tok-canonical', 'opencae-hpc', 'root', 0);
      ins.run('tok-path', 'opencae-hpc', '/root', 0);
      ins.run('tok-path-unique', 'opencae-hpc', '/root', 7);
    });
    const db = openDatabase(dbPath);
    const cursors = db.prepare(
      'SELECT cursor_token, project, recipient, event_sequence FROM agent_message_cursors ORDER BY event_sequence, cursor_token',
    ).all() as unknown as Array<{ cursor_token: string; recipient: string; event_sequence: number }>;
    // The colliding token is gone; the non-colliding one is RENAMED, not
    // dropped — an owner keeps every resume point that can still be honoured.
    expect(cursors.map((c) => `${c.cursor_token}:${c.recipient}:${c.event_sequence}`)).toEqual([
      'tok-canonical:root:0',
      'tok-path-unique:root:7',
    ]);
  });

  it('turns the invariant from red to green, and a graph with no messages is a no-op', () => {
    const invariantStatus = () => spawnSync(process.execPath, [invariants, '--db', dbPath], { encoding: 'utf8' });
    seed((db) => {
      message(db, 'm1', 'sports-platform', '/root');
    });
    closeDatabase();
    const before = invariantStatus();
    expect(before.status, before.stdout).toBe(1);
    expect(before.stdout).toContain('agent-message-scope-ids-are-not-filesystem-paths');

    openDatabase(dbPath);
    closeDatabase();
    const after = invariantStatus();
    expect(after.status, after.stdout).toBe(0);
  });
});
