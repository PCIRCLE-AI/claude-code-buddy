import { useState, useRef, useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import { api, type HealthData } from '../lib/api';

const TYPES = ['bug', 'feature', 'question'] as const;
type FeedbackType = typeof TYPES[number];

const TYPE_I18N_KEYS: Record<FeedbackType, string> = {
  bug: 'feedback.bug',
  feature: 'feedback.feature',
  question: 'feedback.question',
};

interface DoctorCheck { id: string; label: string; status: string; summary: string; fix?: string }
interface DoctorResult { status: string; checks: DoctorCheck[] }

export function FeedbackWidget({ health }: { health: HealthData | null }) {
  const [open, setOpen] = useState(false);
  const [fbType, setFbType] = useState<FeedbackType>('bug');
  const [desc, setDesc] = useState('');
  const [includeSys, setIncludeSys] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Format a DoctorResult into a markdown block that's easy for a
  // human triager to scan in a GitHub issue. WARN/FAIL checks float
  // to the top with their `fix` hint inline so the maintainer can
  // see at a glance what the user actually hit.
  //
  // The install_id check is pulled out into its own line up top so
  // the maintainer can correlate multiple issues from the same user
  // without scrolling through 10 PASS lines.
  function formatDoctor(d: DoctorResult): string {
    const installCheck = d.checks.find(c => c.id === 'install_id');
    const otherChecks = d.checks.filter(c => c.id !== 'install_id');
    const sorted = otherChecks.sort((a, b) => {
      const order = { fail: 0, warn: 1, pass: 2 } as const;
      return (order[a.status as 'fail' | 'warn' | 'pass'] ?? 3) - (order[b.status as 'fail' | 'warn' | 'pass'] ?? 3);
    });
    const lines = sorted.map(c => {
      const icon = c.status === 'fail' ? '❌' : c.status === 'warn' ? '⚠️' : '✅';
      const fix = c.fix ? ` _Fix: ${c.fix}_` : '';
      return `- ${icon} **${c.label}**: ${c.summary}${fix}`;
    });
    const installLine = installCheck
      ? `\n_Anonymous install ID: \`${(installCheck.summary.match(/[0-9a-f-]{36}/) ?? ['(unavailable)'])[0]}\` — included only because you checked "Include system info"._\n`
      : '';
    return `**Diagnostics** (overall: ${d.status})${installLine}\n${lines.join('\n')}`;
  }

  const submit = async () => {
    if (!desc.trim() || submitting) return;
    setSubmitting(true);
    try {
      const labels = `feedback,from-dashboard,${fbType}`;
      let body = desc.trim();
      if (includeSys && health) {
        body += `\n\n---\n**System Info**\n- Version: \`${health.version}\`\n- Entities: ${health.entity_count}\n- Platform: \`${navigator.platform}\`\n- User Agent: \`${navigator.userAgent}\``;
        // Best-effort doctor probe. If it 5xxs or times out we still
        // submit the basic sys-info block — never block the user.
        try {
          const diag = await api<DoctorResult>('GET', '/v1/doctor');
          body += `\n\n${formatDoctor(diag)}`;
        } catch { /* doctor unavailable — basic sys-info still useful */ }
      }
      const typeLabel = t(TYPE_I18N_KEYS[fbType]);
      const url = `https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/new?title=${encodeURIComponent(`[${typeLabel}] `)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(labels)}`;
      window.open(url, '_blank');
      setDesc('');
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button class="fb-btn" onClick={() => setOpen(!open)}>
        {t('feedback.button')}
      </button>
      {open && (
        <div class="fb-panel" ref={panelRef}>
          <h3 class="fb-title">{t('feedback.title')}</h3>
          <div class="fb-types">
            {TYPES.map((type) => (
              <label key={type} class={`fb-type ${fbType === type ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="fb-type"
                  value={type}
                  checked={fbType === type}
                  onChange={() => setFbType(type)}
                />
                {t(TYPE_I18N_KEYS[type])}
              </label>
            ))}
          </div>
          <textarea
            class="fb-desc"
            placeholder={t('feedback.placeholder')}
            value={desc}
            onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)}
          />
          <label class="fb-sys-row">
            <input
              type="checkbox"
              checked={includeSys}
              onChange={() => setIncludeSys(!includeSys)}
            />
            {t('feedback.includeSys')}
          </label>
          <button class="btn btn-primary fb-submit" onClick={submit} disabled={submitting}>
            {submitting ? t('feedback.submitting') : t('feedback.submit')}
          </button>
        </div>
      )}
    </>
  );
}
