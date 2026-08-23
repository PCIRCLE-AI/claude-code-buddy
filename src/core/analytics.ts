// =============================================================================
// Analytics — health score + timeline + value metrics + cleanup suggestions
// =============================================================================
//
// Used by the HTTP /v1/analytics route. Pure read-only aggregation.
// Takes a Database, returns a typed shape. Future CLI/MCP commands
// (`memesh analytics --json`, MCP `analytics` tool) can call this
// directly without re-implementing the SQL.

import type { MemeshDatabase } from '../storage/sqlite.js';
import type { CountRow } from './types.js';

export interface HealthFactor {
  score: number;
  weight: number;
  detail: string;
}

// Knowledge types shown in the age matrix and radar (excludes high-noise session dumps)
export const NOISE_TYPES = new Set([
  'session_keypoint', 'commit', 'weekly-summary', 'session-insight',
  'session-summary', 'session_identity', 'session-identity',
]);

export type AgeBucket = 'week' | 'month' | 'quarter' | 'older';

export interface AgeMatrixEntry {
  type: string;
  bucket: AgeBucket;
  count: number;
}

export interface KnowledgeRadarEntry {
  axis: string;
  count: number;
  types: string[];
}

// The six semantic axes of the Knowledge Radar. Module-level and exported
// because the axis names are ALSO i18n keys on the dashboard
// (`radar.axis.<axis>`): tests/dashboard-i18n.test.ts imports this array to
// prove every axis the server can emit has a catalogue entry, so a new axis
// cannot ship untranslated.
export const RADAR_AXES: Array<{ axis: string; types: string[] }> = [
  { axis: 'lessons',      types: ['lesson_learned', 'lesson', 'mistake'] },
  { axis: 'decisions',    types: ['decision', 'architecture_decision', 'design_decision'] },
  { axis: 'patterns',     types: ['pattern', 'technical_pattern', 'best_practice'] },
  { axis: 'bugs',         types: ['bug_fix', 'verification_result', 'test_result'] },
  { axis: 'processes',    types: ['process', 'workflow_checkpoint', 'refactoring', 'maintenance'] },
  { axis: 'architecture', types: ['architecture', 'infrastructure', 'feature', 'release'] },
];

export interface LoopMetric {
  /** Number of knowledge entities (lesson / decision / pattern / bug_fix /
   *  architecture / etc.) accessed within the last 7 days. */
  reusedThisWeek: number;
  /** Per-day counts for the last 30 days (sparkline source). */
  trend: Array<{ date: string; count: number }>;
  /** Where the count comes from. `recall_hits` once instrumentation is
   *  populated; `last_accessed_at_approximation` for older data and
   *  installs that pre-date recall instrumentation. */
  computedFrom: 'recall_hits' | 'last_accessed_at_approximation';
}

export interface AnalyticsResult {
  healthScore: number;
  healthFactors: {
    activity: HealthFactor;
    quality: HealthFactor;
    freshness: HealthFactor;
    lessons: HealthFactor;
  };
  loopMetric: LoopMetric;
  /**
   * How many lessons are marked `severity:critical` — the one counter the
   * retired Lessons tab carried that a reader acts on ("mistakes already
   * paid for, waiting to be repeated"). Its three siblings were dropped.
   *
   * All three numbers travel together because `critical` alone is a
   * half-truth: on the graph this was written against, 29 lessons were
   * active, 12 carried any severity tag and 5 were critical — so "5" is 5
   * of 12 classified, not 5 of 29, and a tile that prints 5 without the
   * denominator overstates what was measured. `severityTagged === 0` is the
   * not-measured case and must render as such, never as a zero.
   */
  criticalLessons: {
    critical: number;
    severityTagged: number;
    total: number;
  };
  /**
   * How often an agent that was given memories actually cited one, from the
   * two counters the Stop hook keeps (`citation_sessions_cited` /
   * `citation_sessions_total`).
   *
   * `null` when the counters do not exist, and that is a THIRD state, not a
   * zero: it means no session has yet run the citation-era accounting, which
   * is true of every install until the release carrying it lands. A tile
   * that renders `null` as 0% would report perfect non-compliance from an
   * instrument that has never been switched on — the exact failure
   * `retrieval.degraded` exists to prevent on the recall side.
   */
  citationCompliance: { cited: number; total: number } | null;
  timeline: Array<{ date: string; created: number; recalled: number }>;
  ageMatrix: AgeMatrixEntry[];
  knowledgeRadar: KnowledgeRadarEntry[];
}

/**
 * Compute the analytics dashboard payload. All SQL is parameterless and
 * uses datetime() literals, so the function is safe to call repeatedly
 * without parameter binding.
 */
export function computeAnalytics(db: MemeshDatabase): AnalyticsResult {
  // --- Health Score ---
  const totalActive = (db.prepare(
    "SELECT COUNT(*) as c FROM entities WHERE status = 'active'",
  ).get() as CountRow).c;

  const recentlyAccessed = (db.prepare(
    `SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND datetime(last_accessed_at) >= datetime('now', '-30 days')`,
  ).get() as CountRow).c;
  const activityRatio = totalActive > 0 ? recentlyAccessed / totalActive : 0;

  const highConfidence = (db.prepare(
    "SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND confidence > 0.7",
  ).get() as CountRow).c;
  const qualityRatio = totalActive > 0 ? highConfidence / totalActive : 0;

  const newThisWeek = (db.prepare(
    `SELECT COUNT(*) as c FROM entities WHERE created_at >= datetime('now', '-7 days')`,
  ).get() as CountRow).c;
  const freshnessRatio = totalActive > 0 ? Math.min(newThisWeek / totalActive, 1.0) : 0;

  const lessonCount = (db.prepare(
    "SELECT COUNT(*) as c FROM entities WHERE type = 'lesson_learned'",
  ).get() as CountRow).c;
  const lessonRatio = Math.min(lessonCount / 5, 1.0);

  const healthScore = Math.round(
    activityRatio * 30 + qualityRatio * 30 + freshnessRatio * 20 + lessonRatio * 20,
  );

  const healthFactors = {
    activity: {
      score: Math.round(activityRatio * 30),
      weight: 30,
      detail: `${recentlyAccessed}/${totalActive} active entities accessed in last 30 days`,
    },
    quality: {
      score: Math.round(qualityRatio * 30),
      weight: 30,
      detail: `${highConfidence}/${totalActive} active entities with confidence > 0.7`,
    },
    freshness: {
      score: Math.round(freshnessRatio * 20),
      weight: 20,
      detail: `${newThisWeek} new entities this week`,
    },
    lessons: {
      score: Math.round(lessonRatio * 20),
      weight: 20,
      detail: `${lessonCount} lessons learned`,
    },
  };

  // --- Timeline (last 30 days) ---
  const createdTimeline = db.prepare(`
    SELECT DATE(created_at) as day, COUNT(*) as created
    FROM entities
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY DATE(created_at)
    ORDER BY day
  `).all() as Array<{ day: string; created: number }>;

  const recalledTimeline = db.prepare(`
    SELECT DATE(last_accessed_at) as day, COUNT(*) as recalled
    FROM entities
    WHERE datetime(last_accessed_at) >= datetime('now', '-30 days')
    GROUP BY DATE(last_accessed_at)
    ORDER BY day
  `).all() as Array<{ day: string; recalled: number }>;

  const timelineMap = new Map<string, { date: string; created: number; recalled: number }>();
  for (const row of createdTimeline) {
    timelineMap.set(row.day, { date: row.day, created: row.created, recalled: 0 });
  }
  for (const row of recalledTimeline) {
    const existing = timelineMap.get(row.day);
    if (existing) {
      existing.recalled = row.recalled;
    } else {
      timelineMap.set(row.day, { date: row.day, created: 0, recalled: row.recalled });
    }
  }
  const timeline = Array.from(timelineMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // NOTE: valueMetrics, cleanup (stale + duplicate candidates), and
  // recallEffectiveness were computed here and returned by /v1/analytics, but
  // no dashboard component ever rendered them — the dedicated ValueMetrics /
  // CleanupSuggestions / RecallEffectiveness components were never imported.
  // The queries (including an O(n²) duplicate-candidate self-join) ran on every
  // analytics request for output nobody consumed. Removed with the components.

  // --- Age Matrix (knowledge types × time buckets, noise types excluded) ---
  const ageMatrixRaw = db.prepare(`
    SELECT type,
      CASE
        WHEN created_at > datetime('now', '-7 days')  THEN 'week'
        WHEN created_at > datetime('now', '-30 days') THEN 'month'
        WHEN created_at > datetime('now', '-90 days') THEN 'quarter'
        ELSE 'older'
      END as bucket,
      COUNT(*) as count
    FROM entities
    WHERE status = 'active'
    GROUP BY type, bucket
    ORDER BY type, bucket
  `).all() as Array<{ type: string; bucket: AgeBucket; count: number }>;

  const ageMatrix = ageMatrixRaw.filter(r => !NOISE_TYPES.has(r.type));

  // --- Knowledge Radar (6 semantic axes, see module-level RADAR_AXES) ---
  const typeCounts: Record<string, number> = {};
  for (const row of ageMatrixRaw) {
    typeCounts[row.type] = (typeCounts[row.type] ?? 0) + (row.count as number);
  }

  const knowledgeRadar: KnowledgeRadarEntry[] = RADAR_AXES.map(({ axis, types }) => ({
    axis,
    types,
    count: types.reduce((sum, t) => sum + (typeCounts[t] ?? 0), 0),
  }));

  // --- Loop Metric (memory loop: how much is the system actually being used?) ---
  //
  // Counts knowledge-class entities (lessons, decisions, patterns,
  // bug_fixes, architecture, etc. — anything whose recall would prevent
  // re-doing past work) that have a `last_accessed_at` falling inside
  // the last 7 days. This is an APPROXIMATION because last_accessed_at
  // tracks the most-recent access, not every access. Once recall_hits
  // instrumentation matures (post-2026-05-07 G16 fix), the metric can
  // shift to a true per-day series; for now the approximation is
  // accurate enough to power the hero card and is honest about its
  // source via `computedFrom`.
  const KNOWLEDGE_TYPE_LIST = [
    'lesson_learned', 'lesson', 'mistake',
    'decision', 'architecture_decision', 'design_decision',
    'pattern', 'technical_pattern', 'best_practice',
    'bug_fix', 'verification_result', 'test_result',
    'process', 'architecture', 'infrastructure',
    'feature', 'release', 'refactoring',
  ];
  const knowledgeTypePlaceholders = KNOWLEDGE_TYPE_LIST.map(() => '?').join(',');

  const reusedThisWeek = (db.prepare(
    `SELECT COUNT(*) as c FROM entities
     WHERE type IN (${knowledgeTypePlaceholders})
       AND status = 'active'
       AND datetime(last_accessed_at) >= datetime('now', '-7 days')`,
  ).get(...KNOWLEDGE_TYPE_LIST) as CountRow).c;

  const loopTrendRows = db.prepare(`
    SELECT DATE(last_accessed_at) as day, COUNT(*) as count
    FROM entities
    WHERE type IN (${knowledgeTypePlaceholders})
      AND status = 'active'
      AND datetime(last_accessed_at) >= datetime('now', '-30 days')
    GROUP BY DATE(last_accessed_at)
    ORDER BY day
  `).all(...KNOWLEDGE_TYPE_LIST) as Array<{ day: string; count: number }>;

  // `computedFrom` describes THESE numbers, and both queries above read
  // `last_accessed_at`. Nothing here reads `recall_hits`, so the only honest
  // value is the approximation — and the dashboard uses this field to decide
  // whether to SHOW the "this is an approximation" caveat, which means a wrong
  // value here does not mislabel a number, it hides the sentence that explains
  // it.
  //
  // This used to flip to 'recall_hits' whenever the column existed and any
  // knowledge entity had a hit inside the 30-day window. The comment on that
  // gate named the exact failure it was meant to prevent — "the badge would
  // lie: say precise mode while the rendered numbers still come from the
  // approximation" — and the gate did not prevent it, because a hit in the
  // window is not evidence that these queries read hits. Measured on a real
  // graph 2026-08-17: 21 knowledge entities carried in-window `recall_hits`,
  // every one written by the literal-content matching that R1 retired at 0%
  // measured signal, and `recall_accounting_mode` (the stamp that separates
  // the two accounting eras) was absent. The caveat was hidden on that graph.
  //
  // Earning 'recall_hits' takes a schema change, not a probe: `recall_hits` is
  // a running total per entity, so a per-DAY reuse series cannot be derived
  // from it. Set this field where that query lands.
  const loopMetric: LoopMetric = {
    reusedThisWeek,
    trend: loopTrendRows.map((r) => ({ date: r.day, count: r.count })),
    computedFrom: 'last_accessed_at_approximation',
  };

  // --- Critical lessons ---
  //
  // The lesson types are the ones `severity:*` is written onto (see
  // `learn`), and severity lives in tags, not a column. `severityTagged` is
  // the denominator that keeps `critical` honest: a lesson nobody classified
  // is not a lesson that is not critical.
  const LESSON_TYPES = ['lesson_learned', 'lesson', 'mistake'];
  const lessonPlaceholders = LESSON_TYPES.map(() => '?').join(',');
  const lessonTotal = (db.prepare(
    `SELECT COUNT(*) as c FROM entities
     WHERE status = 'active' AND type IN (${lessonPlaceholders})`,
  ).get(...LESSON_TYPES) as CountRow).c;
  const severityTagged = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) as c FROM entities e
     JOIN tags t ON t.entity_id = e.id
     WHERE e.status = 'active' AND e.type IN (${lessonPlaceholders})
       AND t.tag LIKE 'severity:%'`,
  ).get(...LESSON_TYPES) as CountRow).c;
  const criticalCount = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) as c FROM entities e
     JOIN tags t ON t.entity_id = e.id
     WHERE e.status = 'active' AND e.type IN (${lessonPlaceholders})
       AND t.tag = 'severity:critical'`,
  ).get(...LESSON_TYPES) as CountRow).c;
  const criticalLessons = { critical: criticalCount, severityTagged, total: lessonTotal };

  // --- Citation compliance (R1) ---
  //
  // Read as a pair, and only when the TOTAL exists: `cited` without `total`
  // is a numerator with no denominator. A missing total means the hook that
  // keeps these has not run its citation branch on this install yet, which
  // is "not measured", not "0%".
  const readCounter = (key: string): number | null => {
    try {
      const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(key) as
        | { value: string } | undefined;
      if (!row) return null;
      const n = parseInt(row.value, 10);
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch { return null; }
  };
  const citationTotal = readCounter('citation_sessions_total');
  const citationCompliance = citationTotal === null || citationTotal === 0
    ? null
    : { cited: readCounter('citation_sessions_cited') ?? 0, total: citationTotal };

  return {
    healthScore,
    healthFactors,
    loopMetric,
    criticalLessons,
    citationCompliance,
    timeline,
    ageMatrix,
    knowledgeRadar,
  };
}

export interface PmAnalyticsResult {
  velocity: {
    decisionsPerWeek: number;
    releasesPerMonth: number;
    windowDays: number;
  };
  staleness: {
    stalePlanCount: number;
    openDecisionCount: number;
  };
  connectedness: {
    orphanRate: number;
    totalRelations: number;
    activeEntities: number;
  };
}

/**
 * PM-framed analytics: velocity, staleness, KG connectedness.
 * All reads; no LLM. windowDays controls the velocity lookback (default 30).
 */
export function computePmAnalytics(
  db: MemeshDatabase,
  windowDays = 30,
): PmAnalyticsResult {
  const decisionsInWindow = (db.prepare(
    `SELECT COUNT(*) AS n FROM entities WHERE type='decision' AND status='active'
     AND created_at >= datetime('now', '-' || ? || ' days')`,
  ).get(windowDays) as { n: number }).n;

  const releasesInWindow = (db.prepare(
    `SELECT COUNT(*) AS n FROM entities WHERE type='release' AND status='active'
     AND created_at >= datetime('now', '-' || ? || ' days')`,
  ).get(windowDays) as { n: number }).n;

  // `datetime(last_accessed_at)`, because the column and the cutoff are
  // written in two different formats. trackAccess stores an ISO string
  // ('...T...Z'); `datetime('now', ...)` produces SQLite's own
  // 'YYYY-MM-DD HH:MM:SS'. TEXT comparison first differs at the separator,
  // where 'T' (0x54) sorts AFTER ' ' (0x20) — so a plan last touched on the
  // cutoff day never read as stale, whatever the hour. Normalising the
  // column costs an index this query does not have anyway: it already scans
  // for `type='plan'`.
  const stalePlans = (db.prepare(
    `SELECT COUNT(*) AS n FROM entities
     WHERE type='plan' AND status='active'
       AND (last_accessed_at IS NULL OR datetime(last_accessed_at) < datetime('now', '-30 days'))`,
  ).get() as { n: number }).n;

  // Open decisions: created > 14 days ago and not yet superseded by another entity.
  const openDecisions = (db.prepare(
    `SELECT COUNT(*) AS n FROM entities e
     WHERE e.type='decision' AND e.status='active'
       AND e.created_at < datetime('now', '-14 days')
       AND NOT EXISTS (
         SELECT 1 FROM relations r
         WHERE r.from_entity_id=e.id AND r.relation_type='supersedes'
       )`,
  ).get() as { n: number }).n;

  const totalActive = (db.prepare(
    `SELECT COUNT(*) AS n FROM entities WHERE status='active'`,
  ).get() as { n: number }).n;

  const withRelations = (db.prepare(
    `SELECT COUNT(DISTINCT e.id) AS n
     FROM entities e
     JOIN relations r ON r.from_entity_id=e.id OR r.to_entity_id=e.id
     WHERE e.status='active'`,
  ).get() as { n: number }).n;

  const totalRelations = (db.prepare(
    `SELECT COUNT(*) AS n FROM relations`,
  ).get() as { n: number }).n;

  const weeks = windowDays / 7;
  const months = windowDays / 30;

  return {
    velocity: {
      decisionsPerWeek: weeks > 0 ? decisionsInWindow / weeks : 0,
      releasesPerMonth: months > 0 ? releasesInWindow / months : 0,
      windowDays,
    },
    staleness: {
      stalePlanCount: stalePlans,
      openDecisionCount: openDecisions,
    },
    connectedness: {
      orphanRate: totalActive > 0 ? (totalActive - withRelations) / totalActive : 0,
      totalRelations,
      activeEntities: totalActive,
    },
  };
}
