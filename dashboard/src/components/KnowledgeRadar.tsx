import { t } from '../lib/i18n';

interface RadarEntry { axis: string; count: number; types: string[] }

interface KnowledgeRadarProps {
  data: RadarEntry[];
}

/** Look up a localised label for a radar axis. Falls back to the raw
 *  `axis` value (e.g. "patterns") if the i18n key is missing — the
 *  i18n.ts catalogue defines a key per known axis. */
function axisLabel(axis: string): string {
  // No `|| axis` fallback: t() already falls back locale -> en -> key, so
  // the right-hand branch of `||` was unreachable (a non-empty string is
  // truthy). It read as a safety net and was not one — the same dead-branch
  // shape removed from AuthPrompt. tests/dashboard-i18n.test.ts fails the
  // build if a key is missing from the English catalogue.
  return t(`radar.axis.${axis}`);
}

const SIZE = 220;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 80;   // outer radius
const INNER = 14; // inner label padding

function polarToXY(angle: number, radius: number): [number, number] {
  // Start from top, go clockwise
  const rad = (angle - 90) * (Math.PI / 180);
  return [CX + radius * Math.cos(rad), CY + radius * Math.sin(rad)];
}

export function KnowledgeRadar({ data }: KnowledgeRadarProps) {
  if (!data || data.length === 0) return null;

  const n = data.length;
  const maxCount = Math.max(1, ...data.map(d => d.count));
  const angles = data.map((_, i) => (360 / n) * i);

  // Polygon points for the data shape
  const dataPoints = data.map((d, i) => {
    const ratio = d.count / maxCount;
    const r = INNER + ratio * (R - INNER);
    return polarToXY(angles[i], r);
  });
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ' Z';

  // Grid rings at 25% / 50% / 75% / 100%
  const rings = [0.25, 0.5, 0.75, 1.0];

  return (
    <div class="card">
      <div class="card-title" style={{ marginBottom: 8 }}>{t('radar.title')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          style={{ flexShrink: 0 }}
        >
          {/* Grid rings */}
          {rings.map(ratio => {
            const pts = angles.map(a => {
              const r = INNER + ratio * (R - INNER);
              const [x, y] = polarToXY(a, r);
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            });
            return (
              <polygon
                key={ratio}
                points={pts.join(' ')}
                fill="none"
                stroke="rgba(255,255,255,0.06)"
                strokeWidth={1}
              />
            );
          })}

          {/* Spokes */}
          {angles.map((angle, i) => {
            const [x, y] = polarToXY(angle, R);
            return (
              <line
                key={i}
                x1={CX}
                y1={CY}
                x2={x.toFixed(1)}
                y2={y.toFixed(1)}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth={1}
              />
            );
          })}

          {/* Data polygon */}
          <path
            d={dataPath}
            fill="rgba(0,214,180,0.15)"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />

          {/* Data points */}
          {dataPoints.map(([x, y], i) => (
            <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={3} fill="var(--accent)" />
          ))}

          {/* Axis labels */}
          {data.map((d, i) => {
            const angle = angles[i];
            const [x, y] = polarToXY(angle, R + 18);
            const label = axisLabel(d.axis);
            return (
              <text
                key={i}
                x={x.toFixed(1)}
                y={y.toFixed(1)}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={9}
                fill="var(--text-2)"
                fontFamily="var(--font)"
              >
                {label}
              </text>
            );
          })}
        </svg>

        {/* Legend */}
        <div style={{ flex: 1, minWidth: 120 }}>
          {data.map(d => {
            const ratio = maxCount > 0 ? d.count / maxCount : 0;
            return (
              <div key={d.axis} style={{ marginBottom: 8 }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 11,
                  marginBottom: 3,
                }}>
                  <span style={{ color: 'var(--text-1)' }}>{axisLabel(d.axis)}</span>
                  <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                    {d.count}
                  </span>
                </div>
                <div style={{
                  height: 3,
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: 'var(--radius-hairline)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${(ratio * 100).toFixed(1)}%`,
                    height: '100%',
                    background: 'var(--accent)',
                    borderRadius: 'var(--radius-hairline)',
                    transition: 'width 0.3s',
                  }} />
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
            {t('radar.caption')}
          </div>
        </div>
      </div>
    </div>
  );
}
