/**
 * Permanent CI gates for the "fake-working" write-path classes this audit
 * found — so they can't silently come back.
 *
 * The seed bug: session-summary.js wrote an entity but skipped the FTS reindex,
 * so the memory was stored yet unrecallable. The fix centralised the write dance
 * in _shared.js `captureEntity()`. These invariants lock BOTH halves of that
 * fix: (1) the shared helper really does keep FTS in sync, and (2) no write
 * hook hand-rolls its own entity write that could skip the FTS step again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
// _shared.js is plain JS with no type declarations.
const shared = require('../../scripts/hooks/_shared.js');

describe('write-hook invariants (fake-working gates)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-invariants-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captureEntity keeps entities_fts in sync, so hook-written memories are FTS-recallable', () => {
    const handle = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
    expect(handle).not.toBeNull();
    const { db } = handle;
    try {
      const res = shared.captureEntity(db, {
        name: 'invariant-entity-1',
        type: 'note',
        observations: ['the quick brown zebra jumped the fence'],
        tags: ['project:test'],
      });
      expect(res).not.toBeNull();

      // The distinctive observation token must be reachable through the FTS5
      // index — not just present in the observations table.
      const ftsRowids = (db.prepare(
        "SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'zebra'",
      ).all() as Array<{ rowid: number }>).map((r) => r.rowid);
      expect(ftsRowids).toContain(res.id);
    } finally {
      db.close();
    }
  });

  it('every write hook routes through captureEntity and hand-rolls no entity writes', () => {
    // These three hooks persist entities. If any of them writes rows directly
    // instead of via captureEntity, it can drop the FTS/observation steps the
    // helper guarantees — exactly the drift that made session memories
    // unrecallable. A new write hook must be added here too.
    const writeHooks = ['session-summary.js', 'post-commit.js', 'pre-compact.js'];
    for (const hook of writeHooks) {
      const src = fs.readFileSync(path.join('scripts/hooks', hook), 'utf8');
      expect(src, `${hook} must use the shared captureEntity() write helper`).toMatch(/captureEntity\(/);
      expect(
        src,
        `${hook} must not hand-roll "INSERT INTO observations" (bypasses captureEntity's FTS reindex)`,
      ).not.toMatch(/INSERT INTO observations/);
      expect(
        src,
        `${hook} must not hand-roll "INSERT INTO entities_fts" (that belongs in captureEntity)`,
      ).not.toMatch(/INSERT INTO entities_fts/);
    }
  });
});
