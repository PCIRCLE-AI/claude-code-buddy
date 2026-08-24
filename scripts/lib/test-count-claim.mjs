/**
 * Does this README state a hardcoded test count?
 *
 * Extracted so it can be exercised. It used to be a regex literal inline in
 * `check-doc-claims.mjs`, and the CJK branch was added there to catch a live
 * case — README.zh-TW.md's "630 項測試" — in the same change that DELETED that
 * line. So the branch had nothing left to match, no test referenced it, and
 * removing it entirely left both the docs gate and the whole suite green. A
 * guard that cannot fail is not a guard; this module plus
 * `tests/doc-claims-test-count.test.ts` is what makes it one.
 *
 * Two branches because the phrasings share no substring:
 *   - `tests` / `test cases`, case-insensitively. German's own word for this
 *     claim ("Tests") is an English loanword, so the `i` flag already covers
 *     README.de.md.
 *   - `項測試` — Chinese measure word + "test". Nothing in the English branch
 *     can see it.
 *
 * The rule this serves: do not write the number down at all. `npm test` prints
 * the current one. Eleven READMEs once said "630 tests" while the suite was
 * past 1400.
 */
export const TEST_COUNT_RE = /\b\d[\d,]*\s*(tests|test cases)\b|\d[\d,]*\s*項測試/i;

/** @param {string} text README contents @returns {boolean} */
export function statesTestCount(text) {
  return TEST_COUNT_RE.test(text);
}
