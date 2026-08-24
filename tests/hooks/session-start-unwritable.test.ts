/**
 * The banner is a promise, and this is the case where it could not be kept.
 *
 * `session-start.js` prints "◉ MeMesh ready · … memories will be created as
 * you work". On a `~/.memesh` the process cannot write — a read-only mount, a
 * directory that changed owner, a botched `sudo` — every capture hook then
 * fails with EACCES for the whole session while that line still reads green.
 *
 * A probe for this existed and was measured by hand ("with HOME at mode 555
 * this printed MeMesh ready"), but it sat INSIDE the `!existsSync(dbPath)`
 * branch, so it only ever ran before the database existed — which is the one
 * moment the failure is least likely. Nothing pinned it, so the gap was
 * invisible: the fix looked complete and covered the rarest case.
 *
 * These tests run the real hook against a real read-only directory. They are
 * skipped for root, which bypasses the permission bits entirely and would
 * make them pass while proving nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';

const require = createRequire(import.meta.url);
// _shared.js is plain JS with no type declarations.
const shared = require('../../scripts/hooks/_shared.js');

const isRoot = process.getuid?.() === 0;
const isWindows = process.platform === 'win32';

// The skip below is silent by construction: if CI ever moves into a root
// container, every case in this suite evaporates with zero signal, and the
// write-probe regression it pins was exactly a shipped-with-no-test gap.
// This guard is NOT skipped, so an all-skip run fails loudly and the move
// to root has to be a conscious decision, not an accident.
describe('session-start unwritable-suite skip guard', () => {
  it('does not silently skip the whole suite on CI', () => {
    if (!process.env.CI) return; // local root runs are the developer's business
    expect(isRoot && !isWindows, 'CI runs as root — the unwritable-dir suite below is silently skipped; run it in a non-root user or consciously retire it').toBe(false);
  });
});

describe.skipIf(isRoot || isWindows)('session-start: an unwritable memesh dir is never reported as ready', () => {
  let home: string;
  let memeshDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-unwritable-'));
    memeshDir = path.join(home, '.memesh');
    fs.mkdirSync(memeshDir, { recursive: true });
  });

  afterEach(() => {
    // Restore write permission first or the cleanup itself fails.
    try { fs.chmodSync(memeshDir, 0o700); } catch { /* already gone */ }
    removeTempDir(home);
  });

  function runHook(): string {
    const hookPath = path.resolve('scripts/hooks/session-start.js');
    const out = execFileSync('node', [hookPath], {
      input: JSON.stringify({ cwd: home }),
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: memeshDir },
      encoding: 'utf8',
      timeout: 15000,
    });
    const parsed = JSON.parse(out.trim()) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
    return parsed.systemMessage ?? parsed.hookSpecificOutput?.additionalContext ?? '';
  }

  it('warns when the directory is unwritable and the database does NOT yet exist', () => {
    fs.chmodSync(memeshDir, 0o555);
    // Guard the guard: if this environment ignores the mode bits, the test
    // below would pass for the wrong reason.
    expect(() => fs.writeFileSync(path.join(memeshDir, 'probe'), 'x')).toThrow();

    const message = runHook();
    expect(message).toMatch(/cannot write to/i);
    expect(message).not.toMatch(/MeMesh ready/);
  });

  it('warns when the directory is unwritable and the database DOES exist', () => {
    // The case the old probe could not reach, and the only one a real user
    // hits: memesh worked for months, then the directory stopped being
    // writable. Every session after that printed the green count banner.
    const dbPath = path.join(memeshDir, 'knowledge-graph.db');
    execFileSync('node', [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.exec("CREATE TABLE entities (id INTEGER PRIMARY KEY, name TEXT, type TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
       db.exec("INSERT INTO entities (name, type) VALUES ('x', 'note')");
       db.close();`,
      dbPath,
    ], { encoding: 'utf8' });
    expect(fs.existsSync(dbPath), 'no database — this test would exercise the first-run path instead').toBe(true);

    fs.chmodSync(memeshDir, 0o555);
    expect(() => fs.writeFileSync(path.join(memeshDir, 'probe'), 'x')).toThrow();

    const message = runHook();
    expect(message, 'an unwritable memesh dir still reported the session as ready').toMatch(/cannot write to/i);
    expect(message).not.toMatch(/MeMesh ready/);
  });

  it('says nothing about writability when the directory IS writable', () => {
    // Or the two above are satisfied by a hook that always cries wolf.
    const message = runHook();
    expect(message).not.toMatch(/cannot write to/i);
  });

  /** Full current schema + one entity, optionally project-tagged — so the
   * recall pipeline the hook runs against it is the REAL one, not a crash
   * on a minimal fixture. */
  function seedDb(dbPath: string, projectTag?: string): void {
    const { db } = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
    try {
      shared.captureEntity(db, {
        name: 'seed-entity-1',
        type: 'note',
        observations: ['seeded memory for the recall-not-withheld test'],
        tags: projectTag ? [projectTag] : [],
      });
    } finally {
      db.close();
    }
  }

  it('warns when the DB FILE is read-only inside a WRITABLE directory', () => {
    // The botched-sudo state the probe's own comment names: the directory
    // probes writable, the file does not. Both prior tests chmod the
    // DIRECTORY, so the file branch was never exercised — deleting it left
    // the suite green.
    const dbPath = path.join(memeshDir, 'knowledge-graph.db');
    seedDb(dbPath);
    fs.chmodSync(dbPath, 0o444);
    expect(() => fs.appendFileSync(dbPath, '')).toThrow();

    const message = runHook();
    expect(message).toMatch(/cannot write to/i);
    expect(message).toContain('knowledge-graph.db');
    expect(message).not.toMatch(/MeMesh ready/);
  });

  it('warns when a WAL sidecar is unwritable even though the db file is fine', () => {
    // An interrupted sudo run leaves a user-owned database next to
    // root-owned -wal/-shm files; SQLite then fails every write with EACCES
    // while a db-file-only probe reads healthy. Simulated with mode bits
    // (chown needs root); the probe only asks "can this process write it".
    const dbPath = path.join(memeshDir, 'knowledge-graph.db');
    seedDb(dbPath);
    fs.writeFileSync(`${dbPath}-wal`, '');
    fs.chmodSync(`${dbPath}-wal`, 0o444);
    expect(() => fs.appendFileSync(`${dbPath}-wal`, '')).toThrow();

    const message = runHook();
    expect(message).toMatch(/cannot write to/i);
    expect(message).toContain('-wal');
  });

  it('an unwritable target does NOT withhold recall — memories still reach the session', () => {
    // The first draft of the every-session probe RETURNED on the warning,
    // before the read-only recall connection — so a read-only mount turned
    // "capture is off" into "your memory is gone", withholding every
    // existing memory exactly when the user needs context to notice
    // something is wrong. Warn, then keep reading.
    // The db FILE is read-only, the directory writable: capture cannot
    // land, but a reader can still open (SQLite can create the WAL
    // sidecars it needs in the directory). The dir-555 sibling case is
    // physically unreadable for a cleanly-closed WAL database — no -shm
    // can be created — so "recall still works" is only a promise the
    // filesystem lets us keep HERE, and the honest outcome there is the
    // warning plus the memories-not-loaded line (both now delivered).
    const dbPath = path.join(memeshDir, 'knowledge-graph.db');
    const projectName = shared.getProjectName(home);
    seedDb(dbPath, `project:${projectName}`);
    fs.chmodSync(dbPath, 0o444);
    expect(() => fs.appendFileSync(dbPath, '')).toThrow();

    const hookPath = path.resolve('scripts/hooks/session-start.js');
    const out = execFileSync('node', [hookPath], {
      input: JSON.stringify({ cwd: home }),
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_DIR: memeshDir },
      encoding: 'utf8',
      timeout: 15000,
    });
    const parsed = JSON.parse(out.trim()) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    // The warning leads AND the seeded memory still reaches the session.
    expect(parsed.systemMessage).toMatch(/cannot write to/i);
    expect(parsed.systemMessage).not.toMatch(/MeMesh ready/);
    expect(parsed.systemMessage).toMatch(/memories/);
    expect(
      parsed.hookSpecificOutput?.additionalContext,
      'the recall payload must still be injected — capture being off is not memory being gone',
    ).toContain('seeded memory for the recall-not-withheld test');
  });
});
