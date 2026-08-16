/**
 * Canvas cannot read a CSS custom property: `ctx.fillStyle = 'var(--life)'`
 * is invalid and silently paints black. A canvas renderer must resolve the
 * tokens it needs to concrete values, once, from the live stylesheet — so a
 * palette change still reaches the canvas. See DESIGN.md "Canvas cannot read a
 * token".
 *
 * `getComputedStyle` returns `''` for an undefined property — no stylesheet
 * loaded, e.g. a unit test. That empty value is returned as-is, never swapped
 * for a literal fallback: an empty token is a visible signal the palette did
 * not load, and a hardcoded fallback would be exactly the drift this file
 * exists to prevent.
 */
export type ResolvedTokens = Record<string, string>;

export function resolveTokens(el: Element, names: readonly string[]): ResolvedTokens {
  const cs = getComputedStyle(el);
  const out: ResolvedTokens = {};
  for (const name of names) out[name] = cs.getPropertyValue(name).trim();
  return out;
}

/**
 * Build an `rgba()` string from a resolved token colour at a given alpha — for
 * the canvas glows/fills whose alpha is not the token's own (e.g. accent at
 * 40%). The token supplies the hue; hardcoding `rgba(143,242,92,0.4)` in a draw
 * call would be the exact drift the resolver exists to prevent.
 *
 * `resolved` is a 6-digit hex (what the palette defines). Anything else — an
 * empty string when no stylesheet is loaded (a test), or an unexpected form —
 * is returned unchanged, so an absent token stays a visible signal rather than
 * a papered-over literal.
 */
export function rgbaFrom(resolved: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(resolved.trim());
  if (!m) return resolved;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
