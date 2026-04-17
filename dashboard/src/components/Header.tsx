import type { HealthData } from '../lib/api';
import { t } from '../lib/i18n';

export function Header({ health, error }: { health: HealthData | null; error: string }) {
  return (
    <div class="header">
      <div class="header-brand">
        <h1>MeMesh LLM Memory</h1>
        <small>{t('brand.subtitle')}</small>
      </div>
      <div class="header-right">
        <div class="header-meta">
          {health ? (
            <>
              <span><span class="dot dot-ok" />{t('header.connected')}</span>
              <span class="badge-version">v{health.version} · {health.entity_count.toLocaleString()} {t('header.memories')}</span>
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
