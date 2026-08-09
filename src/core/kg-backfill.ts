// =============================================================================
// Knowledge-graph relation backfill — non-LLM heuristics
// =============================================================================
//
// Diagnostic at session start: 1191 of 1328 active entities (89.7%)
// had zero relations. Auto-tagger and dreamer both build relations
// IN PRINCIPLE but only when LLM is available AND on entities they
// process — the long tail of pre-existing entities never gets touched.
// This module fills the gap with cheap, deterministic heuristics that
// run without any LLM:
//
//   1. tag co-occurrence: two active entities sharing ≥ 2 topical
//      tags get a `related-to` edge.
//   2. project clustering: orphan lessons / decisions / bug_fix in
//      a project get linked to the most recent release / feature in
//      that same project (high signal, low noise).
//
// What "topical" means:
//   The system writes a LOT of bookkeeping tags that look topical at
//   a glance (session_end, auto_saved, commit, auto-tracked,
//   type:*, urgency:*, host:*, session:*, week:*) but pairing every
//   entity that shares them produces a cartesian explosion (644 x 644
//   = 207k edges from session_end alone). The TOPICAL_TAG filter
//   keeps:
//     - tags starting with `topic:` or `tech:` (auto-tagger
//       canonical prefixes — see src/core/auto-tagger.ts)
//     - bare tags that are not in the bookkeeping blocklist
//   and rejects everything else.

import type { MemeshDatabase } from '../storage/sqlite.js';
import { getDatabase } from '../db.js';

const SYSTEM_TAG_PREFIXES = [
  'project:', 'week:', 'severity:', 'scope:', 'source:', 'date:',
  'type:', 'urgency:', 'host:', 'session:', 'release:',
];
const SYSTEM_TAG_LITERALS = new Set([
  // Auto-capture pipeline markers (session_end + auto_saved appear
  // on every Stop hook entity, ~640 entities each — pairing them
  // would explode the graph).
  'session_end', 'auto_saved', 'commit', 'auto-tracked',
  'session-summary', 'session-insight', 'session_keypoint',
  'workflow_checkpoint', 'auto', 'auto-captured',
  // Status / type / lifecycle tags — describe the ENTITY, not its
  // subject matter. Pairing entities by these reflects "they're the
  // same kind of thing" rather than "they're about the same topic"
  // and produces cartesian noise (24 lessons all sharing `completed`
  // = 24×23/2 = 276 noise edges in a single rule pass).
  'completed', 'plan-completion', 'lesson', 'verification',
  'engineering-judgment', 'reference', 'plan',
]);
// YYYY-MM-DD pattern (date stamps that snuck through some tag pipelines)
const DATE_TAG_RE = /^\d{4}-\d{2}-\d{2}/;

const NAME_STOPWORDS = new Set([
  'the','and','for','with','from','this','that','are','was','has',
  'fix','add','get','set','use','via','not','new','old','update',
  'into','onto','when','then','also','both','each','more','about',
  // Generic qualifier words that appear across many entity names without
  // carrying topical signal (e.g. "X Best Practices", "Y Pattern Applied").
  // Without this, any two "Best Practices" entities match on "best"+"practices"
  // — same cartesian-explosion class as the "completed" tag bug.
  'best','practices','pattern','applied','standards','professional',
  'using','based','related','general','common','basic','simple',
  // Process / lifecycle words — describe HOW, not WHAT.
  'verification','cleanup','refactoring','implementation','migration',
  'summary','overview','analysis','review','report','notes',
  // Month abbreviations — dates in entity names cause cartesian pairing.
  'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
]);

const NUMERIC_RE = /^\d+$/;

export function tokenizeName(name: string): Set<string> {
  return new Set(
    name.toLowerCase()
        .split(/[\W_]+/)
        // Filter: minimum length, not a stopword, not a bare number (year, count, etc.)
        .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t) && !NUMERIC_RE.test(t))
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) { if (b.has(t)) intersection++; }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Whether a tag carries enough topical signal to gate co-occurrence.
 * Conservative on purpose — false positives become bogus edges that
 * users can't easily clean up.
 */
export function isTopicalTag(tag: string): boolean {
  if (!tag) return false;
  const lower = tag.toLowerCase();
  if (DATE_TAG_RE.test(lower)) return false;
  if (SYSTEM_TAG_LITERALS.has(lower)) return false;
  for (const prefix of SYSTEM_TAG_PREFIXES) {
    if (lower.startsWith(prefix)) {
      // Strict allow-list: `topic:*` and `tech:*` ARE topical even
      // though they share the prefix-form syntax with system tags.
      if (prefix === 'topic:' || prefix === 'tech:') return true;
      return false;
    }
  }
  // Bare tag (no colon) — accept if it looks like content
  if (lower.length < 2) return false;
  return true;
}

export interface RelationCandidate {
  fromEntityId: number;
  fromName: string;
  toEntityId: number;
  toName: string;
  relationType: 'related-to' | 'belongs-to-project' | 'co-created' | 'shares-name-tokens';
  /** Why we proposed this edge — for the CLI dry-run preview. */
  reason: string;
  /** Strength signal — number of shared topical tags or recency in days. */
  strength: number;
}

export interface BackfillOptions {
  /** Limit the orphan candidate set (default: all). */
  project?: string;
  /** Max edges per orphan source — guards against runaway. Default 3. */
  maxEdgesPerSource?: number;
  /** Min shared topical tags for tag-co-occurrence rule. Default 2. */
  minSharedTags?: number;
  /** Run on archived entities too (default: skip — they're soft-deleted). */
  includeArchived?: boolean;
  /** When true, only propose; never write. Same shape used by both modes. */
  dryRun?: boolean;
  /** Rule 3: link high-signal orphans co-created in the same session. Default false. */
  includeSessionCooccurrence?: boolean;
  /** Min signal_score for Rule 3 participants. Default 0.6. */
  minSessionSignalScore?: number;
  /** Rule 4: link orphans sharing ≥N name content tokens. Default false. */
  includeNameTokenSimilarity?: boolean;
  /** Min Jaccard for Rule 4. Default 0.50 (share ≥ half the tokens). Lower values
   *  produce more edges but risk quality degradation on large KBs. */
  minNameJaccard?: number;
  /** Alt gate for Rule 4: ≥N shared tokens also qualifies. Default 3. */
  minSharedNameTokens?: number;
  /**
   * Idempotency cache — clear the persistent "already-attempted" set before
   * running. Useful after a schema change or rule-set change where you want
   * to reconsider every orphan from scratch. Default false (preserve cache).
   */
  resetIdempotency?: boolean;
  /**
   * Test seam — bypass the persistent cache entirely (don't read, don't
   * write). Production callers should not set this; the natural mode of
   * operation is "skip already-attempted orphans, then mark new ones".
   */
  ignoreIdempotency?: boolean;
}

export interface BackfillResult {
  candidatesProposed: number;
  edgesWritten: number;
  dryRun: boolean;
  byRule: {
    tagCooccurrence: number;
    projectClustering: number;
    sessionCooccurrence: number;
    nameTokenSimilarity: number;
  };
  /** Number of orphans skipped because they were already attempted in a prior run. */
  orphansSkippedIdempotent: number;
  /** Orphans newly added to the idempotency cache by this run. */
  orphansMarkedProcessed: number;
}

// memesh_metadata key for the persistent "already attempted" orphan-id set.
// Versioned so a future schema rev (e.g. per-rule tracking) can ignore the v1
// cache without colliding.
const IDEMPOTENCY_KEY = 'kg_backfill_processed_v1';

interface MetadataRow { value: string }

function readProcessedSet(conn: MemeshDatabase): Set<number> {
  // memesh_metadata is created by openDatabase / ensureVecTable; if a caller
  // somehow runs before that migration, skip the cache rather than error out.
  try {
    const row = conn.prepare(
      'SELECT value FROM memesh_metadata WHERE key = ?'
    ).get(IDEMPOTENCY_KEY) as MetadataRow | undefined;
    if (!row) return new Set();
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is number => typeof id === 'number'));
  } catch {
    return new Set();
  }
}

function writeProcessedSet(conn: MemeshDatabase, ids: Set<number>): void {
  const payload = JSON.stringify([...ids]);
  conn.prepare(
    'INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)'
  ).run(IDEMPOTENCY_KEY, payload);
}

function clearProcessedSet(conn: MemeshDatabase): void {
  conn.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(IDEMPOTENCY_KEY);
}

/**
 * Public helper for the CLI's `--reset-idempotency` flag. Idempotent —
 * safe to call even if no cache row exists.
 */
export function resetBackfillIdempotencyCache(db?: MemeshDatabase): void {
  clearProcessedSet(db ?? getDatabase());
}

type OrphanRow = {
  id: number;
  name: string;
  type: string;
  metadata: string | null;
};

type TagRow = {
  entity_id: number;
  tag: string;
};

/**
 * Output of `proposeBackfillCandidates`. Beyond the candidate edges, it
 * also reports which orphans were considered this run (after applying
 * the idempotency filter) and which were skipped because the persistent
 * cache already has them. `backfillRelations` uses these IDs to mark
 * processed entities without re-querying SQL, and the CLI uses them for
 * an accurate "skipped N orphans" summary line.
 */
export interface BackfillProposalResult {
  candidates: RelationCandidate[];
  /** Orphan IDs that this run actually considered (after idempotency filter). */
  consideredOrphanIds: number[];
  /** Orphan IDs skipped because the persistent cache already had them. */
  skippedOrphanIds: number[];
}

/**
 * Propose (and optionally apply) heuristic relations to fix the
 * orphan-entity problem in the KG. The actual candidate list is exposed
 * via `proposeBackfillCandidates` for the dry-run path.
 */
export function backfillRelations(opts: BackfillOptions = {}, db?: MemeshDatabase): BackfillResult {
  const conn = db ?? getDatabase();

  // Single entry point for proposing candidates. `proposeBackfillCandidates`
  // owns the reset / filter logic, so dry-run and non-dry-run behave
  // identically with respect to idempotency. It also returns the orphan
  // IDs we considered, which we re-use below to mark them as processed
  // without re-running the orphan SQL.
  const { candidates, consideredOrphanIds, skippedOrphanIds } =
    proposeBackfillCandidates(opts, conn);

  const result: BackfillResult = {
    candidatesProposed: candidates.length,
    edgesWritten: 0,
    dryRun: !!opts.dryRun,
    byRule: { tagCooccurrence: 0, projectClustering: 0, sessionCooccurrence: 0, nameTokenSimilarity: 0 },
    orphansSkippedIdempotent: skippedOrphanIds.length,
    orphansMarkedProcessed: 0,
  };

  if (opts.dryRun) return result;

  // INSERT OR IGNORE handles the case where the (from, to, type)
  // tuple already exists — relations table has UNIQUE on
  // (from_entity_id, to_entity_id, relation_type).
  const insert = conn.prepare(
    'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
  );
  const tx = conn.transaction((rows: RelationCandidate[]) => {
    for (const c of rows) {
      const r = insert.run(c.fromEntityId, c.toEntityId, c.relationType);
      if (r.changes > 0) {
        result.edgesWritten++;
        if (c.relationType === 'related-to') result.byRule.tagCooccurrence++;
        else if (c.relationType === 'belongs-to-project') result.byRule.projectClustering++;
        else if (c.relationType === 'co-created') result.byRule.sessionCooccurrence++;
        else if (c.relationType === 'shares-name-tokens') result.byRule.nameTokenSimilarity++;
      }
    }
  });
  tx(candidates);

  // Mark every considered orphan as processed, regardless of whether
  // any rule fired for it. This is the key idempotency win: an orphan
  // with no peers still costs CPU to evaluate, so we record it so a
  // re-run skips it. consideredOrphanIds came from
  // proposeBackfillCandidates — no second SQL query needed.
  if (!opts.ignoreIdempotency && consideredOrphanIds.length > 0) {
    const processedBefore = readProcessedSet(conn);
    const next = new Set(processedBefore);
    for (const id of consideredOrphanIds) next.add(id);
    writeProcessedSet(conn, next);
    result.orphansMarkedProcessed = next.size - processedBefore.size;
  }

  return result;
}

export function proposeBackfillCandidates(opts: BackfillOptions = {}, db?: MemeshDatabase): BackfillProposalResult {
  const conn = db ?? getDatabase();
  const maxPerSource = opts.maxEdgesPerSource ?? 3;
  const minShared = opts.minSharedTags ?? 2;
  const statusFilter = opts.includeArchived ? "" : "AND e.status = 'active'";
  const projectClause = opts.project ? "AND EXISTS (SELECT 1 FROM tags t2 WHERE t2.entity_id = e.id AND t2.tag = ?)" : "";
  const projectArgs = opts.project ? [`project:${opts.project}`] : [];

  // Reset the persistent cache first if requested. This runs BEFORE the
  // orphan filter so the cleared state is what the rest of the function
  // sees — meaning `--dry-run --reset-idempotency` actually re-considers
  // every orphan rather than silently using the stale cache.
  // `ignoreIdempotency` bypasses both reset and read (test seam).
  if (opts.resetIdempotency && !opts.ignoreIdempotency) {
    clearProcessedSet(conn);
  }

  // Step 1: identify orphan entities (no relations, optionally project-scoped).
  // Idempotency filter: skip any orphan whose id is in the persistent
  // "already attempted" set. This is what makes re-running the command
  // cheap after a partial crash — we don't re-tokenise every orphan from
  // the start. The set is cleared by `--reset-idempotency` or bypassed
  // by `ignoreIdempotency` (test seam only).
  const allOrphans = conn.prepare(`
    SELECT e.id, e.name, e.type, e.metadata
    FROM entities e
    WHERE 1=1 ${statusFilter}
      ${projectClause}
      AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id)
  `).all(...projectArgs) as OrphanRow[];

  const processed = opts.ignoreIdempotency ? new Set<number>() : readProcessedSet(conn);
  const orphans = processed.size === 0
    ? allOrphans
    : allOrphans.filter((o) => !processed.has(o.id));
  const skippedOrphanIds = processed.size === 0
    ? []
    : allOrphans.filter((o) => processed.has(o.id)).map((o) => o.id);
  const consideredOrphanIds = orphans.map((o) => o.id);

  if (orphans.length === 0) {
    return { candidates: [], consideredOrphanIds, skippedOrphanIds };
  }

  // Step 2: load every active entity's topical tag set into memory once.
  // 1300 entities × ~3 tags = ~4000 rows — trivial.
  const allTagRows = conn.prepare(`
    SELECT t.entity_id, t.tag
    FROM tags t
    JOIN entities e ON e.id = t.entity_id
    WHERE 1=1 ${statusFilter}
  `).all() as TagRow[];

  const tagsByEntity = new Map<number, Set<string>>();
  const entitiesByTag = new Map<string, number[]>();
  for (const row of allTagRows) {
    if (!isTopicalTag(row.tag)) continue;
    let set = tagsByEntity.get(row.entity_id);
    if (!set) {
      set = new Set();
      tagsByEntity.set(row.entity_id, set);
    }
    set.add(row.tag);

    let list = entitiesByTag.get(row.tag);
    if (!list) {
      list = [];
      entitiesByTag.set(row.tag, list);
    }
    list.push(row.entity_id);
  }

  // Step 3: per orphan, find peers with ≥ minShared overlapping topical tags
  const candidates: RelationCandidate[] = [];
  const orphanById = new Map<number, OrphanRow>();
  for (const o of orphans) orphanById.set(o.id, o);

  // Build a lookup of all entity name+type for the from/to fields.
  // Include metadata so Rules 3+4 can read signal_score without a
  // second query. Use the alias `e` consistently so `${statusFilter}`
  // (`AND e.status = 'active'`) resolves correctly.
  const allEntities = conn.prepare(
    `SELECT e.id, e.name, e.type, e.metadata FROM entities e WHERE 1=1 ${statusFilter}`
  ).all() as Array<{ id: number; name: string; type: string; metadata: string | null }>;
  const entityById = new Map<number, { id: number; name: string; type: string; metadata: string | null }>();
  for (const e of allEntities) entityById.set(e.id, e);

  // ---- Rule 1: Tag co-occurrence ----
  for (const orphan of orphans) {
    const orphanTags = tagsByEntity.get(orphan.id);
    if (!orphanTags || orphanTags.size < minShared) continue;

    // Tally peer overlap counts
    const overlapByPeer = new Map<number, number>();
    for (const tag of orphanTags) {
      const peerIds = entitiesByTag.get(tag) ?? [];
      for (const peerId of peerIds) {
        if (peerId === orphan.id) continue;
        overlapByPeer.set(peerId, (overlapByPeer.get(peerId) ?? 0) + 1);
      }
    }

    // Sort peers by overlap desc, take top N
    const ranked = [...overlapByPeer.entries()]
      .filter(([_, n]) => n >= minShared)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxPerSource);

    for (const [peerId, sharedCount] of ranked) {
      const peer = entityById.get(peerId);
      if (!peer) continue;
      candidates.push({
        fromEntityId: orphan.id,
        fromName: orphan.name,
        toEntityId: peer.id,
        toName: peer.name,
        relationType: 'related-to',
        reason: `shares ${sharedCount} topical tag${sharedCount > 1 ? 's' : ''}`,
        strength: sharedCount,
      });
    }
  }

  // ---- Rule 2: Project clustering ----
  // For each orphan in a project, link to the most recent
  // release / feature in the same project. Light touch: 1 edge per
  // orphan, only when the orphan is a "consumer" type (lesson /
  // decision / bug_fix / pattern) AND there's a "producer" type
  // (release / feature) anchor in the project.
  const consumerTypes = new Set(['lesson_learned', 'lesson', 'decision', 'bug_fix', 'pattern', 'mistake', 'best_practice']);
  const anchorTypes = new Set(['release', 'feature', 'architecture', 'plan']);

  // Pre-compute project anchors
  const anchorsByProject = new Map<string, Array<{ id: number; name: string; type: string; created_at: string }>>();
  const projectAnchorRows = conn.prepare(`
    SELECT e.id, e.name, e.type, e.created_at, t.tag AS project_tag
    FROM entities e
    JOIN tags t ON t.entity_id = e.id AND t.tag LIKE 'project:%'
    WHERE 1=1 ${statusFilter}
      AND e.type IN (${[...anchorTypes].map(() => '?').join(',')})
  `).all(...anchorTypes) as Array<{ id: number; name: string; type: string; created_at: string; project_tag: string }>;
  for (const r of projectAnchorRows) {
    const project = r.project_tag.slice('project:'.length);
    let list = anchorsByProject.get(project);
    if (!list) {
      list = [];
      anchorsByProject.set(project, list);
    }
    list.push({ id: r.id, name: r.name, type: r.type, created_at: r.created_at });
  }
  // Sort each project's anchors by recency, newest first
  for (const list of anchorsByProject.values()) {
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  // Map orphan id -> project tag (if any)
  const orphanProjectRows = conn.prepare(`
    SELECT t.entity_id, t.tag
    FROM tags t
    JOIN entities e ON e.id = t.entity_id
    WHERE 1=1 ${statusFilter}
      AND t.tag LIKE 'project:%'
      AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id)
  `).all() as TagRow[];
  const orphanProject = new Map<number, string>();
  for (const r of orphanProjectRows) orphanProject.set(r.entity_id, r.tag.slice('project:'.length));

  for (const orphan of orphans) {
    if (!consumerTypes.has(orphan.type)) continue;
    const project = orphanProject.get(orphan.id);
    if (!project) continue;
    const anchors = anchorsByProject.get(project);
    if (!anchors || anchors.length === 0) continue;
    // Link to the SINGLE most-recent anchor in the project — keep
    // this rule low-volume to maintain signal-to-noise.
    const anchor = anchors[0];
    if (anchor.id === orphan.id) continue;
    candidates.push({
      fromEntityId: orphan.id,
      fromName: orphan.name,
      toEntityId: anchor.id,
      toName: anchor.name,
      relationType: 'belongs-to-project',
      reason: `same-project anchor (${anchor.type})`,
      strength: 1,
    });
  }

  // ---- Rule 3: Session co-occurrence ----
  // High-signal orphans that share a session: tag are co-created —
  // they emerged from the same conversation and likely share context.
  if (opts.includeSessionCooccurrence) {
    const minScore = opts.minSessionSignalScore ?? 0.6;
    const sessionEligibleTypes = new Set([
      'lesson_learned', 'lesson', 'decision', 'architecture', 'architecture_decision',
      'plan', 'feature', 'bug_fix', 'pattern', 'best_practice', 'release',
    ]);

    // Parse signal_score helper — missing score defaults to include (1.0).
    const getSignalScore = (meta: string | null): number => {
      try {
        const parsed = JSON.parse(meta ?? '{}');
        const s = parsed?.signal_score;
        return typeof s === 'number' ? s : 1.0;
      } catch { return 1.0; }
    };

    // Load session: tags for all entities (not just orphans — peers may have relations).
    const sessionTagRows = conn.prepare(`
      SELECT t.entity_id, t.tag
      FROM tags t
      JOIN entities e ON e.id = t.entity_id
      WHERE 1=1 ${statusFilter}
        AND t.tag LIKE 'session:%'
    `).all() as TagRow[];

    // Group eligible entity ids by session: tag.
    const entitiesBySession = new Map<string, number[]>();
    for (const row of sessionTagRows) {
      const ent = entityById.get(row.entity_id);
      if (!ent || !sessionEligibleTypes.has(ent.type)) continue;
      if (getSignalScore(ent.metadata) < minScore) continue;
      let list = entitiesBySession.get(row.tag);
      if (!list) { list = []; entitiesBySession.set(row.tag, list); }
      list.push(row.entity_id);
    }

    // Build session: tag list per orphan for fast lookup.
    const sessionTagsByOrphan = new Map<number, string[]>();
    for (const row of sessionTagRows) {
      if (!orphanById.has(row.entity_id)) continue;
      let list = sessionTagsByOrphan.get(row.entity_id);
      if (!list) { list = []; sessionTagsByOrphan.set(row.entity_id, list); }
      list.push(row.tag);
    }

    for (const orphan of orphans) {
      if (!sessionEligibleTypes.has(orphan.type)) continue;
      if (getSignalScore(orphan.metadata) < minScore) continue;

      const sessionTags = sessionTagsByOrphan.get(orphan.id) ?? [];
      let added = 0;
      // Track already-proposed peers so an orphan sharing multiple
      // session tags with the same peer doesn't produce duplicate edges.
      const proposedPeers = new Set<number>();

      for (const stag of sessionTags) {
        const peers = (entitiesBySession.get(stag) ?? []).filter((id) => id !== orphan.id);
        for (const peerId of peers) {
          if (added >= maxPerSource) break;
          if (proposedPeers.has(peerId)) continue;
          const peer = entityById.get(peerId);
          if (!peer) continue;
          candidates.push({
            fromEntityId: orphan.id,
            fromName: orphan.name,
            toEntityId: peer.id,
            toName: peer.name,
            relationType: 'co-created',
            reason: `co-created in same session (${stag})`,
            strength: 2,
          });
          proposedPeers.add(peerId);
          added++;
        }
        if (added >= maxPerSource) break;
      }
    }
  }

  // ---- Rule 4: Name token similarity ----
  // Orphans whose names share ≥ minSharedNameTokens content tokens
  // (or Jaccard ≥ minNameJaccard) are related in subject matter.
  if (opts.includeNameTokenSimilarity) {
    const minJaccard = opts.minNameJaccard ?? 0.50;
    const minSharedTokens = opts.minSharedNameTokens ?? 3;

    // Pre-compute token sets for all active entities.
    const tokensByEntity = new Map<number, Set<string>>();
    for (const e of allEntities) {
      const tokens = tokenizeName(e.name);
      if (tokens.size >= 2) tokensByEntity.set(e.id, tokens);
    }

    // Track undirected pairs already proposed so each (A,B) pair only
    // generates one edge even when both A and B are orphans (otherwise
    // the outer orphan loop proposes A→B then B→A, doubling the count).
    const proposedNamePairs = new Set<string>();

    for (const orphan of orphans) {
      const orphanTokens = tokensByEntity.get(orphan.id);
      if (!orphanTokens) continue;

      const scored: Array<{ id: number; shared: number; jaccard: number }> = [];
      for (const [candidateId, candidateTokens] of tokensByEntity) {
        if (candidateId === orphan.id) continue;
        const pairKey = `${Math.min(orphan.id, candidateId)}-${Math.max(orphan.id, candidateId)}`;
        if (proposedNamePairs.has(pairKey)) continue;
        let shared = 0;
        for (const t of orphanTokens) { if (candidateTokens.has(t)) shared++; }
        if (shared === 0) continue;
        const jaccard = jaccardSimilarity(orphanTokens, candidateTokens);
        if (shared >= minSharedTokens || jaccard >= minJaccard) {
          scored.push({ id: candidateId, shared, jaccard });
        }
      }

      scored.sort((a, b) => b.shared - a.shared || b.jaccard - a.jaccard);
      for (const { id: peerId, shared, jaccard } of scored.slice(0, maxPerSource)) {
        const peer = entityById.get(peerId);
        if (!peer) continue;
        const pairKey = `${Math.min(orphan.id, peerId)}-${Math.max(orphan.id, peerId)}`;
        proposedNamePairs.add(pairKey);
        candidates.push({
          fromEntityId: orphan.id,
          fromName: orphan.name,
          toEntityId: peer.id,
          toName: peer.name,
          relationType: 'shares-name-tokens',
          reason: `${shared} shared name token(s), Jaccard=${jaccard.toFixed(2)}`,
          strength: shared,
        });
      }
    }
  }

  return { candidates, consideredOrphanIds, skippedOrphanIds };
}
