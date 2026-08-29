import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, closeDatabase } from '../../src/db.js';

/**
 * scripts/audit/memory-invariants.mjs is the check that would have caught
 * #240, #241 and #242 — three defects that seven diff reviews of v4.8.2 did
 * not, because they sat in code the diff never touched and only show up in
 * the DATA. A detector that cannot fail is decoration, so every invariant is
 * exercised twice here: once on a clean graph (must exit 0) and once with the
 * exact defect seeded (must exit 1 and name the entity). The seeding writes
 * the same rows the real bug produced, not a caricature of them.
 */
const script = path.resolve('scripts/audit/memory-invariants.mjs');

function run(dbPath: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [script, '--db', dbPath], { encoding: 'utf8' });
}

/** A real schema (migrations applied), then closed so the script can open it read-only. */
function freshGraph(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-inv-'));
  const dbPath = path.join(dir, 'kg.db');
  openDatabase(dbPath);
  closeDatabase();
  return { dir, dbPath };
}

function withRawDb(dbPath: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try { fn(db); } finally { db.close(); }
}

function insertEntity(db: DatabaseSync, name: string, type: string, extra: Record<string, string> = {}): number {
  const cols = ['name', 'type', ...Object.keys(extra)];
  const vals = [name, type, ...Object.values(extra)];
  db.prepare(`INSERT INTO entities (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  return Number((db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id);
}

describe('memory-invariants: read-only detector over a real graph', () => {
  it('exits 0 on a clean graph and 2 when the database is missing', () => {
    const { dir, dbPath } = freshGraph();
    try {
      const clean = run(dbPath);
      expect(clean.status, clean.stdout + clean.stderr).toBe(0);
      expect(clean.stdout).toContain('memory invariants hold');
      const missing = run(path.join(dir, 'does-not-exist.db'));
      expect(missing.status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the graph read-only: no write can come from the detector', () => {
    const { dir, dbPath } = freshGraph();
    try {
      const before = fs.statSync(dbPath).mtimeMs;
      run(dbPath);
      expect(fs.statSync(dbPath).mtimeMs).toBe(before);
      expect(fs.existsSync(`${dbPath}-wal`) && fs.statSync(`${dbPath}-wal`).size > 0).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#240 — flags a session summary whose observations repeat', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'session-abc-summary', 'session-insight');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        // The real shape: the same three commands appended on every Stop.
        for (let stop = 0; stop < 4; stop++) {
          ins.run(id, 'Significant session: 40 tool calls, 0 files edited');
          ins.run(id, 'Command: git status --short');
          ins.run(id, 'Command: npm view @pcircle/memesh version');
        }
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('FAIL stop-summary-no-duplicate-observations');
      expect(r.stdout).toContain('session-abc-summary  observations=12 unique=3');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#240 — flags "0 files edited" on a summary that recorded a Bash write', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'session-def-summary', 'session-insight');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        ins.run(id, 'Significant session: 25 tool calls, 0 files edited');
        ins.run(id, "Command: cat > src/core/paths.ts <<'EOF'");
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('FAIL stop-summary-does-not-assert-zero-edits-for-bash-sessions');
      expect(r.stdout).toContain('session-def-summary');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#240 — a real violation is not hidden behind eight honest sessions that sort first', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        // Nine honest summaries with a Command line and a true "0 files edited";
        // their names sort before the violator's.
        for (let i = 0; i < 9; i++) {
          const id = insertEntity(db, `session-0${i}-summary`, 'session-insight');
          ins.run(id, 'Significant session: 5 tool calls, 0 files edited');
          ins.run(id, 'Command: git status');
        }
        const bad = insertEntity(db, 'session-zz-summary', 'session-insight');
        ins.run(bad, 'Significant session: 25 tool calls, 0 files edited');
        ins.run(bad, "Command: cat > src/core/paths.ts <<'EOF'");
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('session-zz-summary');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#240 — prints at most eight violations and says so', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        for (let i = 0; i < 9; i++) {
          const id = insertEntity(db, `session-v${i}-summary`, 'session-insight');
          ins.run(id, 'Significant session: 5 tool calls, 0 files edited');
          ins.run(id, "Command: cat > src/x.ts <<'EOF'");
        }
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(1);
      expect((r.stdout.match(/session-v\d-summary/g) ?? []).length).toBe(8);
      expect(r.stdout).toContain('(first 8)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#241 — flags an explicit "-other" lesson bucket holding more than one lesson', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:explicit');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        // Two unrelated lessons, four fields each — exactly what learn() wrote.
        for (const topic of ['fake did not echo the write', 'shared pattern list has three consumers']) {
          ins.run(id, `Error: ${topic}`); ins.run(id, 'Root cause: x'); ins.run(id, 'Fix: y'); ins.run(id, 'Prevention: z');
        }
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('FAIL explicit-lessons-not-fused-into-other-bucket');
      expect(r.stdout).toContain('lesson-proj-other  observations=8 (2 lessons)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#241 — a bucket renamed by kg rename-project (name old, tag new) is still seen', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'lesson-old-other', 'lesson_learned');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:explicit');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'project:new');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        for (const topic of ['one thing', 'another thing']) {
          ins.run(id, `Error: ${topic}`); ins.run(id, 'Root cause: x'); ins.run(id, 'Fix: y'); ins.run(id, 'Prevention: z');
        }
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toContain('lesson-old-other  observations=8 (2 lessons)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#241 — a re-learned lesson with no project tag whose name ends in "-other" is not a bucket', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'lesson-q-could-not-reach-the-other', 'lesson_learned');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:explicit');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        for (const line of ['Error: could not reach the other', 'Root cause: x', 'Fix: y', 'Prevention: z', 'Error: could not reach the other']) ins.run(id, line);
      });
      expect(run(dbPath).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#240 — nine duplicate-summary entities print eight and say so (the SQL cap)', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        for (let i = 0; i < 9; i++) {
          const id = insertEntity(db, `session-d${i}-summary`, 'session-insight');
          ins.run(id, 'Command: git status'); ins.run(id, 'Command: git status');
        }
      });
      const r = run(dbPath);
      expect(r.status).toBe(1);
      expect((r.stdout.match(/session-d\d-summary/g) ?? []).length).toBe(8);
      expect(r.stdout).toContain('(first 8)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#241 — a lesson whose name merely ends in "-other" is not a bucket', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'lesson-proj-could-not-reach-the-other', 'lesson_learned');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:explicit');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'project:proj');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        // Re-learned once: five observations, the shape learn() produces today.
        for (const line of ['Error: could not reach the other', 'Root cause: x', 'Fix: y', 'Prevention: z', 'Error: could not reach the other']) ins.run(id, line);
      });
      expect(run(dbPath).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#240 — exactly eight violations print without a "(first 8)" line', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        for (let i = 0; i < 8; i++) {
          const id = insertEntity(db, `session-e${i}-summary`, 'session-insight');
          ins.run(id, 'Significant session: 5 tool calls, 0 files edited');
          ins.run(id, "Command: cat > src/x.ts <<'EOF'");
        }
      });
      const r = run(dbPath);
      expect(r.status).toBe(1);
      expect((r.stdout.match(/session-e\d-summary/g) ?? []).length).toBe(8);
      expect(r.stdout).not.toContain('(first 8)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#241 — a single explicit lesson in "-other" is not a violation', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        const id = insertEntity(db, 'lesson-proj-other', 'lesson_learned');
        db.prepare('INSERT INTO tags (entity_id, tag) VALUES (?, ?)').run(id, 'source:explicit');
        const ins = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
        ins.run(id, 'Error: one'); ins.run(id, 'Root cause: x'); ins.run(id, 'Fix: y'); ins.run(id, 'Prevention: z');
      });
      expect(run(dbPath).status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('#242 — reports (does not fail on) a global-namespace entity with no project tag', () => {
    const { dir, dbPath } = freshGraph();
    try {
      withRawDb(dbPath, (db) => {
        insertEntity(db, 'always-memesh-on-failure', 'directive', { namespace: 'global' });
      });
      const r = run(dbPath);
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain('note global-namespace-reachable-by-injection');
      expect(r.stdout).toContain('always-memesh-on-failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
