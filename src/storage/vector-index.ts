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
 * Does this database have a usable `entities_vec` table?
 *
 * False means sqlite-vec is not loaded in this process — recall runs on FTS5
 * alone, and nothing should attempt a vector read or write.
 */
export function hasVectorIndex(db: MemeshDatabase): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entities_vec'")
    .get();
  return row !== undefined;
}
