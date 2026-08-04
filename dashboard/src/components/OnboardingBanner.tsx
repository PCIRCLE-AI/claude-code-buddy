import { useEffect, useState } from 'preact/hooks';
import { api, type HealthData } from '../lib/api';
import { t } from '../lib/i18n';
import { actionFailureMessage } from '../lib/failure';

const DISMISS_KEY = 'memesh.onboardingDismissed';

interface Props {
  health: HealthData | null;
}

interface SeedResult {
  inserted: number;
  removed: number;
}

/**
 * SDD plan SPEC-4: a fresh install with 0 memories renders empty
 * charts in every tab — first-impression confusion. This banner
 * surfaces above the tab nav whenever `entity_count === 0` AND the
 * user has not previously dismissed it.
 *
 * One-click affordance: a user staring at empty charts should not
 * have to open a terminal to bootstrap. The "Try the demo" button
 * POSTs `/v1/demo/seed` and dispatches `memesh:data-changed` so the
 * dashboard refetches `/v1/health`; the banner then auto-retires
 * once entity_count climbs above zero. CLI users still have
 * `memesh demo` for headless / CI flows; the on-screen code chips
 * are kept as power-user reference, not the primary path.
 *
 * Dismissal is local-only (`localStorage.memesh.onboardingDismissed`).
 * Once the user runs the demo or stores a real memory the entity
 * count climbs above zero and the banner stops rendering by itself.
 */
export function OnboardingBanner({ health }: Props) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === 'true'; } catch { return false; }
  });
  const [pending, setPending] = useState<'seed' | 'reset' | null>(null);
  const [error, setError] = useState<string>('');

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

  async function runSeed() {
    setError('');
    setPending('seed');
    try {
      await api<SeedResult>('POST', '/v1/demo/seed');
      // Tell App + every other tab to refetch — `/v1/health`
      // entity_count will now be 30 and the banner auto-retires.
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      // Localized sentence with a next step — never the browser's raw
      // "Failed to fetch" for a server that simply is not running.
      setError(actionFailureMessage(e));
    } finally {
      // Clear regardless of outcome. On success the banner unmounts
      // a moment later when health refetch lands; if that refetch
      // fails or is slow, we still want the buttons re-enabled so
      // the user can retry instead of being stuck in "Seeding…".
      setPending(null);
    }
  }

  async function runReset() {
    if (!confirm(t('onboarding.resetConfirm'))) return;
    setError('');
    setPending('reset');
    try {
      await api<SeedResult>('POST', '/v1/demo/reset');
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      setPending(null);
    }
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
        borderRadius: 'var(--radius)',
        background: 'var(--accent-soft)', /* flattened: a decorative gradient is ornament (DESIGN.md) */
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
      {/* #31 — set expectation up-front: nothing here requires an LLM. */}
      <div style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--text-3)', marginTop: 4 }}>
        {t('onboarding.llmHint')}
      </div>

      {/* Primary one-click affordance — no terminal required. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, alignItems: 'center' }}>
        <button
          type="button"
          class="btn btn-primary"
          onClick={runSeed}
          disabled={pending !== null}
          style={{ minWidth: 160 }}
        >
          {pending === 'seed' ? t('onboarding.seedingButton') : t('onboarding.seedButton')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {t('onboarding.seedHint')}
        </span>
      </div>

      {/* Power-user CLI reference — kept for headless / CI flows. */}
      <details style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
        <summary style={{ cursor: 'pointer' }}>{t('onboarding.cliReference')}</summary>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
          <code
            style={{
              padding: '6px 10px',
              background: 'rgba(0, 0, 0, 0.3)',
              border: '1px solid rgba(0, 214, 180, 0.20)',
              borderRadius: 'var(--radius-xs)',
              color: 'var(--accent)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
            }}
          >
            memesh demo
          </code>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('onboarding.hintDemo')}
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, alignItems: 'center' }}>
          <code
            style={{
              padding: '6px 10px',
              background: 'rgba(0, 0, 0, 0.3)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xs)',
              color: 'var(--text-2)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
            }}
          >
            memesh demo --reset --yes
          </code>
          <button
            type="button"
            class="btn"
            onClick={runReset}
            disabled={pending !== null}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            {pending === 'reset' ? t('onboarding.resettingButton') : t('onboarding.resetButton')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('onboarding.hintReset')}
          </span>
        </div>
      </details>

      {error && (
        // role="alert" alone: it already implies aria-live="assertive",
        // and pairing it with an explicit aria-live="polite" told screen
        // readers two contradictory politeness levels for one region.
        <div
          role="alert"
          style={{ marginTop: 10, fontSize: 12, color: 'var(--danger)' }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
