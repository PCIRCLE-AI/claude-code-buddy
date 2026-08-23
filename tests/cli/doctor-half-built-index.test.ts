/**
 * `memesh doctor` reports a half-built vector index — and stays quiet when
 * there isn't one.
 *
 * A rebuild builds the next generation into `entities_vec_next` and promotes
 * it only when complete, so an interrupted run leaves a second, full-size copy
 * of the user's vectors on disk. That is the design working; being unable to
 * SEE it is not. The check that makes it visible (`vector-generation.open` in
 * `src/core/doctor.ts`) shipped with the swap fix and had nothing asserting it:
 * the only tests naming `vector_generation` seed that metadata key as a fixture
 * for other behaviour, and the CLI test covers `reindex --discard-generation`,
 * which is the ACTION, not the diagnostic that tells a user to run it. So the
 * write side was pinned and the read side was not — a memory can be staged,
 * abandoned, and reported by nobody, with the whole suite green.
 *
 * These spawn the built CLI against a real database in a throwaway HOME. A stub
 * cannot cover this: the row's number comes from counting rows in a vec0
 * virtual table, and the state under test is produced by writing to one.
 *
 * Each case asserts the honest verdict AND its opposite — a doctor that simply
 * stopped emitting the row fails the first test here rather than passing all of
 * them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemeshDatabase as Database } from '../../src/storage/sqlite.js';
import type { SqlInputValue } from '../../src/storage/sqlite.js';

const require = createRequire(import.meta.url);
const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

/** The staged width. Not the default 384: a hard-coded fallback anywhere in the
 *  path would read as correct at the default and wrong here. */
const STAGED_DIM = 1536;
const STAGED_PROVIDER = 'openai';
const STAGED_STARTED_AT = '2026-01-01T00:00:00.000Z';

interface DoctorCheck {
  id: string;
  status: string;
  summary: string;
  fix?: string;
  code?: string;
  params?: Record<string, string | number>;
}

describe('doctor: a half-built vector index is visible, not silently holding disk', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-halfbuilt-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    // Matches `getDbPath()`'s default under `memeshDir()`. Named here rather
    // than forced with MEMESH_DB_PATH so the CLI and this fixture agree by
    // resolving the same way a user's install does.
    dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    // Provider credentials in the developer's own shell would send these
    // fixtures to a real API and make the run depend on the network.
    // MEMESH_DIR / MEMESH_DB_PATH go too: either one set in the environment
    // points the CLI at a database this fixture is not seeding. That fails
    // loudly today (`setup: no database at …`), which is the right direction —
    // deleting them makes it impossible rather than merely noisy.
    for (const key of [
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST', 'MEMESH_DIR', 'MEMESH_DB_PATH',
    ]) delete env[key];
    try {
      const stdout = execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  /** Every check doctor emitted, so a case can assert on absence too. */
  function doctorChecks(): DoctorCheck[] {
    const r = run(['doctor', '--json']);
    // doctor exits non-zero when anything WARNs, which several of these
    // fixtures deliberately do — the report on stdout is the subject, not the
    // status. Assert it parsed rather than letting a crash read as "no rows".
    let report: { checks?: DoctorCheck[] };
    try {
      report = JSON.parse(r.stdout) as { checks?: DoctorCheck[] };
    } catch {
      throw new Error(`doctor --json did not produce JSON (status ${r.status}): ${r.stdout || r.stderr}`);
    }
    expect(Array.isArray(report.checks), 'doctor --json has no checks array').toBe(true);
    return report.checks as DoctorCheck[];
  }

  /** A database created by the real code path, holding one memory. */
  function seedDatabase(): void {
    const seeded = run(['remember', '--name', 'a-kept-note', '--type', 'note', '--obs', 'a memory worth keeping']);
    expect(seeded.status, `setup: remember failed — ${seeded.stderr}`).toBe(0);
    expect(fs.existsSync(dbPath), `setup: no database at ${dbPath}`).toBe(true);
  }

  /** Open the seeded database with sqlite-vec loaded — the same two-gate dance
   *  `src/db.ts` does (`allowExtension` at open, then `enableLoadExtension`). */
  function openRaw(): Database {
    const sqliteVec = require('sqlite-vec');
    const db = new Database(dbPath, { allowExtension: true });
    db.enableLoadExtension(true);
    try { sqliteVec.load(db); } finally { db.enableLoadExtension(false); }
    return db;
  }

  /**
   * Leave behind exactly what an interrupted `memesh reindex` leaves: the
   * staging table with `rows` vectors in it, and the marker describing the
   * generation they belong to.
   *
   * Written directly rather than by killing a real rebuild mid-flight, because
   * a rebuild needs an embedding provider and the state — not the route to it —
   * is what doctor reads.
   */
  function seedHalfBuiltIndex(rows: number, marker: string): void {
    const db = openRaw();
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec_next USING vec0(embedding float[${STAGED_DIM}])`);
    const insert = db.prepare('INSERT INTO entities_vec_next (rowid, embedding) VALUES (?, ?)');
    for (let i = 1; i <= rows; i++) {
      insert.run(BigInt(i), Buffer.from(new Float32Array(STAGED_DIM).fill(0.25).buffer) as unknown as SqlInputValue);
    }
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('vector_generation', ?)")
      .run(marker);
    const staged = (db.prepare('SELECT COUNT(*) AS c FROM entities_vec_next').get() as { c: number }).c;
    db.close();
    expect(staged, 'fixture: the staging table was not populated').toBe(rows);
  }

  const openMarker = JSON.stringify({
    dimension: STAGED_DIM,
    provider: STAGED_PROVIDER,
    startedAt: STAGED_STARTED_AT,
  });

  it('says nothing about a half-built index when there is none', () => {
    // The half that gives the warning meaning. Without it, a check hard-wired
    // to fire would pass every other case in this file.
    seedDatabase();

    const ids = doctorChecks().map((c) => c.id);
    expect(ids, 'doctor reported a half-built index on a database that has none').not.toContain('vector_generation');
  });

  it('reports an abandoned rebuild, with the width and provider that produced it', () => {
    seedDatabase();
    seedHalfBuiltIndex(2, openMarker);

    // Exactly one row, not merely at least one: the check sits after two other
    // pushes into the same array, and a duplicated row would read as two
    // separate abandoned rebuilds to anyone reading the report.
    const rows = doctorChecks().filter((c) => c.id === 'vector_generation');
    expect(rows, 'an abandoned rebuild was not reported exactly once').toHaveLength(1);
    const check = rows[0];
    expect(check.status, 'a half-built index is a warning, not a pass').toBe('warn');
    expect(check.code).toBe('vector-generation.open');
    // The three facts that tell a user whether to finish it or throw it away.
    expect(check.summary).toContain(String(STAGED_DIM));
    expect(check.summary).toContain(STAGED_PROVIDER);
    expect(check.summary).toContain(STAGED_STARTED_AT);
    // Both ways out, because they are not interchangeable: one keeps the
    // embeddings already paid for, the other reclaims the disk.
    expect(check.fix).toContain('memesh reindex');
    expect(check.fix).toContain('--discard-generation');
  });

  it('counts the vectors actually staged, rather than reporting that some exist', () => {
    // Two, not one: a count and a boolean are indistinguishable at one row, and
    // the number is what tells a user how much of the rebuild would be re-bought.
    seedDatabase();
    seedHalfBuiltIndex(2, openMarker);

    const check = doctorChecks().find((c) => c.id === 'vector_generation');
    expect(check?.params?.staged, 'the staged count is not the number of staged rows').toBe(2);
    expect(check?.summary).toContain('2 vectors staged');
  });

  it('treats a marker it cannot read as its own case, and does not offer to resume it', () => {
    // `readVectorGeneration` returns three states, and 'unreadable' is the one
    // where resuming could merge two embedding spaces. Doctor must not print
    // the "run reindex to finish it" advice for a generation whose provider and
    // width are unknown.
    seedDatabase();
    seedHalfBuiltIndex(2, '{not json');

    const check = doctorChecks().find((c) => c.id === 'vector_generation');
    expect(check, 'an unreadable marker went unreported').toBeDefined();
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('cannot be read');
    expect(check?.fix).toContain('--discard-generation');
    expect(check?.fix, 'doctor offered to resume a generation whose embedding space is unknown')
      .not.toContain('the vectors already produced are reused');
  });

  it('stops reporting it once the user runs the fix doctor named', () => {
    // The loop the other cases leave open: doctor prints a command, and nothing
    // here proved that command clears the state doctor is complaining about.
    seedDatabase();
    seedHalfBuiltIndex(2, openMarker);
    expect(doctorChecks().map((c) => c.id), 'fixture: nothing to clear').toContain('vector_generation');

    const discarded = run(['reindex', '--discard-generation']);
    expect(discarded.status, `the fix doctor named failed — ${discarded.stderr}`).toBe(0);

    expect(doctorChecks().map((c) => c.id), 'doctor still reports a half-built index after it was discarded')
      .not.toContain('vector_generation');
  });
});
