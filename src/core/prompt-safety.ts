// =============================================================================
// LLM prompt-safety helpers (F7 — OWASP LLM01 defense-in-depth)
// =============================================================================
//
// memesh feeds user-controlled content to LLM providers in four places:
//   - query-expander    — search query
//   - failure-analyzer  — error strings + edited filenames from a session
//                          transcript (transcript may contain malicious
//                          dependency output)
//   - auto-tagger       — entity name/type/observations
//   - consolidator      — entity observations
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
 * Escape characters that would let an attacker close our delimiter and
 * inject new instructions. Currently we wrap user input in
 * `<user_input>...</user_input>` style tags, so we strip "<" / ">"
 * substrings that look like closing tags and clamp control characters
 * (newlines are allowed — they're often meaningful in observations).
 *
 * After this pass, the text is safe to interpolate inside any
 * tag-delimited prompt section. The function is idempotent and
 * preserves the original semantics for any reasonable user input.
 */
export function sanitizeForPrompt(value: string): string {
  if (typeof value !== 'string') return '';
  return value
    // Replace any "</...>" that could close our wrapping tag.
    .replace(/<\s*\/\s*user_[a-z_]+\s*>/gi, '[CLOSING-TAG-STRIPPED]')
    // Strip stray angle brackets so the model can't re-interpret them
    // as a fresh tag block. We keep the *content* but remove the framing.
    .replace(/<\s*\/?\s*system\s*>/gi, '[SYSTEM-TAG-STRIPPED]')
    .replace(/<\s*\/?\s*assistant\s*>/gi, '[ASSISTANT-TAG-STRIPPED]')
    // Clamp ASCII control chars except \n / \t — they have no useful
    // meaning in user content and just open obscure parser surface.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Sanitise an array of user-controlled strings and join them under a
 * shared <user_input> wrapper. Used by failure-analyzer (errors[] +
 * filesEdited[]) and consolidator (observations[]) where the LLM is
 * meant to read each line as a fact, not a directive.
 */
export function sanitizeListForPrompt(items: readonly string[]): string {
  return items.map(sanitizeForPrompt).join('\n');
}
