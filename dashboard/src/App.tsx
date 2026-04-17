import { useState, useEffect } from 'preact/hooks';
import { Header } from './components/Header';
import { TabNav } from './components/TabNav';
import { SearchTab } from './components/SearchTab';
import { BrowseTab } from './components/BrowseTab';
import { AnalyticsTab } from './components/AnalyticsTab';
import { SettingsTab } from './components/SettingsTab';
import { api, type HealthData } from './lib/api';
import { initLocale, t } from './lib/i18n';

initLocale();

const TAB_KEYS = ['Search', 'Browse', 'Analytics', 'Manage', 'Settings'] as const;
type Tab = typeof TAB_KEYS[number];

const TAB_I18N_KEYS: Record<Tab, string> = {
  Search: 'tab.search',
  Browse: 'tab.browse',
  Analytics: 'tab.analytics',
  Manage: 'tab.manage',
  Settings: 'tab.settings',
};

export function App() {
  const [tab, setTab] = useState<Tab>('Browse');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<HealthData>('GET', '/v1/health')
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

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
        <div class={`panel ${tab === 'Manage' ? 'active' : ''}`}>{tab === 'Manage' && <BrowseTab manage />}</div>
        <div class={`panel ${tab === 'Settings' ? 'active' : ''}`}>{tab === 'Settings' && <SettingsTab />}</div>
      </div>
      <button class="fb-btn" onClick={() => {
        const url = 'https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/new?title=' + encodeURIComponent('[Feedback] ') + '&labels=feedback,from-dashboard';
        window.open(url, '_blank');
      }}>
        {t('feedback.button')}
      </button>
    </div>
  );
}
