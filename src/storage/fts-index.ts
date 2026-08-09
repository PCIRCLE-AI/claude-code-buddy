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

import type { MemeshDatabase, SqlOutputValue } from './sqlite.js';

/**
 * Scripts whose writing systems do not put spaces between words. FTS5's
 * `unicode61` tokenizer treats every character in these ranges as a letter, so
 * an unbroken run becomes ONE token: a memory holding 「資料庫遷移前一定要先備份」
 * was reachable only by searching that exact string, and 「資料庫」 matched
 * nothing. Measured on a mixed corpus, Chinese recall was 2/9.
 *
 * The list is derived from the writing system, not from which languages came
 * up first. Version 2 covered CJK ideographs, kana and hangul — which fixed
 * Chinese, Japanese and Korean and left every OTHER spaceless script with the
 * identical defect, undetected because no test used one. Measured on a fresh
 * database at version 2: Thai, Lao, half-width kana and CJK Extension B all
 * stored fine and were unfindable by any fragment of themselves.
 *
 *   U+0E01-U+0E5B    Thai
 *   U+0E81-U+0EDF    Lao
 *   U+1780-U+17FF    Khmer
 *   U+3400-U+4DBF    CJK Extension A
 *   U+4E00-U+9FFF    CJK Unified
 *   U+F900-U+FAFF    CJK compatibility ideographs
 *   U+3040-U+30FF    kana
 *   U+AC00-U+D7AF    hangul syllables
 *   U+FF66-U+FF9D    half-width katakana
 *   U+20000-U+3FFFF  CJK Extension B and beyond (non-BMP)
 *
 * Written as escapes rather than literals: several of these boundaries are
 * unassigned or non-printing code points, and a character-class range whose
 * endpoint got mangled by an editor or a terminal fails silently — it just
 * stops segmenting part of a script.
 *
 * The ranges are the single source for two derived forms below — the regex
 * character class used for segmentation, and the SQL GLOB pattern
 * `src/core/doctor.ts` binds to find runs an older build left unsegmented.
 * Deriving both is the point: doctor's copy was originally a hand-written
 * CJK-only pair, and this list has since grown to ten ranges, so a hand-written
 * copy would have gone on reporting a healthy index over an unsegmented Thai
 * one.
 */
export const UNSPACED_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0e01, 0x0e5b], // Thai
  [0x0e81, 0x0edf], // Lao
  [0x1780, 0x17ff], // Khmer
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0x3040, 0x30ff], // kana
  [0xac00, 0xd7af], // hangul syllables
  [0xff66, 0xff9d], // half-width katakana
  [0x20000, 0x3ffff], // CJK Extension B and beyond
];

/**
 * The ranges as a regular-expression character class.
 *
 * Derived rather than written out a second time. `doctor.ts` needs the same set
 * as a SQL `GLOB` pattern to find terms an older build left unsegmented, and a
 * hand-maintained copy there would have silently gone on checking only CJK
 * after this list grew \u2014 reporting a healthy index over an unsegmented Thai one,
 * which is the failure mode that check exists to catch.
 */
export const UNSPACED_SCRIPT_CLASS = UNSPACED_SCRIPT_RANGES.map(
  ([lo, hi]) => `${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`
).join('');

/**
 * A SQLite `GLOB` pattern matching a term that contains THREE OR MORE
 * consecutive unspaced-script characters — the fingerprint of a run this
 * build's segmenter never wrote.
 *
 * Three, not one, and this is the whole correctness of the check.
 * `segmentUnspacedScripts` only splits runs of two or more, so a LONE unspaced
 * character is passed through untouched — and `unicode61` then treats it and
 * any adjacent ASCII letters/digits as one token. So a perfectly healthy index
 * routinely holds terms like `第1章` or `語abc`: longer than a bigram, starting
 * with an unspaced-script character, and entirely correct.
 *
 * An earlier version of this pattern was `[class]*` ("starts with one"), which
 * reported those healthy databases as damaged and told the user to rebuild an
 * index that was fine. Measured on a clean database written entirely through
 * the normal path: `第1章` and `語abc` were both flagged while both memories
 * were findable.
 *
 * After segmentation the longest possible unspaced run inside a single token is
 * two (a bigram), so three consecutive is unambiguous evidence that some rows
 * were written by a build that was not segmenting.
 *
 * SQLite's GLOB compares code points, not bytes, so the ranges carry over
 * directly — including the astral Extension B range. Passed as a bound
 * parameter rather than concatenated into the SQL.
 */
export const UNSPACED_SCRIPT_GLOB_RUN3 =
  `*[${UNSPACED_SCRIPT_CLASS}][${UNSPACED_SCRIPT_CLASS}][${UNSPACED_SCRIPT_CLASS}]*`;

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
    // Code POINTS, not UTF-16 code units. CJK Extension B lives above the BMP,
    // so `run.slice(i, i + 2)` would cut a surrogate pair in half and index
    // lone surrogates — terms no query can ever produce. While the class held
    // only BMP ranges the two spellings were identical, which is why the
    // simpler form was correct right up until the class grew.
    const chars = [...run];
    if (chars.length === 1) return run;
    const grams: string[] = [];
    for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i] + chars[i + 1]);
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
 * Applied to `toIndexForm()` output so the terms are in the stored form.
 *
 * **A term must START with a letter or a number.** Marks may only follow one.
 *
 * The previous pattern was `[\p{L}\p{N}\p{M}]+`, which accepts a term made of
 * combining marks alone. FTS5's `unicode61 remove_diacritics 1` does not: for
 * non-Latin scripts it treats those marks as SEPARATORS, so a mark-only term
 * tokenises to nothing and the `MATCH` phrase built from it can never hit a
 * row. That gap was observable — `hasSearchableTerms('ํ')` answered true
 * while `search()` returned 0 for it, and the same for U+0301, U+0951, U+064F,
 * U+17B6 and U+3099 — and it mattered beyond a wasted query: `recallEnhanced`
 * gates the vector supplement on `hasSearchableTerms`, so those queries skipped
 * the keyword result and got semantically-nearest memories instead. That is the
 * "nothing matched dressed as here is what matched" shape the gate exists to
 * prevent, on the one input class it did not cover.
 *
 * Requiring a leading letter or number does not drop marks that belong to a
 * word: `toIndexForm` NFC-normalises first, and in every script where a mark
 * survives composition it follows its base character — Thai tone marks,
 * Devanagari matras, Arabic harakat, Hebrew niqqud, combining kana marks. Those
 * still tokenise as one term, and `tests/recall-relevance.test.ts` plus
 * `tests/cjk-recall.test.ts` cover them.
 */
export function tokenizeQuery(text: string): string[] {
  return toIndexForm(String(text ?? '')).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
}

/**
 * The SQL name of the NFC-normalising function registered below.
 *
 * The archived-supplement branch in `knowledge-graph.ts` matches with `LIKE`
 * against the RAW `entities.name` / `observations.content` columns, because
 * archived rows are removed from FTS5. Its terms come from `tokenizeQuery`,
 * which NFC-normalises — so it was comparing normalised terms against
 * un-normalised storage, and text stored decomposed was findable while active
 * and unfindable the moment it was archived. Measured: a Vietnamese memory
 * stored NFD was returned by `search('dữ liệu')` and then, after
 * `archiveEntity`, was absent from `search('dữ liệu', {includeArchived:true})`
 * while its NFC twin was returned.
 *
 * Normalising the stored side in SQL keeps both halves of one `search()` call
 * answering the same question. It is a full scan either way — archived rows
 * have no index to lose.
 */
export const SQL_NFC_FUNCTION = 'memesh_nfc';

/** Handles this process has already registered the function on. */
const nfcRegistered = new WeakSet<object>();

/**
 * Register `memesh_nfc(text)` on a connection, once.
 *
 * Idempotent by WeakSet rather than by relying on the driver's behaviour on
 * re-registration (verified to be silent replacement, but not something to
 * depend on). `deterministic` is correct — NFC of a given string never changes
 * — and lets SQLite cache and reorder freely.
 */
export function registerNfcFunction(db: MemeshDatabase): void {
  if (nfcRegistered.has(db)) return;
  db.function(SQL_NFC_FUNCTION, { deterministic: true }, (value: SqlOutputValue) =>
    typeof value === 'string' ? value.normalize('NFC') : value
  );
  nfcRegistered.add(db);
}

/**
 * Does this query contain anything that can be searched for at all?
 *
 * `"???"`, `"@#$%"`, a lone emoji: non-empty, but nothing survives tokenising.
 * Such a query must return no results rather than something that merely looks
 * like results.
 *
 * **One owner, because two places decide this and they disagreed.**
 * `KnowledgeGraph.search()` returned `[]` correctly, and `recallEnhanced()`
 * then ran the vector supplement anyway — it only checked that the query string
 * was truthy. So with embeddings enabled the caller still got up to `limit`
 * semantically-nearest memories for a query that matched nothing: exactly the
 * "here is what matched" / "I found no terms, have these instead" confusion the
 * behaviour change was made to remove, on the path the change did not cover.
 */
export function hasSearchableTerms(text: string): boolean {
  return tokenizeQuery(text).length > 0;
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
  db: MemeshDatabase,
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
  db: MemeshDatabase,
  entityId: number,
  name: string,
  observationsText: string,
): void {
  db.prepare(
    'INSERT INTO entities_fts (rowid, name, observations) VALUES (?, ?, ?)',
  ).run(entityId, toIndexForm(name), toIndexForm(observationsText));
}
