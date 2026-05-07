import { useState, useEffect, useCallback } from 'preact/hooks';
import { Header } from './components/Header';
import { TabNav } from './components/TabNav';
import { SearchTab } from './components/SearchTab';
import { BrowseTab } from './components/BrowseTab';
import { AnalyticsTab } from './components/AnalyticsTab';
import { SettingsTab } from './components/SettingsTab';
import { GraphTab } from './components/GraphTab';
import { LessonsTab } from './components/LessonsTab';
import { FeedbackWidget } from './components/FeedbackWidget';
import { AuthPrompt } from './components/AuthPrompt';
import { api, AuthRequiredError, getApiToken, setApiToken, type HealthData } from './lib/api';
import { initLocale, t, type Locale } from './lib/i18n';

// Tab order — Lessons leads because the differentiated value of MeMesh
// (failure → structured lesson loop) belongs front and centre. Search is
// demoted past Browse and Analytics because the discovery flow (browse +
// roadmap) is more meaningful for a returning user than another keyword
// box. Order is the source of truth for the nav bar AND the panel-render
// block — keep them in sync.
const TAB_KEYS = ['Lessons', 'Browse', 'Analytics', 'Search', 'Graph', 'Manage', 'Settings'] as const;
type Tab = typeof TAB_KEYS[number];

const TAB_I18N_KEYS: Record<Tab, string> = {
  Lessons: 'tab.lessons',
  Browse: 'tab.browse',
  Analytics: 'tab.analytics',
  Search: 'tab.search',
  Graph: 'tab.graph',
  Manage: 'tab.manage',
  Settings: 'tab.settings',
};

const TAB_STORAGE_KEY = 'memesh.tab';

/**
 * Resolve the initial tab from (in order): URL ?tab=, localStorage,
 * default to Lessons. Deep-link wins so users can bookmark a specific
 * view; otherwise the last-used tab persists across reloads.
 */
function initialTab(): Tab {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('tab');
    if (fromUrl && (TAB_KEYS as readonly string[]).includes(fromUrl)) {
      return fromUrl as Tab;
    }
    const fromStorage = localStorage.getItem(TAB_STORAGE_KEY);
    if (fromStorage && (TAB_KEYS as readonly string[]).includes(fromStorage)) {
      return fromStorage as Tab;
    }
  } catch {
    // SSR / private mode / no window — fall through to default
  }
  return 'Lessons';
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => initLocale());
  const [tab, setTab] = useState<Tab>(initialTab);

  // Persist tab choice on every change so a returning user lands where
  // they left off. localStorage failures (private mode, disabled
  // storage) are silent — the default kicks in next session.
  useEffect(() => {
    try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* no-op */ }
  }, [tab]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState('');
  // Codex fix (2026-05-05): the server protects /v1/* with a bearer
  // token whenever it is bound non-loopback. The dashboard SPA stores
  // the token in localStorage and attaches it via api.ts. If the call
  // returns 401 (no token, wrong token, or rotated token), surface a
  // modal so the user can paste theirs without leaving the page.
  const [needsAuth, setNeedsAuth] = useState(false);

  const refetchHealth = useCallback(() => {
    api<HealthData>('GET', '/v1/health')
      .then((data) => {
        setHealth(data);
        setError('');
        setNeedsAuth(false);
      })
      .catch((e) => {
        if (e instanceof AuthRequiredError) {
          setNeedsAuth(true);
          setError('');
          return;
        }
        setError(e.message);
      });
  }, []);

  // Initial fetch + subscribe to data-changed events. ISSUE-001 fix:
  // BrowseTab's ↻ refresh (and archive/restore) refetches body data via
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
        onSubmit={(token) => {
          setApiToken(token);
          setNeedsAuth(false);
          refetchHealth();
        }}
      />
    );
  }

  return (
    <div class="shell">
      <Header health={health} error={error} />
      <TabNav tabs={tabLabels} active={tab} onSelect={(k) => setTab(k as Tab)} />
      <div class="main">
        <div class={`panel ${tab === 'Search' ? 'active' : ''}`}><SearchTab /></div>
        <div class={`panel ${tab === 'Browse' ? 'active' : ''}`}><BrowseTab /></div>
        <div class={`panel ${tab === 'Analytics' ? 'active' : ''}`}><AnalyticsTab /></div>
        <div class={`panel ${tab === 'Graph' ? 'active' : ''}`}>{tab === 'Graph' && <GraphTab />}</div>
        <div class={`panel ${tab === 'Lessons' ? 'active' : ''}`}>{tab === 'Lessons' && <LessonsTab />}</div>
        <div class={`panel ${tab === 'Manage' ? 'active' : ''}`}>{tab === 'Manage' && <BrowseTab manage />}</div>
        <div class={`panel ${tab === 'Settings' ? 'active' : ''}`}>
          {tab === 'Settings' && <SettingsTab locale={locale} onLocaleChange={setLocale} />}
        </div>
      </div>
      <FeedbackWidget health={health} />
    </div>
  );
}
