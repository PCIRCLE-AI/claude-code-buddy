// signal-scorer — locks down the rule-based score contract.
// Critical scenarios:
//   1. lesson_learned + decision + architecture stay HIGH (≥0.85)
//   2. empty session_keypoint from ~/.claude/hooks/stop.js → 0.0
//   3. trivial commits (typo / wip / bump) → low (≤0.3)
//   4. session-insight from memesh's hook stays mid-range
//   5. score is in [0, 1] for any input — never NaN/undefined
//   6. deterministic: same input → same score every call

import { describe, it, expect } from 'vitest';
import { computeSignalScore } from '../../src/core/signal-scorer.js';

/**
 * The yardstick these tests use to mean "surfaced" rather than "demoted".
 *
 * It lives here, not in the product. `signal-scorer.ts` exported a
 * `SURFACED = 0.4` whose docstring described a dashboard
 * filter users could override in Settings. Nothing imported it but this
 * file, and no such filter was ever built — so the constant documented a
 * feature into existence. The score itself is real and widely used (the
 * dreamer's compactable range, kg-backfill's Rule 3 floor, the briefing);
 * only the phantom threshold is gone.
 */
const SURFACED = 0.4;

describe('signal-scorer', () => {
  it('lesson_learned with substantive content scores at the top', () => {
    const score = computeSignalScore({
      type: 'lesson_learned',
      name: 'lesson-x',
      observations: [
        'Error: race condition in queue processor',
        'Root cause: idempotency key derived after request body parse',
        'Fix: derive key in middleware before any I/O',
        'Prevention: enforce idempotency-key middleware on all write routes',
      ],
    });
    expect(score).toBeGreaterThanOrEqual(0.95);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it('empty session_keypoint from user-global stop.js scores 0.0', () => {
    // The exact format ~/.claude/hooks/stop.js writes when a session
    // fired the hook but produced no captured tools. This is the
    // dominant noise type in production memesh DBs (per F2 — 55%
    // of all entities).
    const score = computeSignalScore({
      type: 'session_keypoint',
      name: 'session_end_1778222674750',
      observations: ['[SESSION] Duration: 0s, Tools used: 0'],
    });
    expect(score).toBe(0.0);
  });

  it('decision and architecture types stay above the default threshold', () => {
    for (const type of ['decision', 'architecture', 'architecture_decision', 'pattern', 'technical_pattern', 'best_practice']) {
      const score = computeSignalScore({
        type,
        name: `entry-${type}`,
        observations: ['some real content describing this concept'],
      });
      expect(score, `expected ${type} to be ≥ default threshold`).toBeGreaterThanOrEqual(SURFACED);
    }
  });

  it('trivial commits score in noise range (≤0.3)', () => {
    expect(computeSignalScore({
      type: 'commit',
      name: 'Commit abc123: fix typo',
      observations: ['fix typo'],
    })).toBeLessThanOrEqual(0.3);

    expect(computeSignalScore({
      type: 'commit',
      name: 'Commit abc124: wip',
      observations: ['wip'],
    })).toBeLessThanOrEqual(0.3);

    expect(computeSignalScore({
      type: 'commit',
      name: 'Commit abc125: bump version',
      observations: ['bump version'],
    })).toBeLessThanOrEqual(0.3);
  });

  it('substantive commits with body score above threshold', () => {
    const score = computeSignalScore({
      type: 'commit',
      name: 'Commit abc126: feat(auth): OAuth 2.0 with PKCE',
      observations: [
        'feat(auth): OAuth 2.0 with PKCE for browser flows\n\nReplace the legacy session-cookie flow with OAuth 2.0 + PKCE per the auth-decision lesson. Tokens rotate every 90 days; refresh handled in middleware.',
      ],
    });
    expect(score).toBeGreaterThan(SURFACED);
  });

  it('session-insight from memesh\'s hook with bugfix tag scores higher than plain', () => {
    const plain = computeSignalScore({
      type: 'session-insight',
      name: 'session-abc-files',
      observations: ['Session edited 5 file(s): a.ts, b.ts, c.ts'],
    });
    const bugfix = computeSignalScore({
      type: 'session-insight',
      name: 'session-abc-fixes',
      observations: ['Fixed 3 errors by editing a.ts, b.ts'],
      tags: ['type:bugfix'],
    });
    expect(bugfix).toBeGreaterThan(plain);
  });

  it('every score is in [0, 1] for arbitrary inputs (no NaN, no out-of-range)', () => {
    const inputs = [
      { type: 'lesson_learned', name: '', observations: [] },
      { type: 'unknown_type', name: 'x', observations: ['something'] },
      { type: '', name: '', observations: [''] },
      { type: 'commit', name: 'c', observations: ['x'.repeat(10000)] },
      { type: 'release', name: 'r', observations: ['v1'] },
    ];
    for (const input of inputs) {
      const score = computeSignalScore(input);
      expect(score, `score for ${JSON.stringify(input).slice(0, 60)}`).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(score)).toBe(true);
    }
  });

  it('is deterministic — same input always returns the same score', () => {
    const input = {
      type: 'lesson_learned' as const,
      name: 'x',
      observations: ['Error: foo', 'Root cause: bar', 'Fix: baz'],
    };
    const a = computeSignalScore(input);
    const b = computeSignalScore(input);
    const c = computeSignalScore(input);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('release type always scores at the top', () => {
    expect(computeSignalScore({
      type: 'release',
      name: 'release-v4.1.4',
      observations: ['Released v4.1.4 with hook-wiring fixes'],
    })).toBeGreaterThanOrEqual(0.95);
  });

  it('near-empty observations always demote to ≤ 0.1, even for lesson_learned', () => {
    // Defensive: a "lesson" with 5 chars of content is not a lesson,
    // it's a buggy capture path. Don't surface it.
    expect(computeSignalScore({
      type: 'lesson_learned',
      name: 'lesson-bad',
      observations: ['oops'],
    })).toBeLessThanOrEqual(0.1);
  });
});

describe('a commit is scored from its message, not from the hook\'s annotations', () => {
  // `post-commit.js` stores THREE observations: the commit message, then
  // `Branch: x`, then `Diff stats: y`. Every test above passes the message
  // alone, which is a shape the product never writes — and it is what let
  // the defect live. `computeSignalScore` joined the three with a SPACE and
  // then reasoned about the result as if it were a raw commit message.
  const branch = 'Branch: main';
  const stats = 'Diff stats: 3 files changed, 45 insertions(+), 12 deletions(-)';

  it('demotes a bodyless conventional commit, annotations and all', () => {
    // Before the fix this scored 0.6. The joined text has no newline, so
    // `firstLine` became the whole 80-character string — too long for every
    // demotion branch — and it fell through to "substantive commit body".
    const score = computeSignalScore({
      type: 'commit',
      name: 'Commit abc: chore: bump version',
      observations: ['chore: bump version', branch, stats],
    });
    expect(score, 'a bodyless commit was scored as substantive').toBeLessThan(SURFACED);
  });

  it('surfaces a commit that actually has a body, annotations and all', () => {
    // Before the fix this scored 0.3: `firstLine` was the short subject, so
    // the length rules demoted the one commit that had earned promotion.
    const score = computeSignalScore({
      type: 'commit',
      name: 'Commit def: fix: the parser',
      observations: [
        'fix: the parser\n\nThe tokenizer dropped the final newline, so a file with no trailing\nblank line lost its last statement. Adds a regression test.',
        branch,
        stats,
      ],
    });
    expect(score, 'a commit with a real body was scored as noise').toBeGreaterThanOrEqual(SURFACED);
  });

  it('ranks the two in that order — the comparison the score exists for', () => {
    // Both assertions above could pass against a constant near the boundary.
    const mechanical = computeSignalScore({
      type: 'commit',
      name: 'a',
      observations: ['chore: bump version', branch, stats],
    });
    const substantive = computeSignalScore({
      type: 'commit',
      name: 'b',
      observations: ['fix: the parser\n\nA real explanation of what changed and why.', branch, stats],
    });
    expect(substantive).toBeGreaterThan(mechanical);
  });
});
