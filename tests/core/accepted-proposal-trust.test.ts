/**
 * Which memories may be pushed into an agent's context unprompted.
 *
 * `isTrustedForAutoContext` blocks anything carrying
 * `metadata.trust = 'untrusted'`. `dream accept` used to stamp that marker on
 * the entity it created, and measured on a real graph the result was the
 * inverse of the intent: 74/74 raw commit records were injectable while 29
 * facts, 11 lessons and 6 decisions — every one of them accepted by a human —
 * were not. The raw commit text that was the source of the risk reached the
 * model either way; only the reviewed paraphrase of it was blocked.
 *
 * So the read-side gate now follows human acceptance. The two properties that
 * have to hold together are pinned here, because either one alone is a
 * regression:
 *
 *   1. What a human accepted becomes injectable — including the rows that
 *      were accepted BEFORE this change (the backfill).
 *   2. What no human saw stays blocked — import and auto-learned lessons mark
 *      themselves untrusted with nobody in the loop, and the backfill is
 *      scoped by `proposal_id` so it can never reach them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase } from '../../src/db.js';
import { MemeshDatabase } from '../../src/storage/sqlite.js';
import { SCHEMA_SQL, FTS_SQL } from '../../src/storage/schema.js';
import { isTrustedForAutoContext } from '../../scripts/hooks/_shared.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-accepted-trust-'));
  dbPath = path.join(dir, 'test.db');
});
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Seed the pre-change state with raw SQL on a handle that never runs the
 * migration chain — going through `openDatabase` first would stamp the
 * backfill marker against an empty table and the pass under test would be
 * skipped on the reopen.
 */
function seedRows(rows: Array<{ name: string; metadata: string | null }>): void {
  const raw = new MemeshDatabase(dbPath);
  raw.exec(SCHEMA_SQL);
  raw.exec(FTS_SQL);
  const stmt = raw.prepare(
    "INSERT INTO entities (name, type, metadata) VALUES (?, 'fact', ?)",
  );
  for (const r of rows) stmt.run(r.name, r.metadata);
  raw.close();
}

function metadataOf(name: string): string | null {
  const row = getDatabase()
    .prepare('SELECT metadata FROM entities WHERE name = ?')
    .get(name) as { metadata: string | null } | undefined;
  return row?.metadata ?? null;
}

describe('auto-injection eligibility follows human acceptance', () => {
  it('releases accepted proposals and leaves every other untrusted row alone', () => {
    seedRows([
      // Accepted via `dream accept` — proposal_id is written only by the two
      // accept paths, so it is the marker of "a human said yes".
      { name: 'accepted-digest', metadata: JSON.stringify({ trust: 'untrusted', proposal_id: 7, signal_score: 0.85 }) },
      // Imported from a file nobody reviewed.
      { name: 'imported-note', metadata: JSON.stringify({ trust: 'untrusted', provenance: { source: 'import' } }) },
      // Auto-learned by the failure analyzer — no human in the loop.
      { name: 'auto-lesson', metadata: JSON.stringify({ trust: 'untrusted' }) },
      // Corrupt metadata must be left exactly as found, never rewritten.
      { name: 'corrupt-meta', metadata: '{not json' },
    ]);

    openDatabase(dbPath);

    // 1. Accepted → injectable, and the rest of its metadata survives.
    const accepted = metadataOf('accepted-digest');
    expect(isTrustedForAutoContext(accepted)).toBe(true);
    const parsed = JSON.parse(accepted!);
    expect(parsed.trust).toBeUndefined();
    expect(parsed.proposal_id).toBe(7);
    expect(parsed.signal_score).toBe(0.85);

    // 2. Everything a human never saw stays blocked.
    expect(isTrustedForAutoContext(metadataOf('imported-note'))).toBe(false);
    expect(isTrustedForAutoContext(metadataOf('auto-lesson'))).toBe(false);

    // 3. Unparseable metadata is untouched — byte for byte.
    expect(metadataOf('corrupt-meta')).toBe('{not json');
  });

  it('is idempotent: a second open does not re-clear a marker written since', () => {
    seedRows([
      { name: 'accepted-digest', metadata: JSON.stringify({ trust: 'untrusted', proposal_id: 1 }) },
    ]);
    openDatabase(dbPath);
    expect(isTrustedForAutoContext(metadataOf('accepted-digest'))).toBe(true);

    // Re-mark it the way a stale writer would, then reopen. The marker guard
    // means the pass does not run again — proving the guard is real rather
    // than the assertion passing because the row simply never changes.
    getDatabase()
      .prepare('UPDATE entities SET metadata = ? WHERE name = ?')
      .run(JSON.stringify({ trust: 'untrusted', proposal_id: 1 }), 'accepted-digest');
    closeDatabase();
    openDatabase(dbPath);

    expect(isTrustedForAutoContext(metadataOf('accepted-digest'))).toBe(false);
  });
});
