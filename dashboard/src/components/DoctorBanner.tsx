import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

const DISMISS_KEY = 'memesh.doctorBanner.dismissedSig';

interface DoctorCheck { id: string; label: string; status: 'pass' | 'warn' | 'fail'; summary: string; fix?: string }
interface DoctorResult { status: string; checks: DoctorCheck[] }

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
        .then((d) => { if (mounted) setDoctor(d); })
        .catch(() => { /* doctor unavailable — banner stays hidden */ });
    };
    fetch();
    const handler = () => fetch();
    window.addEventListener('memesh:data-changed', handler);
    return () => { mounted = false; window.removeEventListener('memesh:data-changed', handler); };
  }, []);

  if (!doctor) return null;
  if (doctor.status === 'PASS') return null;

  const concerns = doctor.checks.filter(c => c.status === 'fail' || c.status === 'warn');
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
  const tone = isFail ? '#ef4444' : '#f59e0b';
  const toneBg = isFail ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)';
  const toneBorder = isFail ? 'rgba(239, 68, 68, 0.32)' : 'rgba(245, 158, 11, 0.32)';

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: 'relative',
        margin: '12px auto 0',
        maxWidth: 920,
        padding: '12px 16px',
        border: `1px solid ${toneBorder}`,
        borderRadius: 8,
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
        {isFail ? t('doctorBanner.failTitle') : t('doctorBanner.warnTitle')}
      </div>
      <ul style={{ margin: '6px 0 10px', paddingLeft: 18, fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)' }}>
        {concerns.slice(0, 3).map(c => {
          // Translate known check IDs, fallback to English summary from doctor
          const summaryKey = `doctor.${c.id}.summary`;
          const fixKey = `doctor.${c.id}.fix`;
          const summary = t(summaryKey) !== summaryKey ? t(summaryKey) : c.summary;
          const fix = c.fix && t(fixKey) !== fixKey ? t(fixKey) : c.fix;
          return (
            <li key={c.id}>
              <strong>{c.label}:</strong> {summary}
              {fix && <> — <em style={{ color: 'var(--text-3)' }}>{fix}</em></>}
            </li>
          );
        })}
        {concerns.length > 3 && (
          <li style={{ color: 'var(--text-3)' }}>…and {concerns.length - 3} more (run `memesh doctor` for full list)</li>
        )}
      </ul>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" class="btn" onClick={getHelp} style={{ fontSize: 12, padding: '4px 12px' }}>
          {t('doctorBanner.getHelp')}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {t('doctorBanner.helpHint')}
        </span>
      </div>
    </div>
  );
}
