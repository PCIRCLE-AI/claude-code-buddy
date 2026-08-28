// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { HomeTab, chooseNextAction } from '../../dashboard/src/components/HomeTab';
import { setLocale } from '../../dashboard/src/lib/i18n';
import type { ReindexStatusData } from '../../dashboard/src/lib/api';

const healthyIndex: ReindexStatusData = {
  status: 'idle',
  job: null,
  configuredProvider: 'openai',
  configuredDimension: 1536,
  storedDimension: 1536,
  pendingReindex: null,
  missingVectors: 0,
  generation: { state: 'open' },
  result: null,
  error: null,
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubHome(options: { proposals?: unknown[]; llm?: boolean; reindex?: ReindexStatusData } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/v1/reindex') return response(options.reindex ?? healthyIndex);
    if (url.startsWith('/v1/dream/proposals')) return response(options.proposals ?? []);
    if (url === '/v1/config') return response({ capabilities: { llm: options.llm === false ? undefined : { provider: 'openai' } } });
    if (url.startsWith('/v1/stats')) return response({ totalEntities: 1, totalObservations: 1, totalRelations: 0, totalTags: 0, typeDistribution: [], tagDistribution: [], statusDistribution: [] });
    if (url.startsWith('/v1/citations')) return response({ total: 0, verified: 0, rate: null });
    return response({});
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('en');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('issue #234 — one truthful next-best action', () => {
  it('uses a deterministic priority for all five requested states', () => {
    const ready = { pendingCount: 0, llmConfigured: true, loading: false, failed: false };
    expect(chooseNextAction(0, healthyIndex, ready)).toBe('empty');
    expect(chooseNextAction(4, { ...healthyIndex, missingVectors: 2 }, { ...ready, pendingCount: 3 })).toBe('reindex');
    expect(chooseNextAction(4, healthyIndex, { ...ready, pendingCount: 3 })).toBe('insights');
    expect(chooseNextAction(4, healthyIndex, { ...ready, llmConfigured: false })).toBe('llm');
    expect(chooseNextAction(4, healthyIndex, ready)).toBe('healthy');
  });

  it('routes an empty library to the existing Memories workflow without claiming completion', () => {
    stubHome();
    const onNavigate = vi.fn();
    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 0 }} onNavigate={onNavigate} />);

    expect(view.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Add your first memory');
    expect(view.container.textContent).toContain('Why:');
    expect(view.container.textContent).toContain('Expected result:');
    expect(view.container.textContent).not.toMatch(/completed|succeeded/i);
    fireEvent.click(view.getByRole('button', { name: 'Open Memories' }));
    expect(onNavigate).toHaveBeenCalledWith('Memories');
  });

  it('renders only the highest-priority reindex action and routes to Settings', async () => {
    stubHome({ proposals: [{ id: 1, status: 'pending' }], reindex: { ...healthyIndex, missingVectors: 1 } });
    const onNavigate = vi.fn();
    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} onNavigate={onNavigate} />);

    await waitFor(() => expect(view.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Rebuild the search index'));
    expect(view.queryByRole('button', { name: 'Review suggestions' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Open search settings' }));
    expect(onNavigate).toHaveBeenCalledWith('Settings');
  });

  it('focuses the existing review surface for pending suggestions', async () => {
    stubHome({ proposals: [{ id: 1, status: 'pending', project: 'p', cluster_key: 'c', source_count: 2, digest_name: 'Review me', digest_observations_preview: 'preview', created_at: '2026-08-29 00:00:00' }] });
    const view = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} />);

    const action = await view.findByRole('button', { name: 'Review suggestions' });
    fireEvent.click(action);
    expect(document.activeElement?.id).toBe('home-insights');
  });

  it('shows provider setup when no LLM exists, otherwise an honest no-action state', async () => {
    stubHome({ llm: false });
    const onNavigate = vi.fn();
    const first = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} onNavigate={onNavigate} />);
    const setup = await first.findByRole('button', { name: 'Open LLM settings' });
    fireEvent.click(setup);
    expect(onNavigate).toHaveBeenCalledWith('Settings');
    first.unmount();

    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubHome();
    const second = render(<HomeTab health={{ status: 'ok', version: '4.8.1', entity_count: 4 }} />);
    await waitFor(() => expect(second.getAllByRole('heading', { level: 2 })[0].textContent).toBe('No action needed right now'));
    expect(second.queryByRole('button', { name: /Open|Review/ })).toBeNull();
  });
});
