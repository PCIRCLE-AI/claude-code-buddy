// ============================================================================
// AUTO-GENERATED from src/core/capture-flag.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
export function autoCaptureDecision(envVal, configAutoCapture) {
    if (envVal === 'false')
        return { enabled: false, offSource: 'env' };
    if (envVal === 'true')
        return { enabled: true, offSource: null };
    if (configAutoCapture === false)
        return { enabled: false, offSource: 'config' };
    return { enabled: true, offSource: null };
}
