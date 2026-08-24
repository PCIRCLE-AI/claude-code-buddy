import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * `memesh why` end to end, against the packaged CLI: local git resolves the
 * commits, the graph answers, and every gap arrives as a typed abstention.
 * The core logic is covered in tests/core/why.test.ts — what THIS file pins
 * is the wiring the unit tests cannot see: the command exists in dist, runs
 * git in the caller's cwd, scopes to the cwd's project, and renders
 * abstentions instead of crashing.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');

let home: string;
let repoDir: string;

/**
 * Run the CLI and capture BOTH streams, whatever the exit code.
 *
 * `execFileSync` only surfaces stderr when the process throws, so the success
 * path used to hardcode `stderr: ''`. Every "no stack trace reached the user"
 * assertion in this file therefore checked stdout — where a stack trace never
 * goes — and passed no matter what the command printed to stderr. `spawnSync`
 * returns both streams on every outcome.
 */
function runCli(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMESH_AUTO_UPDATE: '0' },
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // `status` is null when a signal killed it (a timeout) — a failure, not 0.
    exitCode: result.status ?? -1,
  };
}

function git(args: string[]): void {
  execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', timeout: 15000 });
}

describe('CLI: memesh why', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cli-why-'));
    repoDir = path.join(home, 'repo');
    fs.mkdirSync(repoDir);
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('Scenario: a committed file joins git history to the graph, scoped to the cwd project', () => {
    fs.writeFileSync(path.join(repoDir, 'auth.ts'), 'export const a = 1;\n');
    git(['add', '--', 'auth.ts']);
    git(['commit', '-q', '-m', 'feat: add auth', '--no-verify']);
    const abbrev = execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8', timeout: 15000,
    }).trim();

    // Seed the commit entity the way post-commit names them (abbrev hash).
    const seed = runCli(
      ['remember', '--name', `commit-${abbrev}`, '--type', 'commit', '--obs', 'feat: add auth'],
      repoDir,
    );
    expect(seed.exitCode, seed.stderr).toBe(0);

    const res = runCli(['why', 'auth.ts', '--json'], repoDir);
    expect(res.exitCode, res.stderr).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.project).toBe('repo');
    expect(parsed.commits).toHaveLength(1);
    expect(parsed.commits[0].commit.hash).toHaveLength(40);
    expect(parsed.commits[0].entity.name).toBe(`commit-${abbrev}`);
    // Seeded via `remember`, so no session metadata exists — the honest answer.
    expect(parsed.commits[0].abstentions).toEqual(['no_session_link']);
  });

  it('Scenario: an untracked file renders the typed abstention as a sentence, exit 0', () => {
    fs.writeFileSync(path.join(repoDir, 'notes.md'), 'scratch\n');
    const res = runCli(['why', 'notes.md'], repoDir);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toContain('not tracked by git');
    // BOTH streams. A stack trace goes to stderr, which this helper used to
    // hardcode as empty on the success path — so the assertion below was
    // checking the one stream a trace never reaches.
    expect(res.stdout + res.stderr, 'a stack trace reached the user').not.toMatch(/^\s+at /m);
  });

  it('Scenario: a nonexistent path exits 1 and says so — not "not tracked by git" (M-07)', () => {
    // A typo'd path used to get the SAME message as `notes.md` above — a
    // real, existing file that simply is not committed. That sentence
    // reads as "this file is real, go commit it", not "you misspelled
    // the path", and the caller-mistake convention `pin`/`forget` already
    // follow (exit 1 for "the thing named does not exist") did not apply.
    const res = runCli(['why', 'no-such-file.ts'], repoDir);
    expect(res.exitCode, res.stderr).toBe(1);
    expect(res.stdout).toContain('No such file');
    expect(res.stdout).not.toContain('not tracked by git');
  });
});
