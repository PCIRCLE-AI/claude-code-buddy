// =============================================================================
// An archived entity is in NEITHER search index — D11 / D12
// =============================================================================
//
// Found by querying the maintainer's real graph, not by reading a diff.
// At 2136 entities (820 active, 1316 archived):
//
//   413 of 1013 vector rows belonged to archived entities. 41 real k-NN
//       queries spent 290 of 820 top-20 slots — 35.4% — on memories the user
//       had already put away.
//   213 archived entities were still in `entities_fts`. `MATCH 'ae83279'`
//       returned the archived `commit-ae83279`.
//
// `archiveEntity` always dropped both rows. `compressWeeklyNoise`, the
// dreamer's compaction apply and `splitFusedLessons` archived with a bare
// status UPDATE and dropped neither — and that second defect fed a third: a
// re-remembered entity that still had an FTS row got a SECOND document at the
// same rowid, because `createEntityInner` skipped the contentless delete for
// anything `wasArchived` on the reasoning that archiving had already removed
// it. Only one of the four archive paths had.

import { describe, it, expect, vi } from 'vitest';
import { getDatabase } from '../../src/db.js';
import { KnowledgeGraph } from '../../src/knowledge-graph.js';
import { compressWeeklyNoise } from '../../src/core/lifecycle.js';
import { removeFromFts } from '../../src/storage/fts-index.js';
import { useTestDatabase } from '../helpers/db-fixture.js';

useTestDatabase('memesh-archived-index-');

/** Rows the keyword index holds for an entity id. Contentless FTS5 hides its
 *  columns but not its rowids, so this counts DOCUMENTS, which is the unit the
 *  double-insert defect duplicates. */
function ftsRowCount(db: ReturnType<typeof getDatabase>, id: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM entities_fts WHERE rowid = ?').get(id) as { c: number }
  ).c;
}

function vecRowCount(db: ReturnType<typeof getDatabase>, id: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM entities_vec WHERE rowid = ?').get(BigInt(id)) as {
      c: number;
    }
  ).c;
}

function seedVector(db: ReturnType<typeof getDatabase>, id: number): void {
  const dim = (
    db.prepare("SELECT value FROM memesh_metadata WHERE key = 'embedding_dimension'").get() as
      | { value: string }
      | undefined
  );
  const width = dim ? parseInt(dim.value, 10) : 384;
  const v = new Float32Array(width);
  v[0] = 1;
  db.prepare('INSERT INTO entities_vec (rowid, embedding) VALUES (?, ?)').run(
    BigInt(id),
    Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  );
}

describe('compressWeeklyNoise leaves an archived entity in neither index (D11/D12)', () => {
  function seedOldNoise(db: ReturnType<typeof getDatabase>, count: number): void {
    const date = new Date(Date.now() - 2 * 7 * 24 * 60 * 60 * 1000).toISOString();
    const kg = new KnowledgeGraph(db);
    for (let i = 0; i < count; i++) {
      // Through KnowledgeGraph so the entity is indexed exactly as the product
      // indexes it — a hand-rolled INSERT would leave no FTS row and the test
      // would pass without ever exercising the delete.
      kg.createEntity(`commit-noise-${i}`, 'commit', {
        observations: [`unmistakabletoken${i} touched the parser`],
        tags: ['project:test'],
      });
      db.prepare('UPDATE entities SET created_at = ? WHERE name = ?').run(
        date,
        `commit-noise-${i}`,
      );
    }
  }

  it('removes the FTS row, so keyword search stops answering with it', () => {
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);

    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('commit-noise-0') as {
      id: number;
    }).id;
    expect(ftsRowCount(db, id)).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM entities_fts WHERE entities_fts MATCH 'unmistakabletoken0'").get(),
    ).toEqual({ c: 1 });

    const result = compressWeeklyNoise(db);
    expect(result.compressed).toBe(25);

    expect(
      (db.prepare('SELECT status FROM entities WHERE id = ?').get(id) as { status: string }).status,
    ).toBe('archived');
    expect(ftsRowCount(db, id)).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM entities_fts WHERE entities_fts MATCH 'unmistakabletoken0'").get(),
    ).toEqual({ c: 0 });
  });

  it('removes the vector row, so it stops taking recall slots', () => {
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);

    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('commit-noise-0') as {
      id: number;
    }).id;
    // The suite runs with no embedder, so nothing wrote a vector; write one
    // directly, which is the state a real graph is in when the entity was
    // remembered while an embedder WAS configured.
    seedVector(db, id);
    expect(vecRowCount(db, id)).toBe(1);

    compressWeeklyNoise(db);

    expect(vecRowCount(db, id)).toBe(0);
  });

  it('leaves the entities that stayed active fully indexed', () => {
    // The repair and the fix must remove archived rows and nothing else.
    const db = getDatabase();
    db.exec("DELETE FROM memesh_metadata WHERE key = 'last_noise_compress_at'");
    seedOldNoise(db, 25);
    const kg = new KnowledgeGraph(db);
    kg.createEntity('decision-keep-me', 'decision', {
      observations: ['survivortoken chose SQLite over Postgres'],
      tags: ['project:test'],
    });

    compressWeeklyNoise(db);

    const keep = (db.prepare('SELECT id FROM entities WHERE name = ?').get('decision-keep-me') as {
      id: number;
    }).id;
    expect(ftsRowCount(db, keep)).toBe(1);
    // Exactly one, not "contains": the compression must neither drop the
    // active entity from the index nor leave a second copy of it there.
    expect(kg.search('survivortoken')).toHaveLength(1);
    expect(kg.search('survivortoken').map((e) => e.name)).toEqual(['decision-keep-me']);
  });
});

describe('a re-remembered archived entity is searchable exactly once (D12)', () => {
  /** Archive the way the three leaky paths did: status only, indexes untouched. */
  function archiveWithoutTouchingIndexes(
    db: ReturnType<typeof getDatabase>,
    name: string,
  ): void {
    db.prepare("UPDATE entities SET status = 'archived' WHERE name = ?").run(name);
  }

  // There is deliberately no separate "two documents at one rowid" test.
  // Measured against FTS5 3.51.3: a second insert of IDENTICAL (or superset)
  // text at a rowid is not observable — `SELECT COUNT(*) … WHERE rowid = ?`,
  // `fts5vocab 'row'` and `fts5vocab 'instance'` all merge the postings, and a
  // later correct delete removes them all. An assertion on any of those would
  // have carried the defect's name while being unable to fail. The double
  // insert only leaves damage when the two documents DIFFER, and through
  // `createEntity` there is exactly one way for them to: the title, which is
  // folded into the indexed observation text. That is the case below, and it
  // is the whole of the observable defect.

  it('leaves no token behind that a later delete cannot reach', () => {
    // The permanent-token case, and it needs the two documents to DIVERGE:
    // measured against FTS5 directly, a second document that is a superset of
    // the first is still fully removed by a correct delete of its own text,
    // but one that dropped a term is not — the dropped term has no delete that
    // can ever name it. A title change between archive and re-remember does
    // exactly that, because the title is folded into the indexed observation
    // text (`foldTitleIntoObservations`).
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('commit-def5678', 'commit', {
      title: 'oldtitletoken parser work',
      observations: ['shared body text'],
    });
    archiveWithoutTouchingIndexes(db, 'commit-def5678');

    kg.createEntity('commit-def5678', 'commit', {
      title: 'newtitletoken lexer work',
      observations: ['shared body text'],
    });

    // The old title is gone from the index, not merely unreachable through the
    // entity: with the double insert it survived every subsequent delete.
    expect(kg.search('oldtitletoken')).toHaveLength(0);
    expect(kg.search('newtitletoken')).toHaveLength(1);
    expect(kg.search('newtitletoken').map((e) => e.name)).toEqual(['commit-def5678']);

    // And a proper archive now empties the row completely — the state the old
    // path could not reach for the first document's terms.
    kg.archiveEntity('commit-def5678');
    expect(kg.search('newtitletoken')).toHaveLength(0);
    expect(kg.search('oldtitletoken')).toHaveLength(0);
  });

  it('still works for an entity archived the clean way (no FTS row to delete)', () => {
    // `removeFromFts` classes "no such rowid" as benign, so reading the
    // previous text unconditionally must not break the path that already
    // removed the row. Without this, the fix would trade one defect for a
    // stderr warning on every re-remember of a properly archived memory.
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('note-clean', 'note', { observations: ['cleanpathtoken here'] });
    kg.archiveEntity('note-clean');
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('note-clean') as {
      id: number;
    }).id;
    expect(ftsRowCount(db, id)).toBe(0);

    kg.createEntity('note-clean', 'note', { observations: ['cleanpathtoken here', 'and more'] });

    expect(ftsRowCount(db, id)).toBe(1);
    expect(kg.search('cleanpathtoken')).toHaveLength(1);
    expect(kg.search('cleanpathtoken').map((e) => e.name)).toEqual(['note-clean']);
  });
});

describe('the contentless delete never runs without a row to delete', () => {
  it('a second removeFromFts for the same text is a no-op, not a corrupt index', () => {
    // The mechanism, pinned directly. A contentless FTS5 'delete' writes
    // NEGATIVE postings and does not look for a row first; issued twice for
    // one (rowid, text) the counts go below zero and SQLite raises
    // `database disk image is malformed`. Measured on SQLite 3.51.3 outside
    // this codebase: insert, delete correctly, delete again -> that exact
    // error. `removeFromFts` must therefore refuse the second call rather
    // than rely on the benign-error classifier, which does not (and must
    // not) treat "malformed" as benign.
    //
    // This is the path `forget` then re-`remember` takes on EVERY properly
    // archived memory, so without the guard the fix for the double-INSERT
    // would have traded one defect for a worse one.
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);
    kg.createEntity('note-guarded', 'note', { observations: ['guardedtoken body'] });
    const id = (db.prepare('SELECT id FROM entities WHERE name = ?').get('note-guarded') as {
      id: number;
    }).id;

    removeFromFts(db, id, 'note-guarded', 'guardedtoken body', null);
    expect(ftsRowCount(db, id)).toBe(0);

    // Asserted on stderr, not on a throw: `removeFromFts` is best-effort and
    // swallows its own errors by contract (an index fault must not fail the
    // user's write), so `not.toThrow()` passes whether the guard is there or
    // not. The single warning line it writes for a non-benign error is the
    // deterministic signal — and "database disk image is malformed" is
    // deliberately NOT in the benign set.
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        warnings.push(String(chunk));
        return true;
      });
    try {
      removeFromFts(db, id, 'note-guarded', 'guardedtoken body', null);
    } finally {
      spy.mockRestore();
    }
    expect(warnings.filter((w) => w.includes('removeFromFts'))).toEqual([]);
    expect(ftsRowCount(db, id)).toBe(0);
    expect(kg.search('guardedtoken')).toHaveLength(0);
  });
});
