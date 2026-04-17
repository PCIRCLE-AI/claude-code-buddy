import { useState, useEffect } from 'preact/hooks';
import { Header } from './components/Header';
import { TabNav } from './components/TabNav';
import { SearchTab } from './components/SearchTab';
import { BrowseTab } from './components/BrowseTab';
import { AnalyticsTab } from './components/AnalyticsTab';
import { SettingsTab } from './components/SettingsTab';
import { api, type HealthData } from './lib/api';

const TABS = ['Search', 'Browse', 'Analytics', 'Manage', 'Settings'] as const;
type Tab = typeof TABS[number];

export function App() {
  const [tab, setTab] = useState<Tab>('Browse');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<HealthData>('GET', '/v1/health')
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div class="shell">
      <Header health={health} error={error} />
      <TabNav tabs={TABS as unknown as string[]} active={tab} onSelect={(t) => setTab(t as Tab)} />
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
        💬 Feedback
      </button>
    </div>
  );
}
