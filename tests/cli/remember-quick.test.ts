import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// v4.1 adds a quick-capture fallback for `memesh remember "<text>"`:
// fresh users naturally try the one-arg shape before reading the README,
// and the explicit --name/--type form would reject them. These tests lock
// that behavior so a future refactor cannot silently regress the
// first-time-user happy path.

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      // Mirror HOME → USERPROFILE so Windows os.homedir() resolves to the test tmpdir
      env: { ...process.env, ...env, USERPROFILE: env.HOME ?? process.env.USERPROFILE ?? '' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('memesh remember CLI: quick-capture form', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-remember-'));
    fs.mkdirSync(path.join(tmpHome, '.memesh'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('accepts a single positional text argument and stores it as a note', () => {
    const { stdout, stderr, exitCode } = runCli(
      ['remember', 'OAuth 2.0 with PKCE for the API'],
      { HOME: tmpHome },
    );

    expect(exitCode, `stderr was: ${stderr}`).toBe(0);
    // Default success line includes the auto-generated name.
    expect(stdout).toMatch(/Stored "quick-\d{4}-\d{2}-\d{2}-/);
    expect(stdout).toContain('1 observations');
  }, 60_000);

  it('still accepts the explicit --name/--type form', () => {
    const { exitCode } = runCli(
      ['remember', '--name=auth-decision', '--type=decision', '--obs=Use OAuth 2.0'],
      { HOME: tmpHome },
    );
    expect(exitCode).toBe(0);
  }, 60_000);

  it('errors with helpful guidance when no text and no flags are given', () => {
    const { stderr, exitCode } = runCli(['remember'], { HOME: tmpHome });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--name');
    expect(stderr).toContain('quick-capture');
  }, 60_000);

  // Codex challenge regression (2026-05-05): the previous quick-capture
  // name `quick-<date>-<slug>` was deterministic by day + first 40
  // chars of text. Two `memesh remember "fixed bug"` calls on the same
  // day collapsed into one entity (remember() appends observations on
  // duplicate-name) — silent data loss for journal-style usage. Names
  // now carry a 6-hex-char random suffix so each call is a new entity.
  it('produces a unique entity per call for identical quick-capture text (no silent merge)', () => {
    const r1 = runCli(['remember', 'fixed bug'], { HOME: tmpHome });
    const r2 = runCli(['remember', 'fixed bug'], { HOME: tmpHome });

    expect(r1.exitCode, `r1 stderr: ${r1.stderr}`).toBe(0);
    expect(r2.exitCode, `r2 stderr: ${r2.stderr}`).toBe(0);

    const m1 = r1.stdout.match(/Stored "(quick-[\w-]+)"/);
    const m2 = r2.stdout.match(/Stored "(quick-[\w-]+)"/);
    expect(m1, `r1 stdout: ${r1.stdout}`).not.toBeNull();
    expect(m2, `r2 stdout: ${r2.stdout}`).not.toBeNull();
    expect(m1![1]).not.toBe(m2![1]);

    // And the trailing random suffix shape is exactly 6 lowercase hex.
    expect(m1![1]).toMatch(/-[0-9a-f]{6}$/);
    expect(m2![1]).toMatch(/-[0-9a-f]{6}$/);
  }, 60_000);
});
