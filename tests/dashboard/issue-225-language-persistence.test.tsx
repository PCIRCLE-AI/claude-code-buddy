// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { setLocale, t, type Locale } from '../../dashboard/src/lib/i18n';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configEnvelope(language: string) {
  return jsonResponse({
    success: true,
    data: {
      config: { language },
      capabilities: { searchLevel: 0, llmSource: 'none', embeddings: 'none' },
    },
  });
}

function auxiliaryResponse(url: string): Response {
  if (url.includes('/v1/update-status')) {
    return jsonResponse({
      success: true,
      data: { checkSucceeded: true, freshness: 'fresh', updateAvailable: false },
    });
  }
  if (url.includes('/v1/reindex')) {
    return jsonResponse({
      success: true,
      data: {
        status: 'idle', job: null, configuredProvider: null,
        configuredDimension: 0, storedDimension: 0, pendingReindex: null,
        missingVectors: 0, generation: {}, result: null, error: null,
      },
    });
  }
  return jsonResponse({ success: true, data: {} });
}

function LanguageHarness({ initialLocale = 'en' }: { initialLocale?: Locale }) {
  const [locale, setCurrentLocale] = useState<Locale>(initialLocale);
  return <SettingsTab locale={locale} onLocaleChange={setCurrentLocale} />;
}

async function languageSelect(container: ParentNode): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const label = t('settings.interfaceLanguage');
    const select = Array.from(container.querySelectorAll('select')).find((candidate) =>
      candidate.getAttribute('aria-labelledby') === 'settings-interface-language-label');
    if (!select) throw new Error(`${label} select not rendered`);
    return select as HTMLSelectElement;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setLocale('en');
});

describe('issue #225 output-language persistence truth', () => {
  it('changes the interface immediately but reports output language saved only after POST plus matching GET readback', async () => {
    let serverLanguage = 'English';
    const calls: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/config') && method === 'POST') {
        const body = JSON.parse(String(init?.body));
        calls.push(`POST:${body.language}`);
        serverLanguage = body.language;
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) {
        calls.push(`GET:${serverLanguage}`);
        return configEnvelope(serverLanguage);
      }
      return auxiliaryResponse(url);
    });

    const { container } = render(<LanguageHarness />);
    const select = await languageSelect(container);
    await waitFor(() => expect(container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('English'));
    calls.length = 0;

    fireEvent.change(select, { target: { value: 'zh-TW' } });

    await waitFor(() => expect(select.value).toBe('zh-TW'));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('繁體中文');
      expect(container.textContent).toContain(t('settings.outputLanguageSaved', { language: '繁體中文' }));
    });
    expect(calls).toEqual(['POST:繁體中文', 'GET:繁體中文']);
  });

  it('keeps the confirmed server truth visible after an injected 500, survives reload truthfully, and retries the failed draft', async () => {
    let serverLanguage = 'English';
    let failWrite = true;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/config') && method === 'POST') {
        if (failWrite) {
          return jsonResponse({ success: false, error: 'injected language write failure' }, 500);
        }
        serverLanguage = JSON.parse(String(init?.body)).language;
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) return configEnvelope(serverLanguage);
      return auxiliaryResponse(url);
    });

    const first = render(<LanguageHarness />);
    const select = await languageSelect(first.container);
    fireEvent.change(select, { target: { value: 'zh-TW' } });

    await waitFor(() => {
      expect(select.value).toBe('zh-TW');
      expect(first.container.querySelector('[role="alert"]')?.textContent).toContain('繁體中文');
      expect(first.container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('English');
    });
    expect(first.container.textContent).not.toContain(t('settings.outputLanguageSaved', { language: '繁體中文' }));

    // A reload keeps the browser locale but reads the unchanged server value;
    // it cannot turn the failed write into an apparent success.
    first.unmount();
    const reloaded = render(<LanguageHarness initialLocale="zh-TW" />);
    await languageSelect(reloaded.container);
    await waitFor(() => {
      expect(reloaded.container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('English');
      expect(reloaded.container.textContent).not.toContain(t('settings.outputLanguageSaved', { language: '繁體中文' }));
    });
    reloaded.unmount();

    // Retry the same failed draft in a fresh mounted failure state.
    const retryView = render(<LanguageHarness />);
    const retrySelect = await languageSelect(retryView.container);
    fireEvent.change(retrySelect, { target: { value: 'zh-TW' } });
    await waitFor(() => expect(retryView.container.querySelector('[role="alert"]')).not.toBeNull());
    failWrite = false;
    const retry = Array.from(retryView.container.querySelectorAll('button')).find(
      (button) => button.textContent === t('settings.retryOutputLanguage'),
    );
    expect(retry).toBeDefined();
    fireEvent.click(retry!);
    await waitFor(() => {
      expect(retryView.container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('繁體中文');
      expect(retryView.container.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it('rejects a successful POST when authoritative readback does not match', async () => {
    const serverLanguage = 'English';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/config') && method === 'POST') {
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) return configEnvelope(serverLanguage);
      return auxiliaryResponse(url);
    });

    const { container } = render(<LanguageHarness />);
    const select = await languageSelect(container);
    fireEvent.change(select, { target: { value: 'de' } });

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('English');
    });
    expect(container.textContent).not.toContain(t('settings.outputLanguageSaved', { language: 'Deutsch' }));
  });

  it('serializes in-flight selections so the latest language is the final server and visible truth', async () => {
    let serverLanguage = 'English';
    const posted: string[] = [];
    let resolveFirstPost: (() => void) | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/v1/config') && method === 'POST') {
        const language = JSON.parse(String(init?.body)).language as string;
        posted.push(language);
        if (posted.length === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirstPost = () => {
              serverLanguage = language;
              resolve(jsonResponse({ success: true, data: {} }));
            };
          });
        }
        serverLanguage = language;
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) return configEnvelope(serverLanguage);
      return auxiliaryResponse(url);
    });

    const { container } = render(<LanguageHarness />);
    const select = await languageSelect(container);
    fireEvent.change(select, { target: { value: 'zh-TW' } });
    await waitFor(() => expect(posted).toEqual(['繁體中文']));

    fireEvent.change(select, { target: { value: 'de' } });
    expect(posted).toEqual(['繁體中文']);
    resolveFirstPost?.();

    await waitFor(() => expect(posted).toEqual(['繁體中文', 'Deutsch']));
    await waitFor(() => {
      expect(serverLanguage).toBe('Deutsch');
      expect(select.value).toBe('de');
      expect(container.querySelector('[data-testid="confirmed-output-language"]')?.textContent).toBe('Deutsch');
    });
  });
});
