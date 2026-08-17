import { useState } from 'preact/hooks';
import { InsightsTab } from './InsightsTab';
import { AnalyticsTab } from './AnalyticsTab';
import { MetricsRow } from './MetricsRow';
import { t } from '../lib/i18n';

/**
 * Home = what memesh did for the user (Insights, leading) + the analytics
 * stack folded into an expander. AnalyticsTab fires three fetches on mount
 * and two more from self-fetching panels, so the expander renders it only
 * after the FIRST expand (a `<details>` element would mount — and fetch —
 * while closed); once visited it stays mounted so collapse/expand keeps
 * its state without refetching (DESIGN.md expander pattern).
 */
export function HomeTab() {
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsVisited, setAnalyticsVisited] = useState(false);

  function toggleAnalytics() {
    const next = !analyticsOpen;
    setAnalyticsOpen(next);
    if (next) setAnalyticsVisited(true);
  }

  return (
    <div>
      {/* Numbers first, then what needs a decision, then what was applied —
          the order the work-topology plan asked for. The row degrades per
          tile: one unmeasured metric says so and the others still show. */}
      <MetricsRow />
      <InsightsTab />
      <div class="card" style={{ marginTop: 8 }}>
        <button
          onClick={toggleAnalytics}
          aria-expanded={analyticsOpen}
          aria-controls="home-analytics"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            color: 'var(--text-0)',
            font: '600 13px var(--font-ui)',
            textAlign: 'left',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style={{ transform: analyticsOpen ? 'rotate(90deg)' : 'none', transition: 'transform 150ms', color: 'var(--text-2)', flexShrink: 0 }}>
            <path d="M6 4 L10 8 L6 12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t('home.analyticsTitle')}
          {!analyticsOpen && (
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-3)' }}>{t('home.analyticsHint')}</span>
          )}
        </button>
        <div id="home-analytics" hidden={!analyticsOpen} style={{ marginTop: analyticsOpen ? 14 : 0 }}>
          {analyticsVisited && <AnalyticsTab />}
        </div>
      </div>
    </div>
  );
}
