import { useState, useEffect } from 'preact/hooks';
import { api, type StatsData, type Entity } from '../lib/api';
import { t } from '../lib/i18n';

export function AnalyticsTab() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api<StatsData>('GET', '/v1/stats'),
      api<Entity[]>('GET', '/v1/entities?limit=500&status=all'),
    ]).then(([s, e]) => {
      setStats(s);
      setEntities(e || []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div class="empty"><div class="loading" /></div>;
  if (!stats) return <div class="error-box">{t('common.error')}: Failed to load analytics</div>;

  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const monthMs = 30 * 24 * 60 * 60 * 1000;

  const thisWeek = entities.filter((e) => now - new Date(e.created_at).getTime() < weekMs).length;
  const stale = entities.filter((e) => {
    if (e.archived || e.status === 'archived') return false;
    if (!e.last_accessed_at) return true;
    return now - new Date(e.last_accessed_at).getTime() > monthMs;
  }).length;
  const archivedCount = entities.filter((e) => e.archived || e.status === 'archived').length;
  const topRecalled = entities
    .filter((e) => (e.access_count || 0) > 0)
    .sort((a, b) => (b.access_count || 0) - (a.access_count || 0))
    .slice(0, 5);

  return (
    <div>
      {/* Stats row */}
      <div class="stats-row">
        <div class="stat"><div class="stat-val">{stats.totalEntities.toLocaleString()}</div><div class="stat-lbl">{t('analytics.totalMemories')}</div></div>
        <div class="stat"><div class="stat-val">{stats.totalObservations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.knowledgeFacts')}</div></div>
        <div class="stat"><div class="stat-val">{stats.totalRelations.toLocaleString()}</div><div class="stat-lbl">{t('analytics.connections')}</div></div>
        <div class="stat"><div class="stat-val">{stats.totalTags.toLocaleString()}</div><div class="stat-lbl">{t('analytics.topics')}</div></div>
      </div>

      {/* Insights */}
      <div class="card">
        <div class="card-title">{t('analytics.insights')}</div>
        <div class="insight">
          <span class="insight-icon">📝</span>
          <span class="insight-text">{t('analytics.thisWeek')}</span>
          <span class="insight-val">{thisWeek} {t('analytics.new')}</span>
        </div>
        <div class="insight">
          <span class="insight-icon">💤</span>
          <span class="insight-text">{t('analytics.stale')}</span>
          <span class="insight-val">{stale}</span>
        </div>
        <div class="insight">
          <span class="insight-icon">📦</span>
          <span class="insight-text">{t('analytics.archivedLabel')}</span>
          <span class="insight-val">{archivedCount}</span>
        </div>
      </div>

      {/* Top recalled — show meaningful preview, not raw commit hashes */}
      {topRecalled.length > 0 && (
        <div class="card">
          <div class="card-title">{t('analytics.mostRecalled')}</div>
          {topRecalled.map((e, i) => {
            // Find the most meaningful observation (skip raw commit/session metadata)
            const skipPrefixes = ['Commit:', '[SESSION]', 'Branch:', 'Diff stats:', 'Details:', '[WORK]', '[FOCUS]', '[SUMMARY]', 'Session edited', 'Total tool calls', 'Duration:'];
            const preview = (e.observations || []).find(o =>
              !skipPrefixes.some(p => o.startsWith(p)) && o.length > 10
            ) || e.observations?.[0] || e.name;
            const truncated = preview.length > 80 ? preview.slice(0, 80) + '…' : preview;
            return (
              <div key={e.id} class="insight">
                <span class="insight-icon" style={{ fontSize: 14, color: 'var(--text-3)' }}>#{i + 1}</span>
                <span class="insight-text" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {truncated}
                </span>
                <span class="insight-val">{e.access_count}×</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Topics — filter out internal/system tags, show only user-meaningful ones */}
      {(() => {
        const internalPrefixes = ['auto_saved', 'auto-tracked', 'session_end', 'session:', 'source:', 'scope:', 'date:', 'urgency:'];
        const userTags = stats.tagDistribution.filter(tg =>
          !internalPrefixes.some(p => tg.tag.startsWith(p)) &&
          !/^\d{4}-\d{2}-\d{2}/.test(tg.tag)  // filter date-only tags like "2026-03-26"
        );
        return userTags.length > 0 ? (
          <div class="card">
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
