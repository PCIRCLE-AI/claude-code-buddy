// @vitest-environment happy-dom
//
// The "Fallback providers" section edits the ordered llmFallbacks failover
// chain. These tests pin the parts a user's credentials depend on:
//   - Save POSTs the entries in display order, with a freshly typed key present
//   - an untouched (masked) cloud entry is saved WITHOUT re-sending the '***'
//     mask — the server keeps its stored key
//   - Test posts { provider, apiKey } to /v1/config/test
//   - Remove drops the entry

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';

interface Call { method: string; url: string; body: any }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Route fetch and record every call. `configFallbacks` seeds the GET
 * /v1/config response so a test can start from a stored (masked) chain.
 * IMPORTANT: match /v1/config/test BEFORE /v1/config — the latter is a
 * substring of the former.
 */
function mockFetch(configFallbacks: unknown[] = []): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    if (url.includes('/v1/config/test')) {
      return jsonResponse({ success: true, data: { valid: true, models: [{ id: 'gpt-4o-mini' }], suggested: 'gpt-4o-mini' } });
    }
    if (method === 'POST' && url.includes('/v1/config')) {
      return jsonResponse({ success: true, data: { llm: null, llmFallbacks: [] } });
    }
    if (url.includes('/v1/config')) {
      return jsonResponse({
        success: true,
        data: {
          config: { autoUpdate: 'off', llmFallbacks: configFallbacks },
          capabilities: { searchLevel: 0 },
        },
      });
    }
    return jsonResponse({ success: true, data: {} });
  });
  return calls;
}

function fallbacksCard(container: Element): HTMLElement {
  const card = container.querySelector('[data-testid="settings-fallbacks"]');
  if (!card) throw new Error('fallbacks card not rendered');
  return card as HTMLElement;
}

function findButton(root: Element, text: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

function entries(container: Element): HTMLElement[] {
  return Array.from(fallbacksCard(container).querySelectorAll('[data-testid="fallback-entry"]')) as HTMLElement[];
}

function lastPost(calls: Call[]): Call {
  const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/v1/config') && !c.url.includes('/test'));
  return posts[posts.length - 1];
}

describe('SettingsTab fallback providers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves two fallbacks (ollama + openai w/ key), reordered, in order with the key present', async () => {
    const calls = mockFetch([]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    const card = await waitFor(() => fallbacksCard(container));
    const addBtn = findButton(card, 'Add fallback provider');

    // Entry 0 (defaults to ollama), entry 1 -> openai with a key.
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    await waitFor(() => expect(entries(container).length).toBe(2));

    const secondSelect = entries(container)[1].querySelector('select') as HTMLSelectElement;
    fireEvent.change(secondSelect, { target: { value: 'openai' } });
    await waitFor(() => {
      const pw = entries(container)[1].querySelector('input[type="password"]');
      if (!pw) throw new Error('openai key field not shown yet');
    });
    const keyInput = entries(container)[1].querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: 'sk-openai-123' } });

    // Reorder: move the openai entry (index 1) up so it becomes first.
    const moveUp = findButton(entries(container)[1], '↑');
    fireEvent.click(moveUp);

    fireEvent.click(findButton(fallbacksCard(container), 'Save fallback chain'));

    await waitFor(() => expect(lastPost(calls)).toBeDefined());
    expect(lastPost(calls).body).toEqual({
      llmFallbacks: [
        { provider: 'openai', apiKey: 'sk-openai-123' },
        { provider: 'ollama' },
      ],
    });
  });

  it('does not re-send the mask for an untouched stored cloud entry', async () => {
    const calls = mockFetch([{ provider: 'openai', model: 'gpt-4o-mini', apiKey: '***' }]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    await waitFor(() => expect(entries(container).length).toBe(1));

    // Save WITHOUT touching the key.
    fireEvent.click(findButton(fallbacksCard(container), 'Save fallback chain'));

    await waitFor(() => expect(lastPost(calls)).toBeDefined());
    const sent = lastPost(calls).body.llmFallbacks;
    // No apiKey; identity travels as keepKeyFrom = the loaded index (0).
    expect(sent).toEqual([{ provider: 'openai', model: 'gpt-4o-mini', keepKeyFrom: 0 }]);
    // The mask must never travel back.
    expect(JSON.stringify(sent)).not.toContain('***');
  });

  it('reordering two same-provider stored entries sends each its OWN keepKeyFrom', async () => {
    // The credential-swap bug: two openai entries, both with stored keys,
    // reordered and saved untouched. Each must carry the index it loaded from,
    // so the server refills each with ITS own key rather than swapping them.
    const calls = mockFetch([
      { provider: 'openai', model: 'm0', apiKey: '***' },
      { provider: 'openai', model: 'm1', apiKey: '***' },
    ]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(entries(container).length).toBe(2));

    // Move entry 1 (m1) up so display order becomes [m1, m0].
    fireEvent.click(findButton(entries(container)[1], '↑'));
    fireEvent.click(findButton(fallbacksCard(container), 'Save fallback chain'));

    await waitFor(() => expect(lastPost(calls)).toBeDefined());
    expect(lastPost(calls).body.llmFallbacks).toEqual([
      { provider: 'openai', model: 'm1', keepKeyFrom: 1 },
      { provider: 'openai', model: 'm0', keepKeyFrom: 0 },
    ]);
  });

  it('changing an entry provider clears keepKeyFrom so it cannot inherit a stored key', async () => {
    const calls = mockFetch([
      { provider: 'anthropic', apiKey: '***' },
      { provider: 'openai', model: 'm1', apiKey: '***' },
    ]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(entries(container).length).toBe(2));

    // Change entry 0 anthropic → openai.
    const sel0 = entries(container)[0].querySelector('select') as HTMLSelectElement;
    fireEvent.change(sel0, { target: { value: 'openai' } });

    fireEvent.click(findButton(fallbacksCard(container), 'Save fallback chain'));
    await waitFor(() => expect(lastPost(calls)).toBeDefined());
    // Row 0 (changed) carries NO key and NO keepKeyFrom; row 1 (untouched)
    // keeps its own identity. The changed row must not steal index 1's key.
    expect(lastPost(calls).body.llmFallbacks).toEqual([
      { provider: 'openai' },
      { provider: 'openai', model: 'm1', keepKeyFrom: 1 },
    ]);
  });

  it('Test on a freshly typed key posts { provider, apiKey }', async () => {
    const calls = mockFetch([]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    const card = await waitFor(() => fallbacksCard(container));
    fireEvent.click(findButton(card, 'Add fallback provider'));
    await waitFor(() => expect(entries(container).length).toBe(1));

    const sel = entries(container)[0].querySelector('select') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'anthropic' } });
    await waitFor(() => {
      if (!entries(container)[0].querySelector('input[type="password"]')) throw new Error('key field not shown');
    });
    const keyInput = entries(container)[0].querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(keyInput, { target: { value: 'sk-ant-xyz' } });

    fireEvent.click(findButton(entries(container)[0], 'Test'));

    await waitFor(() => {
      if (!calls.find((c) => c.url.includes('/v1/config/test'))) throw new Error('no test call yet');
    });
    const testCall = calls.find((c) => c.url.includes('/v1/config/test'))!;
    expect(testCall.method).toBe('POST');
    expect(testCall.body).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-xyz' });
  });

  it('Test on an untouched stored cloud entry posts fallbackIndex (its own key), not the mask or nothing', async () => {
    // The false-401 / false-green bug: an untouched cross-provider fallback
    // sends fallbackIndex so the server probes THIS entry's stored key, not the
    // primary's and not an empty key.
    const calls = mockFetch([{ provider: 'openai', model: 'gpt-4o-mini', apiKey: '***' }]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => expect(entries(container).length).toBe(1));

    fireEvent.click(findButton(entries(container)[0], 'Test'));
    await waitFor(() => {
      if (!calls.find((c) => c.url.includes('/v1/config/test'))) throw new Error('no test call yet');
    });
    const testCall = calls.find((c) => c.url.includes('/v1/config/test'))!;
    expect(testCall.body).toEqual({ provider: 'openai', model: 'gpt-4o-mini', fallbackIndex: 0 });
    // No key bytes, no mask travelled.
    expect(JSON.stringify(testCall.body)).not.toContain('***');
    expect(testCall.body).not.toHaveProperty('apiKey');
  });

  it('removing an entry drops it and re-keys the survivor keepKeyFrom to its loaded index', async () => {
    const calls = mockFetch([
      { provider: 'ollama', model: 'llama3.2' },
      { provider: 'openai', model: 'gpt-4o-mini', apiKey: '***' },
    ]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    await waitFor(() => expect(entries(container).length).toBe(2));

    // Remove the first (ollama) entry; the openai survivor loaded from index 1.
    fireEvent.click(findButton(entries(container)[0], 'Remove'));
    await waitFor(() => expect(entries(container).length).toBe(1));

    fireEvent.click(findButton(fallbacksCard(container), 'Save fallback chain'));
    await waitFor(() => expect(lastPost(calls)).toBeDefined());
    // Survivor keeps its identity (index 1) so the server refills ITS key, not
    // the removed ollama slot's.
    expect(lastPost(calls).body.llmFallbacks).toEqual([{ provider: 'openai', model: 'gpt-4o-mini', keepKeyFrom: 1 }]);
  });
});
