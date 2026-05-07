import { useMemo, useRef } from 'preact/hooks';
import type { Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { t } from '../lib/i18n';
import { relativeDate, timeBucket, accessSignal, iconFor } from '../lib/entity-display';

/** Type set that qualifies as a milestone for the rail. Releases are the
 *  primary signal; workflow_checkpoint and weekly-summary are optional
 *  secondary signals only when explicitly tagged. */
const MILESTONE_TYPES = new Set(['release', 'feature']);

/** Type set that qualifies as a "key lesson" — drives the right rail. */
const LESSON_TYPES = new Set([
  'lesson_learned', 'lesson', 'mistake', 'bug_fix',
]);

interface Props {
  projectName: string;
  entities: Entity[];
  /** When provided, renders a "Switch to List view" button in the header. */
  onSwitchToList?: () => void;
}

/**
 * Type priority for within-date sorting. Earlier indices come first.
 * Releases lead because they're milestones; commits / sessions trail because
 * they're activity noise that's already been dimmed by the chip filter
 * upstream of this component.
 */
const TYPE_PRIORITY: Record<string, number> = {
  release: 0,
  architecture: 1,
  architecture_decision: 1,
  infrastructure: 2,
  plan: 3,
  feature: 4,
  decision: 5,
  design_decision: 5,
  pattern: 6,
  technical_pattern: 6,
  best_practice: 7,
  lesson_learned: 8,
  lesson: 8,
  mistake: 8,
  bug_fix: 9,
  refactoring: 10,
  process: 11,
  workflow_checkpoint: 11,
  note: 12,
  knowledge: 13,
  verification_result: 14,
  test_result: 14,
  'weekly-summary': 15,
  weekly_summary: 15,
  commit: 90,
  session_keypoint: 91,
  session_identity: 92,
  'session-identity': 92,
  'session-insight': 93,
  'session-summary': 94,
};

function priorityOf(type: string): number {
  return TYPE_PRIORITY[type] ?? 50;
}

interface DateGroup {
  key: string;
  label: string;
  /** Sort key — newer groups have larger numbers. */
  sort: number;
  entries: Entity[];
}

function groupByDate(entities: Entity[], now: Date = new Date()): DateGroup[] {
  const buckets = new Map<string, DateGroup>();

  for (const e of entities) {
    const ts = e.last_accessed_at || e.created_at;
    const bucket = timeBucket(ts, now);

    let key: string;
    let label: string;
    let sort: number;

    if (bucket === 'today') {
      key = 'today';
      label = t('time.today');
      sort = Number.MAX_SAFE_INTEGER;
    } else if (bucket === 'week') {
      // Use the day-of-month so individual days within "this week" stay
      // separated, but mark them with a relative-date label for clarity.
      const day = ts.slice(0, 10);
      key = `week:${day}`;
      label = relativeDate(ts, now);
      sort = new Date(day).getTime();
    } else if (bucket === 'month') {
      // Group by week within the month.
      const day = ts.slice(0, 10);
      const d = new Date(day);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay()); // Sunday
      const wkKey = weekStart.toISOString().slice(0, 10);
      key = `month:${wkKey}`;
      label = relativeDate(wkKey, now);
      sort = weekStart.getTime();
    } else {
      // older — group by month
      const month = ts.slice(0, 7); // YYYY-MM
      key = `older:${month}`;
      const d = new Date(month + '-01');
      label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      sort = d.getTime();
    }

    let group = buckets.get(key);
    if (!group) {
      group = { key, label, sort, entries: [] };
      buckets.set(key, group);
    }
    group.entries.push(e);
  }

  // Sort groups newest-first
  const groups = Array.from(buckets.values()).sort((a, b) => b.sort - a.sort);
  // Sort within each group by type priority, then by created_at desc
  for (const g of groups) {
    g.entries.sort((a, b) => {
      const dp = priorityOf(a.type) - priorityOf(b.type);
      if (dp !== 0) return dp;
      return b.created_at.localeCompare(a.created_at);
    });
  }
  return groups;
}

export function ProjectRoadmap({ projectName, entities, onSwitchToList }: Props) {
  const stats = useMemo(() => {
    if (entities.length === 0) {
      return { total: 0, first: null as string | null, last: null as string | null, types: [] as Array<[string, number]> };
    }
    const sorted = [...entities].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const typeCount = new Map<string, number>();
    for (const e of entities) typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1);
    return {
      total: entities.length,
      first: sorted[0].created_at,
      last: sorted[sorted.length - 1].created_at,
      types: Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [entities]);

  const groups = useMemo(() => groupByDate(entities), [entities]);

  // Milestones: release/feature entities, newest first, capped at 6
  const milestones = useMemo(
    () => entities
      .filter((e) => MILESTONE_TYPES.has(e.type))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 6),
    [entities],
  );

  // Key lessons: top 5 lesson types by access_count desc
  const keyLessons = useMemo(
    () => entities
      .filter((e) => LESSON_TYPES.has(e.type))
      .sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0))
      .slice(0, 5),
    [entities],
  );

  // Refs for scroll-to-milestone targeting
  const entryRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const setEntryRef = (id: number) => (el: HTMLDivElement | null) => {
    if (el) entryRefs.current.set(id, el);
    else entryRefs.current.delete(id);
  };
  const focusEntry = (id: number) => {
    const el = entryRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background 0.2s';
    el.style.background = 'rgba(0, 214, 180, 0.08)';
    window.setTimeout(() => { el.style.background = ''; }, 1400);
  };

  if (entities.length === 0) {
    return (
      <div class="empty">
        <span class="empty-icon">🗺️</span>
        {t('roadmap.emptyProject')}
      </div>
    );
  }

  return (
    <div>
      {/* Header band */}
      <div
        style={{
          padding: '14px 16px',
          background: 'rgba(0, 214, 180, 0.04)',
          border: '1px solid rgba(0, 214, 180, 0.12)',
          borderRadius: 6,
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-0)' }}>
              📂 {projectName}
              <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                · {t('roadmap.title')}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
              {t('roadmap.summary', {
                count: stats.total,
                first: stats.first ? stats.first.slice(0, 10) : '—',
                last: stats.last ? stats.last.slice(0, 10) : '—',
              })}
            </div>
          </div>
          {onSwitchToList && (
            <button class="btn btn-sm" onClick={onSwitchToList}>
              {t('roadmap.switchToList')}
            </button>
          )}
        </div>

        {/* Type distribution chips */}
        {stats.types.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {stats.types.slice(0, 8).map(([type, count]) => (
              <span
                key={type}
                class="tag"
                style={{ fontSize: 11, background: 'rgba(255,255,255,0.04)' }}
              >
                {type} <span style={{ opacity: 0.6, fontFamily: 'var(--mono)' }}>{count}</span>
              </span>
            ))}
            {stats.types.length > 8 && (
              <span class="tag" style={{ opacity: 0.5, fontSize: 11 }}>
                +{stats.types.length - 8}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Two-column layout on wide screens: timeline + rails sidebar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 16, alignItems: 'start' }}>
        {/* Timeline */}
        <div style={{ position: 'relative', minWidth: 0 }}>
          {groups.map((group) => (
            <div key={group.key} style={{ marginBottom: 18 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 8,
                  paddingBottom: 6,
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    fontWeight: 600,
                    color: 'var(--accent)',
                    fontFamily: 'var(--mono)',
                  }}
                >
                  {group.label}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {group.entries.length}
                </span>
              </div>
              {group.entries.map((e) => (
                <div
                  key={e.id}
                  ref={setEntryRef(e.id)}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    padding: '12px 0',
                  }}
                >
                  <MemoryRow entity={e} />
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Sidebar: Milestones + Key Lessons rails */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 16 }}>
          {milestones.length > 0 && (
            <div class="card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
                {t('roadmap.milestones')}
              </div>
              {milestones.map((m) => (
                <button
                  key={m.id}
                  onClick={() => focusEntry(m.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 0',
                    background: 'transparent',
                    border: 'none',
                    borderTop: '1px solid var(--border-subtle)',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontSize: 14, lineHeight: '18px', flexShrink: 0 }}>{iconFor(m.type)}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.name}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                      {relativeDate(m.created_at)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {keyLessons.length > 0 && (
            <div class="card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
                {t('roadmap.keyLessons')}
              </div>
              {keyLessons.map((l) => {
                const sig = accessSignal(l.access_count);
                return (
                  <button
                    key={l.id}
                    onClick={() => focusEntry(l.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 0',
                      background: 'transparent',
                      border: 'none',
                      borderTop: '1px solid var(--border-subtle)',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <span style={{ fontSize: 14, lineHeight: '18px', flexShrink: 0 }}>{iconFor(l.type)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.name}
                      </div>
                      <div style={{ fontSize: 10, color: sig.tone === 'high' ? 'var(--accent)' : 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                        {sig.tone !== 'none' ? sig.label : t('memory.access.never')}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
