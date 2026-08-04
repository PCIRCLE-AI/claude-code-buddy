import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * A caller mistake gets one line of English and the documented exit code —
 * never a raw stack trace. The P7 audit hit three commands that let a throw
 * escape to the process top: `dream accept/reject <bad id>` printed the full
 * Node stack with this machine's absolute paths, and `verify <bad workdir>`
 * added an ENOENT cause chain. The messages inside those throws were fine;
 * the frame dump around them is what these tests pin down.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 30_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: typeof err.status === 'number' ? err.status : -1,
    };
  }
}

/** A stack frame looks like "    at fn (file:...)" — one line of prose does not. */
function expectNoStackTrace(text: string, label: string): void {
  expect(text, `${label} must not print a stack trace`).not.toMatch(/^\s+at /m);
  expect(text, `${label} must not leak absolute dist paths`).not.toContain('dist/core/');
}

describe('CLI error envelopes: caller mistakes are one line, not a crash', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-errenv-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('dream accept <nonexistent id> exits 1 with the message and a next step', () => {
    const r = runCli(['dream', 'accept', '999']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('proposal #999 not found or not pending');
    expect(r.stderr).toContain('memesh dream list');
    expectNoStackTrace(r.stderr, 'dream accept');
  });

  it('dream reject <nonexistent id> exits 1 with the message and a next step', () => {
    const r = runCli(['dream', 'reject', '999']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('proposal #999 not found or not pending');
    expectNoStackTrace(r.stderr, 'dream reject');
  });

  it('verify with a bogus workdir exits 2 (unverified) without a stack trace', () => {
    const r = runCli(['verify', '--agent-id', 'p7-test', '/nonexistent/bogus-dir']);
    expect(r.exitCode, 'nothing was checked, which is what exit 2 means').toBe(2);
    expect(r.stderr).toContain('workdir does not exist');
    expect(r.stderr).toContain('exit 2 = unverified');
    expectNoStackTrace(r.stderr, 'verify');
  });

  it('pin of a nonexistent entity exits 1 so scripts can see the protection did not happen', () => {
    const r = runCli(['pin', '--name', 'ghost-entity-p7']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('not found');
  });
});
