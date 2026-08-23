/**
 * Pins the guard that stops `wait-for-checks.mjs` calling a partial matrix green.
 *
 * The script's whole reason to exist is that `gh pr checks`' exit code cannot be
 * trusted as a verdict. It then carried the same hole one level down: it asked
 * "is pending zero?" and returned 0 when the answer was yes — sound only if
 * every check has already been registered, which GitHub does in batches.
 * Measured on PR #190 (2026-08-23): a poll returned one row,
 * `Analyze (javascript-typescript)`, with twelve more seconds away. Had that row
 * been green at that instant, thirteen legs would have been reported green on
 * one of them.
 *
 * Both directions are asserted. In particular the FIRST poll of an all-green
 * list must NOT pass, because that is precisely the shape of the bug.
 */
import { describe, it, expect } from 'vitest';
import {
  checkNamesKey,
  evaluatePoll,
  REQUIRED_STABLE_POLLS,
} from '../scripts/lib/check-settling.mjs';

type Tally = { pass: number; pending: number; fail: number };

const green = (n: number): Tally => ({ pass: n, pending: 0, fail: 0 });
const waiting = (pass: number, pending: number): Tally => ({ pass, pending, fail: 0 });

describe('a green tally is only a verdict once the check list holds still', () => {
  it('does NOT pass on the first poll, even with nothing pending', () => {
    // The regression, exactly: three registered, all green, ten not yet created.
    const r = evaluatePoll({
      tally: green(3),
      namesKey: 'a b c',
      prevNamesKey: null,
      stablePolls: 0,
    });
    expect(r.verdict).toBe('wait');
    expect(r.reason).toContain('batches');
  });

  it('passes on the second poll when the same names come back', () => {
    const first = evaluatePoll({
      tally: green(13),
      namesKey: 'a b c',
      prevNamesKey: null,
      stablePolls: 0,
    });
    expect(first.verdict).toBe('wait');

    const second = evaluatePoll({
      tally: green(13),
      namesKey: 'a b c',
      prevNamesKey: 'a b c',
      stablePolls: first.stablePolls,
    });
    expect(second.verdict).toBe('pass');
  });

  it('resets the counter when the list grows, and does not pass on that poll', () => {
    // The batch that was missing shows up. Two green polls have now happened,
    // but they were not about the same set.
    const r = evaluatePoll({
      tally: green(13),
      namesKey: 'a b c d',
      prevNamesKey: 'a b c',
      stablePolls: 1,
    });
    expect(r.verdict).toBe('wait');
    expect(r.stablePolls).toBe(1);
  });

  it('does not pass when the same COUNT arrives under different names', () => {
    // `concurrency.cancel-in-progress` can swap one run's legs for another's at
    // the same cardinality. Keying on the count would call that settled.
    const r = evaluatePoll({
      tally: green(3),
      namesKey: 'x y z',
      prevNamesKey: 'a b c',
      stablePolls: 1,
    });
    expect(r.verdict).toBe('wait');
  });

  it('keeps waiting while anything is pending, however stable the list is', () => {
    const r = evaluatePoll({
      tally: waiting(11, 2),
      namesKey: 'a b c',
      prevNamesKey: 'a b c',
      stablePolls: 5,
    });
    expect(r.verdict).toBe('wait');
    expect(r.reason).toContain('2 pending');
  });

  it('fails immediately, without waiting for the list to settle', () => {
    // A red leg is red whether or not its siblings have registered. Delaying
    // bad news that cannot improve helps nobody.
    const r = evaluatePoll({
      tally: { pass: 1, pending: 4, fail: 1 },
      namesKey: 'a b',
      prevNamesKey: null,
      stablePolls: 0,
    });
    expect(r.verdict).toBe('fail');
  });

  it('needs more than one poll by construction', () => {
    // If this ever became 1 the guard would be inert while still looking present.
    expect(REQUIRED_STABLE_POLLS).toBeGreaterThan(1);
  });
});

describe('the name key identifies the SET, not the order', () => {
  it('is order-independent', () => {
    expect(checkNamesKey([{ name: 'b' }, { name: 'a' }])).toBe(checkNamesKey([{ name: 'a' }, { name: 'b' }]));
  });

  it('separates different sets of the same size', () => {
    expect(checkNamesKey([{ name: 'a' }, { name: 'b' }])).not.toBe(
      checkNamesKey([{ name: 'a' }, { name: 'c' }])
    );
  });

  it('does not collapse unnamed rows into each other silently', () => {
    // Two rows must not key the same as one. `gh` has never omitted `name`,
    // but a key that loses cardinality would let a shrinking list read stable.
    expect(checkNamesKey([{}, {}])).not.toBe(checkNamesKey([{}]));
  });

  it('returns an empty key for a non-array, rather than throwing', () => {
    expect(checkNamesKey(null as unknown as { name?: string }[])).toBe('');
  });
});
