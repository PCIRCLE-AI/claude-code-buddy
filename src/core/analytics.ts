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

export interface AnalyticsResult {
  healthScore: number;
  healthFactors: {
    activity: HealthFactor;
    quality: HealthFactor;
    freshness: HealthFactor;
    lessons: HealthFactor;
  };
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

  return {
    healthScore,
    healthFactors,
    timeline,
    valueMetrics,
    recallEffectiveness,
    cleanup,
  };
}
