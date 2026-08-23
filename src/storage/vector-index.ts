// =============================================================================
// entities_vec — presence, not assumption
// =============================================================================
//
// `sqlite-vec` ships its actual engine as a per-platform loadable file
// (`vec0.dylib` / `.so` / `.dll`) through `optionalDependencies`. On a platform
// it does not publish — musl/Alpine, FreeBSD, an unusual arch — npm installs
// the JS wrapper, installs no binary, and says nothing.
//
// memesh's documented design has always been that vector search SUPPLEMENTS
// FTS5 keyword recall: "without an embedder, recall runs on FTS5 keyword search
// alone" appears in the README, in `reindex()`'s error text, and in the doctor
// rows. The code did not match. `openDatabase` loaded the extension with no
// catch, so on those platforms `sqliteVec.load()` threw, `initialiseDatabase`
// threw, and `memesh remember` died with a raw ERR_MODULE_NOT_FOUND stack
// trace. Measured, not assumed: hiding `sqlite-vec-darwin-arm64` made both
// `remember` and `recall` exit 1 with an unhandled module-resolution error.
//
// So a supplement was a hard startup requirement, and the failure had no
// diagnosis attached. This module is how that stops: the extension load is
// allowed to fail, and every site that touches `entities_vec` asks first.
//
// The question is answered from `sqlite_master` rather than from a boolean
// remembered at open time. A flag is a claim about the past; the catalogue is
// the fact, and this repository has been bitten more than once by trusting the
// claim. The lookup is one indexed read against a table with a handful of rows,
// on paths that are already doing an FTS query or an embedding round-trip.

import type { MemeshDatabase } from './sqlite.js';

/**
 * Does this database have a usable `entities_vec` table IN THIS PROCESS?
 *
 * Touches the table rather than asking `sqlite_master`. Those are different
 * questions and the catalogue answers the wrong one: the row persists in the
 * FILE, so a database created where sqlite-vec loaded and later opened where
 * the platform binary is missing (musl, an unusual arch, `npm ci
 * --omit=optional`, a container image) passed the catalogue check and then
 * threw `no such module: vec0` on first touch.
 *
 * `conflict-candidates.ts` documents that exact trap and catches it — at one
 * of six call sites. The two that were not guarded are `archiveEntity` and
 * `deleteEntity`, where the throw landed between a committed FTS delete and
 * the status update, stranding the memory: active, so the archived-supplement
 * branch never sees it; absent from the index, so keyword search never sees
 * it. Answering the process question here removes the trap for every caller
 * instead of repeating the catch six times.
 *
 * Only the two "there is no vector index" errors are absence. Anything else —
 * a corrupt shadow table, a locked database — is a real fault and must
 * surface, because reporting it as "no index" would silently downgrade recall
 * to keyword-only and look like a configuration choice.
 */
export function hasVectorIndex(db: MemeshDatabase): boolean {
  try {
    db.prepare('SELECT 1 FROM entities_vec LIMIT 1').get();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such module: vec0|no such table/i.test(message)) return false;
    throw err;
  }
}
