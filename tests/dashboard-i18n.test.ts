import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const i18nSource = readFileSync('dashboard/src/lib/i18n.ts', 'utf8');

function parseTranslationKeys(): Map<string, Set<string>> {
  const locales = new Map<string, Set<string>>();
  const localeBlocks = i18nSource.matchAll(/\n  ('[^']+'|\w+): \{([\s\S]*?)\n  \}/g);

  for (const match of localeBlocks) {
    const locale = match[1].replaceAll("'", '');
    const body = match[2];
    const keys = new Set([...body.matchAll(/'([^']+)':/g)].map((keyMatch) => keyMatch[1]));
    locales.set(locale, keys);
  }

  return locales;
}

function parseNamedLocales(): string[] {
  const namesBlock = i18nSource.match(/const LOCALE_NAMES: Record<Locale, string> = \{([\s\S]*?)\n\};/);
  expect(namesBlock).not.toBeNull();

  return [...namesBlock![1].matchAll(/\n  ('[^']+'|\w+):/g)].map((match) => match[1].replaceAll("'", ''));
}

describe('dashboard i18n', () => {
  it('keeps every locale in key parity with English', () => {
    const locales = parseTranslationKeys();
    const englishKeys = locales.get('en');
    expect(englishKeys).toBeDefined();

    for (const [locale, keys] of locales) {
      const missing = [...englishKeys!].filter((key) => !keys.has(key));
      const extra = [...keys].filter((key) => !englishKeys!.has(key));

      expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] });
    }
  });

  it('has labels for every translated locale', () => {
    const translatedLocales = [...parseTranslationKeys().keys()].sort();
    const namedLocales = parseNamedLocales().sort();

    expect(namedLocales).toEqual(translatedLocales);
  });

  it('does not reload the page to apply a language change', () => {
    const settingsSource = readFileSync('dashboard/src/components/SettingsTab.tsx', 'utf8');

    expect(settingsSource).not.toContain('window.location.reload');
  });

  it('does not keep known hardcoded English UI strings in dashboard sources', () => {
    const browseSource = readFileSync('dashboard/src/components/BrowseTab.tsx', 'utf8');
    const memoryRowSource = readFileSync('dashboard/src/components/MemoryRow.tsx', 'utf8');
    const analyticsSource = readFileSync('dashboard/src/components/AnalyticsTab.tsx', 'utf8');
    const graphSource = readFileSync('dashboard/src/components/GraphTab.tsx', 'utf8');
    const settingsSource = readFileSync('dashboard/src/components/SettingsTab.tsx', 'utf8');
    const apiSource = readFileSync('dashboard/src/lib/api.ts', 'utf8');

    expect(browseSource).not.toContain('Failed to archive:');
    expect(browseSource).not.toContain('Failed to restore:');
    expect(memoryRowSource).not.toContain('(no content)');
    expect(memoryRowSource).not.toContain('>archived<');
    expect(memoryRowSource).not.toContain(' facts</span>');
    expect(analyticsSource).not.toContain('Failed to load analytics');
    expect(graphSource).not.toContain(': No data');
    expect(settingsSource).not.toContain('>Level ');
    expect(apiSource).not.toContain('Unknown error');
    expect(apiSource).not.toContain('Request timed out');
  });

  // SDD plan SPEC-7: i18n CI gate.
  //
  // The earlier "known English strings" test only catches a handful of
  // specific phrases that historically leaked. It cannot catch the
  // failure mode v3 actually hit: brand-new components that hardcode
  // zh-TW or other CJK text directly into JSX, breaking the 11-locale
  // contract for users who switch language.
  //
  // This stricter check scans every dashboard component / lib file
  // (excluding i18n.ts itself, where translations legitimately live)
  // for CJK code-points appearing outside of comments. Any hit is a
  // regression — every user-facing string must go through `t()`.
  it('contains no hardcoded CJK strings in dashboard components', () => {
    const { readdirSync } = require('node:fs');
    const { join } = require('node:path');

    // CJK Unified Ideographs + Hiragana + Katakana + Hangul Syllables +
    // Thai. Covers the eleven locales we ship (en/zh-TW/zh-CN/ja/ko/pt/
    // fr/de/vi/es/th); only the ones that use non-Latin scripts trigger
    // here, and Latin-script locales never accidentally hit this gate.
    const cjkPattern = /[一-鿿぀-ゟ゠-ヿ가-힯฀-๿]/;

    function* walk(dir: string): Generator<string> {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, ent.name);
        if (ent.isDirectory()) yield* walk(path);
        else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) yield path;
      }
    }

    /** Strip /* ... *\/ block comments and // line comments before
     *  scanning. Without this the comment stating "本週" would be
     *  flagged just like a hardcoded JSX string. */
    function stripComments(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1');
    }

    const violations: Array<{ file: string; line: number; snippet: string }> = [];
    const exclude = new Set([
      // i18n.ts is the catalogue; translations live there by design.
      'dashboard/src/lib/i18n.ts',
    ]);

    for (const path of walk('dashboard/src')) {
      // Normalize to POSIX separators so the exclude check works on
      // Windows (where `path` uses `\`) without forking the test.
      const rel = path.replace(/\\/g, '/').replace(/^.+memesh-llm-memory\//, '');
      if (exclude.has(rel)) continue;

      const src = readFileSync(path, 'utf8');
      const stripped = stripComments(src);
      if (!cjkPattern.test(stripped)) continue;

      // Report each offending line so the failure message points
      // straight at the regression instead of just "this file has CJK".
      const originalLines = src.split('\n');
      const strippedLines = stripped.split('\n');
      strippedLines.forEach((line, i) => {
        if (cjkPattern.test(line)) {
          violations.push({ file: rel, line: i + 1, snippet: originalLines[i].trim().slice(0, 120) });
        }
      });
    }

    expect(violations).toEqual([]);
  });

  // Blind-spot guard: the parity test above only checks locale-to-locale
  // agreement, so a key that is MISSING FROM ALL locales (never added to the
  // catalogue at all) passes it. That is exactly how AuthPrompt shipped
  // rendering raw `auth.title` / `auth.submit` keys: `t()` returns the key
  // string itself on a miss (truthy), so the `t('x') || 'English'` fallback
  // was dead code and the user saw the dotted key. This scans components for
  // static t('...') keys and asserts each exists in the English catalogue.
  it('has an English translation for every static t() key used in the dashboard', () => {
    const { readdirSync } = require('node:fs');
    const { join } = require('node:path');
    const englishKeys = parseTranslationKeys().get('en');
    expect(englishKeys).toBeDefined();

    function* walk(dir: string): Generator<string> {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) yield* walk(p);
        else if (ent.isFile() && (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx'))) yield p;
      }
    }

    const missing: Array<{ file: string; key: string }> = [];
    for (const path of walk('dashboard/src')) {
      const rel = path.replace(/\\/g, '/').replace(/^.+memesh-llm-memory\//, '');
      if (rel === 'dashboard/src/lib/i18n.ts') continue;
      const src = readFileSync(path, 'utf8');
      // Only STATIC single-quoted keys: t('foo.bar'). Dynamic/template keys
      // (e.g. t(`graph.age${bucket}`)) can't be verified statically and are
      // intentionally skipped — they use backticks and won't match here.
      for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) {
        const key = m[1];
        if (!englishKeys!.has(key)) missing.push({ file: rel, key });
      }
    }

    expect(missing).toEqual([]);
  });

  // Doctor messages reach the dashboard as server data, so the static-key
  // scan above cannot see them. Every warn/fail variant in doctor.ts carries
  // a stable `code:` literal; the banner translates it as
  // `doctor.msg.<code>.summary` / `.fix`. This scans doctor.ts for those
  // literals and demands a catalogue entry for each — a new warn/fail
  // variant cannot ship untranslated (the exact hole that put raw English
  // jargon in front of a zh-TW user: "agentic-loop guard", "user_interrupt").
  // Fixes are looked up only when the check ships one, so only the summary
  // is universally required. Parity across the other 10 locales is then
  // enforced by the locale-parity test at the top of this file.
  it('has an English catalogue entry for every doctor message code', () => {
    const doctorSrc = readFileSync('src/core/doctor.ts', 'utf8');
    const codes = [...doctorSrc.matchAll(/\bcode:\s*'([a-z0-9.-]+)'/g)].map((m) => m[1]);
    expect(codes.length, 'doctor.ts stopped declaring message codes — the banner is back to raw English').toBeGreaterThanOrEqual(40);

    const englishKeys = parseTranslationKeys().get('en');
    expect(englishKeys).toBeDefined();
    const missing = [...new Set(codes)].filter((code) => !englishKeys!.has(`doctor.msg.${code}.summary`));
    expect(missing, 'warn/fail variants with no translation catalogue entry').toEqual([]);
  });
});
