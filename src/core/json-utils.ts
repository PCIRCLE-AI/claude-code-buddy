// =============================================================================
// json-utils — robust JSON-block extraction from chatty LLM responses
// =============================================================================

/**
 * Extract the first COMPLETE JSON object or array from an LLM response that may
 * wrap it in prose, markdown fences, or trailing commentary.
 *
 * Why not a regex: the five callers this replaces (auto-tagger, consolidator,
 * digest-validator, dreamer ×2) had drifted between a greedy `/\{[\s\S]*\}/`
 * and a lazy `/\{[\s\S]*?\}/`, and BOTH are fragile:
 *   - greedy runs from the first opener to the LAST closer, so a `]`/`}` that
 *     appears later in prose ("… see [docs]") swallows the prose and breaks
 *     JSON.parse;
 *   - lazy stops at the FIRST closer, so a nested block (`[[1,2],[3,4]]`) is cut
 *     to `[[1,2]` and fails to parse.
 *
 * This scans from the first opener and tracks nesting depth, skipping brackets
 * that appear inside string literals, and returns the substring of the first
 * balanced block. Robust to nesting AND trailing prose. Returns null when no
 * balanced block exists.
 */
export function extractJsonBlock(text: string, kind: 'object' | 'array'): string | null {
  return jsonBlocks(text, kind, 1)[0] ?? null;
}

/**
 * Every top-level balanced block in the text, in order. The generalized form
 * of {@link extractJsonBlock}: one string-aware, escape-aware bracket scanner
 * for the whole codebase (conflict-judge used to carry a verbatim second copy
 * of the scanner core, so a string/escape-handling fix in one would not have
 * reached the other). `max` caps the scan for callers that only need the
 * first block.
 */
export function jsonBlocks(
  text: string,
  kind: 'object' | 'array',
  max: number = Infinity,
): string[] {
  const out: string[] = [];
  if (!text) return out;
  const open = kind === 'object' ? '{' : '[';
  const close = kind === 'object' ? '}' : ']';

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    // A quote only opens a string INSIDE a block — prose outside can contain
    // unbalanced quotes ("it's) that would otherwise swallow the real block.
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(text.slice(start, i + 1));
        start = -1;
        if (out.length >= max) return out;
      }
    }
  }

  return out;
}
