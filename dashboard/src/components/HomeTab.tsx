import { useCallback, useEffect, useState } from 'preact/hooks';
import { InsightsTab } from './InsightsTab';
import { AnalyticsTab } from './AnalyticsTab';
import { MetricsRow } from './MetricsRow';
import { api, type HealthData, type ReindexStatusData } from '../lib/api';
import { t } from '../lib/i18n';

type HomeDestination = 'Memories' | 'Settings';
type NextActionKind = 'loading' | 'empty' | 'reindex' | 'insights' | 'llm' | 'healthy' | 'unavailable';

interface InsightState {
  pendingCount: number;
  llmConfigured: boolean | null;
  loading: boolean;
  failed: boolean;
}

export function chooseNextAction(
  entityCount: number | null,
  reindex: ReindexStatusData | null | undefined,
  insights: InsightState,
): NextActionKind {
  if (entityCount === 0) return 'empty';
  if (reindex === null || insights.failed) return 'unavailable';
  if (reindex === undefined || insights.loading || insights.llmConfigured === null || entityCount === null) return 'loading';
  if (reindex.pendingReindex !== null || reindex.missingVectors > 0
    || reindex.status === 'failed' || reindex.status === 'retry-needed' || reindex.status === 'running') return 'reindex';
  if (insights.pendingCount > 0) return 'insights';
  if (!insights.llmConfigured) return 'llm';
  return 'healthy';
}

function NextBestAction({
  kind,
  onNavigate,
  onReviewInsights,
}: {
  kind: NextActionKind;
  onNavigate: (destination: HomeDestination) => void;
  onReviewInsights: () => void;
}) {
  const action = kind === 'empty' ? () => onNavigate('Memories')
    : kind === 'reindex' || kind === 'llm' ? () => onNavigate('Settings')
      : kind === 'insights' ? onReviewInsights
        : kind === 'unavailable' ? () => window.location.reload()
          : null;

  return (
    <section class="card" aria-labelledby="home-next-action-title" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ color: 'var(--text-3)', fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' }}>
        {t('home.nextAction.eyebrow')}
      </div>
      <h2 id="home-next-action-title" style={{ margin: '5px 0 6px', fontSize: 18 }}>
        {t(`home.nextAction.${kind}.title`)}
      </h2>
      <p style={{ margin: '0 0 4px', color: 'var(--text-1)', lineHeight: 1.5 }}>
        <strong>{t('home.nextAction.why')}</strong> {t(`home.nextAction.${kind}.why`)}
      </p>
      <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.5 }}>
        <strong>{t('home.nextAction.result')}</strong> {t(`home.nextAction.${kind}.result`)}
      </p>
      {action && (
        <button class="btn btn-primary" style={{ marginTop: 12 }} onClick={action}>
          {t(`home.nextAction.${kind}.action`)}
        </button>
      )}
    </section>
  );
}

/**
 * Home = what memesh did for the user (Insights, leading) + the analytics
 * stack folded into an expander. AnalyticsTab fires three fetches on mount
 * and two more from self-fetching panels, so the expander renders it only
 * after the FIRST expand (a `<details>` element would mount — and fetch —
 * while closed); once visited it stays mounted so collapse/expand keeps
 * its state without refetching (DESIGN.md expander pattern).
 */
export function HomeTab({
  health = null,
  dataRevision = 0,
  onNavigate = () => {},
}: {
  health?: HealthData | null;
  dataRevision?: number;
  onNavigate?: (destination: HomeDestination) => void;
}) {
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsVisited, setAnalyticsVisited] = useState(false);
  const [reindex, setReindex] = useState<ReindexStatusData | null | undefined>(undefined);
  const [insights, setInsights] = useState<InsightState>({ pendingCount: 0, llmConfigured: null, loading: true, failed: false });

  useEffect(() => {
    let cancelled = false;
    setReindex(undefined);
    api<ReindexStatusData>('GET', '/v1/reindex')
      .then((status) => { if (!cancelled) setReindex(status); })
      .catch((error) => {
        if (cancelled) return;
        console.warn('[memesh dashboard] /v1/reindex failed to load:', error);
        setReindex(null);
      });
    return () => { cancelled = true; };
  }, [dataRevision]);

  const updateInsights = useCallback((next: InsightState) => setInsights(next), []);
  const reviewInsights = useCallback(() => {
    const target = document.getElementById('home-insights');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  }, []);

  const nextAction = chooseNextAction(health?.entity_count ?? null, reindex, insights);

  function toggleAnalytics() {
    const next = !analyticsOpen;
    setAnalyticsOpen(next);
    if (next) setAnalyticsVisited(true);
  }

  return (
    <div>
      <NextBestAction kind={nextAction} onNavigate={onNavigate} onReviewInsights={reviewInsights} />
      {/* The recommendation leads; measurements are supporting context. The
          row still degrades per tile: one unmeasured metric says so and the
          others continue to show. */}
      <MetricsRow dataRevision={dataRevision} />
      <InsightsTab dataRevision={dataRevision} onStateChange={updateInsights} />
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
          {analyticsVisited && <AnalyticsTab dataRevision={dataRevision} />}
        </div>
      </div>
    </div>
  );
}
