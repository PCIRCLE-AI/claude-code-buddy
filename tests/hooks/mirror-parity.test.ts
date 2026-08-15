/**
 * F5 mirror-parity gates — the CI guard the P0 FTS bug proved was missing.
 *
 * `scripts/hooks/_shared.js` hand-mirrors part of `src/core` because hooks must
 * run the always-on capture path even when `dist/` is absent (plugin-marketplace
 * `--ignore-scripts`) or stale. The danger is DRIFT: when the mirror diverges
 * from core, real bugs ship silently. Two divergences matter most:
 *
 *   1. PATHS — if the mirror's DB-path / project-identity logic drifts from
 *      `src/core/paths.ts`, a hook resolves the WRONG database file or WRONG
 *      project and writes memory to the wrong place. Silent corruption.
 *
 *   2. FTS reindex — if the mirror's `captureEntity` FTS dance drifts from
 *      `src/storage/fts-index.ts`, hook-written memory stops being searchable.
 *      This is exactly the P0 (entity+obs written, FTS index skipped).
 *
 * `write-hook-invariants.test.ts` already checks captureEntity FTS-syncs in
 * isolation. THIS file is stronger: it pins the mirror to the CORE source of
 * truth, so a change to `paths.ts` / `fts-index.ts` that forgets the mirror
 * turns CI red. Verified non-vacuous: reintroducing the FTS omission in
 * captureEntity, or changing the mirror's path precedence, fails these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  memeshDir as coreMemeshDir,
  getDbPath as coreGetDbPath,
  getMemeshDirFromDbPath as coreGetMemeshDirFromDbPath,
  slugFromRemoteUrl as coreSlugFromRemoteUrl,
  getProjectName as coreGetProjectName,
} from '../../src/core/paths.js';
import { removeFromFts, insertFtsRow } from '../../src/storage/fts-index.js';

const require = createRequire(import.meta.url);
// _shared.js is plain JS (hooks cannot import compiled TS) — require it raw.
const shared = require('../../scripts/hooks/_shared.js');

describe('F5 mirror parity: scripts/hooks/_shared.js vs src/core', () => {
  const savedHome = process.env.HOME;
  const savedDbPath = process.env.MEMESH_DB_PATH;

  afterEach(() => {
    // Restore env the path helpers read at call time.
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDbPath === undefined) delete process.env.MEMESH_DB_PATH;
    else process.env.MEMESH_DB_PATH = savedDbPath;
  });

  describe('paths parity (wrong DB path / project = silent corruption)', () => {
    it('slugFromRemoteUrl matches core for every URL shape', () => {
      const urls = [
        'https://github.com/PCIRCLE-AI/memesh-llm-memory.git',
        'https://github.com/PCIRCLE-AI/memesh-llm-memory',
        'git@github.com:PCIRCLE-AI/memesh-llm-memory.git',
        'https://gitlab.com/group/subgroup/project.git',
        'ssh://git@example.com:2222/team/repo.git',
        'not-a-url',
        '',
      ];
      for (const url of urls) {
        expect(shared.slugFromRemoteUrl(url), `slug drift for ${JSON.stringify(url)}`)
          .toBe(coreSlugFromRemoteUrl(url));
      }
    });

    it('memeshDir matches core (MEMESH_DB_PATH unset, HOME redirected)', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-home-'));
      try {
        delete process.env.MEMESH_DB_PATH;
        process.env.HOME = tmpHome;
        expect(shared.memeshDir()).toBe(coreMemeshDir());
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it('getDbPath matches core with and without MEMESH_DB_PATH override', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-home-'));
      try {
        // (a) no override — derived from HOME.
        delete process.env.MEMESH_DB_PATH;
        process.env.HOME = tmpHome;
        expect(shared.getDbPath()).toBe(coreGetDbPath());

        // (b) explicit override wins identically on both sides.
        const override = path.join(tmpHome, 'custom', 'kg.db');
        process.env.MEMESH_DB_PATH = override;
        expect(shared.getDbPath()).toBe(coreGetDbPath());
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it('getMemeshDirFromDbPath matches core (override set and unset)', () => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-home-'));
      try {
        process.env.HOME = tmpHome;
        const override = path.join(tmpHome, 'nested', 'kg.db');
        process.env.MEMESH_DB_PATH = override;
        expect(shared.getMemeshDirFromDbPath()).toBe(coreGetMemeshDirFromDbPath());

        delete process.env.MEMESH_DB_PATH;
        expect(shared.getMemeshDirFromDbPath()).toBe(coreGetMemeshDirFromDbPath());
      } finally {
        fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    it('getProjectName matches core for the same working directory', () => {
      // Both read git identity for the same cwd; they must agree. This repo is
      // a git checkout, so the real remote/dir-name path is exercised.
      const cwd = process.cwd();
      expect(shared.getProjectName(cwd)).toBe(coreGetProjectName(cwd));
    });
  });

  describe('FTS reindex parity (the P0 class): captureEntity vs core fts-index', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-parity-fts-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    /** Open a fresh hook DB (creates entities/observations/tags/entities_fts). */
    function openDb(file: string) {
      const handle = shared.openHookDb({ ...process.env, MEMESH_DB_PATH: file }, { fts: true });
      expect(handle).not.toBeNull();
      return handle.db;
    }

    /** rowids that MATCH a token in entities_fts, sorted for comparison. */
    function ftsMatch(db: any, token: string): number[] {
      return (db.prepare("SELECT rowid FROM entities_fts WHERE entities_fts MATCH ?").all(token) as Array<{ rowid: number }>)
        .map((r) => r.rowid)
        .sort((a, b) => a - b);
    }

    /** Reference write via the CORE primitive (what captureEntity must equal). */
    function coreWrite(db: any, name: string, type: string, observations: string[]): number {
      db.prepare('INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)').run(name, type);
      const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(name) as { id: number }).id;
      const insertObs = db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)');
      for (const o of observations) insertObs.run(id, o);
      insertFtsRow(db, id, name, observations.join(' '));
      return id;
    }

    it('new-entity FTS state is identical to the core insertFtsRow path', () => {
      const observations = ['the quick brown zebra', 'jumped the fence at dawn'];

      const hookDb = openDb(path.join(tmpDir, 'hook.db'));
      const coreDb = openDb(path.join(tmpDir, 'core.db'));
      try {
        const hookRes = shared.captureEntity(hookDb, { name: 'e1', type: 'note', observations });
        const coreId = coreWrite(coreDb, 'e1', 'note', observations);

        for (const token of ['zebra', 'fence', 'dawn', 'brown']) {
          expect(ftsMatch(hookDb, token), `token ${token} drift`).toEqual(ftsMatch(coreDb, token));
        }
        // Both index the same single rowid.
        expect(ftsMatch(hookDb, 'zebra')).toEqual([hookRes.id]);
        expect(ftsMatch(coreDb, 'zebra')).toEqual([coreId]);
      } finally {
        hookDb.close();
        coreDb.close();
      }
    });

    it('re-index (existing entity) FTS state matches core remove+insert', () => {
      const first = ['alpha bravo charlie'];
      const second = ['delta echo foxtrot'];

      const hookDb = openDb(path.join(tmpDir, 'hook.db'));
      const coreDb = openDb(path.join(tmpDir, 'core.db'));
      try {
        // First write.
        shared.captureEntity(hookDb, { name: 'e1', type: 'note', observations: first });
        const coreId = coreWrite(coreDb, 'e1', 'note', first);

        // Second write to the SAME entity — captureEntity does delete-then-insert.
        shared.captureEntity(hookDb, { name: 'e1', type: 'note', observations: second });
        // Core reference: remove stale FTS, add the new observation, reindex full set.
        removeFromFts(coreDb, coreId, 'e1', first.join(' '));
        coreDb.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(coreId, second[0]);
        insertFtsRow(coreDb, coreId, 'e1', [...first, ...second].join(' '));

        // Old and new tokens must resolve identically on both sides — and the
        // stale index must NOT double-count (the reindex delete worked).
        for (const token of ['alpha', 'charlie', 'delta', 'foxtrot']) {
          expect(ftsMatch(hookDb, token), `token ${token} drift`).toEqual(ftsMatch(coreDb, token));
        }
      } finally {
        hookDb.close();
        coreDb.close();
      }
    });

    it('title fold parity: both sides index and un-index the title identically', () => {
      // UX-1 folds the title into the FTS feed. Contentless FTS5 makes the
      // fold a two-sided contract: the delete must be issued with the exact
      // folded text that was inserted. If the hook mirror folds on insert but
      // not on delete (or vice versa), a re-title leaves stale tokens behind
      // on one side only — precisely the drift class this file exists for.
      const observations = ['plain observation text'];

      const hookDb = openDb(path.join(tmpDir, 'hook.db'));
      const coreDb = openDb(path.join(tmpDir, 'core.db'));
      try {
        const hookRes = shared.captureEntity(hookDb, {
          name: 'e1', type: 'note', observations, title: 'walrus label one',
        });
        // Core reference: same write via the core primitives.
        coreDb.prepare('INSERT INTO entities (name, type, title) VALUES (?, ?, ?)').run('e1', 'note', 'walrus label one');
        const coreId = (coreDb.prepare("SELECT id FROM entities WHERE name = 'e1'").get() as { id: number }).id;
        coreDb.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(coreId, observations[0]);
        insertFtsRow(coreDb, coreId, 'e1', observations.join(' '), 'walrus label one');

        expect(ftsMatch(hookDb, 'walrus')).toEqual([hookRes.id]);
        expect(ftsMatch(coreDb, 'walrus')).toEqual([coreId]);
        // Anti-vacuity pin: the emptiness assertion after the re-title below
        // only means something because the token demonstrably WAS indexed.
        expect(ftsMatch(hookDb, 'walrus').length).toBe(1);

        // Re-title on both sides; the OLD title's tokens must vanish on both.
        shared.captureEntity(hookDb, {
          name: 'e1', type: 'note', observations: [], title: 'penguin label two',
        });
        removeFromFts(coreDb, coreId, 'e1', observations.join(' '), 'walrus label one');
        coreDb.prepare('UPDATE entities SET title = ? WHERE id = ?').run('penguin label two', coreId);
        insertFtsRow(coreDb, coreId, 'e1', observations.join(' '), 'penguin label two');

        for (const token of ['walrus', 'penguin', 'plain']) {
          expect(ftsMatch(hookDb, token), `token ${token} drift`).toEqual(ftsMatch(coreDb, token));
        }
        expect(ftsMatch(hookDb, 'walrus')).toEqual([]);
      } finally {
        hookDb.close();
        coreDb.close();
      }
    });
  });

  describe('query-side parity', () => {
    /**
     * The comments in _shared.js claimed the segmentation version and the hook
     * match builder were "pinned by tests/hooks/mirror-parity.test.ts". They
     * were not — this file never mentioned them, and the two implementations
     * had already drifted: the hook copy omitted the lone-unspaced-character
     * prefix branch, so a single CJK character in a filename was emitted as an
     * exact token and matched nothing against a bigram index.
     *
     * A claimed gate that does not exist is worse than no gate, so these are
     * the assertions the comment was describing.
     */
    it('the hook knows the same segmentation version core writes', async () => {
      const core = await import('../../src/db.js');
      expect(shared.FTS_SEGMENTATION_VERSION).toBe(core.FTS_SEGMENTATION_VERSION);
    });

    it('the hook builds the same MATCH expression core does', async () => {
      const fts = await import('../../src/storage/fts-index.js');

      // Every shape that has bitten: ASCII, an unbroken CJK run, a LONE CJK
      // character (the drift), mixed script, and an empty result.
      for (const query of ['SkillOpt codex', '資料庫遷移', 'v2-图-final', '用 Preact 做儀表板', '???']) {
        const coreTerms = fts.tokenizeQuery(query).slice(0, 32);
        const expected = fts.renderMatchExpression(coreTerms);
        expect(shared.hookMatchExpression(query)).toBe(expected);
      }
    });

    it('a lone CJK character becomes a prefix query on the hook side too', async () => {
      // Named separately because this is the case that was broken, and an
      // equality test against core would silently start passing if BOTH sides
      // regressed together.
      expect(shared.hookMatchExpression('v2-图-final')).toContain('"图"*');
    });
  });

});
