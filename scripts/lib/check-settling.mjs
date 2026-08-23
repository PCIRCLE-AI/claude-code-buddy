// Is a green tally actually a verdict, or just an early poll?
//
// `wait-for-checks.mjs` asked one question — "is pending zero?" — and returned
// success when the answer was yes. That is sound only if every check has
// already been registered, and GitHub registers check runs in batches. Measured
// on PR #190 (2026-08-23): one poll returned a single row,
// `Analyze (javascript-typescript)`, while the other twelve did not exist yet.
// Had that row been `pass` at that moment, the script would have reported
// `pass=1 pending=0 fail=0 exit=0` — thirteen legs, one of them run, reported
// green.
//
// That is the same shape as every gate this repository has had to fix: absence
// of a failure signal read as success. This script exists BECAUSE `gh pr checks`
// exit codes could not be trusted; it should not carry the same hole one level
// down.
//
// The rule: a PASS is only a verdict once the SET OF CHECK NAMES has been
// identical across two consecutive successful polls. A FAIL is a verdict
// immediately — a red leg is red whether or not its siblings have registered,
// and making someone wait for it helps nobody.
//
// Keyed on the name set rather than the count: `concurrency.cancel-in-progress`
// can swap one run's legs for another's at the same cardinality, and "13 rows,
// then a different 13 rows" is not settled.

/** Consecutive polls that must agree on the check-name set before PASS is real. */
export const REQUIRED_STABLE_POLLS = 2;

/**
 * A stable, order-independent key for the set of check names in one poll.
 *
 * @param {Array<{name?: string}>} checks
 * @returns {string}
 */
export function checkNamesKey(checks) {
  if (!Array.isArray(checks)) return '';
  return checks
    .map((c) => (c && typeof c.name === 'string' ? c.name : '(unnamed)'))
    .sort()
    .join(' ');
}

/**
 * Decide what one poll means, given what the previous poll saw.
 *
 * @param {object} input
 * @param {{pass: number, pending: number, fail: number}} input.tally
 * @param {string} input.namesKey            Key for this poll.
 * @param {string|null} input.prevNamesKey   Key for the previous successful poll.
 * @param {number} input.stablePolls         Consecutive polls that have agreed so far.
 * @param {number} [input.requiredStablePolls]
 * @returns {{verdict: 'fail'|'pass'|'wait', stablePolls: number, reason: string}}
 */
export function evaluatePoll({
  tally,
  namesKey,
  prevNamesKey,
  stablePolls,
  requiredStablePolls = REQUIRED_STABLE_POLLS,
}) {
  // No rows at all is never a verdict, and it resets the count. Right after a
  // push GitHub can take seconds to register anything; and mid-run, a response
  // that lost every row is the clearest possible evidence that the list is NOT
  // holding still. Folding it in here rather than short-circuiting in the
  // caller is what keeps "13 green, then zero rows, then the same 13 green"
  // from counting as two consecutive agreeing polls.
  const total = tally.pass + tally.pending + tally.fail;
  if (total === 0) {
    return { verdict: 'wait', stablePolls: 0, reason: 'no checks reported yet' };
  }

  // A red leg is a verdict on its own. Waiting for the set to settle before
  // reporting a failure would only delay bad news that cannot get better.
  if (tally.fail > 0) {
    return { verdict: 'fail', stablePolls: 0, reason: `${tally.fail} check(s) failed` };
  }

  const next = namesKey === prevNamesKey ? stablePolls + 1 : 1;

  if (tally.pending > 0) {
    return { verdict: 'wait', stablePolls: next, reason: `${tally.pending} pending` };
  }

  if (next < requiredStablePolls) {
    return {
      verdict: 'wait',
      stablePolls: next,
      reason:
        `nothing pending, but the check list has only been stable for ${next} of ` +
        `${requiredStablePolls} polls. GitHub registers check runs in batches, so ` +
        `"no pending rows yet" is not "every check passed"`,
    };
  }

  return {
    verdict: 'pass',
    stablePolls: next,
    reason: `${tally.pass} passed, check list stable for ${next} polls`,
  };
}
