import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

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
  // Three outcomes used to render the same thing — nothing.
  //
  // A failed request, a request still in flight, and a reply this bundle
  // cannot read all ended at `return null`, so the card simply was not
  // there. The user cannot tell "still loading" from "the server is down"
  // from "your dashboard is older than your server" when all three look like
  // an absence, and there is nothing to click, retry or report. The sibling
  // on the same tab (`AnalyticsTab`) already renders a spinner and an
  // `role="alert"` box for exactly these two cases.
  const [loading, setLoading] = useState(true);

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
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div class="empty"><div class="loading" /></div>;

  if (error) {
    console.warn('[PmAnalyticsPanel]', error);
    // role="alert" per DESIGN.md: a box that stands in for content has to
    // announce itself to a screen reader rather than repaint silently.
    return (
      <div class="error-box" role="alert">
        {`${t('common.error')}: ${t('analytics.loadFailed')}`}
      </div>
    );
  }
  // Guard the LEAVES, not the groups. `{}` is truthy, so checking that
  // `velocity` / `staleness` / `connectedness` merely exist admits a payload
  // whose groups are all present and all empty — and the next lines call
  // `data.velocity.decisionsPerWeek.toFixed(1)` on `undefined`. Two earlier
  // versions of this guard tightened one level at a time (`!data`, then the
  // three groups) and each was still one level short of the read.
  if (!isPmAnalyticsRenderable(data)) {
    // The request SUCCEEDED and the reply is unreadable — a stale bundle
    // against a newer server, or the reverse. Saying so is the difference
    // between "reload the page" and "memesh is broken": the console warning
    // above is for whoever opens the console, and this is for everyone else.
    return (
      <div class="error-box" role="alert">
        {`${t('common.error')}: ${t('analytics.unreadable')}`}
      </div>
    );
  }

  const orphanPct = (data.connectedness.orphanRate * 100).toFixed(1);
  const orphanColor =
    data.connectedness.orphanRate > 0.7 ? 'var(--danger)'
    : data.connectedness.orphanRate > 0.4 ? 'var(--warning)'
    : 'var(--success)';

  return (
    <div class="card" style={{ marginTop: 8, padding: 16 }}>
      <div class="card-title" style={{ marginBottom: 12 }}>{t('pm.title')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {data.velocity.decisionsPerWeek.toFixed(1)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{t('pm.decisionsPerWeek')}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {data.staleness.openDecisionCount}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{t('pm.openDecisions')}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)', color: orphanColor }}>
            {orphanPct}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{t('pm.orphanRate')}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--mono)' }}>
            {data.connectedness.totalRelations}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{t('pm.relationsTotal')}</div>
        </div>
      </div>
      {data.staleness.stalePlanCount > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--warning)' }}>
          {t('pm.stalePlans', { count: data.staleness.stalePlanCount })}
        </div>
      )}
    </div>
  );
}
