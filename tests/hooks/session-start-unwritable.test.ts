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
import fs from 'fs';
import os from 'os';
import path from 'path';

const isRoot = process.getuid?.() === 0;
const isWindows = process.platform === 'win32';

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
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
});
