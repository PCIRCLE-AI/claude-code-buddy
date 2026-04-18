import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type StatsData, type AnalyticsData } from '../lib/api';
import { HealthScore } from './HealthScore';
import { MemoryTimeline } from './MemoryTimeline';
import { ValueMetrics } from './ValueMetrics';
import { CleanupSuggestions } from './CleanupSuggestions';
import { t } from '../lib/i18n';

export function AnalyticsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<StatsData>('GET', '/v1/stats'),
      api<AnalyticsData>('GET', '/v1/analytics'),
    ]).then(([s, a]) => {
      setStats(s);
      setAnalytics(a);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (!stats || !analytics) return <div class="error-box">{t('common.error')}: Failed to load analytics</div>;

  return (
    <div>
      {/* Row 1: Stats overview */}
      <div class="stats-row">
        <div class="stat"><div class="stat-val">{stats.totalEntities.toLocaleString()}</div><div class="stat-lbl">{t('analytics.totalMemories')}</div></div>
        <div class="stat"><div class="stat-val">{stats.totalObservations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.knowledgeFacts')}</div></div>
        <div class="stat"><div class="stat-val">{stats.totalRelations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.connections')}</div></div>
        <div class="stat"><div class="stat-val">{stats.totalTags.toLocaleString()}</div><div class="stat-lbl">{t('analytics.topics')}</div></div>
      </div>

      {/* Row 2: Health Score */}
      <HealthScore score={analytics.healthScore} factors={analytics.healthFactors} />

      {/* Row 3: Memory Timeline */}
      <div style={{ marginTop: 8 }}>
        <MemoryTimeline data={analytics.timeline} />
      </div>

      {/* Row 4: Value Metrics */}
      <div style={{ marginTop: 8 }}>
        <ValueMetrics
          totalRecalls={analytics.valueMetrics.totalRecalls}
          lessonsWithWarnings={analytics.valueMetrics.lessonsWithWarnings}
          lessonCount={analytics.valueMetrics.lessonCount}
          typeDistribution={analytics.valueMetrics.typeDistribution}
        />
      </div>

      {/* Row 5: Cleanup Suggestions */}
      <div style={{ marginTop: 8 }}>
        <CleanupSuggestions
          staleEntities={analytics.cleanup.staleEntities}
          duplicateCandidates={analytics.cleanup.duplicateCandidates}
          onRefresh={loadData}
        />
      </div>

      {/* Row 6: Topics cloud (kept from original) */}
      {(() => {
        const internalPrefixes = ['auto_saved', 'auto-tracked', 'session_end', 'session:', 'source:', 'scope:', 'date:', 'urgency:'];
        const userTags = stats.tagDistribution.filter(tg =>
          !internalPrefixes.some(p => tg.tag.startsWith(p)) &&
          !/^\d{4}-\d{2}-\d{2}/.test(tg.tag)
        );
        return userTags.length > 0 ? (
          <div class="card" style={{ marginTop: 8 }}>
            <div class="card-title">{t('analytics.topics')}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {userTags.slice(0, 30).map((tg) => (
                <span key={tg.tag} class="tag" style={{ fontSize: Math.max(11, Math.min(15, 10 + Math.log2(tg.count + 1))) + 'px' }}>
                  {tg.tag} <span style={{ opacity: 0.5 }}>({tg.count})</span>
                </span>
              ))}
            </div>
          </div>
        ) : null;
      })()}
    </div>
  );
}
