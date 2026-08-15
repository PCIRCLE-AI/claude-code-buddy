/**
 * The UX-1 title backfill, and the two ways it could silently do harm.
 *
 * The pass gives pre-title rows a heuristic display title. It is fill-only
 * (`WHERE title IS NULL`) and marker-guarded, borrowing both disciplines from
 * the signal-score backfill next to it — a row that already has a title must
 * come out untouched, and a row whose metadata cannot be parsed must be left
 * entirely alone.
 *
 * The part with real teeth is FTS. `insertFtsRow` folds the title into the
 * indexed text, and pre-title rows were indexed WITHOUT one — so every row
 * the pass titles must be reindexed, or the next contentless-FTS delete
 * (issued with the current title folded in) would not match what the index
 * holds and would silently corrupt it. And that reindex must skip archived
 * rows: they have no FTS entry at all (archiveEntity removed it), and a
 * contentless delete for text that was never indexed is the same corruption
 * from the other direction. Both directions are pinned here by observing the
 * index's behaviour, not the code's structure: search → found; archive-then-
 * search → gone, no ghost.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { insertFtsRow } from '../../src/storage/fts-index.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-title-backfill-'));
  dbPath = path.join(dir, 'test.db');
});
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Recreate the pre-title state faithfully: entity + observations rows, and —
 * for active rows — an FTS entry indexed WITHOUT a title, exactly as the
 * pre-UX-1 code left it. Raw SQL on purpose: createEntity() would stamp a
 * title-aware FTS entry and defeat the point.
 */
function seedPreTitleRow(opts: {
  name: string;
  type?: string;
  observations?: string[];
  metadata?: string | null;
  title?: string | null;
  archived?: boolean;
}): void {
  const db = openDatabase(dbPath);
  const status = opts.archived ? 'archived' : 'active';
  db.prepare('INSERT INTO entities (name, type, metadata, title, status) VALUES (?, ?, ?, ?, ?)')
    .run(opts.name, opts.type ?? 'note', opts.metadata ?? null, opts.title ?? null, status);
  const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get(opts.name) as { id: number }).id;
  const observations = opts.observations ?? [];
  for (const obs of observations) {
    db.prepare('INSERT INTO observations (entity_id, content) VALUES (?, ?)').run(id, obs);
  }
  if (!opts.archived) {
    insertFtsRow(db, id, opts.name, observations.join(' '));
  }
  closeDatabase();
}

function rowOf(name: string): { title: string | null; metadata: string | null } {
  const db = openDatabase(dbPath);
  const row = db.prepare('SELECT title, metadata FROM entities WHERE name = ?').get(name) as {
    title: string | null; metadata: string | null;
  };
  closeDatabase();
  return row;
}

/** Force the backfill to run again on the next open. */
function clearMarker(): void {
  const db = openDatabase(dbPath);
  db.prepare("DELETE FROM memesh_metadata WHERE key LIKE 'title_backfill%'").run();
  closeDatabase();
}

function runBackfill(): void {
  clearMarker();
  openDatabase(dbPath);
  closeDatabase();
}

describe('the title backfill fills gaps and nothing else', () => {
  it('titles an untitled row from its best observation and marks the source heuristic', () => {
    seedPreTitleRow({
      name: 'auth-note-9f3a',
      observations: ['Chose OAuth 2.0 with PKCE because implicit flow leaks tokens'],
      metadata: JSON.stringify({ pin: true }),
    });
    runBackfill();

    const row = rowOf('auth-note-9f3a');
    expect(row.title).toBe('Chose OAuth 2.0 with PKCE because implicit flow leaks tokens');
    const meta = JSON.parse(row.metadata as string);
    expect(meta.title_source, 'an unmarked auto-title becomes permanent — the LLM pass may never replace it').toBe('heuristic');
    expect(meta.pin, 'existing metadata keys must survive the stamp').toBe(true);
  });

  it('leaves an existing title exactly as it was', () => {
    seedPreTitleRow({
      name: 'manually-titled',
      observations: ['a long enough observation that the heuristic would gladly use'],
      title: 'A title a human chose',
    });
    runBackfill();

    const row = rowOf('manually-titled');
    expect(row.title).toBe('A title a human chose');
    // No heuristic mark either — the pass never visited this row.
    expect(row.metadata).toBeNull();
  });

  it('does not touch a row whose metadata it cannot parse', () => {
    const corrupt = '{ "half written';
    seedPreTitleRow({
      name: 'corrupt-meta',
      observations: ['an observation the heuristic would otherwise have used here'],
      metadata: corrupt,
    });
    runBackfill();

    const row = rowOf('corrupt-meta');
    expect(row.metadata, 'unparseable metadata was overwritten').toBe(corrupt);
    expect(row.title, 'a title was written without its source mark').toBeNull();
  });

  it('leaves a row with no observations untitled — display fallback covers it', () => {
    seedPreTitleRow({ name: 'bare-row', observations: [] });
    runBackfill();
    expect(rowOf('bare-row').title).toBeNull();
  });

  it('uses the commit subject for commit entities', () => {
    seedPreTitleRow({
      name: 'commit-a1b2c3d',
      type: 'commit',
      observations: ['fix(recall): stop dropping archived matches', 'Branch: main', 'Diff stats: 3 files changed'],
    });
    runBackfill();
    expect(rowOf('commit-a1b2c3d').title).toBe('fix(recall): stop dropping archived matches');
  });

  it('uses the Error line, label stripped, for failure lessons', () => {
    seedPreTitleRow({
      name: 'lesson-xyz',
      type: 'lesson_learned',
      observations: ['Error: pipe to grep swallowed the real exit code\nRoot cause: pattern mismatch'],
    });
    runBackfill();
    expect(rowOf('lesson-xyz').title).toBe('pipe to grep swallowed the real exit code');
  });

  it('runs once, not on every open, and a second forced run changes nothing', () => {
    seedPreTitleRow({
      name: 'idempotent-row',
      observations: ['the observation this title will be derived from, verbatim'],
    });
    runBackfill();
    const first = rowOf('idempotent-row');

    // Ordinary reopen: marker present, pass skipped.
    const db = openDatabase(dbPath);
    const markers = db.prepare("SELECT key FROM memesh_metadata WHERE key LIKE 'title_backfill%'").all() as Array<{ key: string }>;
    closeDatabase();
    expect(markers.length).toBe(1);

    // Forced re-run (as a marker bump would do): fill-only means the
    // already-titled row comes out byte-identical.
    runBackfill();
    expect(rowOf('idempotent-row')).toEqual(first);
  });
});

describe('the title backfill keeps the contentless FTS index truthful', () => {
  it('makes an active row findable by its new title', () => {
    seedPreTitleRow({
      name: 'session-4f2a',
      type: 'commit',
      observations: ['refactor(zanzibar): collapse the tuple cache', 'Branch: main'],
    });
    runBackfill();

    const db = openDatabase(dbPath);
    const kg = new KnowledgeGraph(db);
    // "zanzibar" appears in the title (and observation); the row must match.
    const hits = kg.search('zanzibar');
    expect(hits.map((e) => e.name)).toContain('session-4f2a');
    closeDatabase();
  });

  it('archiving a backfilled row leaves no ghost in the index', () => {
    // THE symmetry test. If the backfill set the title without reindexing,
    // archiveEntity's FTS delete — issued with the title folded in — does
    // not match the pre-title index entry; FTS5 rejects it ("database disk
    // image is malformed") and the stale tokens survive.
    //
    // The probe must be the RAW index, not kg.search(): the search path
    // JOINs entities with a status filter that hides archived rowids, so it
    // stays green over exactly this corruption. Measured: with the
    // backfill's reindex deleted, a kg.search() probe passed while the
    // delete failure was traced to stderr.
    seedPreTitleRow({
      name: 'ghost-check',
      observations: ['a wholly distinctive xylophone observation for this row'],
    });
    runBackfill();

    const db = openDatabase(dbPath);
    const kg = new KnowledgeGraph(db);
    expect(kg.search('xylophone').map((e) => e.name)).toContain('ghost-check');
    kg.archiveEntity('ghost-check');
    const stale = db.prepare(
      "SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'xylophone'"
    ).all();
    expect(
      stale.length,
      'stale FTS tokens survived the archive — the backfill did not reindex what it titled'
    ).toBe(0);
    closeDatabase();
  });

  it('titles an archived row without touching FTS, and the archived LIKE search finds it by title', () => {
    seedPreTitleRow({
      name: 'archived-row',
      type: 'lesson_learned',
      observations: ['Error: quokka overflow in the widget assembler'],
      archived: true,
    });
    runBackfill();

    // rowOf() opens and closes the module-singleton handle, so it must not
    // be interleaved with a live handle from openDatabase().
    expect(rowOf('archived-row').title).toBe('quokka overflow in the widget assembler');

    const db = openDatabase(dbPath);
    // No FTS entry may exist for it — a contentless delete/insert against a
    // row archiveEntity already removed is index corruption.
    const ftsHit = db.prepare(
      "SELECT rowid FROM entities_fts WHERE entities_fts MATCH 'quokka'"
    ).all();
    expect(ftsHit.length, 'the backfill wrote FTS entries for an archived row').toBe(0);

    // The archived supplement matches e.title too — a memory findable by its
    // title while active must stay findable once archived.
    const kg = new KnowledgeGraph(db);
    const hits = kg.search('overflow', { includeArchived: true });
    expect(hits.map((e) => e.name)).toContain('archived-row');
    closeDatabase();
  });
});
