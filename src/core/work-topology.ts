// =============================================================================
// work-topology — which memories are the WORK, and how to say them in one line
// =============================================================================
//
// A runtime leaf with no imports at all, so
// scripts/generate-hook-core.mjs copies it next to the hooks. Three consumers
// were meant to share one answer to "what counts as the work layer" — the
// graph, the memory list, and what gets injected into an agent — and both the
// CEO and the design review landed independently on the same conclusion: that
// whitelist must exist exactly once. `WORK_LAYER_TYPES` below is it. UX-4
// consumes this constant rather than defining its own.
//
// Deliberately no SQL here. The hook, the MCP transport and the dashboard each
// already own a database handle with their own schema-compat rules; what they
// were missing is the *classification and phrasing*, which is what this file
// is. Keeping queries out also makes the whole thing unit-testable without a
// database.

/**
 * The work layer: memories that describe the WORK — what was decided, what
 * was learned, what is being aimed at. This is the single whitelist.
 *
 * `goal`, `plan` and `task-state` are listed before anything writes them
 * (measured 2026-08-16: zero rows of each). That is deliberate — the line
 * between layers should not move when A1b starts writing them, or the
 * before/after numbers stop being comparable.
 */
export const WORK_LAYER_TYPES: ReadonlySet<string> = new Set([
  'decision',
  'lesson_learned',
  'lesson',
  'mistake',
  'milestone',
  'pattern',
  'technical_pattern',
  'goal',
  'plan',
  'task-state',
]);

/**
 * The evidence layer: mechanical capture. Not noise — it is what the work
 * layer is derived FROM, and on a graph with no curated memories yet it is
 * the only thing there is. It ranks last and is shown only when the layers
 * above it leave room, which is the empty-state fallback both reviews asked
 * for: never an empty injection.
 */
export const EVIDENCE_LAYER_TYPES: ReadonlySet<string> = new Set([
  'commit',
  'session-insight',
  'session-summary',
  'session_keypoint',
  'session-identity',
  'session_identity',
  'weekly-summary',
  'weekly_summary',
  'workflow_checkpoint',
]);

export type TopologyLayer = 'work' | 'knowledge' | 'evidence';

export function layerOf(type: string): TopologyLayer {
  if (WORK_LAYER_TYPES.has(type)) return 'work';
  if (EVIDENCE_LAYER_TYPES.has(type)) return 'evidence';
  return 'knowledge';
}

export interface TopologyEntity {
  name: string;
  type: string;
  /** UX-1's human-readable display string. */
  title?: string | null;
  /** First observation — the fallback when there is no title. */
  snippet?: string | null;
  /** metadata.signal_score. Null for hook-captured rows, which never get
   *  scored (hooks are cheap always-on capture by design). */
  signalScore?: number | null;
  /** True when this memory belongs to a DIFFERENT project than the one being
   *  described. It still earns a place — a lesson learned elsewhere is often
   *  the one that saves you — but it must not be filed under a heading that
   *  claims it is about the current project. */
  foreign?: boolean;
}

/**
 * The one line an entity gets.
 *
 * `title → snippet → type`, and NEVER the name. `name` is a machine dedup key
 * (`session-<pid>-<ts>-files`, `commit-a1b2c3d`); a model spends tokens
 * reading it and gets nothing. Measured over ten real sessions: of the
 * memories injected under the old name-first format, the number the
 * transcript went on to mention was zero.
 *
 * Titles are usually derived from the first observation, so emitting title
 * AND snippet sent the same sentence twice — that redundancy, plus the name,
 * is most of what this format removes.
 */
export function topologyLine(entity: TopologyEntity, maxChars: number): string {
  const title = entity.title?.trim();
  const snippet = entity.snippet?.trim();
  const text = title || snippet || `${entity.type} memory`;
  return `- [${entity.type}] ${clip(text, maxChars)}`;
}

/**
 * Truncate on a word boundary. The previous format cut at a fixed offset and
 * shipped fragments like "…Led user throug" — the reader pays for the whole
 * clause and cannot use the end of it.
 */
function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  // Only respect the boundary if it is not pathologically early (a single
  // very long token would otherwise collapse the line to nothing).
  const base = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/** Highest signal first; unscored rows sort last but are never dropped. */
function bySignal(a: TopologyEntity, b: TopologyEntity): number {
  const av = typeof a.signalScore === 'number' ? a.signalScore : -1;
  const bv = typeof b.signalScore === 'number' ? b.signalScore : -1;
  return bv - av;
}

export interface TopologySection {
  heading: string;
  entities: TopologyEntity[];
}

/**
 * Group into the sections an agent actually needs, in the order it needs
 * them: what was decided, what not to repeat, what else is known, and only
 * then the raw activity trail.
 *
 * Order is a budget decision as much as an editorial one — the caller
 * truncates from the tail, so whatever ranks last is what gets cut. Decisions
 * and lessons lead because they are the most expensive things to rediscover
 * and the most costly to contradict; the evidence trail is last because a
 * session can re-derive it from git and the filesystem in a way it cannot
 * re-derive a decision's reasoning.
 */
export function groupTopology(entities: TopologyEntity[], projectName: string): TopologySection[] {
  const decisions: TopologyEntity[] = [];
  const lessons: TopologyEntity[] = [];
  const knowledge: TopologyEntity[] = [];
  const evidence: TopologyEntity[] = [];
  const foreign: TopologyEntity[] = [];

  for (const e of entities) {
    // Scope is checked before layer: a memory from another project must never
    // land under a heading that names this one, whatever its type.
    if (e.foreign) { foreign.push(e); continue; }
    const layer = layerOf(e.type);
    if (layer === 'evidence') { evidence.push(e); continue; }
    if (layer === 'knowledge') { knowledge.push(e); continue; }
    if (e.type === 'lesson_learned' || e.type === 'lesson' || e.type === 'mistake') lessons.push(e);
    else decisions.push(e);
  }

  for (const list of [decisions, lessons, knowledge, evidence, foreign]) list.sort(bySignal);

  const sections: TopologySection[] = [];
  if (decisions.length) sections.push({ heading: `Decisions and direction for "${projectName}":`, entities: decisions });
  if (lessons.length) sections.push({ heading: `Lessons from "${projectName}" — do not repeat these:`, entities: lessons });
  if (knowledge.length) sections.push({ heading: `What is known about "${projectName}":`, entities: knowledge });
  if (evidence.length) sections.push({ heading: `Recent activity in "${projectName}":`, entities: evidence });
  if (foreign.length) sections.push({ heading: 'From your other projects (may or may not apply here):', entities: foreign });
  return sections;
}

export interface TopologyBudget {
  /** Hard ceiling on the assembled block, in characters. */
  maxChars: number;
  /** Per-line ceiling for the display text. */
  maxLineChars?: number;
  /** Ceiling per section, so one crowded section cannot eat the budget. */
  maxPerSection?: number;
}

/**
 * Assemble the injected lines, newest concern first, within budget.
 *
 * Returns whole lines only: the caller wraps them in a fence, and a line cut
 * in half by the budget could leave that fence danglable.
 */
export function buildTopologyLines(
  entities: TopologyEntity[],
  projectName: string,
  budget: TopologyBudget,
): string[] {
  const maxLineChars = budget.maxLineChars ?? 150;
  const maxPerSection = budget.maxPerSection ?? 8;
  const lines: string[] = [];
  let used = 0;

  for (const section of groupTopology(entities, projectName)) {
    const candidate = section.entities.slice(0, maxPerSection);
    const rendered: string[] = [];
    for (const e of candidate) {
      const line = topologyLine(e, maxLineChars);
      if (used + line.length + 1 > budget.maxChars) break;
      rendered.push(line);
      used += line.length + 1;
    }
    if (rendered.length === 0) continue;
    // Charge the heading only once it has something under it.
    if (used + section.heading.length + 2 > budget.maxChars) break;
    used += section.heading.length + 2;
    lines.push(section.heading, ...rendered, '');
  }

  // Drop the trailing spacer so the block does not end on a blank line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
