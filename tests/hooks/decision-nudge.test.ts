/**
 * decision-nudge.js — PostToolUse hook for ExitPlanMode / AskUserQuestion (#277).
 *
 * MeMesh's read side fires automatically; the write side did not, so an
 * agent could make several decisions in a session and store none of them
 * until asked. This hook closes that gap with a one-line reminder at the
 * two tool calls where a decision most likely just happened.
 *
 * Contract under test, against the REAL spawned script (not a reimplementation):
 *   - ExitPlanMode and AskUserQuestion each get the nudge.
 *   - Any other tool_name is silent.
 *   - At most once per (session, tool) — a second call for the SAME tool in
 *     the SAME session is silent; a DIFFERENT tool in the same session still
 *     nudges.
 *   - Malformed JSON / missing session_id exit 0 with empty stdout.
 *   - Nothing is written outside MEMESH_DIR — in particular the hook never
 *     creates or opens the knowledge-graph database (it is forbidden to).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { removeTempDir } from '../helpers/temp-dir.js';
import { expectPrivateFile } from '../helpers/permissions.js';
import { expectValidHookOutput } from '../helpers/hook-output-contract.js';

const HOOK_PATH = path.resolve('scripts/hooks/decision-nudge.js');

describe('Feature: decision-nudge hook (PostToolUse ExitPlanMode|AskUserQuestion)', () => {
  let tmpHome: string;
  let memeshDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-decision-nudge-'));
    memeshDir = path.join(tmpHome, '.memesh');
    fs.mkdirSync(memeshDir, { recursive: true });
    // A db PATH is provided (matching how a real install sets it) precisely
    // to prove the hook never touches it — see 'never opens the database' below.
    dbPath = path.join(memeshDir, 'knowledge-graph.db');
  });

  afterEach(() => {
    removeTempDir(tmpHome);
  });

  function runHook(input: object | string): { stdout: string; stderr: string; status: number | null } {
    const stdinBody = typeof input === 'string' ? input : JSON.stringify(input);
    const result = spawnSync('node', [HOOK_PATH], {
      input: stdinBody,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome, // Windows parity
        MEMESH_DIR: memeshDir,
        MEMESH_DB_PATH: dbPath,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    return {
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      status: result.status ?? null,
    };
  }

  function payload(toolName: string, sessionId = 'contract-session-1', extra: object = {}) {
    return {
      session_id: sessionId,
      cwd: tmpHome,
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: { foo: 'bar' },
      ...extra,
    };
  }

  function listAllFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listAllFiles(full));
      else out.push(full);
    }
    return out;
  }

  it('ExitPlanMode gets the nudge, with the PostToolUse contract shape', () => {
    const { stdout, stderr, status } = runHook(payload('ExitPlanMode'));
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).not.toBe('');
    expectValidHookOutput(stdout, 'decision-nudge.js stdout');
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('ExitPlanMode');
    expect(ctx).toContain('remember');
    expect(ctx).toContain('type:decision or type:lesson');
    expect(ctx).toContain('project:<name>');
    // Not memory content — must NOT ride the buildReferenceContext fence
    // that recalled/guard content uses (see the hook's own comment on why).
    expect(ctx).not.toContain('background data');
  });

  it('AskUserQuestion gets the nudge', () => {
    const { stdout, status } = runHook(payload('AskUserQuestion'));
    expect(status).toBe(0);
    expect(stdout).not.toBe('');
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('AskUserQuestion');
  });

  it('a different tool_name emits nothing', () => {
    const { stdout, status, stderr } = runHook(payload('Bash'));
    expect(status).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('');
  });

  it('is rate-limited to at most once per tool per session', () => {
    const first = runHook(payload('ExitPlanMode', 'same-session'));
    expect(first.stdout).not.toBe('');

    const second = runHook(payload('ExitPlanMode', 'same-session'));
    expect(second.status).toBe(0);
    expect(second.stdout).toBe('');
  });

  it('a different session still nudges after the first session already claimed the flag', () => {
    const s1 = runHook(payload('ExitPlanMode', 'session-a'));
    expect(s1.stdout).not.toBe('');
    const s2 = runHook(payload('ExitPlanMode', 'session-b'));
    expect(s2.stdout).not.toBe('');
  });

  it('a different tool in the SAME session still nudges — the rate limit is per (session, tool)', () => {
    const planNudge = runHook(payload('ExitPlanMode', 'mixed-session'));
    expect(planNudge.stdout).not.toBe('');
    const questionNudge = runHook(payload('AskUserQuestion', 'mixed-session'));
    expect(questionNudge.stdout).not.toBe('');
  });

  it('malformed JSON exits 0 with no output', () => {
    const { stdout, status, stderr } = runHook('not-json-at-all{{{');
    expect(status).toBe(0);
    expect(stdout).toBe('');
    // Not asserting stderr is empty here — a JSON parse failure is allowed
    // to trace, but it must never crash or block.
    expect(stderr === '' || stderr.includes('decision-nudge')).toBe(true);
  });

  it('empty stdin exits 0 with no output', () => {
    const { stdout, status } = runHook('');
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('missing session_id exits 0 with no output, even for a target tool', () => {
    const { stdout, status } = runHook({
      cwd: tmpHome,
      hook_event_name: 'PostToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: {},
    });
    expect(status).toBe(0);
    expect(stdout).toBe('');
  });

  it('a session_id that is not filename-safe exits 0 with no output (path-traversal guard)', () => {
    const { stdout, status } = runHook(payload('ExitPlanMode', '../../etc/passwd'));
    expect(status).toBe(0);
    expect(stdout).toBe('');
    // And nothing was written anywhere near that traversal target.
    expect(fs.existsSync(path.join(memeshDir, 'decision-nudge-flags'))).toBe(false);
  });

  it('never opens the database — no db file is created by a nudge', () => {
    runHook(payload('ExitPlanMode', 'db-check-session'));
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('creates nothing outside MEMESH_DIR, and the flag file is private (0600)', () => {
    runHook(payload('ExitPlanMode', 'fs-scope-session'));
    const files = listAllFiles(tmpHome);
    // Every file that exists anywhere under tmpHome must live under memeshDir.
    for (const f of files) {
      expect(f.startsWith(memeshDir + path.sep) || f === memeshDir).toBe(true);
    }
    const flagPath = path.join(memeshDir, 'decision-nudge-flags', 'fs-scope-session-ExitPlanMode.flag');
    expect(fs.existsSync(flagPath)).toBe(true);
    expectPrivateFile(flagPath);
  });

  it('finishes well under the hook budget', () => {
    const start = Date.now();
    runHook(payload('ExitPlanMode', 'timing-session'));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
