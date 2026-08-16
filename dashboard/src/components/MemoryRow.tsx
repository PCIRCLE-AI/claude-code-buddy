import { t as translate } from '../lib/i18n';
import type { Entity } from '../lib/api';
import {
  relativeDate,
  displayTitle,
  accessSignal,
  extractProject,
  typeLabel,
} from '../lib/entity-display';
import { EntityIcon } from './icons/EntityIcon';

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Format a created_at ISO string as `YYYY-MM-DD HH:mm` in the user's
 *  locale timezone. Memory rows surface this absolute timestamp so a
 *  user can tell "exactly when was this captured" at a glance, without
 *  having to hover the row or open it. */
function formatCreatedAt(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  entity: Entity;
  actions?: preact.ComponentChild;
  highlight?: string;
}

const TONE_COLORS = {
  // Fills use the -soft pair (DESIGN.md pair rule); high is told apart by
  // the life-coloured text at weight 600, not a louder fill.
  high:   { bg: 'var(--life-soft)', fg: 'var(--life)' },
  medium: { bg: 'var(--life-soft)', fg: 'var(--life)' },
  low:    { bg: 'var(--border-subtle)', fg: 'var(--text-2)' },
  none:   { bg: 'var(--border-subtle)', fg: 'var(--text-3)' },
} as const;

export function MemoryRow({ entity: e, actions, highlight }: Props) {
  const preview = displayTitle(e) || translate('memory.noContent');
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
        <div style={{ height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-2)' }}>
          <EntityIcon type={e.type} size={18} />
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{relTime}</div>
      </div>
      <div class="mem-body">
        {/* The machine key (e.name) is deliberately NOT in the visible row —
            it is a dedup/append key, not a label. Hovering the headline
            reveals it for the rare "which entity is this exactly" case. */}
        <div class="mem-preview" title={e.name}>
          {highlight ? <Highlight text={truncate(preview, 160)} term={highlight} /> : truncate(preview, 160)}
        </div>
        <div class="mem-meta" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span class="badge badge-type">{typeLabel(e.type)}</span>
          {isArchived && <span class="badge badge-archived">{translate('memory.archivedBadge')}</span>}
          {project && (
            <span
              class="tag"
              style={{ background: 'var(--life-soft)', color: 'var(--life)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title={translate('memory.tooltip.project')}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path d="M2 4 a1 1 0 0 1 1 -1 h4 l2 2 h5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              {project}
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
              title={translate('memory.tooltip.recalled', { count: access.count })}
            >
              ✓ {access.label}
            </span>
          )}
          {hasRelations && (
            <span class="tag" style={{ opacity: 0.7 }} title={translate('memory.tooltip.hasRelations', { count: e.relations!.length })}>
              → {e.relations!.length}
            </span>
          )}
          <span
            style={{
              color: 'var(--text-3)',
              fontSize: 10,
              fontFamily: 'var(--mono)',
              opacity: 0.85,
            }}
            title={translate('memory.tooltip.createdAt', { date: e.created_at })}
          >
            · {formatCreatedAt(e.created_at)}
          </span>
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
