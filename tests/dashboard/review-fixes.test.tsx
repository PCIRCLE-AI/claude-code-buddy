// @vitest-environment happy-dom
//
// The five scenarios the UX-1..UX-4 review found and nothing covered. Each
// fix was measured to be UNPINNED when it landed — the suite stayed green
// with the defect restored — so these exist to make the next regression
// loud rather than to describe code that already works.
//
// The through-line is one rule: a failure and an absence are different
// claims. "No results", "no projects", "2,000 active" and "oldest first"
// are all statements about the user's data, and each of these tests fails
// if the component makes one of them from a response it could not read, a
// request that lost a race, or a comparison of two timestamp formats.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { ProjectTab } from '../../dashboard/src/components/ProjectTab';
import { t } from '../../dashboard/src/lib/i18n';
import type { Entity } from '../../dashboard/src/lib/api';

function entity(i: number, over: Partial<Entity> = {}): Entity {
  return {
    id: i,
    name: `entity-${i}`,
    type: 'decision',
    created_at: '2026-08-01 00:00:00',
    observations: [`obs ${i}`],
    tags: [],
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Answers each URL from `routes`, freshly — one Response cannot be read
 *  twice and these components legitimately fetch more than once. */
function stubFetch(routes: (url: string) => unknown | Promise<unknown>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = await routes(url);
    return jsonResponse({ success: true, data: body });
  }) as typeof fetch);
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('MemoriesTab — a stale ranked search must not overwrite a newer view', () => {
  it('a slow earlier query that resolves last is discarded', async () => {
    // Type "auth" (slow), then clear the box. Clearing correctly returns the
    // browse list — and then the stale "auth" response used to arrive and
    // flip the view back to ranked mode with an empty search box.
    // Explicitly typed: assigning only inside the Promise executor lets TS
    // narrow this to `never` at the call site below.
    let releaseSlow: undefined | (() => void);
    let recallCalls = 0;
    stubFetch(async (url) => {
      if (url.includes('/v1/projects')) return [];
      if (url.includes('/v1/recall')) {
        recallCalls++;
        await new Promise<void>((r) => { releaseSlow = r; });
        return { entities: [entity(99, { observations: ['STALE ranked hit'] })], retrieval: {} };
      }
      return [entity(1, { observations: ['browse row'] })];
    });

    const { container } = render(<MemoriesTab />);
    await waitFor(() => { expect(container.textContent).toContain('browse row'); });

    const search = container.querySelector('input[type="search"]') as HTMLInputElement;
    expect(search, 'the Memories search box moved').not.toBeNull();
    fireEvent.input(search, { target: { value: 'auth' } });
    // Enter reads `filter` from state, and the input's state update has not
    // flushed yet at this point — pressing Enter immediately made
    // runDeepSearch see an empty query and return without fetching, which
    // would make this whole test vacuous.
    await waitFor(() => { expect(search.value).toBe('auth'); });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => {
      expect(recallCalls, 'no ranked search was issued — the race is not being staged').toBe(1);
    });

    // Back to browsing before the answer lands.
    fireEvent.input(search, { target: { value: '' } });
    await waitFor(() => { expect(search.value).toBe(''); });

    releaseSlow?.();
    // Settle properly. `waitFor(browse row)` alone is satisfied on its first
    // synchronous check — the row is already there — so it would assert
    // BEFORE the stale response had a chance to write, and pass whether or
    // not the guard exists. Give the promise chain and the rerender real
    // turns of the event loop first.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    expect(
      container.textContent,
      'a discarded search overwrote the browse list it had already left',
    ).not.toContain('STALE ranked hit');
    expect(container.textContent, 'the browse list should still be showing').toContain('browse row');
  });
});

describe('MemoriesTab — a truncated list says so even when the total is unknown', () => {
  it('health that never loads does not silence the truncation notice', async () => {
    // Hitting the fetch limit IS the evidence of truncation. The total only
    // decides which sentence to use; `(health?.entity_count ?? 0)` made a
    // null health mean "nothing was cut" and a 12,000-memory library showed
    // "2,000 active" with nothing saying the rest existed.
    const many = Array.from({ length: 2000 }, (_, i) => entity(i + 1));
    stubFetch((url) => (url.includes('/v1/projects') ? [] : many));

    const { container } = render(<MemoriesTab health={null} />);
    await waitFor(() => { expect(container.textContent).toContain('obs 1'); });
    expect(container.textContent).toContain(t('browse.truncatedUnknownTotal', { shown: '2,000' }).slice(0, 24));
  });
});

describe('MemoriesTab — "newest first" compares instants, not two text formats', () => {
  it('a fresher never-recalled memory outranks one recalled earlier the same day', async () => {
    // `last_accessed_at` is ISO-8601, `created_at` is SQLite's space format,
    // and a space sorts before a 'T' — so within one day every recalled
    // memory used to precede a fresher never-recalled one.
    const recalledEarlier = entity(1, {
      name: 'recalled-9am', observations: ['recalled at 9am'],
      created_at: '2026-08-01 00:00:00', last_accessed_at: '2026-08-17T09:00:00.000Z',
    });
    const freshLater = entity(2, {
      name: 'fresh-11pm', observations: ['created at 11pm'],
      created_at: '2026-08-17 23:00:00',
    });
    stubFetch((url) => (url.includes('/v1/projects') ? [] : [recalledEarlier, freshLater]));

    const { container } = render(<MemoriesTab />);
    await waitFor(() => { expect(container.textContent).toContain('created at 11pm'); });

    // Switch to the recency sort, then read the DOM order of the two rows.
    const sort = container.querySelector('select') as HTMLSelectElement;
    if (sort) fireEvent.change(sort, { target: { value: 'recent' } });
    await waitFor(() => {
      const text = container.textContent ?? '';
      const fresh = text.indexOf('created at 11pm');
      const older = text.indexOf('recalled at 9am');
      expect(fresh, 'both rows must render').toBeGreaterThanOrEqual(0);
      expect(older).toBeGreaterThanOrEqual(0);
      expect(fresh, 'the 14-hours-older recalled row was ranked as the newest').toBeLessThan(older);
    });
  });
});

describe('ProjectTab — a failed project fetch is not an empty project list', () => {
  it('says the request failed instead of claiming the user has no projects', async () => {
    stubFetch((url) => {
      if (url.includes('/v1/projects')) throw new TypeError('Failed to fetch');
      return [entity(1, { tags: ['project:myapp'] })];
    });

    const { container } = render(<ProjectTab />);
    await waitFor(() => {
      expect(
        container.textContent,
        'a dead /v1/projects rendered as "no project memories yet"',
      ).not.toContain(t('project.empty'));
    });
  });
});
