/**
 * Doctor's stale-keyword-index check, against a real database.
 *
 * The state it detects is reachable in normal use and silent by construction.
 * `ensureFtsSegmentation` advances a version marker and only ever moves it
 * FORWARD, so a database migrated by a segmentation-aware build and then
 * written to by an older one ends up holding whole-run tokens that no segmented
 * query can match. The old build does not know the marker exists, leaves it
 * alone, and re-upgrading short-circuits — those memories stay unreachable by
 * any partial-phrase query, permanently, with `entities` intact and every
 * health signal green. Users reach it by having an npm-global and a
 * plugin-marketplace install side by side, or by downgrading after a bad
 * release. Two comments in `db.ts` claimed doctor reported this; nothing did.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `tests/core/doctor.test.ts`:
 *
 * The first version of these tests used that file's `makeDatabase` stub, which
 * dispatches on `sql.includes('fts_vocab')` and returns a canned row. Mutating
 * `length(term) > 2` to `length(term) > 200`, and replacing the
 * `sqlite_master` guard with `if (true)`, BOTH left all 45 tests green — a stub
 * never executes the statement, so it cannot test a predicate. The predicate is
 * the fix. These run the real query against a real FTS5 index instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase, closeDatabase } from '../src/db.js';
import { KnowledgeGraph } from '../src/knowledge-graph.js';
import { runDoctor } from '../src/core/doctor.js';
import { UNSPACED_SCRIPT_GLOB_PREFIX } from '../src/storage/fts-index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The check, lifted verbatim from `runDoctor`.
 *
 * `runDoctor` needs a package root, an install channel, a config path and a
 * dozen other probes to reach this line; none of them bear on whether the
 * statement finds an unsegmented term. `tests/core/doctor.test.ts` already pins
 * that the row is emitted with the offending term in its message and the
 * `reindex --fts` fix — what is unpinned, and what mutation testing showed
 * unpinned, is the SQL. Kept byte-identical to `src/core/doctor.ts`; the
 * `pins the exact statement` case below fails if the two drift.
 */
const SEGMENTATION_SQL = `SELECT term FROM fts_vocab
            WHERE length(term) > 2
              AND term GLOB ?
            LIMIT 1`;

describe('Feature: doctor detects a stale (unsegmented) keyword index', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ftsseg-'));
    dbPath = path.join(dir, 'test.db');
    try { closeDatabase(); } catch { /* none open */ }
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function probe(): { term?: string } | undefined {
    const db = openDatabase(dbPath);
    // The pattern comes from the same export doctor binds, so the ranges cannot
    // drift between the check and the test that claims to cover it — which is
    // the whole reason it is an export and not a literal in either place.
    return db.prepare(SEGMENTATION_SQL).get(UNSPACED_SCRIPT_GLOB_PREFIX) as
      | { term?: string }
      | undefined;
  }

  it('finds the whole-run token an older build leaves behind', () => {
    const db = openDatabase(dbPath);
    new KnowledgeGraph(db).createEntity('normal-entity', 'note', { observations: [] });
    const id = (db.prepare(`SELECT id FROM entities WHERE name = 'normal-entity'`).get() as { id: number }).id;

    // What a pre-segmentation binary writes: the raw run, straight into the
    // contentless index, with the marker untouched.
    db.prepare(`INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, '')`)
      .run(id, '資料庫遷移前一定要先備份');

    expect(probe()?.term).toBe('資料庫遷移前一定要先備份');
  });

  it('stays silent on an index the current build wrote', () => {
    // The half that gives the warning meaning. Bigrams are two characters, so
    // `length(term) > 2` is the entire discrimination between "damaged" and
    // "healthy" — widen it and the check reports nothing forever; narrow it to
    // `> 1` and it fires on every correctly-segmented Chinese database there is.
    const kg = new KnowledgeGraph(openDatabase(dbPath));
    kg.createEntity('備份紀律', 'note', { observations: ['資料庫遷移前一定要先備份'] });

    const terms = (openDatabase(dbPath).prepare('SELECT term FROM fts_vocab').all() as { term: string }[])
      .map((r) => r.term);
    // Confirms the fixture is what the test claims: real bigrams, not one run.
    expect(terms).toContain('資料');
    expect(terms).toContain('備份');
    expect(terms.every((t) => [...t].length <= 2)).toBe(true);

    expect(probe()).toBeUndefined();
    // ...and the memory is genuinely reachable by a fragment, which is the
    // user-visible property the whole check is a proxy for.
    expect(kg.search('備份').map((e) => e.name)).toContain('備份紀律');
  });

  it('detects an unsegmented run in EVERY spaceless script, not just CJK', () => {
    // The reason the range set is a shared export. The first version of this
    // check hard-coded `char(13312)`–`char(40959)` — CJK only — which was the
    // whole class at the time. The class then grew to ten ranges, and a
    // hand-written copy here would have gone on reporting a healthy index over
    // a database full of unsegmented Thai: the exact "reports success without
    // checking" shape this release is about, reintroduced by the fix for it.
    const db = openDatabase(dbPath);
    const kg = new KnowledgeGraph(db);
    const samples = [
      ['thai', 'สำรองข้อมูลก่อนย้ายฐานข้อมูล'],
      ['lao', 'ສຳຮອງຂໍ້ມູນກ່ອນຍ້າຍຖານຂໍ້ມູນ'],
      ['halfwidth', 'ﾃﾞｰﾀﾍﾞｰｽｲｺｳﾏｴﾆﾊﾞｯｸｱｯﾌﾟ'],
      ['extb', '\u{20BB7}\u{20089}\u{210C1}\u{20BB7}\u{20089}'],
    ];
    for (const [label, text] of samples) {
      const id = kg.createEntity(`row-${label}`, 'note', { observations: [] });
      // As an older build would have written it: the run, whole.
      db.prepare(`INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, '')`)
        .run(id, text);
      const term = probe()?.term;
      // Not `toBe(text)`. `unicode61` splits Thai, Lao and Khmer at their
      // combining marks, so what lands in the index is a long FRAGMENT of the
      // run rather than the whole of it — still far longer than a bigram, which
      // is what makes it detectable and what makes the memory unfindable.
      expect(term, `${label} run went undetected`).toBeDefined();
      expect([...term!].length, `${label} term is not longer than a bigram`).toBeGreaterThan(2);
      expect(text, `${label} term is not from the stored text`).toContain(term!);
      db.exec("INSERT INTO entities_fts (entities_fts) VALUES('delete-all')");
    }
  });

  it('does not fire on Latin text, however long the word', () => {
    // The GLOB range is what keeps this check off the 99% of databases that
    // hold no CJK at all. Drop the range and every English word over two
    // letters reports a corrupt index.
    new KnowledgeGraph(openDatabase(dbPath)).createEntity('antidisestablishmentarianism', 'note', {
      observations: ['supercalifragilisticexpialidocious'],
    });

    expect(probe()).toBeUndefined();
  });

  it('pins the exact statement doctor runs', () => {
    // These cases test a copy. If `doctor.ts` edits its query and this file
    // does not, they go on passing while the shipped check does whatever it now
    // does — the copy would be pinning nothing, which is the failure mode this
    // whole file was written to correct.
    // `fileURLToPath`, not `new URL(...).pathname`. On Windows the latter
    // returns a leading-slash drive path ("/D:/..."), which `path.join` then
    // concatenates with the cwd drive into "D:\D:\..." — this test failed on
    // both Windows legs with exactly that. The trap is already written down in
    // `scripts/check-version-coherence.mjs`; `tests/release-scripts-safety.test.ts`
    // now forbids the form outright so reading the note is not the only defence.
    const doctorSrc = fs.readFileSync(
      path.join(repoRoot, 'src', 'core', 'doctor.ts'),
      'utf8',
    );
    expect(doctorSrc).toContain(SEGMENTATION_SQL);
    // The guard that lets an older schema through without throwing.
    expect(doctorSrc).toMatch(
      /sqlite_master WHERE type = 'table' AND name = 'fts_vocab'/,
    );
  });

  it('reports the database as healthy when fts_vocab does not exist', async () => {
    // Schemas older than the view have no `fts_vocab`. Absent is not clean, but
    // it is not damage either — and it must not throw, because the check runs
    // inside the block that owns doctor's "Database" verdict, so an exception
    // would report a perfectly good database as broken. This is the case the
    // `sqlite_master` guard exists for, and the one a blanket `try/catch` would
    // have hidden along with every real fault.
    //
    // Driven through `runDoctor` with the REAL database rather than by
    // asserting the statement directly. An earlier version did the latter and
    // mutating the guard to `if (true)` survived it: proving the raw SQL throws
    // says nothing about whether doctor still asks it.
    const db = openDatabase(dbPath);
    new KnowledgeGraph(db).createEntity('a-memory', 'note', { observations: ['hello'] });
    db.exec('DROP TABLE fts_vocab');
    expect(() => db.prepare(SEGMENTATION_SQL).get(UNSPACED_SCRIPT_GLOB_PREFIX)).toThrow(/no such table/);

    const result = await runDoctor({
      packageRoot: dir,
      packageVersion: '4.2.11',
      openDatabaseImpl: () => db as never,
      closeDatabaseImpl: () => undefined,
      embedTextImpl: async () => new Float32Array(384),
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }) as never,
      getConfigPathImpl: () => path.join(dir, 'config.json'),
      getUpdateCheckImpl: async () => ({}) as never,
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global',
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: '',
      }),
    });

    // The whole point: a schema too old for the view still reports a working
    // database, and no segmentation row is invented for it.
    expect(result.checks.filter((c: { id: string }) => c.id === 'database').map((c: { status: string }) => c.status))
      .toEqual(['pass']);
    expect(result.checks.find((c: { id: string }) => c.id === 'fts_segmentation')).toBeUndefined();
  });

  it('emits exactly one database row when the block throws', async () => {
    // Found by mutating the `sqlite_master` guard to `if (true)`: with the
    // guard gone the segmentation query throws on a schema that has no
    // `fts_vocab`, and every assertion still passed. The reason was not that
    // doctor coped — it was that the `pass` row had ALREADY been pushed, the
    // catch appended a SECOND row with the same `database` id and status
    // `fail`, and `.find()` returned the passing one. A caller reading the row
    // saw a healthy database while the overall verdict said FAIL.
    //
    // So this asserts the count, not the status. `toBe('pass')` cannot tell a
    // healthy database from a contradictory pair.
    const db = openDatabase(dbPath);
    const exploding = {
      prepare(sql: string) {
        if (sql.includes('COUNT(*)')) return { get: () => ({ c: 1 }) };
        throw new Error('database disk image is malformed');
      },
    };

    const result = await runDoctor({
      packageRoot: dir,
      packageVersion: '4.2.11',
      openDatabaseImpl: () => exploding as never,
      closeDatabaseImpl: () => undefined,
      embedTextImpl: async () => new Float32Array(384),
      detectCapabilitiesImpl: () => ({ searchLevel: 0, llm: null, embeddings: 'disabled' }) as never,
      getConfigPathImpl: () => path.join(dir, 'config.json'),
      getUpdateCheckImpl: async () => ({}) as never,
      getCurrentInstallChannelImpl: () => 'npm-global',
      getInstallChannelSupportImpl: () => ({
        channel: 'npm-global',
        label: 'npm global',
        canSelfUpdate: true,
        recommendedCommand: 'memesh update',
        guidance: '',
      }),
    });
    db.close();

    const rows = result.checks.filter((c: { id: string }) => c.id === 'database');
    expect(rows.map((c: { status: string }) => c.status)).toEqual(['fail']);
    expect(result.status).toBe('FAIL');
  });
});
