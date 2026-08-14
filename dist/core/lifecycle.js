import { insertFtsRow } from '../storage/fts-index.js';
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_DAYS = 30;
const DECAY_FACTOR = 0.9;
const MIN_CONFIDENCE = 0.01;
export function runAutoDecay(db) {
    ensureMetadataTable(db);
    const lastDecay = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get();
    if (lastDecay) {
        const elapsed = Date.now() - new Date(lastDecay.value).getTime();
        if (elapsed < DECAY_INTERVAL_MS) {
            return { decayed: 0 };
        }
    }
    const cols = db.prepare('PRAGMA table_info(entities)').all();
    if (!cols.some((c) => c.name === 'confidence')) {
        return { decayed: 0 };
    }
    const threshold = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(`
    UPDATE entities
    SET confidence = MAX(confidence * ?, ?)
    WHERE status = 'active'
      AND (last_accessed_at IS NULL OR last_accessed_at < ?)
      AND confidence > ?
  `).run(DECAY_FACTOR, MIN_CONFIDENCE, threshold, MIN_CONFIDENCE);
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_decay_at', ?)").run(new Date().toISOString());
    return { decayed: Number(result.changes) };
}
export function getDecayStatus(db) {
    ensureMetadataTable(db);
    const lastDecay = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_decay_at'").get();
    const cols = db.prepare('PRAGMA table_info(entities)').all();
    let belowThreshold = 0;
    if (cols.some((c) => c.name === 'confidence')) {
        const row = db.prepare("SELECT COUNT(*) as c FROM entities WHERE confidence < 0.5 AND status = 'active'").get();
        belowThreshold = row.c;
    }
    return {
        lastDecayAt: lastDecay?.value ?? null,
        entitiesBelowThreshold: belowThreshold,
    };
}
const PRESERVED_TYPES = new Set([
    'decision', 'pattern', 'lesson_learned', 'bug_fix', 'architecture',
    'convention', 'feature', 'best_practice', 'concept', 'tool', 'note',
    'plan', 'release', 'refactoring', 'maintenance',
]);
const NOISE_TYPES = new Set([
    'session_keypoint', 'commit', 'session-insight', 'session-summary',
]);
const COMPRESS_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOISE_AGE_DAYS = 7;
const NOISE_THRESHOLD = 20;
export function compressWeeklyNoise(db) {
    ensureMetadataTable(db);
    const lastRun = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'last_noise_compress_at'").get();
    if (lastRun) {
        const elapsed = Date.now() - new Date(lastRun.value).getTime();
        if (elapsed < COMPRESS_INTERVAL_MS) {
            return { compressed: 0, weeksProcessed: 0 };
        }
    }
    const cols = db.prepare('PRAGMA table_info(entities)').all();
    if (!cols.some((c) => c.name === 'status')) {
        return { compressed: 0, weeksProcessed: 0 };
    }
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
  `).all(...noiseTypeValues, cutoff, NOISE_THRESHOLD);
    let totalCompressed = 0;
    for (const { week, count } of weekGroups) {
        const entities = db.prepare(`
      SELECT e.id, e.name, e.type
      FROM entities e
      WHERE e.type IN (${noiseTypePlaceholders})
        AND e.status = 'active'
        AND strftime('%Y-W%W', e.created_at) = ?
        AND e.created_at < ?
    `).all(...noiseTypeValues, week, cutoff);
        if (entities.length === 0)
            continue;
        const typeCounts = new Map();
        for (const e of entities) {
            typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
        }
        const typeBreakdown = Array.from(typeCounts.entries())
            .map(([t, c]) => `${c} ${t}`)
            .join(', ');
        const summaryName = `weekly-summary-${week}`;
        const existing = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName);
        if (existing) {
            db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(existing.id, `+${entities.length} entities archived (${typeBreakdown})`);
        }
        else {
            const title = `${week} — ${entities.length} entities compressed`;
            db.prepare('INSERT INTO entities (name, type, title, metadata) VALUES (?, ?, ?, ?)').run(summaryName, 'weekly-summary', title, JSON.stringify({ title_source: 'heuristic' }));
            const summaryRow = db.prepare('SELECT id FROM entities WHERE name = ?').get(summaryName);
            const obsText = `${week}: ${count} auto-tracked entities compressed (${typeBreakdown})`;
            db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(summaryRow.id, obsText);
            insertFtsRow(db, summaryRow.id, summaryName, obsText, title);
            const entityIdPlaceholders = entities.map(() => '?').join(',');
            const projectTags = db.prepare(`
        SELECT DISTINCT t.tag FROM tags t
        JOIN entities e ON e.id = t.entity_id
        WHERE e.id IN (${entityIdPlaceholders})
          AND t.tag LIKE 'project:%'
      `).all(...entities.map(e => e.id));
            for (const { tag } of projectTags) {
                db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(summaryRow.id, tag);
            }
            db.prepare('INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)').run(summaryRow.id, 'source:noise-filter');
        }
        const archiveIdPlaceholders = entities.map(() => '?').join(',');
        db.prepare(`
      UPDATE entities SET status = 'archived'
      WHERE id IN (${archiveIdPlaceholders})
    `).run(...entities.map(e => e.id));
        totalCompressed += entities.length;
    }
    db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('last_noise_compress_at', ?)").run(new Date().toISOString());
    return { compressed: totalCompressed, weeksProcessed: weekGroups.length };
}
export { PRESERVED_TYPES, NOISE_TYPES };
function ensureMetadataTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS memesh_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}
//# sourceMappingURL=lifecycle.js.map