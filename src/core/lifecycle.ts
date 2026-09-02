import type { MemeshDatabase } from '../storage/sqlite.js';
import { KnowledgeGraph } from '../knowledge-graph.js';
import { dropEntityFromIndexes } from '../storage/entity-index.js';

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STALE_THRESHOLD_DAYS = 30;
const DECAY_FACTOR = 0.9;
const MIN_CONFIDENCE = 0.01;

/**
 * Run auto-decay on stale entities.
 * Reduces confidence by 0.9x for entities not accessed in 30+ days.
 * Only runs if last decay was 24+ hours ago (throttled).
 * Never deletes data — only reduces confidence score.
 * Skips archived entities and entities already at the confidence floor.
 */
export function runAutoDecay(db: MemeshDatabase): { decayed: number } {
  // Check throttle: skip if last decay was less than 24h ago
  const lastDecay = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'"
  ).get() as { value: string } | undefined;

  if (lastDecay) {
    const elapsed = Date.now() - new Date(lastDecay.value).getTime();
    if (elapsed < DECAY_INTERVAL_MS) {
      return { decayed: 0 };
    }
  }

  // Backward-compat guard: skip if confidence column doesn't exist
  const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'confidence')) {
    return { decayed: 0 };
  }

  // Entities are stale if last_accessed_at is older than threshold, or NULL (never accessed)
  const threshold = new Date(
    Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const result = db.prepare(`
    UPDATE entities
    SET confidence = MAX(confidence * ?, ?)
    WHERE status = 'active'
      AND (last_accessed_at IS NULL OR last_accessed_at < ?)
      AND confidence > ?
  `).run(DECAY_FACTOR, MIN_CONFIDENCE, threshold, MIN_CONFIDENCE);

  // Record when decay last ran (even if 0 entities were decayed)
  db.prepare(
    "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_decay_at', ?)"
  ).run(new Date().toISOString());

  return { decayed: Number(result.changes) };
}

/**
 * Get decay status for reporting or diagnostics.
 */
export function getDecayStatus(db: MemeshDatabase): {
  lastDecayAt: string | null;
  entitiesBelowThreshold: number;
} {
  const lastDecay = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'"
  ).get() as { value: string } | undefined;

  const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
  let belowThreshold = 0;
  if (cols.some((c) => c.name === 'confidence')) {
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM entities WHERE confidence < 0.5 AND status = 'active'"
    ).get() as { c: number };
    belowThreshold = row.c;
  }

  return {
    lastDecayAt: lastDecay?.value ?? null,
    entitiesBelowThreshold: belowThreshold,
  };
}

// Types that should NEVER be compressed — they represent intentional knowledge
const PRESERVED_TYPES = new Set([
  'decision', 'pattern', 'lesson_learned', 'bug_fix', 'architecture',
  'convention', 'feature', 'best_practice', 'concept', 'tool', 'note',
  'plan', 'release', 'refactoring', 'maintenance',
]);

// Types considered auto-generated noise
const NOISE_TYPES = new Set([
  'session_keypoint', 'commit', 'session-insight', 'session-summary',
]);

const COMPRESS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NOISE_AGE_DAYS = 7;
const NOISE_THRESHOLD = 20; // minimum noise entities per week to trigger compression

/**
 * Compress old auto-generated entities into weekly summaries.
 * Groups session_keypoint, commit, session-insight entities older than 7 days
 * by ISO week. Creates one summary entity per week and archives the originals.
 *
 * - Throttled to once per 24 hours via memesh_metadata
 * - Only compresses if > 20 noise entities exist for a given week
 * - Never touches: decisions, patterns, lessons, bug_fixes, or any intentional knowledge
 */
export function compressWeeklyNoise(db: MemeshDatabase): { compressed: number; weeksProcessed: number } {
  const kg = new KnowledgeGraph(db);

  // Throttle: skip if last compression was less than 24h ago
  const lastRun = db.prepare(
    "SELECT value FROM memesh_metadata WHERE key = 'last_noise_compress_at'"
  ).get() as { value: string } | undefined;

  if (lastRun) {
    const elapsed = Date.now() - new Date(lastRun.value).getTime();
    if (elapsed < COMPRESS_INTERVAL_MS) {
      return { compressed: 0, weeksProcessed: 0 };
    }
  }

  // Backward-compat: skip if status column doesn't exist
  const cols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'status')) {
    return { compressed: 0, weeksProcessed: 0 };
  }

  // Find old noise entities grouped by calendar week
  const cutoff = new Date(Date.now() - NOISE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const noiseTypePlaceholders = Array.from(NOISE_TYPES).map(() => '?').join(',');
  const noiseTypeValues = Array.from(NOISE_TYPES);

  const weekGroups = db.prepare(`
    SELECT strftime('%Y-W%W', created_at) as week,
           COUNT(*) as count
    FROM entities
    WHERE type IN (${noiseTypePlaceholders})
      AND status = 'active'
      AND created_at < datetime(?)
    GROUP BY week
    HAVING count >= ?
    ORDER BY week
  `).all(...noiseTypeValues, cutoff, NOISE_THRESHOLD) as Array<{ week: string; count: number }>;

  let totalCompressed = 0;

  for (const { week, count } of weekGroups) {
    // Get entities for this week — include cutoff filter to avoid archiving recent entities
    const entities = db.prepare(`
      SELECT e.id, e.name, e.type
      FROM entities e
      WHERE e.type IN (${noiseTypePlaceholders})
        AND e.status = 'active'
        AND strftime('%Y-W%W', e.created_at) = ?
        AND e.created_at < datetime(?)
    `).all(...noiseTypeValues, week, cutoff) as Array<{ id: number; name: string; type: string }>;

    if (entities.length === 0) continue;

    // Count by type
    const typeCounts = new Map<string, number>();
    for (const e of entities) {
      typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    }

    const typeBreakdown = Array.from(typeCounts.entries())
      .map(([t, c]) => `${c} ${t}`)
      .join(', ');

    // Create or update weekly summary entity — through KnowledgeGraph.
    // A raw INSERT here used to be a fourth entity-write path (besides
    // createEntity/captureEntity): its append branch skipped the
    // contentless-FTS delete+insert dance (stale index tokens on every
    // appended summary), and its create branch skipped the signal_score
    // stamp. createEntity owns both invariants; `untrusted` opts out of
    // the confidence bump — a machine summary adds no truth value.
    const summaryName = `weekly-summary-${week}`;
    const existing = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName) as { id: number } | undefined;

    if (existing) {
      kg.createEntity(summaryName, 'weekly-summary', {
        observations: [`+${entities.length} entities archived (${typeBreakdown})`],
        trustOverride: 'untrusted',
      });
    } else {
      // Heuristic title, same as the auto-capture hooks generate.
      // title_source marks this as machine-derived, so a future LLM titling
      // pass may replace it; an unmarked title is treated as human-provided.
      const title = `${week} — ${entities.length} entities compressed`;
      const obsText = `${week}: ${count} auto-tracked entities compressed (${typeBreakdown})`;
      // Copy project tags from originals
      const entityIdPlaceholders = entities.map(() => '?').join(',');
      const projectTags = db.prepare(`
        SELECT DISTINCT t.tag FROM tags t
        JOIN entities e ON e.id = t.entity_id
        WHERE e.id IN (${entityIdPlaceholders})
          AND t.tag LIKE 'project:%'
      `).all(...entities.map(e => e.id)) as Array<{ tag: string }>;
      kg.createEntity(summaryName, 'weekly-summary', {
        title,
        metadata: { title_source: 'heuristic' },
        observations: [obsText],
        tags: [...projectTags.map((t) => t.tag), 'source:noise-filter'],
        trustOverride: 'untrusted',
      });
    }

    // Archive originals — out of BOTH indexes, then out of circulation.
    //
    // This used to be the bare UPDATE alone, and an archived entity kept its
    // FTS row and its vector. Measured on the maintainer's graph, this path
    // alone accounted for all 213 archived entities still in the keyword index
    // (`MATCH 'ae83279'` answered with the archived `commit-ae83279`), and it
    // is also what made re-remembering one of them insert a second, permanently
    // undeletable document at the same FTS rowid — see `createEntityInner`.
    //
    // Per entity rather than one set-UPDATE: a contentless FTS5 delete has to
    // repeat that row's own indexed text, so there is no set form of it.
    const archiveOne = db.prepare("UPDATE entities SET status = 'archived' WHERE id = ?");
    db.transaction(() => {
      for (const e of entities) {
        dropEntityFromIndexes(db, e.id, e.name);
        archiveOne.run(e.id);
      }
    })();

    totalCompressed += entities.length;
  }

  // Record timestamp
  db.prepare(
    "INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_noise_compress_at', ?)"
  ).run(new Date().toISOString());

  return { compressed: totalCompressed, weeksProcessed: weekGroups.length };
}

// Export preserved/noise type sets for testing
export { PRESERVED_TYPES, NOISE_TYPES };

// memesh_metadata is created by SCHEMA_SQL (db.ts / openHookDb) — the only
// two schema owners. The ad-hoc CREATE TABLE that used to live here was the
// exact drift class check-schema-drift.mjs cannot see, and its bare DDL exec
// broke the read-only-file degradation the schema owners handle deliberately.
