import type { MemeshDatabase } from './storage/sqlite.js';
export type { Entity, Relation, CreateEntityInput, SearchOptions } from './core/types.js';
import type { Entity, Relation, CreateEntityInput, SearchOptions, EntityRow } from './core/types.js';
import { findConflicts, trackAccess } from './storage/conflicts.js';
import {
  indexedObservationText,
  insertFtsRow,
  joinIndexedObservations,
  removeFromFts,
  tokenizeQuery,
  renderMatchExpression,
  registerNfcFunction,
  SQL_NFC_FUNCTION,
} from './storage/fts-index.js';
import { computeSignalScore } from './core/signal-scorer.js';
import { dropEntityFromIndexes, removeVectorRow } from './storage/entity-index.js';

/**
 * Cap on how many terms of a query reach the FTS5 MATCH expression. Terms are
 * OR-ed, so an unbounded query (a pasted stack trace, a log dump) would build
 * an arbitrarily large disjunction. Real questions are well under this.
 */
const MAX_QUERY_TERMS = 32;

/**
 * Turn a user query into an FTS5 MATCH expression, or null when there is
 * nothing searchable in it.
 *
 * The query is segmented by `segmentUnspacedScripts()` — the same function the
 * indexer applies — before being split, so a Chinese, Japanese or Korean query
 * produces the character bigrams the index actually holds. **The two sides must
 * stay identical**; `tests/cjk-recall.test.ts` pins that.
 *
 * The token class mirrors what `unicode61` treats as part of a word — letters,
 * digits, and the combining marks that belong to them — so the query is cut the
 * way the index was. Two properties depend on it:
 *
 *   - `\p{L}\p{N}` keeps non-Latin scripts alive. A plain `[^a-zA-Z0-9]` strip
 *     would reduce a CJK query to nothing, and an empty query falls through to
 *     the recent-list path: a search that looks successful while answering a
 *     different question.
 *   - `\p{M}` plus the NFC normalisation keep decomposed text whole. Splitting
 *     on a combining mark cut words in half — NFD `naïve` became `nai` + `ve`,
 *     neither of which is a token in the index, because unicode61 folds the
 *     mark and stores `naive`.
 *
 * Every token is alphanumeric by construction, so quoting needs no escaping and
 * no FTS5 operator (`OR`, `NEAR`, `*`, `^`, `:`) can survive as syntax.
 *
 * A lone unspaced-script character is the one case segmentation cannot serve —
 * the index holds bigrams, so 「資」 matches no token. Those become a prefix
 * query (`"資"*`), which reaches every bigram STARTING with that character.
 * Known bound: it will not find 「融資」, where the character sits second.
 * Indexing unigrams as well would fix that at the cost of index size and noise
 * for a rare query shape; pinned as a limit rather than chased.
 */
function buildMatchExpression(db: MemeshDatabase, query: string): string | null {
  // The cap is applied AFTER the frequency guard, not before. Bigram
  // segmentation turns a 40-character Chinese question into ~39 terms, so a
  // positional cap discarded everything past roughly the 33rd character —
  // which may hold the query's rarest, most selective terms — while an English
  // question of the same length keeps all ~13 of its words. Dropping the
  // ubiquitous ones first means the terms that survive are the ones that
  // actually narrow the search.
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return null;
  return renderMatchExpression(dropUbiquitousTerms(db, terms).slice(0, MAX_QUERY_TERMS));
}

/**
 * The archived-supplement branch's equivalent of `buildMatchExpression()`.
 *
 * Archived rows live outside FTS5, so they are matched with LIKE. Same terms,
 * same segmentation — otherwise "include archived" quietly answers a different
 * question than the search it is supplementing. Each term is wrapped in `%…%`
 * and its LIKE metacharacters escaped with a backslash, paired with an
 * `ESCAPE '\\'` clause at the call site.
 *
 * Falls back to the whole (escaped) query when tokenising yields nothing, so a
 * punctuation-only query still behaves as before rather than matching everything.
 */
function archivedLikeTerms(db: MemeshDatabase, query: string): string[] {
  const escapeLike = (v: string) => v.replace(/[\\%_]/g, '\\$&');
  // Same ORDER as the FTS branch: drop the ubiquitous terms FIRST, then cap.
  // These two had silently diverged — the FTS side moved the cap after the
  // guard and this one did not — so a 37-character Chinese question gave the
  // two branches different term sets, and the archived supplement quietly
  // answered a different question from the search it supplements. That bites
  // hardest exactly where it is used: an archived row is usually a superseded
  // version of an active one, sharing the head of the text and differing in the
  // tail, which is the part a positional cap discards.
  const terms = tokenizeQuery(query);
  const kept = (terms.length > 1 ? dropUbiquitousTerms(db, terms) : terms).slice(
    0,
    MAX_QUERY_TERMS
  );
  if (kept.length === 0) return [`%${escapeLike(query)}%`];
  return kept.map((t) => `%${escapeLike(t)}%`);
}

/**
 * A term present in more than this fraction of indexed rows is dropped from the
 * MATCH expression. Measured on LongMemEval haystacks: R@5 is unchanged at 90%,
 * 70% and 50%, and starts to fall at 30% (94.0% → 93.0%), so 50% takes the
 * available speed with margin against the cliff.
 */
const UBIQUITOUS_TERM_FRACTION = 0.5;

/**
 * Below this many indexed rows the guard does not apply.
 *
 * This is a correctness floor, not a performance one — the guard is measurably
 * faster at every corpus size tested, including 50 rows. Document frequency
 * simply has no meaning on a handful of rows: in a four-memory database a term
 * in three of them is the subject, not a stopword, and dropping it would delete
 * the query.
 */
const MIN_ROWS_FOR_DF_GUARD = 25;

/**
 * Drop query terms that appear in most of the index.
 *
 * Terms are OR-ed, so search cost is the size of the union of their postings,
 * and one ubiquitous word dominates it. Measured on a synthetic corpus with a
 * 12-term query, 200 iterations, including the cost of the lookup itself:
 *
 *         50 rows    0.071 ms  ->  0.039 ms   -45%
 *        500 rows    0.411 ms  ->  0.079 ms   -81%
 *      5 000 rows    4.147 ms  ->  0.481 ms   -88%
 *    100 000 rows   80.15  ms  ->  8.57  ms   -89%
 *
 * It wins at every size tested — the lookup is one indexed probe while the
 * saving scales with the corpus.
 *
 * The dropped terms are the ones BM25 already scores near zero — a word in
 * every row has no inverse document frequency — so this removes work rather
 * than signal. Measured on LongMemEval, R@5 is unchanged.
 *
 * `fts_vocab` is an `fts5vocab` view over `entities_fts`; it stores nothing of
 * its own, so this costs one indexed lookup and no disk.
 *
 * Never returns an empty list. A query made entirely of common words — "what
 * did we do" — keeps its rarest term, because returning nothing would be worse
 * than returning a broad match.
 */
/**
 * Number of active entities, for the document-frequency guard's ceiling.
 *
 * This was briefly cached, keyed on `(PRAGMA data_version, total_changes())`.
 * The invalidation was correct but the cache could never pay: every non-empty
 * search calls `trackAccess`, whose UPDATE moves `total_changes()` and
 * invalidates the entry before the next recall — and hook processes are
 * short-lived, so they start cold and exit before a second search. Measured on
 * a 20k-entity database: the count is 376us, the stamp check 5.9us, and on the
 * hot path the stamp check was pure addition.
 *
 * A cache that cannot hit is complexity plus a claim that is not true, so it
 * is gone. This is the honest cost.
 */
function activeEntityCount(db: MemeshDatabase): number {
  return (
    db.prepare("SELECT count(*) AS c FROM entities WHERE status = 'active'").get() as { c: number }
  ).c;
}

/**
 * Largest number of terms sent to the `fts_vocab` lookup in one statement.
 *
 * The cap on query terms is applied AFTER this guard (so the surviving terms
 * are the selective ones, not merely the first 32), which means the `IN (...)`
 * clause takes one bound parameter per token of the RAW query. A pasted stack
 * trace or a pasted CJK document blows past SQLITE_MAX_VARIABLE_NUMBER (32766)
 * and the prepare throws `too many SQL variables` — swallowed by the catch
 * below under a comment blaming a missing `fts_vocab`, silently disabling the
 * optimisation for exactly the queries that need it most. Measured on a 20k-row
 * vocab: 12 terms 0.18ms, 500 terms 1.9ms, 3000 terms 11.5ms, 20000 terms 77ms.
 *
 * 256 is 8x the term cap — far more than enough for the guard to choose from,
 * and it keeps the lookup in the sub-millisecond range.
 */
const MAX_DF_LOOKUP_TERMS = 256;

/**
 * Lowercase a term the way `entities_fts` does — and ONLY where we know how.
 *
 * `entities_fts` is declared `unicode61 remove_diacritics 1`, which strips
 * combining marks from LATIN characters. For other scripts unicode61 treats a
 * combining mark as a SEPARATOR, so the stored tokens are not the mark-stripped
 * word at all. Measured against a real FTS5 table:
 *
 *     "café"     -> stored as  "cafe"          (diacritic removed)
 *     "काम"      -> stored as  "क", "म"        (SPLIT on the matra)
 *     "कम"       -> stored as  "कम"
 *     "مُحَمَّد"     -> stored as  "م","ح","م","د"  (split on harakat)
 *     "한국"      -> stored as  "한국"
 *
 * An earlier version stripped every `\p{M}` unconditionally. That maps a large
 * word space onto a small skeleton space, so `fold("काम")` produced `"कम"` — a
 * REAL, DIFFERENT, and commonly frequent word. If `कम` cleared the ubiquity
 * ceiling, the query term `काम` was dropped, and since terms are OR-ed the
 * disjunction lost the only member that could match: the search returned
 * nothing. That regressed Devanagari, Bengali, Tamil, Telugu, Arabic, Hebrew
 * and Thai — every script whose marks are not Latin diacritics.
 *
 * So folding is restricted to terms that are Latin-with-marks. Everything else
 * is looked up as written: correct for CJK and Hangul bigrams, which carry no
 * marks, and for the mark-bearing scripts it simply finds no vocab row, giving
 * document frequency 0 and KEEPING the term. That is the safe direction and is
 * what `main` did for every accented term — the guard silently not applying
 * costs a little speed, whereas deleting a query term costs the answer.
 */
const LATIN_FOLDABLE = /^[\p{Script=Latin}\p{M}\p{N}]+$/u;

function fold(term: string): string {
  const lower = term.toLowerCase();
  if (!LATIN_FOLDABLE.test(lower)) return lower;
  return lower.normalize('NFD').replace(/\p{M}/gu, '');
}

function dropUbiquitousTerms(db: MemeshDatabase, terms: string[]): string[] {
  if (terms.length < 2) return terms;
  try {
    const total = activeEntityCount(db);
    if (total < MIN_ROWS_FOR_DF_GUARD) return terms;

    // Fold the way the index folds, or the lookup silently never matches.
    // entities_fts is declared `remove_diacritics 1`, so unicode61 strips
    // combining marks before storing: `café` is stored as `cafe`. Looking it up
    // as `café` returned no row, the term got document frequency 0, and it was
    // always kept — the guard quietly did not apply to any accented or
    // decomposed term. Recall was unaffected (FTS5 folds again at MATCH time);
    // the optimisation just never ran.
    const lowered = terms.slice(0, MAX_DF_LOOKUP_TERMS).map(fold);
    const rows = db
      .prepare(`SELECT term, doc FROM fts_vocab WHERE term IN (${lowered.map(() => '?').join(',')})`)
      .all(...lowered) as Array<{ term: string; doc: number }>;
    if (rows.length === 0) return terms;

    const docFreq = new Map(rows.map((r) => [r.term, r.doc]));
    const ceiling = UBIQUITOUS_TERM_FRACTION * total;
    const kept = terms.filter((t) => (docFreq.get(fold(t)) ?? 0) <= ceiling);
    if (kept.length > 0) return kept;

    // Everything is common. Keep the single rarest rather than matching nothing.
    return [terms.reduce((rarest, t) =>
      (docFreq.get(fold(t)) ?? 0) < (docFreq.get(fold(rarest)) ?? 0) ? t : rarest
    )];
  } catch {
    // fts_vocab missing (a database opened by an older version, or a caller
    // that built the schema by hand) — the guard is an optimisation, so fall
    // back to searching every term rather than failing the query.
    return terms;
  }
}

export class KnowledgeGraph {
  constructor(private db: MemeshDatabase) {}

  updateEntityMetadata(
    name: string,
    updater: (currentMetadata: Record<string, unknown>) => Record<string, unknown> | null | undefined
  ): void {
    const row = this.db
      .prepare('SELECT metadata FROM entities WHERE name = ?')
      .get(name) as { metadata: string | null } | undefined;

    if (!row) return;

    const currentMetadata = this.parseMetadata(row.metadata);
    const nextMetadata = updater(currentMetadata);
    this.db
      .prepare('UPDATE entities SET metadata = ? WHERE name = ?')
      .run(nextMetadata ? JSON.stringify(nextMetadata) : null, name);
  }

  createEntity(
    name: string,
    type: string,
    opts?: {
      observations?: string[];
      tags?: string[];
      metadata?: Record<string, unknown>;
      namespace?: string;
      /** Human-readable display string. Set on a new entity's initial
       *  INSERT; on an existing entity, an explicitly supplied value
       *  that differs from the current one UPDATEs it (same "explicit
       *  value wins, undefined leaves it alone" rule as `namespace`
       *  below). Omit to leave an existing title untouched. */
      title?: string | null;
      /**
       * Trust signal for the confidence-bump gate. Must arrive at
       * `createEntity()` time rather than via a later
       * `updateEntityMetadata()` call, because the bump decision
       * happens inside this function. The default ('trusted') matches
       * what `buildLocalMetadata()` writes for explicit user
       * remembers; importer / failure-analyzer paths pass
       * `'untrusted'` to opt out of the bump.
       */
      trustOverride?: 'trusted' | 'untrusted';
    }
  ): number {
    // One transaction, for the same reason `archiveEntity`, `deleteEntity`
    // and `clearEntityData` have one — and this is the writer that matters
    // most, because it is the one every surface uses.
    //
    // The body below performs the same six-write sequence the hooks'
    // `captureEntity` does: the entity row, a confidence update, the
    // observations, the tags, and the contentless-FTS delete + insert that
    // make them findable. In autocommit a throw in the middle commits the
    // prefix, and the two likely resting places are both invisible —
    // observations with no FTS row (a memory that exists and can never be
    // recalled), or the old FTS row deleted and the new one not written. The
    // `INSERT OR IGNORE` on the entity name then makes it permanent: the next
    // write reports "already there" and never repairs the rest.
    //
    // Safe to nest: `MemeshDatabase` tracks depth and turns an inner
    // transaction into a SAVEPOINT, so `createEntitiesBatch`'s outer
    // transaction and the import/dreamer callers keep working unchanged.
    return this.db.transaction(() => this.createEntityInner(name, type, opts))();
  }

  private createEntityInner(
    name: string,
    type: string,
    opts?: Parameters<KnowledgeGraph['createEntity']>[2],
  ): number {
    // Phase-1 of #39 (signal scorer): every entity gets a rule-based
    // signal_score at creation time so the dashboard can default-hide
    // empty session_keypoints, mechanical commits, and other captured
    // noise without depending on an LLM round-trip. Stamping in
    // metadata at write-time is cheaper than computing on every
    // dashboard read.
    const incomingMetadata = (opts?.metadata && typeof opts.metadata === 'object') ? { ...opts.metadata } : {};
    if (incomingMetadata.signal_score === undefined) {
      incomingMetadata.signal_score = computeSignalScore({
        type,
        name,
        observations: opts?.observations ?? [],
        tags: opts?.tags ?? [],
      });
    }

    // INSERT OR IGNORE — if entity already exists, get its id
    const insertResult = this.db
      .prepare(
        'INSERT OR IGNORE INTO entities (name, type, metadata, namespace, title) VALUES (?, ?, ?, ?, ?)'
      )
      .run(name, type, JSON.stringify(incomingMetadata), opts?.namespace ?? 'personal', opts?.title ?? null);
    const isNewEntity = insertResult.changes > 0;

    const row = this.db
      .prepare('SELECT id, status, namespace, title, type FROM entities WHERE name = ?')
      .get(name) as { id: number; status: string; namespace: string | null; title: string | null; type: string };
    const entityId = row.id;

    // Title update on an EXISTING entity — the INSERT OR IGNORE above never
    // touches `title` when the row already exists (the whole insert attempt
    // is dropped), so this mirrors the namespace-move block below: only an
    // explicitly supplied, actually-different value writes anything.
    // When title changes via API/remember (user-provided), clear title_source
    // to mark it as permanent (Fix C3: keep title_source synchronized).
    const previousTitle = row.title;
    if (!isNewEntity && opts?.title !== undefined && opts.title !== previousTitle) {
      this.db
        .prepare('UPDATE entities SET title = ? WHERE id = ?')
        .run(opts.title, entityId);
      // User-provided title: clear title_source from metadata to mark as permanent.
      // Heal corrupted metadata if parse fails (Fix C2).
      const metaRow = this.db.prepare('SELECT metadata FROM entities WHERE id = ?').get(entityId) as { metadata: string | null } | undefined;
      let metadata: Record<string, unknown> = {};
      if (metaRow?.metadata) {
        try {
          const parsed = JSON.parse(metaRow.metadata);
          metadata = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch {
          console.error(`MeMesh: healed corrupted metadata for entity ${entityId} during title update.`);
        }
      }
      // Remove title_source to mark as user-provided (permanent)
      delete metadata.title_source;
      this.db.prepare('UPDATE entities SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(metadata), entityId);
    }

    // An explicit namespace applies to an entity that already exists, too.
    // This used to be creation-only — the parameter was accepted, ignored and
    // reported as success, so `remember` with `namespace: "team"` on an
    // existing memory left it in `personal` and said it had stored it, and
    // `import --namespace` did not do the forcing its documentation promised.
    // Only an explicitly supplied value moves anything: `undefined` means the
    // caller said nothing, and a re-remember must not drag an entity back to
    // the `personal` default.
    //
    // A move records where it came from. Nothing else does: `RememberResult`
    // had no namespace field, no backup is taken, and the entity's own row is
    // overwritten — so a move made by mistake (an agent filling in an optional
    // field it saw a default for) was undoable only by a user who happened to
    // remember the old value. `previous_namespace` makes it undoable from the
    // row itself. Recorded only when the namespace actually CHANGES, so
    // re-remembering into the same scope does not rewrite metadata.
    const previousNamespace = row.namespace ?? 'personal';
    const requestedNamespace = opts?.namespace;
    if (!isNewEntity && requestedNamespace !== undefined && requestedNamespace !== previousNamespace) {
      this.db
        .prepare('UPDATE entities SET namespace = ? WHERE id = ?')
        .run(requestedNamespace, entityId);
      this.updateEntityMetadata(name, (meta) => ({
        ...meta,
        previous_namespace: previousNamespace,
        namespace_moved_at: new Date().toISOString(),
      }));
    }

    // Reactivate archived entities on re-remember
    const wasArchived = !isNewEntity && row.status === 'archived';
    if (wasArchived) {
      this.db
        .prepare("UPDATE entities SET status = 'active' WHERE name = ?")
        .run(name);
    }

    // For existing entities, capture current obs text to delete the old FTS
    // entry before the rebuild. For new entities there is no prior entry, so
    // the delete is skipped.
    //
    // A previously ARCHIVED entity used to be lumped in with the new ones,
    // on the reasoning that "the FTS entry was already removed by
    // archiveEntity". Only `archiveEntity` removes it. `compressWeeklyNoise`,
    // the dreamer's compaction apply and `splitFusedLessons` all archived with
    // a bare UPDATE, and a row archived by any of those still had its FTS
    // entry — so re-remembering it INSERTED A SECOND DOCUMENT AT THE SAME
    // ROWID. That is not a duplicate you can clean up later: `entities_fts` is
    // contentless, a delete must repeat the exact text that was indexed, and
    // after the second insert the only text any future delete can reconstruct
    // is the SECOND one's. The first document's tokens become permanently
    // unremovable, and keyword search goes on answering with them. Measured on
    // the maintainer's graph: 213 archived entities were still in the index,
    // every one of them a live candidate for this.
    //
    // Reading the text unconditionally is correct for BOTH archived cases.
    // Archiving never touches observations, so this IS the text that was
    // indexed at archive time; and when the entity was archived through
    // `archiveEntity` and genuinely has no FTS row, `removeFromFts` classes
    // the miss as benign and does nothing.
    const prevObs = isNewEntity
      ? []
      : (this.db
          .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
          .all(entityId) as { content: string }[]);

    // Confidence policy on re-assertion. Three takes, each driven by
    // review feedback:
    //
    //   1. First take: bump on every re-call. Codex caught it as a
    //      pump-attack — every internal caller (auto-tagger, importer,
    //      tight loop) would inflate confidence with no truth value
    //      added.
    //   2. Second take: never bump from createEntity, only from
    //      explicit `learn`. (A successful `consolidate` also reached
    //      here until that tool was retired.) Codex caught
    //      THAT as a one-way decay regression for LLM-free installs.
    //   3. Third take: bump on new observations only. Codex caught
    //      THAT as still permitting untrusted sources (importer,
    //      auto-learned lessons) to lift confidence.
    //
    // Resolved: bump only when (a) the entity already exists and is
    // not being reactivated from archive, (b) the call introduces a
    // brand-new observation string, AND (c) the metadata trust signal
    // is 'trusted' (the default for explicit MCP/HTTP/CLI remember
    // calls). Untrusted sources — `importMemories(append/overwrite)`,
    // `createLesson` (failure-analyzer auto-learned), and any future
    // caller that sets `trustOverride: 'untrusted'` — explicitly
    // opt out of confidence lift.
    if (!isNewEntity && !wasArchived) {
      const prevSet = new Set(prevObs.map((o) => o.content));
      const introducesNewObservation = (opts?.observations ?? []).some(
        (o) => !prevSet.has(o),
      );
      // Trust signal lookup. Direct callers may set
      // `opts.trustOverride` (the canonical channel — used by
      // `operations.remember()` after Codex flagged the original
      // metadata-only path). Some callers still pass the trust value
      // inside `opts.metadata.trust`; honor that as a fallback so
      // `kg.createEntity({ metadata: { trust: 'untrusted' } })` still
      // works for direct test fixtures.
      const trustFromMetadata =
        opts?.metadata && typeof opts.metadata === 'object'
          ? (opts.metadata as { trust?: unknown }).trust
          : undefined;
      const incomingTrust = opts?.trustOverride ?? trustFromMetadata;
      const isTrusted = incomingTrust === undefined || incomingTrust === 'trusted';
      if (introducesNewObservation && isTrusted) {
        this.db
          .prepare('UPDATE entities SET confidence = MIN(confidence + 0.05, 1.0) WHERE id = ?')
          .run(entityId);
      }
    }
    const prevObsText = isNewEntity
      ? undefined
      : joinIndexedObservations(prevObs.map((o) => o.content));

    // Add observations — never store the same sentence twice on one entity
    // (#240). The hooks' shared `captureEntity` (scripts/hooks/_shared.js)
    // already guards on CONTENT for the same reason; this append branch is
    // this function's own writer path and had no guard at all, so every
    // non-hook caller that appends repeatedly — `remember()`/`setTaskState()`
    // (a field that gets set and cleared several times writes the identical
    // "next cleared" string every time), `importMemories`, the weekly-summary
    // compressor in lifecycle.ts — could regrow the exact duplicate-row shape
    // #240 was fixed for. The guard is on CONTENT, not existence, so a
    // genuinely new observation still lands even when the entity already has
    // others: only an exact repeat of stored text is dropped.
    //
    // NOT reusing `prevObs` here even though it looks like the same set: it
    // is forced to `[]` for a reactivated entity (`isNewEntity || wasArchived`
    // above) because `archiveEntity` already removed the FTS row and there is
    // nothing to un-index. It does NOT delete `observations` rows — `forget()`
    // "never permanently deletes data" — so a re-remember of an archived
    // entity would see no prior content and re-insert every observation as a
    // duplicate, the exact defect this guard exists to close. The dedup set
    // is therefore its own query, keyed on `isNewEntity` alone.
    //
    // EXCLUDED: the lesson family — `lesson_learned`, `lesson`, `mistake`,
    // the same three types `dedupeObservations` and its invariant exclude
    // (src/storage/graph-repairs.ts, scripts/audit/memory-invariants.mjs) —
    // for the reason those comments give: `groupLessons` there and the
    // dashboard's `parseStructuredBlocks` (LessonCards.tsx) read a lesson
    // entity's observations as ORDERED BLOCKS cut at each `Error: ` line, not
    // as a bag of sentences. Re-submitting the SAME error text is the
    // intended accumulate/reconfirm path (lesson-engine.ts:92): a second
    // `learn(error: "X", fix: "B")` after `learn(error: "X", fix: "A")`
    // appends a second `Error: X` block with a different `Fix:` line. A
    // content guard would see the second `Error: X` as a repeat of the
    // first, drop it, and fuse both blocks into one — silently discarding
    // `Fix: A`. Every OTHER type's reader selects `content` alone with no
    // ordering, so a repeat there is genuinely inert.
    //
    // The membership check reads the entity's STORED type (`row.type`) for
    // an existing entity, never the incoming `type` argument: `INSERT OR
    // IGNORE` above is a no-op on a name collision, so the row's real type
    // never changes on re-remember (pinned by "should ... preserve original
    // type on duplicate entity" above) — but `type` still holds whatever
    // string this call passed. A caller is free to pass any 1-100 char
    // string (`transports/schemas.ts`'s `type: z.string().min(1).max(100)`,
    // no enum), so re-remembering an existing lesson under some OTHER type
    // string would have made this check take the non-lesson branch and run
    // content dedup against ordered lesson blocks anyway — silently dropping
    // a repeated `Root cause:`/`Fix:`/`Prevention:` line the lesson family is
    // exempted specifically to keep. `isNewEntity` still uses the incoming
    // `type` because there is no stored type yet to read.
    if (opts?.observations?.length) {
      const insertObs = this.db.prepare(
        'INSERT INTO observations (entity_id, content) VALUES (?, ?)'
      );
      const effectiveType = isNewEntity ? type : row.type;
      const isLessonFamily = effectiveType === 'lesson_learned' || effectiveType === 'lesson' || effectiveType === 'mistake';
      if (isLessonFamily) {
        for (const obs of opts.observations) {
          insertObs.run(entityId, obs);
        }
      } else {
        const existingObsContent = new Set(
          isNewEntity
            ? []
            : (this.db
                .prepare('SELECT content FROM observations WHERE entity_id = ?')
                .all(entityId) as { content: string }[]
              ).map((o) => o.content)
        );
        for (const obs of opts.observations) {
          if (existingObsContent.has(obs)) continue;
          existingObsContent.add(obs);
          insertObs.run(entityId, obs);
        }
      }
    }

    // Always rebuild FTS so the entity name is indexed (even without observations)
    this.rebuildFts(entityId, name, prevObsText, previousTitle);

    // Add tags
    if (opts?.tags?.length) {
      const insertTag = this.db.prepare(
        'INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?, ?)'
      );
      for (const tag of opts.tags) {
        insertTag.run(entityId, tag);
      }
    }

    return entityId;
  }

  createEntitiesBatch(entities: CreateEntityInput[]): void {
    const txn = this.db.transaction(() => {
      for (const e of entities) {
        this.createEntity(e.name, e.type, {
          observations: e.observations,
          tags: e.tags,
          metadata: e.metadata,
          namespace: e.namespace,
        });
      }
    });
    txn();
  }

  createRelation(
    fromName: string,
    toName: string,
    relationType: string,
  ): void {
    const fromRow = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(fromName) as { id: number } | undefined;
    const toRow = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(toName) as { id: number } | undefined;

    if (!fromRow) {
      throw new Error(`Entity not found: ${fromName}`);
    }
    if (!toRow) {
      throw new Error(`Entity not found: ${toName}`);
    }

    // The relations.metadata column was never written by any caller and
    // has been retired (SDD G3). The column itself stays in the SQLite
    // schema for compatibility with older databases; we just stop binding
    // anything to it.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO relations (from_entity_id, to_entity_id, relation_type) VALUES (?, ?, ?)'
      )
      .run(fromRow.id, toRow.id, relationType);
  }

  getEntity(name: string): Entity | null {
    const row = this.db
      .prepare(
        'SELECT id, name, title, type, created_at, metadata, status, access_count, last_accessed_at, confidence, namespace, recall_hits, recall_misses FROM entities WHERE name = ?'
      )
      .get(name) as EntityRow | undefined;

    if (!row) return null;

    const observations = (this.db
      .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
      .all(row.id) as Array<{ content: string }>)
      .map((o) => o.content);

    const tags = (this.db
      .prepare('SELECT tag FROM tags WHERE entity_id = ?')
      .all(row.id) as Array<{ tag: string }>)
      .map((t) => t.tag);

    const relations = this.getRelations(name);

    return {
      id: row.id,
      name: row.name,
      title: row.title,
      type: row.type,
      created_at: row.created_at,
      metadata: row.metadata ? this.parseMetadata(row.metadata) : undefined,
      observations,
      tags,
      relations: relations.length > 0 ? relations : undefined,
      ...(row.status === 'archived' ? { archived: true } : {}),
      access_count: row.access_count ?? 0,
      last_accessed_at: row.last_accessed_at ?? undefined,
      confidence: row.confidence ?? 1.0,
      recall_hits: row.recall_hits ?? 0,
      recall_misses: row.recall_misses ?? 0,
      namespace: row.namespace ?? 'personal',
    };
  }

  getEntitiesByIds(
    ids: number[],
    opts?: { includeArchived?: boolean; namespace?: string; tag?: string }
  ): Entity[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const params: (string | number)[] = [...ids];

    // Build dynamic filters
    // Default behavior: include all (archived + active) unless explicitly excluded
    const statusFilter = opts?.includeArchived === false ? "AND status != 'archived'" : '';
    const namespaceFilter = opts?.namespace ? 'AND namespace = ?' : '';
    if (opts?.namespace) params.push(opts.namespace);

    // Batch query 1: entities
    const entityRows = this.db
      .prepare(
        // `recall_hits` / `recall_misses` are selected because `rankEntities`
        // reads them. Without them the hydrator handed the scorer `undefined`
        // for both, `impactScore(0 ?? 0, 0 ?? 0)` returned 0.5 for every row,
        // and the impact factor — 10% of the ranking — was a constant. On a
        // real graph the true range is 0.037 to 0.750. `briefing.ts` hydrates
        // them and got real values; the recall path did not, so one scorer
        // behaved differently depending on who called it.
        `SELECT id, name, title, type, created_at, metadata, status, access_count, last_accessed_at, confidence, namespace, recall_hits, recall_misses
         FROM entities WHERE id IN (${placeholders}) ${statusFilter} ${namespaceFilter}`
      )
      .all(...params) as EntityRow[];

    // Index entity rows by id for fast lookup
    const entityMap = new Map<number, EntityRow>();
    for (const row of entityRows) {
      entityMap.set(row.id, row);
    }

    // Batch query 2: observations (ordered by id to match getEntity behavior)
    const obsRows = this.db
      .prepare(
        `SELECT entity_id, content FROM observations WHERE entity_id IN (${placeholders}) ORDER BY id`
      )
      .all(...ids) as Array<{ entity_id: number; content: string }>;

    const obsMap = new Map<number, string[]>();
    for (const row of obsRows) {
      if (!obsMap.has(row.entity_id)) obsMap.set(row.entity_id, []);
      obsMap.get(row.entity_id)!.push(row.content);
    }

    // Batch query 3: tags
    const tagRows = this.db
      .prepare(
        `SELECT entity_id, tag FROM tags WHERE entity_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ entity_id: number; tag: string }>;

    const tagMap = new Map<number, string[]>();
    for (const row of tagRows) {
      if (!tagMap.has(row.entity_id)) tagMap.set(row.entity_id, []);
      tagMap.get(row.entity_id)!.push(row.tag);
    }

    // Batch query 4: relations (from_entity_id perspective, matching getRelations)
    const relRows = this.db
      .prepare(
        `SELECT r.from_entity_id, e_from.name AS "from", e_to.name AS "to",
                r.relation_type AS type
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE r.from_entity_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ from_entity_id: number; from: string; to: string; type: string }>;

    const relMap = new Map<number, Relation[]>();
    for (const row of relRows) {
      if (!relMap.has(row.from_entity_id)) relMap.set(row.from_entity_id, []);
      relMap.get(row.from_entity_id)!.push({
        from: row.from,
        to: row.to,
        type: row.type,
      });
    }

    // Build Entity objects in input order, skipping missing ids
    const results: Entity[] = [];
    for (const id of ids) {
      const row = entityMap.get(id);
      if (!row) continue;

      const observations = obsMap.get(id) ?? [];
      const tags = tagMap.get(id) ?? [];
      const relations = relMap.get(id) ?? [];
      if (opts?.tag && !tags.includes(opts.tag)) continue;

      results.push({
        id: row.id,
        name: row.name,
        title: row.title,
        type: row.type,
        created_at: row.created_at,
        metadata: row.metadata ? this.parseMetadata(row.metadata) : undefined,
        observations,
        tags,
        relations: relations.length > 0 ? relations : undefined,
        ...(row.status === 'archived' ? { archived: true } : {}),
        access_count: row.access_count ?? 0,
        recall_hits: row.recall_hits ?? 0,
        recall_misses: row.recall_misses ?? 0,
        last_accessed_at: row.last_accessed_at ?? undefined,
        confidence: row.confidence ?? 1.0,
        namespace: row.namespace ?? 'personal',
      });
    }

    return results;
  }

  getRelations(entityName: string): Relation[] {
    const rows = this.db
      .prepare(
        `SELECT e_from.name AS "from", e_to.name AS "to", r.relation_type AS type
         FROM relations r
         JOIN entities e_from ON r.from_entity_id = e_from.id
         JOIN entities e_to ON r.to_entity_id = e_to.id
         WHERE e_from.name = ?`
      )
      .all(entityName) as Array<{ from: string; to: string; type: string }>;

    return rows.map((r) => ({
      from: r.from,
      to: r.to,
      type: r.type,
    }));
  }

  search(query?: string, opts?: SearchOptions): Entity[] {
    const limit = opts?.limit ?? 20;

    const countAsAccess = opts?.countAsAccess ?? true;

    if (!query || query.trim() === '') {
      if (opts?.tag) {
        return this.listRecentByTag(opts.tag, limit, opts?.includeArchived, opts?.namespace, countAsAccess);
      }
      return this.listRecent(limit, opts?.includeArchived, opts?.namespace, countAsAccess);
    }

    // Terms are OR-ed, not space-separated. A space is FTS5's implicit AND,
    // which required EVERY word of a question — "what", "did", "with" — to
    // appear in one memory, so a question asked in the user's own words matched
    // nothing. The invariant to preserve: terms are OR-ed and BM25 decides the
    // order. See the CHANGELOG entry for the measured effect.
    const ftsQuery = buildMatchExpression(this.db, query);
    if (ftsQuery === null) {
      // Nothing searchable in a query that was not itself empty — "???",
      // "@#$%", a lone emoji. Returning recent memories here answers a
      // question nobody asked and dresses it as a search result: the caller
      // cannot tell "here is what matched" from "I found no terms, have these
      // instead". The genuinely empty query is handled above and still lists
      // recent, which is its documented behaviour.
      return [];
    }

    // Contentless FTS5: columns return null, so join via rowid → entities.id
    // Archived entities are removed from FTS5 by archiveEntity(), so status filter is a safety net.
    //
    // Ordering is FTS5's `rank` (BM25), not `e.id DESC`. LIMIT decides which
    // rows survive to the multi-factor scorer, so ordering by id meant the
    // NEWEST matches survived and the best match was discarded before it could
    // ever be scored. Recency still counts — it is one of the five scoring
    // factors — but it no longer decides what gets scored.
    //
    // The tag filter is an EXISTS subquery rather than a join: a join against a
    // multi-row `tags` table needs SELECT DISTINCT to dedupe, and DISTINCT both
    // adds a temp B-tree and constrains what ORDER BY can reference. EXISTS
    // keeps this to one statement for every filter combination.
    // Parameter order is MATCH → tag → namespace → limit, matching the clause
    // order below; `tests/recall-relevance.test.ts` pins it.
    const statusFilter = opts?.includeArchived ? '' : "AND e.status = 'active'";
    const namespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
    const tagFilter = opts?.tag
      ? 'AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND t.tag = ?)'
      : '';
    const params: (string | number)[] = [ftsQuery];
    if (opts?.tag) params.push(opts.tag);
    if (opts?.namespace) params.push(opts.namespace);
    params.push(limit);
    let ftsRows: Array<{ id: number }>;
    try {
      ftsRows = this.db
        .prepare(
          `SELECT e.id FROM entities_fts f
           JOIN entities e ON e.id = f.rowid
           WHERE entities_fts MATCH ?
             ${tagFilter}
             ${statusFilter}
             ${namespaceFilter}
           -- e.id breaks BM25 ties. Ties are common — every row matching only
           -- the same single term scores identically — and LIMIT decides which
           -- of them survive to the multi-factor scorer, so without a
           -- tiebreaker the same query over the same corpus can return
           -- different memories run to run. Newest-first among equals is the
           -- same preference the rest of the scorer expresses.
           ORDER BY f.rank, e.id DESC
           LIMIT ?`
        )
        .all(...params) as Array<{ id: number }>;
    } catch (err) {
      // FTS5 syntax error from user query — return empty results
      if (err instanceof Error && err.message?.includes('fts5')) return [];
      throw err;
    }

    // Fetch full entities from FTS results (batch hydration)
    const ftsIds = ftsRows.map(r => r.id);
    const results = this.getEntitiesByIds(ftsIds, {
      includeArchived: opts?.includeArchived,
      namespace: opts?.namespace,
    });
    const seenIds = new Set(ftsIds);

    // When includeArchived is true, archived entities are not in FTS5 (removed by archiveEntity).
    // Supplement with a direct SQL search over archived entities' observations
    // and names. Archived rows are removed from FTS5 by archiveEntity(), so
    // this branch cannot use the index — but it must agree with the FTS branch
    // about what the user asked for. It therefore matches the SAME terms
    // buildMatchExpression() produced, OR-ed, rather than the raw query string:
    // interpolating the whole question meant an archived memory could only be
    // found by a literal substring of it, so a scattered-word question found
    // the active copy and missed the archived one, and a CJK query missed
    // entirely because it was never segmented.
    //
    // LIKE metacharacters in those terms are escaped. `%` and `_` are wildcards
    // here (unlike in the FTS branch, where the tokeniser has already discarded
    // them), so an unescaped query of `a%` would enumerate archived rows far
    // beyond what the user asked for.
    if (opts?.includeArchived) {
      const tagJoin = opts?.tag ? 'JOIN tags t ON t.entity_id = e.id' : '';
      const tagFilter = opts?.tag ? 'AND t.tag = ?' : '';
      const archivedNamespaceFilter = opts?.namespace ? 'AND e.namespace = ?' : '';
      const likeTerms = archivedLikeTerms(this.db, query);
      // `memesh_nfc(...)` on the STORED side. The terms are already NFC —
      // `tokenizeQuery` normalises — so without it this compared normalised
      // terms against raw storage, and a memory stored decomposed was findable
      // while active and unfindable once archived.
      registerNfcFunction(this.db);
      // `e.title` is in the clause for the same reason the whole branch
      // exists: the active side folds title into the FTS feed, so a memory
      // matched by its human title would otherwise be findable while active
      // and unfindable once archived. COALESCE because title is nullable —
      // memesh_nfc passes NULL through and NULL LIKE is three-valued NULL;
      // functionally falsy, but coalescing keeps the arm a plain boolean.
      const termClause = likeTerms
        .map(
          () =>
            `(${SQL_NFC_FUNCTION}(e.name) LIKE ? ESCAPE '\\' ` +
            `OR ${SQL_NFC_FUNCTION}(COALESCE(e.title, '')) LIKE ? ESCAPE '\\' ` +
            `OR ${SQL_NFC_FUNCTION}(o.content) LIKE ? ESCAPE '\\')`
        )
        .join(' OR ');
      const archivedParams: (string | number)[] = likeTerms.flatMap((t) => [t, t, t]);
      if (opts?.tag) archivedParams.push(opts.tag);
      if (opts?.namespace) archivedParams.push(opts.namespace);

      const archivedRows = this.db
        .prepare(
          `SELECT DISTINCT e.id, e.name
           FROM entities e
           LEFT JOIN observations o ON o.entity_id = e.id
           ${tagJoin}
           WHERE e.status = 'archived'
             AND (${termClause})
             ${tagFilter}
             ${archivedNamespaceFilter}
           ORDER BY e.id DESC
           LIMIT ?`
        )
        .all(...archivedParams, limit) as Array<{ id: number; name: string }>;

      const archivedIds = archivedRows.map(r => r.id).filter(id => !seenIds.has(id));
      const archivedEntities = this.getEntitiesByIds(archivedIds, {
        includeArchived: true,
        namespace: opts?.namespace,
      });
      results.push(...archivedEntities);
    }

    // Access only. `recall_hits` belongs to the Stop hook, which is the one
    // place that can tell whether an injected memory was USED — see
    // storage/conflicts.ts::trackAccess.
    if (countAsAccess) this.trackAccess(results.map((e) => e.id));
    return results;
  }

  /**
   * Increment access_count and update last_accessed_at for entities.
   * Called after search/recall returns results.
   * Delegates to storage/conflicts.ts::trackAccess for shared use.
   */
  trackAccess(entityIds: number[]): void {
    trackAccess(this.db, entityIds);
  }

  /**
   * Find contradicting entity pairs in a set of results.
   * Delegates to storage/conflicts.ts::findConflicts.
   */
  findConflicts(entityNames: string[]): string[] {
    return findConflicts(this.db, entityNames);
  }

  listRecent(limit?: number, includeArchived?: boolean, namespace?: string, countAsAccess = true): Entity[] {
    const statusFilter = includeArchived ? '' : "AND status = 'active'";
    const namespaceFilter = namespace ? 'AND namespace = ?' : '';
    const params: (string | number)[] = [];
    if (namespace) params.push(namespace);
    params.push(limit ?? 20);
    const rows = this.db
      .prepare(`SELECT id FROM entities WHERE 1=1 ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
      .all(...params) as { id: number }[];

    // Batch-hydrate instead of getEntity()-in-a-loop (4 queries per row →
    // 4 queries total). getEntitiesByIds preserves input order, so the
    // ORDER BY id DESC above is retained.
    const results = this.getEntitiesByIds(
      rows.map((r) => r.id),
      { includeArchived, namespace }
    );

    if (countAsAccess) this.trackAccess(results.map((e) => e.id));
    return results;
  }

  /**
   * List active (or all) entities of one type, most-recent first. The storage
   * counterpart of the raw `SELECT ... WHERE type = ?` the HTTP transport used
   * to hand-roll — keeps the status/ordering semantics in one place and batch-
   * hydrates via getEntitiesByIds. Does NOT trackAccess (a type browse is a
   * catalogue read, matching the prior transport behavior).
   */
  listByType(type: string, limit?: number, includeArchived?: boolean, namespace?: string): Entity[] {
    const statusFilter = includeArchived ? '' : "AND status = 'active'";
    const namespaceFilter = namespace ? 'AND namespace = ?' : '';
    const params: (string | number)[] = [type];
    if (namespace) params.push(namespace);
    params.push(limit ?? 20);
    const rows = this.db
      .prepare(`SELECT id FROM entities WHERE type = ? ${statusFilter} ${namespaceFilter} ORDER BY id DESC LIMIT ?`)
      .all(...params) as { id: number }[];
    return this.getEntitiesByIds(
      rows.map((r) => r.id),
      { includeArchived, namespace }
    );
  }

  private listRecentByTag(tag: string, limit: number, includeArchived?: boolean, namespace?: string, countAsAccess = true): Entity[] {
    const statusFilter = includeArchived ? '' : "AND e.status = 'active'";
    const namespaceFilter = namespace ? 'AND e.namespace = ?' : '';
    const params: (string | number)[] = [tag];
    if (namespace) params.push(namespace);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT e.id
         FROM entities e
         JOIN tags t ON t.entity_id = e.id
         WHERE t.tag = ?
         ${statusFilter}
         ${namespaceFilter}
         ORDER BY e.id DESC
         LIMIT ?`
      )
      .all(...params) as { id: number }[];

    // Batch-hydrate (see listRecent) — order-preserving, same fields/filters.
    const results = this.getEntitiesByIds(
      rows.map((r) => r.id),
      { includeArchived, namespace }
    );

    if (countAsAccess) this.trackAccess(results.map((e) => e.id));
    return results;
  }

  /**
   * Clear all observations and tags for an entity without deleting the entity row.
   * Used by overwrite import to start fresh before re-adding data.
   */
  clearEntityData(name: string): void {
    const row = this.db
      .prepare('SELECT id, title FROM entities WHERE name = ?')
      .get(name) as { id: number; title: string | null } | undefined;
    if (!row) return;

    // Capture current observations text for FTS delete before clearing.
    // ALWAYS a string, never undefined-on-empty: createEntity indexes
    // name+title even for a zero-observation entity, so an FTS row exists —
    // the old `length > 0 ? text : undefined` skipped the delete for exactly
    // that case, and an overwrite-import of an observation-less entity
    // double-inserted the same rowid into the index. If the entity truly has
    // no FTS row (archived, pre-index era), `removeFromFts` skips the delete
    // because the rowid is not indexed.
    //
    // That last sentence used to read "removeFromFts's benign-error class
    // absorbs the miss", and it was not true: on SQLite 3.51.3 a contentless
    // delete with no row to match either does nothing OR — when the same
    // (rowid, text) was already deleted — raises `database disk image is
    // malformed`, which that class deliberately does NOT absorb. The check
    // now lives in `removeFromFts` itself, before the delete.
    const prevObsText = indexedObservationText(this.db, row.id);

    // One transaction, for the same reason archiveEntity has one: these four
    // writes are a single act. A throw between the observation delete and the
    // FTS rebuild leaves indexed text for observations that are gone —
    // keyword search answering for content nobody can read.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM observations WHERE entity_id = ?').run(row.id);
      this.db.prepare('DELETE FROM tags WHERE entity_id = ?').run(row.id);
      // Rebuild FTS with empty content (removes old indexed text). title is
      // untouched by this method, so the same value goes in on both sides.
      this.rebuildFts(row.id, name, prevObsText, row.title);
      // And drop the vector, for the same reason the FTS text is dropped: it
      // encodes observations that no longer exist. The keyword index was
      // cleared here from the start; the vector was not, so every caller of
      // this method — `--merge overwrite` on import, and the memory tool's
      // `rewriteObservations` — left the entity semantically matching its OLD
      // text. A memory edited to say the opposite of what it used to say
      // still came back for the old query, with the new text attached.
      //
      // Deleted rather than re-embedded: embedding is a network call and this
      // is a synchronous graph mutation. NO vector is a state the system
      // already knows how to see (`countMissingVectors`) and already knows
      // how to fix (`memesh reindex`); a WRONG vector is neither.
      removeVectorRow(this.db, row.id);
    })();
  }

  archiveEntity(name: string): { archived: boolean; name?: string; previousStatus?: string } {
    const row = this.db
      .prepare('SELECT id, status, title FROM entities WHERE name = ?')
      .get(name) as { id: number; status: string; title: string | null } | undefined;

    if (!row) return { archived: false };

    // One transaction, because a partial archive is worse than a failed one.
    //
    // These ran in autocommit. The FTS delete committed, the vector delete
    // threw `no such module: vec0` (see hasVectorIndex — the catalogue check
    // could not tell a loaded extension from a leftover table row), and the
    // status update never ran. The memory was left ACTIVE and unindexed:
    // invisible to keyword search, invisible to the archived-supplement
    // branch (which filters on status='archived'), and invisible to
    // `includeArchived`. Retrying threw again forever. Only `reindex --fts`
    // recovered it, and nothing told the user it existed.
    //
    // hasVectorIndex now answers the process question, so the throw should
    // not recur — but the atomicity is what makes a future throw survivable
    // rather than data-destroying, and that is worth having independently.
    this.db.transaction(() => {
      dropEntityFromIndexes(this.db, row.id, name);

      this.db
        .prepare("UPDATE entities SET status = 'archived' WHERE id = ?")
        .run(row.id);
    }).immediate();

    return { archived: true, name, previousStatus: row.status };
  }

  removeObservation(
    entityName: string,
    observationContent: string
  ): { removed: boolean; remainingObservations: number; entityFound: boolean } {
    // Read the indexed text under the same write lock as the deletion: FTS
    // and vectors must not outlive the observation they describe.
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, title, status FROM entities WHERE name = ?')
        .get(entityName) as { id: number; title: string | null; status: string } | undefined;

      // `entityFound` exists because "no such entity" and "that text does not
      // match any observation" are different problems with opposite next steps,
      // and the caller could not tell them apart: both arrived as
      // `removed: false`, and the CLI printed "Entity not found" for the second
      // one — sending the user to re-create a memory that was sitting right there.
      if (!row) return { removed: false, remainingObservations: 0, entityFound: false };

      const prevObs = this.db
        .prepare('SELECT content FROM observations WHERE entity_id = ? ORDER BY id')
        .all(row.id) as { content: string }[];
      const prevObsText = joinIndexedObservations(prevObs.map((o) => o.content));

      const deleteResult = this.db
        .prepare('DELETE FROM observations WHERE entity_id = ? AND content = ?')
        .run(row.id, observationContent);

      if (deleteResult.changes === 0) {
        return { removed: false, remainingObservations: prevObs.length, entityFound: true };
      }

      if (row.status !== 'archived') {
        this.rebuildFts(row.id, entityName, prevObsText, row.title);
      }
      removeVectorRow(this.db, row.id);

      const remaining = this.db
        .prepare('SELECT COUNT(*) as c FROM observations WHERE entity_id = ?')
        .get(row.id) as { c: number };

      return { removed: true, remainingObservations: remaining.c, entityFound: true };
    }).immediate();
  }

  /**
   * Hard-delete an entity by name. Cleans the FTS5 entry, the
   * sqlite-vec embedding row, then DELETE FROM entities — the
   * foreign-key cascade handles observations, tags, and relations.
   *
   * Prefer `archiveEntity()` for user-facing forget flows: archiving
   * preserves the row for restore + analytics. This hard delete is
   * the right tool only when the entity should not exist at all
   * (e.g. demo cleanup after `memesh demo --reset`).
   *
   * Both index sides matter: FTS5 is contentless and needs the
   * original observations to locate its row, and `entities_vec` is
   * a separate virtual table whose rows are not cascaded by the
   * `entities` FK — leaving them behind shows up as orphan
   * embeddings on later vector searches.
   */
  deleteEntity(name: string): { deleted: boolean } {
    const row = this.db
      .prepare('SELECT id, title FROM entities WHERE name = ?')
      .get(name) as { id: number; title: string | null } | undefined;

    if (!row) return { deleted: false };

    // Delete FTS entry first (contentless FTS5 requires the original
    // indexed values to find the row — see storage/fts-index.ts).
    // One transaction, same reason as archiveEntity: in autocommit the FTS
    // delete committed and a throw on the vector delete left the entity row
    // in place but out of the index — a permanent orphan that no search could
    // reach and no retry could clear.
    this.db.transaction(() => {
      // Same pair as archiveEntity, through the same owner, so a hard delete
      // cannot leak orphan embeddings while an archive does not.
      dropEntityFromIndexes(this.db, row.id, name);

      // CASCADE handles observations, relations, tags.
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(row.id);
    }).immediate();

    return { deleted: true };
  }

  private parseMetadata(rawMetadata: string | null): Record<string, unknown> {
    if (!rawMetadata) return {};
    try {
      const parsed = JSON.parse(rawMetadata);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  /**
   * `previousTitle` must be the title as it stood BEFORE whatever change
   * triggered this rebuild — same rule as `previousObsText` — because a
   * contentless FTS5 delete has to match the exact values that were
   * indexed. The insert side always re-reads the entity's CURRENT title
   * from the DB rather than trusting a caller-supplied "new" value, so a
   * title UPDATE that already landed before this call (see createEntity)
   * is picked up correctly with no risk of the two getting out of sync.
   */
  private rebuildFts(
    entityId: number,
    entityName: string,
    previousObsText?: string,
    previousTitle?: string | null
  ): void {
    if (previousObsText !== undefined) {
      removeFromFts(this.db, entityId, entityName, previousObsText, previousTitle);
    }
    const obsText = indexedObservationText(this.db, entityId);
    const currentTitleRow = this.db
      .prepare('SELECT title FROM entities WHERE id = ?')
      .get(entityId) as { title: string | null } | undefined;
    insertFtsRow(this.db, entityId, entityName, obsText, currentTitleRow?.title ?? null);
  }
}
