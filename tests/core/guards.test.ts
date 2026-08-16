/**
 * The guard leaf — one definition of "what is a valid guard" and "does a
 * guard fire", shared by the dreamer's proposer, the accept path and the
 * PreToolUse hooks (via the generated mirror). These are the pure halves;
 * the wired halves are pinned in tests/core/lesson-guards.test.ts (dreamer)
 * and tests/hooks/guard-check.test.ts (spawned hooks).
 */
import { describe, it, expect } from 'vitest';
import {
  validateGuardSpec,
  matchingGuards,
  guardFromMetadata,
  GUARD_BENIGN_PROBES,
  type GuardSpec,
  type ActiveGuard,
} from '../../src/core/guards.js';

const valid: GuardSpec = {
  tool: 'Bash',
  pattern: 'git\\s+checkout\\s+--\\s',
  message: 'git checkout -- discards uncommitted work with no undo. Commit or stash first.',
  should_match: ['git checkout -- src/', 'git  checkout -- .'],
  should_not_match: ['git checkout -b feature', 'git status'],
};

describe('validateGuardSpec', () => {
  it('accepts a specific, evidenced spec', () => {
    expect(validateGuardSpec(valid)).toEqual([]);
  });

  it('rejects non-objects and unknown tools', () => {
    expect(validateGuardSpec(null)).toEqual(['guard spec is not an object']);
    expect(validateGuardSpec({ ...valid, tool: 'WebFetch' }).join(' ')).toContain('tool must be one of');
  });

  it('rejects patterns that cannot be a guard: too short, non-compiling, empty-matching', () => {
    expect(validateGuardSpec({ ...valid, pattern: 'rm -' }).join(' ')).toContain('6–200 chars');
    expect(validateGuardSpec({ ...valid, pattern: '([a-z]+' }).join(' ')).toContain('does not compile');
    expect(validateGuardSpec({ ...valid, pattern: '(x)?(y)?' }).join(' ')).toContain('matches the empty string');
  });

  it('rejects a pattern broad enough to fire on routine work', () => {
    // `git\s` matches `git status` — a guard like that nags until the user
    // turns the feature off, which is how safety features die.
    const errors = validateGuardSpec({
      ...valid,
      pattern: 'git\\s+\\w+',
      should_match: ['git checkout -- src/', 'git add -A'],
      should_not_match: ['ls -la', 'echo hi'],
    });
    expect(errors.join(' ')).toContain('benign input');
  });

  it('executes the evidence: failing examples fail the spec', () => {
    expect(validateGuardSpec({ ...valid, should_match: ['git stash', 'git checkout -- x'] }).join(' '))
      .toContain('should_match example does not match');
    expect(validateGuardSpec({ ...valid, should_not_match: ['git checkout -- y', 'git status'] }).join(' '))
      .toContain('should_not_match example matches');
    expect(validateGuardSpec({ ...valid, should_match: ['git checkout -- x'] }).join(' '))
      .toContain('at least 2');
  });

  it('keeps the benign probe list honest — every probe is plausible routine work', () => {
    // Anti-vacuity: an empty probe list would silently gut the broadness
    // check above.
    expect(GUARD_BENIGN_PROBES.length).toBeGreaterThanOrEqual(5);
  });
});

describe('matchingGuards', () => {
  const guards: ActiveGuard[] = [
    { lessonId: 1, tool: 'Bash', pattern: 'git\\s+add\\s+(-A|\\.)(\\s|$)', message: 'stage explicit paths', action: 'warn' },
    { lessonId: 2, tool: 'Edit', pattern: 'password\\s*=', message: 'no hardcoded secrets', action: 'warn' },
    { lessonId: 3, tool: 'Bash', pattern: '([a-z', message: 'corrupt — must be skipped', action: 'warn' },
    { lessonId: 4, tool: 'Bash', pattern: 'git\\s+add', message: 'wrong action value', action: 'maybe' },
  ];

  it('fires only for the matching tool and pattern, case-insensitively', () => {
    const hits = matchingGuards(guards, 'Bash', 'GIT ADD -A');
    expect(hits.map((g) => g.lessonId)).toEqual([1]);
    expect(matchingGuards(guards, 'Edit', 'const password = "x"').map((g) => g.lessonId)).toEqual([2]);
  });

  it('a corrupt pattern degrades to silence, never to a crash', () => {
    expect(() => matchingGuards(guards, 'Bash', 'anything')).not.toThrow();
    expect(matchingGuards(guards, 'Bash', 'ls').length).toBe(0);
  });

  it('an unknown action value is not a firing guard', () => {
    // lessonId 4 matches the haystack but carries action 'maybe' — firing
    // on a value the schema does not define would let a typo widen policy.
    expect(matchingGuards(guards, 'Bash', 'git add src/x.ts').map((g) => g.lessonId)).toEqual([]);
  });

  it('empty haystack fires nothing', () => {
    expect(matchingGuards(guards, 'Bash', '').length).toBe(0);
  });
});

describe('guardFromMetadata', () => {
  it('parses an enabled guard and defaults action to warn', () => {
    const g = guardFromMetadata(7, JSON.stringify({ guard: { enabled: true, tool: 'Bash', pattern: 'x{6,}', message: 'm' } }));
    expect(g).toEqual({ lessonId: 7, tool: 'Bash', pattern: 'x{6,}', message: 'm', action: 'warn' });
  });

  it('disabled, malformed or absent guards are null', () => {
    expect(guardFromMetadata(7, JSON.stringify({ guard: { enabled: false, tool: 'Bash', pattern: 'x', message: 'm' } }))).toBeNull();
    expect(guardFromMetadata(7, JSON.stringify({ guard: { enabled: true, tool: 'Bash' } }))).toBeNull();
    expect(guardFromMetadata(7, 'not json')).toBeNull();
    expect(guardFromMetadata(7, null)).toBeNull();
  });
});
