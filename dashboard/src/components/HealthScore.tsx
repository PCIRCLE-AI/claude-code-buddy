import { t } from '../lib/i18n';

interface Props {
  score: number;  // 0-100
  factors: { activity: number; quality: number; freshness: number; lessons: number }; // each 0-100
}

function scoreColor(value: number): string {
  if (value >= 80) return 'var(--success)';
  if (value >= 60) return 'var(--accent)';
  if (value >= 40) return 'var(--warning)';
  return 'var(--danger)';
}

function scoreLabel(value: number): string {
  if (value >= 80) return t('health.excellent');
  if (value >= 60) return t('health.good');
  if (value >= 40) return t('health.fair');
  return t('health.poor');
}

const factorKeys = ['activity', 'quality', 'freshness', 'lessons'] as const;

export function HealthScore({ score, factors }: Props) {
  const color = scoreColor(score);

  return (
    <div class="card">
      <div class="card-title">{t('health.title')}</div>
      <div style={{
        display: 'flex',
        gap: '24px',
        alignItems: 'center',
      }}>
        {/* Left: circular score */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          flexShrink: 0,
        }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            border: `3px solid ${color}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: '24px',
              fontWeight: 700,
              color,
              letterSpacing: '-0.02em',
            }}>
              {score}
            </span>
          </div>
          <span style={{
            marginTop: '6px',
            fontSize: '11px',
            fontWeight: 500,
            color: 'var(--text-2)',
          }}>
            {scoreLabel(score)}
          </span>
        </div>

        {/* Right: factor bars */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {factorKeys.map((key) => {
            const value = factors[key];
            const barColor = scoreColor(value);
            return (
              <div key={key}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '4px',
                }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                    {t(`health.${key}`)}
                  </span>
                  <span style={{
                    fontFamily: 'var(--mono)',
                    fontSize: '11px',
                    color: 'var(--text-3)',
                  }}>
                    {value}%
                  </span>
                </div>
                <div style={{
                  height: '4px',
                  borderRadius: '2px',
                  background: 'var(--bg-0)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${value}%`,
                    borderRadius: '2px',
                    background: barColor,
                    transition: 'width 600ms ease-out',
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
