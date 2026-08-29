import { useState } from 'preact/hooks';
import { api, type HealthData } from '../lib/api';
import { t } from '../lib/i18n';
import { actionFailureMessage } from '../lib/failure';
import { TerminalHandoff } from './ExternalHandoff';

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
 * dashboard refetches `/v1/health`; the welcome content then becomes
 * a compact demo-only cleanup surface while demo_entity_count remains
 * above zero. CLI users still have
 * `memesh demo` for headless / CI flows; the on-screen code chips
 * are kept as power-user reference, not the primary path.
 *
 * Dismissal is local-only (`localStorage.memesh.onboardingDismissed`).
 * Dismissal hides only the empty-library welcome. A populated library
 * with demo-tagged rows always keeps its scoped cleanup action visible.
 */
export function OnboardingBanner({ health }: Props) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === 'true'; } catch { return false; }
  });
  const [pending, setPending] = useState<'seed' | 'reset' | null>(null);
  const [error, setError] = useState<string>('');

  if (!health) return null;
  const demoCount = health.demo_entity_count ?? 0;
  const showOnboarding = health.entity_count === 0 && !dismissed;
  const showDemoCleanup = demoCount > 0;
  if (!showOnboarding && !showDemoCleanup) return null;

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
      // entity_count and demo_entity_count will now move the region from
      // empty-library onboarding to the compact cleanup state.
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      // Localized sentence with a next step — never the browser's raw
      // "Failed to fetch" for a server that simply is not running.
      setError(actionFailureMessage(e));
    } finally {
      // Clear regardless of outcome. If the health refetch fails or is slow,
      // we still want the buttons re-enabled so
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
      const readback = await api<HealthData>('GET', '/v1/health');
      if ((readback.demo_entity_count ?? 0) !== 0) {
        throw new Error(t('onboarding.resetReadbackFailed'));
      }
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
      aria-label={showDemoCleanup ? t('onboarding.demoLoadedTitle') : t('onboarding.title')}
      style={{
        position: 'relative',
        margin: '12px auto 8px',
        maxWidth: 920,
        padding: '14px 18px',
        border: '1px solid rgba(143, 242, 92, 0.28)',
        borderRadius: 'var(--radius)',
        background: 'var(--life-soft)', /* flattened: a decorative gradient is ornament (DESIGN.md) */
        color: 'var(--text-1)',
      }}
    >
      {showOnboarding && (
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
      )}
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-0)', marginBottom: 6 }}>
        {showDemoCleanup ? t('onboarding.demoLoadedTitle') : t('onboarding.title')}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-1)' }}>
        {showDemoCleanup ? t('onboarding.demoLoadedBody', { count: demoCount }) : t('onboarding.body')}
      </div>
      {showOnboarding && (
        <ul style={{ fontSize: 11, lineHeight: 1.55, color: 'var(--text-3)', margin: '6px 0 0', paddingLeft: 18 }}>
          <li>{t('onboarding.coreHint')}</li>
          <li>{t('onboarding.semanticHint')}</li>
          <li>{t('onboarding.llmHint')}</li>
        </ul>
      )}

      {/* Primary one-click affordance — no terminal required. */}
      {showOnboarding && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, alignItems: 'center' }}>
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
      </div>}

      {showDemoCleanup && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12, alignItems: 'center' }}>
          <button
            type="button"
            class="btn"
            onClick={runReset}
            disabled={pending !== null}
          >
            {pending === 'reset' ? t('onboarding.resettingButton') : t('onboarding.resetButton')}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('onboarding.hintReset')}
          </span>
        </div>
      )}

      {/* Power-user CLI reference — kept for headless / CI flows. */}
      {showOnboarding && <details style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
        <summary style={{ cursor: 'pointer' }}>{t('onboarding.cliReference')}</summary>
        <TerminalHandoff id="demo-cli-fallback" command="memesh demo" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {t('onboarding.hintDemo')}
          </span>
        </div>
        <TerminalHandoff id="demo-cli-fallback" command="memesh demo --reset --yes" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, alignItems: 'center' }}>
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
      </details>}

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
