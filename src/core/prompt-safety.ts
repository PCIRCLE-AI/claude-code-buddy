// =============================================================================
// LLM prompt-safety helpers (F7 — OWASP LLM01 defense-in-depth)
// =============================================================================
//
// memesh feeds user-controlled content to LLM providers in three places:
//   - failure-analyzer  — error strings + edited filenames from a session
//                          transcript (transcript may contain malicious
//                          dependency output)
//   - auto-tagger       — entity name/type/observations
//   - consolidator      — entity observations
//
// (query-expander was a fourth call site until it was retired from the
// recall hot path — see src/core/operations.ts:recallEnhanced. This
// helper is kept for the remaining three.)
//
// Even though every output path validates / whitelists / truncates the
// LLM's response, defense-in-depth says we should also harden the input
// side: wrap untrusted text in clear delimiters, neutralise any
// delimiters the user themselves typed so they cannot break out, and
// prefix the prompt with an explicit "treat as data, not instructions"
// directive. This is the OWASP LLM01 recommended pattern.
//
// We do NOT try to detect/strip injection attempts — that arms race is
// unwinnable. We just prevent the easiest cases (closing the delimiter
// and re-opening with new instructions) and rely on output validation
// for everything else.

/**
 * Escape sequences that would let an attacker close our delimiter and
 * inject new instructions, regardless of which tag name we wrap with.
 *
 * The three remaining call sites use different tag names:
 *   - failure-analyzer  → `<session_errors>` / `<files_edited>`
 *   - auto-tagger       → `<entity_name>` / `<entity_type>` / `<entity_facts>`
 *   - consolidator      → `<observations>`
 *
 * The first version of this sanitiser only stripped `</user_*>` closing
 * tags, which left other prompts exposed to closing-tag injection.
 * This version strips ANY tag-shaped substring `<...>` whose name is a
 * lowercase identifier, plus the conventional `<system>` / `<assistant>`
 * roles that some providers interpret specially. Newlines and tabs are
 * preserved (they carry meaning in observations); other ASCII control
 * bytes are dropped.
 *
 * After this pass, the text is safe to interpolate inside any
 * tag-delimited prompt section. The function is idempotent and
 * preserves the original semantics for any reasonable user input.
 */
export function sanitizeForPrompt(value: string): string {
  if (typeof value !== 'string') return '';
  return value
    // Strip ANY closing tag whose name is a lowercase identifier.
    // Catches </user_query>, </session_errors>, </observations>, etc.
    .replace(/<\s*\/\s*[a-z][a-z0-9_]*\s*>/gi, '[CLOSING-TAG-STRIPPED]')
    // Strip role-shaped tags (<system>/<assistant>/<user>) regardless of
    // open/close direction — some providers treat these specially even
    // mid-prompt.
    .replace(/<\s*\/?\s*(system|assistant|user)\s*>/gi, '[ROLE-TAG-STRIPPED]')
    // Strip any opening tag whose name looks like one of our wrappers,
    // so a user can't inject `<observations>` inside the body and have
    // the model think the data block restarted with attacker content.
    .replace(/<\s*[a-z][a-z0-9_]*\s*>/gi, '[OPEN-TAG-STRIPPED]')
    // Clamp ASCII control chars except \n / \t — they have no useful
    // meaning in user content and just open obscure parser surface.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Sanitise an array of user-controlled strings and join them under a
 * shared wrapper. Used by failure-analyzer (errors[] + filesEdited[])
 * and consolidator (observations[]) where the LLM is meant to read
 * each line as a fact, not a directive.
 */
export function sanitizeListForPrompt(items: readonly string[]): string {
  return items.map(sanitizeForPrompt).join('\n');
}
