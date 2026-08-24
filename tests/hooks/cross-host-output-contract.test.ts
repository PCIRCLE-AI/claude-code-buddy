/**
 * Hook output that two hosts must both accept.
 *
 * `hook-output-contract.test.ts` next door asks "is this valid Claude Code
 * hook output". That is a different question from "will every host we
 * document support accept it", and the gap between them shipped: both
 * `post-commit.js` and `session-summary.js` ended with
 * `console.log(JSON.stringify({ suppressOutput: true }))`, which is
 * unimpeachable Claude Code output and which Codex CLI rejects per event.
 * Reported from a live Codex session in 4.7.1 and 4.7.2:
 *
 *   PostToolUse hook returned unsupported suppressOutput
 *   hook returned invalid post-tool-use JSON output
 *   hook returned invalid stop hook JSON output
 *
 * Once per Bash call and once per turn, with the capture itself having
 * already succeeded — so the memory was written and the user got an error
 * about it anyway.
 *
 * The field was never doing any work. Neither hook writes anything else to
 * stdout, so there was no output to suppress; it only announced an intent
 * that silence already expresses. Empty stdout with exit 0 is the "no
 * opinion" signal in both contracts.
 *
 * This file pins the portable answer: these two hooks say nothing at all.
 * The neighbouring contract test would pass either way — it accepts
 * `kind: 'empty'` AND a well-formed envelope — which is exactly why the
 * regression needs its own assertion rather than relying on that one.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';

function runHook(file: string, payload: object, home: string): { stdout: string; status: number } {
  const hookPath = path.resolve('scripts/hooks', file);
  try {
    const stdout = execFileSync('node', [hookPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

describe('hooks that must be silent on success', () => {
  it('post-commit.js writes nothing after a REAL commit it accepts', () => {
    // The path that matters, and the only one the shipped bug was on. Every
    // early return in this hook already exited silently, so a synthetic
    // payload proves nothing: it is turned away at one of six gates before
    // reaching the line that used to print. This builds a real repository and
    // a real commit, and feeds the hook the hash git actually produced —
    // otherwise `git cat-file -e <hash>^{commit}` rejects it and the test
    // passes for the wrong reason.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-crosshost-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-crosshost-repo-'));
    try {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      git(repo, 'add', 'a.txt');
      const commitOut = git(repo, 'commit', '-m', 'add a.txt');

      // Guard the guard: if git's output stopped matching the hook's own
      // regex, the hook would bail early and this test would go quiet.
      expect(commitOut, "git's commit line no longer matches what the hook parses")
        .toMatch(/\[[\w/.-]+(?: \([\w -]+\))? [a-f0-9]{7,}\]/);

      const { stdout, status } = runHook('post-commit.js', {
        session_id: 'cross-host-1',
        cwd: repo,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "add a.txt"' },
        tool_response: { stdout: commitOut },
      }, home);

      expect(status, 'post-commit.js exited non-zero on a real commit').toBe(0);
      expect(
        stdout.trim(),
        'post-commit.js wrote to stdout. Codex validates hook output per event and rejects '
        + 'fields Claude Code accepts — `suppressOutput` is the one that shipped in 4.7.1/4.7.2 '
        + 'and errored on every Bash call. Silence is what both hosts accept.',
      ).toBe('');

      // And the capture still happened — silence must not mean "did nothing".
      const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
      expect(fs.existsSync(dbPath), 'the hook went silent AND stopped capturing').toBe(true);
    } finally {
      removeTempDir(home, repo);
    }
  });

  it('session-summary.js writes nothing on a Stop it declines to act on', () => {
    // Weaker than the case above and labelled so: with an empty transcript this
    // takes an early return rather than the full path. It still pins that the
    // early returns stay silent; the source scan below is what covers the
    // completed path for this hook.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-crosshost-'));
    fs.mkdirSync(path.join(home, '.memesh'), { recursive: true });
    try {
      const { stdout, status } = runHook('session-summary.js', {
        session_id: 'cross-host-2',
        cwd: home,
        hook_event_name: 'Stop',
        transcript_path: '',
      }, home);

      expect(status).toBe(0);
      expect(stdout.trim(), 'session-summary.js wrote to stdout on an early return').toBe('');
    } finally {
      removeTempDir(home);
    }
  });

  it('no hook still emits suppressOutput from a branch the success path misses', () => {
    // The runtime assertions above only cover the success path. An early
    // return that emits the field would slip past them, and the field reads as
    // harmless enough to be reintroduced by someone tidying up.
    //
    // Comments are stripped before scanning, deliberately: the hooks now carry
    // a comment explaining why the field is absent, and a check that cannot
    // tell an explanation from an emission would forbid documenting the
    // decision. Naming the mistake is how it stays fixed.
    const dir = path.resolve('scripts/hooks');
    const stripComments = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');

    const offenders = fs.readdirSync(dir)
      .filter(f => f.endsWith('.js'))
      .filter(f => /suppressOutput/.test(stripComments(fs.readFileSync(path.join(dir, f), 'utf8'))));

    expect(offenders, `these hooks emit suppressOutput, which Codex rejects per event`)
      .toEqual([]);
  });
});
