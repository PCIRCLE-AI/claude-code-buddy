import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

const DISMISS_KEY = 'memesh.insightsBanner.dismissed';

interface ProposalSummary {
  id: number;
  status: 'pending' | 'applied' | 'rejected';
  // Other fields exist on the wire (project, cluster_key, etc.) but the
  // banner only needs to know that pending proposals exist.
}

interface Props {
  /**
   * Current active tab. The banner self-suppresses on Home — insights
   * lead that tab, so there's no point nudging someone who's already
   * looking at the list.
   */
  currentTab: string;
  /**
   * Click handler that switches the active tab to Home (where insights
   * live). Wired from App.tsx so the banner doesn't need to know about
   * the tab-state machine.
   */
  onNavigateToInsights: () => void;
}

/**
 * Global onboarding banner that surfaces pending dream proposals from
 * any tab. Without this, users only see proposals if they land on Home
 * — which a user parked on another tab may not revisit for days.
 *
 * Visual style mirrors `OnboardingBanner` (accent-tinted gradient) so
 * it reads as a friendly nudge rather than an error/warn (those slots
 * are owned by `DoctorBanner`).
 *
 * Hide rules (in order):
 *   1. Already on Home (where insights lead) → no point nudging.
 *   2. User dismissed this session via the × button.
 *   3. No pending proposals.
 *
 * Dismiss is sessionStorage-only on purpose. Persisting across sessions
 * would suppress the banner forever once the user clicks ×, even after
 * the dreamer generates new insights tomorrow. Re-surfacing on the
 * next visit gives users another chance to engage without being
 * repeatedly nagged within one sitting.
 */
export function InsightsBanner({ currentTab, onNavigateToInsights }: Props) {
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    let mounted = true;
    const fetch = () => {
      api<ProposalSummary[]>('GET', '/v1/dream/proposals?status=pending')
        .then((data) => {
          if (!mounted) return;
          // Server returns a wrapped { success, data } envelope which
          // api() unwraps to the inner data — but defensively handle
          // either shape since InsightsTab does the same belt-and-
          // braces parse for the same endpoint.
          const list = Array.isArray(data) ? data : (data as { data?: ProposalSummary[] })?.data ?? [];
          setPendingCount(list.length);
        })
        .catch(() => { /* endpoint unavailable — banner stays hidden */ });
    };
    fetch();
    const handler = () => fetch();
    window.addEventListener('memesh:data-changed', handler);
    return () => { mounted = false; window.removeEventListener('memesh:data-changed', handler); };
  }, []);

  if (currentTab === 'Home') return null;
  if (dismissed) return null;
  if (pendingCount === 0) return null;

  function dismiss(e: Event) {
    e.stopPropagation();
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, 'true'); } catch { /* private mode */ }
  }

  // Pluralize the noun via a {s} param — "1 new insight" vs
  // "3 new insights". Locales that don't pluralize the same way
  // (zh-TW/zh-CN/ja/ko/th — "insight" stays singular) translate the
  // template directly without the {s} token, which the substitution
  // engine drops harmlessly.
  const message = t('banner.pendingInsights', { n: pendingCount, s: pendingCount === 1 ? '' : 's' });

  return (
    // The whole banner is one click target that navigates — that is a
    // button, not a named region. role="region" told assistive tech
    // "landmark you can skip" while click/Enter/Space all navigated.
    <div
      role="button"
      aria-label={t('banner.viewAll')}
      onClick={onNavigateToInsights}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onNavigateToInsights();
        }
      }}
      tabIndex={0}
      style={{
        position: 'relative',
        margin: '12px auto 0',
        maxWidth: 920,
        padding: '10px 40px 10px 16px',
        border: '1px solid rgba(143, 242, 92, 0.32)',
        borderRadius: 'var(--radius)',
        background: 'var(--life-soft)', /* flattened: a decorative gradient is ornament (DESIGN.md) */
        color: 'var(--text-1)',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1.5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <span style={{ flex: 1 }}>
        <span style={{ marginRight: 6 }} aria-hidden="true">💡</span>
        {message}
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('banner.dismiss')}
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
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
    </div>
  );
}
