/**
 * Cross-hook gate for the Claude Code hook-output contract.
 *
 * Issue #53 shipped because every hook test asserted the shape its own hook
 * happened to emit. `pre-compact.js` emitted a `hookSpecificOutput` variant
 * that Claude Code has no schema for; its test asserted exactly that; CI was
 * green while every real compaction showed the user a validation error.
 *
 * Per-hook tests cannot catch that class of bug — they are tautological. This
 * file is the non-tautological counterpart: it runs every hook MeMesh ships
 * and validates the stdout against the externally-derived contract in
 * tests/helpers/hook-output-contract.ts. A hook that invents a shape fails
 * here regardless of what its own test believes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  expectValidHookOutput,
  validateHookOutput,
  HOOK_SPECIFIC_OUTPUT_EVENTS,
} from '../helpers/hook-output-contract.js';

interface HookCase {
  /** Filename under scripts/hooks/ */
  file: string;
  /** Event it is bound to in hooks/hooks.json */
  boundEvent: string;
  /** Representative stdin payload */
  input: Record<string, unknown>;
  /** Extra env needed to reach the emitting path */
  env?: Record<string, string>;
}

/**
 * One entry per hook declared in hooks/hooks.json. Keep in sync — the
 * "every declared hook is covered" test below fails if a hook is added to
 * hooks.json without a case here.
 */
const HOOK_CASES: HookCase[] = [
  {
    file: 'pre-edit-recall.js',
    boundEvent: 'PreToolUse',
    input: {
      session_id: 'contract-1',
      cwd: '/tmp/contract-project',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/contract-project/src/auth.ts' },
    },
  },
  {
    file: 'pre-bash-orchestration-nudge.js',
    boundEvent: 'PreToolUse',
    input: {
      session_id: 'contract-2',
      cwd: '/tmp/contract-project',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    },
    // Nudge is opt-in; without this it exits silently and the case is vacuous.
    env: { MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '1' },
  },
  {
    file: 'session-start.js',
    boundEvent: 'SessionStart',
    input: {
      session_id: 'contract-3',
      cwd: '/tmp/contract-project',
      hook_event_name: 'SessionStart',
      source: 'startup',
    },
  },
  {
    file: 'post-commit.js',
    boundEvent: 'PostToolUse',
    input: {
      session_id: 'contract-4',
      cwd: '/tmp/contract-project',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      tool_response: { stdout: '[main abc1234] test\n 1 file changed, 1 insertion(+)' },
    },
  },
  {
    file: 'session-summary.js',
    boundEvent: 'Stop',
    input: {
      session_id: 'contract-5',
      cwd: '/tmp/contract-project',
      hook_event_name: 'Stop',
      transcript_path: '',
    },
  },
  {
    file: 'pre-compact.js',
    boundEvent: 'PreCompact',
    input: {
      session_id: 'contract-6',
      cwd: '/tmp/contract-project',
      hook_event_name: 'PreCompact',
      transcript_path: '',
      reason: 'auto',
    },
  },
  {
    file: 'user-prompt-intent.js',
    boundEvent: 'UserPromptSubmit',
    input: {
      session_id: 'contract-7',
      cwd: '/tmp/contract-project',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'remember that we use PKCE for OAuth',
    },
  },
];

describe('Feature: Claude Code hook-output contract', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-contract-'));
    dbPath = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function runHook(hookCase: HookCase): string {
    const hookPath = path.resolve('scripts/hooks', hookCase.file);
    try {
      return execFileSync('node', [hookPath], {
        input: JSON.stringify(hookCase.input),
        env: {
          ...process.env,
          MEMESH_DB_PATH: dbPath,
          MEMESH_DIR: testDir,
          // Keep the run hermetic: no npm registry check, no detached spawn.
          MEMESH_AUTO_UPDATE: '0',
          ...hookCase.env,
        },
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch (err) {
      // A hook must never fail the harness; surface stdout anyway so the
      // contract assertion reports the real payload rather than a spawn error.
      const e = err as { stdout?: string };
      if (typeof e.stdout === 'string') return e.stdout;
      throw err;
    }
  }

  for (const hookCase of HOOK_CASES) {
    it(`Scenario: ${hookCase.file} (${hookCase.boundEvent}) emits a contract-valid payload`, () => {
      const stdout = runHook(hookCase);
      expectValidHookOutput(stdout, `${hookCase.file} stdout`);
    });

    it(`Scenario: ${hookCase.file} never claims a hookSpecificOutput variant its event lacks`, () => {
      const stdout = runHook(hookCase);
      const result = validateHookOutput(stdout);
      const hso = result.parsed?.hookSpecificOutput as { hookEventName?: string } | undefined;
      if (!hso) return; // emitting nothing, or top-level-only, is always fine

      // The event named inside hookSpecificOutput must be one Claude Code
      // actually defines, and must match the event the hook is bound to.
      expect(Object.keys(HOOK_SPECIFIC_OUTPUT_EVENTS)).toContain(hso.hookEventName);
      expect(hso.hookEventName).toBe(hookCase.boundEvent);
    });
  }

  it('Scenario: PreCompact has no hookSpecificOutput variant (regression guard for #53)', () => {
    expect(HOOK_SPECIFIC_OUTPUT_EVENTS).not.toHaveProperty('PreCompact');

    // The exact payload that shipped in v4.2.7 must be rejected by the validator.
    const shipped = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext: 'Saved 169 insights to MeMesh before compaction',
      },
    });
    const result = validateHookOutput(shipped);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('no variant for event "PreCompact"');
  });

  it('Scenario: every hook declared in hooks.json has a contract case', () => {
    const hooksJson = JSON.parse(fs.readFileSync(path.resolve('hooks/hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    const declared = new Set<string>();
    for (const matchers of Object.values(hooksJson.hooks)) {
      for (const matcher of matchers) {
        for (const entry of matcher.hooks) {
          declared.add(path.basename(entry.command));
        }
      }
    }

    const covered = new Set(HOOK_CASES.map((c) => c.file));
    const uncovered = [...declared].filter((f) => !covered.has(f));
    expect(uncovered).toEqual([]);
  });
});
