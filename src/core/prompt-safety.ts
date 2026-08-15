// =============================================================================
// LLM prompt-safety helpers (F7 — OWASP LLM01 defense-in-depth)
// =============================================================================
//
// Who must use this module is no longer a hand-maintained list here (that
// list was wrong twice — it named a retired module and omitted a live one).
// It is enforced by machine: tests/core/prompt-safety-boundary.test.ts scans
// every file that imports `callLLM` and fails any that does not import this
// module. `wrapUntrusted()` below is the standard way in — it builds the
// data-block fence AND sanitises in one call, so a new LLM flow cannot
// interpolate raw text with nothing but code review standing in the way.
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
 * The three call sites use different tag names:
 *   - failure-analyzer  → `<session_errors>` / `<files_edited>`
 *   - auto-tagger       → `<entity_name>` / `<entity_type>` / `<entity_facts>`
 *   - digest-validator  → `<digest>` / `<sources>`
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
 * and digest-validator (observations[]) where the LLM is meant to read
 * each line as a fact, not a directive.
 */
export function sanitizeListForPrompt(items: readonly string[]): string {
  return items.map(sanitizeForPrompt).join('\n');
}

/**
 * THE way to place untrusted text inside a tag-delimited data block.
 *
 * Sanitises by construction — the call site cannot forget the sanitise
 * step, because building the block IS the step. This is the same design
 * the hook side already runs (`buildReferenceContext` owns its fence):
 * asking each caller to sanitise first is how the boundary breaks,
 * because the next caller added will not know that it must. The
 * conflict pipeline was the seventh LLM flow added to this codebase;
 * this function exists so the eighth cannot interpolate raw entity text
 * with nothing but a code review standing in the way.
 *
 * The tag name is caller-controlled CODE, not data — but it is validated
 * anyway, because a tag with `>` or spaces in it would corrupt the fence
 * that everything else relies on.
 *
 * Accepts a single string or a list (list items join as lines, matching
 * sanitizeListForPrompt).
 */
export function wrapUntrusted(tag: string, text: string | readonly string[]): string {
  if (!/^[a-z][a-z0-9_]*$/.test(tag)) {
    throw new Error(`wrapUntrusted: invalid tag name ${JSON.stringify(tag)} — lowercase identifiers only`);
  }
  const body = Array.isArray(text) ? sanitizeListForPrompt(text) : sanitizeForPrompt(text as string);
  return `<${tag}>\n${body}\n</${tag}>`;
}
