import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

// User Prompt Intent hook — detects "remember/save to memory" intent in
// prompts and injects a dual-write hint via stdout JSON.
// Test surface: regex precision, output shape, feature-flag gate, never-block guarantee.

describe('Feature: User Prompt Intent Hook', () => {
  function runHook(input: object, env: NodeJS.ProcessEnv = {}): { stdout: string; status: number | null } {
    const hookPath = path.resolve('scripts/hooks/user-prompt-intent.js');
    try {
      const stdout = execFileSync('node', [hookPath], {
        input: JSON.stringify(input),
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 5000,
      });
      return { stdout: stdout.trim(), status: 0 };
    } catch (e: any) {
      return { stdout: (e.stdout ?? '').toString().trim(), status: e.status ?? null };
    }
  }

  function expectNoOp(result: { stdout: string; status: number | null }) {
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  }

  function expectHint(result: { stdout: string; status: number | null }) {
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('memesh-remember-intent');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain('mcp__memesh__remember');
    return parsed;
  }

  describe('Scenario: positive intent detection', () => {
    it('detects "remember this" imperative', () => {
      expectHint(runHook({ prompt: 'Please remember this for later sessions' }));
    });

    it('detects "save to memory"', () => {
      expectHint(runHook({ prompt: 'save this to memory' }));
    });

    it('detects "save to memesh"', () => {
      expectHint(runHook({ prompt: 'save to memesh as a lesson' }));
    });

    it('detects "memorize this"', () => {
      expectHint(runHook({ prompt: 'memorize this preference' }));
    });

    it('detects "add this to memory"', () => {
      expectHint(runHook({ prompt: 'add this to memory please' }));
    });

    it('detects CJK 記下來', () => {
      expectHint(runHook({ prompt: '把這個記下來' }));
    });

    it('detects CJK 存到 memesh', () => {
      expectHint(runHook({ prompt: '存到 memesh 給未來 session' }));
    });

    it('detects CJK 記憶起來', () => {
      expectHint(runHook({ prompt: '把這個結論記憶起來' }));
    });

    it('accepts user_prompt field name (alternative)', () => {
      expectHint(runHook({ user_prompt: 'remember this fact' }));
    });
  });

  describe('Scenario: negative — passing mention of "remember"', () => {
    it('does NOT match conversational "remember when"', () => {
      expectNoOp(runHook({ prompt: 'Do you remember when we discussed this?' }));
    });

    it('does NOT match "I remember reading"', () => {
      expectNoOp(runHook({ prompt: "I remember reading the docs but can't find it" }));
    });

    it('does NOT match "Do you remember the X?" (regression: smoke test 2026-05-08)', () => {
      expectNoOp(runHook({ prompt: 'Do you remember the docs?' }));
      expectNoOp(runHook({ prompt: 'do you remember the API key we used last week?' }));
    });

    it('does NOT match "you remember" / "did you remember" patterns', () => {
      expectNoOp(runHook({ prompt: 'You remember this from before' }));
      expectNoOp(runHook({ prompt: 'Did you remember to commit?' }));
    });

    it('does NOT match "memory leak" debugging prompts', () => {
      expectNoOp(runHook({ prompt: 'Help me debug the memory leak in this code' }));
    });

    it('does NOT match unrelated "save" actions', () => {
      expectNoOp(runHook({ prompt: 'save this file as JSON' }));
      expectNoOp(runHook({ prompt: 'git stash save the work' }));
    });

    it('handles empty prompt', () => {
      expectNoOp(runHook({ prompt: '' }));
    });

    it('handles missing prompt field', () => {
      expectNoOp(runHook({}));
    });

    it('handles malformed JSON input gracefully (never blocks)', () => {
      const hookPath = path.resolve('scripts/hooks/user-prompt-intent.js');
      const result = (() => {
        try {
          const out = execFileSync('node', [hookPath], {
            input: 'not-json',
            env: process.env,
            encoding: 'utf8',
            timeout: 5000,
          });
          return { stdout: out.trim(), status: 0 };
        } catch (e: any) {
          return { stdout: '', status: e.status ?? null };
        }
      })();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    });
  });

  describe('Scenario: feature-flag gate', () => {
    it('emits NO hint when MEMESH_AUTO_CAPTURE=false', () => {
      expectNoOp(runHook({ prompt: 'remember this fact' }, { MEMESH_AUTO_CAPTURE: 'false' }));
    });

    it('emits hint when MEMESH_AUTO_CAPTURE=true (or unset, default-on)', () => {
      expectHint(runHook({ prompt: 'remember this fact' }, { MEMESH_AUTO_CAPTURE: 'true' }));
    });
  });

  describe('Scenario: hint content', () => {
    it('mentions both stores (memesh + Claude Code MEMORY.md)', () => {
      const parsed = expectHint(runHook({ prompt: 'remember this for me' }));
      const hint = parsed.hookSpecificOutput.additionalContext;
      expect(hint).toContain('mcp__memesh__remember');
      expect(hint).toContain('MEMORY.md');
      expect(hint).toContain('namespace=personal');
    });

    it('instructs scope-based namespace decision', () => {
      const parsed = expectHint(runHook({ prompt: 'save to memory please' }));
      const hint = parsed.hookSpecificOutput.additionalContext;
      expect(hint).toContain('Machine-level');
      expect(hint).toContain('Project-internal');
      expect(hint).toMatch(/global/i);
    });

    it('instructs bidirectional pointer between memesh + file', () => {
      const parsed = expectHint(runHook({ prompt: 'memorize this preference' }));
      const hint = parsed.hookSpecificOutput.additionalContext;
      expect(hint).toContain('bidirectional pointer');
    });
  });
});
