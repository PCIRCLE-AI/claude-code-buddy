import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase, getDatabase, FTS_SEGMENTATION_VERSION } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { segmentUnspacedScripts } from '../src/storage/fts-index.js';
import { useTestDatabase } from './helpers/db-fixture.js';

/**
 * Recall for scripts that do not put spaces between words.
 *
 * FTS5's `unicode61` tokenizer treats every CJK character as a letter, so an
 * unbroken run indexed as ONE token: a memory holding 「資料庫遷移前一定要先備份」
 * was reachable only by searching that exact string. Measured on a mixed
 * corpus, Chinese recall was 2/9 — for a Chinese-writing user, keyword recall
 * was effectively broken while English worked perfectly, so nothing looked
 * wrong.
 *
 * `segmentUnspacedScripts()` splits those runs into overlapping character
 * bigrams, on the index side (`insertFtsRow`) and the query side
 * (`buildMatchExpression`). The invariant these cases exist to protect is that
 * **both sides use the same function**: segment one side only and every query
 * produces tokens the index does not contain.
 */
describe('Feature: CJK recall', () => {
  useTestDatabase('memesh-cjk-');

  let kg: KnowledgeGraph;

  beforeEach(() => {
    kg = new KnowledgeGraph(getDatabase());
  });

  describe('segmentUnspacedScripts', () => {
    it('splits an unbroken run into overlapping bigrams', () => {
      expect(segmentUnspacedScripts('資料庫遷移').trim()).toBe('資料 料庫 庫遷 遷移');
    });

    it('leaves Latin text byte-for-byte alone', () => {
      const latin = 'Postgres over MySQL for the analytics service (2026-07): 95.60% R@5!';
      expect(segmentUnspacedScripts(latin)).toBe(latin);
    });

    it('only touches the CJK runs inside mixed text', () => {
      // Two runs here, not one: 「用」 alone, then 「做儀表板」 — the Latin word
      // between them is a boundary, so each run is segmented on its own.
      expect(segmentUnspacedScripts('用 Preact 做儀表板').trim()).toBe('用 Preact  做儀 儀表 表板');
    });

    it('leaves a lone character as itself', () => {
      expect(segmentUnspacedScripts('金')).toBe('金');
    });
  });

  describe('retrieval', () => {
    beforeEach(() => {
      kg.createEntity('zh-migration', 'note', {
        observations: ['資料庫遷移前一定要先備份，上次沒備份直接跑 alembic upgrade 掉了兩小時訂單'],
      });
      kg.createEntity('zh-frontend', 'note', {
        observations: ['儀表板用 Preact 而不是 React，為了讓單檔 bundle 保持小'],
      });
      kg.createEntity('ja-backup', 'note', {
        observations: ['データベース移行の前に必ずバックアップを取ること'],
      });
      kg.createEntity('ko-backup', 'note', {
        observations: ['데이터베이스 마이그레이션 전에 반드시 백업할 것'],
      });
      kg.createEntity('en-storage', 'note', {
        observations: ['Postgres over MySQL for the analytics service, we need window functions'],
      });
    });

    it('finds a Chinese memory from part of the phrase', () => {
      expect(kg.search('資料庫遷移').map((e) => e.name)).toContain('zh-migration');
      expect(kg.search('備份').map((e) => e.name)).toContain('zh-migration');
    });

    it('answers a Chinese question phrased in the user’s own words', () => {
      expect(kg.search('儀表板前端用什麼框架').map((e) => e.name)).toContain('zh-frontend');
    });

    it('works for Japanese and Korean too', () => {
      expect(kg.search('バックアップ').map((e) => e.name)).toContain('ja-backup');
      expect(kg.search('백업').map((e) => e.name)).toContain('ko-backup');
    });

    it('still matches Latin words embedded in a CJK memory', () => {
      expect(kg.search('Preact').map((e) => e.name)).toContain('zh-frontend');
    });

    it('does not make everything match everything', () => {
      const names = kg.search('資料庫遷移').map((e) => e.name);
      expect(names).not.toContain('en-storage');
      expect(names).not.toContain('zh-frontend');
    });

    it('leaves English retrieval unchanged', () => {
      expect(kg.search('Why did we choose Postgres for analytics?').map((e) => e.name)).toContain(
        'en-storage'
      );
    });

    it('reaches a lone CJK character by prefix, with its known bound', () => {
      kg.createEntity('zh-lead', 'note', { observations: ['資訊系統重構'] });
      kg.createEntity('zh-mid', 'note', { observations: ['公司融資完成'] });
      kg.createEntity('zh-final', 'note', { observations: ['本月營收'] });

      // A prefix query reaches any bigram that STARTS with the character —
      // 資訊 in one, 資完 in the other — so a mid-run character is fine.
      const hits = kg.search('資').map((e) => e.name);
      expect(hits).toContain('zh-lead');
      expect(hits).toContain('zh-mid');

      // The bound is the LAST character of a run: 「收」 only ever appears as
      // the second half of 營收, and the index holds no unigrams. Documented
      // rather than chased — fixing it means indexing every character too, for
      // a rare query shape.
      expect(kg.search('收').map((e) => e.name)).not.toContain('zh-final');
    });

    it('round-trips text that arrives decomposed, in both directions', () => {
      // 한글 and Vietnamese have two byte-level spellings that look identical:
      // composed (NFC) and decomposed (NFD). macOS filesystem APIs, Finder
      // copy and several Korean IMEs emit NFD, and the hooks capture file
      // paths, so both reach the index as ordinary input.
      //
      // The index side and the query side must agree on WHICH spelling they
      // store and search, or the two never meet. This is the same pairing
      // invariant as segmentation, one layer down.
      kg.createEntity('ko-nfd', 'note', {
        observations: ['데이터베이스 백업 정책'.normalize('NFD')],
      });
      kg.createEntity('vi-nfd', 'note', {
        observations: ['sao lưu dữ liệu trước khi chuyển đổi'.normalize('NFD')],
      });

      // Stored decomposed, asked composed.
      expect(kg.search('데이터베이스'.normalize('NFC')).map((e) => e.name)).toContain('ko-nfd');
      expect(kg.search('dữ liệu'.normalize('NFC')).map((e) => e.name)).toContain('vi-nfd');

      // Stored composed, asked decomposed — 'ko-backup' above is composed.
      expect(kg.search('데이터베이스'.normalize('NFD')).map((e) => e.name)).toContain('ko-backup');
    });

    it('keeps deletes working — the index side and delete side must agree', () => {
      // Contentless FTS5 finds the row to delete by the values that were
      // INDEXED. If insertFtsRow segmented but removeFromFts did not, archiving
      // would leave a ghost row that keeps answering queries.
      kg.createEntity('zh-temp', 'note', { observations: ['臨時筆記可以刪掉'] });
      expect(kg.search('臨時筆記').map((e) => e.name)).toContain('zh-temp');

      kg.archiveEntity('zh-temp');
      expect(kg.search('臨時筆記').map((e) => e.name)).not.toContain('zh-temp');
    });
  });

  describe('migration of an existing database', () => {
    it('rebuilds an index written before segmentation existed', () => {
      // Simulate the pre-segmentation state: FTS rows holding whole runs, and
      // no `fts_segmentation_version` marker. Without the rebuild, every
      // segmented query would produce tokens this index does not contain, so
      // Chinese recall would go from bad to zero on upgrade.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cjk-migrate-'));
      const dbPath = path.join(dir, 'legacy.db');
      try {
        // openDatabase() returns the process-wide handle if one is already
        // open, so the fixture's database has to be closed first or this test
        // silently exercises the wrong file.
        closeDatabase();
        const legacy = openDatabase(dbPath);
        const id = new KnowledgeGraph(legacy).createEntity('legacy-note', 'note', {
          observations: ['資料庫遷移前一定要先備份'],
        });

        // Roll the index back to the old, unsegmented form.
        legacy.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
        legacy
          .prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)')
          .run(id, 'legacy-note', '資料庫遷移前一定要先備份');
        legacy.prepare("DELETE FROM memesh_metadata WHERE key = 'fts_segmentation_version'").run();
        closeDatabase();

        // Reopening must notice the missing marker and rebuild.
        openDatabase(dbPath);
        const kg2 = new KnowledgeGraph(getDatabase());
        expect(kg2.search('資料庫遷移').map((e) => e.name)).toContain('legacy-note');
        // Compared against the constant, not a literal. A hardcoded '1' here
        // turned every future bump of the segmentation rules into a spurious
        // test failure, which trains people to edit the expectation rather
        // than ask whether the migration still works.
        expect(
          getDatabase()
            .prepare("SELECT value FROM memesh_metadata WHERE key = 'fts_segmentation_version'")
            .get()
        ).toEqual({ value: String(FTS_SEGMENTATION_VERSION) });
      } finally {
        try {
          closeDatabase();
        } catch {
          /* already closed */
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves a database that is already at the current version alone', () => {
      // The rebuild is a delete-all over the whole index. It has to be a
      // once-per-database event: if the version check stops working, every
      // openDatabase() call — and every hook fires one — pays a full reindex.
      //
      // The observable consequence of a rebuild is that hand-written index
      // state is overwritten, so writing a row the rebuild would not produce
      // and checking it survives is what distinguishes "skipped" from "ran".
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cjk-idem-'));
      const dbPath = path.join(dir, 'current.db');
      try {
        closeDatabase();
        const db = openDatabase(dbPath);
        const id = new KnowledgeGraph(db).createEntity('sentinel', 'note', {
          observations: ['資料庫遷移前一定要先備份'],
        });

        // Replace the segmented row with an unsegmented one, but leave the
        // marker at the current version. A correct guard does not touch it.
        db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
        db.prepare('INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)').run(
          id,
          'sentinel',
          '資料庫遷移前一定要先備份'
        );
        closeDatabase();

        openDatabase(dbPath);
        const kg2 = new KnowledgeGraph(getDatabase());
        // Still unsegmented, so a partial-phrase query cannot reach it. If the
        // rebuild ran anyway, it was repaired and this finds the row.
        expect(kg2.search('資料庫遷移').map((e) => e.name)).not.toContain('sentinel');
      } finally {
        try {
          closeDatabase();
        } catch {
          /* already closed */
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
