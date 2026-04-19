import type { PatternsData } from '../lib/api';
import { t } from '../lib/i18n';

interface Props {
  data: PatternsData;
}

export function UserPatterns({ data }: Props) {
  const { workSchedule, toolPreferences, focusAreas, workflow, strengths, learningAreas } = data;

  // Build hour heatmap data (0-23)
  const hourMap = new Map<number, number>();
  for (const h of workSchedule.hourDistribution) hourMap.set(h.hour, h.count);
  const maxHourCount = Math.max(1, ...workSchedule.hourDistribution.map((h) => h.count));

  // Find peak hours (top 3)
  const peakHours = [...workSchedule.hourDistribution]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((h) => `${h.hour.toString().padStart(2, '0')}:00`);

  // Find busiest days (top 2)
  const busiestDays = [...workSchedule.dayDistribution]
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((d) => d.day);

  return (
    <div class="card">
      <div class="card-title">{t('patterns.title')}</div>

      {/* Work Schedule Heatmap */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          marginBottom: 8,
        }}>
          {t('patterns.workSchedule')}
        </div>
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {Array.from({ length: 24 }, (_, hour) => {
            const count = hourMap.get(hour) || 0;
            const intensity = count / maxHourCount;
            return (
              <div
                key={hour}
                title={`${hour.toString().padStart(2, '0')}:00 — ${count}`}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 'var(--radius-xs)',
                  background: intensity > 0
                    ? `rgba(0, 214, 180, ${0.1 + intensity * 0.7})`
                    : 'var(--bg-0)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: intensity > 0.5 ? 'var(--bg-0)' : 'var(--text-3)',
                  fontFamily: 'var(--mono)',
                }}
              >
                {hour}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, fontFamily: 'var(--mono)' }}>
          {t('patterns.peakHours')}: {peakHours.join(', ')}
          {busiestDays.length > 0 && (
            <span> · {t('patterns.busiestDays')}: {busiestDays.join(', ')}</span>
          )}
        </div>
      </div>

      {/* Top Tools */}
      {toolPreferences.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            marginBottom: 8,
          }}>
            {t('patterns.tools')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {toolPreferences.slice(0, 10).map((tp) => (
              <span
                key={tp.tool}
                class="tag"
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                {tp.tool} <span style={{ opacity: 0.5 }}>({tp.sessions})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Workflow Stats */}
      <div style={{ marginBottom: 16 }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          marginBottom: 8,
        }}>
          {t('patterns.workflow')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div class="stat" style={{ padding: 12 }}>
            <div class="stat-val" style={{ fontSize: 18 }}>
              {workflow.avgSessionMinutes > 0 ? `${Math.round(workflow.avgSessionMinutes)}m` : '—'}
            </div>
            <div class="stat-lbl">{t('patterns.avgSession')}</div>
          </div>
          <div class="stat" style={{ padding: 12 }}>
            <div class="stat-val" style={{ fontSize: 18 }}>
              {workflow.totalSessions > 0 ? workflow.commitsPerSession.toFixed(1) : '—'}
            </div>
            <div class="stat-lbl">{t('patterns.commitsPerSession')}</div>
          </div>
        </div>
      </div>

      {/* Focus Areas */}
      {focusAreas.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            marginBottom: 8,
          }}>
            {t('patterns.focus')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {focusAreas.slice(0, 12).map((fa) => (
              <span
                key={fa.type}
                class="tag"
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                {fa.type} <span style={{ opacity: 0.5 }}>({fa.count})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Strengths & Learning Areas */}
      {(strengths.length > 0 || learningAreas.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* Strengths */}
          <div>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: '.06em',
              marginBottom: 8,
            }}>
              {t('patterns.strengths')}
            </div>
            {strengths.slice(0, 5).map((s) => (
              <div key={s.type} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-1)' }}>{s.type}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)' }}>
                    {Math.round(s.avgConfidence * 100)}%
                  </span>
                </div>
                <div style={{ height: 3, borderRadius: 2, background: 'var(--bg-0)' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.round(s.avgConfidence * 100)}%`,
                    borderRadius: 2,
                    background: 'rgba(0, 214, 180, 0.5)',
                    transition: 'width 600ms ease-out',
                  }} />
                </div>
              </div>
            ))}
            {strengths.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>—</div>
            )}
          </div>

          {/* Learning Areas */}
          <div>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: '.06em',
              marginBottom: 8,
            }}>
              {t('patterns.learning')}
            </div>
            {learningAreas.slice(0, 5).map((la) => (
              <div
                key={la.tag}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6,
                  fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--text-1)' }}>{la.tag}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
                  {la.count}
                </span>
              </div>
            ))}
            {learningAreas.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>—</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
