import { useMemo } from 'preact/hooks';
import type { Entity } from '../lib/api';
import { clusterOf, CLUSTER_DOT, type TypeCluster } from '../lib/entity-display';
import { t } from '../lib/i18n';

/**
 * Capture density by category — a per-project histogram of WHEN memories
 * were captured, split by type cluster.
 *
 * The name is the honesty contract: this measures what memesh CAPTURED,
 * not what happened. A quiet stretch on the band is a capture gap (hooks
 * off, work done elsewhere), not proof the project slept — the label says
 * so (`roadmap.densityNote`) and stays visible next to the band.
 *
 * Buckets are derived from `created_at` — the same field the roadmap's
 * phase segmentation uses — so the band and the phase strip describe one
 * timeline. (The flat fallback list groups by last_accessed; do not
 * "align" the band to that, it is a different axis.)
 *
 * Rendering follows DESIGN.md's composition-bar precedent: the bar itself
 * is aria-hidden ornament over data; the visible text (title, note,
 * legend counts) carries everything a screen reader needs. Bucket height
 * is linear in count — luminance/height carry data or they do not appear.
 */

const CLUSTERS: TypeCluster[] = ['knowledge', 'activity', 'session', 'reference'];
const BAND_HEIGHT = 34;
/** Upper bound on bucket count; the size ladder below keeps real spans
 *  well under it, this is the guard for degenerate date data. */
const MAX_BUCKETS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

interface Bucket {
  startMs: number;
  counts: Record<TypeCluster, number>;
  total: number;
}

function bucketSizeMs(spanMs: number): number {
  const spanDays = spanMs / DAY_MS;
  if (spanDays <= 31) return DAY_MS;
  if (spanDays <= 217) return 7 * DAY_MS;
  return 30 * DAY_MS;
}

export function deriveBuckets(entities: Entity[]): Bucket[] {
  const times = entities
    .map((e) => new Date(e.created_at).getTime())
    .filter((ms) => Number.isFinite(ms));
  if (times.length === 0) return [];
  const first = Math.min(...times);
  const last = Math.max(...times);
  const size = bucketSizeMs(Math.max(last - first, 1));
  const count = Math.min(Math.floor((last - first) / size) + 1, MAX_BUCKETS);
  const buckets: Bucket[] = Array.from({ length: count }, (_, i) => ({
    startMs: first + i * size,
    counts: { knowledge: 0, activity: 0, session: 0, reference: 0 },
    total: 0,
  }));
  for (const e of entities) {
    const ms = new Date(e.created_at).getTime();
    if (!Number.isFinite(ms)) continue;
    const idx = Math.min(Math.floor((ms - first) / size), count - 1);
    buckets[idx].counts[clusterOf(e.type)]++;
    buckets[idx].total++;
  }
  return buckets;
}

export function CaptureDensityBand({ entities }: { entities: Entity[] }) {
  const buckets = useMemo(() => deriveBuckets(entities), [entities]);
  const clusterTotals = useMemo(() => {
    const totals: Record<TypeCluster, number> = { knowledge: 0, activity: 0, session: 0, reference: 0 };
    for (const b of buckets) for (const c of CLUSTERS) totals[c] += b.counts[c];
    return totals;
  }, [buckets]);

  if (buckets.length === 0) return null;
  const max = Math.max(...buckets.map((b) => b.total), 1);

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-ui)' }}>
          {t('roadmap.densityTitle')}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{t('roadmap.densityNote')}</span>
      </div>
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 1,
          height: BAND_HEIGHT,
          background: 'var(--bg-0)',
          borderRadius: 'var(--radius-hairline)',
          padding: '2px 2px 0',
        }}
      >
        {buckets.map((b, i) => (
          <div
            key={i}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: 0 }}
          >
            {CLUSTERS.map((c) => b.counts[c] > 0 && (
              <div
                key={c}
                style={{
                  height: Math.max((b.counts[c] / max) * (BAND_HEIGHT - 2), 1),
                  background: CLUSTER_DOT[c],
                  borderRadius: 'var(--radius-hairline)',
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
        {CLUSTERS.map((c) => clusterTotals[c] > 0 && (
          <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-ui)' }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 'var(--radius-hairline)', background: CLUSTER_DOT[c], flexShrink: 0 }} />
            {t(`cluster.${c}`)}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, opacity: 0.7 }}>{clusterTotals[c]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
