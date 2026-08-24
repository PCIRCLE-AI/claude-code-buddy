/**
 * The docs gate's "no README states a test count" rule, pinned.
 *
 * Why this file exists: the rule's CJK branch was added to catch a live case
 * (README.zh-TW.md's "630 項測試") in the same change that deleted that line.
 * With nothing left to match and no test naming it, deleting the branch
 * outright left `check-doc-claims.mjs` at exit 0 and the whole suite green —
 * verified by mutation, which is how the gap was found rather than guessed.
 *
 * The rule matters because it is the one that stops eleven READMEs from
 * drifting to "630 tests" while the suite is past 1400. A guard nothing
 * watches is the defect, not the drift it failed to catch.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { statesTestCount } from '../scripts/lib/test-count-claim.mjs';

describe('the READMEs-state-no-test-count rule', () => {
  it.each([
    ['English', 'The suite has 630 tests and they all pass.'],
    ['English, comma-grouped', 'All 1,472 tests pass.'],
    ['English, "test cases"', 'Covered by 630 test cases.'],
    ['German (Tests is an English loanword)', 'Die Suite umfasst 630 Tests.'],
    ['Traditional Chinese', '```bash\nnpm test  # 630 項測試\n```'],
    ['Traditional Chinese, spaced', '共 1,472 項測試'],
  ])('catches a hardcoded count in %s', (_label, text) => {
    expect(statesTestCount(text), `this phrasing would drift unnoticed: ${text}`).toBe(true);
  });

  it.each([
    ['a bare npm test', '```bash\nnpm test\n```'],
    ['prose with no number', 'Run the tests before you push.'],
    ['a version number', 'MeMesh 4.7.1 ships today.'],
    ['an unrelated count', 'The dashboard has 5 tabs and 11 languages.'],
  ])('does not fire on %s', (_label, text) => {
    expect(statesTestCount(text), `false positive on: ${text}`).toBe(false);
  });

  it('is the predicate check-doc-claims actually runs, not a second copy', () => {
    // The rule drifted once already by being written down twice. Assert the
    // gate imports this module rather than carrying its own regex — otherwise
    // every case above could pass while the shipped gate used something else.
    const gate = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'check-doc-claims.mjs'),
      'utf8',
    );
    expect(gate).toContain("import { statesTestCount } from './lib/test-count-claim.mjs'");
    expect(gate, 'the gate kept a private regex copy').not.toMatch(/項測試\s*\/[a-z]*;/);
  });

  it('the repository itself currently states no test count', () => {
    // The live assertion, not just the predicate's unit behaviour.
    const repoRoot = path.join(__dirname, '..');
    const readmes = fs.readdirSync(repoRoot).filter(f => /^README(\.[a-zA-Z-]+)?\.md$/.test(f));
    expect(readmes.length, 'no READMEs found — this test stopped looking at anything').toBeGreaterThan(0);

    const offenders = readmes.filter(f =>
      statesTestCount(fs.readFileSync(path.join(repoRoot, f), 'utf8')),
    );
    expect(offenders, `README(s) state a hardcoded test count: ${offenders.join(', ')}`).toEqual([]);
  });
});
