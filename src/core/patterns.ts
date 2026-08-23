// =============================================================================
// User Patterns — shared computation for MCP + HTTP transports
// Extracted to eliminate duplication between handlers.ts and http/server.ts
// =============================================================================

import type { MemeshDatabase } from '../storage/sqlite.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PatternsResult {
  workSchedule: {
    hourDistribution: Array<{ hour: number; count: number }>;
    // dayNum is SQLite strftime('%w'): 0 = Sunday … 6 = Saturday. The row
    // used to also carry an English day NAME baked in by a SQL CASE WHEN;
    // that made every consumer render English regardless of UI language.
    // Names are presentation — each transport localises dayNum itself.
    dayDistribution: Array<{ dayNum: number; count: number }>;
  };
  focusAreas: Array<{ type: string; count: number }>;
  workflow: {
    commitsPerSession: number;
    totalSessions: number;
    totalCommits: number;
  };
  strengths: Array<{ type: string; avgConfidence: number; count: number }>;
  learningAreas: Array<{ tag: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_TYPES = ['session_keypoint', 'commit', 'session_identity', 'workflow_checkpoint', 'session-insight'];
const LEARNING_TYPES = ['lesson_learned', 'mistake', 'bug_fix', 'lesson'];

// ---------------------------------------------------------------------------
// computePatterns — all SQL queries in one place
// ---------------------------------------------------------------------------

export function computePatterns(db: MemeshDatabase, categories?: string[]): PatternsResult {
  const allCategories = !categories || categories.length === 0;

  // --- Work Schedule ---
  let hourDistribution: Array<{ hour: number; count: number }> = [];
  let dayDistribution: Array<{ dayNum: number; count: number }> = [];

  if (allCategories || categories!.includes('workSchedule')) {
    hourDistribution = db.prepare(`
      SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) as hour, COUNT(*) as count
      FROM entities
      GROUP BY hour ORDER BY hour
    `).all() as Array<{ hour: number; count: number }>;

    dayDistribution = db.prepare(`
      SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) as dayNum,
        COUNT(*) as count
      FROM entities GROUP BY dayNum ORDER BY dayNum
    `).all() as Array<{ dayNum: number; count: number }>;
  }

  // --- Focus Areas ---
  let focusAreas: Array<{ type: string; count: number }> = [];

  if (allCategories || categories!.includes('focusAreas')) {
    focusAreas = db.prepare(`
      SELECT type, COUNT(*) as count FROM entities
      WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type ORDER BY count DESC LIMIT 10
    `).all(...AUTO_TYPES) as Array<{ type: string; count: number }>;
  }

  // --- Workflow ---
  let commitsPerSession = 0;
  let totalSessions = 0;
  let totalCommits = 0;

  if (allCategories || categories!.includes('workflow')) {
    totalCommits = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE type = 'commit'"
    ).get() as { c: number }).c;
    totalSessions = (db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE type IN ('session_keypoint', 'session-insight')"
    ).get() as { c: number }).c;
    commitsPerSession = totalSessions > 0 ? Math.round((totalCommits / totalSessions) * 10) / 10 : 0;
  }

  // --- Strengths ---
  let strengths: Array<{ type: string; avgConfidence: number; count: number }> = [];

  if (allCategories || categories!.includes('strengths')) {
    strengths = db.prepare(`
      SELECT type, ROUND(AVG(confidence), 2) as avgConfidence, COUNT(*) as count
      FROM entities WHERE status = 'active' AND type NOT IN (${AUTO_TYPES.map(() => '?').join(',')})
      GROUP BY type HAVING count >= 2
      ORDER BY avgConfidence DESC LIMIT 5
    `).all(...AUTO_TYPES) as Array<{ type: string; avgConfidence: number; count: number }>;
  }

  // --- Learning Areas ---
  let learningAreas: Array<{ tag: string; count: number }> = [];

  if (allCategories || categories!.includes('learningAreas')) {
    learningAreas = db.prepare(`
      SELECT t.tag, COUNT(*) as count FROM tags t
      JOIN entities e ON t.entity_id = e.id
      WHERE e.type IN (${LEARNING_TYPES.map(() => '?').join(',')})
        AND t.tag NOT LIKE 'date:%' AND t.tag NOT LIKE 'auto%' AND t.tag NOT LIKE 'session%'
        AND t.tag != 'scope:project'
      GROUP BY t.tag ORDER BY count DESC LIMIT 10
    `).all(...LEARNING_TYPES) as Array<{ tag: string; count: number }>;
  }

  return {
    workSchedule: { hourDistribution, dayDistribution },
    focusAreas,
    workflow: { commitsPerSession, totalSessions, totalCommits },
    strengths,
    learningAreas,
  };
}
