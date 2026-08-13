// @vitest-environment happy-dom
//
// The Behaviour toggle (autoUpdate select) used to swallow
// a failed POST in an empty catch, so the control snapped back with no signal —
// the user thought the setting saved. Guard that a failed write is surfaced.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route fetch: GET /v1/config loads a config; POST /v1/config fails. */
function mockFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/v1/config')) {
      return jsonResponse({ success: false, error: 'save failed' });
    }
    if (url.includes('/v1/config')) {
      return jsonResponse({
        success: true,
        data: {
          config: { autoUpdate: 'off', enableAgenticOrchestration: false },
          capabilities: { searchLevel: 0 },
        },
      });
    }
    // update-status and anything else the tab loads on mount.
    return jsonResponse({ success: true, data: {} });
  });
}

describe('SettingsTab behaviour toggles surface POST failures', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the error instead of silently swallowing a failed autoUpdate write', async () => {
    mockFetch();
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    // Wait for config to load — the autoUpdate <select> (the one with a
    // 'patch' option) is only rendered once config resolves.
    const select = await waitFor(() => {
      const sel = Array.from(container.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'patch'),
      );
      if (!sel) throw new Error('autoUpdate select not rendered yet');
      return sel as HTMLSelectElement;
    });

    fireEvent.change(select, { target: { value: 'patch' } });

    await waitFor(() => {
      expect(container.textContent).toContain('save failed');
    });
  });
});
