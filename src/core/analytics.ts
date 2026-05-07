// =============================================================================
// Analytics — health score + timeline + value metrics + cleanup suggestions
// =============================================================================
//
// Used by the HTTP /v1/analytics route. Pure read-only aggregation.
// Takes a Database, returns a typed shape. Future CLI/MCP commands
// (`memesh analytics --json`, MCP `analytics` tool) can call this
// directly without re-implementing the SQL.

import type Database from 'better-sqlite3';
import type { CountRow, PragmaColumnRow } from './types.js';

export interface HealthFactor {
  score: number;
  weight: number;
  detail: string;
}

export interface RecallEffectiveness {
  overallHitRate: number;
  totalHits: number;
  totalMisses: number;
  trackedEntities: number;
  topEffective: Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;
  mostIgnored: Array<{ name: string; type: string; hits: number; misses: number; hitRate: number }>;
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
  timeline: Array<{ date: string; created: number; recalled: number }>;
  valueMetrics: {
    totalRecalls: number;
    lessonCount: number;
    lessonsWithWarnings: number;
    typeDistribution: unknown[];
  };
  recallEffectiveness: RecallEffectiveness | null;
  cleanup: {
    staleEntities: unknown[];
    duplicateCandidates: unknown[];
  };
  ageMatrix: AgeMatrixEntry[];
  knowledgeRadar: KnowledgeRadarEntry[];
}

/**
 * Compute the analytics dashboard payload. All SQL is parameterless and
 * uses datetime() literals, so the function is safe to call repeatedly
 * without parameter binding.
 */
export function computeAnalytics(db: Database.Database): AnalyticsResult {
  // --- Health Score ---
  const totalActive = (db.prepare(
    "SELECT COUNT(*) as c FROM entities WHERE status = 'active'",
  ).get() as CountRow).c;

  const recentlyAccessed = (db.prepare(
    `SELECT COUNT(*) as c FROM entities WHERE status = 'active' AND last_accessed_at >= datetime('now', '-30 days')`,
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
    WHERE last_accessed_at >= datetime('now', '-30 days')
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

  // --- Value Metrics ---
  const totalRecalls = (db.prepare(
    "SELECT COALESCE(SUM(access_count), 0) as c FROM entities",
  ).get() as CountRow).c;

  const lessonsWithWarnings = (db.prepare(
    "SELECT COUNT(*) as c FROM entities WHERE type = 'lesson_learned' AND access_count > 0",
  ).get() as CountRow).c;

  const typeDistribution = db.prepare(
    "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC",
  ).all();

  const valueMetrics = {
    totalRecalls,
    lessonCount,
    lessonsWithWarnings,
    typeDistribution,
  };

  // --- Cleanup Suggestions ---
  const staleEntities = db.prepare(`
    SELECT id, name, type, confidence,
      CAST((julianday('now') - julianday(COALESCE(last_accessed_at, created_at))) AS INTEGER) as days_unused
    FROM entities
    WHERE status = 'active'
      AND confidence < 0.4
      AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-30 days'))
    ORDER BY confidence ASC
    LIMIT 10
  `).all();

  const duplicateCandidates = db.prepare(`
    SELECT e1.name as name1, e2.name as name2, e1.type
    FROM entities e1
    JOIN entities e2 ON e1.id < e2.id AND e1.type = e2.type
    WHERE e1.status = 'active' AND e2.status = 'active'
      AND (INSTR(LOWER(e1.name), LOWER(e2.name)) > 0 OR INSTR(LOWER(e2.name), LOWER(e1.name)) > 0)
    LIMIT 5
  `).all();

  const cleanup = { staleEntities, duplicateCandidates };

  // --- Recall Effectiveness (only if recall_hits column exists) ---
  let recallEffectiveness: RecallEffectiveness | null = null;
  try {
    const recallColCheck = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
    if (recallColCheck.some((c: PragmaColumnRow) => c.name === 'recall_hits')) {
      const totals = db.prepare(
        `SELECT COALESCE(SUM(recall_hits), 0) as hits, COALESCE(SUM(recall_misses), 0) as misses,
         COUNT(*) as tracked FROM entities WHERE (recall_hits > 0 OR recall_misses > 0)`,
      ).get() as { hits: number; misses: number; tracked: number };

      const total = totals.hits + totals.misses;
      const overallHitRate = total > 0 ? totals.hits / total : 0;

      const topEffective = db.prepare(
        `SELECT name, type, COALESCE(recall_hits, 0) as hits, COALESCE(recall_misses, 0) as misses,
         CAST(COALESCE(recall_hits, 0) AS REAL) / (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) as hitRate
         FROM entities WHERE (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) > 0
         ORDER BY hitRate DESC, hits DESC LIMIT 5`,
      ).all() as RecallEffectiveness['topEffective'];

      const mostIgnored = db.prepare(
        `SELECT name, type, COALESCE(recall_hits, 0) as hits, COALESCE(recall_misses, 0) as misses,
         CAST(COALESCE(recall_hits, 0) AS REAL) / (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) as hitRate
         FROM entities WHERE (COALESCE(recall_hits, 0) + COALESCE(recall_misses, 0)) > 0
         ORDER BY hitRate ASC, misses DESC LIMIT 5`,
      ).all() as RecallEffectiveness['mostIgnored'];

      recallEffectiveness = {
        overallHitRate,
        totalHits: totals.hits,
        totalMisses: totals.misses,
        trackedEntities: totals.tracked,
        topEffective,
        mostIgnored,
      };
    }
  } catch {
    // recall_hits column may not exist yet — skip gracefully
  }

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

  // --- Knowledge Radar (6 semantic axes) ---
  const RADAR_AXES: Array<{ axis: string; types: string[] }> = [
    { axis: 'lessons',      types: ['lesson_learned', 'lesson', 'mistake'] },
    { axis: 'decisions',    types: ['decision', 'architecture_decision', 'design_decision'] },
    { axis: 'patterns',     types: ['pattern', 'technical_pattern', 'best_practice'] },
    { axis: 'bugs',         types: ['bug_fix', 'verification_result', 'test_result'] },
    { axis: 'processes',    types: ['process', 'workflow_checkpoint', 'refactoring', 'maintenance'] },
    { axis: 'architecture', types: ['architecture', 'infrastructure', 'feature', 'release'] },
  ];

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
       AND last_accessed_at >= datetime('now', '-7 days')`,
  ).get(...KNOWLEDGE_TYPE_LIST) as CountRow).c;

  const loopTrendRows = db.prepare(`
    SELECT DATE(last_accessed_at) as day, COUNT(*) as count
    FROM entities
    WHERE type IN (${knowledgeTypePlaceholders})
      AND status = 'active'
      AND last_accessed_at >= datetime('now', '-30 days')
    GROUP BY DATE(last_accessed_at)
    ORDER BY day
  `).all(...KNOWLEDGE_TYPE_LIST) as Array<{ day: string; count: number }>;

  // Detect whether full instrumentation is already producing data — if
  // any knowledge entity has recall_hits > 0, we can claim accuracy.
  // Otherwise we're still in the approximation regime.
  let loopComputedFrom: LoopMetric['computedFrom'] = 'last_accessed_at_approximation';
  try {
    const recallColCheck = db.prepare("PRAGMA table_info(entities)").all() as PragmaColumnRow[];
    if (recallColCheck.some((c) => c.name === 'recall_hits')) {
      const hasHits = (db.prepare(
        `SELECT COUNT(*) as c FROM entities
         WHERE type IN (${knowledgeTypePlaceholders}) AND recall_hits > 0`,
      ).get(...KNOWLEDGE_TYPE_LIST) as CountRow).c;
      if (hasHits > 0) loopComputedFrom = 'recall_hits';
    }
  } catch { /* recall_hits column missing — stay in approximation mode */ }

  const loopMetric: LoopMetric = {
    reusedThisWeek,
    trend: loopTrendRows.map((r) => ({ date: r.day, count: r.count })),
    computedFrom: loopComputedFrom,
  };

  return {
    healthScore,
    healthFactors,
    loopMetric,
    timeline,
    valueMetrics,
    recallEffectiveness,
    cleanup,
    ageMatrix,
    knowledgeRadar,
  };
}
