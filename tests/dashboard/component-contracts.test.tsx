// @vitest-environment happy-dom
//
// One contract, applied to the dashboard components listed below: **on
// degenerate data, a component may render an empty state, but it may not render
// the machinery, drop half the page, or reject into nowhere.**
//
// This is deliberately not nineteen "renders without throwing" tests. Those
// cannot fail for any reason a user would notice, and this repository has spent
// three releases removing checks with that property. What it asserts instead is
// the class of bug that actually reaches a dashboard user, and it takes three
// separate detectors because the three shapes each slip past the other two:
//
//   1. **Text leak.** `undefined` / `NaN` / `[object Object]` in visible text —
//      what an unguarded `value.toFixed()`, a missing field or a stringified
//      object looks like on screen — or a raw i18n KEY rendered instead of its
//      translation. That last one is not hypothetical: the auth screen shipped
//      `auth.title` to a remote operator, because `t()` returns the key on a
//      miss and five lookups were written `t('auth.x') || 'English literal'`, a
//      fallback that can never run since a non-empty string is truthy.
//   2. **Unhandled rejection.** A component with no `.catch` whose loader
//      throws.
//   3. **Render error.** A throw during the rerender that a promise callback
//      triggered. Measured: this produces NO unhandled rejection and NO text —
//      `AnalyticsTab` handed `{healthFactors:{}, loopMetric:{}, timeline:{}}`
//      silently drops four panels and leaves only the stats row. Detectors 1
//      and 2 are both blind to it; a recording error boundary is not.
//
// Every component is exercised against four API stubs: empty-but-successful, a
// failure, half a payload, and every group present but hollow. Components that
// take props get the degenerate props below.
//
// ## Why the three canaries exist
//
// The first version of this file waited with `waitFor(() => expect(container)
// .toBeTruthy())`. `container` is truthy the instant `render()` returns, so
// that wait resolved on its first synchronous check and **every assertion ran
// before the stubbed response arrived**. Measured: reverting three of the six
// guards this suite was written to protect left all 58 tests passing, and
// `GraphTab` — a live, unmutated instance of the leak in (1) — passed 3/3 while
// rendering `Cannot read properties of undefined`.
//
// Replacing the wait fixes today's instance. It does not stop the wait from
// rotting again, and neither would a per-component list of settled predicates:
// a hand-maintained list is the thing that drifted in the first place. So the
// three canaries below assert the harness's **ability to fail** — one per
// detector. If `settle()` ever stops settling, the canaries stop being caught
// and this file goes red on itself.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { Component } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
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
const COMPONENT_DIR = 'dashboard/src/components';

/**
 * Every key in the English catalogue. A rendered key is a missed translation:
 * `t()` returns its argument on a miss, so the key IS the failure mode.
 */
const I18N_KEYS: string[] = (() => {
  const src = fs.readFileSync(path.join(repoRoot, 'dashboard/src/lib/i18n.ts'), 'utf8');
  const en = src.slice(src.indexOf('\n  en: {'), src.indexOf("\n  'zh-TW': {"));
  return [...en.matchAll(/^\s+'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)':/gm)].map(m => m[1]);
})();

/* ------------------------------------------------------------------ *
 * Detectors                                                           *
 * ------------------------------------------------------------------ */

/** Unhandled rejections observed during the current test, in order. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };

/** Render errors caught by the boundary each case is mounted inside. */
let caught: unknown[] = [];

/**
 * Records instead of recovering.
 *
 * The application ships **no** error boundary — `grep -rn "componentDidCatch"
 * dashboard/src` is empty — so in production a render error here is a white
 * screen. This boundary exists only so the test can see the error at all;
 * asserting `caught` is empty is asserting the white screen never happens.
 */
class Recorder extends Component<{ children: ComponentChildren }> {
  componentDidCatch(err: unknown): void { caught.push(err); }
  render() { return this.props.children; }
}

/* ------------------------------------------------------------------ *
 * Settling                                                            *
 * ------------------------------------------------------------------ */

/**
 * Promises the stubbed `fetch` has handed out and that nothing has awaited yet.
 * `settle()` drains this rather than waiting a fixed number of milliseconds.
 */
const pendingResponses: Promise<unknown>[] = [];

/**
 * Run every promise chain the render kicked off to completion.
 *
 * `api()` is `await fetch(...)` then `await res.json()`, so one call is a small,
 * bounded number of microtask hops followed by Preact's rerender. Draining the
 * recorded promises and then yielding the microtask queue is therefore a
 * *deterministic* wait: nothing here depends on how fast the machine is, which
 * is the whole objection to `setTimeout(50)`. The pass limit is a runaway guard
 * for a component that re-fetches forever, not a duration guess.
 *
 * The final hop is a macrotask on purpose: Node reports `unhandledRejection` at
 * a macrotask boundary, so detector 2 cannot see anything until one turn has
 * elapsed. `setImmediate` is a turn boundary, not a sleep.
 */
async function settle(): Promise<void> {
  await act(async () => {
    let quiet = 0;
    for (let pass = 0; pass < 25 && quiet < 3; pass++) {
      const batch = pendingResponses.splice(0);
      if (batch.length === 0) quiet++;
      else quiet = 0;
      await Promise.allSettled(batch);
      await Promise.resolve();
    }
  });
  await new Promise<void>(resolve => setImmediate(resolve));
}

/* ------------------------------------------------------------------ *
 * API stubs                                                           *
 * ------------------------------------------------------------------ */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Install a `fetch` double whose promises `settle()` can wait on. */
function stubApi(respond: () => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
    const p = (async () => respond())();
    pendingResponses.push(p.catch(() => undefined));
    return p;
  }) as typeof globalThis.fetch);
}

/** An API that answers successfully with nothing in it. */
function stubEmptyApi(): void {
  stubApi(() => jsonResponse({ success: true, data: {} }));
}

/** An API that is down. Every component must survive its own error path. */
function stubFailingApi(): void {
  stubApi(() => { throw new Error('connection refused'); });
}

/**
 * An API that answers with SOME of the payload — the version-skew shape.
 *
 * Note what this is NOT: it is not what a fresh install returns.
 * `computeAnalytics` and `computePmAnalytics` (`src/core/analytics.ts`) both
 * return every key unconditionally, so a brand-new database yields
 * `healthScore: 0` and `summaries: []`, which pass every guard. The reachable
 * causes are a stale cached bundle, a proxy rewriting the body, and a future
 * partial-failure path.
 *
 * The scalars below are deliberately populated and every array/object group is
 * deliberately absent: that is the combination that survives a truthiness check
 * and then throws on the first `.filter` / `.map` / nested read.
 */
function stubPartialApi(): void {
  stubApi(() => jsonResponse({
    success: true,
    data: {
      totalEntities: 3,
      totalObservations: 7,
      totalRelations: 1,
      totalTags: 2,
      healthScore: 42,
      connectedness: { orphanRate: 0.1, totalRelations: 1 },
    },
  }));
}

/**
 * Every top-level key present, every group hollow.
 *
 * `{}` is truthy, so this is the payload that survives a guard written as
 * `a.healthFactors && a.loopMetric && a.timeline` and then throws one level
 * down, inside the child the group was handed to. Measured against the
 * pre-fix `AnalyticsTab`: two render errors, zero unhandled rejections, zero
 * leaked text, four panels silently gone.
 */
function stubHollowApi(): void {
  stubApi(() => jsonResponse({
    success: true,
    data: {
      totalEntities: 3, totalObservations: 7, totalRelations: 1, totalTags: 2,
      typeDistribution: [], tagDistribution: [], statusDistribution: [],
      healthScore: 42, healthFactors: {}, loopMetric: {}, timeline: {},
      ageMatrix: {}, knowledgeRadar: {},
      velocity: {}, staleness: {}, connectedness: {},
      entities: {}, relations: {}, noiseTypes: {},
      summaries: {}, window_days: 7,
      checks: {},
      workSchedule: {}, toolPreferences: {}, focusAreas: {}, workflow: {},
      strengths: {}, learningAreas: {},
    },
  }));
}

/**
 * The core of each payload valid, the optional extras hollow.
 *
 * This is the shape a guard is *right* to let through: `AnalyticsTab` treats
 * `ageMatrix` / `knowledgeRadar` as optional and coerces them at the point of
 * use rather than blanking the whole tab, so a server that implements the main
 * metrics and not those two must still render. Without this stub that coercion
 * is unreachable — measured: replacing it with `?? []` broke nothing, because
 * `stubHollowApi` never gets past the analytics guard.
 */
function stubOptionalExtrasHollowApi(): void {
  const factor = { score: 1, weight: 30, detail: '' };
  stubApi(() => jsonResponse({
    success: true,
    data: {
      totalEntities: 3, totalObservations: 7, totalRelations: 1, totalTags: 2,
      typeDistribution: [], tagDistribution: [], statusDistribution: [],
      healthScore: 42,
      healthFactors: { activity: factor, quality: factor, freshness: factor, lessons: factor },
      loopMetric: { reusedThisWeek: 0, trend: [], computedFrom: 'recall_hits' },
      timeline: [],
      // The two the component is allowed to tolerate — hollow, not absent.
      ageMatrix: {}, knowledgeRadar: {},
      workSchedule: { hourDistribution: [], dayDistribution: [] },
      toolPreferences: [], focusAreas: [], strengths: [], learningAreas: [],
      workflow: { avgSessionMinutes: 0, commitsPerSession: 0, totalSessions: 0, totalCommits: 0 },
      velocity: { decisionsPerWeek: 0, releasesPerMonth: 0, windowDays: 30 },
      staleness: { stalePlanCount: 0, openDecisionCount: 0 },
      connectedness: { orphanRate: 0, totalRelations: 0, activeEntities: 0 },
      summaries: [], window_days: 7,
      entities: [], relations: [], noiseTypes: [],
      checks: [],
    },
  }));
}

const STUBS: Array<{ label: string; install: () => void }> = [
  { label: 'answers empty', install: stubEmptyApi },
  { label: 'is down', install: stubFailingApi },
  { label: 'answers with half a payload', install: stubPartialApi },
  { label: 'answers with every group present but hollow', install: stubHollowApi },
  { label: 'answers with the core valid and the optional extras hollow', install: stubOptionalExtrasHollowApi },
];

/* ------------------------------------------------------------------ *
 * The assertion                                                       *
 * ------------------------------------------------------------------ */

/** Visible text must not expose the machinery behind it. */
function assertNoLeakedInternals(name: string, text: string): void {
  for (const leak of ['undefined', 'NaN', '[object Object]']) {
    expect(`${name}: ${text}`).not.toContain(leak);
  }
  const leakedKeys = I18N_KEYS.filter(k => text.includes(k));
  expect(`${name} leaked i18n keys: ${leakedKeys.join(", ")}`).toBe(`${name} leaked i18n keys: `);
}

/* ------------------------------------------------------------------ *
 * Cases                                                               *
 * ------------------------------------------------------------------ */

/** Components and the most degenerate props they can legally be handed. */
const CASES: Array<{ name: string; node: () => ComponentChildren }> = [
  { name: 'AnalyticsTab', node: () => <AnalyticsTab /> },
  { name: 'BrowseTab', node: () => <BrowseTab /> },
  { name: 'DoctorBanner', node: () => <DoctorBanner /> },
  { name: 'FeedbackWidget', node: () => <FeedbackWidget health={null} /> },
  { name: 'GraphTab', node: () => <GraphTab /> },
  { name: 'Header', node: () => <Header health={null} error="" /> },
  {
    name: 'HealthScore',
    // Weights are the constants `src/core/analytics.ts` emits (30/30/20/20), not
    // zeroes. `HealthScore` renders `Math.round((score / weight) * 100)`, so a
    // zero weight produces `NaN%` — but no code path can send one, and guarding
    // a value that is a literal in the same repository would be defending
    // against nothing. A brand-new install sends score 0 against those weights,
    // which is the degenerate case that actually occurs.
    node: () => {
      const z = (weight: number) => ({ score: 0, weight, detail: '' });
      return (
        <HealthScore
          score={0}
          factors={{ activity: z(30), quality: z(30), freshness: z(20), lessons: z(20) }}
        />
      );
    },
  },
  {
    name: 'InsightsBanner',
    node: () => <InsightsBanner currentTab="search" onNavigateToInsights={() => {}} />,
  },
  { name: 'InsightsTab', node: () => <InsightsTab /> },
  { name: 'KnowledgeRadar', node: () => <KnowledgeRadar data={[]} /> },
  { name: 'LessonsTab', node: () => <LessonsTab /> },
  { name: 'LlmTelemetryPanel', node: () => <LlmTelemetryPanel /> },
  { name: 'MemoryAgeMatrix', node: () => <MemoryAgeMatrix data={[]} /> },
  { name: 'MemoryTimeline', node: () => <MemoryTimeline data={[]} /> },
  { name: 'PmAnalyticsPanel', node: () => <PmAnalyticsPanel /> },
  { name: 'SearchTab', node: () => <SearchTab /> },
  { name: 'TabNav', node: () => <TabNav tabs={[]} active="" onSelect={() => {}} /> },
  {
    name: 'UserPatterns',
    node: () => (
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
    node: () => (
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

/**
 * Components deliberately outside `CASES`, each with the reason.
 *
 * This list exists so that "not covered" is a decision somebody wrote down
 * rather than an omission nobody noticed — the previous version of this file
 * claimed in its own header that the six components with dedicated test files
 * were "covered here too", when they were exactly the six that were missing.
 */
const INTENTIONALLY_EXCLUDED: Record<string, string> = {
  AuthPrompt: 'tests/dashboard/AuthPrompt.test.tsx — rendered only from a 401 path, takes no API-backed props',
  MemoryLoopCard: 'tests/dashboard/MemoryLoopCard.test.tsx covers its degenerate inputs directly',
  MemoryRow: 'tests/dashboard/MemoryRow.test.tsx covers its degenerate inputs directly',
  OnboardingBanner: 'tests/dashboard/OnboardingBanner.test.tsx covers its degenerate inputs directly',
  ProjectRoadmap: 'tests/dashboard/ProjectRoadmap.test.tsx covers its degenerate inputs directly',
  SettingsTab: 'has unguarded reads of `data.config` and `config.config`; adding it here is blocked on fixing those, not on writing the case',
};

/* ------------------------------------------------------------------ *
 * Canaries — one per detector, asserting the harness can still fail   *
 * ------------------------------------------------------------------ */

/**
 * A payload with a field missing, obtained the way the real ones are.
 *
 * `JSON.parse` rather than an object literal on purpose. Writing
 * `undefined as unknown as T` makes the defect statically provable — CodeQL
 * raised `js/property-access-on-non-object`, "the base expression of this
 * property access is always undefined", and it was right. A canary has to be a
 * runtime failure, not a typo a static analyser can fold away, or it stops
 * standing in for the thing it represents: a response that parsed fine and did
 * not contain the field.
 */
function parsedWithout<T>(json: string): T {
  return JSON.parse(json) as T;
}

/** Leaks `undefined` into text, never rejects, never throws. Detector 1 only. */
function LeakyCanary() {
  const partial = parsedWithout<{ missing?: string }>('{}');
  return <div>{`value: ${partial.missing}`}</div>;
}

/** Rejects from an effect and renders fine. Detector 2 only. */
function RejectingCanary() {
  useEffect(() => {
    void Promise.resolve().then(() => {
      const payload = parsedWithout<{ group: { boom: () => void } }>('{}');
      payload.group.boom();
    });
  }, []);
  return <div>fine</div>;
}

/**
 * Throws during the rerender that "data arriving" triggers. No rejection, no
 * text. Detector 3 only.
 *
 * It mounts cleanly first on purpose. Measured: Preact's `componentDidCatch`
 * does **not** catch a throw from the initial synchronous mount — that one
 * propagates straight out of `render()` — and a canary that threw on mount
 * would therefore be testing a path no real component takes. Every component
 * here renders a loading state, then rerenders with the response, and it is
 * that second pass which throws.
 */
function CrashingCanary() {
  const [loaded, setLoaded] = useState(false);
  // Deferred by a microtask, exactly like a response arriving. A bare
  // `setLoaded(true)` in the effect body rerenders inside `render()`'s own act
  // flush, and that throw escapes the boundary the same way a mount-time throw
  // does — which would make this canary test a path no component takes.
  useEffect(() => { void Promise.resolve().then(() => setLoaded(true)); }, []);
  const hollow = parsedWithout<{ rows: number[] }>('{}');
  return <div>{loaded ? hollow.rows.map(n => <span>{n}</span>) : 'loading'}</div>;
}

/* ------------------------------------------------------------------ *
 * Suite                                                               *
 * ------------------------------------------------------------------ */

describe('dashboard components on degenerate data', () => {
  beforeEach(() => {
    // DoctorBanner and friends read localStorage on mount.
    try {
      localStorage.clear();
    } catch {
      /* environment without storage — the components already guard for it */
    }
    unhandled = [];
    caught = [];
    pendingResponses.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    // `@testing-library/preact` only auto-registers cleanup when `afterEach` is
    // a global, and this project does not set `test.globals`. Without this call
    // every rendered tree stays mounted with live effects, so a rejection from
    // one test lands during the next and `unhandled` blames the wrong component.
    cleanup();
    vi.restoreAllMocks();
  });

  it('the i18n key list was actually extracted', () => {
    // Without this, `leakedKeys` is filtered from an empty array and every
    // assertion below silently stops checking the thing it was written for.
    expect(I18N_KEYS.length).toBeGreaterThan(50);
    expect(I18N_KEYS).toContain('auth.title');
  });

  it('every component on disk is either covered or explicitly excluded', () => {
    // Derived from the directory, not from a sentence in a comment. A component
    // added tomorrow fails here until somebody decides which side it is on.
    const onDisk = fs
      .readdirSync(path.join(repoRoot, COMPONENT_DIR))
      .filter(f => f.endsWith('.tsx'))
      .map(f => f.replace(/\.tsx$/, ''))
      .sort();
    expect(onDisk.length).toBeGreaterThan(20);

    const accounted = new Set([...CASES.map(c => c.name), ...Object.keys(INTENTIONALLY_EXCLUDED)]);
    expect(onDisk.filter(n => !accounted.has(n))).toEqual([]);

    // And the reverse, so a deleted component does not leave a stale exemption
    // behind that quietly excuses a future component of the same name.
    const diskSet = new Set(onDisk);
    expect(Object.keys(INTENTIONALLY_EXCLUDED).filter(n => !diskSet.has(n))).toEqual([]);
    expect(CASES.map(c => c.name).filter(n => !diskSet.has(n))).toEqual([]);
  });

  describe('the contract itself can fail', () => {
    it('detector 1 catches a text leak that neither rejects nor throws', async () => {
      stubEmptyApi();
      const { container } = render(<Recorder><LeakyCanary /></Recorder>);
      await settle();
      expect(unhandled).toEqual([]);
      expect(caught).toEqual([]);
      expect(() => assertNoLeakedInternals('LeakyCanary', container.textContent ?? '')).toThrow();
    });

    it('detector 2 catches a rejection that leaks no text', async () => {
      stubEmptyApi();
      const { container } = render(<Recorder><RejectingCanary /></Recorder>);
      await settle();
      expect(caught).toEqual([]);
      assertNoLeakedInternals('RejectingCanary', container.textContent ?? '');
      expect(unhandled.length).toBeGreaterThan(0);
    });

    it('detector 3 catches a render error that neither leaks text nor rejects', async () => {
      stubEmptyApi();
      const { container } = render(<Recorder><CrashingCanary /></Recorder>);
      await settle();
      expect(unhandled).toEqual([]);
      assertNoLeakedInternals('CrashingCanary', container.textContent ?? '');
      expect(caught.length).toBeGreaterThan(0);
    });
  });

  for (const c of CASES) {
    for (const stub of STUBS) {
      it(`${c.name} survives an API that ${stub.label}`, async () => {
        // The previous test must have unmounted. Without `cleanup()` in
        // `afterEach` every tree stays live, and a rejection from one test then
        // lands during the next — the detectors would blame the wrong
        // component. This is the assertion that makes that cleanup call
        // something more than a comment.
        expect(document.body.childElementCount).toBe(0);
        stub.install();
        const { container } = render(<Recorder>{c.node()}</Recorder>);
        await settle();
        expect(caught.map(String)).toEqual([]);
        expect(unhandled.map(String)).toEqual([]);
        assertNoLeakedInternals(c.name, container.textContent ?? '');
      });
    }
  }
});
