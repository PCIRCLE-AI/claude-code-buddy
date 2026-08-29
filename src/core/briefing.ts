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
// exactly once — classification, phrasing, the assembly order, the budget,
// the fence — is imported from the single owners below.
//
// The selection is a LEAN read on purpose. The first version went through
// `kg.search`/`kg.listRecent`, which hydrate observations, tags and relations
// for every candidate (up to 2×400 rows to render ~35 lines) and bump
// `access_count` on all of them — recall's machinery, sized for limit≈20 and
// for callers that asked. A briefing is not an ask for 800 memories: it reads
// scalar columns for the window, ranks, gates, and fetches ONE snippet per
// survivor — the same shape the hook uses. It also tracks no access: the
// hook's injection never has, and a ranking signal that means "was shown
// unasked" would inflate frequency for whatever happened to be in the window.

import { getDatabase } from '../db.js';
import { getProjectName } from './paths.js';
import { readRepoState, repoStateLines } from './repo-state.js';
import { rankEntities } from './scoring.js';
import { getTaskState } from './task-state-store.js';
import { unreadDeliveryCount, unreadInboxLines } from './agent-message-inbox.js';
import { taskStateLines } from './task-state.js';
import {
  SNIPPET_FETCH_CHARS,
  TOPOLOGY_CANDIDATE_CAP,
  assembleTopologyBlock,
  buildReferenceContext,
  isAutoInjectable,
  type TopologyEntity,
} from './work-topology.js';

const PROJECT_LIMIT = 30;
const RECENT_LIMIT = 5;

export interface BriefingResult {
  project: string;
  /** The fenced, injection-ready block — identical framing to the hook's. */
  text: string;
  /** How many memories were rendered into the block (excluding the task state). */
  entityCount: number;
  /** Whether a recorded task state leads the block. */
  hasTaskState: boolean;
}

interface CandidateRow {
  id: number;
  name: string;
  type: string | null;
  title: string | null;
  metadata: string | null;
  access_count: number | null;
  last_accessed_at: string | null;
  confidence: number | null;
  recall_hits: number | null;
  recall_misses: number | null;
}

const CANDIDATE_COLUMNS =
  'e.id, e.name, e.type, e.title, e.metadata, e.access_count, e.last_accessed_at, e.confidence, e.recall_hits, e.recall_misses';

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Rank a candidate window with core's own scoring, gate it, and cap it.
 * Wide fetch BEFORE the gate — the starvation bug this repo measured was a
 * top-N cut applied before a filter, letting one blocked class consume the
 * whole window.
 */
interface PoolRow {
  id: number;
  name: string;
  type: string | null;
  title: string | null;
  meta: Record<string, unknown> | null;
  access_count?: number;
  last_accessed_at?: string;
  confidence?: number;
  recall_hits?: number;
  recall_misses?: number;
}

function selectPool(rows: CandidateRow[], cap: number): PoolRow[] {
  const withMeta: PoolRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    title: row.title,
    meta: parseMetadata(row.metadata),
    // SQLite hands back null for absent scalars; rankEntities' generic wants
    // them undefined. Same values, one shape.
    access_count: row.access_count ?? undefined,
    last_accessed_at: row.last_accessed_at ?? undefined,
    confidence: row.confidence ?? undefined,
    recall_hits: row.recall_hits ?? undefined,
    recall_misses: row.recall_misses ?? undefined,
  }));
  return rankEntities(withMeta, new Map())
    .filter((row) => isAutoInjectable(row.meta))
    .slice(0, cap);
}

function toTopologyEntity(row: PoolRow, snippet: string | null): TopologyEntity {
  const signal = row.meta?.signal_score;
  return {
    name: row.name,
    type: row.type || 'memory',
    // The citation handle: briefing lines carry the same `[mem:<id>]` ref
    // the session-start injection prints, so a memory reads the same way on
    // every surface an agent meets it.
    id: row.id,
    title: row.title,
    snippet,
    signalScore: typeof signal === 'number' ? signal : null,
  };
}

/**
 * Assemble the same block session-start injects, for a caller that has no
 * session-start: task state first (the one line someone stated on purpose),
 * then the ranked topology, wrapped in the shared fence.
 */
export function assembleBriefing(project?: string): BriefingResult {
  const projectName = project ?? getProjectName();
  const db = getDatabase();

  // Derived first, stated second, and in that order on purpose. Both blocks
  // used to be one: the stated goal was injected under a heading that read as
  // the project's status, and nothing else in the briefing said where the work
  // actually was. Facts read from git on the way out cannot be stale; a
  // recorded intention always can be, so it follows the facts rather than
  // standing in for them.
  // Only when the process is actually standing in that project. `project` is
  // a NAME, not a path, so `process.cwd()` is the right repository for a CLI
  // run and can be an entirely different one over MCP, where the server's cwd
  // has nothing to do with the project being asked about. Reporting this
  // repository's branch under another project's heading would be a new way of
  // saying something false, which is the thing this module exists to stop.
  const repoLines = (project === undefined || project === getProjectName())
    ? repoStateLines(readRepoState())
    : [];

  // The one stated line, before anything ranked — same reasoning as the
  // hook: ranking cannot know what you meant to do next.
  const { state } = getTaskState(projectName);
  // The inbox line rides WITH the stated lines, not among the ranked
  // memories: like goal / next / blocked it is a fact the agent must act
  // on, not a memory that scored well. See agent-message-inbox.ts.
  const stateLines = [
    ...taskStateLines(state, projectName),
    ...unreadInboxLines(unreadDeliveryCount(db, projectName), projectName),
  ];

  const projectRows = db.prepare(
    `SELECT DISTINCT ${CANDIDATE_COLUMNS}
     FROM entities e JOIN tags t ON t.entity_id = e.id
     WHERE t.tag = ? AND e.status = 'active'
     ORDER BY e.id DESC
     LIMIT ?`,
  ).all(`project:${projectName}`, TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[];
  const projectPool = selectPool(projectRows, PROJECT_LIMIT);

  // Recent pool: newest activity across ALL projects. Anything only here is
  // from elsewhere and must say so — the assembler files rows from a foreign
  // pool under a heading that does not claim this project.
  const recentRows = db.prepare(
    `SELECT ${CANDIDATE_COLUMNS}
     FROM entities e
     WHERE e.status = 'active'
     ORDER BY e.id DESC
     LIMIT ?`,
  ).all(TOPOLOGY_CANDIDATE_CAP) as unknown as CandidateRow[];
  const recentPool = selectPool(recentRows, RECENT_LIMIT);

  // One snippet per survivor, one query — first observation per entity,
  // fetched a few line-widths long so clip() can still cut on a word
  // boundary. This is the survivors-only hydration the hook already uses.
  const survivorIds = [...new Set([...projectPool, ...recentPool].map((row) => row.id))];
  const snippets = new Map<number, string>();
  if (survivorIds.length > 0) {
    const placeholders = survivorIds.map(() => '?').join(',');
    const obsRows = db.prepare(
      `SELECT entity_id, substr(content, 1, ${SNIPPET_FETCH_CHARS}) AS content
       FROM observations WHERE entity_id IN (${placeholders})
       ORDER BY id ASC`,
    ).all(...survivorIds) as Array<{ entity_id: number; content: string | null }>;
    for (const row of obsRows) {
      if (snippets.has(row.entity_id)) continue;
      const text = String(row.content ?? '').trim();
      if (text) snippets.set(row.entity_id, text);
    }
  }

  const toEntities = (pool: PoolRow[]) =>
    pool.map((row) => toTopologyEntity(row, snippets.get(row.id) ?? null));

  const lines = assembleTopologyBlock(
    stateLines,
    [
      { entities: toEntities(projectPool), foreign: false },
      { entities: toEntities(recentPool), foreign: true },
    ],
    projectName,
  );

  // Repository facts PREFIX a briefing; they never constitute one. Prepending
  // them unconditionally made "nothing to say" impossible — every call inside
  // a git repository returned a fenced block whose entire content was a branch
  // name, which is the one thing the agent can already see. So the emptiness
  // test comes first and the facts are context for memories, not a substitute.
  const withRepo = lines.length > 0 && repoLines.length > 0
    ? [...repoLines, '', ...lines]
    : lines;

  return {
    project: projectName,
    text: lines.length > 0 ? buildReferenceContext(withRepo) : '',
    entityCount: lines.filter((l) => l.startsWith('- [')).length,
    hasTaskState: stateLines.length > 0,
  };
}
