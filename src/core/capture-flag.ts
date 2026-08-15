// =============================================================================
// capture-flag — the auto-capture on/off decision, in one place
// =============================================================================
//
// A LEAF on purpose: no imports, so scripts/generate-hook-core.mjs can copy
// it into scripts/hooks/_generated/ and the hook side (`isAutoCaptureEnabled`
// in _shared.js) and the core side (doctor's `autoCaptureOffSource`) execute
// the SAME precedence rules instead of two hand-mirrored copies. The old
// comment claimed "the TS/hook-JS bundle boundary forbids sharing code" —
// the _generated/ mechanism is exactly the disproof.
//
// The two sides read their config differently (hooks parse config.json
// leniently via readHookConfig; core uses readConfig) — that part stays with
// the caller. What must never fork is the DECISION: which values count, and
// that env beats config.

/**
 * Resolve the auto-capture flag from its two inputs.
 *
 * Precedence: env > config > default(on). Only the explicit strings 'true' /
 * 'false' count for the env var, and only literal `false` counts for config —
 * a stray value must not disable capture.
 *
 * `offSource` names WHO turned it off ('env' is per-process, 'config' is
 * machine-wide) — doctor needs the distinction because observing the env var
 * in ITS shell says nothing certain about the agent's hooks.
 */
export function autoCaptureDecision(
  envVal: string | undefined,
  configAutoCapture: unknown,
): { enabled: boolean; offSource: 'env' | 'config' | null } {
  if (envVal === 'false') return { enabled: false, offSource: 'env' };
  if (envVal === 'true') return { enabled: true, offSource: null };
  if (configAutoCapture === false) return { enabled: false, offSource: 'config' };
  return { enabled: true, offSource: null };
}
