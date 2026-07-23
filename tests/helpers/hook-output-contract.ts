/**
 * Claude Code hook-output contract — single source of truth for tests.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every hook test used to hand-assert the exact object its hook happened to
 * emit (`expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact')`).
 * Those assertions mirror the implementation, so they stay green even when the
 * implementation emits a shape Claude Code refuses. That is how issue #53
 * shipped: `pre-compact.js` emitted `hookSpecificOutput.hookEventName:
 * 'PreCompact'`, the test asserted exactly that, CI was green, and every real
 * compaction showed the user a validation error.
 *
 * A test that asserts "the code does what the code does" cannot catch a spec
 * violation. This module encodes the *external* contract instead, so any hook
 * emitting an invalid shape fails CI regardless of what its author assumed.
 *
 * PROVENANCE — read before editing
 * --------------------------------
 * These tables were extracted from the shipped Claude Code CLI bundle
 * (`@anthropic-ai/claude-code` v2.1.19, `cli.js`), by reading the Zod schema
 * it actually validates hook stdout against. They are NOT copied from the
 * public docs: docs.claude.com lists every hook *event name* that exists,
 * which is a much longer list and is not the same thing as the set of events
 * with a `hookSpecificOutput` variant. Trusting the docs here produces exactly
 * the bug in #53.
 *
 * To re-derive after a Claude Code upgrade:
 *   grep -o 'hookEventName:U\.literal("[A-Za-z]*")' "$(npm root -g)/@anthropic-ai/claude-code/cli.js" | sort -u
 *
 * The contract is versioned by Claude Code, not by MeMesh — if a future
 * release adds a `PreCompact` variant, update `HOOK_SPECIFIC_OUTPUT_EVENTS`
 * and the provenance note above together.
 */

/** Claude Code version whose bundle these tables were extracted from. */
export const CONTRACT_SOURCE_VERSION = '2.1.19';

/**
 * Valid top-level keys of a hook's JSON stdout.
 *
 * Verbatim from the base object in the bundle:
 *   continue, suppressOutput, stopReason, decision, reason, systemMessage,
 *   hookSpecificOutput
 *
 * Note there is no top-level `additionalContext` — it only exists *inside*
 * `hookSpecificOutput`.
 */
export const TOP_LEVEL_FIELDS = [
  'continue',
  'suppressOutput',
  'stopReason',
  'decision',
  'reason',
  'systemMessage',
  'hookSpecificOutput',
] as const;

/** Valid values for the top-level `decision` field. */
export const DECISION_VALUES = ['approve', 'block'] as const;

/**
 * The ONLY events with a `hookSpecificOutput` variant, mapped to the extra
 * fields each variant accepts beyond `hookEventName`.
 *
 * Deliberately absent (and therefore invalid to emit): PreCompact,
 * PostCompact, Stop, SubagentStop, SessionEnd, and every other event.
 * A hook bound to one of those must use top-level fields instead
 * (`systemMessage` to tell the human, `suppressOutput` to stay quiet).
 */
export const HOOK_SPECIFIC_OUTPUT_EVENTS: Record<string, readonly string[]> = {
  PreToolUse: ['permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'],
  PostToolUse: ['additionalContext', 'updatedMCPToolOutput'],
  PostToolUseFailure: ['additionalContext'],
  PermissionRequest: ['decision'],
  UserPromptSubmit: ['additionalContext'],
  SessionStart: ['additionalContext'],
  Setup: ['additionalContext'],
  SubagentStart: ['additionalContext'],
  Notification: ['additionalContext'],
};

export type HookOutputKind = 'empty' | 'json' | 'plain';

export interface HookOutputValidation {
  valid: boolean;
  /** What the hook actually wrote: nothing, a JSON document, or plain text. */
  kind: HookOutputKind;
  /** Parsed JSON when `kind === 'json'`, otherwise undefined. */
  parsed?: Record<string, unknown>;
  /** Human-readable contract violations; empty when `valid` is true. */
  errors: string[];
}

/**
 * Validate one hook's stdout against the contract.
 *
 * Emitting nothing is always valid — that is how a hook opts out. Plain
 * (non-JSON) text is reported as `kind: 'plain'` and left to the caller to
 * judge: Claude Code accepts it for some events, but every MeMesh hook is
 * expected to emit JSON or nothing, so hook tests treat it as a failure.
 */
export function validateHookOutput(stdout: string): HookOutputValidation {
  const trimmed = (stdout ?? '').trim();
  if (trimmed === '') return { valid: true, kind: 'empty', errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { valid: true, kind: 'plain', errors: [] };
  }

  const errors: string[] = [];

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      kind: 'json',
      errors: ['top-level output must be a JSON object'],
    };
  }

  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!(TOP_LEVEL_FIELDS as readonly string[]).includes(key)) {
      errors.push(
        `unknown top-level field "${key}" — valid fields: ${TOP_LEVEL_FIELDS.join(', ')}`,
      );
    }
  }

  if ('decision' in obj && !(DECISION_VALUES as readonly unknown[]).includes(obj.decision)) {
    errors.push(`decision must be one of ${DECISION_VALUES.join(' | ')}, got ${JSON.stringify(obj.decision)}`);
  }
  for (const stringField of ['stopReason', 'reason', 'systemMessage'] as const) {
    if (stringField in obj && typeof obj[stringField] !== 'string') {
      errors.push(`${stringField} must be a string`);
    }
  }
  for (const boolField of ['continue', 'suppressOutput'] as const) {
    if (boolField in obj && typeof obj[boolField] !== 'boolean') {
      errors.push(`${boolField} must be a boolean`);
    }
  }

  if ('hookSpecificOutput' in obj) {
    const hso = obj.hookSpecificOutput;
    if (hso === null || typeof hso !== 'object' || Array.isArray(hso)) {
      errors.push('hookSpecificOutput must be an object');
    } else {
      const inner = hso as Record<string, unknown>;
      const event = inner.hookEventName;
      if (typeof event !== 'string') {
        errors.push('hookSpecificOutput.hookEventName must be a string');
      } else if (!(event in HOOK_SPECIFIC_OUTPUT_EVENTS)) {
        errors.push(
          `hookSpecificOutput has no variant for event "${event}" — ` +
            `Claude Code ${CONTRACT_SOURCE_VERSION} defines variants only for: ` +
            `${Object.keys(HOOK_SPECIFIC_OUTPUT_EVENTS).sort().join(', ')}. ` +
            'Use a top-level field (systemMessage / suppressOutput) instead.',
        );
      } else {
        const allowed = HOOK_SPECIFIC_OUTPUT_EVENTS[event];
        for (const key of Object.keys(inner)) {
          if (key === 'hookEventName') continue;
          if (!allowed.includes(key)) {
            errors.push(
              `hookSpecificOutput.${key} is not valid for event "${event}" — ` +
                `allowed: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
            );
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, kind: 'json', parsed: obj, errors };
}

/**
 * Assertion sugar for hook tests. Throws with the full contract violation
 * list (and the offending payload) so a failure explains itself.
 */
export function expectValidHookOutput(stdout: string, label = 'hook output'): HookOutputValidation {
  const result = validateHookOutput(stdout);
  if (result.kind === 'plain') {
    throw new Error(`${label}: expected JSON or empty stdout, got plain text: ${stdout.slice(0, 200)}`);
  }
  if (!result.valid) {
    throw new Error(
      `${label} violates the Claude Code hook-output contract:\n` +
        result.errors.map((e) => `  - ${e}`).join('\n') +
        `\nPayload: ${stdout.trim().slice(0, 400)}`,
    );
  }
  return result;
}
