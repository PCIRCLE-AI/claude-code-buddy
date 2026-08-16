/**
 * Two source-level rules the dashboard fixes in this release depend on, and
 * which no test was enforcing.
 *
 * 1. **Every `var(--x)` must name a token that exists.** CSS custom properties
 *    fail silently: `var(--font-mono, monospace)` on an undefined token renders
 *    in the browser's generic monospace and looks deliberate. The palette
 *    defines `--mono`; five places referenced `--font-mono`, which is not a
 *    token, so the auth token input rendered in the wrong font and nothing
 *    reported it. Both a mutation sweep and the whole test suite missed it —
 *    a token typo is invisible to every test that does not read the CSS.
 *
 * 2. **No `t(...) || 'literal'` fallback branches.** `t()` returns the key
 *    string on a miss, and a non-empty string is truthy, so the right-hand side
 *    is unreachable. It reads as a safety net and cannot be one: a missing
 *    translation shows the raw key either way, and the dead literal hides that
 *    from review. `tests/dashboard-i18n.test.ts` skips template-literal keys by
 *    design, so these three sites were unreachable by it.
 *
 * Both are structural — they check the source, because the failure is invisible
 * at runtime by definition.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'dashboard', 'src');

/**
 * The OTHER dashboard.
 *
 * `src/cli/view-live.ts` is a complete standalone renderer — the pre-build
 * fallback the HTTP server serves when `dashboard/dist/index.html` is absent,
 * i.e. what every source-checkout user sees. It carries its own palette and
 * ~200 `var(--…)` sites. Scoping this gate to `dashboard/src` alone left the
 * identical `--font-mono`-style typo invisible in the file the gate exists to
 * protect against. Its palette is self-contained, so it is checked as its own
 * scope rather than against the dashboard's tokens.
 */
const viewLive = path.join(repoRoot, 'src', 'cli', 'view-live.ts');

function walk(dir: string, exts: string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, exts);
    return exts.includes(path.extname(entry.name)) ? [full] : [];
  });
}

describe('Feature: the dashboard design system is actually followed', () => {
  it.each([
    ['dashboard/src', () => walk(srcDir, ['.css', '.tsx', '.ts'])],
    ['src/cli/view-live.ts', () => [viewLive]],
  ])('every var(--token) in %s names a token that scope defines', (_scope, collect) => {
    const files = collect();

    // Definitions are collected from every file in the scope, not only `.css`:
    // `view-live.ts` embeds its palette in a template literal, so a CSS-only
    // scan would report all 24 of its tokens as undefined.
    const defined = new Set<string>();
    for (const file of files) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*(--[\w-]+)\s*:/gm)) {
        defined.add(m[1]);
      }
    }
    expect(defined.size).toBeGreaterThan(10); // the palette was found at all

    const unknown = new Map<string, string[]>();
    for (const file of files) {
      const rel = path.relative(repoRoot, file);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/var\(\s*(--[\w-]+)/g)) {
        // A token may legitimately be set inline on an element rather than in a
        // stylesheet — accept it if anything in the tree assigns it.
        if (defined.has(m[1])) continue;
        if (!unknown.has(m[1])) unknown.set(m[1], []);
        unknown.get(m[1])!.push(rel);
      }
    }

    expect(
      [...unknown].map(([token, where]) => `${token} used in ${where.join(', ')}`)
    ).toEqual([]);
  });

  it('has no dead `t(...) || literal` fallback branches', () => {
    const offenders: string[] = [];
    for (const file of walk(srcDir, ['.tsx', '.ts'])) {
      const text = fs.readFileSync(file, 'utf8');
      // `t(anything) || <something>` — the right side can never be reached.
      for (const m of text.matchAll(/\bt\([^)]*\)\s*\|\|/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(repoRoot, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 3. **No colour literal that resolves to a token's colour, in any syntax,
   *    and none of the off-palette hues the redesign removed — including inside
   *    canvas draw calls, where a token hue must be resolved, never hardcoded.**
   *
   *    Comparison is NUMERIC, not string: every literal and every token value is
   *    parsed to canonical {r,g,b,a} channels, so `#00D6B4`, `rgb(0,214,180)`
   *    and `rgba(0,214,180,1)` are all recognised as `--accent`, and
   *    `rgba(0,214,180,0.08)` as `--accent-soft`. A string compare (the earlier
   *    version) missed every one of those — same colour, different spelling.
   *
   *    Three rules:
   *      a. literal RGBA == a token's RGBA  → the token, written as a literal.
   *      b. literal RGB   == an off-palette hue (any alpha) → a removed colour.
   *      c. literal RGB   == a token's RGB (any alpha) AND the literal sits in a
   *         `ctx.fillStyle`/`ctx.strokeStyle` assignment → canvas hardcoded a
   *         palette hue instead of resolving it (DESIGN.md "Canvas cannot read a
   *         token"). This is what catches accent/bg drawn at a custom alpha,
   *         which rule (a) can't (the alpha differs from the token's own).
   *
   *    Exemptions: `lib/type-palette.ts` (categorical hues map to no token) and
   *    `lib/tokens.ts` (the resolver). `global.css` is not scanned — it defines
   *    the palette and its sanctioned hover glows; the var()-resolves test above
   *    guards its token usage. Sanctioned DOM accent-glows (accent rgb at a
   *    non-token alpha, not in a ctx call) are left alone by all three rules.
   */
  it('has no literal that resolves to a token colour or off-palette hue (numeric, incl. canvas)', () => {
    type RGBA = { r: number; g: number; b: number; a: number };
    const parseColor = (raw: string): RGBA | null => {
      const s = raw.trim().toLowerCase();
      const hex = /^#([0-9a-f]{3,8})$/.exec(s);
      if (hex) {
        let h = hex[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('') + 'ff';
        else if (h.length === 4) h = h.split('').map((c) => c + c).join('');
        else if (h.length === 6) h += 'ff';
        else if (h.length !== 8) return null;
        return {
          r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255,
        };
      }
      const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
      if (rgb) {
        return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
      }
      return null;
    };
    const a3 = (n: number) => Math.round(n * 1000) / 1000;
    const rgbaKey = (c: RGBA) => `${c.r},${c.g},${c.b},${a3(c.a)}`;
    const rgbKey = (c: RGBA) => `${c.r},${c.g},${c.b}`;

    const css = fs.readFileSync(path.join(srcDir, 'styles', 'global.css'), 'utf8');
    const tokenRgba = new Set<string>();
    const tokenRgb = new Set<string>();
    for (const m of css.matchAll(/^\s*--[\w-]+:\s*(.+?);/gm)) {
      const c = parseColor(m[1].trim());
      if (c) { tokenRgba.add(rgbaKey(c)); tokenRgb.add(rgbKey(c)); }
    }
    expect(tokenRgb.size).toBeGreaterThan(5);

    // Off-palette hues the redesigns removed — one base colour each (alpha-
    // agnostic). The 2026-08 VIVARIUM swap retired the whole Precision
    // Engineer brand (cyan accent + old semantic hues) and the hand-picked
    // categorical palette (replaced by the oklch species formula) — writing
    // any of them again is a regression to a dead system, not a new colour.
    // NOT here: #F87171 — it is the drift ramp's stale endpoint, still live
    // in GraphTab's legend gradient (the gradient IS the data).
    const offPaletteRgb = new Set(
      ['#ef4444', '#f59e0b', '#22c55e', '#ff5050', '#ffc800',
       'rgb(255,200,87)', 'rgb(160,160,160)',
       // Precision Engineer brand + semantics (superseded 2026-08-16)
       '#00d6b4', '#00f0ca', '#ff6b6b', '#ffb84d', '#60a5fa',
       // pre-formula categorical hues
       '#a78bfa', '#4ade80', '#f472b6', '#38bdf8', '#fb923c',
       '#818cf8', '#e879f9', '#94a3b8'].map((h) => rgbKey(parseColor(h)!)),
    );

    const exempt = new Set(['lib/type-palette.ts', 'lib/tokens.ts']);
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const offenders: string[] = [];
    for (const file of walk(srcDir, ['.tsx', '.ts'])) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      if (exempt.has(rel)) continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      const lines = text.split('\n');
      for (const m of text.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)/g)) {
        const c = parseColor(m[0]);
        if (!c) continue; // e.g. rgb(${r},${g},${b}) — computed, not a literal
        const lineNo = text.slice(0, m.index).split('\n').length;
        const lineText = lines[lineNo - 1] ?? '';
        const inCanvasDraw = /\bctx\.(fillStyle|strokeStyle)\s*=/.test(lineText);
        let why = '';
        if (tokenRgba.has(rgbaKey(c))) why = 'token colour as a literal';
        else if (offPaletteRgb.has(rgbKey(c))) why = 'off-palette hue';
        else if (inCanvasDraw && tokenRgb.has(rgbKey(c))) why = 'canvas hardcodes a token hue';
        if (why) offenders.push(`${path.relative(repoRoot, file)}:${lineNo} ${m[0]} (${why})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
