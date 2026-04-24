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
});
