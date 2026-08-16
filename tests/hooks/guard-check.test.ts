/**
 * G1 wired end to end on the HOOK side, against spawned real hooks:
 *
 *   - guard-check.js (PreToolUse Bash): an accepted guard fires on a
 *     matching command — fenced warning with the lesson's `[mem:id]`
 *     handle, fire counted in metadata — and stays silent otherwise.
 *   - pre-edit-recall.js (PreToolUse Edit|Write): the same store serves
 *     Edit guards, and the guard half is NOT throttled — the recall
 *     throttle must never mute a warning about a dangerous edit.
 *
 * Contract order matters: every failure path is a silent pass. A guard
 * system that can break the user's Bash tool is worse than no guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Feature: lesson guards at the PreToolUse hooks', () => {
  let tmpHome: string;
  let dbPath: string;
  let db: any;
  let kg: any;

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-guard-hook-'));
    dbPath = path.join(tmpHome, 'graph.db');
    process.env.MEMESH_DB_PATH = dbPath;
    const dbMod = await import('../../src/db.js');
    db = dbMod.openDatabase(dbPath);
    const { KnowledgeGraph } = await import('../../src/knowledge-graph.js');
    kg = new KnowledgeGraph(db);
  });

  afterEach(async () => {
    const { closeDatabase } = await import('../../src/db.js');
    try { closeDatabase(); } catch { /* already closed */ }
    delete process.env.MEMESH_DB_PATH;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function seedGuardedLesson(guard: Record<string, unknown>, name = 'guarded-lesson'): number {
    return kg.createEntity(name, 'lesson_learned', {
      observations: ['Error: it happened', 'Fix: do not'],
      tags: ['project:memesh'],
      metadata: { guard },
    });
  }

  function runHook(script: string, input: object): { stdout: string; stderr: string } {
    const hookPath = path.resolve(`scripts/hooks/${script}`);
    const result = spawnSync('node', [hookPath], {
      input: JSON.stringify({ cwd: tmpHome, ...input }),
      env: { ...process.env, MEMESH_DB_PATH: dbPath },
      encoding: 'utf8',
      timeout: 10000,
    });
    if (result.error) throw result.error;
    expect(result.status, `hook exited ${result.status}\nstderr:\n${result.stderr}`).toBe(0);
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  const bashGuard = {
    enabled: true,
    action: 'warn',
    tool: 'Bash',
    pattern: 'git\\s+checkout\\s+--\\s',
    message: 'git checkout -- discards uncommitted work. Commit or stash first.',
    fires: 0,
  };

  it('a matching Bash command gets the fenced warning with the citation handle, and the fire is counted', () => {
    const lessonId = seedGuardedLesson(bashGuard);

    const { stdout, stderr } = runHook('guard-check.js', {
      tool_name: 'Bash',
      tool_input: { command: 'git checkout -- src/core/' },
    });
    expect(stderr).toBe('');
    const out = JSON.parse(stdout);
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('discards uncommitted work');
    expect(ctx).toContain(`[mem:${lessonId}]`);
    // Memory content rides the reference fence like every injection path.
    expect(ctx).toContain('background data');

    const meta = JSON.parse(db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata);
    expect(meta.guard.fires).toBe(1);
    expect(typeof meta.guard.last_fired_at).toBe('string');
  });

  it('a non-matching command, a disabled guard, and a wrong-tool guard are all silence', () => {
    seedGuardedLesson(bashGuard, 'g-armed');
    seedGuardedLesson({ ...bashGuard, enabled: false, pattern: 'rm\\s+-rf\\s' }, 'g-disabled');
    seedGuardedLesson({ ...bashGuard, tool: 'Edit', pattern: 'checkout' }, 'g-edit-only');

    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'git status' } }).stdout).toBe('');
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } }).stdout).toBe('');
    // 'checkout' appears in the command, but that guard is Edit-scoped.
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'echo checkout' } }).stdout).toBe('');
  });

  it('no database, no command, garbage input — all silent passes', () => {
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: {} }).stdout).toBe('');
    fs.rmSync(dbPath, { force: true });
    expect(runHook('guard-check.js', { tool_name: 'Bash', tool_input: { command: 'git checkout -- x' } }).stdout).toBe('');
  });

  it('an Edit guard fires from pre-edit-recall against path plus incoming content — even when the recall throttle would skip the file', () => {
    const lessonId = seedGuardedLesson({
      ...bashGuard,
      tool: 'Edit',
      pattern: 'password\\s*=\\s*["\']',
    }, 'no-hardcoded-secrets');

    const input = {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/config.ts', new_string: 'const password = "hunter2"' },
    };

    const first = runHook('pre-edit-recall.js', input);
    expect(first.stdout).not.toBe('');
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain(`[mem:${lessonId}]`);

    // Second edit of the SAME file: the recall half is throttled now, but
    // the dangerous content must still warn — a throttle that mutes guards
    // would train exactly one repetition of every mistake.
    const second = runHook('pre-edit-recall.js', input);
    expect(second.stdout).not.toBe('');
    expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toContain(`[mem:${lessonId}]`);

    const meta = JSON.parse(db.prepare('SELECT metadata FROM entities WHERE id = ?').get(lessonId).metadata);
    expect(meta.guard.fires).toBe(2);
  });

  it('a safe edit stays guard-silent (recall may still speak, guards must not)', () => {
    seedGuardedLesson({ ...bashGuard, tool: 'Edit', pattern: 'password\\s*=\\s*["\']' }, 'no-hardcoded-secrets');
    const { stdout } = runHook('pre-edit-recall.js', {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/other.ts', new_string: 'const user = readEnv()' },
    });
    if (stdout !== '') {
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).not.toContain('A guard you accepted');
    }
  });
});
