// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { App } from '../../dashboard/src/App';
import { t } from '../../dashboard/src/lib/i18n';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configData(
  llm: { provider: string; model?: string; apiKey?: string } | undefined,
  embedder: { provider: 'openai' | 'ollama' } | undefined = undefined,
  effectiveLlm: { provider: string; model?: string; apiKey?: string } | undefined = llm,
  llmSource: 'config' | 'environment' | 'none' = llm ? 'config' : 'none',
) {
  return {
    config: { ...(llm ? { llm } : {}), ...(embedder ? { embedder } : {}) },
    capabilities: {
      searchLevel: llm ? 1 : 0,
      ...(effectiveLlm ? { llm: effectiveLlm } : {}),
      llmSource,
      embeddings: embedder?.provider ?? 'tfidf',
    },
  };
}

function backgroundResponse(url: string): Response | null {
  if (url.includes('/v1/update-status')) return jsonResponse({ success: true, data: {} });
  if (url.includes('/v1/reindex')) {
    return jsonResponse({
      success: true,
      data: {
        status: 'idle', job: null, configuredProvider: null, configuredDimension: 384,
        storedDimension: null, pendingReindex: null, missingVectors: 0,
        generation: { state: 'none' }, result: null, error: null,
      },
    });
  }
  if (url.includes('/v1/health')) {
    return jsonResponse({ success: true, data: { status: 'ok', version: '4.8.1', entity_count: 0 } });
  }
  if (url.includes('/v1/doctor')) return jsonResponse({ success: true, data: { status: 'pass', checks: [] } });
  if (url.includes('/v1/improvements')) return jsonResponse({ success: true, data: [] });
  return null;
}

function capabilityValues(container: Element): string[] {
  return [...container.querySelectorAll('.card:first-child .stat-val')]
    .map((node) => node.textContent?.trim() ?? '');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('SettingsTab primary LLM draft, test, save, and remove semantics', () => {
  it('separates an environment-detected effective LLM from the empty saved setting', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const background = backgroundResponse(url);
      if (background) return background;
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: configData(
            undefined,
            undefined,
            { provider: 'openai', model: 'gpt-env', apiKey: 'masked-secret-must-not-render' },
            'environment',
          ),
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText, queryByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(getByText(t('settings.llmSourceEnvironment'))).toBeTruthy());
    expect(capabilityValues(container)).toContain('Openai');
    expect(capabilityValues(container)).toContain('gpt-env');
    expect(container.textContent).not.toContain('masked-secret-must-not-render');
    expect([...container.querySelectorAll('input[name="provider"]')].some((node) => (node as HTMLInputElement).checked)).toBe(false);
    expect(queryByText(t('settings.removeProvider'))).toBeNull();
    expect(getByText(t('settings.savedLlmSetting'))).toBeTruthy();
  });

  it('labels saved config as authoritative when environment and config conflict', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const background = backgroundResponse(url);
      if (background) return background;
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: configData(
            { provider: 'openai', model: 'gpt-config', apiKey: '***' },
            undefined,
            { provider: 'openai', model: 'gpt-config', apiKey: '***' },
            'config',
          ),
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(getByText(t('settings.llmSourceConfig'))).toBeTruthy());
    expect(capabilityValues(container)).toContain('Openai');
    expect(capabilityValues(container)).toContain('gpt-config');
    expect((container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement).checked).toBe(true);
    expect(getByText(t('settings.removeProvider'))).toBeTruthy();
  });

  it('renders an honest no-effective-LLM source when neither config nor environment resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const background = backgroundResponse(url);
      if (background) return background;
      if (url.includes('/v1/config')) {
        return jsonResponse({ success: true, data: configData(undefined) });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(getByText(t('settings.llmSourceNone'))).toBeTruthy());
  });

  it('marks a radio-only change unsaved, never POSTs it, and protects browser unload', async () => {
    const requests: Array<{ method: string; url: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      requests.push({ method, url });
      const background = backgroundResponse(url);
      if (background) return background;
      if (url.includes('/v1/config')) {
        return jsonResponse({ success: true, data: configData({ provider: 'anthropic', apiKey: '***' }) });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.querySelector('input[name="provider"][value="openai"]')).not.toBeNull());

    fireEvent.click(container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement);

    expect(getByText(t('settings.unsaved'))).toBeTruthy();
    expect(getByText(t('settings.testRequired'))).toBeTruthy();
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('keeps a failed test as an unsaved draft without posting config', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      if (method === 'POST' && url.includes('/v1/config/test')) {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ success: true, data: { valid: false, error: 'fixture probe failed' } });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({ success: true, data: configData({ provider: 'anthropic', apiKey: '***' }) });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.querySelector('input[name="provider"][value="openai"]')).not.toBeNull());
    fireEvent.click(container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement);
    fireEvent.input(container.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'fixture-key' } });
    fireEvent.click(getByText(t('settings.test')));

    await waitFor(() => expect(container.textContent).toContain('fixture probe failed'));
    expect(container.textContent).toContain(t('settings.unsaved'));
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('fixture-key');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain('/v1/config/test');
  });

  it('tests the selected model and keeps the catalog available after inference failure', async () => {
    let testBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      if (method === 'POST' && url.includes('/v1/config/test')) {
        testBody = JSON.parse(String(init?.body));
        return jsonResponse({
          success: true,
          data: {
            valid: false,
            errorCode: 'inference_failed',
            error: 'Model gpt-listed-only failed the inference probe: OpenAI API error: 400',
            catalogVerified: true,
            inferenceVerified: false,
            testedModel: 'gpt-listed-only',
            suggested: 'gpt-compatible',
            models: [{ id: 'gpt-compatible' }, { id: 'gpt-listed-only' }],
          },
        });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: configData({ provider: 'openai', model: 'gpt-listed-only', apiKey: '***' }),
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(getByText(t('settings.test'))).toBeTruthy());
    fireEvent.click(getByText(t('settings.test')));

    await waitFor(() => expect(container.textContent).toContain('OpenAI API error: 400'));
    expect(testBody).toMatchObject({ provider: 'openai', model: 'gpt-listed-only' });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect([...container.querySelectorAll('option')].map((entry) => entry.value))
      .toEqual(expect.arrayContaining(['gpt-compatible', 'gpt-listed-only']));
    fireEvent.change(container.querySelector('select') as HTMLSelectElement, { target: { value: 'gpt-compatible' } });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('promotes the draft only after POST plus authoritative GET readback', async () => {
    let persisted = false;
    const sequence: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      if (method === 'POST' && url.includes('/v1/config/test')) {
        sequence.push('test');
        return jsonResponse({ success: true, data: { valid: true, models: [{ id: 'gpt-fixture' }], suggested: 'gpt-fixture' } });
      }
      if (method === 'POST' && url.endsWith('/v1/config')) {
        sequence.push('save');
        persisted = true;
        return jsonResponse({ success: true, data: { llm: { provider: 'openai', model: 'gpt-fixture', apiKey: '***' } } });
      }
      if (url.includes('/v1/config')) {
        sequence.push(persisted ? 'readback' : 'load');
        return jsonResponse({
          success: true,
          data: persisted
            ? configData({ provider: 'openai', model: 'gpt-fixture', apiKey: '***' })
            : configData({ provider: 'anthropic', apiKey: '***' }),
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText, queryByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.querySelector('input[name="provider"][value="openai"]')).not.toBeNull());
    fireEvent.click(container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement);
    fireEvent.input(container.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'fixture-key' } });
    fireEvent.click(getByText(t('settings.test')));
    await waitFor(() => expect(container.textContent).toContain(t('settings.testPassed', { count: 1 })));
    fireEvent.click(getByText(t('settings.save')));

    await waitFor(() => expect(container.textContent).toContain(t('settings.saved')));
    expect(sequence).toEqual(['load', 'test', 'save', 'readback']);
    expect(queryByText(t('settings.unsaved'))).toBeNull();
    expect((container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    expect(capabilityValues(container)).toContain('Openai');
    expect(capabilityValues(container)).toContain('gpt-fixture');
  });

  it('preserves the tested draft and secret input when Save fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      if (method === 'POST' && url.includes('/v1/config/test')) {
        return jsonResponse({ success: true, data: { valid: true, models: [{ id: 'gpt-fixture' }], suggested: 'gpt-fixture' } });
      }
      if (method === 'POST' && url.endsWith('/v1/config')) {
        return jsonResponse({ success: false, error: 'fixture save refused' }, 500);
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({ success: true, data: configData({ provider: 'anthropic', apiKey: '***' }) });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.querySelector('input[name="provider"][value="openai"]')).not.toBeNull());
    fireEvent.click(container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement);
    fireEvent.input(container.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'fixture-key' } });
    fireEvent.click(getByText(t('settings.test')));
    await waitFor(() => expect(container.textContent).toContain(t('settings.testPassed', { count: 1 })));
    fireEvent.click(getByText(t('settings.save')));

    await waitFor(() => expect(container.textContent).toContain('fixture save refused'));
    expect(container.textContent).toContain(t('settings.unsaved'));
    expect(container.textContent).toContain(t('settings.testPassed', { count: 1 }));
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('fixture-key');
    expect((container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement).checked).toBe(true);
    expect(capabilityValues(container)).toContain('Anthropic');
    expect(capabilityValues(container)).not.toContain('gpt-fixture');
  });

  it('removes matching Ollama LLM and search provider together with GET readback', async () => {
    let removed = false;
    let removalBody: unknown = null;
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      if (method === 'POST' && url.endsWith('/v1/config')) {
        removalBody = JSON.parse(String(init?.body));
        removed = true;
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: removed
            ? configData(undefined, undefined)
            : configData({ provider: 'ollama', model: 'llama3.2' }, { provider: 'ollama' }),
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain(t('settings.removeMatchingProviders')));
    fireEvent.click(getByText(t('settings.removeMatchingProviders')));

    await waitFor(() => expect(container.textContent).toContain(t('settings.providerRemoved')));
    expect(removalBody).toEqual({ llm: null, embedder: null });
    expect(container.textContent).toContain(t('settings.indexProviderConfigured', { provider: t('settings.none'), dimension: '—' }));
    expect(container.textContent).not.toContain(t('settings.indexProviderConfigured', { provider: 'Ollama', dimension: '768' }));
    expect((getByText(t('settings.reindexStart')) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('App protects an unsaved Settings draft', () => {
  it('keeps Settings active when the user cancels tab navigation', async () => {
    localStorage.setItem('memesh.tab', 'Settings');
    vi.stubGlobal('confirm', vi.fn(() => false));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const background = backgroundResponse(url);
      if (background) return background;
      if (url.includes('/v1/config')) {
        return jsonResponse({ success: true, data: configData({ provider: 'anthropic', apiKey: '***' }) });
      }
      return jsonResponse({ success: true, data: [] });
    });

    const { container, getByRole } = render(<App />);
    await waitFor(() => expect(container.querySelector('input[name="provider"][value="openai"]')).not.toBeNull());
    fireEvent.click(container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement);
    fireEvent.click(getByRole('tab', { name: t('tab.home') }));

    expect(vi.mocked(confirm)).toHaveBeenCalledWith(t('settings.unsavedConfirm'));
    expect(getByRole('tab', { name: t('tab.settings') }).getAttribute('aria-selected')).toBe('true');
    expect(container.textContent).toContain(t('settings.unsaved'));
  });
});

/* ── loop closure: the readback must actually be read ────────────────────── */

describe('issue #221 — the save/readback loop is closed, not merely sequenced', () => {
  // The first version of these tests asserted the ORDER of calls and a
  // hardcoded readback body. Three mutations survived all 475 dashboard and
  // HTTP tests: posting a wrong model, posting no model at all, and deleting
  // the readback reconciliation in save() outright. A fake whose answer does
  // not depend on what was written cannot see any of them — it proves the
  // component made a request, not that the request carried the user's choice
  // or that the answer was checked.
  //
  // So the fake below is a store: it keeps the posted `llm` and serves it
  // back. That closes the loop on the write side. The second test breaks the
  // loop deliberately — the server answers with something the user did not
  // choose — and requires the UI to refuse, which is what pins the guard.

  function storeBackedFetch(opts: { readbackOverride?: unknown } = {}) {
    let stored: { provider: string; model?: string; apiKey?: string } | undefined;
    const posted: Array<Record<string, unknown>> = [];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      if (method === 'POST' && url.includes('/v1/config/test')) {
        return jsonResponse({ success: true, data: { valid: true, models: [{ id: 'gpt-fixture' }, { id: 'gpt-other' }], suggested: 'gpt-fixture' } });
      }
      if (method === 'POST' && url.endsWith('/v1/config')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { llm?: typeof stored };
        posted.push(body as Record<string, unknown>);
        stored = body.llm ?? undefined;           // the store echoes the write
        return jsonResponse({ success: true, data: { llm: stored } });
      }
      if (url.includes('/v1/config')) {
        if (stored && opts.readbackOverride !== undefined) {
          return jsonResponse({ success: true, data: configData(opts.readbackOverride as never) });
        }
        return jsonResponse({ success: true, data: configData(stored ?? { provider: 'anthropic', apiKey: '***' }) });
      }
      return jsonResponse({ success: true, data: {} });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as never);
    return { posted, get stored() { return stored; } };
  }

  async function selectTestAndSave(container: Element, getByText: (s: string) => HTMLElement) {
    await waitFor(() => expect(container.querySelector('input[name="provider"][value="openai"]')).not.toBeNull());
    fireEvent.click(container.querySelector('input[name="provider"][value="openai"]') as HTMLInputElement);
    fireEvent.input(container.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'fixture-key' } });
    fireEvent.click(getByText(t('settings.test')));
    await waitFor(() => expect(container.textContent).toContain(t('settings.testPassed', { count: 2 })));
    fireEvent.click(getByText(t('settings.save')));
  }

  it('sends the chosen model and shows back exactly what the server stored', async () => {
    const store = storeBackedFetch();
    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await selectTestAndSave(container, getByText);
    await waitFor(() => expect(container.textContent).toContain(t('settings.saved')));

    // The write carried the user's selection — not an empty body, not a
    // mangled one. This is what M1 and M2 escaped.
    expect(store.posted).toHaveLength(1);
    expect(store.posted[0].llm).toMatchObject({ provider: 'openai', model: 'gpt-fixture' });
    // And the card shows what the STORE holds, which is the same value.
    expect(store.stored).toMatchObject({ provider: 'openai', model: 'gpt-fixture' });
    expect(capabilityValues(container)).toContain('gpt-fixture');
  });

  it('refuses to report removal when the server still holds the provider', async () => {
    // Same defect as the save path: the remove-readback guard could be
    // deleted and all 477 dashboard/HTTP tests stayed green, because the
    // fake decided what to return from `removed`, a flag it set itself,
    // rather than from what the request actually did.
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const background = backgroundResponse(url);
      if (background) return background;
      // The POST is accepted and the server keeps the provider anyway — a
      // write that reports success and changes nothing.
      if (method === 'POST' && url.endsWith('/v1/config')) return jsonResponse({ success: true, data: {} });
      if (url.includes('/v1/config')) {
        return jsonResponse({ success: true, data: configData({ provider: 'ollama', model: 'llama3.2' }, { provider: 'ollama' }) });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain(t('settings.removeMatchingProviders')));
    fireEvent.click(getByText(t('settings.removeMatchingProviders')));

    await waitFor(() => expect(container.textContent).toContain(t('settings.configReadbackFailed')));
    expect(container.textContent).not.toContain(t('settings.providerRemoved'));
  });

  it('refuses to report success when the readback disagrees with what was chosen', async () => {
    // The server accepts the POST but answers the readback with a different
    // model. Deleting the reconciliation in save() makes this pass silently,
    // which is exactly the mutation that survived before.
    const store = storeBackedFetch({ readbackOverride: { provider: 'openai', model: 'gpt-something-else', apiKey: '***' } });
    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await selectTestAndSave(container, getByText);

    await waitFor(() => expect(container.textContent).toContain(t('settings.configReadbackFailed')));
    expect(container.textContent).not.toContain(t('settings.saved'));
    expect(store.posted[0].llm).toMatchObject({ model: 'gpt-fixture' });
  });
});
