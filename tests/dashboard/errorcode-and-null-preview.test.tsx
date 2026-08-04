// @vitest-environment happy-dom
//
// Batch C glue — the dashboard half of two server contracts:
//
// 1. `digest_observations_preview` is now `null` (not the '(empty)'
//    sentinel) when a proposal has no observations. The cards must render
//    a localised empty state — never the sentinel, never a dangling '…'.
// 2. Error envelopes carry a stable machine `errorCode` next to the
//    English `error` prose. api() translates KNOWN codes (httpError.*),
//    falls back to the raw prose for unknown ones; SettingsTab translates
//    probe codes (settings.testError.*) and keeps the prose as detail.
//    Miss-detection is the sanctioned `translated === key` check.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { api } from '../../dashboard/src/lib/api';
import { t } from '../../dashboard/src/lib/i18n';
import { PatternCard } from '../../dashboard/src/components/PatternCard';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

// ── api(): stable errorCode → translated message ────────────────────────────

describe('api() translates known errorCodes', () => {
  it('throws the httpError.<code> translation for a known code, not the raw prose', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'route.retired', error: 'raw server English about /v1/dream/run' }),
    );
    const expected = t('httpError.route.retired');
    expect(expected, 'the catalogue must actually contain the key this test relies on').not.toBe('httpError.route.retired');
    await expect(api('POST', '/v1/consolidate', {})).rejects.toThrow(expected);
  });

  it('falls back to the raw error prose for an UNKNOWN code (absence stays visible)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'future.not-in-this-bundle', error: 'raw prose survives' }),
    );
    await expect(api('POST', '/v1/whatever', {})).rejects.toThrow('raw prose survives');
  });

  it('still uses the raw error when no errorCode is present (pre-upgrade servers)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, error: 'plain old message' }),
    );
    await expect(api('POST', '/v1/whatever', {})).rejects.toThrow('plain old message');
  });
});

// ── null preview: PatternCard ────────────────────────────────────────────────

const noop = () => {};
const cardProps = {
  detail: undefined,
  expanded: false,
  inFlight: false,
  onToggleExpand: noop,
  onAccept: noop,
  onReject: noop,
  formatRelative: () => 'now',
  statusBadgeStyle: () => ({}),
  statusLabel: (s: string) => s,
};

function patternProposal(preview: string | null) {
  return {
    id: 7,
    project: 'memesh',
    cluster_key: 'pattern:2026-08-05',
    source_count: 3,
    digest_name: 'a-pattern',
    digest_observations_preview: preview,
    status: 'pending',
    created_at: '2026-08-05 00:00:00',
  };
}

describe('PatternCard renders null preview as a localised empty state', () => {
  it('shows insights.noPreview and no dangling ellipsis when preview is null', () => {
    const { container } = render(<PatternCard proposal={patternProposal(null)} {...cardProps} />);
    expect(container.textContent).toContain(t('insights.noPreview'));
    expect(container.textContent).not.toContain('…');
    expect(container.textContent).not.toContain('(empty)');
  });

  it('shows the preview text with an ellipsis when one exists', () => {
    const { container } = render(<PatternCard proposal={patternProposal('real preview text')} {...cardProps} />);
    expect(container.textContent).toContain('real preview text…');
  });
});

// ── null preview: InsightsTab digest card ────────────────────────────────────

describe('InsightsTab renders a null digest preview as a localised empty state', () => {
  it('shows insights.noPreview for a digest proposal without observations', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/dream/proposals')) {
        return jsonResponse({
          success: true,
          data: [{
            id: 1,
            project: 'memesh',
            cluster_key: '2026-W32',
            source_count: 5,
            digest_name: 'empty-digest',
            digest_observations_preview: null,
            status: 'pending',
            created_at: '2026-08-05 00:00:00',
            kind: 'digest',
          }],
        });
      }
      // /v1/config capability probe and anything else the tab loads.
      return jsonResponse({ success: true, data: { capabilities: { llm: { provider: 'anthropic' } } } });
    });

    const { container } = render(<InsightsTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('empty-digest');
    });
    expect(container.textContent).toContain(t('insights.noPreview'));
    expect(container.textContent).not.toContain('(empty)');
  });
});

// ── SettingsTab: probe errorCode translation + language POST ────────────────

describe('SettingsTab translates config-test probe codes', () => {
  it('renders settings.testError.auth (with the raw prose as detail) when the probe says auth', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/config/test')) {
        return jsonResponse({
          success: true,
          data: { valid: false, error: 'Authentication failed — the API key was rejected.', errorCode: 'auth' },
        });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: {
            config: { llm: { provider: 'anthropic' } },
            capabilities: { searchLevel: 1, llm: { provider: 'anthropic' } },
          },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container } = render(<SettingsTab locale="en" onLocaleChange={noop} />);

    // Wait for config to load — the apiKey input renders once a non-ollama
    // provider is selected. The Test button stays disabled until a key is
    // typed, so enter one before clicking.
    const keyInput = await waitFor(() => {
      const input = container.querySelector('input[type="password"]');
      if (!input) throw new Error('apiKey input not rendered yet');
      return input as HTMLInputElement;
    });
    fireEvent.input(keyInput, { target: { value: 'sk-test-not-a-real-key' } });

    const testButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === t('settings.test') && !(b as HTMLButtonElement).disabled,
    );
    expect(testButton, 'enabled Test button not found').toBeDefined();
    fireEvent.click(testButton!);

    await waitFor(() => {
      expect(container.textContent).toContain(t('settings.testError.auth'));
    });
    // The raw provider prose stays visible as the detail.
    expect(container.textContent).toContain('the API key was rejected');
  });
});

describe('SettingsTab language selector also sets the server output language', () => {
  it('POSTs { language: <display name> } to /v1/config when the locale changes', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/config')) {
        posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse({ success: true, data: {} });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: { config: {}, capabilities: { searchLevel: 0 } },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });

    const { container } = render(<SettingsTab locale="en" onLocaleChange={noop} />);

    // The language <select> is the one carrying the zh-TW option.
    const select = await waitFor(() => {
      const sel = Array.from(container.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'zh-TW'),
      );
      if (!sel) throw new Error('language select not rendered yet');
      return sel as HTMLSelectElement;
    });

    fireEvent.change(select, { target: { value: 'zh-TW' } });

    // The POST carries the locale's DISPLAY NAME — it lands inside an LLM
    // prompt, where '繁體中文' is unambiguous and a bare code is not.
    await waitFor(() => {
      expect(posts.some((p) => (p.body as any)?.language === '繁體中文')).toBe(true);
    });
  });
});
