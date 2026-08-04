import { useState } from 'preact/hooks';
import { api } from '../lib/api';
import { actionFailureMessage } from '../lib/failure';
import { t } from '../lib/i18n';

/**
 * The durable second entry point to the demo seed.
 *
 * OnboardingBanner is dismissable, and the dismissal is permanent
 * (localStorage) — after which a user staring at an empty Browse list, a
 * blank Graph canvas or an empty Lessons tab had NO path back to the
 * one-click demo. This block renders inside those empty states whenever the
 * database itself is empty, regardless of the banner's dismissal, so the
 * seed stays discoverable exactly where the emptiness is felt.
 *
 * Deliberately NOT gated on the banner's localStorage key: the banner is a
 * first-run greeting, this is the empty state itself.
 */
export function EmptyLibraryState() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function runSeed() {
    setError('');
    setPending(true);
    try {
      await api('POST', '/v1/demo/seed');
      // App refetches /v1/health on this event; entity_count goes above
      // zero and every empty state (this one included) retires itself.
      window.dispatchEvent(new Event('memesh:data-changed'));
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      // Re-enable on every outcome: on success the component unmounts a
      // moment later when the refetch lands; if that refetch is slow or
      // fails, the user can retry instead of staring at "Seeding…".
      setPending(false);
    }
  }

  return (
    <div class="empty" style={{ padding: '32px 20px' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-0)', marginBottom: 6 }}>
        {t('emptyLibrary.title')}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-1)', maxWidth: 480, margin: '0 auto 14px' }}>
        {t('emptyLibrary.body')}
      </div>
      <button
        type="button"
        class="btn btn-primary"
        onClick={() => void runSeed()}
        disabled={pending}
        style={{ minWidth: 160 }}
      >
        {pending ? t('onboarding.seedingButton') : t('onboarding.seedButton')}
      </button>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
        {t('onboarding.seedHint')}
      </div>
      {error && (
        <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--danger)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
