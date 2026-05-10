import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type StatsData, type AnalyticsData, type PatternsData } from '../lib/api';
import { HealthScore } from './HealthScore';
import { MemoryLoopCard } from './MemoryLoopCard';
import { MemoryTimeline } from './MemoryTimeline';
import { MemoryAgeMatrix } from './MemoryAgeMatrix';
import { KnowledgeRadar } from './KnowledgeRadar';
import { UserPatterns } from './UserPatterns';
import { LlmTelemetryPanel } from './LlmTelemetryPanel';
import { t } from '../lib/i18n';

export function AnalyticsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [patterns, setPatterns] = useState<PatternsData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<StatsData>('GET', '/v1/stats').catch(() => null),
      api<AnalyticsData>('GET', '/v1/analytics').catch(() => null),
      api<PatternsData>('GET', '/v1/patterns').catch(() => null),
    ]).then(([s, a, p]) => {
      setStats(s);
      setAnalytics(a);
      setPatterns(p);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (!stats && !analytics) return <div class="error-box">{t('common.error')}: {t('analytics.loadFailed')}</div>;

  return (
    <div>
      {/* Row 1: Stats overview */}
      {stats && (
        <div class="stats-row">
          <div class="stat"><div class="stat-val">{stats.totalEntities.toLocaleString()}</div><div class="stat-lbl">{t('analytics.totalMemories')}</div></div>
          <div class="stat"><div class="stat-val">{stats.totalObservations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.knowledgeFacts')}</div></div>
          <div class="stat"><div class="stat-val">{stats.totalRelations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.connections')}</div></div>
          <div class="stat"><div class="stat-val">{stats.totalTags.toLocaleString()}</div><div class="stat-lbl">{t('analytics.topics')}</div></div>
        </div>
      )}

      {/* Row 2: Memory Loop hero — the value-proof KPI replacing the Health
          Score gauge as the dominant element on this tab. Health Score is
          retained below as a secondary card. */}
      {analytics && (
        <div style={{ marginTop: 8 }}>
          <MemoryLoopCard metric={analytics.loopMetric} />
        </div>
      )}

      {/* Row 2b (demoted): Health Score */}
      {analytics && (
        <div style={{ marginTop: 8 }}>
          <HealthScore score={analytics.healthScore} factors={analytics.healthFactors} />
        </div>
      )}

      {/* Row 3: Memory Timeline */}
      {analytics && (
        <div style={{ marginTop: 8 }}>
          <MemoryTimeline data={analytics.timeline} />
        </div>
      )}

      {/* Row 4: Age Matrix + Knowledge Radar (side by side on wide screens) */}
      {analytics && (
        <div style={{
          marginTop: 8,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 8,
        }}>
          <MemoryAgeMatrix data={analytics.ageMatrix ?? []} />
          <KnowledgeRadar data={analytics.knowledgeRadar ?? []} />
        </div>
      )}

      {/* Row 5: User Patterns */}
      {patterns && (
        <div style={{ marginTop: 8 }}>
          <UserPatterns data={patterns} />
        </div>
      )}

      {/* Row 5b: LLM telemetry — quantifies "memesh did X for you"
          across the 5 Smart-Mode flows. Renders even when other
          analytics fail; sourced from a separate endpoint. */}
      <div style={{ marginTop: 8 }}>
        <LlmTelemetryPanel />
      </div>

      {/* Row 6: Topics cloud */}
      {stats && (() => {
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
