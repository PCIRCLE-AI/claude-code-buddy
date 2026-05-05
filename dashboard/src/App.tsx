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
import { api, type HealthData } from './lib/api';
import { initLocale, t, type Locale } from './lib/i18n';

const TAB_KEYS = ['Search', 'Browse', 'Analytics', 'Graph', 'Lessons', 'Manage', 'Settings'] as const;
type Tab = typeof TAB_KEYS[number];

const TAB_I18N_KEYS: Record<Tab, string> = {
  Search: 'tab.search',
  Browse: 'tab.browse',
  Analytics: 'tab.analytics',
  Graph: 'tab.graph',
  Lessons: 'tab.lessons',
  Manage: 'tab.manage',
  Settings: 'tab.settings',
};

export function App() {
  const [locale, setLocale] = useState<Locale>(() => initLocale());
  const [tab, setTab] = useState<Tab>('Browse');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState('');

  const refetchHealth = useCallback(() => {
    api<HealthData>('GET', '/v1/health')
      .then((data) => {
        setHealth(data);
        setError('');
      })
      .catch((e) => setError(e.message));
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
