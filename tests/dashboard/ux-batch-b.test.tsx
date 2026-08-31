// @vitest-environment happy-dom
//
// Batch B — flow / error / empty-state UX. What these pin:
//
//   1. No raw exception prose reaches the user. A dead server surfaces as
//      the browser's "Failed to fetch"; every catch that used to paint
//      `e.message` now routes through actionFailureMessage(), which says
//      what happened AND what to do, localised.
//   2. api() reads the error envelope on non-2xx responses. The server
//      sends `success:false` envelopes WITH their real status (400/500);
//      throwing `HttpError` straight off `!res.ok` discarded the errorCode
//      the whole Batch-C translation layer exists for.
//   3. An empty DATABASE and a filter that matched nothing are different
//      truths with different messages — and the empty-database state carries
//      the demo seed button, the durable entry point that survives the
//      OnboardingBanner's permanent dismissal.
//   4. Silent truncation is spoken: Memories at its 2000-row fetch limit
//      names the real total; the Graph's node cap names what it kept.
//
// All network is stubbed — nothing here touches ~/.memesh or any config.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { api, HttpError, NetworkError, type Entity } from '../../dashboard/src/lib/api';
import { actionFailureMessage } from '../../dashboard/src/lib/failure';
import { t, getLocale } from '../../dashboard/src/lib/i18n';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { ProjectTab } from '../../dashboard/src/components/ProjectTab';
import { GraphTab, capGraphEntities, GRAPH_NODE_CAP } from '../../dashboard/src/components/GraphTab';
import { SettingsTab } from '../../dashboard/src/components/SettingsTab';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { EmptyLibraryState } from '../../dashboard/src/components/EmptyLibraryState';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function entity(i: number, over: Partial<Entity> = {}): Entity {
  return {
    id: i,
    name: `entity-${i}`,
    // 'decision' sits in the WORK layer — the default scope when Signal
    // Mode is on — so list-visibility assertions see these rows.
    type: 'decision',
    created_at: '2026-08-01T00:00:00.000Z',
    observations: [`obs ${i}`],
    tags: [],
    ...over,
  };
}

const unreachableSentence = t('common.serverUnreachable');

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/* ── api(): envelopes on real (non-2xx) statuses ─────────────────────────── */

describe('api() reads the error envelope the server actually sends (non-2xx)', () => {
  it('translates a KNOWN errorCode from a 400 envelope instead of throwing "HTTP 400"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'validation.bad-body', error: 'raw zod prose' }, 400),
    );
    const expected = t('httpError.validation.bad-body');
    expect(expected, 'the catalogue must contain the key this test relies on').not.toBe('httpError.validation.bad-body');
    await expect(api('POST', '/v1/remember', {})).rejects.toThrow(expected);
  });

  it('keeps the raw prose for an UNKNOWN code on a 500 envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, errorCode: 'future.code', error: 'prose survives' }, 500),
    );
    await expect(api('GET', '/v1/whatever')).rejects.toThrow('prose survives');
  });

  it('still throws HttpError for a non-2xx with no envelope (a proxy page)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502 }),
    );
    await expect(api('GET', '/v1/health')).rejects.toBeInstanceOf(HttpError);
  });
});

/* ── actionFailureMessage(): the four shapes ─────────────────────────────── */

describe('actionFailureMessage', () => {
  it('turns a NetworkError into the unreachable sentence, not browser prose', () => {
    const msg = actionFailureMessage(new NetworkError('Failed to fetch'));
    expect(msg).toContain(unreachableSentence);
    expect(msg).not.toContain('Failed to fetch');
  });

  it('names the status for an envelope-less HttpError', () => {
    expect(actionFailureMessage(new HttpError(502))).toBe(t('common.serverError', { status: 502 }));
  });

  it('passes through an envelope Error (already translated or server prose)', () => {
    expect(actionFailureMessage(new Error('digest already applied'))).toBe('digest already applied');
  });

  it('falls back to the localized unknown for a non-Error throw', () => {
    expect(actionFailureMessage('wat')).toBe(t('errors.unknown'));
  });
});

/* ── MemoriesTab: dead server, both failure paths ────────────────────────── */

describe('MemoriesTab against a dead server', () => {
  it('deep search shows the localized unreachable sentence, never "Failed to fetch"', async () => {
    // The list loads fine and the server dies BEFORE the ranked search, so
    // the sentence this pins comes from the /v1/recall ACTION path — the
    // migrated SearchTab guard — not from the mount load's catch.
    let dead = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (dead) throw new TypeError('Failed to fetch');
      const url = String(input);
      if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [] });
      return jsonResponse({ success: true, data: [entity(1)] });
    });
    const { container } = render(<MemoriesTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });

    dead = true;
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'auth' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'error box should render').not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });

  it('routes a dead server at load through the classified sentence', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<MemoriesTab />);
    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });
});

/* ── MemoriesTab: empty database vs filter-matched-nothing ───────────────── */

function stubMemories(entities: Entity[], entityCount?: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.includes('/v1/demo/seed')) {
      return jsonResponse({ success: true, data: { inserted: 30, removed: 0 } });
    }
    if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [] });
    if (url.includes('/v1/entities')) return jsonResponse({ success: true, data: entities });
    return jsonResponse({ success: true, data: { status: 'ok', version: 't', entity_count: entityCount ?? entities.length } });
  });
}

describe('MemoriesTab empty-state awareness', () => {
  it('an empty database shows the seed entry point, not "try a different filter"', async () => {
    stubMemories([]);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
    expect(container.textContent).not.toContain(t('browse.emptyFilter'));

    // The one-click seed works from here — the OnboardingBanner may be
    // permanently dismissed, so this button is the durable path.
    const seedBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent === t('onboarding.seedButton'));
    expect(seedBtn, 'seed button should render inside the empty state').toBeDefined();
    fireEvent.click(seedBtn!);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/v1/demo/seed', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('a filter that matched nothing keeps the filter message and no seed button', async () => {
    stubMemories([entity(1)]);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    // UX-1: rows no longer print the machine name; the observation-derived
    // headline is the render sentinel now.
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });
    const filterInput = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(filterInput, { target: { value: 'zzz-no-match' } });
    await waitFor(() => {
      expect(container.textContent).toContain(t('browse.noMatch'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
  });

  it('an empty WORK LAYER guides instead of apologising, and one click widens the scope', async () => {
    // Signal Mode defaults ON, so the tab opens scoped to the work layer.
    // A graph of pure mechanical capture (commits) has nothing there — the
    // empty state must say where work memories come from and offer the
    // all-memories scope, not claim a filter mismatch or a fresh install.
    stubMemories([entity(1, { type: 'commit' })]);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('memories.workEmpty'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
    expect(container.textContent).not.toContain(t('browse.noMatch'));

    const showAll = [...container.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes(t('memories.showAll')));
    expect(showAll, 'the show-all escape hatch should render').toBeDefined();
    fireEvent.click(showAll!);
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });
  });

  it('names the truncation when the fetch limit is hit and the library is larger', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => entity(i + 1));
    stubMemories(full, 5000);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 5000 }} />);
    const expected = t('browse.truncated', {
      shown: (2000).toLocaleString('en'),
      total: (5000).toLocaleString('en'),
    });
    await waitFor(() => {
      expect(container.textContent).toContain(expected);
    });
  });

  it('says nothing about truncation when the fetch got everything', async () => {
    stubMemories([entity(1), entity(2)], 2);
    const { container } = render(<MemoriesTab health={{ status: 'ok', version: 't', entity_count: 2 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain('obs 1');
    });
    // Match the key's stable English prefix rather than re-interpolating.
    expect(container.textContent).not.toContain('showing the first');
  });
});

/* ── GraphTab: scale guard + empty state ─────────────────────────────────── */

describe('GraphTab scale guard', () => {
  it('capGraphEntities keeps the most-recalled nodes and respects the cap', () => {
    const many = Array.from({ length: GRAPH_NODE_CAP + 100 }, (_, i) =>
      entity(i + 1, { access_count: i }));
    const capped = capGraphEntities(many);
    expect(capped.length).toBe(GRAPH_NODE_CAP);
    // Highest access_count must survive; the lowest must not.
    expect(capped.some((e) => e.access_count === GRAPH_NODE_CAP + 99)).toBe(true);
    expect(capped.some((e) => e.access_count === 0)).toBe(false);
  });

  it('capGraphEntities is the identity at or under the cap', () => {
    const few = [entity(1), entity(2)];
    expect(capGraphEntities(few)).toBe(few);
  });

  it('the capped graph SAYS it is capped', async () => {
    const many = Array.from({ length: GRAPH_NODE_CAP + 10 }, (_, i) =>
      entity(i + 1, { access_count: i }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: true, data: { entities: many, relations: [], noiseTypes: [], evidenceCounts: {} } }),
    );
    const { container } = render(<GraphTab />);
    const expected = t('graph.cappedNote', {
      shown: GRAPH_NODE_CAP.toLocaleString('en'),
      total: (GRAPH_NODE_CAP + 10).toLocaleString('en'),
    });
    await waitFor(() => {
      expect(container.textContent).toContain(expected);
    });
  });

  it('an empty database renders the instructive empty state, not a bare canvas', async () => {
    // mockImplementation, not mockResolvedValue: an empty work layer makes the
    // tab fall back to the full graph, so this path fetches TWICE. One shared
    // Response object throws "Body has already been used" on the second read —
    // a real fetch hands back a fresh body per call, and the fixture has to.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      jsonResponse({ success: true, data: { entities: [], relations: [], noiseTypes: [], evidenceCounts: {} } }),
    ) as ReturnType<typeof fetch>);
    const { container } = render(<GraphTab />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('counts orphans over the DRAWN edge set, not the uncapped relations', async () => {
    // Above the cap, a relation can point at a node that was capped out. The
    // canvas draws no edge for it (both endpoints must survive), so the node
    // is a visible orphan — and the stat must agree with what is drawn.
    const survivors = Array.from({ length: GRAPH_NODE_CAP - 1 }, (_, i) =>
      entity(i + 1, { name: `keep-${i + 1}`, access_count: 100 }));
    const lonely = entity(9000, { name: 'lonely', access_count: 100 });
    const cappedOut = entity(9001, { name: 'capped-partner', access_count: 0 });
    // 1499 survivors + lonely + capped-partner = GRAPH_NODE_CAP + 1 → the
    // access_count-0 partner is exactly the node the cap drops.
    const all = [...survivors, lonely, cappedOut];
    const relations = [
      { from: 'keep-1', to: 'keep-2', type: 'relates-to' },     // both survive → drawn → connected
      { from: 'lonely', to: 'capped-partner', type: 'relates-to' }, // partner capped → not drawn
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: true, data: { entities: all, relations, noiseTypes: [], evidenceCounts: {} } }),
    );
    const { container } = render(<GraphTab />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('graph.cappedNote', {
        shown: GRAPH_NODE_CAP.toLocaleString(getLocale()),
        total: (GRAPH_NODE_CAP + 1).toLocaleString(getLocale()),
      }));
    });
    // Stats row: [entities(total), relations, orphans]. Only keep-1 and
    // keep-2 have a DRAWN edge, so orphans = GRAPH_NODE_CAP - 2. The buggy
    // version counted `lonely` as connected off the raw relation → one fewer.
    const statVals = [...container.querySelectorAll('.stat-val')].map((n) => n.textContent);
    const expectedOrphans = (GRAPH_NODE_CAP - 2).toLocaleString(getLocale());
    const buggyOrphans = (GRAPH_NODE_CAP - 3).toLocaleString(getLocale());
    expect(statVals[2]).toBe(expectedOrphans);
    expect(statVals[2]).not.toBe(buggyOrphans);
  });
});

/* ── ProjectTab: the tri-state before claiming emptiness ─────────────────── */
//
// Migrated from the retired LessonsTab's empty-state suite: the tri-state
// on `health` survived the tab merge and lives in ProjectTab now. The
// LessonsTab cap-note guard (`lessons.capNote`) has NO surviving surface —
// the merged Memories list speaks its truncation through `browse.truncated`,
// pinned above.

describe('ProjectTab empty states', () => {
  it('an empty DATABASE gets the seed entry point', async () => {
    stubMemories([]);
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
    expect(container.textContent).not.toContain(t('project.empty'));
  });

  it('renders neither empty-state while health is still loading (no false-flash)', async () => {
    // health arrives async from App's /v1/health, independent of this tab's
    // own entities fetch. Before it lands, `null?.entity_count === 0` is
    // false — deciding then would flash "no project memories yet" (or the
    // fresh-install screen) over a state nobody has measured yet. The
    // tri-state holds a neutral spinner until health !== null.
    stubMemories([]);
    const { container } = render(<ProjectTab health={null} />);
    // Let the tab's own two fetches (entities + projects) settle first, so
    // this pins the post-load decision, not the initial loading spinner.
    // (Break-tested: with `entity_count: 0` instead of null, EmptyLibraryState
    // is already visible at this exact flush point — so the negative
    // assertions below run against the settled frame, not the initial one.)
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('.loading'), 'a neutral spinner should hold the frame').not.toBeNull();
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
    expect(container.textContent).not.toContain(t('project.empty'));
  });

  it('a populated database with no project tags explains where the story comes from', async () => {
    stubMemories([entity(1)]);
    const { container } = render(<ProjectTab health={{ status: 'ok', version: 't', entity_count: 42 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('project.empty'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
  });
});

/* ── SettingsTab: re-test with the stored key + model visibility ─────────── */

describe('SettingsTab stored-key re-test', () => {
  function stubSettings(posts: Array<{ url: string; body: unknown }>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/config/test')) {
        posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return jsonResponse({ success: true, data: { valid: true, models: [{ id: 'claude-x' }] } });
      }
      if (url.includes('/v1/config')) {
        return jsonResponse({
          success: true,
          data: {
            // Server masks a stored key as '***'.
            config: { llm: { provider: 'anthropic', model: 'claude-x', apiKey: '***' } },
            capabilities: { searchLevel: 1, embeddings: 'ollama', llm: { provider: 'anthropic', model: 'claude-x' } },
          },
        });
      }
      return jsonResponse({ success: true, data: {} });
    });
  }

  it('enables Test with an empty field when a key is stored, and POSTs without apiKey', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    stubSettings(posts);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);

    const testButton = await waitFor(() => {
      const btn = [...container.querySelectorAll('button')]
        .find((b) => b.textContent === t('settings.test')) as HTMLButtonElement | undefined;
      if (!btn) throw new Error('Test button not rendered yet');
      return btn;
    });
    // The dead end this fixes: empty field + stored key used to disable this.
    expect(testButton.disabled).toBe(false);
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(posts.length).toBeGreaterThan(0);
    });
    // Omitting apiKey is the contract: the server then falls back to the
    // stored key. Sending '' would probe with a blank credential instead.
    expect(posts[0].body).not.toHaveProperty('apiKey');
    expect(posts[0].body).toMatchObject({ provider: 'anthropic' });
  });

  it('shows the configured model in the Capabilities card', async () => {
    stubSettings([]);
    const { container } = render(<SettingsTab locale="en" onLocaleChange={() => {}} />);
    await waitFor(() => {
      const stats = [...container.querySelectorAll('.stat-val')].map((n) => n.textContent);
      expect(stats).toContain('claude-x');
    });
  });
});

/* ── InsightsTab: action failures are sentences, not exceptions ──────────── */

describe('InsightsTab action failure routing', () => {
  it('a dead server during accept shows the unreachable sentence', async () => {
    let dead = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (dead) throw new TypeError('Failed to fetch');
      if (method === 'GET' && url.includes('/v1/dream/proposals')) {
        return jsonResponse({
          success: true,
          data: [{
            id: 1, project: 'p', cluster_key: 'k', source_count: 2,
            digest_name: 'd', digest_observations_preview: 'txt',
            status: 'pending', created_at: '2026-08-05 00:00:00', kind: 'digest',
          }],
        });
      }
      return jsonResponse({ success: true, data: { capabilities: { llm: null } } });
    });

    const { container } = render(<InsightsTab />);
    const acceptBtn = await waitFor(() => {
      const btn = [...container.querySelectorAll('button')]
        .find((b) => b.textContent === t('insights.accept')) as HTMLButtonElement | undefined;
      if (!btn) throw new Error('accept button not rendered yet');
      return btn;
    });
    dead = true;
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });

  it('surfaces provider-error skips from a successful Dream envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/dream/run')) {
        return jsonResponse({
          success: true,
          data: {
            proposalsCreated: 0,
            llmCalls: 0,
            skipped: [{ code: 'provider_error', reason: 'LLM call failed: OpenAI API error: 400' }],
          },
        });
      }
      if (url.includes('/v1/dream/proposals')) return jsonResponse({ success: true, data: [] });
      return jsonResponse({ success: true, data: { capabilities: { llm: { provider: 'openai' } } } });
    });

    const { container } = render(<InsightsTab />);
    const run = await waitFor(() => {
      const button = [...container.querySelectorAll('button')]
        .find((entry) => entry.textContent === t('insights.runDream')) as HTMLButtonElement | undefined;
      if (!button) throw new Error('Dream button not rendered');
      return button;
    });
    fireEvent.click(run);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('OpenAI API error: 400');
      expect(alert?.textContent).toContain(t('insights.runProviderError', { error: '' }).split(':')[0]);
    });
  });

  it('keeps zero proposals without provider errors as an honest no-result state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/dream/run')) {
        return jsonResponse({
          success: true,
          data: { proposalsCreated: 0, llmCalls: 1, skipped: [{ reason: 'LLM returned NOOP' }] },
        });
      }
      if (url.includes('/v1/dream/proposals')) return jsonResponse({ success: true, data: [] });
      return jsonResponse({ success: true, data: { capabilities: { llm: { provider: 'openai' } } } });
    });

    const { container } = render(<InsightsTab />);
    const run = await waitFor(() => {
      const button = [...container.querySelectorAll('button')]
        .find((entry) => entry.textContent === t('insights.runDream')) as HTMLButtonElement | undefined;
      if (!button) throw new Error('Dream button not rendered');
      return button;
    });
    fireEvent.click(run);

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('[role="status"]')?.textContent).toContain(t('insights.runNoResult'));
    });
  });

  it('renders the proposal created by a compatible Dream run after success', async () => {
    let dreamRan = false;
    let proposalReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/v1/dream/run')) {
        dreamRan = true;
        return jsonResponse({
          success: true,
          data: { proposalsCreated: 1, llmCalls: 1, skipped: [] },
        });
      }
      if (url.includes('/v1/dream/proposals')) {
        proposalReads += 1;
        return jsonResponse({
          success: true,
          data: dreamRan
            ? [{
                id: 42,
                project: 'dashboard-e2e',
                cluster_key: 'compatible-model',
                source_count: 2,
                digest_name: 'dashboard-e2e-dream-proposal',
                digest_observations_preview: 'Created through the real Dream response path',
                status: 'pending',
                created_at: '2026-08-31 00:00:00',
                kind: 'digest',
              }]
            : [],
        });
      }
      return jsonResponse({ success: true, data: { capabilities: { llm: { provider: 'openai' } } } });
    });

    const { container } = render(<InsightsTab />);
    const run = await waitFor(() => {
      const button = [...container.querySelectorAll('button')]
        .find((entry) => entry.textContent === t('insights.runDream')) as HTMLButtonElement | undefined;
      if (!button) throw new Error('Dream button not rendered');
      return button;
    });
    expect(container.textContent).not.toContain('dashboard-e2e-dream-proposal');

    fireEvent.click(run);

    await waitFor(() => {
      expect(container.textContent).toContain('dashboard-e2e-dream-proposal');
      expect(container.querySelector('[role="status"]')?.textContent)
        .toContain(t('insights.runCreated', { count: 1 }));
    });
    expect(proposalReads).toBeGreaterThanOrEqual(2);
  });
});

/* ── EmptyLibraryState: its own failure surface ──────────────────────────── */

describe('EmptyLibraryState', () => {
  it('surfaces a seed failure as a localized sentence in a live alert', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<EmptyLibraryState />);
    const btn = container.querySelector('button.btn-primary') as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    // finally-block: the button re-enables so the user can retry.
    expect(btn.disabled).toBe(false);
  });
});
