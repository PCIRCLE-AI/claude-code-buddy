import { useState, useEffect, useCallback } from 'preact/hooks';
import { Header } from './components/Header';
import { TabNav } from './components/TabNav';
import { HomeTab } from './components/HomeTab';
import { MemoriesTab } from './components/MemoriesTab';
import { ProjectTab } from './components/ProjectTab';
import { SettingsTab } from './components/SettingsTab';
import { GraphTab } from './components/GraphTab';
import { FeedbackWidget } from './components/FeedbackWidget';
import { AuthPrompt } from './components/AuthPrompt';
import { OnboardingBanner } from './components/OnboardingBanner';
import { DoctorBanner } from './components/DoctorBanner';
import { InsightsBanner } from './components/InsightsBanner';
import { api, AuthRequiredError, getApiToken, setApiToken, type HealthData } from './lib/api';
import { initLocale, t, type Locale } from './lib/i18n';

// Five tabs, one job each. Home leads because it answers the visit's real
// question — what did memesh do for me, and does anything need my
// judgment. Memories is the whole library behind one surface (search,
// scope, manage). Project is the story of one project. Graph and Settings
// keep their jobs. Order is the source of truth for the nav bar AND the
// panel-render block — keep them in sync.
const TAB_KEYS = ['Home', 'Memories', 'Project', 'Graph', 'Settings'] as const;
type Tab = typeof TAB_KEYS[number];

const TAB_I18N_KEYS: Record<Tab, string> = {
  Home: 'tab.home',
  Memories: 'tab.memories',
  Project: 'tab.project',
  Graph: 'tab.graph',
  Settings: 'tab.settings',
};

/** Where the retired tab names lead now — a stored `memesh.tab` or a
 *  bookmarked `?tab=Browse` deep link degrades to the surface that
 *  absorbed it, not silently to the default. */
const LEGACY_TAB_MAP: Record<string, Tab> = {
  Insights: 'Home',
  Analytics: 'Home',
  Search: 'Memories',
  Browse: 'Memories',
  Manage: 'Memories',
  Lessons: 'Memories',
};

const TAB_STORAGE_KEY = 'memesh.tab';

/**
 * Resolve the initial tab from (in order): URL ?tab=, localStorage,
 * default to Home. Deep-link wins so users can bookmark a specific
 * view; otherwise the last-used tab persists across reloads.
 */
function initialTab(): Tab {
  const resolve = (raw: string | null): Tab | null => {
    if (!raw) return null;
    if ((TAB_KEYS as readonly string[]).includes(raw)) return raw as Tab;
    return LEGACY_TAB_MAP[raw] ?? null;
  };
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = resolve(params.get('tab'));
    if (fromUrl) return fromUrl;
    const fromStorage = resolve(localStorage.getItem(TAB_STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch {
    // SSR / private mode / no window — fall through to default
  }
  return 'Home';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => initLocale());
  const [tab, setTab] = useState<Tab>(initialTab);
  // Tabs that have been activated at least once. Memories and Project each
  // fetch /v1/entities?limit=2000 fully hydrated plus /v1/projects on
  // mount — they keep their component state across tab switches
  // (mounted-but-hidden), but must not mount BEFORE first activation, or
  // every page load pays those requests for tabs the user may never open.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<Tab>>(() => new Set<Tab>());
  useEffect(() => {
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);
  // `|| tab === X` covers the first render before the effect lands, so the
  // active tab never flashes empty.
  const keepMounted = (key: Tab) => visitedTabs.has(key) || tab === key;

  // Persist tab choice on every change so a returning user lands where
  // they left off. localStorage failures (private mode, disabled
  // storage) are silent — the default kicks in next session.
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* no-op */ }
    // Write the tab back to the URL. The read side (initialTab) has
    // honoured ?tab= deep links since the 5-tab shell, but nothing ever
    // wrote the param — so copying the address bar always shared "wherever
    // the reader's own storage lands them", never the view being looked
    // at. replaceState, not pushState: tab switches are view state, not
    // navigation history.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      history.replaceState(null, '', url);
    } catch { /* no-op — same private-mode tolerance as storage */ }
  }, [tab]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState('');
  // Codex fix (2026-05-05): the server protects /v1/* with a bearer
  // token whenever it is bound non-loopback. The dashboard SPA stores
  // the token in localStorage and attaches it via api.ts. If the call
  // returns 401 (no token, wrong token, or rotated token), surface a
  // modal so the user can paste theirs without leaving the page.
  const [needsAuth, setNeedsAuth] = useState(false);

  // A 401 can arrive on ANY tab's own fetch once a token expires or rotates
  // mid-session — and each tab catches its own errors, so without this the
  // only symptom was one tab's "failed to load". api() announces every 401
  // on this event; swap in the auth prompt no matter whose request tripped.
  useEffect(() => {
    const onAuthRequired = () => setNeedsAuth(true);
    window.addEventListener('memesh:auth-required', onAuthRequired);
    return () => window.removeEventListener('memesh:auth-required', onAuthRequired);
  }, []);
  const [authRejected, setAuthRejected] = useState(false);

  const refetchHealth = useCallback(() => {
    api<HealthData>('GET', '/v1/health')
      .then((data) => {
        setHealth(data);
        setError('');
        setNeedsAuth(false);
      })
      .catch((e) => {
        if (e instanceof AuthRequiredError) {
          // A 401 while a token is already stored means that token was
          // rejected, not that none was supplied.
          setAuthRejected(getApiToken() !== null);
          setNeedsAuth(true);
          setError('');
          return;
        }
        setError(e.message);
      });
  }, []);

  // Initial fetch + subscribe to data-changed events. ISSUE-001 fix:
  // MemoriesTab's ↻ refresh (and archive/restore) refetches body data via
  // its own state, but the header lives here in App and used to fetch
  // /v1/health only once on mount. The header therefore stayed stuck
  // at the page-load count. Dispatching `memesh:data-changed` from any
  // mutation site keeps the header in sync without coupling components.
  useEffect(() => {
    refetchHealth();
    const handler = () => refetchHealth();
    window.addEventListener('memesh:data-changed', handler);
    return () => window.removeEventListener('memesh:data-changed', handler);
  }, [refetchHealth]);

  // Build translated tab labels paired with their keys for TabNav
  const tabLabels = TAB_KEYS.map((key) => ({ key, label: t(TAB_I18N_KEYS[key]) }));

  if (needsAuth) {
    return (
      <AuthPrompt
        currentToken={getApiToken()}
        rejected={authRejected}
        onSubmit={(token) => {
          setApiToken(token);
          // Any token we are about to try is not yet rejected. If it comes
          // back 401, the catch in refetchHealth sets the flag again — which
          // is what turns a silent flash-and-return into visible feedback.
          setAuthRejected(false);
          setNeedsAuth(false);
          refetchHealth();
        }}
      />
    );
  }

  return (
    <div class="shell">
      <Header health={health} error={error} />
      {/* The notice slot: one banner at a time. Each banner self-decides
          eligibility (ineligible = no DOM), and DOM order IS the priority —
          Doctor (broken install) > Onboarding (empty library) > Insights
          (pending proposals). The stylesheet shows only the slot's first
          rendered child; the rest wait in the tree for the winner to clear
          (dismissal or the condition resolving). Three banners could
          previously stack into a wall above the nav. */}
      <div class="notice-slot">
        <DoctorBanner />
        <OnboardingBanner health={health} />
        <InsightsBanner currentTab={tab} onNavigateToInsights={() => setTab('Home')} />
      </div>
      <TabNav tabs={tabLabels} active={tab} onSelect={(k) => setTab(k as Tab)} />
      {/* Each panel is the tabpanel for its TabNav tab: id + role +
          aria-labelledby wire the roving-tablist relationship (see TabNav). */}
      <div class="main">
        <div id="panel-Home" role="tabpanel" aria-labelledby="tab-Home" class={`panel ${tab === 'Home' ? 'active' : ''}`}>{tab === 'Home' && <HomeTab />}</div>
        <div id="panel-Memories" role="tabpanel" aria-labelledby="tab-Memories" class={`panel ${tab === 'Memories' ? 'active' : ''}`}>{keepMounted('Memories') && <MemoriesTab health={health} />}</div>
        <div id="panel-Project" role="tabpanel" aria-labelledby="tab-Project" class={`panel ${tab === 'Project' ? 'active' : ''}`}>{keepMounted('Project') && <ProjectTab health={health} />}</div>
        <div id="panel-Graph" role="tabpanel" aria-labelledby="tab-Graph" class={`panel ${tab === 'Graph' ? 'active' : ''}`}>{tab === 'Graph' && <GraphTab />}</div>
        <div id="panel-Settings" role="tabpanel" aria-labelledby="tab-Settings" class={`panel ${tab === 'Settings' ? 'active' : ''}`}>
          {tab === 'Settings' && <SettingsTab locale={locale} onLocaleChange={setLocale} />}
        </div>
      </div>
      <FeedbackWidget health={health} />
    </div>
  );
}
