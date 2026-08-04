import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

const DISMISS_KEY = 'memesh.doctorBanner.dismissedSig';

interface DoctorCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  summary: string;
  fix?: string;
  code?: string;
  params?: Record<string, string | number>;
}
interface DoctorResult { status: string; checks: DoctorCheck[] }

/**
 * Translate one doctor field by its stable message code, falling back to the
 * raw English the server sent. `t()` returns the key itself on a catalogue
 * miss — that equality IS the miss signal (this is the sanctioned pattern;
 * an or-fallback is not, because a returned key is truthy). The earlier
 * per-check-id localization was reverted for erasing state-specific detail;
 * codes are per-VARIANT and params carry the dynamic parts, so nothing is
 * erased — an untranslated variant simply shows the server's English.
 */
export function trField(key: string, fallback: string, params?: Record<string, string | number>): string {
  const translated = t(key, params);
  return translated === key ? fallback : translated;
}
export function trSummary(c: DoctorCheck): string {
  return c.code ? trField(`doctor.msg.${c.code}.summary`, c.summary, c.params) : c.summary;
}
export function trFix(c: DoctorCheck): string | undefined {
  if (!c.fix) return undefined;
  return c.code ? trField(`doctor.msg.${c.code}.fix`, c.fix, c.params) : c.fix;
}
export function trLabel(c: DoctorCheck): string {
  return trField(`doctor.label.${c.id}`, c.label);
}

/**
 * WARN codes that report "nothing is wrong (yet)" rather than a problem —
 * they never earn a banner. The user's words, verbatim: 「既然沒更新就不要
 * 出聲，有更新才通知」— a fresh install nagged "no cached update check yet"
 * on every tab, which reads as *something is wrong* when nothing is.
 * `memesh doctor` (the CLI) still reports every one of these in full; the
 * banner interrupts, so it is reserved for broken things (FAIL) and
 * action-needed things (update available, version withdrawn, search
 * degraded). FAIL status always banners regardless of this list.
 */
export const QUIET_WARN_CODES = new Set([
  'update-status.no-cache',        // has not checked yet — not a problem
  'update-status.stale',           // version is current, cache merely old
  'update-status.deprecation-unknown', // lookup failed; retried silently
  'hook-activity.quiet',           // configured fine, just no sessions yet
  'shell-cli.not-on-path',         // plugin-only installs work fully
  'skills-manifest.missing-dev',   // normal for source checkouts
  'install-channel.unknown',       // nothing is broken
  'http-probe.no-server',          // you are LOOKING at the dashboard
  'readme-parity.unreadable',      // contributor-facing
  'readme-parity.drift',           // contributor-facing
]);

/**
 * Only surface concerns that are actually actionable to a user.
 * FAIL always counts (broken install — user has to act). WARN counts only
 * when it is NOT a quiet-by-design code (above) AND doctor attached a real
 * `fix` hint — without that filter, "PASS_WITH_CONCERNS" produced banners
 * like `Install method: … — No action needed`: alarmist title,
 * non-actionable body.
 */
export function isBannerWorthy(c: DoctorCheck): boolean {
  if (c.status === 'fail') return true;
  if (c.status !== 'warn') return false;
  if (c.code && QUIET_WARN_CODES.has(c.code)) return false;
  if (!c.fix) return false;
  const fix = c.fix.trim().toLowerCase();
  if (!fix) return false;
  if (fix === 'no action needed' || fix.startsWith('no action')) return false;
  return true;
}

/**
 * Surfaces doctor WARN/FAIL checks above the tab nav so users
 * who hit a real install/runtime problem (hooks unwired, LLM 401,
 * pending reindex) actually see it instead of silently wondering
 * why memesh "doesn't work properly". This is the user-visible
 * tip of the "ship-前-verify" gate: doctor finds it → user sees it
 * → one-click "Get help" routes to the existing FeedbackWidget
 * with that diagnostic pre-attached.
 *
 * Dismiss semantics: remember the SIGNATURE of dismissed checks
 * (a join of their IDs + statuses), not just "dismissed = true".
 * If a new check starts failing, the banner reappears. If the same
 * checks continue failing the user already chose to ignore, it
 * stays dismissed.
 */
export function DoctorBanner() {
  const [doctor, setDoctor] = useState<DoctorResult | null>(null);
  const [dismissedSig, setDismissedSig] = useState<string>(() => {
    try { return localStorage.getItem(DISMISS_KEY) ?? ''; } catch { return ''; }
  });

  useEffect(() => {
    let mounted = true;
    const fetch = () => {
      api<DoctorResult>('GET', '/v1/doctor')
        // A response without `checks` is not a doctor result. Storing it
        // anyway made `doctor.checks.filter(...)` throw on the next render.
        .then((d) => { if (mounted) setDoctor(Array.isArray(d?.checks) ? d : null); })
        .catch(() => { /* doctor unavailable — banner stays hidden */ });
    };
    fetch();
    const handler = () => fetch();
    window.addEventListener('memesh:data-changed', handler);
    return () => { mounted = false; window.removeEventListener('memesh:data-changed', handler); };
  }, []);

  if (!doctor) return null;
  if (doctor.status === 'PASS') return null;

  // Only surface concerns that are actually actionable to a user.
  // FAIL always counts (broken install — user has to act). WARN counts
  // ONLY when doctor attached a `fix` hint AND that hint isn't a
  // self-contradicting "no action needed" placeholder. Without this
  // filter, "PASS_WITH_CONCERNS" produced banners like
  // `Install method: Installation method detection — No action needed`
  // — alarmist title + non-actionable body. The CLI / `memesh doctor`
  // still reports every WARN; the dashboard just stops popping a
  // banner for ones the user can't (or shouldn't) act on.
  const concerns = doctor.checks.filter(isBannerWorthy);
  if (concerns.length === 0) return null;

  // Signature is stable for the same set of failing checks. Sort
  // before joining so check order doesn't change the signature.
  const currentSig = concerns
    .map(c => `${c.id}:${c.status}`)
    .sort()
    .join('|');
  if (currentSig === dismissedSig) return null;

  function dismiss() {
    setDismissedSig(currentSig);
    try { localStorage.setItem(DISMISS_KEY, currentSig); } catch { /* private mode */ }
  }

  function getHelp() {
    // Pre-fill the GitHub issue with the failing-check summaries.
    // The maintainer sees exactly what the user hit; the user sees
    // a one-click bridge from "something's wrong" to "I reported it".
    const lines = concerns.map(c => {
      const icon = c.status === 'fail' ? '❌' : '⚠️';
      const fix = c.fix ? ` _Fix: ${c.fix}_` : '';
      return `- ${icon} **${c.label}**: ${c.summary}${fix}`;
    });
    const body = `${t('doctorBanner.preambleForIssue')}\n\n${lines.join('\n')}`;
    const labels = 'feedback,from-dashboard,bug,doctor-warning';
    const url = `https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/new?title=${encodeURIComponent('[Bug] memesh doctor reported issues')}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(labels)}`;
    window.open(url, '_blank');
  }

  const isFail = doctor.status === 'FAIL';
  const tone = isFail ? 'var(--danger)' : 'var(--warning)';
  const toneBg = isFail ? 'var(--danger-soft)' : 'var(--warning-soft)';
  const toneBorder = tone;

  return (
    <div
      // `role="alert"` alone: it already implies an assertive live region,
      // and pairing it with `aria-live="polite"` told every screen reader two
      // contradictory urgencies for the same node. A failed doctor check is
      // the thing the user must hear about before interacting — assertive is
      // the right one of the two.
      role="alert"
      style={{
        position: 'relative',
        margin: '12px auto 0',
        maxWidth: 920,
        padding: '12px 16px',
        border: `1px solid ${toneBorder}`,
        borderRadius: 'var(--radius)',
        background: toneBg,
        color: 'var(--text-1)',
      }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('doctorBanner.dismiss')}
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
      <div style={{ fontSize: 13, fontWeight: 600, color: tone, marginBottom: 6 }}>
        {isFail ? t('doctorBanner.failTitle') : t('doctorBanner.warnTitleSoft')}
      </div>
      <ul style={{ margin: '6px 0 10px', paddingLeft: 18, fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)' }}>
        {concerns.slice(0, 3).map(c => {
          const fix = trFix(c);
          return (
            <li key={c.id}>
              <strong>{trLabel(c)}:</strong> {trSummary(c)}
              {fix && <> — <em style={{ color: 'var(--text-3)' }}>{fix}</em></>}
            </li>
          );
        })}
        {concerns.length > 3 && (
          <li style={{ color: 'var(--text-3)' }}>{t('doctorBanner.moreCount', { n: concerns.length - 3 })}</li>
        )}
      </ul>
      {/* "Get help" pushes a GitHub issue. Only show for FAIL (broken
          install — the user can't fix it themselves). For WARN-only
          the fix command is already in the list above, so the GitHub
          escalation route would be premature and noisy. */}
      {isFail && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" class="btn" onClick={getHelp} style={{ fontSize: 12, padding: '4px 12px' }}>
            {t('doctorBanner.getHelp')}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {t('doctorBanner.helpHint')}
          </span>
        </div>
      )}
    </div>
  );
}
