import { useState, useRef, useEffect } from 'preact/hooks';
import { t } from '../lib/i18n';
import type { HealthData } from '../lib/api';

const TYPES = ['bug', 'feature', 'question'] as const;
type FeedbackType = typeof TYPES[number];

const TYPE_I18N_KEYS: Record<FeedbackType, string> = {
  bug: 'feedback.bug',
  feature: 'feedback.feature',
  question: 'feedback.question',
};

export function FeedbackWidget({ health }: { health: HealthData | null }) {
  const [open, setOpen] = useState(false);
  const [fbType, setFbType] = useState<FeedbackType>('bug');
  const [desc, setDesc] = useState('');
  const [includeSys, setIncludeSys] = useState(true);
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

  const submit = () => {
    if (!desc.trim()) return;
    const labels = `feedback,from-dashboard,${fbType}`;
    let body = desc.trim();
    if (includeSys && health) {
      body += `\n\n---\n**System Info**\n- Version: ${health.version}\n- Entities: ${health.entity_count}\n- Platform: ${navigator.platform}\n- User Agent: ${navigator.userAgent}`;
    }
    const typeLabel = t(TYPE_I18N_KEYS[fbType]);
    const url = `https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/new?title=${encodeURIComponent(`[${typeLabel}] `)}&body=${encodeURIComponent(body)}&labels=${encodeURIComponent(labels)}`;
    window.open(url, '_blank');
    setDesc('');
    setOpen(false);
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
          <button class="btn btn-primary fb-submit" onClick={submit}>
            {t('feedback.submit')}
          </button>
        </div>
      )}
    </>
  );
}
