import { t } from '../lib/i18n';

interface EffectivenessEntry {
  name: string;
  type: string;
  hits: number;
  misses: number;
  hitRate: number;
}

interface Props {
  overallHitRate: number;
  totalHits: number;
  totalMisses: number;
  trackedEntities: number;
  topEffective: EffectivenessEntry[];
  mostIgnored: EffectivenessEntry[];
}

export function RecallEffectiveness({ overallHitRate, totalHits, totalMisses, trackedEntities, topEffective, mostIgnored }: Props) {
  const pct = Math.round(overallHitRate * 100);
  const total = totalHits + totalMisses;

  return (
    <div>
      <div class="stats-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div class="stat">
          <div class="stat-val" style={{ color: pct >= 50 ? 'var(--accent)' : 'var(--warning, #f59e0b)' }}>{pct}%</div>
          <div class="stat-lbl">{t('recall.effectiveness')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{totalHits}</div>
          <div class="stat-lbl">{t('recall.hits')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{totalMisses}</div>
          <div class="stat-lbl">{t('recall.misses')}</div>
        </div>
        <div class="stat">
          <div class="stat-val">{trackedEntities}</div>
          <div class="stat-lbl">{t('recall.tracked')}</div>
        </div>
      </div>

      {total > 0 && (
        <div class="card">
          <div class="card-title">{t('recall.hitRate')}</div>

          {/* Overall bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-0)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${pct}%`,
                  borderRadius: 3,
                  background: pct >= 50 ? 'rgba(0, 214, 180, 0.7)' : 'rgba(245, 158, 11, 0.7)',
                  transition: 'width 600ms ease-out',
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              {t('recall.summary', { used: totalHits, total })}
            </div>
          </div>

          {/* Top effective */}
          {topEffective.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6, fontWeight: 500 }}>{t('recall.mostEffective')}</div>
              {topEffective.slice(0, 3).map((e) => (
                <EntityBar key={e.name} entry={e} color="rgba(0, 214, 180, 0.6)" />
              ))}
            </div>
          )}

          {/* Most ignored */}
          {mostIgnored.length > 0 && mostIgnored[0].hitRate < 0.5 && (
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6, fontWeight: 500 }}>{t('recall.leastEffective')}</div>
              {mostIgnored.slice(0, 3).map((e) => (
                <EntityBar key={e.name} entry={e} color="rgba(245, 158, 11, 0.5)" />
              ))}
            </div>
          )}
        </div>
      )}

      {total === 0 && (
        <div class="card" style={{ textAlign: 'center', padding: '20px 16px' }}>
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {t('recall.noData')}
          </div>
        </div>
      )}
    </div>
  );
}

function EntityBar({ entry, color }: { entry: EffectivenessEntry; color: string }) {
  const pct = Math.round(entry.hitRate * 100);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
        <span style={{ fontSize: 12, color: 'var(--text-1)', maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.name}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
          {pct}% ({entry.hits}h/{entry.misses}m)
        </span>
      </div>
      <div style={{ height: 3, borderRadius: 2, background: 'var(--bg-0)' }}>
        <div style={{ height: '100%', width: `${pct}%`, borderRadius: 2, background: color, transition: 'width 600ms ease-out' }} />
      </div>
    </div>
  );
}
