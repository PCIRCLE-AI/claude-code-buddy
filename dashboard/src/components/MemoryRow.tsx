import type { Entity } from '../lib/api';

function formatTime(iso: string): { date: string; time: string } {
  try {
    const d = new Date(iso);
    return {
      date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    };
  } catch {
    return { date: '—', time: '' };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

interface Props {
  entity: Entity;
  actions?: preact.ComponentChild;
  highlight?: string;
}

export function MemoryRow({ entity: e, actions, highlight }: Props) {
  const t = formatTime(e.created_at);
  const preview = e.observations?.[0] || '(no content)';
  const obsCount = e.observations?.length || 0;
  const isArchived = e.archived || e.status === 'archived';

  return (
    <div class="mem-row" style={isArchived ? { opacity: 0.45 } : undefined}>
      <div class="mem-time">
        <div>{t.date}</div>
        <div>{t.time}</div>
      </div>
      <div class="mem-body">
        <div class="mem-preview">
          {highlight ? <Highlight text={truncate(preview, 140)} term={highlight} /> : truncate(preview, 140)}
        </div>
        <div class="mem-meta">
          <span class="badge badge-type">{e.type}</span>
          {isArchived && <span class="badge badge-archived">archived</span>}
          <span>{e.name}</span>
          {obsCount > 1 && <span>· {obsCount} facts</span>}
          {e.tags?.slice(0, 3).map((tag) => <span class="tag" key={tag}>{tag}</span>)}
          {(e.tags?.length || 0) > 3 && <span class="tag" style={{ opacity: 0.5 }}>+{e.tags!.length - 3}</span>}
        </div>
      </div>
      {actions && <div class="mem-actions">{actions}</div>}
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const parts: preact.ComponentChild[] = [];
  const lower = text.toLowerCase();
  const lt = term.toLowerCase();
  let pos = 0;
  while (pos < text.length) {
    const idx = lower.indexOf(lt, pos);
    if (idx === -1) { parts.push(text.slice(pos)); break; }
    if (idx > pos) parts.push(text.slice(pos, idx));
    parts.push(<mark>{text.slice(idx, idx + lt.length)}</mark>);
    pos = idx + lt.length;
  }
  return <>{parts}</>;
}
