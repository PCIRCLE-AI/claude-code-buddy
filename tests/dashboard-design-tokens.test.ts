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
   * 3. **No colour literal where a token holds that exact value, and none of the
   *    off-palette hues the redesign removed.** A literal equal to a token is
   *    invisible to a palette change — the whole reason tokens exist — and the
   *    off-palette set (`#ef4444`, `rgba(255,200,0,…)`, …) was the drift this
   *    batch cleaned up; without a gate it grows straight back.
   *
   *    The ban SET is derived from `global.css`, not hand-listed, so it cannot
   *    drift from the palette. Two exemptions, each with a reason the code and
   *    DESIGN.md both state:
   *      - `lib/type-palette.ts` — the categorical entity-type hues map to no
   *        token, so a token cannot express them (see DESIGN.md).
   *      - `styles/global.css` itself — it defines the palette, and its hover
   *        glows/shadows are sanctioned hand-rolled accent rgba (DESIGN.md);
   *        the existing var()-resolves test already guards its token usage.
   */
  it('has no colour literal equal to a token value, nor an off-palette hue', () => {
    const css = fs.readFileSync(path.join(srcDir, 'styles', 'global.css'), 'utf8');
    const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const tokenValues = new Set<string>();
    for (const m of css.matchAll(/^\s*--[\w-]+:\s*(.+?);/gm)) tokenValues.add(norm(m[1]));

    // Off-palette hues the redesign replaced with tokens. Prefixes so any alpha
    // of the same hand-rolled hue is caught. NOT here: #4ADE80 / #F87171, which
    // are sanctioned categorical hues (type-palette + the drift legend).
    const offPalettePrefixes = [
      '#ef4444', '#f59e0b', '#22c55e', '#ff5050', '#ffc800',
      'rgba(255,200,0', 'rgba(255,80,80', 'rgba(255,200,87', 'rgba(160,160,160',
    ];

    const exempt = new Set(['lib/type-palette.ts', 'lib/tokens.ts']);
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const offenders: string[] = [];
    for (const file of walk(srcDir, ['.tsx', '.ts'])) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      if (exempt.has(rel)) continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of text.matchAll(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)/g)) {
        const value = norm(m[0]);
        const isTokenEqual = tokenValues.has(value);
        const isOffPalette = offPalettePrefixes.some((p) => value.startsWith(norm(p)));
        if (isTokenEqual || isOffPalette) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${path.relative(repoRoot, file)}:${line} ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
