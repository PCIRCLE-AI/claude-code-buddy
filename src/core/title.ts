// =============================================================================
// title — the human-readable-title contract, in one place
// =============================================================================
//
// A LEAF on purpose: no imports, so scripts/generate-hook-core.mjs can copy it
// into scripts/hooks/_generated/ and every writer of a title — core remember
// (schemas.ts), the backfill (db.ts), and the capture hooks (_shared.js) —
// executes the SAME cap and truncation rule. These used to be three
// hand-mirrored copies ("mirrors TITLE_MAX_LENGTH in scripts/hooks/_shared.js"
// said the third one), so a cap change was a three-place edit that review had
// to catch.

/** Title cap, shared by every writer. A title should read as a short
 *  scannable label — distinctly shorter than MemoryRow's 160-char fallback
 *  preview, not a second paragraph. schemas.ts REJECTS above this length
 *  (API callers get an error they can react to); generators TRUNCATE to it
 *  (a heuristic writer has nobody to bounce the input back to). */
export const TITLE_MAX_LENGTH = 200;

/** Trim, then hard-cap with a single-character ellipsis. The generator-side
 *  half of the contract (the validator side is `titleField` in schemas.ts,
 *  which rejects instead). */
export function truncateTitle(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  return trimmed.length > TITLE_MAX_LENGTH
    ? trimmed.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + '…'
    : trimmed;
}

/**
 * Does an observation carry no display value (mechanical capture metadata)?
 *
 * The UNION of the two lists that used to live apart and drift: the backfill
 * knew `Branch/Diff stats/Compaction reason/Tool calls`, the dashboard's
 * preview picker knew `Plan "…" completed` — neither knew the other's, so
 * the backfill could pick a "title" the dashboard would have skipped as
 * noise. One list, both sides.
 */
export const BOILERPLATE_OBSERVATION_PATTERN =
  /^(Steps|Commits|Branch|Diff stats|Compaction reason|Tool calls|Plan ".+" completed)[:\s]/;

export function isBoilerplateObservation(text: string): boolean {
  return BOILERPLATE_OBSERVATION_PATTERN.test(text.trim());
}
