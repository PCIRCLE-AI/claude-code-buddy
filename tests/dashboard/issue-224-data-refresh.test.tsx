// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { ProjectTab } from '../../dashboard/src/components/ProjectTab';
import { GraphTab } from '../../dashboard/src/components/GraphTab';
import { MetricsRow } from '../../dashboard/src/components/MetricsRow';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { App } from '../../dashboard/src/App';
import type { AnalyticsData, Entity, PatternsData, StatsData } from '../../dashboard/src/lib/api';

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function entity(id: number, title: string): Entity {
  return {
    id,
    name: `entity-${id}`,
    title,
    type: 'decision',
    created_at: '2026-08-29T00:00:00.000Z',
    observations: [title],
    tags: ['project:refresh-demo'],
    access_count: 0,
  };
}

function analytics(score: number): AnalyticsData {
  return {
    healthScore: score,
    healthFactors: {
      activity: { score, weight: 0.25 },
      quality: { score, weight: 0.25 },
      freshness: { score, weight: 0.25 },
      lessons: { score, weight: 0.25 },
    },
    criticalLessons: { critical: 0, severityTagged: 1, total: 1 },
    citationCompliance: null,
    loopMetric: { reusedThisWeek: 0, trend: [] },
    timeline: [],
    ageMatrix: [],
    knowledgeRadar: [],
  } as unknown as AnalyticsData;
}

function stats(totalEntities: number): StatsData {
  return {
    totalEntities,
    totalObservations: totalEntities * 2,
    totalRelations: totalEntities * 3,
    totalTags: 1,
    typeDistribution: [],
    tagDistribution: [],
    statusDistribution: [],
  };
}

function patterns(): PatternsData {
  return {
    workSchedule: { hourDistribution: [], dayDistribution: [] },
    focusAreas: [],
    workflow: { commitsPerSession: 0, totalSessions: 0, totalCommits: 0 },
    strengths: [],
    learningAreas: [],
  };
}

function pmAnalytics(decisionsPerWeek: number) {
  return {
    velocity: { decisionsPerWeek, releasesPerMonth: 1, windowDays: 30 },
    staleness: { stalePlanCount: 0, openDecisionCount: 2 },
    connectedness: { orphanRate: 0.25, totalRelations: 12, activeEntities: 20 },
  };
}

function proposal(id: number, text: string) {
  return {
    id,
    project: 'refresh-demo',
    cluster_key: `cluster-${id}`,
    source_count: 2,
    digest_name: text,
    digest_observations_preview: text,
    status: 'pending',
    created_at: '2026-08-29 00:00:00',
    kind: 'digest',
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('issue #224 — one data revision refreshes mounted surfaces', () => {
  it('Memories reloads without recursively broadcasting, and a failed refresh preserves valid rows', async () => {
    let round = 0;
    let fail = false;
    const changed = vi.fn();
    window.addEventListener('memesh:data-changed', changed);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/projects')) return response([]);
      if (url.includes('/v1/entities')) {
        if (fail) throw new TypeError('Failed to fetch');
        round++;
        return response([entity(round, round === 1 ? 'first memory' : 'newest memory')]);
      }
      return response({});
    });

    const view = render(<MemoriesTab dataRevision={0} />);
    await waitFor(() => expect(view.container.textContent).toContain('first memory'));
    expect(changed).not.toHaveBeenCalled();

    view.rerender(<MemoriesTab dataRevision={1} />);
    await waitFor(() => expect(view.container.textContent).toContain('newest memory'));
    expect(changed).not.toHaveBeenCalled();

    fail = true;
    view.rerender(<MemoriesTab dataRevision={2} />);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(view.container.textContent).toContain('newest memory');
    window.removeEventListener('memesh:data-changed', changed);
  });

  it('Memories ignores an older response that resolves after the latest refresh', async () => {
    let resolveOld!: (value: Response) => void;
    let entityRequest = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/projects')) return Promise.resolve(response([]));
      if (url.includes('/v1/entities')) {
        entityRequest++;
        if (entityRequest === 1) return new Promise<Response>((resolve) => { resolveOld = resolve; });
        return Promise.resolve(response([entity(2, 'latest wins')]));
      }
      return Promise.resolve(response({}));
    });

    const view = render(<MemoriesTab dataRevision={0} />);
    view.rerender(<MemoriesTab dataRevision={1} />);
    await waitFor(() => expect(view.container.textContent).toContain('latest wins'));
    resolveOld(response([entity(1, 'stale loses')]));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.container.textContent).not.toContain('stale loses');
  });

  it('Project and Graph refetch their visible datasets when the revision changes', async () => {
    let round = 1;
    let failProject = false;
    let failGraph = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const rows = Array.from({ length: round === 1 ? 5 : 6 }, (_, i) => entity(i + 1, `${round === 1 ? 'old' : 'new'} project ${i}`));
      if (url.includes('/v1/projects')) return response([{ name: 'refresh-demo', count: rows.length }]);
      if (url.includes('/v1/entities')) {
        if (failProject) throw new TypeError('Failed to fetch');
        return response(rows);
      }
      if (url.includes('/v1/graph')) {
        if (failGraph) throw new TypeError('Failed to fetch');
        return response({ entities: rows, relations: [], evidenceCounts: {}, noiseTypes: [] });
      }
      return response({});
    });

    const project = render(<ProjectTab dataRevision={0} health={{ status: 'ok', version: 't', entity_count: 5 }} />);
    await waitFor(() => expect(project.container.textContent).toContain('old project 0'));
    const graph = render(<GraphTab dataRevision={0} />);
    await waitFor(() => expect(graph.container.querySelector('canvas')).not.toBeNull());

    round = 2;
    project.rerender(<ProjectTab dataRevision={1} health={{ status: 'ok', version: 't', entity_count: 6 }} />);
    graph.rerender(<GraphTab dataRevision={1} />);
    await waitFor(() => expect(project.container.textContent).toContain('new project 0'));
    await waitFor(() => expect(graph.container.textContent).toContain('6'));
    expect(project.container.textContent).not.toContain('old project 0');

    failProject = true;
    failGraph = true;
    project.rerender(<ProjectTab dataRevision={2} health={{ status: 'ok', version: 't', entity_count: 6 }} />);
    graph.rerender(<GraphTab dataRevision={2} />);
    await waitFor(() => expect(project.container.querySelector('[role="alert"]')).not.toBeNull());
    await waitFor(() => expect(graph.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(project.container.textContent).toContain('new project 0');
    expect(graph.container.querySelector('canvas')).not.toBeNull();
  });

  it('Home metrics and proposals refetch, and failed metrics refresh retains the last measurement', async () => {
    let round = 1;
    let failMetrics = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/analytics')) {
        if (failMetrics) throw new TypeError('Failed to fetch');
        return response(analytics(round === 1 ? 51 : 91));
      }
      if (url.includes('/v1/dream/proposals')) return response([proposal(round, round === 1 ? 'old proposal' : 'new proposal')]);
      if (url.includes('/v1/config')) return response({ capabilities: { llm: { provider: 'openai' } } });
      return response({});
    });

    const metrics = render(<MetricsRow dataRevision={0} />);
    const insights = render(<InsightsTab dataRevision={0} />);
    await waitFor(() => expect(metrics.container.textContent).toContain('51'));
    await waitFor(() => expect(insights.container.textContent).toContain('old proposal'));

    round = 2;
    metrics.rerender(<MetricsRow dataRevision={1} />);
    insights.rerender(<InsightsTab dataRevision={1} />);
    await waitFor(() => expect(metrics.container.textContent).toContain('91'));
    await waitFor(() => expect(insights.container.textContent).toContain('new proposal'));

    failMetrics = true;
    metrics.rerender(<MetricsRow dataRevision={2} />);
    await waitFor(() => expect(metrics.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(metrics.container.textContent).toContain('91');
  });

  it('Insights ignores a stale proposal response and preserves the latest proposals on refresh failure', async () => {
    let resolveOld!: (value: Response) => void;
    let proposalRequest = 0;
    let fail = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v1/config')) return Promise.resolve(response({ capabilities: { llm: { provider: 'openai' } } }));
      if (url.includes('/v1/dream/proposals')) {
        proposalRequest++;
        if (proposalRequest === 1) return new Promise<Response>((resolve) => { resolveOld = resolve; });
        if (fail) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(response([proposal(2, 'latest proposal wins')]));
      }
      return Promise.resolve(response({}));
    });

    const view = render(<InsightsTab dataRevision={0} />);
    view.rerender(<InsightsTab dataRevision={1} />);
    await waitFor(() => expect(view.container.textContent).toContain('latest proposal wins'));
    resolveOld(response([proposal(1, 'stale proposal loses')]));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.container.textContent).not.toContain('stale proposal loses');

    fail = true;
    view.rerender(<InsightsTab dataRevision={2} />);
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(view.container.textContent).toContain('latest proposal wins');
  });

  it('an opened Home analytics surface refreshes every nested panel and preserves its last data on failure', async () => {
    const counts = new Map<string, number>();
    let failAnalytics = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://dashboard.local').pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (failAnalytics && ['/v1/stats', '/v1/analytics', '/v1/patterns', '/v1/telemetry', '/v1/analytics/pm'].includes(path)) {
        throw new TypeError('Failed to fetch');
      }
      if (path === '/v1/health') return response({ status: 'ok', version: '4.8.1', entity_count: 12 });
      if (path === '/v1/stats') return response(stats(12));
      if (path === '/v1/analytics') return response(analytics(66));
      if (path === '/v1/patterns') return response(patterns());
      if (path === '/v1/telemetry') return response({ window_days: 30, summaries: [] });
      if (path === '/v1/analytics/pm') return response(pmAnalytics(3.5));
      if (path === '/v1/dream/proposals') return response([]);
      if (path === '/v1/config') return response({ capabilities: { llm: null } });
      if (path === '/v1/doctor') return response({ status: 'pass', checks: [] });
      if (path === '/v1/improvements') return response([]);
      return response({});
    });

    const view = render(<App />);
    const analyticsButton = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>('button[aria-controls="home-analytics"]');
      expect(button).not.toBeNull();
      return button!;
    });
    fireEvent.click(analyticsButton);
    await waitFor(() => expect(counts.get('/v1/stats')).toBe(1));
    await waitFor(() => expect(counts.get('/v1/telemetry')).toBe(1));
    await waitFor(() => expect(counts.get('/v1/analytics/pm')).toBe(1));
    expect(view.container.textContent).toContain('3.5');

    const analyticsBefore = counts.get('/v1/analytics') ?? 0;
    const proposalsBefore = counts.get('/v1/dream/proposals') ?? 0;
    const configBefore = counts.get('/v1/config') ?? 0;
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(counts.get('/v1/stats')).toBe(2));
    await waitFor(() => expect(counts.get('/v1/analytics')).toBe(analyticsBefore + 2));
    await waitFor(() => expect(counts.get('/v1/dream/proposals')).toBe(proposalsBefore + 2));
    await waitFor(() => expect(counts.get('/v1/config')).toBe(configBefore + 1));
    await waitFor(() => expect(counts.get('/v1/telemetry')).toBe(2));
    await waitFor(() => expect(counts.get('/v1/analytics/pm')).toBe(2));
    expect(counts.get('/v1/patterns')).toBe(2);

    failAnalytics = true;
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(counts.get('/v1/telemetry')).toBe(3));
    await waitFor(() => expect(view.container.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(3));
    expect(view.container.textContent).toContain('3.5');
    expect(view.container.textContent).toContain('12');
  });

  it('App ignores stale health and keeps the last valid Header value when a later refresh fails', async () => {
    let resolveOld!: (value: Response) => void;
    let healthRequest = 0;
    let fail = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://dashboard.local').pathname;
      if (path === '/v1/health') {
        healthRequest++;
        if (healthRequest === 1) return new Promise<Response>((resolve) => { resolveOld = resolve; });
        if (fail) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(response({ status: 'ok', version: '4.8.1', entity_count: 9 }));
      }
      if (path === '/v1/analytics') return Promise.resolve(response(analytics(70)));
      if (path === '/v1/dream/proposals') return Promise.resolve(response([]));
      if (path === '/v1/config') return Promise.resolve(response({ capabilities: { llm: null } }));
      if (path === '/v1/doctor') return Promise.resolve(response({ status: 'pass', checks: [] }));
      if (path === '/v1/improvements') return Promise.resolve(response([]));
      return Promise.resolve(response({}));
    });

    const view = render(<App />);
    await waitFor(() => expect(healthRequest).toBe(1));
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(view.container.querySelector('.badge-version')?.textContent).toContain('9'));
    resolveOld(response({ status: 'ok', version: '4.8.1', entity_count: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.container.querySelector('.badge-version')?.textContent).toContain('9');

    fail = true;
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());
    expect(view.container.querySelector('.badge-version')?.textContent).toContain('9');
  });

  it('App turns one global mutation event into one new Home and Header revision', async () => {
    const counts = new Map<string, number>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      // This is an HTTP request URL, not a filesystem module URL. Keep the
      // pathname access separate so the repository safety scan can continue
      // rejecting new URL(...).pathname for module-path resolution.
      const requestUrl = new URL(url, 'http://dashboard.local');
      const path = requestUrl.pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === '/v1/health') return response({ status: 'ok', version: '4.8.1', entity_count: 1 });
      if (path === '/v1/analytics') return response(analytics(70));
      if (path === '/v1/dream/proposals') return response([]);
      if (path === '/v1/config') return response({ capabilities: { llm: null } });
      if (path === '/v1/doctor') return response({ status: 'pass', checks: [] });
      if (path === '/v1/improvements') return response([]);
      return response({});
    });

    render(<App />);
    await waitFor(() => expect(counts.get('/v1/health')).toBe(1));
    await waitFor(() => expect(counts.get('/v1/analytics')).toBe(1));
    await waitFor(() => expect(counts.get('/v1/dream/proposals')).toBe(2));
    const proposalsBefore = counts.get('/v1/dream/proposals') ?? 0;
    const configBefore = counts.get('/v1/config') ?? 0;
    window.dispatchEvent(new Event('memesh:data-changed'));
    await waitFor(() => expect(counts.get('/v1/health')).toBe(2));
    await waitFor(() => expect(counts.get('/v1/analytics')).toBe(2));
    await waitFor(() => expect(counts.get('/v1/dream/proposals')).toBe(proposalsBefore + 2));
    expect(counts.get('/v1/config')).toBe(configBefore + 1);
  });
});
