import { t as translate } from '../lib/i18n';
import type { Entity } from '../lib/api';
import {
  iconFor,
  relativeDate,
  pickBestObservation,
  accessSignal,
  extractProject,
} from '../lib/entity-display';

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

interface Props {
  entity: Entity;
  actions?: preact.ComponentChild;
  highlight?: string;
}

const TONE_COLORS = {
  high:   { bg: 'rgba(0, 214, 180, 0.18)', fg: '#00D6B4' },
  medium: { bg: 'rgba(0, 214, 180, 0.10)', fg: '#00D6B4' },
  low:    { bg: 'rgba(255, 255, 255, 0.04)', fg: 'var(--text-2)' },
  none:   { bg: 'rgba(255, 255, 255, 0.03)', fg: 'var(--text-3)' },
} as const;

export function MemoryRow({ entity: e, actions, highlight }: Props) {
  const preview = pickBestObservation(e.observations) || translate('memory.noContent');
  const obsCount = e.observations?.length ?? 0;
  const isArchived = e.archived || e.status === 'archived';
  const project = extractProject(e);
  const access = accessSignal(e.access_count);
  const accessTone = TONE_COLORS[access.tone];
  const relTime = relativeDate(e.last_accessed_at || e.created_at);
  const hasRelations = (e.relations?.length ?? 0) > 0;

  return (
    <div class="mem-row" style={isArchived ? { opacity: 0.45 } : undefined}>
      {/* Icon column — compact, type signal */}
      <div class="mem-time" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 18, lineHeight: '20px' }}>{iconFor(e.type)}</div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{relTime}</div>
      </div>
      <div class="mem-body">
        <div class="mem-preview">
          {highlight ? <Highlight text={truncate(preview, 160)} term={highlight} /> : truncate(preview, 160)}
        </div>
        <div class="mem-meta" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span class="badge badge-type">{e.type}</span>
          {isArchived && <span class="badge badge-archived">{translate('memory.archivedBadge')}</span>}
          {project && (
            <span
              class="tag"
              style={{ background: 'rgba(0, 214, 180, 0.12)', color: 'var(--accent)' }}
              title="project"
            >
              📂 {project}
            </span>
          )}
          {access.tone !== 'none' && (
            <span
              class="tag"
              style={{
                background: accessTone.bg,
                color: accessTone.fg,
                fontWeight: access.tone === 'high' ? 600 : 400,
              }}
              title={`Recalled ${access.count} times`}
            >
              ✓ {access.label}
            </span>
          )}
          {hasRelations && (
            <span class="tag" style={{ opacity: 0.7 }} title="has relations">
              → {e.relations!.length}
            </span>
          )}
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>{e.name}</span>
          {obsCount > 1 && (
            <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
              · {translate('memory.factsCount', { count: obsCount })}
            </span>
          )}
          {e.tags
            ?.filter((tg) => !tg.startsWith('project:') && !/^\d{4}-\d{2}-\d{2}/.test(tg))
            .slice(0, 3)
            .map((tag) => <span class="tag" key={tag}>{tag}</span>)}
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
