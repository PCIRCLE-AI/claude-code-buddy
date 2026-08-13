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

  it('a read-only database FILE still opens and reads — opening must not write when there is nothing to write', () => {
    // The regression this pins: two DML statements (the hook_runs_since
    // INSERT OR IGNORE, and a tags-dedup DELETE that predates this PR) lived
    // inside the SCHEMA_SQL block every open executes. Even as no-ops they
    // took the WAL writer lock, so a chmod-444 file — a backup, a snapshot,
    // a permissions accident — failed to open at all ("attempt to write a
    // readonly database"). Both now run behind SELECT-first guards: a
    // database that already has the marker and the index gets pure reads.
    if (process.platform === 'win32') return; // chmod read-only semantics differ

    const first = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
    expect(first).not.toBeNull();
    shared.captureEntity(first.db, { name: 'ro-entity', type: 'note', observations: ['kept'], tags: [] });
    first.db.close();

    fs.chmodSync(dbPath, 0o444);
    try {
      const reopened = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: dbPath }, { fts: true });
      expect(reopened, 'a read-only database file must still open for reading').not.toBeNull();
      try {
        const row = reopened.db.prepare("SELECT id FROM entities WHERE name = 'ro-entity'").get();
        expect(row, 'the reopened read-only database must be readable').toBeDefined();
      } finally {
        reopened.db.close();
      }
    } finally {
      fs.chmodSync(dbPath, 0o644);
    }
  });

  it('recordHookRun stamps and upserts; openHookDb alone never stamps', () => {
    // `hook_runs` is the only evidence that a hook EXECUTED rather than merely
    // captured something, and doctor now reports a FAIL when it goes stale.
    // That makes the write itself load-bearing: if this stops happening,
    // doctor starts accusing a perfectly healthy install of having dead hooks.
    //
    // openHookDb must NOT stamp: it used to, and that certified the wrong
    // thing — a hook that opened the database and then died in its own
    // capture logic looked alive for a day. The stamp belongs to the hook's
    // successful exit (pinned end-to-end in pre-compact.test.ts).
    // Opened WITH a smuggled `hook:` option on purpose: the first draft of
    // this file guarded against the option's return with a source grep
    // (`/openHookDb\([^)]*hook:/`), which any indirection — a spread, an
    // options variable — walks straight past. The behavioural claim is the
    // one that matters: whatever a caller passes, opening must never stamp.
    const opened = shared.openHookDb(
      { ...process.env, MEMESH_DB_PATH: dbPath },
      { fts: true, hook: 'session-summary' },
    );
    try {
      const rows = opened.db.prepare('SELECT hook FROM hook_runs').all();
      expect(rows, 'openHookDb stamped a heartbeat — that lie is what this PR removes').toHaveLength(0);

      shared.recordHookRun(opened.db, 'session-summary');
      const row = opened.db.prepare("SELECT hook, run_count FROM hook_runs WHERE hook = 'session-summary'").get();
      expect(row, 'recordHookRun did not record that the hook ran').toBeDefined();
      expect(row.run_count).toBe(1);

      // Second run of the same hook increments rather than duplicating — the
      // table is keyed by hook name and must not grow with usage.
      shared.recordHookRun(opened.db, 'session-summary');
      const again = opened.db.prepare("SELECT run_count FROM hook_runs WHERE hook = 'session-summary'").all();
      expect(again).toHaveLength(1);
      expect(again[0].run_count).toBe(2);
    } finally { opened.db.close(); }
  });

  it('every capture hook stamps its own completion, and none stamps at open', () => {
    // The stamp is per call site, so a new capture hook that forgets it is
    // invisible: capture works, and doctor slowly decides the loop is dead.
    // The inverse matters just as much: a `hook:` option handed back to
    // openHookDb would quietly move the stamp to before capture again.
    for (const hook of ['session-summary.js', 'post-commit.js', 'pre-compact.js']) {
      const src = fs.readFileSync(path.join('scripts/hooks', hook), 'utf8');
      const name = hook.replace(/\.js$/, '');
      expect(
        src,
        `${hook} must call recordHookRun(db, '${name}') at its successful exit, or doctor cannot tell it ever ran`,
      ).toContain(`recordHookRun(db, '${name}')`);
      expect(
        src,
        `${hook} passes hook: to openHookDb — the open-time stamp reported crashed hooks as alive`,
      ).not.toMatch(/openHookDb\([^)]*hook:/);
    }
  });
});
