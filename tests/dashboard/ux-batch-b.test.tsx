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
//   4. Silent truncation is spoken: Browse at its 2000-row fetch limit names
//      the real total; the Graph's node cap names what it kept.
//
// All network is stubbed — nothing here touches ~/.memesh or any config.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { api, HttpError, NetworkError, type Entity } from '../../dashboard/src/lib/api';
import { actionFailureMessage } from '../../dashboard/src/lib/failure';
import { t } from '../../dashboard/src/lib/i18n';
import { SearchTab } from '../../dashboard/src/components/SearchTab';
import { BrowseTab } from '../../dashboard/src/components/BrowseTab';
import { GraphTab, capGraphEntities, GRAPH_NODE_CAP } from '../../dashboard/src/components/GraphTab';
import { LessonsTab } from '../../dashboard/src/components/LessonsTab';
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
    // 'decision' sits in the knowledge cluster — the default filter when
    // Signal Mode is on — so list-visibility assertions see these rows.
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

/* ── SearchTab: dead server ──────────────────────────────────────────────── */

describe('SearchTab against a dead server', () => {
  it('shows the localized unreachable sentence, never "Failed to fetch"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<SearchTab />);
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'auth' } });
    const button = container.querySelector('button.btn-primary') as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert, 'error box should render').not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
  });
});

/* ── BrowseTab: empty database vs filter-matched-nothing ─────────────────── */

function stubBrowse(entities: Entity[], entityCount?: number) {
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

describe('BrowseTab empty-state awareness', () => {
  it('an empty database shows the seed entry point, not "try a different filter"', async () => {
    stubBrowse([]);
    const { container } = render(<BrowseTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
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
    stubBrowse([entity(1)]);
    const { container } = render(<BrowseTab health={{ status: 'ok', version: 't', entity_count: 1 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain('entity-1');
    });
    const filterInput = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.input(filterInput, { target: { value: 'zzz-no-match' } });
    await waitFor(() => {
      expect(container.textContent).toContain(t('browse.noMatch'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
  });

  it('names the truncation when the fetch limit is hit and the library is larger', async () => {
    const full = Array.from({ length: 2000 }, (_, i) => entity(i + 1));
    stubBrowse(full, 5000);
    const { container } = render(<BrowseTab health={{ status: 'ok', version: 't', entity_count: 5000 }} />);
    const expected = t('browse.truncated', {
      shown: (2000).toLocaleString('en'),
      total: (5000).toLocaleString('en'),
    });
    await waitFor(() => {
      expect(container.textContent).toContain(expected);
    });
  });

  it('says nothing about truncation when the fetch got everything', async () => {
    stubBrowse([entity(1), entity(2)], 2);
    const { container } = render(<BrowseTab health={{ status: 'ok', version: 't', entity_count: 2 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain('entity-1');
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
      jsonResponse({ success: true, data: { entities: many, relations: [], noiseTypes: [] } }),
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: true, data: { entities: [], relations: [], noiseTypes: [] } }),
    );
    const { container } = render(<GraphTab />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
    expect(container.querySelector('canvas')).toBeNull();
  });
});

/* ── LessonsTab: empty guidance + cap note ───────────────────────────────── */

function stubLessons(lessons: Entity[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/projects')) return jsonResponse({ success: true, data: [] });
    return jsonResponse({ success: true, data: lessons });
  });
}

describe('LessonsTab empty states', () => {
  it('an empty DATABASE gets the seed entry point', async () => {
    stubLessons([]);
    const { container } = render(<LessonsTab health={{ status: 'ok', version: 't', entity_count: 0 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('emptyLibrary.title'));
    });
  });

  it('a populated database with zero lessons explains where lessons come from', async () => {
    stubLessons([]);
    const { container } = render(<LessonsTab health={{ status: 'ok', version: 't', entity_count: 42 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('lessons.emptyGuide'));
    });
    expect(container.textContent).not.toContain(t('emptyLibrary.title'));
  });

  it('notes the fetch cap when exactly the limit came back', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) =>
      entity(i + 1, { type: 'lesson_learned' }));
    stubLessons(hundred);
    const { container } = render(<LessonsTab health={{ status: 'ok', version: 't', entity_count: 400 }} />);
    await waitFor(() => {
      expect(container.textContent).toContain(t('lessons.capNote', { limit: 100 }));
    });
  });

  it('routes a dead server through the classified sentence', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = render(<LessonsTab />);
    await waitFor(() => {
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain(unreachableSentence);
    });
    expect(container.textContent).not.toContain('Failed to fetch');
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
            capabilities: { searchLevel: 1, embeddings: 'onnx', llm: { provider: 'anthropic', model: 'claude-x' } },
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
