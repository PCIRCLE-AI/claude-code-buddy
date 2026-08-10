/**
 * The signal-score backfill, and the two ways re-running it could go wrong.
 *
 * `remember()` used to rebuild an entity's metadata from a snapshot taken
 * before the row was written, discarding the `signal_score` stamped at
 * creation. So on any graph that has been in use, entities written through
 * `remember` after the v1 backfill carry no score while everything older does
 * — and the three consumers disagree about what missing MEANS: `kg-backfill`
 * treats it as 1.0, the dreamer as 0.5, the dashboard passes it through. The
 * marker is bumped to v2 so the scan runs once more and closes the split.
 *
 * A re-run is only safe because the pass fills a gap rather than recomputing:
 * a row that already has a score must come out untouched, and a row whose
 * metadata cannot be parsed must be left entirely alone. That second one was a
 * latent bug — the parse failure fell back to `{}` and the column was written
 * back whole, so an unreadable metadata column was replaced by one holding
 * only a score. Harmless while the pass ran once on a young graph; not
 * harmless now that it runs again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-backfill-'));
  dbPath = path.join(dir, 'test.db');
});
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Insert a row with the given raw metadata column, bypassing the API. */
function seedRaw(name: string, metadata: string | null): void {
  const db = openDatabase(dbPath);
  db.prepare("INSERT INTO entities (name, type, metadata) VALUES (?, 'note', ?)").run(name, metadata);
  db.prepare('INSERT INTO observations (entity_id, content) VALUES ((SELECT id FROM entities WHERE name = ?), ?)')
    .run(name, 'a reasonably specific observation about the thing');
  closeDatabase();
}

function metadataOf(name: string): string | null {
  const db = openDatabase(dbPath);
  const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get(name) as { metadata: string | null };
  closeDatabase();
  return row.metadata;
}

/** Force the backfill to run again, as the version bump does on a real graph. */
function clearMarker(): void {
  const db = openDatabase(dbPath);
  db.prepare("DELETE FROM memesh_metadata WHERE key LIKE 'signal_score_backfill%'").run();
  closeDatabase();
}

describe('the signal-score backfill fills gaps and nothing else', () => {
  it('scores a row that has none', () => {
    seedRaw('unscored', JSON.stringify({ pin: true }));
    clearMarker();
    openDatabase(dbPath); // triggers the backfill
    closeDatabase();

    const meta = JSON.parse(metadataOf('unscored') as string);
    expect(typeof meta.signal_score, 'the gap this pass exists to close was not filled').toBe('number');
    // Everything that was already there survives.
    expect(meta.pin).toBe(true);
  });

  it('leaves a row that already has one exactly as it was', () => {
    // Not a recompute. A deliberately odd value proves the pass did not
    // overwrite it with what the scorer would have produced.
    const original = JSON.stringify({ signal_score: 0.123456, note: 'keep me' });
    seedRaw('scored', original);
    clearMarker();
    openDatabase(dbPath);
    closeDatabase();

    const meta = JSON.parse(metadataOf('scored') as string);
    expect(meta.signal_score).toBe(0.123456);
    expect(meta.note).toBe('keep me');
  });

  it('does not replace a metadata column it cannot parse', () => {
    // The latent bug the re-run would otherwise expose: the parse failure fell
    // back to `{}`, and the row is written back whole, so the unreadable
    // content was destroyed and replaced by a bare score.
    const corrupt = '{ "half written';
    seedRaw('corrupt', corrupt);
    clearMarker();
    openDatabase(dbPath);
    closeDatabase();

    expect(metadataOf('corrupt'), 'unparseable metadata was overwritten by the backfill').toBe(corrupt);
  });

  it('runs once, not on every open', () => {
    seedRaw('marker-check', null);
    clearMarker();
    openDatabase(dbPath);
    closeDatabase();

    const db = openDatabase(dbPath);
    const marker = db.prepare("SELECT key FROM memesh_metadata WHERE key LIKE 'signal_score_backfill%'").all() as Array<{ key: string }>;
    closeDatabase();
    expect(marker.map(m => m.key), 'the pass did not record that it had run').toContain('signal_score_backfill_v2');
  });
});
