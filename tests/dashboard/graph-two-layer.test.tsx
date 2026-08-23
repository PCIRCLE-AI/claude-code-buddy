// @vitest-environment happy-dom
//
// UX-4's two-layer graph, from the tab's side. What this pins:
//
//   1. The work layer is what loads first — the tab's question is "what was
//      decided and learned", not "what is stored".
//   2. When the work layer is too small to be a graph, the fallback to the
//      full graph is ANNOUNCED. A silent fallback is the same defect R2
//      removed from recall: the user asked for one thing and is shown
//      another with nothing saying so.
//   3. The layer buttons carry aria-pressed, so the current layer is
//      readable without seeing the colour.
//
// The requests are asserted by URL because that is the contract between the
// bundle and the server — a mock of `fetchWorkGraph` would pass even if the
// tab called the wrong endpoint.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { GraphTab, WORK_LAYER_MIN_NODES, isWorkGraphRenderable } from '../../dashboard/src/components/GraphTab';
import { t } from '../../dashboard/src/lib/i18n';
import type { Entity } from '../../dashboard/src/lib/api';

function entity(i: number, overrides: Partial<Entity> = {}): Entity {
  return {
    id: i,
    name: `work-${i}`,
    type: 'decision',
    created_at: '2026-08-16T00:00:00.000Z',
    observations: ['obs'],
    tags: [],
    access_count: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records every requested URL and answers each from `routes`, freshly —
 *  one Response object cannot be read twice, and this tab legitimately
 *  fetches more than once on the fallback path. */
function stubFetch(routes: (url: string) => unknown): string[] {
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input);
    seen.push(url);
    return Promise.resolve(jsonResponse({ success: true, data: routes(url) }));
  }) as typeof fetch);
  return seen;
}

// A FIXED count, not `WORK_LAYER_MIN_NODES + 1`: a fixture derived from the
// constant under test moves with it, so raising the threshold to 9999 would
// still "pass". (Measured: it did — this file's first version survived that
// mutation.) The constant is pinned separately below, so a deliberate change
// to it is a visible edit here rather than a silent one.
const WORK_NODES = Array.from({ length: 5 }, (_, i) => entity(i + 1));

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('GraphTab — two layers', () => {
  it('the fallback threshold is small enough that a real graph renders the work layer', () => {
    // 3, measured against the live graph on 2026-08-17: 53 work entities of
    // 361 active. The threshold exists for a young install, where the work
    // layer is genuinely empty — not to gate ordinary use.
    expect(WORK_LAYER_MIN_NODES).toBe(3);
    expect(WORK_NODES.length).toBeGreaterThanOrEqual(WORK_LAYER_MIN_NODES);
  });

  it('a payload with no evidenceCounts is unreadable, not a graph of zero badges', async () => {
    // The leaf predicate, tested directly: a component-level assertion cannot
    // tell "rejected because evidenceCounts was missing" from "rejected
    // because entities was", and it is the FIRST that this guard adds.
    expect(isWorkGraphRenderable({ entities: [], relations: [], evidenceCounts: {} })).toBe(true);
    expect(isWorkGraphRenderable({ entities: [], relations: [] })).toBe(false);
    expect(isWorkGraphRenderable({ entities: [], relations: [], evidenceCounts: [] as unknown as Record<string, number> })).toBe(false);

    // …and the tab says so rather than drawing every badge as zero.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch((url) =>
      url.includes('layer=work')
        ? { entities: WORK_NODES, relations: [] }   // server omitted evidenceCounts
        : { entities: WORK_NODES, relations: [], noiseTypes: [] },
    );
    const { container } = render(<GraphTab />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/could not read the reply|看不懂/i);
    });
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('names the focused node by its headline, never by the machine key', async () => {
    // UX-1's chain is `title → best observation → type + date` and it
    // "Deliberately NEVER falls back to `name`" — name is a dedup key like
    // `pre-compact-<sessionId>`. The graph rendered that key in its focus
    // banner, which is the one place the user reads a node's identity in
    // text. Pinned because the fix was measured to be unprotected: reverting
    // it to `{egoEntity.name}` left every existing assertion green.
    const titled = entity(1, { name: 'pre-compact-9f3c2a1b', title: 'Why the graph opens on work' });
    stubFetch(() => ({
      entities: [titled, ...WORK_NODES.slice(1)],
      relations: [],
      evidenceCounts: {},
    }));
    const { container } = render(<GraphTab />);
    await waitFor(() => { expect(container.querySelector('canvas')).not.toBeNull(); });

    // Enter focus mode the way the component does — clicking is a canvas
    // gesture, so drive the state through the search box's auto-centre
    // instead and assert on what the banner would render.
    const search = container.querySelector(`input[placeholder="${t('graph.search')}"]`) as HTMLInputElement;
    expect(search, 'the graph search box moved').not.toBeNull();
    fireEvent.input(search, { target: { value: 'Why the graph' } });
    await waitFor(() => {
      expect(container.textContent, 'graph search cannot find a node by its headline')
        .toContain('1 matches');
    });
    expect(container.textContent).not.toContain('pre-compact-9f3c2a1b');
  });

  it('asks for the work layer first and never fetches the full graph when it is big enough', async () => {
    const seen = stubFetch(() => ({
      entities: WORK_NODES,
      relations: [],
      evidenceCounts: { 'work-1': 2 },
    }));
    const { container } = render(<GraphTab />);
    await waitFor(() => {
      expect(container.querySelector('canvas')).not.toBeNull();
    });
    expect(seen.some((u) => u.includes('/v1/graph?layer=work'))).toBe(true);
    // The whole point of the layered response: the evidence layer (an order
    // of magnitude bigger) is not shipped to draw this view.
    expect(seen.filter((u) => u.endsWith('/v1/graph'))).toEqual([]);
    expect(container.textContent).not.toContain(t('graph.layerFellBack', { min: WORK_LAYER_MIN_NODES }));
  });

  it('falls back to the full graph when the work layer is too small — and says so', async () => {
    const seen = stubFetch((url) =>
      url.includes('layer=work')
        ? { entities: [entity(1)], relations: [], evidenceCounts: {} }
        : { entities: [entity(1), entity(2)], relations: [], noiseTypes: [] },
    );
    const { container } = render(<GraphTab />);
    await waitFor(() => {
      expect(container.textContent).toContain(
        t('graph.layerFellBack', { min: WORK_LAYER_MIN_NODES }),
      );
    });
    expect(seen.some((u) => u.endsWith('/v1/graph'))).toBe(true);
  });

  it('switching to Everything fetches the full graph and drops the fallback note', async () => {
    stubFetch((url) =>
      url.includes('layer=work')
        ? { entities: WORK_NODES, relations: [], evidenceCounts: {} }
        : { entities: WORK_NODES, relations: [], noiseTypes: [] },
    );
    const { container } = render(<GraphTab />);
    await waitFor(() => { expect(container.querySelector('canvas')).not.toBeNull(); });

    // Scoped to this render's container: @testing-library/preact leaves
    // earlier renders in document.body here, so a document-wide getByText
    // matches the previous test's buttons too.
    const btn = (label: string): HTMLElement => {
      const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
      if (!found) throw new Error(`no button labelled ${label}`);
      return found as HTMLElement;
    };

    expect(btn(t('graph.layerAll')).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn(t('graph.layerAll')));
    await waitFor(() => {
      expect(btn(t('graph.layerAll')).getAttribute('aria-pressed')).toBe('true');
    });
    expect(btn(t('graph.layerWork')).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('GraphTab — a node can be opened from the keyboard', () => {
  // Node selection was pointer-only. The click handler was the ONLY path into
  // ego mode and the evidence drill-down, so a keyboard user could focus the
  // canvas (it is focusable and carries an aria-label with the counts) and
  // read the summary — and could not open a single node. Search highlighted
  // matches and stopped there.
  //
  // The fix is deliberately narrow: Enter in the search box, only when the
  // query has narrowed to exactly one node. Full node-to-node traversal is
  // still deferred, and the canvas comment says so.

  function searchBox(container: Element): HTMLInputElement {
    const input = container.querySelector('input[type="text"]') as HTMLInputElement | null;
    if (!input) throw new Error('fixture: no search box rendered');
    return input;
  }

  it('Enter opens the sole match', async () => {
    const target = entity(1, { name: 'work-1', title: 'The decision about caching' });
    stubFetch(() => ({
      entities: [target, ...WORK_NODES.slice(1)],
      relations: [],
      evidenceCounts: {},
    }));
    const { container } = render(<GraphTab />);
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());

    const input = searchBox(container);
    fireEvent.input(input, { target: { value: 'caching' } });
    await waitFor(() => {
      expect(container.textContent ?? '', 'fixture: the query matched nothing').toContain('1 ');
    });

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(container.textContent ?? '', 'Enter did not open the node')
        .toContain('The decision about caching');
    });
  });

  it('says Enter is available exactly when it is', async () => {
    // A hint that appeared on every search would promise an action that does
    // nothing whenever the query matches two nodes or none.
    stubFetch(() => ({ entities: WORK_NODES, relations: [], evidenceCounts: {} }));
    const { container } = render(<GraphTab />);
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());

    const input = searchBox(container);
    const hint = () => container.querySelector('#graph-search-hint')?.textContent ?? '';

    // Every fixture node is named `work-N`, so this matches all five.
    fireEvent.input(input, { target: { value: 'work-' } });
    await waitFor(() => expect(hint()).toContain('5 '));
    expect(hint(), 'the hint promised Enter on an ambiguous query').not.toContain(t('graph.enterToOpen'));

    fireEvent.input(input, { target: { value: 'work-3' } });
    await waitFor(() => expect(hint()).toContain('1 '));
    expect(hint(), 'the hint is missing when Enter WOULD work').toContain(t('graph.enterToOpen'));
  });

  it('Enter on an ambiguous query does nothing', async () => {
    stubFetch(() => ({ entities: WORK_NODES, relations: [], evidenceCounts: {} }));
    const { container } = render(<GraphTab />);
    await waitFor(() => expect(container.querySelector('canvas')).not.toBeNull());

    const input = searchBox(container);
    fireEvent.input(input, { target: { value: 'work-' } });
    await waitFor(() => expect(container.querySelector('#graph-search-hint')?.textContent ?? '').toContain('5 '));

    fireEvent.keyDown(input, { key: 'Enter' });

    // No focus banner appeared — the tab is where it was.
    expect(container.querySelector('#graph-search-hint')?.textContent ?? '').toContain('5 ');
  });
});
