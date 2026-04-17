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
