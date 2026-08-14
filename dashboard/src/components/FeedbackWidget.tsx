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
  const toggleRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close and return focus to the toggle — a dialog that traps nothing must at
  // least not strand the keyboard user's focus on a removed node.
  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Move focus into the panel on open (the obvious field).
    textareaRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The toggle is a SIBLING of the panel, not inside it — without this guard
      // a click on the toggle counts as "outside", closes on mousedown, and the
      // click then reopens: the button can never close the panel it opened.
      if (toggleRef.current?.contains(target)) return;
      if (panelRef.current && !panelRef.current.contains(target)) {
        setOpen(false); // click-away: no focus move, the pointer chose elsewhere
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
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
      const url = `https://github.com/PCIRCLE-AI/memesh/issues/new?title=${encodeURIComponent(`[${typeLabel}] `)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(labels)}`;
      window.open(url, '_blank');
      setDesc('');
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        ref={toggleRef}
        class="fb-btn"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="fb-panel"
      >
        {t('feedback.button')}
      </button>
      {open && (
        // role="dialog" WITHOUT aria-modal: the background stays reachable
        // (this is a corner popover, not a modal), and claiming modality while
        // the rest of the page is live would mislead a screen reader. Escape
        // closes it and focus returns to the toggle (see close()).
        <div
          class="fb-panel"
          ref={panelRef}
          role="dialog"
          id="fb-panel"
          aria-labelledby="fb-title"
        >
          <h3 class="fb-title" id="fb-title">{t('feedback.title')}</h3>
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
            ref={textareaRef}
            class="fb-desc"
            aria-label={t('feedback.descLabel')}
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
