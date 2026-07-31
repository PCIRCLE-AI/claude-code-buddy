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

function walk(dir: string, exts: string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, exts);
    return exts.includes(path.extname(entry.name)) ? [full] : [];
  });
}

describe('Feature: the dashboard design system is actually followed', () => {
  it('every var(--token) names a token the stylesheets define', () => {
    const files = walk(srcDir, ['.css', '.tsx', '.ts']);

    const defined = new Set<string>();
    for (const file of files) {
      if (path.extname(file) !== '.css') continue;
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
});
