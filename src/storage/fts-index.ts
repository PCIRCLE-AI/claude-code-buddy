// =============================================================================
// FTS5 index helpers — contentless-FTS5 delete + insert primitives
// =============================================================================
//
// SQLite's `content=''` FTS5 mode requires that deletes supply the
// previously-indexed column values (otherwise the row stays in the
// index). The pattern is:
//
//   INSERT INTO entities_fts(entities_fts, rowid, name, observations)
//   VALUES('delete', <rowid>, <previous-name>, <previous-obs-text>);
//   INSERT INTO entities_fts(rowid, name, observations) VALUES(?, ?, ?);
//
// This dance is identical at every call site. Centralizing it here:
//   - removes a documented drift hazard (4 inline copies in
//     knowledge-graph.ts + lifecycle.ts)
//   - gives a single place to bump if FTS schema changes
//   - keeps the helpers parameterless from `KnowledgeGraph`-state so
//     they can be called from non-class contexts (lifecycle.ts)

import type Database from 'better-sqlite3';

/**
 * Scripts whose writing systems do not put spaces between words. FTS5's
 * `unicode61` tokenizer treats every character in these ranges as a letter, so
 * an unbroken run becomes ONE token: a memory holding 「資料庫遷移前一定要先備份」
 * was reachable only by searching that exact string, and 「資料庫」 matched
 * nothing. Measured on a mixed corpus, Chinese recall was 2/9.
 *
 * CJK ideographs + compatibility ideographs, kana, and hangul syllables.
 *
 * Exported because `knowledge-graph.ts` needs the same set to decide whether a
 * single-character term should become a prefix query. It carried a verbatim
 * copy; adding a range to one and not the other silently desynchronises what
 * the index stores from what a query asks for.
 */
export const UNSPACED_SCRIPT_CLASS = '㐀-䶿一-鿿豈-﫿぀-ヿ가-힯';

const UNSPACED_SCRIPT = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]+`, 'gu');

/**
 * Split unspaced-script runs into overlapping character bigrams so FTS5 has
 * something word-shaped to index. Everything else — Latin, digits, punctuation,
 * spacing — is returned untouched, so English behaviour is bit-for-bit
 * unchanged.
 *
 *   「資料庫遷移」        ->  「資料 料庫 庫遷 遷移」
 *   "Postgres over MySQL" ->  "Postgres over MySQL"
 *
 * Overlapping bigrams (rather than fixed pairs) are what make a query land on a
 * word boundary the indexer could not know about: 「料庫」 exists as a token
 * even though a segmenter would have cut 「資料庫」 as one word.
 *
 * **This function is half of a pair.** The query side must segment identically
 * — `KnowledgeGraph.search()` does, via the same import — or queries produce
 * tokens the index does not contain. `tests/cjk-recall.test.ts` pins the
 * symmetry; do not change one side alone.
 *
 * Chosen over swapping the table to FTS5's `trigram` tokenizer, which was
 * measured on the same corpus at 3/9 Chinese recall for 4x the index size,
 * against 9/9 and 1.6x here — and which would have meant migrating the virtual
 * table itself rather than only its contents.
 */
export function segmentUnspacedScripts(text: string): string {
  return text.replace(UNSPACED_SCRIPT, (run) => {
    if (run.length === 1) return run;
    const grams: string[] = [];
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
    return ` ${grams.join(' ')} `;
  });
}

/**
 * Turn arbitrary text into the exact form the FTS5 index stores and searches.
 *
 * **This is the single owner of that answer.** Both halves of the pair — the
 * write path in this file and `buildMatchExpression()` in knowledge-graph.ts —
 * call it, so the index and the query cannot disagree about normalisation or
 * segmentation. They previously agreed about only one of the two:
 *
 *   - The write path did not normalise at all. Text stored decomposed (NFD)
 *     was indexed under different code points than the same text composed, and
 *     was unreachable by any query.
 *   - The query path normalised AFTER segmenting. Decomposed Hangul is a run
 *     of conjoining jamo (U+1100–U+11FF), which fall outside
 *     `UNSPACED_SCRIPT_CLASS`, so it was never split into bigrams; composing it
 *     afterwards produced one whole-run token the index does not contain, and
 *     the query returned nothing even against correctly-indexed content.
 *
 * NFD is not exotic input. macOS filesystem APIs and Finder emit it, several
 * Korean and Vietnamese IMEs emit it, and the hooks capture file paths.
 *
 * Order matters: normalise first, so segmentation sees composed syllables.
 */
export function toIndexForm(text: string): string {
  return segmentUnspacedScripts(text.normalize('NFC'));
}

/**
 * Split text into the terms the FTS5 index actually holds.
 *
 * Same split FTS5's `unicode61` tokenizer uses — runs of letters, numbers and
 * combining marks — applied to `toIndexForm()` output so the terms are in the
 * stored form.
 */
export function tokenizeQuery(text: string): string[] {
  return toIndexForm(String(text ?? '')).match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/**
 * Render terms into an FTS5 MATCH expression.
 *
 * **One implementation, because there used to be two.** `knowledge-graph.ts`
 * and `scripts/hooks/_shared.js` each rendered their own, and they had already
 * diverged: the hook copy omitted the lone-unspaced-character prefix branch, so
 * a single CJK character in a filename was emitted as an exact token and
 * matched nothing against a bigram index — the exact failure the hook change
 * was written to fix. This module is mirrored to the hook side at build time,
 * so sharing it here makes that drift structurally impossible rather than
 * something review has to keep catching.
 *
 * Terms are OR-ed: a question phrased in the user's own words should find the
 * memory rather than require every word to appear in it.
 *
 * A lone unspaced-script character becomes a PREFIX query. The index holds
 * overlapping bigrams and no unigrams, so an exact match on one character can
 * never hit; `"資"*` reaches any bigram starting with it.
 */
export function renderMatchExpression(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms
    .map((term) =>
      isLoneUnspacedChar(term)
        ? `"${term.replace(/"/g, '""')}"*`
        : `"${term.replace(/"/g, '""')}"`
    )
    .join(' OR ');
}

const LONE_UNSPACED_CHAR = new RegExp(`[${UNSPACED_SCRIPT_CLASS}]`, 'u');

/** A single character from a script written without spaces between words. */
export function isLoneUnspacedChar(term: string): boolean {
  return [...term].length === 1 && LONE_UNSPACED_CHAR.test(term);
}

/**
 * Remove a row from the contentless FTS5 index. Caller must supply the
 * previously-indexed name + observation text — that's what FTS5
 * requires to find the row in `content=''` mode.
 *
 * Best-effort: this function MUST NOT throw, because callers (e.g.
 * `archiveEntity`, `rebuildFts`) treat FTS maintenance as a side
 * concern of the primary DB write — failing the whole operation
 * because the index is wedged would lose user data on the entities
 * table. But the prior implementation swallowed *every* exception
 * silently, including real DB faults (lock contention, disk full,
 * schema corruption), which let the index drift out of sync with
 * the entities table with no operator signal.
 *
 * Now we still never throw, but we log a single-line warning to
 * stderr for any error that isn't the documented "no row to delete"
 * benign case (FTS5 'delete' is idempotent for missing rowids — that
 * one is genuinely safe to ignore).
 */
export function removeFromFts(
  db: Database.Database,
  entityId: number,
  name: string,
  prevObsText: string,
): void {
  try {
    // Segment on the way out too. Contentless FTS5 locates the row by the
    // values that were INDEXED, so a delete that passed the raw text while the
    // insert segmented it would never match, and the stale row would survive
    // every rebuild.
    db.prepare(
      "INSERT INTO entities_fts (entities_fts, rowid, name, observations) VALUES('delete', ?, ?, ?)",
    ).run(entityId, toIndexForm(name), toIndexForm(prevObsText));
  } catch (err) {
    if (isBenignFtsDeleteError(err)) return;
    // Real failure — log so an operator sees the index drift signal
    // instead of discovering it later via stale search results.
    process.stderr.write(
      `[memesh fts-index] removeFromFts(rowid=${entityId}) failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/**
 * FTS5 contentless `'delete'` raises SQLITE_ERROR with a "database
 * disk image is malformed" or "no such rowid" style message when the
 * indexed (name, observations) values don't match what the index has
 * stored for the rowid. That's still benign in our schema: the entity
 * either was never indexed (e.g. status='archived' from migration) or
 * was already cleaned up by a prior call. We treat those as no-ops.
 *
 * Anything else — disk full, locked DB, malformed schema, foreign-key
 * cascade failure — should reach the operator.
 */
function isBenignFtsDeleteError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  // "no such rowid" — FTS row never existed, idempotent delete.
  // "values do not match" / "no such row" — caller's recorded values
  //    drifted from what FTS stored (entity edited outside the helper);
  //    rebuildFts will reindex the row anyway.
  // We deliberately do NOT classify "database is locked", "disk I/O",
  // "disk image is malformed", or "no such table" as benign. Those
  // are real DB faults the operator must see.
  return /no such rowid|values do not match|no such row\b/i.test(msg);
}

/**
 * Insert a fresh row into the FTS5 index. Used after `removeFromFts`
 * when re-indexing an entity, or standalone for a brand-new entity
 * that has no prior FTS row (e.g. weekly-summary entities created in
 * lifecycle.ts).
 */
export function insertFtsRow(
  db: Database.Database,
  entityId: number,
  name: string,
  observationsText: string,
): void {
  db.prepare(
    'INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)',
  ).run(entityId, toIndexForm(name), toIndexForm(observationsText));
}
