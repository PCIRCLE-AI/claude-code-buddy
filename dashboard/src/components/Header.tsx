import type { HealthData } from '../lib/api';
import { t, getLocale } from '../lib/i18n';
import { useSignalMode } from '../lib/signalMode';

export function Header({ health, error }: { health: HealthData | null; error: string }) {
  const [signalMode, setSignalMode] = useSignalMode();

  return (
    <div class="header">
      <div class="header-brand">
        <h1>MeMesh</h1>
        <small>{t('brand.subtitle')}</small>
      </div>
      <div class="header-right">
        <div class="header-meta">
          {/* Signal Mode toggle. Browse defaults to the knowledge cluster
              when ON; Graph default-hides noise types; Analytics scopes
              its own counts. The single source of truth lives in the
              `useSignalMode` hook so every tab sees the same value
              without prop-drilling. */}
          <button
            type="button"
            class="signal-toggle"
            onClick={() => setSignalMode(!signalMode)}
            aria-pressed={signalMode}
            title={t(signalMode ? 'header.signalModeOnHint' : 'header.signalModeOffHint')}
            style={{
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 'var(--radius)',
              border: `1px solid ${signalMode ? 'rgba(143, 242, 92, 0.4)' : 'var(--border)'}`,
              background: signalMode ? 'var(--life-soft)' : 'transparent',
              color: signalMode ? 'var(--life)' : 'var(--text-2)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span style={{ marginRight: 4 }}>{signalMode ? '●' : '○'}</span>
            {t(signalMode ? 'header.signalModeOn' : 'header.signalModeOff')}
          </button>
          {health ? (
            <>
              <span><span class="dot dot-ok" />{t('header.connected')}</span>
              <span class="badge-version">v{health.version} · {health.entity_count.toLocaleString(getLocale())} {t('header.memories')}</span>
            </>
          ) : error ? (
            <span><span class="dot dot-err" />{t('header.disconnected')}</span>
          ) : (
            <span style={{ color: 'var(--text-3)' }}>{t('header.connecting')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
