import { useState, useEffect } from 'preact/hooks';
import { api, type StatsData, type Entity } from '../lib/api';

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
  if (!stats) return <div class="error-box">Failed to load analytics</div>;

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
        <div class="stat"><div class="stat-val">{stats.totalEntities.toLocaleString()}</div><div class="stat-lbl">Total Memories</div></div>
        <div class="stat"><div class="stat-val">{stats.totalObservations.toLocaleString()}</div><div class="stat-lbl">Knowledge Facts</div></div>
        <div class="stat"><div class="stat-val">{stats.totalRelations.toLocaleString()}</div><div class="stat-lbl">Connections</div></div>
        <div class="stat"><div class="stat-val">{stats.totalTags.toLocaleString()}</div><div class="stat-lbl">Topics</div></div>
      </div>

      {/* Insights */}
      <div class="card">
        <div class="card-title">Insights</div>
        <div class="insight">
          <span class="insight-icon">📝</span>
          <span class="insight-text">This week</span>
          <span class="insight-val">{thisWeek} new</span>
        </div>
        <div class="insight">
          <span class="insight-icon">💤</span>
          <span class="insight-text">Stale (30+ days unused)</span>
          <span class="insight-val">{stale}</span>
        </div>
        <div class="insight">
          <span class="insight-icon">📦</span>
          <span class="insight-text">Archived</span>
          <span class="insight-val">{archivedCount}</span>
        </div>
      </div>

      {/* Top recalled */}
      {topRecalled.length > 0 && (
        <div class="card">
          <div class="card-title">Most Recalled</div>
          {topRecalled.map((e, i) => (
            <div key={e.id} class="insight">
              <span class="insight-icon" style={{ fontSize: 14, color: 'var(--text-3)' }}>#{i + 1}</span>
              <span class="insight-text" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.observations?.[0] || e.name}
              </span>
              <span class="insight-val">{e.access_count}×</span>
            </div>
          ))}
        </div>
      )}

      {/* Topics */}
      {stats.tagDistribution.length > 0 && (
        <div class="card">
          <div class="card-title">Topics</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {stats.tagDistribution.slice(0, 30).map((t) => (
              <span key={t.tag} class="tag" style={{ fontSize: Math.max(11, Math.min(16, 10 + t.count)) + 'px' }}>
                {t.tag} <span style={{ opacity: 0.5 }}>({t.count})</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
