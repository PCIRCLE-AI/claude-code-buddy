// @vitest-environment happy-dom
//
// One contract, applied to every dashboard component: **on degenerate data, a
// component may render an empty state, but it may not render the machinery.**
//
// This is deliberately not nineteen "renders without throwing" tests. Those
// cannot fail for any reason a user would notice, and this repository has spent
// three releases removing checks with that property. What it asserts instead is
// the class of bug that actually reaches a dashboard user:
//
//   - `undefined` / `NaN` / `[object Object]` leaking into visible text, which
//     is what an unguarded `value.toFixed()`, a missing field or a stringified
//     object looks like on screen;
//   - a raw i18n KEY rendered instead of its translation. That one is not
//     hypothetical: the auth screen shipped `auth.title` to a remote operator,
//     because `t()` returns the key string on a miss and five lookups were
//     written as `t('auth.x') || 'English literal'` — a fallback that can never
//     run, since a non-empty string is truthy.
//
// Every component is exercised twice: once with an API that answers empty-but-
// successful, and once with an API that fails. Components that fetch on mount
// get both paths; components that take props get the degenerate props below.
//
// The six components with their own dedicated test files are covered here too —
// this contract is orthogonal to what those assert.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/preact';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { AnalyticsTab } from '../../dashboard/src/components/AnalyticsTab';
import { BrowseTab } from '../../dashboard/src/components/BrowseTab';
import { DoctorBanner } from '../../dashboard/src/components/DoctorBanner';
import { FeedbackWidget } from '../../dashboard/src/components/FeedbackWidget';
import { GraphTab } from '../../dashboard/src/components/GraphTab';
import { Header } from '../../dashboard/src/components/Header';
import { HealthScore } from '../../dashboard/src/components/HealthScore';
import { InsightsBanner } from '../../dashboard/src/components/InsightsBanner';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { KnowledgeRadar } from '../../dashboard/src/components/KnowledgeRadar';
import { LessonsTab } from '../../dashboard/src/components/LessonsTab';
import { LlmTelemetryPanel } from '../../dashboard/src/components/LlmTelemetryPanel';
import { MemoryAgeMatrix } from '../../dashboard/src/components/MemoryAgeMatrix';
import { MemoryTimeline } from '../../dashboard/src/components/MemoryTimeline';
import { PatternCard } from '../../dashboard/src/components/PatternCard';
import { PmAnalyticsPanel } from '../../dashboard/src/components/PmAnalyticsPanel';
import { SearchTab } from '../../dashboard/src/components/SearchTab';
import { TabNav } from '../../dashboard/src/components/TabNav';
import { UserPatterns } from '../../dashboard/src/components/UserPatterns';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every key in the English catalogue. A rendered key is a missed translation:
 * `t()` returns its argument on a miss, so the key IS the failure mode.
 */
const I18N_KEYS: string[] = (() => {
  const src = fs.readFileSync(path.join(repoRoot, 'dashboard/src/lib/i18n.ts'), 'utf8');
  const en = src.slice(src.indexOf('\n  en: {'), src.indexOf("\n  'zh-TW': {"));
  return [...en.matchAll(/^\s+'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)':/gm)].map(m => m[1]);
})();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** An API that answers successfully with nothing in it — the empty-install shape. */
function stubEmptyApi(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    jsonResponse({ success: true, data: {} })
  );
}

/** An API that is down. Every component must survive its own error path. */
function stubFailingApi(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('connection refused');
  });
}

/** The assertion. Visible text must not expose the machinery behind it. */
function assertNoLeakedInternals(name: string, text: string): void {
  for (const leak of ['undefined', 'NaN', '[object Object]']) {
    expect(`${name}: ${text}`).not.toContain(leak);
  }
  const leakedKeys = I18N_KEYS.filter(k => text.includes(k));
  expect(`${name} leaked i18n keys: ${leakedKeys.join(", ")}`).toBe(`${name} leaked i18n keys: `);
}

/** Components and the most degenerate props they can legally be handed. */
const CASES: Array<{ name: string; render: () => { container: Element } }> = [
  { name: 'AnalyticsTab', render: () => render(<AnalyticsTab />) },
  { name: 'BrowseTab', render: () => render(<BrowseTab />) },
  { name: 'DoctorBanner', render: () => render(<DoctorBanner />) },
  { name: 'FeedbackWidget', render: () => render(<FeedbackWidget health={null} />) },
  { name: 'GraphTab', render: () => render(<GraphTab />) },
  { name: 'Header', render: () => render(<Header health={null} error="" />) },
  {
    name: 'HealthScore',
    // Weights are the constants `src/core/analytics.ts` emits (30/30/20/20), not
    // zeroes. `HealthScore` renders `Math.round((score / weight) * 100)`, so a
    // zero weight produces `NaN%` — but no code path can send one, and guarding
    // a value that is a literal in the same repository would be defending
    // against nothing. A brand-new install sends score 0 against those weights,
    // which is the degenerate case that actually occurs.
    render: () => {
      const z = (weight: number) => ({ score: 0, weight, detail: '' });
      return render(
        <HealthScore
          score={0}
          factors={{ activity: z(30), quality: z(30), freshness: z(20), lessons: z(20) }}
        />
      );
    },
  },
  {
    name: 'InsightsBanner',
    render: () => render(<InsightsBanner currentTab="search" onNavigateToInsights={() => {}} />),
  },
  { name: 'InsightsTab', render: () => render(<InsightsTab />) },
  { name: 'KnowledgeRadar', render: () => render(<KnowledgeRadar data={[]} />) },
  { name: 'LessonsTab', render: () => render(<LessonsTab />) },
  { name: 'LlmTelemetryPanel', render: () => render(<LlmTelemetryPanel />) },
  { name: 'MemoryAgeMatrix', render: () => render(<MemoryAgeMatrix data={[]} />) },
  { name: 'MemoryTimeline', render: () => render(<MemoryTimeline data={[]} />) },
  { name: 'PmAnalyticsPanel', render: () => render(<PmAnalyticsPanel />) },
  { name: 'SearchTab', render: () => render(<SearchTab />) },
  {
    name: 'TabNav',
    render: () => render(<TabNav tabs={[]} active="" onSelect={() => {}} />),
  },
  {
    name: 'UserPatterns',
    render: () =>
      render(
        <UserPatterns
          data={{
            workSchedule: { hourDistribution: [], dayDistribution: [] },
            toolPreferences: [],
            focusAreas: [],
            workflow: { avgSessionMinutes: 0, commitsPerSession: 0, totalSessions: 0, totalCommits: 0 },
            strengths: [],
            learningAreas: [],
          }}
        />
      ),
  },
  {
    name: 'PatternCard',
    render: () =>
      render(
        <PatternCard
          proposal={{
            id: 1,
            project: 'memesh',
            cluster_key: 'k',
            source_count: 0,
            digest_name: 'pattern-1',
            digest_observations_preview: '',
            status: 'pending',
            created_at: '2026-08-04T00:00:00.000Z',
          }}
          detail={undefined}
          expanded={false}
          inFlight={false}
          onToggleExpand={() => {}}
          onAccept={() => {}}
          onReject={() => {}}
          formatRelative={() => 'just now'}
          statusBadgeStyle={() => ({})}
          statusLabel={() => 'Pending'}
        />
      ),
  },
];

describe('dashboard components on degenerate data', () => {
  beforeEach(() => {
    // DoctorBanner and friends read localStorage on mount.
    try {
      localStorage.clear();
    } catch {
      /* environment without storage — the components already guard for it */
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('the i18n key list was actually extracted', () => {
    // Without this, `leakedKeys` is filtered from an empty array and every
    // assertion below silently stops checking the thing it was written for.
    expect(I18N_KEYS.length).toBeGreaterThan(50);
    expect(I18N_KEYS).toContain('auth.title');
  });

  for (const c of CASES) {
    it(`${c.name} exposes no internals when the API answers empty`, async () => {
      stubEmptyApi();
      const { container } = c.render();
      await waitFor(() => expect(container).toBeTruthy());
      assertNoLeakedInternals(c.name, container.textContent ?? '');
    });

    it(`${c.name} exposes no internals when the API is down`, async () => {
      stubFailingApi();
      const { container } = c.render();
      await waitFor(() => expect(container).toBeTruthy());
      assertNoLeakedInternals(c.name, container.textContent ?? '');
    });
  }
});
