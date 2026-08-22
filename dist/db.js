import { MemeshDatabase } from './storage/sqlite.js';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { runAutoDecay } from './core/lifecycle.js';
import { resolveEmbeddingDimension } from './core/config.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { getDbPath } from './core/paths.js';
import { insertFtsRow, joinIndexedObservations, removeFromFts } from './storage/fts-index.js';
import { SCHEMA_SQL, FTS_SQL, safeAlter, migrateEntitiesSchema, ensureTagsUniqueIndex, ensureHookRunsSince, ensureFtsSegmentation, rebuildFtsIndex, runOnceMigration, FTS_SEGMENTATION_VERSION, } from './storage/schema.js';
export { runOnceMigration, FTS_SEGMENTATION_VERSION };
import { truncateTitle, isBoilerplateObservation } from './core/title.js';
let db = null;
let dimensionMismatchNoticed = false;
export function openDatabase(dbPath) {
    if (db)
        return db;
    const resolvedPath = dbPath ?? getDbPath();
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.chmodSync(dir, 0o700);
    }
    catch { }
    const opening = new MemeshDatabase(resolvedPath, { allowExtension: true });
    try {
        initialiseDatabase(opening, resolvedPath);
    }
    catch (err) {
        try {
            opening.close();
        }
        catch { }
        throw err;
    }
    db = opening;
    return db;
}
function isReadonlyDbError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /readonly database|SQLITE_READONLY/i.test(msg);
}
function initialiseDatabase(db, resolvedPath) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    try {
        migrateToCurrentSchema(db, resolvedPath);
    }
    catch (err) {
        if (!isReadonlyDbError(err))
            throw err;
        try {
            process.stderr.write('MeMesh: the database file is read-only, so schema migration was skipped — ' +
                'opened for reads only. Capture and migrations resume when the file is writable.\n');
        }
        catch { }
    }
    return db;
}
function migrateToCurrentSchema(db, resolvedPath) {
    db.exec(SCHEMA_SQL);
    db.exec(FTS_SQL);
    ensureTagsUniqueIndex(db);
    ensureHookRunsSince(db);
    try {
        process.umask(0o077);
    }
    catch { }
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            fs.chmodSync(`${resolvedPath}${suffix}`, 0o600);
        }
        catch { }
    }
    migrateEntitiesSchema(db);
    runAutoDecay(db);
    backfillSignalScores(db);
    backfillTitles(db);
    backfillAcceptedProposalTrust(db);
    ensureDreamProposalsTable(db);
    ensureConflictJudgedPairsTable(db);
    ensureLlmTelemetryTable(db);
    runAutoTelemetryPrune(db);
    ensureFtsSegmentation(db);
    let vectorIndexAvailable = true;
    db.enableLoadExtension(true);
    try {
        sqliteVec.load(db);
    }
    catch (err) {
        vectorIndexAvailable = false;
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`MeMesh: sqlite-vec could not be loaded (${detail}).\n` +
            'MeMesh: recall will use FTS5 keyword search only. `memesh doctor` explains this row.\n');
    }
    finally {
        db.enableLoadExtension(false);
    }
    if (vectorIndexAvailable) {
        const { dimension: targetDim, confident: dimensionKnown } = resolveEmbeddingDimension();
        ensureVecTable(db, resolvedPath, targetDim, dimensionKnown);
    }
}
export function reindexFts() {
    const database = getDatabase();
    database.transaction(() => {
        rebuildFtsIndex(database);
        database
            .prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
            .run('fts_segmentation_version', String(FTS_SEGMENTATION_VERSION));
        database.prepare('DELETE FROM memesh_metadata WHERE key = ?').run('fts_segmentation_version_last_attempt');
    }).immediate();
    const { c } = database
        .prepare("SELECT count(*) AS c FROM entities WHERE status = 'active'")
        .get();
    return { entities: c };
}
function ensureVecTable(db, resolvedPath, targetDim, dimensionKnown = true) {
    const storedDim = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
    const currentDim = storedDim ? parseInt(storedDim.value, 10) : 0;
    const vecExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities_vec'").get();
    if (vecExists && currentDim === targetDim) {
        return;
    }
    if (vecExists && !dimensionKnown) {
        process.stderr.write(`MeMesh: embedding dimension could not be determined (config unreadable), so the ` +
            `existing ${currentDim}-dim vector index was left untouched rather than rebuilt. ` +
            `Fix ~/.memesh/config.json to change embedders.\n`);
        return;
    }
    if (vecExists && currentDim !== 0 && currentDim !== targetDim) {
        if (!dimensionMismatchNoticed) {
            process.stderr.write(`MeMesh: this database records ${currentDim}-dim embeddings but the current ` +
                `configuration asks for ${targetDim}. Nothing is deleted — the index is kept ` +
                `so a rebuild can resume — but semantic search is OFF until the rebuild ` +
                `finishes, because a ${targetDim}-dim query cannot be matched against a ` +
                `${currentDim}-dim index; recall is on keyword search alone meanwhile. ` +
                `Run 'memesh reindex' to build the ${targetDim}-dim index alongside it and ` +
                `switch over once it is complete.\n`);
            dimensionMismatchNoticed = true;
        }
        markReindexOwed(currentDim, targetDim, 'dimension-change', db);
        return;
    }
    db.transaction(() => {
        db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_vec USING vec0(
        embedding float[${targetDim}]
      );
    `);
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('embedding_dimension', ?)").run(String(targetDim));
    }).immediate();
}
export const GENERATION_TABLE = 'entities_vec_next';
const GENERATION_HASH_TABLE = 'entities_vec_next_source';
const GENERATION_KEY = 'vector_generation';
function tableExists(conn, name) {
    return conn.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name).c > 0;
}
function assertVectorWidth(dimension) {
    if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 65536) {
        throw new Error(`Refusing to build a vector index at width ${String(dimension)}.`);
    }
}
export function readVectorGeneration() {
    if (!db)
        return { state: 'none' };
    try {
        const row = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(GENERATION_KEY);
        if (!row)
            return { state: 'none' };
        const parsed = JSON.parse(row.value);
        if (typeof parsed.dimension !== 'number' || typeof parsed.provider !== 'string') {
            return { state: 'unreadable', detail: 'the marker is missing its dimension or provider' };
        }
        return {
            state: 'open',
            info: {
                dimension: parsed.dimension,
                provider: parsed.provider,
                startedAt: String(parsed.startedAt ?? ''),
            },
        };
    }
    catch (err) {
        return { state: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    }
}
export function generationRowIds() {
    const out = new Set();
    if (!db)
        return out;
    if (!tableExists(db, GENERATION_TABLE))
        return out;
    const rows = db.prepare(`SELECT rowid AS id FROM ${GENERATION_TABLE}`).all();
    for (const r of rows)
        out.add(Number(r.id));
    return out;
}
export function beginVectorGeneration(dimension, provider) {
    assertVectorWidth(dimension);
    const conn = getDatabase();
    const read = readVectorGeneration();
    const stagingExists = tableExists(conn, GENERATION_TABLE);
    if (read.state === 'unreadable' && stagingExists) {
        throw new Error('A half-built vector index is present but its marker cannot be read '
            + `(${read.detail}). Resuming it risks mixing vectors from two different `
            + 'embedding spaces, and discarding it throws away embeddings a previous run '
            + 'already produced, so neither is done automatically. Run '
            + '`memesh reindex --discard-generation` to throw the half-built index away '
            + 'and start clean.');
    }
    const existing = read.state === 'open' ? read.info : null;
    const compatible = stagingExists && existing !== null
        && existing.dimension === dimension && existing.provider === provider;
    if (stagingExists && !compatible) {
        discardVectorGeneration();
    }
    const startedAt = compatible && existing ? existing.startedAt : new Date().toISOString();
    conn.transaction(() => {
        conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${GENERATION_TABLE} USING vec0(embedding float[${dimension}])`);
        conn.exec(`CREATE TABLE IF NOT EXISTS ${GENERATION_HASH_TABLE} (`
            + 'rowid_ref INTEGER PRIMARY KEY, text_hash TEXT NOT NULL)');
        conn.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(GENERATION_KEY, JSON.stringify({ dimension, provider, startedAt }));
    }).immediate();
    return { resumed: compatible };
}
export function generationRowHashes() {
    const out = new Map();
    if (!db)
        return out;
    if (!tableExists(db, GENERATION_HASH_TABLE))
        return out;
    const rows = db.prepare(`SELECT rowid_ref AS id, text_hash AS h FROM ${GENERATION_HASH_TABLE}`).all();
    for (const r of rows)
        out.set(Number(r.id), r.h);
    return out;
}
export function recordGenerationRow(entityId, textHash) {
    const conn = getDatabase();
    conn.prepare(`INSERT OR REPLACE INTO ${GENERATION_HASH_TABLE} (rowid_ref, text_hash) VALUES (?, ?)`).run(BigInt(entityId), textHash);
}
export function discardVectorGeneration() {
    const conn = getDatabase();
    conn.transaction(() => {
        conn.exec(`DROP TABLE IF EXISTS ${GENERATION_TABLE}`);
        conn.exec(`DROP TABLE IF EXISTS ${GENERATION_HASH_TABLE}`);
        conn.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(GENERATION_KEY);
    }).immediate();
}
export function swapVectorGeneration(dimension) {
    assertVectorWidth(dimension);
    const conn = getDatabase();
    conn.transaction(() => {
        conn.exec(`DELETE FROM ${GENERATION_TABLE} WHERE rowid NOT IN `
            + `(SELECT id FROM entities WHERE status = 'active')`);
        const storedDim = Number(conn.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get()?.value ?? 0);
        if (storedDim === dimension) {
            conn.exec(`INSERT INTO ${GENERATION_TABLE} (rowid, embedding) `
                + `SELECT v.rowid, v.embedding FROM entities_vec v `
                + `WHERE v.rowid IN (SELECT id FROM entities WHERE status = 'active') `
                + `AND v.rowid NOT IN (SELECT rowid FROM ${GENERATION_TABLE})`);
        }
        const staged = conn.prepare(`SELECT COUNT(*) AS c FROM ${GENERATION_TABLE}`).get().c;
        conn.exec('DROP TABLE IF EXISTS entities_vec');
        conn.exec(`CREATE VIRTUAL TABLE entities_vec USING vec0(embedding float[${dimension}])`);
        conn.exec(`INSERT INTO entities_vec (rowid, embedding) SELECT rowid, embedding FROM ${GENERATION_TABLE}`);
        const installed = conn.prepare('SELECT COUNT(*) AS c FROM entities_vec').get().c;
        if (installed !== staged) {
            throw new Error(`Vector index swap copied ${installed} of ${staged} staged rows; refusing to publish a short index.`);
        }
        conn.exec(`DROP TABLE ${GENERATION_TABLE}`);
        conn.exec(`DROP TABLE IF EXISTS ${GENERATION_HASH_TABLE}`);
        conn.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run('embedding_dimension', String(dimension));
        conn.prepare('DELETE FROM memesh_metadata WHERE key = ?').run(GENERATION_KEY);
    }).immediate();
}
export function getStoredEmbeddingDimension() {
    if (!db)
        return 0;
    const row = db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get();
    return row ? Number(row.value) || 0 : 0;
}
export function getPendingReindexInfo() {
    return readPendingReindex(db);
}
function readPendingReindex(conn) {
    if (!conn)
        return null;
    try {
        const row = conn.prepare("SELECT value FROM memesh_metadata WHERE key = 'pending_reindex'").get();
        return row ? JSON.parse(row.value) : null;
    }
    catch {
        return null;
    }
}
export function markReindexOwed(from, to, reason, conn = db) {
    if (!conn)
        return;
    const existing = readPendingReindex(conn);
    if (existing && existing.from === from && existing.to === to && existing.reason === reason) {
        return;
    }
    conn.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES ('pending_reindex', ?)").run(JSON.stringify({
        from,
        to,
        reason,
        noticedAt: existing?.noticedAt ?? new Date().toISOString(),
    }));
}
export function clearPendingReindexFlag() {
    if (!db)
        return;
    db.prepare("DELETE FROM memesh_metadata WHERE key = 'pending_reindex'").run();
}
function ensureDreamProposalsTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS dream_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      source_ids TEXT NOT NULL,
      proposed_digest TEXT NOT NULL,
      llm_model TEXT,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_status ON dream_proposals(status);
    CREATE INDEX IF NOT EXISTS idx_dream_proposals_project ON dream_proposals(project);
  `);
    const dpCols = db.prepare("PRAGMA table_info(dream_proposals)").all();
    if (!dpCols.some((c) => c.name === 'source_kind')) {
        safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'entities'");
    }
    if (!dpCols.some((c) => c.name === 'kind')) {
        safeAlter(db, "ALTER TABLE dream_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'digest'");
    }
}
function ensureConflictJudgedPairsTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS conflict_judged_pairs (
      pair_key TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      proposal_id INTEGER,
      judged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
function ensureLlmTelemetryTable(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS llm_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      flow TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      project TEXT,
      attempt_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error_class TEXT,
      error_message TEXT,
      fallback_used INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_llm_telemetry_ts ON llm_telemetry(ts);
    CREATE INDEX IF NOT EXISTS idx_llm_telemetry_flow ON llm_telemetry(flow);
    CREATE INDEX IF NOT EXISTS idx_llm_telemetry_status ON llm_telemetry(status);
  `);
}
const TELEMETRY_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TELEMETRY_PRUNE_DEFAULT_DAYS = 180;
const TELEMETRY_PRUNE_MARKER = 'last_telemetry_prune_at';
function runAutoTelemetryPrune(db) {
    const last = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(TELEMETRY_PRUNE_MARKER);
    if (last) {
        const elapsed = Date.now() - new Date(last.value).getTime();
        if (elapsed < TELEMETRY_PRUNE_INTERVAL_MS)
            return;
    }
    const cutoffIso = new Date(Date.now() - TELEMETRY_PRUNE_DEFAULT_DAYS * 86400000).toISOString();
    try {
        db.prepare('DELETE FROM llm_telemetry WHERE ts < ?').run(cutoffIso);
    }
    catch {
        return;
    }
    db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(TELEMETRY_PRUNE_MARKER, new Date().toISOString());
}
function backfillSignalScores(db) {
    const MARKER = 'signal_score_backfill_v2';
    const done = db.prepare("SELECT value FROM memesh_metadata WHERE key = ?").get(MARKER);
    if (done)
        return;
    const rows = db.prepare('SELECT id, name, type, metadata FROM entities').all();
    if (rows.length === 0) {
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)").run(MARKER, new Date().toISOString());
        return;
    }
    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ?');
    const tagStmt = db.prepare('SELECT tag FROM tags WHERE entity_id = ?');
    const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    const tx = db.transaction(() => {
        let scored = 0;
        let skipped = 0;
        for (const row of rows) {
            let metadata;
            if (row.metadata) {
                try {
                    metadata = JSON.parse(row.metadata);
                }
                catch {
                    skipped++;
                    continue;
                }
                if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
                    skipped++;
                    continue;
                }
            }
            else {
                metadata = {};
            }
            if (typeof metadata.signal_score === 'number') {
                skipped++;
                continue;
            }
            const observations = obsStmt.all(row.id).map(o => o.content);
            const tags = tagStmt.all(row.id).map(t => t.tag);
            metadata.signal_score = computeSignalScore({
                type: row.type,
                name: row.name,
                observations,
                tags,
            });
            updateStmt.run(JSON.stringify(metadata), row.id);
            scored++;
        }
        db.prepare("INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)").run(MARKER, JSON.stringify({ at: new Date().toISOString(), scored, skipped }));
    });
    tx();
}
function deriveHeuristicTitle(type, observations) {
    if (observations.length === 0)
        return null;
    if (type === 'lesson_learned' || type === 'lesson' || type === 'mistake') {
        const errObs = observations.find((o) => /^Error:\s*/.test(o.trim()));
        if (errObs) {
            const firstLine = errObs.trim().replace(/^Error:\s*/, '').split('\n')[0].trim();
            if (firstLine)
                return truncateTitle(firstLine);
        }
    }
    if (type === 'commit') {
        const first = observations[0]?.split('\n')[0].trim();
        if (first && !/^(Branch|Diff stats):/.test(first))
            return truncateTitle(first);
    }
    const nonTrivial = observations.filter((o) => o.length > 30 && !isBoilerplateObservation(o));
    const pool = nonTrivial.length > 0 ? nonTrivial : observations;
    const best = pool.slice(0, 3).reduce((a, b) => (b.length > a.length ? b : a), pool[0]);
    const firstLine = best?.split('\n')[0].trim();
    return firstLine ? truncateTitle(firstLine) : null;
}
function backfillAcceptedProposalTrust(db) {
    const MARKER = 'accepted_proposal_trust_v1';
    if (db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER))
        return;
    const stamp = (cleared, skipped) => db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)')
        .run(MARKER, JSON.stringify({ at: new Date().toISOString(), cleared, skipped }));
    let rows;
    try {
        rows = db.prepare(`SELECT id, metadata FROM entities
        WHERE metadata IS NOT NULL
          AND json_valid(metadata)
          AND json_extract(metadata, '$.trust') = 'untrusted'
          AND json_extract(metadata, '$.proposal_id') IS NOT NULL`).all();
    }
    catch {
        return;
    }
    if (rows.length === 0) {
        stamp(0, 0);
        return;
    }
    const updateStmt = db.prepare('UPDATE entities SET metadata = ? WHERE id = ?');
    const tx = db.transaction(() => {
        let cleared = 0;
        let skipped = 0;
        for (const row of rows) {
            let metadata;
            try {
                const parsed = JSON.parse(row.metadata ?? '{}');
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    skipped++;
                    continue;
                }
                metadata = parsed;
            }
            catch {
                skipped++;
                continue;
            }
            delete metadata.trust;
            updateStmt.run(JSON.stringify(metadata), row.id);
            cleared++;
        }
        stamp(cleared, skipped);
    });
    tx();
}
function backfillTitles(db) {
    const MARKER = 'title_backfill_v1';
    const done = db.prepare('SELECT value FROM memesh_metadata WHERE key = ?').get(MARKER);
    if (done)
        return;
    const rows = db.prepare('SELECT id, name, type, status, metadata FROM entities WHERE title IS NULL').all();
    const stamp = (titled, skipped) => db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(MARKER, JSON.stringify({ at: new Date().toISOString(), titled, skipped }));
    if (rows.length === 0) {
        stamp(0, 0);
        return;
    }
    const obsStmt = db.prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id');
    const updateStmt = db.prepare('UPDATE entities SET title = ?, metadata = ? WHERE id = ?');
    const tx = db.transaction(() => {
        let titled = 0;
        let skipped = 0;
        for (const row of rows) {
            let metadata;
            if (row.metadata) {
                try {
                    metadata = JSON.parse(row.metadata);
                }
                catch {
                    skipped++;
                    continue;
                }
                if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
                    skipped++;
                    continue;
                }
            }
            else {
                metadata = {};
            }
            const observations = obsStmt.all(row.id).map(o => o.content);
            const title = deriveHeuristicTitle(row.type, observations);
            if (!title) {
                skipped++;
                continue;
            }
            metadata.title_source = 'heuristic';
            updateStmt.run(title, JSON.stringify(metadata), row.id);
            if (row.status === 'active') {
                const obsText = joinIndexedObservations(observations);
                removeFromFts(db, row.id, row.name, obsText);
                insertFtsRow(db, row.id, row.name, obsText, title);
            }
            titled++;
        }
        db.prepare('INSERT OR REPLACE INTO memesh_metadata (key, value) VALUES (?, ?)').run(MARKER, JSON.stringify({ at: new Date().toISOString(), titled, skipped }));
    });
    tx();
}
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
    }
    dimensionMismatchNoticed = false;
}
export function getDatabase() {
    if (!db)
        throw new Error('Database not opened');
    return db;
}
export function isDatabaseOpen() {
    return db !== null;
}
//# sourceMappingURL=db.js.map