/**
 * Conflict detection, reachable from the terminal.
 *
 * `findConflicts()` runs on every recall and reports any `contradicts`
 * relation between the results. Nothing creates that relation automatically —
 * a caller states it — and the CLI had no flag for stating any relation at
 * all. So for anyone using `memesh` from a terminal the answer was structurally
 * fixed: every recall said "no conflicts", not because it had checked and
 * found none, but because nothing they could type would ever create one.
 *
 * Both behavioural relation types are now flags on `remember`.
 * `tests/relation-types-documented.test.ts` fails if either loses its flag or
 * its help text; this file checks that the flags do what they say against a
 * real database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', exitCode: e.status ?? 1 };
  }
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-relations-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('memesh remember --contradicts', () => {
  it('makes recall report the conflict', () => {
    expect(runCli(['remember', '--name', 'use-jwt', '--type', 'decision', '--obs', 'We use JWT']).exitCode).toBe(0);
    const stated = runCli(['remember', '--name', 'no-jwt', '--type', 'decision', '--obs', 'We do not use JWT', '--contradicts', 'use-jwt']);
    expect(stated.exitCode, stated.stderr).toBe(0);
    expect(stated.stdout).toContain('conflicts stated: use-jwt');

    const recalled = runCli(['recall', 'jwt']);
    expect(recalled.stdout).toContain('Conflicts detected');
    expect(recalled.stdout).toContain('"no-jwt" contradicts "use-jwt"');
  });

  it('recall without a stated contradiction reports none', () => {
    // The control. Without it, a recall that printed "Conflicts detected"
    // unconditionally would satisfy the test above.
    runCli(['remember', '--name', 'alpha', '--type', 'note', '--obs', 'unrelated one']);
    runCli(['remember', '--name', 'beta', '--type', 'note', '--obs', 'unrelated two']);
    expect(runCli(['recall', 'unrelated']).stdout).not.toContain('Conflicts detected');
  });

  it('says so when the target does not exist, and exits non-zero', () => {
    // The relation was not created, so the conflict the user asked for will
    // never fire. Reporting success here is the failure this repository keeps
    // finding.
    const r = runCli(['remember', '--name', 'orphan', '--type', 'note', '--obs', 'x', '--contradicts', 'nothing-here']);
    expect(r.stderr + r.stdout).toMatch(/Relation to "nothing-here" failed/);
    expect(r.exitCode).toBe(1);
  });
});

describe('memesh remember --supersedes', () => {
  it('archives the named entity and says that it did', () => {
    runCli(['remember', '--name', 'auth-v1', '--type', 'decision', '--obs', 'old plan']);
    const r = runCli(['remember', '--name', 'auth-v2', '--type', 'decision', '--obs', 'new plan', '--supersedes', 'auth-v1']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('archived as superseded: auth-v1');

    // The database is the check, not the message.
    expect(runCli(['recall', 'plan']).stdout).not.toContain('auth-v1');
    expect(runCli(['recall', 'plan', '--include-archived']).stdout).toContain('auth-v1');
  });
});
