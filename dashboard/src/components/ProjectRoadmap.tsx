import { useMemo, useRef } from 'preact/hooks';
import type { Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { t } from '../lib/i18n';
import { relativeDate, timeBucket, accessSignal } from '../lib/entity-display';
import { EntityIcon } from './icons/EntityIcon';

/** Type set that qualifies as a milestone for the rail. Releases are the
 *  primary signal; workflow_checkpoint and weekly-summary are optional
 *  secondary signals only when explicitly tagged. */
const MILESTONE_TYPES = new Set(['release', 'feature']);

/** Type set that qualifies as a "key lesson" — drives the right rail. */
const LESSON_TYPES = new Set([
  'lesson_learned', 'lesson', 'mistake', 'bug_fix',
]);

/* ---------- v2: auto-phase derivation ---------- */

/** Type ranking for choosing a phase's representative anchor entity.
 *  Lower number = higher priority. Releases are the strongest signal
 *  ("what we shipped"); plans / architecture decisions describe the
 *  shape of the period; everything else falls back to the first
 *  entity. */
const PHASE_ANCHOR_PRIORITY: Record<string, number> = {
  release: 0,
  architecture: 1,
  architecture_decision: 1,
  plan: 2,
  feature: 3,
  decision: 4,
  design_decision: 4,
};

interface Phase {
  startIso: string;
  endIso: string;
  entityCount: number;
  /** Localised-or-derived label for the phase strip header. */
  label: string;
  /** The entity used to derive the label, when one exists. Lets the
   *  UI scroll-to that entity on click. */
  anchorId?: number;
}

/**
 * Heuristic phase derivation. Cluster entities into runs where every
 * consecutive pair lands within `MAX_GAP_DAYS` of each other. A run
 * with at least `MIN_PHASE_ENTITIES` becomes a phase; smaller runs are
 * dropped (they look noisy on a strip with two big phases beside
 * them). Each phase's label comes from the highest-priority entity in
 * the run, falling back to a date-range string when nothing matches.
 */
function derivePhases(entities: Entity[]): Phase[] {
  const MAX_GAP_DAYS = 7;
  const MIN_PHASE_ENTITIES = 3;

  if (entities.length < MIN_PHASE_ENTITIES) return [];
  const sorted = [...entities].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const runs: Entity[][] = [];
  let current: Entity[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].created_at;
    const cur = sorted[i].created_at;
    const gapDays = (new Date(cur).getTime() - new Date(prev).getTime()) / 86400000;
    if (gapDays <= MAX_GAP_DAYS) {
      current.push(sorted[i]);
    } else {
      runs.push(current);
      current = [sorted[i]];
    }
  }
  runs.push(current);

  return runs
    .filter((run) => run.length >= MIN_PHASE_ENTITIES)
    .map<Phase>((run) => {
      const anchor = run
        .map((e) => ({ e, p: PHASE_ANCHOR_PRIORITY[e.type] ?? 99 }))
        .sort((a, b) => a.p - b.p)[0];
      const label = anchor.p < 99
        ? anchor.e.name
        : `${run[0].created_at.slice(0, 10)} – ${run[run.length - 1].created_at.slice(0, 10)}`;
      return {
        startIso: run[0].created_at,
        endIso: run[run.length - 1].created_at,
        entityCount: run.length,
        label,
        anchorId: anchor.p < 99 ? anchor.e.id : undefined,
      };
    });
}

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

  // v2 auto-phases. Empty array for projects below the density threshold;
  // the strip renders a small placeholder note in that case.
  const phases = useMemo(() => derivePhases(entities), [entities]);

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
        <span class="empty-icon" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
          {/* Map outline — empty roadmap fallback */}
          <svg width="32" height="32" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4 L6 2 L10 4 L14 2 V12 L10 14 L6 12 L2 14 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M6 2 V12 M10 4 V14" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </span>
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
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-0)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" style={{ color: 'var(--accent)' }}>
                <path d="M2 4 a1 1 0 0 1 1 -1 h4 l2 2 h5 a1 1 0 0 1 1 1 v6 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              <span>{projectName}</span>
              <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 13 }}>
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

      {/* v2: Auto-phase strip. Renders only when the project has enough
          density (≥3 entities within ≤7-day windows) to make phases
          meaningful. Click a phase chip to scroll the corresponding
          anchor entity into view. */}
      {phases.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
            padding: '12px 14px',
            border: '1px solid rgba(255, 255, 255, 0.04)',
            borderRadius: 6,
            background: 'rgba(255, 255, 255, 0.02)',
            overflowX: 'auto',
          }}
        >
          <span
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--text-3)',
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {t('roadmap.phases')}
          </span>
          {phases.map((phase, i) => (
            <button
              key={`${phase.startIso}-${phase.label}`}
              onClick={() => phase.anchorId !== undefined && focusEntry(phase.anchorId)}
              disabled={phase.anchorId === undefined}
              style={{
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 2,
                padding: '6px 10px',
                background: i === phases.length - 1 ? 'rgba(0, 214, 180, 0.08)' : 'transparent',
                border: '1px solid',
                borderColor: i === phases.length - 1 ? 'rgba(0, 214, 180, 0.3)' : 'var(--border-subtle)',
                borderRadius: 4,
                color: 'var(--text-1)',
                cursor: phase.anchorId !== undefined ? 'pointer' : 'default',
                fontFamily: 'inherit',
                textAlign: 'left',
                minWidth: 100,
              }}
              title={`${phase.startIso.slice(0, 10)} → ${phase.endIso.slice(0, 10)}`}
            >
              <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }}>
                {phase.label}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
                {phase.entityCount} · {relativeDate(phase.startIso)}
              </span>
            </button>
          ))}
        </div>
      )}

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
                  <span style={{ flexShrink: 0, color: 'var(--accent)' }}><EntityIcon type={m.type} size={14} /></span>
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
                    <span style={{ flexShrink: 0, color: 'var(--text-2)' }}><EntityIcon type={l.type} size={14} /></span>
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
