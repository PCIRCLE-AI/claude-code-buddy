import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RADAR_AXES } from '../src/core/analytics.js';

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
    // InsightsTab once hand-rolled an English-only relative-time ladder
    // ("5s ago" / "3m ago" / …) instead of the localised shared formatter.
    const insightsSource = readFileSync('dashboard/src/components/InsightsTab.tsx', 'utf8');
    expect(insightsSource).not.toMatch(/\}[smhd] ago/);
    expect(insightsSource).toContain('relativeDate(');
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

  // Template-key call sites — t(`prefix.${value}`) — are invisible to the
  // static-key scan above, which is exactly how they leak: a value the
  // catalogue never heard of renders as a raw dotted key (or falls back to
  // the raw identifier at sites using the sanctioned miss detection). For
  // every template site the set of possible runtime values IS enumerable
  // somewhere real — a server constant, a type union, the literals a module
  // records — so each set is derived from that source and asserted to be a
  // subset of the English catalogue. Locale parity (test above) then carries
  // the guarantee to all 11 languages.
  describe('template-key fixed sets are fully translated', () => {
    const englishKeys = () => {
      const keys = parseTranslationKeys().get('en');
      expect(keys).toBeDefined();
      return keys!;
    };

    const expectAllPresent = (keys: string[]) => {
      const en = englishKeys();
      expect(keys.filter((k) => !en.has(k))).toEqual([]);
    };

    // KnowledgeRadar: t(`radar.axis.${axis}`) — axes come from the server's
    // RADAR_AXES constant, imported here so a new axis fails this test
    // until its translation lands.
    it('covers every radar axis', () => {
      expect(RADAR_AXES.length).toBeGreaterThanOrEqual(6);
      expectAllPresent(RADAR_AXES.map(({ axis }) => `radar.axis.${axis}`));
    });

    // InsightsTab: t(`insights.status.${status}`) and t(`insights.filter.${f}`).
    // The status lifecycle is pending → applied/rejected (dreamer.ts).
    it('covers every proposal status and filter', () => {
      expectAllPresent(['pending', 'applied', 'rejected'].map((s) => `insights.status.${s}`));
      expectAllPresent(['pending', 'applied', 'rejected', 'all'].map((f) => `insights.filter.${f}`));
    });

    // typeLabel(): t(`type.${slug}`) — entity types are open server data
    // with a sanctioned raw-slug fallback, so "⊆ catalogue" cannot hold for
    // arbitrary input. What must hold: every type THIS CODEBASE produces or
    // styles is translated. Derived from the two real vocabularies —
    // entity-display's TYPE_CLUSTER map and GraphTab's TYPE_COLORS.
    it('covers every entity type the dashboard knows about', () => {
      const entityDisplay = readFileSync('dashboard/src/lib/entity-display.ts', 'utf8');
      const clusterBlock = entityDisplay.match(/const TYPE_CLUSTER[\s\S]*?\n\};/);
      expect(clusterBlock).not.toBeNull();
      const clusterTypes = [...clusterBlock![0].matchAll(/(?:'([^']+)'|([\w-]+)):\s*'(?:knowledge|activity|reference|session)'/g)]
        .map((m) => m[1] ?? m[2]);
      expect(clusterTypes.length).toBeGreaterThanOrEqual(25);

      // Entity-type colours moved out of one TYPE_COLORS map: the token-backed
      // types are now in GraphTab's TOKEN_TYPE_VARS (value `'--token'`, resolved
      // for the canvas — see DESIGN.md), the category-only hues in
      // lib/type-palette.ts (value `'#hex'`). Both together are the vocabulary.
      const graphSrc = readFileSync('dashboard/src/components/GraphTab.tsx', 'utf8');
      const tokenBlock = graphSrc.match(/const TOKEN_TYPE_VARS[\s\S]*?\n\};/);
      expect(tokenBlock).not.toBeNull();
      const tokenTypes = [...tokenBlock![0].matchAll(/(?:'([^']+)'|([\w-]+)):\s*'--/g)]
        .map((m) => m[1] ?? m[2]);

      const paletteSrc = readFileSync('dashboard/src/lib/type-palette.ts', 'utf8');
      const paletteBlock = paletteSrc.match(/CATEGORICAL_TYPE_COLORS[\s\S]*?\n\};/);
      expect(paletteBlock).not.toBeNull();
      const catTypes = [...paletteBlock![0].matchAll(/(?:'([^']+)'|([\w-]+)):\s*'#/g)]
        .map((m) => m[1] ?? m[2]);

      const colorTypes = [...tokenTypes, ...catTypes];
      expect(colorTypes.length).toBeGreaterThanOrEqual(10);

      expectAllPresent([...new Set([...clusterTypes, ...colorTypes])].map((t) => `type.${t}`));
    });

    // relationLabel(): t(`relation.${type}`) — the relation vocabulary this
    // codebase emits lives in three places: the demo seed's relation
    // triples, kg-backfill's relationType union, and the two
    // behaviour-changing types documented in core/types.ts.
    it('covers every relation type the codebase emits', () => {
      const demoSrc = readFileSync('src/core/demo.ts', 'utf8');
      const demoRelations = [...demoSrc.matchAll(/\['[^']+', '([a-z_-]+)', '[^']+'\]/g)].map((m) => m[1]);
      expect(demoRelations.length).toBeGreaterThanOrEqual(5);

      const backfillSrc = readFileSync('src/core/kg-backfill.ts', 'utf8');
      const unionMatch = backfillSrc.match(/relationType:\s*((?:'[a-z-]+'\s*\|\s*)+'[a-z-]+')/);
      expect(unionMatch).not.toBeNull();
      const backfillRelations = [...unionMatch![1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
      expect(backfillRelations.length).toBeGreaterThanOrEqual(4);

      const all = [...new Set([...demoRelations, ...backfillRelations, 'supersedes', 'contradicts'])];
      expectAllPresent(all.map((r) => `relation.${r}`));
    });

    // UserPatterns: t(`patterns.day.${dayNum}`) — SQLite strftime %w is
    // exactly 0..6.
    it('covers all seven weekdays', () => {
      expectAllPresent([0, 1, 2, 3, 4, 5, 6].map((n) => `patterns.day.${n}`));
    });

    // LlmTelemetryPanel: t(`telemetry.flow.${flow}`) — flows are the
    // literals passed to recordTelemetry() across src/core.
    it('covers every telemetry flow recorded in src/core', () => {
      const { readdirSync } = require('node:fs');
      const flows = new Set<string>();
      for (const f of readdirSync('src/core')) {
        if (!f.endsWith('.ts')) continue;
        const src = readFileSync(`src/core/${f}`, 'utf8');
        for (const m of src.matchAll(/recordTelemetry\([^)]*\{\s*flow:\s*'([\w-]+)'/g)) flows.add(m[1]);
      }
      expect(flows.size).toBeGreaterThanOrEqual(5);
      expectAllPresent([...flows].map((f) => `telemetry.flow.${f}`));
    });

    // LlmTelemetryPanel: t(`telemetry.errorClass.${cls}`) — classes are the
    // LLMErrorClass union in llm-client.ts.
    it('covers every LLM error class', () => {
      // Strip line comments first: the union annotates each member with a
      // comment that itself contains a `;`, which would end a lazy match
      // after the first member.
      const clientSrc = readFileSync('src/core/llm-client.ts', 'utf8').replace(/\/\/[^\n]*/g, '');
      const unionMatch = clientSrc.match(/export type LLMErrorClass =([\s\S]*?);/);
      expect(unionMatch).not.toBeNull();
      const classes = [...unionMatch![1].matchAll(/\|\s*'(\w+)'/g)].map((m) => m[1]);
      expect(classes.length).toBeGreaterThanOrEqual(7);
      expectAllPresent(classes.map((c) => `telemetry.errorClass.${c}`));
    });

    // LessonsTab: t(`lessons.severity.${severity}`) — severities are the
    // severity:* tags severityOf() recognises.
    it('covers every lesson severity', () => {
      const lessonsSrc = readFileSync('dashboard/src/components/LessonsTab.tsx', 'utf8');
      const severities = [...new Set([...lessonsSrc.matchAll(/severity:(\w+)/g)].map((m) => m[1]))];
      expect(severities.sort()).toEqual(['critical', 'major', 'minor']);
      expectAllPresent(severities.map((s) => `lessons.severity.${s}`));
    });

    // PatternCard: t(`pattern.severity.${severity}`) — high/medium/low from
    // extractSeverity()'s regex.
    it('covers every pattern severity', () => {
      expectAllPresent(['high', 'medium', 'low'].map((s) => `pattern.severity.${s}`));
    });

    // MemoryAgeMatrix: t(`ageMatrix.bucket.${bucket}`) — the four buckets of
    // the AgeBucket type.
    it('covers every age bucket', () => {
      expectAllPresent(['week', 'month', 'quarter', 'older'].map((b) => `ageMatrix.bucket.${b}`));
    });

    // lib/api.ts: t(`httpError.${errorCode}`) — codes come from the server's
    // ErrorCode union in src/transports/http/server.ts, parsed here so a new
    // server code fails this test until its translation lands. (api.ts falls
    // back to the raw English prose for unknown codes, so a miss degrades,
    // not crashes — but a KNOWN code must never ship untranslated.)
    it('covers every HTTP errorCode the server can emit', () => {
      // Strip line comments first — each union member is annotated with one.
      const serverSrc = readFileSync('src/transports/http/server.ts', 'utf8').replace(/\/\/[^\n]*/g, '');
      const unionMatch = serverSrc.match(/type ErrorCode =([\s\S]*?);/);
      expect(unionMatch, 'server.ts stopped declaring the ErrorCode union').not.toBeNull();
      const codes = [...unionMatch![1].matchAll(/\|\s*'([\w.-]+)'/g)].map((m) => m[1]);
      expect(codes.length).toBeGreaterThanOrEqual(12);
      expectAllPresent(codes.map((c) => `httpError.${c}`));
    });

    // SettingsTab: t(`settings.testError.${code}`) — the probe codes the
    // llm-validator attaches to POST /v1/config/test failures. `http_<status>`
    // is a family; it is translated through the single parameterised
    // settings.testError.http entry.
    it('covers every config-test probe code', () => {
      expectAllPresent(['auth', 'network', 'no_models', 'bad_host', 'unknown'].map((c) => `settings.testError.${c}`));
      expectAllPresent(['settings.testError.http']);
    });
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
