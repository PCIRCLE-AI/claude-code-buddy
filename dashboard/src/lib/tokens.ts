/**
 * Canvas cannot read a CSS custom property: `ctx.fillStyle = 'var(--accent)'`
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
