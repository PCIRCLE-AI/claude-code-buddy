import Database from 'better-sqlite3';

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
export function runAutoDecay(db: Database.Database): { decayed: number } {
  ensureMetadataTable(db);

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

  return { decayed: result.changes };
}

/**
 * Get decay status for reporting or diagnostics.
 */
export function getDecayStatus(db: Database.Database): {
  lastDecayAt: string | null;
  entitiesBelowThreshold: number;
} {
  ensureMetadataTable(db);

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
export function compressWeeklyNoise(db: Database.Database): { compressed: number; weeksProcessed: number } {
  ensureMetadataTable(db);

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

  // Find old noise entities grouped by ISO week
  const cutoff = new Date(Date.now() - NOISE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const noiseTypePlaceholders = Array.from(NOISE_TYPES).map(() => '?').join(',');
  const noiseTypeValues = Array.from(NOISE_TYPES);

  const weekGroups = db.prepare(`
    SELECT strftime('%Y-W%W', created_at) as week,
           COUNT(*) as count
    FROM entities
    WHERE type IN (${noiseTypePlaceholders})
      AND status = 'active'
      AND created_at < ?
    GROUP BY week
    HAVING count >= ?
    ORDER BY week
  `).all(...noiseTypeValues, cutoff, NOISE_THRESHOLD) as Array<{ week: string; count: number }>;

  let totalCompressed = 0;

  for (const { week, count } of weekGroups) {
    // Get entities for this week
    const entities = db.prepare(`
      SELECT e.id, e.name, e.type
      FROM entities e
      WHERE e.type IN (${noiseTypePlaceholders})
        AND e.status = 'active'
        AND strftime('%Y-W%W', e.created_at) = ?
    `).all(...noiseTypeValues, week) as Array<{ id: number; name: string; type: string }>;

    // Count by type
    const typeCounts = new Map<string, number>();
    for (const e of entities) {
      typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
    }

    const typeBreakdown = Array.from(typeCounts.entries())
      .map(([t, c]) => `${c} ${t}`)
      .join(', ');

    // Create weekly summary entity
    const summaryName = `weekly-summary-${week}`;
    const existing = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName);
    if (!existing) {
      db.prepare('INSERT INTO entities (name, type) VALUES (?, ?)').run(summaryName, 'weekly-summary');
      const summaryRow = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName) as { id: number };
      db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(
        summaryRow.id,
        `${week}: ${count} auto-tracked entities compressed (${typeBreakdown})`
      );
      // Copy project tags from originals
      const entityIdPlaceholders = entities.map(() => '?').join(',');
      const projectTags = db.prepare(`
        SELECT DISTINCT t.tag FROM tags t
        JOIN entities e ON e.id = t.entity_id
        WHERE e.id IN (${entityIdPlaceholders})
          AND t.tag LIKE 'project:%'
      `).all(...entities.map(e => e.id)) as Array<{ tag: string }>;
      for (const { tag } of projectTags) {
        db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(summaryRow.id, tag);
      }
      db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(summaryRow.id, 'source:noise-filter');
    }

    // Archive originals
    const archiveIdPlaceholders = entities.map(() => '?').join(',');
    db.prepare(`
      UPDATE entities SET status = 'archived'
      WHERE id IN (${archiveIdPlaceholders})
    `).run(...entities.map(e => e.id));

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

/**
 * Ensure the memesh_metadata table exists.
 * Used to store decay timestamps and other operational metadata.
 */
function ensureMetadataTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}
