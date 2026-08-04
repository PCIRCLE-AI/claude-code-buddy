import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';

interface PmAnalytics {
  velocity: { decisionsPerWeek: number; releasesPerMonth: number; windowDays: number };
  staleness: { stalePlanCount: number; openDecisionCount: number };
  connectedness: { orphanRate: number; totalRelations: number; activeEntities: number };
}

/** Every number this card renders, checked where it is read rather than where it is grouped. */
export function isPmAnalyticsRenderable(d: PmAnalytics | null): d is PmAnalytics {
  return (
    typeof d?.velocity?.decisionsPerWeek === 'number' &&
    typeof d.staleness?.openDecisionCount === 'number' &&
    typeof d.staleness?.stalePlanCount === 'number' &&
    typeof d.connectedness?.orphanRate === 'number' &&
    typeof d.connectedness?.totalRelations === 'number'
  );
}

export function PmAnalyticsPanel() {
  const [data, setData] = useState<PmAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // `api()` already unwraps the {success, data} envelope and returns
    // `json.data`, so the type argument is the PAYLOAD, not the envelope.
    // Declaring `{ data: PmAnalytics }` and then reading `r.data` unwrapped
    // twice: `data` stayed undefined, `if (!data) return null` always fired,
    // and this whole card silently never rendered while the server computed
    // it on every load.
    api<PmAnalytics>('GET', '/v1/analytics/pm')
      .then((r) => {
        // A rejected shape must not be silent: the request SUCCEEDED, so no
        // other path will ever log, and the card just never appears.
        if (r !== null && !isPmAnalyticsRenderable(r)) {
          console.warn('[PmAnalyticsPanel] /v1/analytics/pm answered, but with a shape this bundle cannot render — stale bundle or version skew, not an outage:', r);
        }
        setData(r);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    console.warn('[PmAnalyticsPanel]', error);
    return null;
  }
  // Guard the LEAVES, not the groups. `{}` is truthy, so checking that
  // `velocity` / `staleness` / `connectedness` merely exist admits a payload
  // whose groups are all present and all empty — and the next lines call
  // `data.velocity.decisionsPerWeek.toFixed(1)` on `undefined`. Two earlier
  // versions of this guard tightened one level at a time (`!data`, then the
  // three groups) and each was still one level short of the read.
  if (!isPmAnalyticsRenderable(data)) return null;

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
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {data.velocity.decisionsPerWeek.toFixed(1)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>decisions/week</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {data.staleness.openDecisionCount}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>open decisions (&gt;14d)</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)', color: orphanColor }}>
            {orphanPct}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>KG orphan rate</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>
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
