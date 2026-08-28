// @vitest-environment happy-dom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/preact';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { t } from '../../dashboard/src/lib/i18n';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const noop = () => {};

describe('SettingsTab search-index provider card', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('saves the search-index provider with config readback and shows rebuild progress to success', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    let configReads = 0;
    let reindexReads = 0;

    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/reindex')) {
        posts.push({ url, body: null });
        return jsonResponse({
          success: true,
          data: {
            status: 'running',
            job: { id: 'job-1', state: 'running', processed: 0, total: 3, startedAt: '2026-08-28T12:00:00.000Z', finishedAt: null },
            configuredProvider: 'openai',
            configuredDimension: 1536,
            storedDimension: 768,
            pendingReindex: { from: 768, to: 1536, reason: 'dimension-change', noticedAt: '2026-08-28T11:59:00.000Z' },
            missingVectors: 2,
            generation: { state: 'none' },
            result: null,
            error: null,
          },
        }, 202);
      }
      if (method === 'POST' && url.includes('/v1/config')) {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        posts.push({ url, body });
        return jsonResponse({ success: true, data: { embedder: { provider: 'openai' } } });
      }
      if (url.includes('/v1/reindex')) {
        reindexReads++;
        if (reindexReads === 1) {
          return jsonResponse({
            success: true,
            data: {
              status: 'idle', job: null, configuredProvider: 'ollama', configuredDimension: 768,
              storedDimension: 768, pendingReindex: null, missingVectors: 0,
              generation: { state: 'none' }, result: null, error: null,
            },
          });
        }
        const running = reindexReads === 2;
        return jsonResponse({
          success: true,
          data: running
            ? {
                status: 'running',
                job: { id: 'job-1', state: 'running', processed: 1, total: 3, startedAt: '2026-08-28T12:00:00.000Z', finishedAt: null },
                configuredProvider: 'openai',
                configuredDimension: 1536,
                storedDimension: 768,
                pendingReindex: { from: 768, to: 1536, reason: 'dimension-change', noticedAt: '2026-08-28T11:59:00.000Z' },
                missingVectors: 2,
                generation: { state: 'open', info: { provider: 'openai', dimension: 1536, startedAt: '2026-08-28T12:00:00.000Z' } },
                result: null,
                error: null,
              }
            : {
                status: 'succeeded',
                job: { id: 'job-1', state: 'succeeded', processed: 3, total: 3, startedAt: '2026-08-28T12:00:00.000Z', finishedAt: '2026-08-28T12:00:02.000Z' },
                configuredProvider: 'openai',
                configuredDimension: 1536,
                storedDimension: 1536,
                pendingReindex: null,
                missingVectors: 0,
                generation: { state: 'none' },
                result: { processed: 3, embedded: 3, skipped: 0, failed: 0, outcomes: { stored: 3 }, missingVectors: 0, missingVectorsDatabaseWide: 0, pendingReindexCleared: true, generationSwapped: true, abortedAfter: null },
                error: null,
              },
        });
      }
      if (url.includes('/v1/update-status')) {
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) {
        configReads++;
        const embedder = configReads >= 2 ? { provider: 'openai' } : { provider: 'ollama' };
        const embeddings = configReads >= 2 ? 'openai' : 'ollama';
        return jsonResponse({
          success: true,
          data: {
            config: {
              llm: { provider: 'openai', apiKey: '***' },
              embedder,
            },
            capabilities: {
              searchLevel: 1,
              llm: { provider: 'openai', apiKey: '***' },
              embeddings,
            },
          },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={noop} />);

    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.indexProviderTitle'));
      expect(container.textContent).toContain(t('settings.indexProviderConfigured', { provider: 'Ollama', dimension: '768' }));
    });

    const openaiRadio = await waitFor(() => {
      const radios = Array.from(container.querySelectorAll('input[type="radio"][name="embedder-provider"]'));
      const found = radios.find((el) => (el as HTMLInputElement).value === 'openai');
      if (!found) throw new Error('embedder provider radios not rendered');
      return found as HTMLInputElement;
    });
    fireEvent.click(openaiRadio);

    fireEvent.click(getByText(t('settings.indexProviderSave')));

    await waitFor(() => {
      expect(posts.some((p) => (p.body as { embedder?: { provider?: string } } | null)?.embedder?.provider === 'openai')).toBe(true);
      expect(container.textContent).toContain(t('settings.indexProviderConfigured', { provider: 'OpenAI', dimension: '1536' }));
    });

    fireEvent.click(getByText(t('settings.reindexStart')));

    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.reindexRunning', { processed: '1', total: '3' }));
    });

    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.reindexSucceeded'));
      expect(container.textContent).toContain(t('settings.reindexUpToDate'));
    });
  });

  it('shows a truthful failed rebuild state and retry action', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    let reindexReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/reindex')) {
        return jsonResponse({
          success: true,
          data: {
            status: 'failed',
            job: { id: 'job-2', state: 'failed', processed: 0, total: 0, startedAt: '2026-08-28T12:10:00.000Z', finishedAt: '2026-08-28T12:10:00.100Z' },
            configuredProvider: null,
            configuredDimension: 384,
            storedDimension: 768,
            pendingReindex: { from: 768, to: 1536, reason: 'dimension-change', noticedAt: '2026-08-28T12:09:00.000Z' },
            missingVectors: 2,
            generation: { state: 'none' },
            result: null,
            error: 'No embedding provider configured',
          },
        }, 202);
      }
      if (url.includes('/v1/reindex')) {
        reindexReads++;
        return jsonResponse({
          success: true,
          data: {
            status: reindexReads === 1 ? 'retry-needed' : 'failed',
            job: reindexReads === 1 ? null : { id: 'job-2', state: 'failed', processed: 0, total: 0, startedAt: '2026-08-28T12:10:00.000Z', finishedAt: '2026-08-28T12:10:00.100Z' },
            configuredProvider: null,
            configuredDimension: 384,
            storedDimension: 768,
            pendingReindex: { from: 768, to: 1536, reason: 'dimension-change', noticedAt: '2026-08-28T12:09:00.000Z' },
            missingVectors: 2,
            generation: { state: 'none' },
            result: null,
            error: reindexReads === 1 ? null : 'No embedding provider configured',
          },
        });
      }
      if (url.includes('/v1/update-status')) {
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: {
            config: {
              llm: { provider: 'anthropic', apiKey: '***' },
              embedder: { provider: 'openai' },
            },
            capabilities: {
              searchLevel: 1,
              llm: { provider: 'anthropic', apiKey: '***' },
              embeddings: 'openai',
            },
          },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={noop} />);

    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.indexProviderTitle'));
      expect(container.textContent).toContain(t('settings.reindexRetryNeeded'));
    });

    fireEvent.click(getByText(t('settings.reindexRetry')));

    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.reindexFailed'));
      expect(container.textContent).toContain('No embedding provider configured');
    });
  });

  it('does not invent a saved Ollama provider when no embedder is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/reindex')) {
        return jsonResponse({
          success: true,
          data: {
            status: 'idle', job: null, configuredProvider: null, configuredDimension: 384,
            storedDimension: 384, pendingReindex: null, missingVectors: 0,
            generation: { state: 'none' }, result: null, error: null,
          },
        });
      }
      if (url.includes('/v1/update-status')) {
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: {
            config: {},
            capabilities: { searchLevel: 0, embeddings: 'tfidf' },
          },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container, getByText } = render(<SettingsTab locale="en" onLocaleChange={noop} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.indexProviderConfigured', {
        provider: t('settings.none'), dimension: '—',
      }));
    });
    expect((getByText(t('settings.indexProviderSave')) as HTMLButtonElement).disabled).toBe(true);
    expect((getByText(t('settings.reindexStart')) as HTMLButtonElement).disabled).toBe(true);
  });
});
