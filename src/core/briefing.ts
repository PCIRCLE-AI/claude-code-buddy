// =============================================================================
// briefing — the assembled work topology, for agents that do not run the hooks
// =============================================================================
//
// Claude Code gets the topology pushed at session start by
// `scripts/hooks/session-start.js`. Every other MCP client — Gemini, Codex,
// anything that speaks the protocol — runs no hooks, so until this existed
// they could reach the PARTS (recall, task_state) but never the assembled
// block. "Cross-vendor gets the assembled topology, not the parts" is A1c's
// acceptance criterion, verbatim.
//
// This deliberately does NOT share selection SQL with the hook. That is the
// A1a design decision, restated in work-topology.ts's header: each consumer
// owns its own database access with its own compat rules; what must exist
// exactly once is the CLASSIFICATION, the PHRASING and the FENCE — and those
// are imported from the single owners below (work-topology, task-state). The
// hook queries raw SQLite because it cannot import core; this side uses
// core's own recall selection, which already owns ranking.

import { getDatabase } from '../db.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { getProjectName } from './paths.js';
import { rankEntities } from './scoring.js';
import { getTaskState } from './task-state-store.js';
import { taskStateLines, taskStateName } from './task-state.js';
import {
  buildReferenceContext,
  buildTopologyLines,
  isAutoInjectable,
  type TopologyEntity,
} from './work-topology.js';
import type { Entity } from './types.js';

// Same shape as the hook's budget: a block that primes a session without
// eating its working context. The hook reads a configured session limit for
// the project pool; this surface uses a fixed cap because its caller can
// simply ask again with `recall` for more — the hook cannot be asked.
const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;
const CANDIDATE_CAP = 400;
const MAX_CONTEXT_CHARS = 4000;
const MAX_LINE_CHARS = 160;

export interface BriefingResult {
  project: string;
  /** The fenced, injection-ready block — identical framing to the hook's. */
  text: string;
  /** How many memories made it into the block (excluding the task state). */
  entityCount: number;
  /** Whether a recorded task state leads the block. */
  hasTaskState: boolean;
}

function toTopologyEntity(entity: Entity, foreign: boolean): TopologyEntity {
  const signal = entity.metadata?.signal_score;
  return {
    name: entity.name,
    type: entity.type || 'memory',
    title: entity.title ?? null,
    snippet: entity.observations[0]?.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS) || null,
    signalScore: typeof signal === 'number' ? signal : null,
    foreign,
  };
}

/**
 * Assemble the same block session-start injects, for a caller that has no
 * session-start: task state first (the one line someone stated on purpose),
 * then the ranked topology, wrapped in the shared fence.
 */
export function assembleBriefing(project?: string): BriefingResult {
  const projectName = project ?? getProjectName();
  const kg = new KnowledgeGraph(getDatabase());

  // The one stated line, before anything ranked — same reasoning as the
  // hook: ranking cannot know what you meant to do next.
  const { state } = getTaskState(projectName);
  const stateLines = taskStateLines(state, projectName);

  // Project pool: everything tagged to this project, ranked by core's own
  // scoring (the owner of the weights the hook's SQL mirrors), then gated by
  // the shared auto-injection policy. Wide fetch before the gate — the
  // starvation bug this repo measured was a top-N cut applied BEFORE a
  // filter, letting one blocked class consume the whole window.
  const projectPool = rankEntities(
    kg.search(undefined, { tag: `project:${projectName}`, limit: CANDIDATE_CAP }),
    new Map(),
  )
    .filter((e) => isAutoInjectable(e.metadata))
    .slice(0, PROJECT_LIMIT);

  // Recent pool: newest activity across ALL projects. Anything only here is
  // from elsewhere and must say so — groupTopology files `foreign` rows under
  // a heading that does not claim this project.
  const recentPool = rankEntities(kg.listRecent(CANDIDATE_CAP), new Map())
    .filter((e) => isAutoInjectable(e.metadata))
    .slice(0, RECENT_LIMIT);

  const taskEntity = taskStateName(projectName);
  const seen = new Set<number>();
  const candidates: TopologyEntity[] = [];
  const addAll = (rows: Entity[], foreign: boolean) => {
    for (const e of rows) {
      if (seen.has(e.id)) continue;
      // Rendered in full above; listed again under a ranked heading it would
      // repeat the goal as though it were a separate memory.
      if (e.name === taskEntity) continue;
      seen.add(e.id);
      candidates.push(toTopologyEntity(e, foreign));
    }
  };
  addAll(projectPool, false);
  addAll(recentPool, true);

  const lines: string[] = [];
  if (stateLines.length > 0) lines.push(...stateLines, '');
  const topologyLines = buildTopologyLines(candidates, projectName, {
    maxChars: MAX_CONTEXT_CHARS,
    maxLineChars: MAX_LINE_CHARS,
  });
  lines.push(...topologyLines);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return {
    project: projectName,
    text: lines.length > 0 ? buildReferenceContext(lines) : '',
    // Counted from what was actually RENDERED, not from the candidate pool —
    // the budget can cut candidates, and a count that includes the cut ones
    // would overstate what the caller received.
    entityCount: topologyLines.filter((l) => l.startsWith('- [')).length,
    hasTaskState: stateLines.length > 0,
  };
}
