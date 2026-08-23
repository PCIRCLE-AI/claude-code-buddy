// =============================================================================
// signal-scorer — rule-based signal-to-noise classifier for entities
// =============================================================================
//
// PROBLEM
// ───────
// memesh's auto-capture pipelines (post-commit hook, session-summary
// hook, the user's own ~/.claude/hooks/stop.js) produce thousands of
// low-signal entries: empty session_keypoints, single-line "fix typo"
// commits, weekly recaps with nothing new. These drown the high-signal
// entries (lessons, decisions, architecture) on the dashboard. The
// project's own SDD plan F2 measured the noise ratio at 91% — without
// filtering, value entries vanish.
//
// DESIGN
// ──────
// Each entity gets `metadata.signal_score` ∈ [0, 1]:
//   1.0 = always signal (lesson_learned, release, plan with content)
//   0.9 = high-value type by default (decision, architecture, pattern)
//   0.5 = neutral (note, feature, bug_fix without root-cause)
//   0.3 = low (short / mechanical commits)
//   0.0 = pure noise (Duration: 0s session_keypoint from a hook that
//         fired but had nothing to capture)
//
// Dashboard hides everything < 0.4 by default; threshold is
// configurable in Settings. The score is RULE-BASED — no LLM call,
// runs in microseconds. Phase 2 (cluster compactor) and Phase 3
// (pattern detector) layer LLM-based work ON TOP of this floor.
//
// CONTRACT
// ────────
// - Pure function: same inputs → same score, no side effects.
// - Deterministic: never produces NaN, always in [0, 1].
// - Idempotent: re-scoring an entity gives the same value.
// - Cheap to backfill: scoring 3000 existing entities should be ms,
//   not seconds.

export interface SignalInput {
  type: string;
  name: string;
  observations: string[];
  /** Existing tags (for context — e.g. type:bugfix bumps over a
   *  bare type='session-insight'). */
  tags?: string[];
}

/**
 * Compute a rule-based signal score for an entity. Higher = keep in
 * surface views. Lower = demote / hide by default.
 */
export function computeSignalScore(input: SignalInput): number {
  const { type, observations, tags = [] } = input;
  const obsText = observations.join(' ').trim();
  const obsLen = obsText.length;

  // Base score by type — encodes "what types are inherently
  // high-value vs disposable". These come from the actual entity
  // distribution in production memesh DBs.
  const base = baseScoreForType(type);

  // Empty / near-empty observations always demote, regardless of
  // type — a `lesson_learned` with 5 chars of content is not a
  // lesson, it's noise that crept in via a buggy capture path.
  if (obsLen < 10) return Math.min(base, 0.1);

  // The specific session_keypoint failure mode that motivated
  // this whole feature: user-global stop.js writes
  //   "[SESSION] Duration: 0s, Tools used: 0"
  // for sessions that fired the hook but produced nothing.
  // These are pure noise — auto-hide.
  if (type === 'session_keypoint' && /Duration: 0s, Tools used: 0/.test(obsText)) {
    return 0.0;
  }

  // Mechanical commit messages — short, conventional-only, no body.
  // "fix typo", "wip", "bump version" type entries.
  //
  // Read from the OBSERVATION, not from the joined text. `obsText` is
  // `observations.join(' ')`, and post-commit stores three of them: the
  // commit message, `Branch: x`, and `Diff stats: y`. Joining with a SPACE
  // means the flattened string has no newline unless the message itself had
  // one — so the old code asked the hook's own annotations to answer
  // questions about the author's message, and got the answer backwards:
  //
  //   no body  -> nothing to split on, so `firstLine` was the whole
  //               80-character joined string: too long for every demotion
  //               branch, fell through to "substantive commit body", 0.6
  //   a body   -> `firstLine` was just the subject, "fix: thing", 10 chars
  //               with a colon: 0.3
  //
  // Measured on the live graph: 459 commits at 0.6, exactly 1 below 0.4.
  // The score meant to demote mechanical commits was promoting them.
  if (type === 'commit') {
    const message = (observations[0] ?? '').trim();
    const [subject = '', ...rest] = message.split('\n');
    const head = subject.trim();
    const hasBody = rest.join('\n').trim().length > 0;
    // The length rules describe a message with nothing but a subject line.
    // A commit that wrote a body has already earned the benefit of the
    // doubt, however terse its subject.
    if (!hasBody) {
      if (head.length < 30 && !/[!:]/.test(head)) return 0.2;
      if (head.length < 30) return 0.3;
      if (head.length < 60) return 0.4;
    }
    return Math.min(0.7, base + 0.1);
  }

  // session-insight from memesh's own session-summary hook —
  // already filtered by toolCallCount >= 3, but reweight by tags
  // and content length.
  if (type === 'session-insight') {
    if (tags.includes('type:bugfix')) return 0.7;
    if (tags.includes('type:heavy-session')) return 0.6;
    return 0.5;
  }

  // weekly-summary entries are aggregates — useful at-a-glance,
  // less useful per individual entry.
  if (type === 'weekly-summary' || type === 'weekly_summary') {
    return obsLen > 200 ? 0.5 : 0.3;
  }

  // For high-base types, observations length boost: a lesson with
  // 500 chars of root-cause analysis is more valuable than a
  // one-liner lesson.
  if (base >= 0.8) {
    if (obsLen > 200) return Math.min(1.0, base + 0.05);
    return base;
  }

  return base;
}

/**
 * Per-type default. The list reflects memesh's actual production
 * type distribution (per Dashboard-v3 SDD plan F2 measurement) and
 * the original wedge: lessons + decisions + architecture are the
 * crown jewels; commits + sessions are operational noise.
 */
function baseScoreForType(type: string): number {
  // Golden — always keep
  if (type === 'lesson_learned') return 1.0;
  if (type === 'release') return 1.0;

  // High-value knowledge types
  if (type === 'decision' || type === 'architecture' || type === 'architecture_decision') return 0.9;
  if (type === 'pattern' || type === 'technical_pattern' || type === 'best_practice') return 0.9;
  if (type === 'plan') return 0.85;

  // Mid-value
  if (type === 'feature') return 0.65;
  if (type === 'bug_fix') return 0.7;
  if (type === 'note') return 0.55;

  // Operational / activity
  if (type === 'session-insight') return 0.5;
  if (type === 'session_keypoint') return 0.2;
  if (type === 'commit') return 0.5; // Refined further by content
  if (type === 'workflow_checkpoint') return 0.4;

  // Reference
  if (type === 'reference' || type === 'documentation') return 0.6;

  // Aggregates
  if (type === 'weekly-summary' || type === 'weekly_summary') return 0.4;

  // Unknown — give benefit of doubt
  return 0.5;
}

