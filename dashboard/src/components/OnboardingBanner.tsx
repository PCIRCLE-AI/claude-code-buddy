import { useEffect, useState } from 'preact/hooks';
import type { HealthData } from '../lib/api';
import { t } from '../lib/i18n';

const DISMISS_KEY = 'memesh.onboardingDismissed';

interface Props {
  health: HealthData | null;
}

/**
 * SDD plan SPEC-4: a fresh install with 0 memories renders empty
 * charts in every tab — first-impression confusion. This banner
 * surfaces above the tab nav whenever `entity_count === 0` AND the
 * user has not previously dismissed it.
 *
 * Dismissal is local-only (`localStorage.memesh.onboardingDismissed`).
 * Once the user runs `memesh demo` or stores a real memory the
 * entity count climbs above zero and the banner stops rendering by
 * itself — no need to also clear the flag.
 */
export function OnboardingBanner({ health }: Props) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === 'true'; } catch { return false; }
  });

  // If the dataset transitions from empty to non-empty, hide the
  // banner immediately — even before the user dismisses — so the
  // "demo command finished" experience is not the banner persisting.
  useEffect(() => {
    if (health && health.entity_count > 0) setDismissed(true);
  }, [health?.entity_count]);

  if (!health) return null;
  if (health.entity_count > 0) return null;
  if (dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, 'true'); } catch { /* private mode */ }
  }

  return (
    <div
      role="region"
      aria-label={t('onboarding.title')}
      style={{
        position: 'relative',
        margin: '12px auto 8px',
        maxWidth: 920,
        padding: '14px 18px',
        border: '1px solid rgba(0, 214, 180, 0.28)',
        borderRadius: 8,
        background: 'linear-gradient(135deg, rgba(0, 214, 180, 0.10) 0%, rgba(0, 214, 180, 0.02) 100%)',
        color: 'var(--text-1)',
      }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('onboarding.dismiss')}
        style={{
          position: 'absolute',
          top: 8,
          right: 10,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-3)',
          fontSize: 18,
          lineHeight: 1,
          cursor: 'pointer',
          padding: 4,
        }}
      >
        ×
      </button>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-0)', marginBottom: 6 }}>
        {t('onboarding.title')}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-1)' }}>
        {t('onboarding.body')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
        <code
          style={{
            padding: '6px 10px',
            background: 'rgba(0, 0, 0, 0.3)',
            border: '1px solid rgba(0, 214, 180, 0.20)',
            borderRadius: 4,
            color: 'var(--accent)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        >
          memesh demo
        </code>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {t('onboarding.hintDemo')}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
        <code
          style={{
            padding: '6px 10px',
            background: 'rgba(0, 0, 0, 0.3)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            color: 'var(--text-2)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        >
          memesh demo --reset --yes
        </code>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('onboarding.hintReset')}
        </span>
      </div>
    </div>
  );
}
