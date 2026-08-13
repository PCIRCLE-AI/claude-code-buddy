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
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  it('captureEntity stamps source_host=claude-code on a NEW entity', () => {
    // Hooks only ever run under Claude Code, so hook capture IS claude-code
    // capture. The stamp is what lets a federated reader (phase 03) say which
    // host a memory came from.
    const handle = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
    const { db } = handle;
    try {
      const res = shared.captureEntity(db, { name: 'prov-new', type: 'note', observations: ['x'] });
      const row = db.prepare('SELECT metadata FROM entities WHERE id = ?').get(res.id) as { metadata: string };
      expect(JSON.parse(row.metadata).provenance.source_host).toBe('claude-code');
    } finally {
      db.close();
    }
  });

  it('captureEntity does NOT overwrite metadata another writer already recorded', () => {
    // OR IGNORE re-capture of an existing entity must leave provenance alone —
    // an entity first written via MCP from another host keeps that host.
    const handle = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
    const { db } = handle;
    try {
      db.prepare('INSERT INTO entities (name, type, metadata) VALUES (?, ?, ?)')
        .run('prov-existing', 'note', JSON.stringify({ provenance: { source_host: 'codex' } }));
      shared.captureEntity(db, { name: 'prov-existing', type: 'note', observations: ['y'] });
      const row = db.prepare('SELECT metadata FROM entities WHERE name = ?').get('prov-existing') as { metadata: string };
      expect(JSON.parse(row.metadata).provenance.source_host).toBe('codex');
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

  it('openHookDb stamps the heartbeat when given a hook name, and not otherwise', () => {
    // `hook_runs` is the only evidence that a hook EXECUTED rather than merely
    // captured something, and doctor now reports a FAIL when it goes stale.
    // That makes the write itself load-bearing: if this stops happening,
    // doctor starts accusing a perfectly healthy install of having dead hooks.
    const stamped = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { hook: 'session-summary' });
    try {
      const row = stamped.db.prepare("SELECT hook, run_count FROM hook_runs WHERE hook = 'session-summary'").get();
      expect(row, 'openHookDb did not record that the hook ran').toBeDefined();
      expect(row.run_count).toBe(1);
    } finally { stamped.db.close(); }

    // Second run of the same hook increments rather than duplicating — the
    // table is keyed by hook name and must not grow with usage.
    const again = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { hook: 'session-summary' });
    try {
      const rows = again.db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").all();
      expect(rows).toHaveLength(1);
      expect(rows[0].run_count).toBe(2);
    } finally { again.db.close(); }

    // A caller with no hook name is an internal helper, not a hook firing.
    // session-summary calls openHookDb() a second time to count entities; if
    // that stamped the heartbeat too, the count would stop meaning "sessions".
    const anonymous = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath });
    try {
      const row = anonymous.db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").get();
      expect(row.run_count, 'an internal openHookDb() call was counted as a hook run').toBe(2);
    } finally { anonymous.db.close(); }
  });

  it('every capture hook passes its own name to openHookDb', () => {
    // The stamp is opt-in per call site, so a new capture hook that forgets it
    // is invisible: capture works, and doctor slowly decides the loop is dead.
    for (const hook of ['session-summary.js', 'post-commit.js', 'pre-compact.js']) {
      const src = fs.readFileSync(path.join('scripts/hooks', hook), 'utf8');
      const name = hook.replace(/\.js$/, '');
      expect(
        src,
        `${hook} must pass hook: '${name}' to openHookDb, or doctor cannot tell it ever ran`,
      ).toContain(`hook: '${name}'`);
    }
  });
});
