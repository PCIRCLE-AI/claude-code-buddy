import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Entity } from '../lib/api';
import { MemoryRow } from './MemoryRow';
import { t, getLocale } from '../lib/i18n';
import { relativeDate, timeBucket, accessSignal, typeLabel, displayTitle } from '../lib/entity-display';
import { EntityIcon } from './icons/EntityIcon';
import { CaptureDensityBand } from './CaptureDensityBand';

/** The decision species, for the ADR view. `architecture` alone is a
 *  structure description, not a choice — it stays out. */
const DECISION_TYPES = new Set(['decision', 'design_decision', 'architecture_decision']);

/** Relation types the timeline overlay draws. ONLY the two behavioural
 *  types that actually exist in this codebase (BEHAVIOURAL_RELATION_TYPES);
 *  `caused` appears in MCP prose but no writer emits it — drawing a legend
 *  for it would be advertising an edge that cannot occur. */
const LINEAGE_EDGE_TYPES = new Set(['supersedes', 'contradicts']);

/** Type set that qualifies as a milestone for the rail. Releases are the
 *  primary signal; workflow_checkpoint and weekly-summary are optional
 *  secondary signals only when explicitly tagged. */
const MILESTONE_TYPES = new Set(['release', 'feature']);

/** Milestone signal gate: feature/plan/decision entries below this are
 *  filtered from the milestone rail. 'release' type is always exempt —
 *  a shipped release is always PM-meaningful regardless of score. Entities
 *  without signal_score (created before the scorer) pass through unfiltered. */
const MILESTONE_SIGNAL_THRESHOLD = 0.65;
const MILESTONE_ALWAYS_INCLUDE_TYPES = new Set(['release']);

/** Type set that qualifies as a "key lesson" — drives the right rail. */
const LESSON_TYPES = new Set([
  'lesson_learned', 'lesson', 'mistake', 'bug_fix',
]);

/* ---------- v2: auto-phase derivation ---------- */

/** Types that qualify an entity as a phase anchor — i.e. a real PM
 *  milestone: something named that we can label the period with.
 *  Lower number = higher priority. Anything not in this map is
 *  treated as activity noise (session_keypoint, commit, session_identity,
 *  session-insight, session-summary, workflow_checkpoint, note, etc.)
 *  and CANNOT seed a phase by itself. A run of pure activity entities
 *  no longer becomes a "2026-04-15 – 2026-04-22" date-range phase —
 *  the roadmap is meant to surface what was decided / shipped /
 *  learned, not what days had typing. */
const PHASE_ANCHOR_PRIORITY: Record<string, number> = {
  release: 0,
  architecture: 1,
  architecture_decision: 1,
  infrastructure: 1,
  plan: 2,
  feature: 3,
  decision: 4,
  design_decision: 4,
  bug_fix: 5,
  refactoring: 6,
  'weekly-summary': 7,
  weekly_summary: 7,
  lesson_learned: 8,
  lesson: 8,
  mistake: 8,
  principle: 9,
  best_practice: 10,
  technical_pattern: 10,
  pattern: 10,
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
 * PM-meaningful phase derivation. Cluster entities into runs where every
 * consecutive pair lands within `MAX_GAP_DAYS` of each other, then
 * promote a run to a phase only if it satisfies BOTH:
 *   1. `>= MIN_PHASE_ENTITIES` total entities (density floor — keeps
 *      the strip from showing one-off events as their own phase)
 *   2. has at least one PM-anchorable entity (release, feature,
 *      decision, plan, architecture, bug_fix, lesson_learned, etc. —
 *      see `PHASE_ANCHOR_PRIORITY`). Runs of pure activity noise
 *      (session_keypoint, commit, session_identity, ...) are dropped
 *      entirely — they would have produced an unhelpful date-range
 *      label like "2026-04-15 – 2026-04-22".
 *
 * Each surviving phase is labelled by the highest-priority anchor in
 * its run. There is no date-range fallback; if we can't name what
 * happened in a period, the period is not a milestone.
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

  const phases: Phase[] = [];
  for (const run of runs) {
    if (run.length < MIN_PHASE_ENTITIES) continue;
    const anchor = run
      .map((e) => ({ e, p: PHASE_ANCHOR_PRIORITY[e.type] ?? 99 }))
      .sort((a, b) => a.p - b.p)[0];
    if (anchor.p === 99) continue; // PM-meaningful gate: no named anchor → not a milestone
    phases.push({
      startIso: run[0].created_at,
      endIso: run[run.length - 1].created_at,
      entityCount: run.length,
      label: displayTitle(anchor.e),
      anchorId: anchor.e.id,
    });
  }
  return phases;
}

interface Props {
  projectName: string;
  entities: Entity[];
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
      label = d.toLocaleDateString(getLocale(), { year: 'numeric', month: 'long' });
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

type RoadmapView = 'tree' | 'mindmap' | 'decisions';

export function ProjectRoadmap({ projectName, entities }: Props) {
  const [view, setView] = useState<RoadmapView>('tree');

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

  // Milestones: release/feature entities, signal-gated, newest first, capped at 6.
  // 'release' type is always included; legacy entities (no signal_score) pass through.
  const milestones = useMemo(() => {
    return entities
      .filter((e) => {
        if (!MILESTONE_TYPES.has(e.type)) return false;
        if (MILESTONE_ALWAYS_INCLUDE_TYPES.has(e.type)) return true;
        const score = (e.metadata as Record<string, unknown> | undefined)?.signal_score;
        if (typeof score !== 'number') return true; // legacy: pass through
        return score >= MILESTONE_SIGNAL_THRESHOLD;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 6);
  }, [entities]);

  const filteredMilestoneCount = useMemo(() => {
    const eligible = entities.filter((e) => MILESTONE_TYPES.has(e.type));
    return eligible.length - milestones.length;
  }, [entities, milestones]);

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
    el.focus({ preventScroll: true });
    el.style.transition = 'background 0.2s';
    el.style.background = 'var(--life-soft)';
    window.setTimeout(() => { el.style.background = ''; }, 1400);
  };
  const focusTreeEntry = (id: number) => {
    setView('tree');
    window.requestAnimationFrame(() => focusEntry(id));
  };

  /* ---------- lineage overlay (supersedes / contradicts arcs) ---------- */

  const idByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entities) m.set(e.name, e.id);
    return m;
  }, [entities]);

  // Edges where BOTH endpoints are in this project view. Relations are
  // outgoing-only in the payload, so this is the complete set for entities
  // on screen — no reverse pass needed for drawing.
  const lineageEdges = useMemo(() => {
    const edges: Array<{ from: number; to: number; type: string }> = [];
    for (const e of entities) {
      for (const r of e.relations ?? []) {
        if (!LINEAGE_EDGE_TYPES.has(r.type)) continue;
        const to = idByName.get(r.to);
        if (to !== undefined && to !== e.id) edges.push({ from: e.id, to, type: r.type });
      }
    }
    return edges;
  }, [entities, idByName]);

  const trunkRef = useRef<HTMLDivElement | null>(null);
  const [edgePaths, setEdgePaths] = useState<Array<{ d: string; type: string }>>([]);
  // Measured off the DOM after render — an edge is only drawn between rows
  // that are actually on screen ("every moving pixel tells a truth" applies
  // to static pixels too: no arc to an element that is not there). The
  // every-render effect below converges via the equality guard.
  const computeEdgePathsRef = useRef<() => void>(() => {});
  computeEdgePathsRef.current = () => {
    const container = trunkRef.current;
    if (!container || lineageEdges.length === 0 || view !== 'tree') {
      setEdgePaths((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const cTop = container.getBoundingClientRect().top;
    const next: Array<{ d: string; type: string }> = [];
    for (const edge of lineageEdges) {
      const fromEl = entryRefs.current.get(edge.from);
      const toEl = entryRefs.current.get(edge.to);
      if (!fromEl || !toEl) continue;
      const fr = fromEl.getBoundingClientRect();
      const tr = toEl.getBoundingClientRect();
      const y1 = Math.round(fr.top - cTop + fr.height / 2);
      const y2 = Math.round(tr.top - cTop + tr.height / 2);
      next.push({ d: `M 14 ${y1} C 0 ${y1}, 0 ${y2}, 14 ${y2}`, type: edge.type });
    }
    setEdgePaths((prev) => {
      const same = prev.length === next.length
        && prev.every((p, i) => p.d === next[i].d && p.type === next[i].type);
      return same ? prev : next;
    });
  };
  useEffect(() => { computeEdgePathsRef.current(); });
  useEffect(() => {
    const onResize = () => computeEdgePathsRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const drawnSupersedes = edgePaths.filter((p) => p.type === 'supersedes').length;
  const drawnContradicts = edgePaths.filter((p) => p.type === 'contradicts').length;

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
          background: 'var(--border-subtle)',
          border: '1px solid rgba(143, 242, 92, 0.12)',
          borderRadius: 'var(--radius-sm)',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-0)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" style={{ color: 'var(--life)' }}>
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
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            {/* Tree / mindmap toggle */}
            <div
              role="tablist"
              aria-label={t('roadmap.viewToggle')}
              style={{
                display: 'inline-flex',
                background: 'var(--border-subtle)',
                borderRadius: 'var(--radius-xs)',
                padding: 2,
                border: '1px solid var(--border-subtle)',
              }}
            >
              {(['tree', 'mindmap', 'decisions'] as const).map((v) => {
                const active = view === v;
                const label = v === 'tree'
                  ? `🌲 ${t('roadmap.viewTree')}`
                  : v === 'mindmap'
                    ? `🧠 ${t('roadmap.viewMindmap')}`
                    : `⚖️ ${t('roadmap.viewDecisions')}`;
                return (
                  <button
                    key={v}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setView(v)}
                    style={{
                      padding: '4px 10px',
                      background: active ? 'rgba(143,242,92,0.15)' : 'transparent',
                      color: active ? 'var(--life)' : 'var(--text-2)',
                      border: 'none',
                      borderRadius: 'var(--radius-hairline)',
                      fontSize: 11,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Type distribution chips */}
        {stats.types.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {stats.types.slice(0, 8).map(([type, count]) => (
              <span
                key={type}
                class="tag"
                style={{ fontSize: 11, background: 'var(--border-subtle)' }}
              >
                {typeLabel(type)} <span style={{ opacity: 0.6, fontFamily: 'var(--mono)' }}>{count}</span>
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

      {/* Capture density by category — created_at buckets, the same axis
          the phase strip below segments on. Honestly named: it shows what
          memesh captured, not everything that happened. */}
      <CaptureDensityBand entities={entities} />

      {/* v2: Auto-phase strip. Renders only when the project has enough
          density (≥3 entities within ≤7-day windows) to make phases
          meaningful. Click a phase chip to scroll the corresponding
          anchor entity into view. */}
      {view !== 'decisions' && phases.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 14,
            padding: '12px 14px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
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
                background: i === phases.length - 1 ? 'var(--life-soft)' : 'transparent',
                border: '1px solid',
                borderColor: i === phases.length - 1 ? 'rgba(143, 242, 92, 0.3)' : 'var(--border-subtle)',
                borderRadius: 'var(--radius-xs)',
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

      {/* Mindmap view — radial dendrogram laid out in SVG. Project sits
          at the centre; phases radiate out to evenly-spaced positions
          on a circle; each phase's entities arrange along a fan from
          that phase outward. Click any node to switch back to tree
          view and scroll the corresponding entity into focus. */}
      {view === 'mindmap' && phases.length > 0 && (
        <RoadmapMindmap
          projectName={projectName}
          phases={phases}
          entities={entities}
          onNodeClick={focusTreeEntry}
        />
      )}
      {view === 'mindmap' && phases.length === 0 && (
        <div class="empty" style={{ padding: 24 }}>
          {t('roadmap.emptyProject')} — {t('roadmap.mindmapNeedsPhases')}
        </div>
      )}

      {/* ADR view — the project's decisions as a record, with their
          supersession lineage spelled out. */}
      {view === 'decisions' && (
        <DecisionsView
          entities={entities}
          onJump={focusTreeEntry}
        />
      )}

      {/* Two-column layout on wide screens: timeline + rails sidebar */}
      {view === 'tree' && (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 16, alignItems: 'start' }}>
        {/* Vertical-timeline tree.
            Each phase is a dot on the trunk; entities branch off as
            indented leaves. ● for completed phases, ○ for the most-
            recent / active one. When phase derivation produced too few
            results (project below density threshold), fall through to
            the date-grouped flat list so small projects still render. */}
        <div style={{ position: 'relative', minWidth: 0 }}>
          {/* Lineage legend — the visible text carrier for the aria-hidden
              arcs below; counts are of DRAWN arcs, never of edges that
              could not be placed. */}
          {(drawnSupersedes > 0 || drawnContradicts > 0) && (
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 6, fontFamily: 'var(--font-ui)' }}>
              {drawnSupersedes > 0 && (
                <span style={{ marginRight: 10 }}>— {t('roadmap.lineageSupersedes', { n: drawnSupersedes })}</span>
              )}
              {drawnContradicts > 0 && (
                <span style={{ color: 'var(--warning)' }}>⋯ {t('roadmap.lineageConflicts', { n: drawnContradicts })}</span>
              )}
            </div>
          )}
          {phases.length > 0 ? (
            <div
              ref={trunkRef}
              style={{
                position: 'relative',
                paddingLeft: 28,
              }}
            >
              {/* Trunk line — runs the full vertical extent */}
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 8,
                  top: 4,
                  bottom: 4,
                  width: 2,
                  background: 'var(--border-subtle)',
                }}
              />
              {/* Lineage arcs — supersedes (solid, neutral: history) and
                  contradicts (dashed, warning: unresolved) between rows on
                  screen. Decorative twin of the legend above. */}
              {edgePaths.length > 0 && (
                <svg
                  aria-hidden="true"
                  style={{ position: 'absolute', left: 0, top: 0, width: 28, height: '100%', overflow: 'visible', pointerEvents: 'none' }}
                >
                  {edgePaths.map((p, i) => (
                    <path
                      key={i}
                      d={p.d}
                      fill="none"
                      stroke={p.type === 'contradicts' ? 'var(--warning)' : 'var(--text-3)'}
                      strokeWidth={1.5}
                      strokeDasharray={p.type === 'contradicts' ? '3 3' : undefined}
                      opacity={0.8}
                    />
                  ))}
                </svg>
              )}
              {(() => {
                // Bucket entities into their derived phase by date range.
                // Entities outside any phase window (single-day micro-runs
                // dropped by derivePhases) hang off a synthetic "Other"
                // group at the end.
                const phaseEntries: Entity[][] = phases.map(() => []);
                const orphans: Entity[] = [];
                for (const e of entities) {
                  const idx = phases.findIndex(
                    (p) => e.created_at >= p.startIso && e.created_at <= p.endIso,
                  );
                  if (idx >= 0) phaseEntries[idx].push(e);
                  else orphans.push(e);
                }
                // Sort within each phase by type priority then created_at desc
                for (const arr of phaseEntries) {
                  arr.sort((a, b) => {
                    const dp = priorityOf(a.type) - priorityOf(b.type);
                    if (dp !== 0) return dp;
                    return b.created_at.localeCompare(a.created_at);
                  });
                }
                // Show phases newest-first to match visual expectation
                const phasesView = phases
                  .map((p, i) => ({ phase: p, entries: phaseEntries[i], idx: i }))
                  .reverse();

                return (
                  <>
                    {phasesView.map(({ phase, entries: phEntries }, vIdx) => {
                      const isActive = vIdx === 0; // most-recent phase
                      return (
                        <div
                          key={`${phase.startIso}-${phase.label}`}
                          style={{ position: 'relative', marginBottom: 22 }}
                        >
                          {/* Phase dot */}
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              left: -28,
                              top: 4,
                              width: 14,
                              height: 14,
                              borderRadius: '50%',
                              background: isActive ? 'transparent' : 'var(--life)',
                              border: `2px solid var(--life)`,
                              boxSizing: 'border-box',
                            }}
                          />
                          {/* Phase header */}
                          <button
                            onClick={() => phase.anchorId !== undefined && focusEntry(phase.anchorId)}
                            disabled={phase.anchorId === undefined}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              gap: 2,
                              padding: 0,
                              background: 'transparent',
                              border: 'none',
                              color: 'inherit',
                              cursor: phase.anchorId !== undefined ? 'pointer' : 'default',
                              fontFamily: 'inherit',
                              textAlign: 'left',
                              width: '100%',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 600,
                                color: 'var(--text-0)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '100%',
                              }}
                            >
                              {phase.label}
                              {isActive && (
                                <span
                                  style={{
                                    marginLeft: 8,
                                    fontSize: 10,
                                    color: 'var(--life)',
                                    fontFamily: 'var(--mono)',
                                    fontWeight: 500,
                                  }}
                                >
                                  {t('roadmap.activePhase')}
                                </span>
                              )}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--text-3)',
                                fontFamily: 'var(--mono)',
                              }}
                            >
                              {phase.startIso.slice(0, 10)} → {phase.endIso.slice(0, 10)} · {phEntries.length === 1 ? t('roadmap.entryCount', { count: 1 }) : t('roadmap.entriesCount', { count: phEntries.length })}
                            </span>
                          </button>
                          {/* Branched entity leaves */}
                          <div style={{ marginTop: 8 }}>
                            {phEntries.map((e, i) => {
                              const isLast = i === phEntries.length - 1;
                              return (
                                <div
                                  key={e.id}
                                  ref={setEntryRef(e.id)}
                                  tabIndex={-1}
                                  data-roadmap-entry-id={e.id}
                                  style={{
                                    position: 'relative',
                                    paddingLeft: 24,
                                    paddingTop: 6,
                                    paddingBottom: 6,
                                  }}
                                >
                                  {/* Branch connector */}
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      position: 'absolute',
                                      left: 0,
                                      top: 0,
                                      bottom: isLast ? '50%' : 0,
                                      width: 1,
                                      background: 'var(--border-subtle)',
                                    }}
                                  />
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      position: 'absolute',
                                      left: 0,
                                      top: '50%',
                                      width: 18,
                                      height: 1,
                                      background: 'var(--border-subtle)',
                                      transform: 'translateY(-50%)',
                                    }}
                                  />
                                  <MemoryRow entity={e} />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {orphans.length > 0 && (
                      <div style={{ position: 'relative', marginBottom: 22 }}>
                        <span
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            left: -28,
                            top: 4,
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            background: 'var(--text-3)',
                            opacity: 0.4,
                          }}
                        />
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--text-2)',
                            fontFamily: 'var(--mono)',
                            marginBottom: 8,
                          }}
                        >
                          {t('roadmap.otherGroup', { count: orphans.length })}
                        </div>
                        {orphans.map((e, i) => {
                          const isLast = i === orphans.length - 1;
                          return (
                            <div
                              key={e.id}
                              ref={setEntryRef(e.id)}
                              tabIndex={-1}
                              data-roadmap-entry-id={e.id}
                              style={{ position: 'relative', paddingLeft: 24, paddingTop: 6, paddingBottom: 6 }}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  position: 'absolute', left: 0, top: 0,
                                  bottom: isLast ? '50%' : 0, width: 1,
                                  background: 'var(--border-subtle)',
                                }}
                              />
                              <span
                                aria-hidden="true"
                                style={{
                                  position: 'absolute', left: 0, top: '50%',
                                  width: 18, height: 1,
                                  background: 'var(--border-subtle)',
                                  transform: 'translateY(-50%)',
                                }}
                              />
                              <MemoryRow entity={e} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ) : (
            // Fallback for projects below the phase-density threshold
            // (<3 entities per 7-day window). Same flat date-bucketed
            // list as before, since there's nothing meaningful to tree.
            groups.map((group) => (
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
                      color: 'var(--life)',
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
                    tabIndex={-1}
                    data-roadmap-entry-id={e.id}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      padding: '12px 0',
                    }}
                  >
                    <MemoryRow entity={e} />
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Sidebar: Milestones + Key Lessons rails */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 16 }}>
          {milestones.length > 0 && (
            <div class="card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-2)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                {t('roadmap.milestones')}
                {filteredMilestoneCount > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.55, textTransform: 'none', letterSpacing: 0 }}>
                    {t('roadmap.lowSignalHidden', { count: filteredMilestoneCount })}
                  </span>
                )}
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
                  <span style={{ flexShrink: 0, color: 'var(--life)' }}><EntityIcon type={m.type} size={14} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {displayTitle(m)}
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
                        {displayTitle(l)}
                      </div>
                      <div style={{ fontSize: 10, color: sig.tone === 'high' ? 'var(--life)' : 'var(--text-3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
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
      )}
    </div>
  );
}

/* ============================================================================
 * DecisionsView — the project's decisions as an ADR-style record.
 * ----------------------------------------------------------------------------
 * One card per decision-type entity, newest first: title (memory voice),
 * date, an honest two-state status derived from the graph — `superseded`
 * when a supersedes edge points AT it (or it arrived archived), `active`
 * otherwise. No invented lifecycle (proposed/accepted/…): the graph does
 * not record one, so the view does not display one.
 *
 * The lineage is spelled out per card: what this decision supersedes, and
 * what superseded it (reverse edges computed here — the payload only
 * carries outgoing relations). Chain targets inside the project jump to
 * the tree view; targets outside it render as plain names.
 * ========================================================================= */
function DecisionsView({ entities, onJump }: { entities: Entity[]; onJump: (id: number) => void }) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>());
  const toggle = (id: number) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const decisions = useMemo(
    () => entities
      .filter((e) => DECISION_TYPES.has(e.type))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [entities],
  );

  const byName = useMemo(() => {
    const m = new Map<string, Entity>();
    for (const e of entities) m.set(e.name, e);
    return m;
  }, [entities]);

  // Reverse supersession index: target name -> the entities that replaced it.
  const supersededBy = useMemo(() => {
    const m = new Map<string, Entity[]>();
    for (const e of entities) {
      for (const r of e.relations ?? []) {
        if (r.type !== 'supersedes') continue;
        const list = m.get(r.to) ?? [];
        list.push(e);
        m.set(r.to, list);
      }
    }
    return m;
  }, [entities]);

  if (decisions.length === 0) {
    return <div class="empty" style={{ padding: 24 }}>{t('adr.empty')}</div>;
  }

  const chainLink = (name: string) => {
    const target = byName.get(name);
    if (!target) return <span style={{ color: 'var(--text-2)' }}>{name}</span>;
    return (
      <button
        onClick={() => onJump(target.id)}
        style={{
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          color: 'var(--life)', fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline',
        }}
      >
        {displayTitle(target)}
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {decisions.map((e) => {
        const replacedBy = supersededBy.get(e.name) ?? [];
        const isSuperseded = replacedBy.length > 0 || Boolean(e.archived) || e.status === 'archived';
        const isOpen = expanded.has(e.id);
        const bodyId = `adr-body-${e.id}`;
        const supersedesTargets = (e.relations ?? []).filter((r) => r.type === 'supersedes').map((r) => r.to);
        return (
          <div
            key={e.id}
            style={{
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              opacity: isSuperseded ? 0.75 : 1,
            }}
          >
            <button
              aria-expanded={isOpen}
              aria-controls={bodyId}
              onClick={() => toggle(e.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                background: 'transparent', border: 'none', padding: 0,
                cursor: 'pointer', color: 'inherit', textAlign: 'left', fontFamily: 'inherit',
              }}
            >
              <span aria-hidden="true" style={{ color: 'var(--text-3)', fontSize: 10, width: 10, flexShrink: 0 }}>
                {isOpen ? '▾' : '▸'}
              </span>
              <EntityIcon type={e.type} size={14} />
              <span style={{ fontFamily: 'var(--font-memory)', fontSize: 15, color: 'var(--text-0)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {displayTitle(e)}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>
                {e.created_at.slice(0, 10)}
              </span>
              <span
                style={{
                  fontSize: 10,
                  padding: '2px 8px',
                  borderRadius: 9999,
                  flexShrink: 0,
                  background: isSuperseded ? 'var(--neutral-soft)' : 'var(--life-soft)',
                  color: isSuperseded ? 'var(--text-2)' : 'var(--life)',
                }}
              >
                {isSuperseded ? t('adr.statusSuperseded') : t('adr.statusActive')}
              </span>
            </button>
            {isOpen && (
              <div id={bodyId} style={{ marginTop: 8, paddingLeft: 18 }}>
                {e.observations.map((obs, i) => (
                  <p key={i} style={{ fontFamily: 'var(--font-memory)', fontSize: 15, lineHeight: 1.6, color: 'var(--text-1)', margin: '0 0 6px' }}>
                    {obs}
                  </p>
                ))}
                {(supersedesTargets.length > 0 || replacedBy.length > 0) && (
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {supersedesTargets.map((name) => (
                      <span key={`s-${name}`}>{t('adr.supersedes')} → {chainLink(name)}</span>
                    ))}
                    {replacedBy.map((winner) => (
                      <span key={`b-${winner.id}`}>{t('adr.supersededBy')} → {chainLink(winner.name)}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * RoadmapMindmap — radial dendrogram view for a project's phases + entities.
 * ----------------------------------------------------------------------------
 * Layout: project node at the SVG centre; phases sit on a circle of radius
 * R_PHASE around it; each phase's entities fan out from the phase node along
 * a wedge of the surrounding annulus. Connector curves use a quadratic
 * Bézier that hands off near the parent then straightens at the leaf, which
 * reads as "branches" rather than starbursts.
 *
 * Click any node → caller switches back to tree view and scrolls the
 * corresponding entity into focus. The mindmap is read-only; everything
 * navigation-shaped delegates to the tree view's existing focus behaviour.
 * ========================================================================= */
interface MindmapProps {
  projectName: string;
  phases: Phase[];
  entities: Entity[];
  onNodeClick: (entityId: number) => void;
}

function RoadmapMindmap({ projectName, phases, entities, onNodeClick }: MindmapProps) {
  // Bucket entities by phase (same logic as tree view)
  const phaseEntries: Entity[][] = phases.map(() => []);
  for (const e of entities) {
    const idx = phases.findIndex(
      (p) => e.created_at >= p.startIso && e.created_at <= p.endIso,
    );
    if (idx >= 0) phaseEntries[idx].push(e);
  }
  // Sort within each phase by type priority then date desc
  for (const arr of phaseEntries) {
    arr.sort((a, b) => {
      const dp = priorityOf(a.type) - priorityOf(b.type);
      if (dp !== 0) return dp;
      return b.created_at.localeCompare(a.created_at);
    });
  }
  // Cap entities per phase so a single dense phase doesn't crowd out the rest
  const MAX_ENTITIES_PER_PHASE = 6;
  const truncated = phaseEntries.map((arr) => ({
    shown: arr.slice(0, MAX_ENTITIES_PER_PHASE),
    extra: Math.max(0, arr.length - MAX_ENTITIES_PER_PHASE),
  }));

  const W = 900;
  const H = 600;
  const cx = W / 2;
  const cy = H / 2;
  const R_PHASE = 170;
  const R_ENTITY_INNER = 230;
  const R_ENTITY_STEP = 30;

  // Spread phases evenly around the circle, starting from -90deg (top)
  const phaseAngle = (i: number) => (2 * Math.PI * i) / phases.length - Math.PI / 2;

  // ---- Pan / wheel-zoom state ----
  // We translate then scale in SVG-space. The viewBox is fixed at 0..W x 0..H,
  // so a screen-pixel delta is mapped to SVG-space via the SVG's actual
  // bounding rect at event time (handled in the wheel/move helpers below).
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [scale, setScale] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  // Refs mirror state so the wheel handler (attached once via useEffect) reads
  // current values without needing to be re-bound every render.
  const scaleRef = useRef(scale);
  const panRef2 = useRef({ x: panX, y: panY });
  scaleRef.current = scale;
  panRef2.current = { x: panX, y: panY };
  const panRef = useRef<{ active: boolean; lastX: number; lastY: number }>({
    active: false,
    lastX: 0,
    lastY: 0,
  });
  const [grabbing, setGrabbing] = useState(false);

  const SCALE_MIN = 0.25;
  const SCALE_MAX = 4;

  /** Convert client (screen) coords to SVG-viewBox coords by undoing the
   *  SVG element's CSS scaling. We do NOT undo the pan/scale transform —
   *  callers want the pre-transform world position so we can re-anchor
   *  zoom around the cursor. */
  const clientToSvg = (clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - r.left) / r.width) * W,
      y: ((clientY - r.top) / r.height) * H,
    };
  };

  // Wheel handler must be attached as a non-passive listener so preventDefault()
  // actually stops the page from scrolling. Preact's onWheel JSX prop is
  // delegated and effectively passive, so we attach the listener manually.
  // Bound once; reads current scale/pan via refs.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const cur = scaleRef.current;
      const curPan = panRef2.current;
      // Smooth, sign-correct zoom factor. deltaY > 0 (scroll down) zooms out.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.max(SCALE_MIN, Math.min(SCALE_MAX, cur * factor));
      if (next === cur) return;
      // Anchor zoom on cursor: keep the world-point under the cursor stationary.
      // World point pre-zoom: w = (svg - pan) / scale
      // After zoom we want: w = (svg - panNew) / next  →  panNew = svg - w * next
      const { x: sx, y: sy } = clientToSvg(e.clientX, e.clientY);
      const wx = (sx - curPan.x) / cur;
      const wy = (sy - curPan.y) / cur;
      setScale(next);
      setPanX(sx - wx * next);
      setPanY(sy - wy * next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onMouseDown = (e: JSX.TargetedMouseEvent<SVGSVGElement>) => {
    // Only pan on background drags. Phase nodes and entity leaves are wrapped
    // in <g style={{cursor:'pointer'}}> with onClick handlers — if mousedown
    // landed inside one of those, let the click pass through (don't pan).
    // The pan/zoom group itself has no cursor:pointer, so we can use that
    // to distinguish background from interactive node.
    const target = e.target as Element | null;
    let cur: Element | null = target;
    while (cur && cur !== svgRef.current) {
      // SVGElement.style.cursor reflects the inline style attribute.
      const c = (cur as SVGElement).style?.cursor;
      if (c === 'pointer') return; // hit an interactive node — don't pan
      cur = cur.parentElement;
    }
    e.preventDefault();
    panRef.current.active = true;
    panRef.current.lastX = e.clientX;
    panRef.current.lastY = e.clientY;
    setGrabbing(true);
  };

  const onMouseMove = (e: JSX.TargetedMouseEvent<SVGSVGElement>) => {
    if (!panRef.current.active) return;
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // Map screen-pixel deltas into viewBox coordinates so panning matches
    // cursor speed regardless of CSS-rendered SVG size.
    const dx = ((e.clientX - panRef.current.lastX) / r.width) * W;
    const dy = ((e.clientY - panRef.current.lastY) / r.height) * H;
    panRef.current.lastX = e.clientX;
    panRef.current.lastY = e.clientY;
    setPanX((p) => p + dx);
    setPanY((p) => p + dy);
  };

  const endPan = () => {
    if (!panRef.current.active) return;
    panRef.current.active = false;
    setGrabbing(false);
  };

  const resetView = () => {
    setScale(1);
    setPanX(0);
    setPanY(0);
  };

  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        background: 'rgba(255,255,255,0.02)',
        overflow: 'hidden',
        marginBottom: 14,
      }}
    >
      {/* Reset button — top-right overlay */}
      <button
        onClick={resetView}
        title={t('roadmap.resetHint')}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 2,
          padding: '4px 10px',
          fontSize: 11,
          fontFamily: 'inherit',
          background: 'rgba(0,0,0,0.4)',
          color: 'var(--text-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xs)',
          cursor: 'pointer',
        }}
      >
        {t('graph.resetView')}
      </button>
      {/* Hint */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 12,
          zIndex: 2,
          fontSize: 10,
          fontFamily: 'var(--mono)',
          color: 'var(--text-3)',
          pointerEvents: 'none',
        }}
      >
        {t('roadmap.zoomHint', { pct: Math.round(scale * 100) })}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{
          display: 'block',
          minHeight: 600,
          cursor: grabbing ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endPan}
        onMouseLeave={endPan}
        onDblClick={resetView}
      >
        <g transform={`translate(${panX} ${panY}) scale(${scale})`}>
        {/* Connector curves: project → phase, phase → entities */}
        {phases.map((_, i) => {
          const ang = phaseAngle(i);
          const px = cx + R_PHASE * Math.cos(ang);
          const py = cy + R_PHASE * Math.sin(ang);
          return (
            <path
              key={`p-${i}`}
              d={`M ${cx} ${cy} Q ${(cx + px) / 2} ${(cy + py) / 2 - 10} ${px} ${py}`}
              fill="none"
              stroke="rgba(143, 242, 92, 0.4)"
              strokeWidth={1.5}
            />
          );
        })}
        {phases.map((_, i) => {
          const { shown } = truncated[i];
          const baseAng = phaseAngle(i);
          const phasePx = cx + R_PHASE * Math.cos(baseAng);
          const phasePy = cy + R_PHASE * Math.sin(baseAng);
          const wedge = Math.PI / 6; // 30deg total wedge per phase
          return shown.map((e, j) => {
            const t = shown.length === 1 ? 0.5 : j / (shown.length - 1);
            const ang = baseAng - wedge / 2 + wedge * t;
            const r = R_ENTITY_INNER + R_ENTITY_STEP * (j % 3);
            const ex = cx + r * Math.cos(ang);
            const ey = cy + r * Math.sin(ang);
            return (
              <path
                key={`e-${i}-${e.id}`}
                d={`M ${phasePx} ${phasePy} Q ${(phasePx + ex) / 2} ${(phasePy + ey) / 2} ${ex} ${ey}`}
                fill="none"
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={1}
              />
            );
          });
        })}

        {/* Project node — centre */}
        <g>
          <circle cx={cx} cy={cy} r={42} fill="rgba(143, 242, 92, 0.18)" stroke="var(--life)" strokeWidth={1.5} />
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fontWeight={600}
            fill="var(--text-0)"
            style={{ pointerEvents: 'none' }}
          >
            {projectName.length > 14 ? projectName.slice(0, 12) + '…' : projectName}
          </text>
        </g>

        {/* Phase nodes */}
        {phases.map((phase, i) => {
          const ang = phaseAngle(i);
          const px = cx + R_PHASE * Math.cos(ang);
          const py = cy + R_PHASE * Math.sin(ang);
          const labelTrunc = phase.label.length > 18 ? phase.label.slice(0, 16) + '…' : phase.label;
          return (
            <g
              key={`phase-${i}`}
              role={phase.anchorId !== undefined ? 'button' : undefined}
              tabindex={phase.anchorId !== undefined ? 0 : undefined}
              aria-label={phase.anchorId !== undefined ? phase.label : undefined}
              style={{ cursor: phase.anchorId !== undefined ? 'pointer' : 'default' }}
              onClick={() => phase.anchorId !== undefined && onNodeClick(phase.anchorId)}
              onKeyDown={(ev: KeyboardEvent) => {
                if (phase.anchorId !== undefined && (ev.key === 'Enter' || ev.key === ' ')) {
                  ev.preventDefault();
                  onNodeClick(phase.anchorId);
                }
              }}
            >
              <circle
                cx={px}
                cy={py}
                r={28}
                fill="rgba(143, 242, 92, 0.10)"
                stroke="var(--life)"
                strokeWidth={1.25}
              />
              <text
                x={px}
                y={py - 4}
                textAnchor="middle"
                fontSize={10}
                fontWeight={600}
                fill="var(--text-0)"
                style={{ pointerEvents: 'none' }}
              >
                <tspan x={px} dy={0}>{labelTrunc}</tspan>
                <tspan x={px} dy={12} fontSize={9} fill="var(--text-3)" fontWeight={400} fontFamily="var(--mono)">
                  {phase.entityCount} · {phase.startIso.slice(5, 10)}
                </tspan>
              </text>
            </g>
          );
        })}

        {/* Entity leaves */}
        {phases.map((_, i) => {
          const { shown, extra } = truncated[i];
          const baseAng = phaseAngle(i);
          const wedge = Math.PI / 6;
          return (
            <g key={`leaves-${i}`}>
              {shown.map((e, j) => {
                const t = shown.length === 1 ? 0.5 : j / (shown.length - 1);
                const ang = baseAng - wedge / 2 + wedge * t;
                const r = R_ENTITY_INNER + R_ENTITY_STEP * (j % 3);
                const ex = cx + r * Math.cos(ang);
                const ey = cy + r * Math.sin(ang);
                const label = displayTitle(e);
                const labelTrunc = label.length > 22 ? label.slice(0, 20) + '…' : label;
                return (
                  <g
                    key={e.id}
                    role="button"
                    tabindex={0}
                    aria-label={`${label} (${typeLabel(e.type)})`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => onNodeClick(e.id)}
                    onKeyDown={(ev: KeyboardEvent) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        onNodeClick(e.id);
                      }
                    }}
                  >
                    <title>{`${label} (${e.type})`}</title>
                    <circle
                      cx={ex}
                      cy={ey}
                      r={4}
                      fill="var(--text-2)"
                    />
                    <text
                      x={ex}
                      y={ey - 8}
                      textAnchor={Math.cos(ang) > 0.2 ? 'start' : Math.cos(ang) < -0.2 ? 'end' : 'middle'}
                      fontSize={9}
                      fill="var(--text-1)"
                      style={{ pointerEvents: 'none' }}
                    >
                      {labelTrunc}
                    </text>
                  </g>
                );
              })}
              {extra > 0 && (() => {
                const ang = baseAng + wedge / 2 + 0.05;
                const r = R_ENTITY_INNER + R_ENTITY_STEP * 2 + 10;
                const ex = cx + r * Math.cos(ang);
                const ey = cy + r * Math.sin(ang);
                return (
                  <text
                    x={ex}
                    y={ey}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--text-3)"
                    fontStyle="italic"
                  >
                    {t('roadmap.moreEntities', { count: extra })}
                  </text>
                );
              })()}
            </g>
          );
        })}
        </g>
      </svg>
    </div>
  );
}
