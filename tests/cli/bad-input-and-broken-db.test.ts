/**
 * Two failure modes every command shared, and neither said what was wrong.
 *
 * A NUMERIC FLAG THAT IS NOT A NUMBER. `parseInt('abc')` is `NaN`, and `NaN`
 * was carried straight into whatever the flag fed. Each site failed
 * differently and none of them named the flag:
 *
 *   recall --limit abc   NaN into a SQL LIMIT — a raw `ERR_SQLITE_ERROR`
 *                        stack trace carrying the absolute install path
 *   export --limit abc   silently ignored; the default was used and the
 *                        user was told nothing
 *   why --line abc       NaN reached `git blame -L NaN,NaN`, the failure was
 *                        caught, and the user was told "That line does not
 *                        exist in the tracked file" — a false statement from
 *                        the one command whose contract is to abstain
 *
 * `why` had grown a hand-written guard with a comment explaining exactly
 * this. It was the only command that had. The guard is now one commander
 * coercion applied at every numeric option, so a new flag inherits it.
 *
 * A DATABASE THAT WILL NOT OPEN. Every command opens the database through one
 * helper, and that helper let the throw through: a fifteen-line Node stack
 * with the install path, from `recall`, from `remember`, from all of them.
 * `memesh doctor` handles the identical state and says what to do about it —
 * it was simply the only command that did.
 *
 * Spawns the built CLI, because both defects are about what a user SEES.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

describe('a numeric flag that is not a number', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-badnum-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      delete env[key];
    }
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env, timeout: 30000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  for (const [command, flag] of [
    [['recall', 'anything', '--limit', 'abc'], '--limit'],
    [['export', '--limit', 'abc'], '--limit'],
    [['why', 'README.md', '--line', 'abc'], '--line'],
  ] as const) {
    it(`refuses \`${command.join(' ')}\` by naming ${flag}`, () => {
      const r = run([...command]);

      expect(r.status, 'a bad numeric flag exited 0').not.toBe(0);
      expect(r.stderr, 'the message does not name the flag').toContain(flag);
      expect(r.stderr, 'the message does not say what kind of value is wanted')
        .toMatch(/whole number/);
      // The two shapes this replaces, neither of which may come back.
      expect(r.stderr, 'a raw SQLite error reached the user').not.toContain('ERR_SQLITE_ERROR');
      expect(r.stderr, 'a stack trace reached the user').not.toMatch(/\n\s+at /);
    });
  }

  it('accepts a real number, and honours it — the anti-vacuity half', () => {
    // A coercion that rejected everything would satisfy every test above
    // and make the flags unusable. The size assertion is the second half:
    // `export --limit` used to be dropped on the floor, so "it exits 0" was
    // true of the broken version too.
    const seed = run(['remember', '--name', 'note-a', '--type', 'note', '--obs', 'first widget fact']);
    expect(seed.status, `setup: remember failed: ${seed.stderr}`).toBe(0);
    const second = run(['remember', '--name', 'note-b', '--type', 'note', '--obs', 'second widget fact']);
    expect(second.status, `setup: remember failed: ${second.stderr}`).toBe(0);

    const r = run(['export', '--limit', '1']);
    expect(r.status, `a valid --limit was rejected: ${r.stderr}`).toBe(0);
    const doc = JSON.parse(r.stdout) as { entities: unknown[] };
    expect(doc.entities, 'the limit was parsed and then ignored').toHaveLength(1);
  });

  it('refuses zero and negatives, which SQL would accept and misread', () => {
    // `LIMIT 0` returns nothing and `LIMIT -1` means "no limit" — both are
    // answers to a question the user did not ask.
    expect(run(['recall', 'anything', '--limit', '0']).status).not.toBe(0);
    expect(run(['recall', 'anything', '--limit', '-3']).status).not.toBe(0);
  });
});

describe('a database that will not open', () => {
  let home: string;
  let dbPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-brokendb-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
    // Not a SQLite file at all — the shape a truncated copy, a failed
    // restore or a synced-then-corrupted file takes.
    fs.writeFileSync(dbPath, 'this is not a database, it is a text file\n');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function run(args: string[]): { status: number; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    for (const key of ['MEMESH_DIR', 'MEMESH_DB_PATH']) delete env[key];
    const r = spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env, timeout: 30000 });
    return { status: r.status ?? 1, stderr: r.stderr ?? '' };
  }

  it('answers a sentence and a next step, not a stack trace', () => {
    const r = run(['recall', 'anything']);

    expect(r.status, 'a broken database exited 0').not.toBe(0);
    expect(r.stderr, 'the user is not told what to do next').toContain('memesh doctor');
    expect(r.stderr, 'a stack trace reached the user').not.toMatch(/\n\s+at /);
  });

  it('does the same for a write command', () => {
    // The helper is shared, so every command inherits the message — this is
    // the assertion that says so rather than assuming it.
    const r = run(['remember', '--name', 'a-name', '--type', 'note', '--obs', 'a fact']);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('memesh doctor');
  });

  it('a healthy database still works — the anti-vacuity half', () => {
    // Without this, a `withDatabase` that always reported a broken database
    // would pass both tests above and break every command.
    fs.rmSync(dbPath);
    const r = run(['recall', 'anything', '--json']);
    expect(r.status, `a healthy database was reported broken: ${r.stderr}`).toBe(0);
  });
});
