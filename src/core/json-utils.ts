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
  if (!text) return null;
  const open = kind === 'object' ? '{' : '[';
  const close = kind === 'object' ? '}' : ']';
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null; // opener with no balanced closer
}
