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
import { render, cleanup, act, fireEvent } from '@testing-library/preact';
import { Component } from 'preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { t, setLocale } from '../../dashboard/src/lib/i18n';
import { App } from '../../dashboard/src/App';
import {
  AnalyticsTab,
  isAnalyticsRenderable,
  isPatternsRenderable,
  isStatsRenderable,
} from '../../dashboard/src/components/AnalyticsTab';
import { isGraphRenderable } from '../../dashboard/src/components/GraphTab';
import { isPmAnalyticsRenderable } from '../../dashboard/src/components/PmAnalyticsPanel';
import { Chip } from '../../dashboard/src/components/Chip';
import { DoctorBanner } from '../../dashboard/src/components/DoctorBanner';
import { EmptyLibraryState } from '../../dashboard/src/components/EmptyLibraryState';
import { FeedbackWidget } from '../../dashboard/src/components/FeedbackWidget';
import { GraphTab } from '../../dashboard/src/components/GraphTab';
import { Header } from '../../dashboard/src/components/Header';
import { HealthScore } from '../../dashboard/src/components/HealthScore';
import { HomeTab } from '../../dashboard/src/components/HomeTab';
import { InsightsBanner } from '../../dashboard/src/components/InsightsBanner';
import { InsightsTab } from '../../dashboard/src/components/InsightsTab';
import { KnowledgeRadar } from '../../dashboard/src/components/KnowledgeRadar';
import { LlmTelemetryPanel } from '../../dashboard/src/components/LlmTelemetryPanel';
import { MemoriesTab } from '../../dashboard/src/components/MemoriesTab';
import { MemoryAgeMatrix } from '../../dashboard/src/components/MemoryAgeMatrix';
import { MemoryTimeline } from '../../dashboard/src/components/MemoryTimeline';
import { PatternCard } from '../../dashboard/src/components/PatternCard';
import { PmAnalyticsPanel } from '../../dashboard/src/components/PmAnalyticsPanel';
import { ProjectTab } from '../../dashboard/src/components/ProjectTab';
import {
  SettingsTab,
  isConfigRenderable,
  isUpdateStatusRenderable,
} from '../../dashboard/src/components/SettingsTab';
import { TabNav } from '../../dashboard/src/components/TabNav';
import { UserPatterns } from '../../dashboard/src/components/UserPatterns';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPONENT_DIR = 'dashboard/src/components';

/**
 * Every key in the English catalogue. A rendered key is a missed translation:
 * `t()` returns its argument on a miss, so the key IS the failure mode.
 */
const EN: Map<string, string> = (() => {
  const src = fs.readFileSync(path.join(repoRoot, 'dashboard/src/lib/i18n.ts'), 'utf8');
  const en = src.slice(src.indexOf('\n  en: {'), src.indexOf("\n  'zh-TW': {"));
  const out = new Map<string, string>();
  for (const m of en.matchAll(/^\s+'([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9.]+)':\s*'((?:[^'\\]|\\.)*)'/gm)) {
    out.set(m[1], m[2]);
  }
  return out;
})();

const I18N_KEYS: string[] = [...EN.keys()];

/** The English text a key renders as, or a loud failure if the key is gone. */
function en(key: string): string {
  const value = EN.get(key);
  if (!value) throw new Error(`expected i18n key ${key} is not in the English catalogue`);
  return value;
}

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

/**
 * An API that is down. A real fetch signals a network failure as a
 * TypeError — and api() classifies on exactly that, so a stub throwing a
 * plain Error would be a failure shape no browser produces and would land
 * in the wrong classification branch.
 */
function stubFailingApi(): void {
  stubApi(() => { throw new TypeError('Failed to fetch'); });
}

/**
 * A server that is UP and answering 500s. The request "failed", but sending
 * the user to check `memesh serve` would point at a process that is
 * demonstrably running — this must classify as unreadable, not unreachable.
 */
function stubErroringApi(): void {
  stubApi(() => new Response('{"success":false,"error":"boom"}', { status: 500 }));
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
 * The fields below are the ones a guard is TEMPTED to stop at, and nothing
 * more. `totalEntities` plus `tagDistribution` was the exact extent of
 * `AnalyticsTab`'s stats guard, and the stats row reads three more scalars —
 * `totalObservations.toLocaleString()` and friends — so this payload is the
 * one that survived that guard and threw three reads later. The earlier
 * version of this stub populated all four scalars, which made a
 * two-leaf guard and a five-leaf guard indistinguishable: the fix to the
 * guard was unreachable dead code until this stub stopped handing it the
 * fields it forgot to check.
 */
function stubPartialApi(): void {
  stubApi(() => jsonResponse({
    success: true,
    data: {
      totalEntities: 3,
      tagDistribution: [],
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

const STUBS: Array<{ label: string; install: () => void; positive?: true }> = [
  { label: 'answers empty', install: stubEmptyApi },
  { label: 'is down', install: stubFailingApi },
  { label: 'answers with half a payload', install: stubPartialApi },
  { label: 'answers with every group present but hollow', install: stubHollowApi },
  // The only stub where every component is supposed to render for real, so the
  // only one the positive half of the contract can be asserted against.
  { label: 'answers with the core valid and the optional extras hollow', install: stubOptionalExtrasHollowApi, positive: true },
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
  { name: 'Chip', node: () => <Chip label="" active={false} onClick={() => {}} /> },
  { name: 'DoctorBanner', node: () => <DoctorBanner /> },
  { name: 'EmptyLibraryState', node: () => <EmptyLibraryState /> },
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
  { name: 'HomeTab', node: () => <HomeTab /> },
  {
    name: 'InsightsBanner',
    node: () => <InsightsBanner currentTab="Memories" onNavigateToInsights={() => {}} />,
  },
  { name: 'InsightsTab', node: () => <InsightsTab /> },
  { name: 'KnowledgeRadar', node: () => <KnowledgeRadar data={[]} /> },
  { name: 'LlmTelemetryPanel', node: () => <LlmTelemetryPanel /> },
  { name: 'MemoriesTab', node: () => <MemoriesTab /> },
  { name: 'MemoryAgeMatrix', node: () => <MemoryAgeMatrix data={[]} /> },
  { name: 'MemoryTimeline', node: () => <MemoryTimeline data={[]} /> },
  { name: 'PmAnalyticsPanel', node: () => <PmAnalyticsPanel /> },
  { name: 'ProjectTab', node: () => <ProjectTab /> },
  { name: 'SettingsTab', node: () => <SettingsTab locale="en" onLocaleChange={() => {}} /> },
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
  LessonCards: 'helper renderers (severity badge, expanded bodies) with no top-level surface — exercised through MemoriesTab rows',
  MemoryLoopCard: 'tests/dashboard/MemoryLoopCard.test.tsx covers its degenerate inputs directly',
  MemoryRow: 'tests/dashboard/MemoryRow.test.tsx covers its degenerate inputs directly',
  OnboardingBanner: 'tests/dashboard/OnboardingBanner.test.tsx covers its degenerate inputs directly',
  ProjectRoadmap: 'tests/dashboard/ProjectRoadmap.test.tsx covers its degenerate inputs directly',
};

/* ------------------------------------------------------------------ *
 * The positive half of the contract                                   *
 * ------------------------------------------------------------------ */

/**
 * What each component must actually RENDER when the API answers with a payload
 * the server can really produce (`stubOptionalExtrasHollowApi`).
 *
 * Everything above this line is a prohibition — no leaked text, no rejection,
 * no render error. **A component that renders nothing satisfies all three.**
 * Measured: forcing all four new leaf guards to reject every payload left this
 * file at 100 passed / exit 0 while `PmAnalyticsPanel` rendered 0 characters
 * and `AnalyticsTab` dropped from 594 to 216 — the stats row survived and the
 * health, timeline and patterns panels vanished. A guard checked against leaves
 * fails in exactly that direction, and nothing here could see it.
 *
 * So this is the missing clause. Expectations are i18n **keys**, resolved to
 * their English text at run time, so they follow the catalogue instead of
 * becoming a second hand-maintained copy of it; `en()` throws if a key is
 * retired. `literals` is for the one component with no `t()` calls at all.
 *
 * `nothing` is for components that legitimately render empty under their
 * degenerate props — a decision written down, not an omission. The meta-test
 * below requires every case to declare one or the other.
 *
 * Note a length check is not enough: 216 characters passed while four panels
 * were missing.
 */
const MUST_RENDER: Record<string, { keys?: string[]; literals?: string[]; nothing?: string }> = {
  // One marker per row this tab is made of, because each row has its own guard
  // and a marker from a different row will not notice that row disappearing:
  // stats / health / timeline / patterns.
  AnalyticsTab: { keys: ['analytics.totalMemories', 'health.title', 'timeline.title', 'patterns.title'] },
  Chip: { nothing: 'renders only its caller-supplied label, and the degenerate props hand it an empty one' },
  DoctorBanner: { nothing: 'renders only when a doctor check has failed; every stub sends an empty checks list' },
  // Fetches nothing on mount (the seed POST fires only on click), so it must
  // render the same guidance whatever the API stub does.
  EmptyLibraryState: { keys: ['emptyLibrary.title', 'onboarding.seedButton'] },
  FeedbackWidget: { keys: ['feedback.button'] },
  GraphTab: { keys: ['tab.graph', 'graph.entities'] },
  Header: { literals: ['MeMesh'] },
  HealthScore: { keys: ['health.title'] },
  // Home is InsightsTab (which declares its own marker above) plus the
  // analytics expander; the expander header is the only text HomeTab itself
  // owns, and it must survive every payload — a HomeTab that lost it lost
  // the only route to the analytics stack.
  HomeTab: { keys: ['home.analyticsTitle'] },
  InsightsBanner: { nothing: 'renders only when there are unreviewed insights to point at from the current tab' },
  InsightsTab: { keys: ['insights.title'] },
  KnowledgeRadar: { nothing: 'takes `data={[]}`; an empty radar has no axes to draw' },
  LlmTelemetryPanel: { keys: ['telemetry.title'] },
  // One marker for the static chrome (the card title) and one for the scope
  // chip row — different rows, each rendered before any fetch settles, so
  // either vanishing is caught independently of the payload.
  MemoriesTab: { keys: ['browse.title', 'memories.scopeLabel'] },
  MemoryAgeMatrix: { nothing: 'takes `data={[]}`; an empty matrix has no buckets to draw' },
  MemoryTimeline: { keys: ['timeline.title'] },
  PatternCard: { literals: ['pattern-1'] },
  PmAnalyticsPanel: { keys: ['pm.decisionsPerWeek', 'pm.orphanRate'] },
  // ProjectTab has NO static chrome: everything it draws is data-gated
  // (spinner → error → tri-state empty → chips). The "positive" stub's
  // payload is not an entities array, so the tab's one honest render under
  // it is the classified version-skew sentence — asserting it pins that a
  // payload nobody could read is named as such instead of rendering blank
  // or masquerading as a fresh install.
  ProjectTab: { keys: ['common.responseUnreadable'] },
  // One marker per card: capabilities / LLM provider / updates / behaviour /
  // language. The card titles are static, so they must survive every payload
  // this suite sends — a SettingsTab that lost a card lost a control surface.
  //
  // `settings.updateUnavailable` pins the CALL SITE of the update-status
  // guard, which the leaf tests cannot see: this stub's payload carries none
  // of the fields the summary branches on, and without the guard it falls
  // through every branch and lands on "Up to date" — a false green. The
  // correct answer to a payload that said nothing is "can't check", visibly.
  // `settings.llmOptional.title`, NOT `settings.llmProvider`, as the LLM
  // card's marker: `llmProvider` is also the Capabilities card's stat label,
  // so with it the whole LLM card — provider radios, key entry, Save — could
  // disappear and the other occurrence would still satisfy `toContain`. A
  // marker shared between two cards watches neither.
  SettingsTab: {
    keys: [
      'settings.capabilities',
      'settings.llmOptional.title',
      'settings.updates',
      'settings.behaviourTitle',
      'settings.language',
      'settings.updateUnavailable',
    ],
  },
  TabNav: { nothing: 'takes `tabs={[]}`; there are no tabs to render' },
  UserPatterns: { keys: ['patterns.title'] },
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

/**
 * A leak that arrives the way the real components' data does: through the
 * stubbed `fetch`, `res.json()`, a state update, and then a SECOND fetch
 * issued from the effect that state change triggers.
 *
 * The three canaries above all fail synchronously or one microtask deep, so
 * none of them exercises what `settle()` exists for — a component whose
 * defect is only visible after the response promise chain has fully run.
 * Measured: with the drain loop gutted to an empty `act()` (the `setImmediate`
 * left in place), every other test in this file still passes — 143 of 144 —
 * and this is the single assertion that notices the harness stopped waiting.
 */
function ChainedFetchCanary() {
  const [step, setStep] = useState<unknown>(null);
  const [text, setText] = useState('loading');
  useEffect(() => {
    void fetch('/v1/step-one')
      .then(r => r.json())
      .then(d => setStep(d))
      .catch(() => setText('failed'));
  }, []);
  useEffect(() => {
    if (step === null) return;
    void fetch('/v1/step-two')
      .then(r => r.json() as Promise<{ missing?: string }>)
      .then(d => setText(`value: ${d.missing}`))
      .catch(() => setText('failed'));
  }, [step]);
  return <div>{text}</div>;
}

/* ------------------------------------------------------------------ *
 * Shape guards, leaf by leaf                                          *
 * ------------------------------------------------------------------ */

/** Remove one dotted path from a nested plain-object payload. */
function deepDelete(obj: Record<string, unknown>, dotted: string): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  delete cur[parts[parts.length - 1]];
}

/**
 * Each guard, a payload it must accept, and every leaf whose absence it must
 * reject — one test per leaf, because a component-level stub cannot do this:
 * a stub missing three fields is rejected by whichever checks remain, so
 * deleting any single check from the guard still passes. Measured: with only
 * the stub-level tests, removing `isStatsRenderable`'s `totalObservations`
 * line left the whole file green while the stats row was one payload away
 * from calling `.toLocaleString()` on `undefined`.
 *
 * The `leaves` lists are maintained by hand and checked by execution: a stale
 * entry fails its test the day the guard stops requiring it. What this cannot
 * catch is a NEW dereference added to a render without a matching guard line
 * — that direction is what the API stubs and `MUST_RENDER` above are for.
 */
const GUARD_LEAVES: Array<{
  name: string;
  guard: (v: unknown) => boolean;
  valid: () => Record<string, unknown>;
  leaves: string[];
}> = [
  {
    name: 'isStatsRenderable',
    guard: isStatsRenderable as (v: unknown) => boolean,
    valid: () => ({ totalEntities: 3, totalObservations: 7, totalRelations: 1, totalTags: 2, tagDistribution: [] }),
    leaves: ['totalEntities', 'totalObservations', 'totalRelations', 'totalTags', 'tagDistribution'],
  },
  {
    name: 'isAnalyticsRenderable',
    guard: isAnalyticsRenderable as (v: unknown) => boolean,
    valid: () => ({
      healthScore: 42,
      healthFactors: {
        activity: { score: 1, weight: 30 },
        quality: { score: 1, weight: 30 },
        freshness: { score: 1, weight: 20 },
        lessons: { score: 1, weight: 20 },
      },
      loopMetric: { trend: [] },
      timeline: [],
    }),
    leaves: [
      'healthScore',
      'healthFactors.activity.score', 'healthFactors.activity.weight',
      'healthFactors.quality.score', 'healthFactors.quality.weight',
      'healthFactors.freshness.score', 'healthFactors.freshness.weight',
      'healthFactors.lessons.score', 'healthFactors.lessons.weight',
      'loopMetric.trend',
      'timeline',
    ],
  },
  {
    name: 'isPatternsRenderable',
    guard: isPatternsRenderable as (v: unknown) => boolean,
    valid: () => ({
      workSchedule: { hourDistribution: [], dayDistribution: [] },
      toolPreferences: [], focusAreas: [], strengths: [], learningAreas: [],
      workflow: { avgSessionMinutes: 0, totalSessions: 0, commitsPerSession: 0 },
    }),
    leaves: [
      'workSchedule.hourDistribution', 'workSchedule.dayDistribution',
      'toolPreferences', 'focusAreas', 'strengths', 'learningAreas',
      'workflow.avgSessionMinutes', 'workflow.totalSessions', 'workflow.commitsPerSession',
    ],
  },
  {
    name: 'isPmAnalyticsRenderable',
    guard: isPmAnalyticsRenderable as (v: unknown) => boolean,
    valid: () => ({
      velocity: { decisionsPerWeek: 0 },
      staleness: { openDecisionCount: 0, stalePlanCount: 0 },
      connectedness: { orphanRate: 0, totalRelations: 0 },
    }),
    leaves: [
      'velocity.decisionsPerWeek',
      'staleness.openDecisionCount', 'staleness.stalePlanCount',
      'connectedness.orphanRate', 'connectedness.totalRelations',
    ],
  },
  {
    name: 'isGraphRenderable',
    guard: isGraphRenderable as (v: unknown) => boolean,
    valid: () => ({ entities: [], relations: [] }),
    leaves: ['entities', 'relations'],
  },
  {
    name: 'isConfigRenderable',
    guard: isConfigRenderable as (v: unknown) => boolean,
    valid: () => ({ config: {}, capabilities: { searchLevel: 0, embeddings: 'tfidf' } }),
    leaves: ['config'],
  },
  {
    name: 'isUpdateStatusRenderable',
    guard: isUpdateStatusRenderable as (v: unknown) => boolean,
    valid: () => ({ checkSucceeded: true, freshness: 'fresh', updateAvailable: false }),
    leaves: ['checkSucceeded', 'freshness', 'updateAvailable'],
  },
];

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

  it('every covered component declares what it must render, or why it renders nothing', () => {
    // Without this, adding a case and forgetting its expectation leaves that
    // component back where the whole file started: three prohibitions and no
    // requirement, satisfied by rendering nothing at all.
    const missing: string[] = [];
    const both: string[] = [];
    for (const c of CASES) {
      const want = MUST_RENDER[c.name];
      const positive = (want?.keys?.length ?? 0) + (want?.literals?.length ?? 0);
      if (!want || (positive === 0 && !want.nothing)) missing.push(c.name);
      else if (positive > 0 && want.nothing) both.push(c.name);
    }
    expect(missing).toEqual([]);
    expect(both).toEqual([]);

    // And nothing stale: an entry for a component no longer under test would
    // silently stop being enforced.
    const covered = new Set(CASES.map(c => c.name));
    expect(Object.keys(MUST_RENDER).filter(n => !covered.has(n))).toEqual([]);

    // Every key named above must still exist, or `en()` would throw inside a
    // case and read as that component's failure rather than a retired key.
    for (const want of Object.values(MUST_RENDER)) for (const k of want.keys ?? []) expect(() => en(k)).not.toThrow();
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

    it('settle() waits out a leak that arrives through the real fetch path, two responses deep', async () => {
      stubEmptyApi();
      const { container } = render(<Recorder><ChainedFetchCanary /></Recorder>);
      await settle();
      expect(unhandled).toEqual([]);
      expect(caught).toEqual([]);
      const text = container.textContent ?? '';
      // Split on purpose: `loading` here means the harness stopped waiting and
      // every per-component assertion below is running against nothing — the
      // vacuous-wait failure this file's header documents, as opposed to the
      // leak itself going undetected.
      expect(text, 'the chained fetch never completed — settle() is not settling').toContain('value:');
      expect(() => assertNoLeakedInternals('ChainedFetchCanary', text)).toThrow();
    });
  });

  it('SettingsTab names version skew, not an outage, when /v1/config answers with the wrong shape', async () => {
    // The two failures need two diagnoses: "failed to load" sends a user to
    // their server, "cannot render" sends them to `memesh doctor` / a reload.
    // Without this, bypassing the shape guard is invisible — the read throws,
    // the network .catch absorbs it, and the tab degrades identically while
    // the console blames an outage that never happened. Measured: that exact
    // mutation survived every other test in this file.
    const warns: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    });
    stubEmptyApi();
    render(<Recorder><SettingsTab locale="en" onLocaleChange={() => {}} /></Recorder>);
    await settle();
    const skew = warns.filter(w => w.includes('/v1/config') && w.includes('cannot render'));
    const outage = warns.filter(w => w.includes('/v1/config failed to load'));
    expect(skew, 'the shape rejection should be diagnosed as version skew').toHaveLength(1);
    expect(outage, 'an empty-but-successful response is not an outage').toEqual([]);
  });

  describe('the two failures are told apart', () => {
    // KT's failure-display policy: "could not reach the server" and "the
    // server answered but this bundle could not read it" carry different
    // next steps (check `memesh serve` vs reload / `memesh doctor`), so a
    // component in a failed state must name the RIGHT one — and not the
    // other. One collapsed message sends half the users chasing a server
    // that is running fine.
    const PAIRS: Array<{ name: string; node: () => ComponentChildren; install: () => void; kind: 'down' | 'skew' }> = [
      { name: 'AnalyticsTab', node: () => <AnalyticsTab />, install: stubFailingApi, kind: 'down' },
      { name: 'AnalyticsTab', node: () => <AnalyticsTab />, install: stubPartialApi, kind: 'skew' },
      { name: 'GraphTab', node: () => <GraphTab />, install: stubFailingApi, kind: 'down' },
      { name: 'GraphTab', node: () => <GraphTab />, install: stubEmptyApi, kind: 'skew' },
      { name: 'MemoriesTab', node: () => <MemoriesTab />, install: stubFailingApi, kind: 'down' },
      { name: 'MemoriesTab', node: () => <MemoriesTab />, install: stubEmptyApi, kind: 'skew' },
      { name: 'InsightsTab', node: () => <InsightsTab />, install: stubFailingApi, kind: 'down' },
      { name: 'InsightsTab', node: () => <InsightsTab />, install: stubEmptyApi, kind: 'skew' },
      { name: 'LlmTelemetryPanel', node: () => <LlmTelemetryPanel />, install: stubFailingApi, kind: 'down' },
      { name: 'LlmTelemetryPanel', node: () => <LlmTelemetryPanel />, install: stubEmptyApi, kind: 'skew' },
      // A 500 is a server that ANSWERED. The first wiring of this feature
      // labelled every catch "unreachable", which mislabelled the most
      // common real failure with the one instruction that cannot help.
      { name: 'AnalyticsTab', node: () => <AnalyticsTab />, install: stubErroringApi, kind: 'skew' },
      { name: 'GraphTab', node: () => <GraphTab />, install: stubErroringApi, kind: 'skew' },
      { name: 'LlmTelemetryPanel', node: () => <LlmTelemetryPanel />, install: stubErroringApi, kind: 'skew' },
    ];
    for (const c of PAIRS) {
      const label = c.kind === 'down' ? 'the server is down' : 'the reply was unreadable (version skew)';
      it(`${c.name} says so when ${label}`, async () => {
        expect(document.body.childElementCount).toBe(0);
        c.install();
        const { container } = render(<Recorder>{c.node()}</Recorder>);
        await settle();
        const text = container.textContent ?? '';
        // DESIGN.md: an error state must live in a `role="alert"` element —
        // it replaces content, and a screen reader hears nothing from a
        // silent repaint. Asserting the message INSIDE the alert pins both
        // the wording and the announcement at once.
        const alertText = [...container.querySelectorAll('[role="alert"]')]
          .map(nod => nod.textContent ?? '')
          .join(' ');
        const want = c.kind === 'down' ? en('common.serverUnreachable') : en('common.responseUnreadable');
        const wrong = c.kind === 'down' ? en('common.responseUnreadable') : en('common.serverUnreachable');
        expect(alertText, `${c.name} should name the failure inside a role="alert" element`).toContain(want);
        expect(text, `${c.name} must not blame the other failure`).not.toContain(wrong);
      });
    }
  });

  it('a mid-session 401 is announced to the app, not swallowed as a load failure', async () => {
    // Each tab catches its own errors, so before this event existed a token
    // that expired mid-session surfaced as one tab's "failed to load" while
    // the auth prompt never appeared. api() must announce every 401.
    const announced: number[] = [];
    const listener = () => { announced.push(1); };
    window.addEventListener('memesh:auth-required', listener);
    try {
      stubApi(() => new Response('unauthorized', { status: 401 }));
      render(<Recorder><LlmTelemetryPanel /></Recorder>);
      await settle();
      expect(unhandled).toEqual([]);
      expect(caught).toEqual([]);
      expect(announced.length, 'the 401 should have been announced').toBeGreaterThan(0);
    } finally {
      window.removeEventListener('memesh:auth-required', listener);
    }
  });

  it('PmAnalyticsPanel renders through the catalogue, not through English literals', async () => {
    // The English catalogue values ARE the old hardcoded literals, so a
    // positive `toContain` in English passes whether or not `t()` is called.
    // Switching locale is the only observable difference between "translated"
    // and "hardcoded" — and if the zh-TW keys were missing, `t()` would fall
    // back to English and the negative assertion below would catch that too.
    setLocale('zh-TW');
    try {
      const zh = t('pm.decisionsPerWeek');
      expect(zh, 'zh-TW must actually translate this key').not.toBe(en('pm.decisionsPerWeek'));
      stubOptionalExtrasHollowApi();
      const { container } = render(<Recorder><PmAnalyticsPanel /></Recorder>);
      await settle();
      const text = container.textContent ?? '';
      expect(text, 'should render the zh-TW label').toContain(zh);
      expect(text, 'must not render the English literal').not.toContain(en('pm.decisionsPerWeek'));
    } finally {
      setLocale('en');
    }
  });

  it('LlmTelemetryPanel ignores a stale response that lands after a window switch', async () => {
    // The effect re-runs per window switch with no request ordering of its
    // own — without the cleanup flag, whichever response RESOLVES last wins,
    // so a lagging 30d reply could overwrite the 7d data on screen, or a
    // stale failure could blank out fresh good data. Resolve out of order on
    // purpose: the switched-to window answers first, the abandoned one last.
    const pending: Array<(r: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((() =>
      new Promise<Response>(res => { pending.push(res); })) as typeof globalThis.fetch);
    const flush = async () => {
      await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
      });
      await new Promise<void>(r => setImmediate(r));
    };

    const { container } = render(<Recorder><LlmTelemetryPanel /></Recorder>);
    await flush();
    expect(pending.length, 'the mount fetch should be pending').toBe(1);

    const sevenDays = [...container.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('7'));
    expect(sevenDays, 'the 7-day window button should exist').toBeTruthy();
    fireEvent.click(sevenDays as HTMLButtonElement);
    await flush();
    expect(pending.length, 'the switch should issue a second fetch').toBe(2);

    // The CURRENT window answers with a clean empty payload...
    pending[1](jsonResponse({ success: true, data: { window_days: 7, summaries: [] } }));
    await flush();
    // ...and the ABANDONED request answers later, with garbage.
    pending[0](jsonResponse({ success: true, data: {} }));
    await flush();

    const text = container.textContent ?? '';
    expect(text, 'the fresh window data should be on screen').toContain(en('telemetry.empty'));
    expect(text, 'the stale failure must not overwrite it').not.toContain(en('common.responseUnreadable'));
  });

  it('the app swaps in the auth prompt when any request announces a 401', async () => {
    // PR #111 pinned the announcing side (api() fires the event); this pins
    // the LISTENING side — remove App's listener and only this fails.
    stubEmptyApi();
    const { container } = render(<Recorder><App /></Recorder>);
    await settle();
    expect((container.textContent ?? '')).not.toContain(en('auth.title'));

    await act(async () => {
      window.dispatchEvent(new Event('memesh:auth-required'));
    });
    await settle();
    expect(container.textContent ?? '', 'the auth prompt should have taken over')
      .toContain(en('auth.title'));
  });

  describe('shape guards, leaf by leaf', () => {
    for (const g of GUARD_LEAVES) {
      it(`${g.name} accepts the payload it exists to admit`, () => {
        expect(g.guard(g.valid())).toBe(true);
      });
      it(`${g.name} rejects null`, () => {
        expect(g.guard(null)).toBe(false);
      });
      for (const leaf of g.leaves) {
        it(`${g.name} rejects a payload missing only ${leaf}`, () => {
          const v = g.valid();
          deepDelete(v, leaf);
          expect(g.guard(v)).toBe(false);
        });
      }
    }
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
        const text = container.textContent ?? '';
        assertNoLeakedInternals(c.name, text);

        // The positive half. Only against the stub where the component is
        // supposed to have real content, because that is the only payload for
        // which "renders nothing" is unambiguously wrong.
        if (stub.positive) {
          const want = MUST_RENDER[c.name];
          // `expect(text, message)`, NOT `expect(\`…${text}\`).toContain(needle)`.
          // The first version of this built the needle into the message and then
          // searched the message — an assertion that could not fail, written
          // inside the change whose whole point is removing those. The
          // break-test caught it; nothing else would have.
          for (const key of want.keys ?? []) {
            expect(text, `${c.name} should render ${key} (${JSON.stringify(en(key))})`).toContain(en(key));
          }
          for (const literal of want.literals ?? []) {
            expect(text, `${c.name} should render ${JSON.stringify(literal)}`).toContain(literal);
          }
          if (want.nothing) expect(text, `${c.name} should render nothing: ${want.nothing}`).toBe('');
        }
      });
    }
  }
});
