import { t } from '../lib/i18n';

interface LoopMetric {
  reusedThisWeek: number;
  trend: Array<{ date: string; count: number }>;
  computedFrom: 'recall_hits' | 'last_accessed_at_approximation';
}

interface Props {
  metric: LoopMetric;
}

const SPARK_W = 220;
const SPARK_H = 36;
const SPARK_PAD = 2;

/**
 * Render a 30-day-window sparkline. Falls back to a single horizontal
 * baseline when there is no data so the layout doesn't shift.
 */
function Sparkline({ trend }: { trend: LoopMetric['trend'] }) {
  if (!trend || trend.length === 0) {
    return (
      <svg width={SPARK_W} height={SPARK_H} style={{ display: 'block' }}>
        <line x1={0} y1={SPARK_H / 2} x2={SPARK_W} y2={SPARK_H / 2} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
      </svg>
    );
  }
  // Single-point case: a one-day-old install has trend.length === 1, which
  // would degenerate into a zero-width path under the regular branch. Plot
  // the single point centred so it reads as "data exists, just not enough
  // for a curve yet" rather than an empty box.
  if (trend.length === 1) {
    const x = SPARK_W / 2;
    const y = SPARK_H / 2;
    return (
      <svg width={SPARK_W} height={SPARK_H} style={{ display: 'block' }}>
        <line x1={SPARK_PAD} y1={SPARK_H - SPARK_PAD} x2={SPARK_W - SPARK_PAD} y2={SPARK_H - SPARK_PAD} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        <circle cx={x} cy={y} r={3} fill="#00D6B4" />
      </svg>
    );
  }
  const maxCount = Math.max(1, ...trend.map((p) => p.count));
  const xStep = (SPARK_W - SPARK_PAD * 2) / (trend.length - 1);

  const points = trend.map((p, i) => {
    const x = SPARK_PAD + i * xStep;
    const y = SPARK_H - SPARK_PAD - (p.count / maxCount) * (SPARK_H - SPARK_PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  // Area path: line down to baseline + back to start
  const linePath = `M${points[0]} L${points.slice(1).join(' L')}`;
  const areaPath = `${linePath} L${SPARK_PAD + (trend.length - 1) * xStep},${SPARK_H - SPARK_PAD} L${SPARK_PAD},${SPARK_H - SPARK_PAD} Z`;

  return (
    <svg width={SPARK_W} height={SPARK_H} style={{ display: 'block' }}>
      <path d={areaPath} fill="rgba(0, 214, 180, 0.12)" />
      <path d={linePath} fill="none" stroke="#00D6B4" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {trend.map((_, i) => {
        const [xs, ys] = points[i].split(',');
        const isLast = i === trend.length - 1;
        return isLast ? <circle key={i} cx={xs} cy={ys} r={2.5} fill="#00D6B4" /> : null;
      })}
    </svg>
  );
}

export function MemoryLoopCard({ metric }: Props) {
  const { reusedThisWeek, trend, computedFrom } = metric;
  const isApprox = computedFrom === 'last_accessed_at_approximation';

  // Compute change vs prior 7 days for the small trend pill
  const prior7 = trend.slice(0, Math.max(0, trend.length - 7))
    .slice(-7)
    .reduce((s, p) => s + p.count, 0);
  const last7 = trend.slice(-7).reduce((s, p) => s + p.count, 0);
  const delta = prior7 > 0 ? Math.round(((last7 - prior7) / prior7) * 100) : null;

  return (
    <div
      class="card"
      style={{
        display: 'flex',
        gap: 24,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '20px 24px',
        background: 'linear-gradient(135deg, rgba(0, 214, 180, 0.06) 0%, rgba(0, 214, 180, 0.02) 100%)',
        border: '1px solid rgba(0, 214, 180, 0.18)',
      }}
    >
      <div style={{ flex: '1 1 200px', minWidth: 200 }}>
        <div
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-2)',
            fontWeight: 600,
            marginBottom: 6,
          }}
        >
          {t('loop.label')}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              lineHeight: 1,
              color: reusedThisWeek > 0 ? 'var(--accent)' : 'var(--text-2)',
              fontFamily: 'Satoshi, system-ui, sans-serif',
              letterSpacing: '-0.03em',
            }}
          >
            {reusedThisWeek > 0 ? reusedThisWeek.toLocaleString() : '—'}
          </div>
          {delta !== null && delta !== 0 && (
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'var(--mono)',
                color: delta > 0 ? '#4ADE80' : '#F87171',
              }}
            >
              {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}%
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-1)', marginTop: 4 }}>
          {reusedThisWeek > 0 ? t('loop.subtitleHas') : t('loop.subtitleNone')}
        </div>
        {isApprox && (
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6, fontStyle: 'italic' }}>
            {t('loop.approxNote')}
          </div>
        )}
      </div>

      <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <Sparkline trend={trend} />
        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
          {t('loop.sparkLabel')}
        </div>
      </div>
    </div>
  );
}
