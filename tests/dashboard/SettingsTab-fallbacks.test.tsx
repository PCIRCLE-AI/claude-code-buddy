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
          config: { autoUpdate: 'off', enableAgenticOrchestration: false, llmFallbacks: configFallbacks },
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
    expect(sent).toEqual([{ provider: 'openai', model: 'gpt-4o-mini' }]);
    // The mask must never travel back.
    expect(JSON.stringify(sent)).not.toContain('***');
  });

  it('Test posts { provider, apiKey } to /v1/config/test', async () => {
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
      const testCall = calls.find((c) => c.url.includes('/v1/config/test'));
      if (!testCall) throw new Error('no test call yet');
    });
    const testCall = calls.find((c) => c.url.includes('/v1/config/test'))!;
    expect(testCall.method).toBe('POST');
    expect(testCall.body).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-xyz' });
  });

  it('removing an entry drops it from the saved chain', async () => {
    const calls = mockFetch([
      { provider: 'ollama', model: 'llama3.2' },
      { provider: 'openai', model: 'gpt-4o-mini', apiKey: '***' },
    ]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    await waitFor(() => expect(entries(container).length).toBe(2));

    // Remove the first (ollama) entry.
    fireEvent.click(findButton(entries(container)[0], 'Remove'));
    await waitFor(() => expect(entries(container).length).toBe(1));

    fireEvent.click(findButton(fallbacksCard(container), 'Save fallback chain'));
    await waitFor(() => expect(lastPost(calls)).toBeDefined());
    expect(lastPost(calls).body.llmFallbacks).toEqual([{ provider: 'openai', model: 'gpt-4o-mini' }]);
  });
});
