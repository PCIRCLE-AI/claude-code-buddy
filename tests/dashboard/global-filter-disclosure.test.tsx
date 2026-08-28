// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { Header } from '../../dashboard/src/components/Header';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { GraphTab } from '../../dashboard/src/components/GraphTab';
import { setLocale, t } from '../../dashboard/src/lib/i18n';
import type { Entity } from '../../dashboard/src/lib/api';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function entity(id: number, type = 'decision'): Entity {
  return {
    id,
    name: `global-filter-${id}`,
    type,
    created_at: '2026-08-29T00:00:00.000Z',
    observations: [`memory ${id}`],
    tags: [],
    access_count: 0,
  };
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-TW');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/v1/entities')) return response([entity(1), entity(2, 'session_keypoint')]);
    if (url === '/v1/projects') return response([]);
    if (url.includes('/v1/graph?layer=work')) {
      return response({
        entities: [entity(1), entity(2), entity(3), entity(4), entity(5)],
        relations: [],
        evidenceCounts: {},
      });
    }
    return response({ entities: [], relations: [], noiseTypes: ['session_keypoint'], evidenceCounts: {} });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLocale('en');
  localStorage.clear();
});

describe('issue #232 — understandable global memory filter', () => {
  it('explains the focused/all effect and updates both affected pages in the same tab', async () => {
    const view = render(
      <>
        <Header health={{ status: 'ok', version: '4.8.1', entity_count: 2 }} error="" />
        <MemoriesTab />
        <GraphTab />
      </>,
    );

    const focused = t('globalFilter.focusedStatus');
    await waitFor(() => expect(view.container.textContent?.split(focused).length).toBe(3));

    const toggle = view.getByRole('button', { name: /重點記憶.*session.*commit.*活動紀錄/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).not.toContain('訊號');

    fireEvent.click(toggle);
    const all = t('globalFilter.allStatus');
    await waitFor(() => expect(view.container.textContent?.split(all).length).toBe(3));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('memesh.signalMode')).toBe('false');
  });

  it('persists across remount and responds to a cross-tab storage event', async () => {
    localStorage.setItem('memesh.signalMode', 'false');
    const view = render(<Header health={{ status: 'ok', version: '4.8.1', entity_count: 0 }} error="" />);
    const toggle = view.getByRole('button', { name: /所有記憶.*session.*commit.*活動紀錄/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    localStorage.setItem('memesh.signalMode', 'true');
    window.dispatchEvent(new StorageEvent('storage', { key: 'memesh.signalMode' }));
    await waitFor(() => expect(toggle.textContent).toContain('重點記憶'));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });
});
