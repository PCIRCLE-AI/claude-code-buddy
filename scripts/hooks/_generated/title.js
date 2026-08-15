// ============================================================================
// AUTO-GENERATED from src/core/title.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export const TITLE_MAX_LENGTH = 200;
export function truncateTitle(text) {
    if (!text)
        return text;
    const trimmed = text.trim();
    return trimmed.length > TITLE_MAX_LENGTH
        ? trimmed.slice(0, TITLE_MAX_LENGTH - 1).trimEnd() + '…'
        : trimmed;
}
export const BOILERPLATE_OBSERVATION_PATTERN = /^(Steps|Commits|Branch|Diff stats|Compaction reason|Tool calls|Plan ".+" completed)[:\s]/;
export function isBoilerplateObservation(text) {
    return BOILERPLATE_OBSERVATION_PATTERN.test(text.trim());
}
