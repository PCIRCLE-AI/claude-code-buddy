import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';

interface PmAnalytics {
  velocity: { decisionsPerWeek: number; releasesPerMonth: number; windowDays: number };
  staleness: { stalePlanCount: number; openDecisionCount: number };
  connectedness: { orphanRate: number; totalRelations: number; activeEntities: number };
}

export function PmAnalyticsPanel() {
  const [data, setData] = useState<PmAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: PmAnalytics }>('GET', '/v1/analytics/pm')
      .then((r) => setData(r.data))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    console.warn('[PmAnalyticsPanel]', error);
    return null;
  }
  if (!data) return null;

  const orphanPct = (data.connectedness.orphanRate * 100).toFixed(1);
  const orphanColor =
    data.connectedness.orphanRate > 0.7 ? '#ef4444'
    : data.connectedness.orphanRate > 0.4 ? '#f59e0b'
    : '#22c55e';

  return (
    <div class="card" style={{ marginTop: 8, padding: 16 }}>
      <div class="card-title" style={{ marginBottom: 12 }}>PM Metrics</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
            {data.velocity.decisionsPerWeek.toFixed(1)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>decisions/week</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
            {data.staleness.openDecisionCount}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>open decisions (&gt;14d)</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: orphanColor }}>
            {orphanPct}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>KG orphan rate</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
            {data.connectedness.totalRelations}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>relations total</div>
        </div>
      </div>
      {data.staleness.stalePlanCount > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: '#f59e0b' }}>
          {data.staleness.stalePlanCount} plan{data.staleness.stalePlanCount > 1 ? 's' : ''} not reviewed in 30+ days
        </div>
      )}
    </div>
  );
}
