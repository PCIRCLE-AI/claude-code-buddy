import { t } from '../lib/i18n';

interface Props {
  totalRecalls: number;
  lessonsWithWarnings: number;
  lessonCount: number;
  typeDistribution: Array<{ type: string; count: number }>;
}

export function ValueMetrics({ totalRecalls, lessonsWithWarnings, lessonCount, typeDistribution }: Props) {
  const top8 = typeDistribution.slice(0, 8);
  const total = top8.reduce((sum, d) => sum + d.count, 0);

  return (
    <div>
      <div class="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div class="stat">
          <div class="stat-val">{totalRecalls.toLocaleString()}</div>
          <div class="stat-lbl">{t('value.totalRecalls')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{lessonCount}</div>
          <div class="stat-lbl">{t('value.lessonsLearned')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{lessonsWithWarnings}</div>
          <div class="stat-lbl">{t('value.lessonsWithWarnings')}</div>
        </div>
      </div>

      {top8.length > 0 && (
        <div class="card">
          <div class="card-title">{t('value.coverage')}</div>
          {top8.map((d) => {
            const pct = total > 0 ? Math.round((d.count / total) * 100) : 0;
            return (
              <div key={d.type} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{d.type}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-3)' }}>
                    {d.count} ({pct}%)
                  </span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-0)' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      borderRadius: 2,
                      background: 'rgba(0, 214, 180, 0.6)',
                      transition: 'width 600ms ease-out',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
