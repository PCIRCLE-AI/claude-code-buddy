# Changelog

All notable changes to MeMesh are documented here.

## [Unreleased]

### Added

- **Anthropic memory tool (`memory_20250818`) backed by the knowledge graph** (`src/core/memory-tool.ts`, exported from the package root) — for applications that call the **Messages API directly** rather than through MCP. Claude gets a memory tool whose storage is MeMesh instead of a folder of text files, so it also gets FTS5 search, multi-factor ranking, auto-decay, relations and namespaces without knowing they are there. Anthropic's contract states that `/memories` is "a prefix that your handler maps onto real storage, such as a per-user directory or keys in a database", so this is the documented shape of the integration rather than a workaround.

  Not a tenth MCP tool, and not on the HTTP or CLI surface. The nine MCP tools serve an agent that already speaks MeMesh; this serves an application that speaks only the Messages API. Folding them together would make one surface answer to two contracts.

  Each entity renders as one file whose lines are its observations, **ordered by observation id — insertion order, never score.** That is the load-bearing decision: `view` and the edit that follows it are separate turns, and between them one of the seven hooks can write a new observation. If the order the model saw came from a ranking, the line numbers it read would address different content by the time it sent them back — a silent wrong write rather than an error. An observation may itself contain newlines, so the line-to-memory map is computed from the rendered text rather than assumed one-to-one.

  Two behaviours differ from a filesystem on purpose. `delete` **archives**: the person whose memory it is did not ask for the deletion, a model did, so it disappears from the model's view and stays restorable from theirs. `str_replace` **refuses an ambiguous `old_str`** and returns the line numbers of every occurrence rather than editing the first match — it is a write, and the wrong one is silent.

  Three defects found by `/review` before merge, each reproduced before fixing. **A directory view no longer touches ranking state**: it went through `KnowledgeGraph.listRecent()`, which calls `trackAccess()` — and since the API injects "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE" into the system prompt, every conversation was incrementing `access_count` on every memory in the database (measured: 0 to 4 apiece after four views). `frequency` is 0.18 of the ranking score and `last_accessed_at` feeds `recency` at 0.25, so a read was flattening both signals and defeating auto-decay. Listings now query for the two facts they need and hydrate nothing. **`rename` no longer leaves the old name searchable**: `entities_fts` is contentless, so a delete must be issued with the text that was indexed; renaming the row first and rebuilding after deleted with the NEW name, matched nothing, and layered the new tokens on top of the old. Measured: after renaming `kangaroo-notes` to `wallaby-notes`, `MATCH kangaroo` still returned the row. The FTS row is now removed under the old name, then reinserted under the new one, in one transaction. **Writes are bounded**: 256 KB per memory and 16 000 characters per `view`, both required by the contract's security section.

  Path-traversal validation is on the implementer per Anthropic's own warning, and is enforced here even though nothing touches a filesystem: `..` cannot reach `secrets.env`, but it can resolve to a different namespace or memory than the one named. Refused: anything outside `/memories` (including `/memories-of-you/...`, which passes a naive `startsWith`), `.`/`..`/empty segments, `%2e%2e`, backslashes, NUL bytes, paths deeper than `namespace/memory`, unknown namespaces, writes to a directory, and deleting or renaming the root or a namespace.

- **`memesh doctor` now reports the runtime it is running on** (`src/core/doctor.ts`) — Node version, ABI, platform/arch, whether that version satisfies `package.json` `engines.node`, and whether the built-in `node:sqlite` module is present. A user below the supported floor previously saw hooks misbehaving and a red native-binding row with nothing anywhere naming the one fact that explains both. Below the floor the row FAILS with an upgrade instruction.

  The version comparison understands `>=X.Y.Z` and nothing else, on purpose: this row is allowed to fail, so a parser that guessed at `^`, `||` or `<` ranges would sometimes tell a healthy install it is broken. Anything it cannot parse is reported as "not checked", which is the true statement, and reported informationally so it cannot move `Overall`.

  The `node:sqlite` probe **resolves** the module rather than importing it. Measured on v22.23.2: `await import('node:sqlite')` prints `ExperimentalWarning: SQLite is an experimental feature` to stderr, and seven hooks parse process output — a diagnostic that caused the class of breakage it exists to diagnose. Everything the row prints is a machine fact, which matters because `memesh feedback` copies doctor summaries verbatim into a **public** GitHub issue body.

### Security

- **`ci.yml` declares `permissions: contents: read` instead of inheriting it** (`.github/workflows/ci.yml`) — it was the only workflow in the directory without its own block, so the job that checks out and runs pull-request code took whatever the repository-level default happened to be. That default is `read` today, which is why nothing was wrong; it is also a web-UI setting that can change with no diff, no commit and no review. Least privilege stated in the file that needs it.

### Changed

- **The supported Node floor is now `>=22.5.0`** (`package.json`, `package-lock.json`, `.github/workflows/*.yml`, all 11 `README*.md` badges, `CONTRIBUTING.md`) — **nothing was broken on Node 20.** All three of its OS legs were green the morning it was removed; this is a support-policy change, not a fix. Node 20 reached end of life on 2026-03-24, so the package was promising a runtime that receives no security patches, and the CI comment written when the matrix grew already set the condition for removal: *"the leg goes when the claim goes, not before."* The claim went.

  `22.5.0` rather than `22.0.0` because that is the release where `node:sqlite` became available. The floor is where a future migration off `better-sqlite3` needs it to be, and `memesh doctor`'s `node:sqlite` row can now state a fact about every supported runtime instead of one that is sometimes absent.

  Three jobs still pinned `node-version: '20'` after the matrix moved, and one of them was **`publish-npm.yml`** — the publish path would have run `prepublishOnly` → `verify:release` (which does `npm pack`, installs into a consumer tree, and audits it) on a runtime the package it was publishing declares unsupported. All five literal pins across the three workflows now read `'22'`.

  `tests/ci-matrix-covers-engines.test.ts` is what keeps them together from here: it fails if any workflow pins a Node below `engines.node`, **and** if no job runs the declared floor. The second half matters more than it looks — legs get deleted for wall-clock time, floors get raised on purpose, so "we claim 22.5 and test only 24" is the likelier accident, and it leaves the oldest runtime users are entitled to run as the one runtime nobody runs.

- **A test named "emits nothing on stderr" never read stderr** (`tests/core/node-runtime-check.test.ts`) — it used `execFileSync`, which returns **stdout**; piping stderr captures it and discards it on success. So the variable called `stderr` held the child's stdout, and the assertion that it was empty was true no matter how loudly the probe warned. Measured: a child that writes to stderr and exits 0 leaves the old assertion green. It now uses `spawnSync` and asserts on `result.stderr` and `result.status`, and the fix was mutation-verified **on Node 22** — the only line in the matrix where importing `node:sqlite` actually emits the `ExperimentalWarning` this guards against, so verifying anywhere else would have proved nothing. Caught by an independent review of the diff; it is the same defect class as the shipped bugs this stack fixes, in the test written to prevent them.

- **Node 26 broke every dashboard test that touches `localStorage`** (`vitest.config.ts`, `tests/setup/webstorage.ts`) — found by the new Node 26 CI leg on its first run, which is what it is for. Node 26 ships the Web Storage API, so `localStorage` exists as a global before any test environment is set up, and without `--localstorage-file` its value is `undefined`. vitest's happy-dom environment skips names that are already present, so under `@vitest-environment happy-dom` the window and the global are one object with an undefined `localStorage`, and five `OnboardingBanner` tests died on `Cannot read properties of undefined (reading 'clear')`. Measured broken on v26.5.1 and fine on v20.20.2 / v22.23.2 / v24.15.0; happy-dom 20.11.1, the newest release, does not change it.

  A setup file now installs happy-dom's own `Storage`, borrowed from a throwaway `Window`, so Node 26 exercises the same implementation as every other version instead of a hand-written stand-in — and only for DOM environments, so the `node`-environment suite keeps exactly the globals the real runtime gives it. `happy-dom` is loaded with a dynamic `import()` inside that branch: as a static import it would load in all ~90 node-environment files, which neither have a DOM nor want one, and a resolution failure there would take the node suite down before the guard could rule it out. `--no-experimental-webstorage` would have been tidier and was tried first: vitest replaces `poolOptions.forks.execArgv` with its own list so the flag never reaches the worker, and Node 20 rejects the flag outright.

- **CI now runs on every pull request, not only those landing on `main`/`develop`** (`.github/workflows/ci.yml`, `.github/workflows/codeql.yml`) — the `branches: [main, develop]` filter on `pull_request` reads as "test what reaches the trunk" and behaved as "skip anything stacked". A PR based on another feature branch got no Build & Test and no CodeQL, while `multi-model-review.yml` — which has no filter — still posted its reviews. Reviewed, never compiled, never scanned, and indistinguishable from healthy on a page of green checks. Found the honest way: by stacking a PR that changed the test matrix and watching the matrix not run on it. `push` still fires only for `main`/`develop`, so this costs one run per PR, not two.

- **CI tests Node 24, and Node 26 on Linux** (`.github/workflows/ci.yml`) — the matrix was `[20, 22]`, so Krypton, the LTS line released over a year ago, had no coverage at all. Node 20 reached end of life on 2026-03-24 and was still tested at the time, because `engines` still said `>=20`; the leg goes when the claim goes, not before. Both went, in the entry above, before either shipped.

  Node 26 is Linux-only, and the reason is worth recording: **`better-sqlite3@12.9.0` publishes no prebuilt binary for Node 26's ABI (147)**. Measured — `prebuild-install warn install No prebuilt binaries found (target=26.5.1 runtime=node arch=arm64 platform=darwin)`, followed by a `node-gyp rebuild` that succeeded in 18s on macOS/arm64. It works, but it needs a full toolchain (MSVC on Windows), so one Linux leg buys early warning without paying for a source build on three runners. The same gap has a user-facing edge: a plugin-marketplace install runs with `--ignore-scripts`, so on Node 26 there is neither a prebuild to download nor a build step to run.

### Fixed

- **`consolidate` could destroy every observation on an entity and report that nothing had happened** (`src/core/consolidator.ts`, `src/core/types.ts`, `src/transports/cli/cli.ts`) — it removed the originals in a loop of `removeObservation()` calls that each committed on their own, then wrote the replacement, with a bare `catch` around the pair. Anything that made the replacement throw — a closed database, a full disk, a `SIGINT` between the two — left the entity permanently empty. Measured, with `createEntity` made to fail the way any of those would:

  ```
  OBSERVATIONS LEFT ON DISK : 0 []
  REPORTED observations_after: 6
  REPORTED error             : (none)
  ```

  Six observations gone, and a result whose numbers say the entity was untouched, because the `catch` added the original count to `observations_after` and returned no error. The doc comment on the function promised "if the LLM fails or produces no shorter result, the entity is left unchanged"; that promise held for the LLM failure it anticipated and not for the write failure it did not.

  The swap is now one transaction, so an entity has either its new observations or its old ones. `ConsolidateResult` carries `failed`, because "0 consolidated" and "0 consolidated, 3 failed" are different answers and only one of them means there is nothing to do — the same shape `reindex` gained above. The CLI checks `failed` **before** printing the "nothing met the threshold" advice, which until now was shown for every zero, sending the user to lower `--min-obs` when the cause was a failed write.

- **`consolidate` ignored pins, and promoted anything it summarised to full confidence** (`src/core/consolidator.ts`, `src/transports/cli/cli.ts`) — two ways it acted on memories nobody had asked it to touch. A pin is the user saying *do not touch this*; `dreamer` has always honoured it (`metadata.pin === true`) and this path did not, so `memesh consolidate` with no arguments compressed pinned entities along with everything else in `listRecent(100)`. Pinned entities are now skipped and named back in `skipped_pinned`, so "nothing to do" cannot be read as "refused to touch what you pinned". The `pin`/`unpin` command descriptions said "the dreamer" and now say what is true of both.

  Separately, a successful compression ran `UPDATE entities SET confidence = 1.0`. Compression removes text; it adds no evidence. Everywhere else confidence moves in small increments for real re-confirmation and decays with age, so the reset erased that entire history — and since `consolidate` is an MCP tool the model itself can call, a model could raise its own memories to maximum confidence (0.17 of the ranking score) by asking for them to be summarised. Deleting the reset was not sufficient on its own: `createEntity()` treats a write to an existing entity as re-confirmation and applies `+0.05` (measured: 0.4 became 0.45). Consolidation is now held confidence-neutral inside the transaction.

  Still true, and recorded rather than guessed at: the only acceptance test on the LLM's output is that it returned *fewer strings* than it was given. Any character-ratio threshold to replace that would be a number with no evidence behind it. `consolidate` also remains the unguarded sibling of `dreamer`, which stages the same kind of destructive rewrite in `dream_proposals` for human review — whether that gap closes by adopting the proposal flow or by retiring the tool is a product decision, not a defect fix.

- **`memesh reindex --vectors` no longer deletes every embedding on the word of a config file** (`src/core/embedder.ts`, `src/db.ts`, `src/transports/cli/cli.ts`) — the consent gate refused to authorise the drop unless something could refill the index afterwards, and asked `isEmbeddingAvailable()`. That function reports which provider the config *names*: for `openai` and `ollama` it returns `true` without checking a key, reaching an endpoint, or comparing a dimension. An expired key, a key typed after the provider name, or a stopped Ollama therefore authorised dropping every vector in the database, and the refill then wrote nothing back. The precondition is now `canRefillVectorIndex()`, which embeds one string and measures the result against the width the table is about to be declared with — a proof rather than a claim. `allowVectorIndexRebuild` is async as a result, and the refusal message now names what to check.

- **Consent to rebuild the vector index is bound to the database it was granted for** (`src/db.ts`) — it was a module-level boolean, so in the HTTP server, or any process that opens more than one database, a grant recorded for A could be spent by an unrelated `openDatabase(B)` that ran first. B's vectors, never consented to and never asked about, would be the ones dropped. The grant now records a resolved path and is refused for any other.

- **A reindex that regenerated nothing no longer reports success** (`src/core/operations.ts`, `src/transports/cli/cli.ts`) — the end-state check asked "does every entity have a vector", which a full index satisfies with the *stale* vectors the run was asked to replace. So when a provider switch made every write fail, `countMissingVectors` returned 0, the reindex-needed flag was cleared, `✅ Reindex complete` printed, and the command exited `0` — in exactly the situation it exists for. `ReindexResult` now carries `failed`, and the verdict, the exit code and the flag all require both halves: every memory holds a vector *and* every attempted write landed. Entities whose observations are all whitespace are counted separately (`nothing_to_embed`) so they cannot hold the flag open forever, matching the exclusion `countMissingVectors` already made.

- **The dashboard's auth field reports itself invalid for a rejected token, not only an empty one** (`dashboard/src/components/AuthPrompt.tsx`) — the rejected branch rendered a `role="alert"` message but left `aria-invalid="false"` and no `aria-describedby`, so a screen-reader user heard the announcement and then found a control that disagreed with it. Both messages now own one stable id and both reach the field.

## [4.2.11] — 2026-07-29

This release exists because the headline benchmark figure was measuring the
wrong code. `benchmarks/longmemeval/run.mjs` carried its own table creation,
its own FTS5 query building and its own ranking, so the published **95.40% R@5**
scored that reimplementation and not the product. Measured through the function
a real `recall` call actually reaches, the same 500 questions scored **5.20%**,
with 473 of them returning nothing at all. Four compounding retrieval defects
were each hiding the others.

Everything below follows from that: the defects are fixed, the benchmark now
runs through the shipped path, and every published claim that no longer matched
the code has been corrected against source. The number is now **95.60%**, and it
is the product's number.

Auditing for the same shape turned up two more places reporting success without
doing the work, and both are fixed here. `verify_agent_work` returned
`pass: true` when given nothing to check against — so `memesh verify … && deploy`
deployed on a check that never ran — and the dashboard's auth screen carried
translation fallbacks that could never execute. The common root cause is an
optimistic default: `?? true` and `|| 'fallback'` turn a missing input into a
reported success, when the honest answer is "not checked".

Upgrading rebuilds the full-text index once, on first open, to add CJK
segmentation. Existing memories are re-indexed from the entity and observation
rows, which are never touched — nothing is deleted and nothing needs re-entering.

### Performance

- **A query term present in most of the corpus no longer drags the whole index into the scan** (`src/knowledge-graph.ts`, `src/db.ts`, `scripts/hooks/_shared.js`) — query terms are OR-ed, so the cost of a search is the union of their postings and one ubiquitous word dominates it. `dropUbiquitousTerms()` removes terms appearing in more than half the indexed rows, using a new `fts_vocab` (`fts5vocab`) view that stores nothing of its own. Measured with a 12-term query, 200 iterations, including the lookup's own cost: **0.071 → 0.039 ms at 50 rows (−45%), 0.411 → 0.079 ms at 500 (−81%), 4.147 → 0.481 ms at 5 000 (−88%), 80.15 → 8.57 ms at 100 000 (−89%)**.

  The dropped terms are the ones BM25 already scores near zero — a word in every row has no inverse document frequency — so this removes work rather than signal. R@5 on LongMemEval is unchanged at cut-offs of 90%, 70% and 50%, and falls at 30% (94.0% → 93.0%); 50% takes the speed with margin against that cliff. The full 500-question run holds at R@5 95.60% / R@10 97.80%.

  Two edges are pinned by tests, because they are where a frequency filter goes wrong: a query made entirely of common words keeps its rarest term rather than filtering to nothing, and the guard does not apply below 25 rows, where a term in most of the corpus is the subject rather than a stopword. A missing `fts_vocab` falls back to searching every term.

  Preventive rather than remedial — no one is at a scale where this bites today, which is why it had to be free at every size to justify shipping.

### Security

- **The local embedding runtime is no longer installed by default** (`package.json`) — `@huggingface/transformers` is an optional peer dependency now, so a plain `npm i @pcircle/memesh` no longer pulls `onnxruntime-node` (→ `adm-zip`) and `sharp`, which between them carried five high-severity advisories with no fix available upstream. Recall does not need it: the published 95.60% R@5 is Mode A, measured with **no embeddings at all**, and Mode B with embeddings scores identically. The code already degraded gracefully when the package was absent. Users who want local ONNX embeddings install it alongside; BYOK OpenAI/Ollama embeddings are unaffected.

  Measured on a real consumer install of the packed tarball: before, `sharp@0.34.5` + `adm-zip@0.5.18` and 5 high advisories; after, neither package present, no advisories, and English and Chinese recall both still work.

- **The dependency gate now measures what ships, not what this repo has** (`scripts/check-consumer-audit.mjs`) — `npm audit --omit=dev` run in the repo audits the repo's own tree, and npm applies `overrides` only at the install root, so the overrides added here changed what this project tests and changed nothing for a consumer. A gate reporting success against a tree nobody installs is the same defect as the benchmark that scored a reimplementation. `npm run audit:prod` now packs the tarball, installs it the way a user does, and audits there — and refuses to pass if the install produced no tree.

### Fixed

- **A memory written while the index rebuilt could vanish from search, permanently** (`src/db.ts`, `scripts/hooks/_shared.js`) — the rebuild read its source rows *before* opening its transaction, and better-sqlite3's default transaction is `BEGIN DEFERRED`, so no write lock existed until the first statement inside it. Seven hooks, the MCP server, the HTTP server and the CLI all open this database, so an entity committed in that window was erased by `delete-all` and never reinserted; the version marker then committed, so it never retried. The entity row survived, which is why nothing noticed. Migrations now run through one helper that takes `BEGIN IMMEDIATE`, re-checks the version under the lock, and backs off 24h after a failure instead of re-scanning the whole corpus on every process start. Hooks run the same migration — they previously did not, leaving hook-only users with a permanently half-segmented index and a "database disk image is malformed" message on stderr.

- **An unreadable config deleted every embedding** (`src/core/config.ts`, `src/db.ts`) — `readConfig()` returned `{}` for both "no config" and "config could not be read", and the embedding dimension derived from it drives a `DROP TABLE entities_vec` on mismatch. A truncated write or a bad permission bit therefore read as "user configured nothing", fell back to 384-dim, and dropped a BYOK user's entire 1536-dim vector index — unrecoverable, no backup, no prompt, and regenerating it costs money on an API provider. `readConfigResult()` reports which case it is; an unknown dimension now keeps the existing table. The vector migration's `DROP`, marker, `CREATE` and dimension stamp are one transaction, so a crash between them can no longer leave `memesh doctor` reporting a healthy install over an emptied index.

- **Non-Latin memories stored in decomposed form were unreachable** (`src/storage/fts-index.ts`, `src/knowledge-graph.ts`) — CJK search was half fixed. The index side never normalised Unicode at all, and the query side normalised *after* segmenting, so decomposed Hangul was never split into bigrams. Text arriving as NFD — which macOS filesystem APIs, Finder and several Korean and Vietnamese IMEs emit, and which the hooks capture from file paths — could not be found in either spelling. `toIndexForm()` now owns "text → index tokens" for both sides. Existing databases rebuild their index once, through the locked path above.

- **The committed dashboard bundle could not be reproduced on Windows** (`.gitattributes`, `scripts/build-dashboard.mjs`, `.github/workflows/ci.yml`) — found the moment the build-output gate started actually building. `.gitattributes` listed the ten extensions whose CRLF breakage had been noticed and left `.css` and `.html` out, so Windows checked out `dashboard/index.html` and `dashboard/src/styles/global.css` with CRLF, vite **inlined** them into `dashboard/dist/index.html`, and the carriage returns landed mid-line inside a shipped artifact — a real content difference that line-ending normalisation cannot undo. The rule is now `* text=auto eol=lf`: line endings are a property of text, not of a suffix list somebody remembered to extend. Renormalising changed no file, confirming nothing had been stored with CRLF.

  Two compounding causes alongside it. `build-dashboard.mjs` ran `npm install` rather than `npm ci`, justified as tolerating lockfile drift in development — but the only moment `dashboard/node_modules` is absent is a clean CI checkout, so the convenience applied where it was never needed and the pinning was missing where it always is. And CI built the dashboard **twice**, once inside `npm run build` and again in a later step, with the second build landing *after* the release gates — so the gate diffed the artifact produced by the unpinned install. The redundant steps are gone. Verified by deleting `dashboard/node_modules` and rebuilding: the locked install reproduces the committed bundle byte-for-byte.

- **A docs gate reported FAIL on a correct tree** (`scripts/verify-docs-sync.sh`) — the hook count was `find scripts/hooks -name '*.js' ! -name '_shared.js'`, which recurses, so when the build-generated mirror `scripts/hooks/_generated/` arrived the count went 7 → 9 and the gate failed every run. A gate that fails on a healthy repo gets ignored, and then it is not a gate. It now counts top-level files that are not underscore-prefixed — the convention already in use for "lives here but is not a hook".

- **A failed database open poisoned the whole process** (`src/db.ts`) — pre-existing, found while reviewing this branch. `openDatabase` assigned its module singleton BEFORE finishing initialisation, so any throw after `new Database()` — a peer holding the write lock during `SCHEMA_SQL`, a read-only file, a failed extension load — left `db` pointing at a handle with no schema, no migrations and no sqlite-vec. `if (db) return db` then handed that handle to every later caller for the life of the process. Reproduced: with a peer holding `BEGIN EXCLUSIVE` the first call threw "database is locked" and the next returned the poisoned handle, throwing "no such table: memesh_metadata". The migration machinery's transient-error backoff exists precisely so a held lock is retried later, and it never got the chance. The singleton is now published only on success, and the abandoned handle is closed.

- **A memory stored decomposed became unfindable the moment it was archived** (`src/knowledge-graph.ts`, `src/storage/fts-index.ts`) — pre-existing. Archived rows leave FTS5, so that branch matches with `LIKE` against the raw `name`/`content` columns — while its terms come from `tokenizeQuery`, which NFC-normalises. The two halves of one `search()` call therefore disagreed about normalisation, and only after archiving. Measured: a Vietnamese memory stored NFD was returned by `search('dữ liệu')` and absent from `search('dữ liệu', {includeArchived: true})` while its NFC twin was returned. A deterministic `memesh_nfc()` SQL function now normalises the stored side too, so both halves answer the same question. NFD is not exotic input — macOS filesystem APIs, Finder and several Korean and Vietnamese IMEs emit it.

- **A query of combining marks alone claimed to be searchable** (`src/storage/fts-index.ts`) — pre-existing. `tokenizeQuery` accepted `[\p{L}\p{N}\p{M}]+`, which matches a run of marks with no base character. FTS5's `unicode61 remove_diacritics 1` treats those marks as separators for non-Latin scripts, so the `MATCH` phrase built from one can never hit a row. Measured for U+0E4D, U+0301, U+0951, U+064F and U+3099: `hasSearchableTerms` answered true and `search()` returned 0 — and because `recallEnhanced` gates the vector supplement on that answer, those queries skipped the keyword result and got semantically-nearest memories instead. A term must now start with a letter or a number; marks that follow one are untouched, so Thai tone marks, Devanagari matras, Arabic harakat and Hebrew niqqud all still tokenise as part of their word.

- **The segmentation upgrade did not reach any existing database** (`src/db.ts`) — found by a six-specialist review of this branch, and the most serious thing in it. `rebuildFtsIndex` carried a fast path, `if (fromVersion === 1 && !hasDecomposedText(db)) return;`, justified by "v2 differs from v1 ONLY by NFC-normalising before segmenting". True when the target was 2. Version 3 also widens the script class, and **none of the newly-covered scripts has a canonical decomposition**, so the probe returned false for exactly the corpora the widening exists to fix. Measured: a v1 database holding Thai and half-width katakana came out of the upgrade with its marker stamped 3, its index still holding v1 whole-run tokens, and every fragment query returning nothing. The marker only moves forward, so it never self-heals.

  It was also a **regression**: the query side does segment, so half-width katakana and CJK Extension B lost the exact-full-string query that worked before the upgrade. And `_shared.js`'s hook-side twin never had the skip, so the same database ended in one of two index states depending on which process opened it first — with doctor calling one of them damaged.

  The skip is gone. A version-keyed shortcut is only sound while someone re-derives its premise at every bump, and nobody does; rebuilding unconditionally is also what makes the core and hook halves agree by construction. It bought back 140ms against 13ms on a 20k-entity database, once per database per bump.

- **`memesh doctor` reported a healthy index as damaged, and put a line of your memories in a public issue body** (`src/core/doctor.ts`, `src/storage/fts-index.ts`) — two defects in the check added earlier in this release. Its predicate was "a term longer than a bigram that starts with an unspaced-script character", on the premise that a segmenting build cannot produce one. False: `segmentUnspacedScripts` leaves a LONE unspaced character untouched, and `unicode61` then joins it to adjacent ASCII, so an ordinary healthy database holds terms like `第1章` and `語abc`. Both were flagged, and both memories were findable — so the verdict was wrong, not merely noisy. The predicate now requires **three consecutive** unspaced-script characters, which segmentation can never emit.

  The message also embedded an example term taken straight from `fts_vocab`. `memesh feedback` and the dashboard's feedback widget copy every doctor summary verbatim into a pre-filled **public** GitHub issue body, and diagnostics are opt-out — so that example was a line of the user's own memories staged for publication. It now reports a count, which is just as actionable: rebuild, re-run doctor, expect 0.

- **Every spaceless script now segments, not only CJK** (`src/storage/fts-index.ts`, `src/db.ts`) — the fix above listed the scripts that had been reported (CJK ideographs, kana, hangul) rather than the property that makes them need fixing, so Chinese, Japanese and Korean started working and **Thai, Lao, Khmer, half-width katakana and CJK Extension B kept the exact defect**, invisibly, because no test used one. Measured on a fresh database: each stored correctly and was unfindable by any fragment of itself. All five are findable now, verified through the real index and the real query builder.

  Segmentation is also code-point aware. Extension B lives above the BMP, so building bigrams over UTF-16 code units cut surrogate pairs in half — and a run of *only* non-BMP characters still matched, by accident of even alignment, which is why this needed a mixed-width case to expose. With one BMP character beside one above it, the bigram straddling the boundary was `[low surrogate] + 「資」`, so the legitimate token was never produced and no query could reach it.

  `FTS_SEGMENTATION_VERSION` goes to 3, so existing databases rebuild their keyword index once on first open, through the locked migration path. Entity and observation rows are not touched. Spaced scripts are unaffected: Cyrillic, Greek and Devanagari are asserted to pass through byte-for-byte, since widening a character class is precisely how a script that *does* use spaces gets bigrammed by mistake.

- **`memesh reindex --fts`** rebuilds the keyword index on demand, and **`memesh doctor` now reports when you need it** (`src/core/doctor.ts`). The version marker only moves forward, so it cannot describe a database migrated by a newer build and then written to by an older one — reachable by a downgrade, or by an npm-global and a plugin-marketplace install side by side. Two comments claimed doctor detected this state; nothing did, so it was silent by construction: `entities` stays intact, every health signal stays green, and the affected memories are simply unfindable by any partial-phrase query, permanently. The new `fts_segmentation` check looks for what the old rules leave behind — an indexed term longer than a bigram made entirely of unspaced-script characters, which a segmenting build cannot produce — and names the offending term so you can tell whether the rebuild worked.

- **A failing database reported both `pass` and `fail`** (`src/core/doctor.ts`) — the "Database opened successfully" row was pushed as soon as the entity count came back, so anything that threw afterwards was caught and appended a *second* row with the same `database` id and status `fail`. The overall verdict was right and the row a reader looks at was wrong: `checks.find(c => c.id === 'database')` returned the passing one. The block now stages its rows and emits exactly one, whichever way it ends. Found by mutation-testing the check above — with the duplicate present, deliberately breaking the new check left the whole suite green.

- **`verify_agent_work` still passed on a claim it never evaluated** (`src/core/verifier.ts`) — with no discoverable git base, `expected_files` was never compared, yet a report saying `pass: true` produced an unqualified `pass`. A supplied claim that could not be evaluated is now `unverified`. `pass` returns as a deprecated alias for `verdict === 'pass'`, so callers upgrading from 4.2.10 keep working — but an unverified run reads `false`, which is what the old boolean got wrong.

- **A query with no searchable terms returned recent memories** (`src/knowledge-graph.ts`) — `"???"`, `"@#$%"` and the like fell through to the recent list, so unmatched memories came back labelled as results. It returns empty now. A genuinely empty query still lists recent. **Behaviour change.**

- **Recall was not reproducible** (`src/knowledge-graph.ts`) — `ORDER BY f.rank` had no tiebreaker and BM25 ties are the common case, so which rows survived `LIMIT` to reach the scorer was left to SQLite. Ties now break by recency.

- **The prompt-injection fence did not own its own fence** (`scripts/hooks/_shared.js`) — `buildReferenceContext()` declares its contents to be data rather than instructions, then interpolated caller text verbatim. `pre-edit-recall.js` passed raw observation text, so a stored memory containing a newline and a triple-backtick closed the fence and had the rest read as instructions. The renderer now guarantees it: whitespace is collapsed and the fence outgrows any backtick run in the content.

- **`.gitignore` re-included a subtree over the top of the global rules** — `!benchmarks/longmemeval/**` is a recursive negation, and a later negation wins, so it overrode `.env` and `data/` for that whole subtree, in a public repo, in the directory `REPRODUCE.md` tells people to download a dataset into. The line was also unnecessary.

- **The publish path enforced less than the review path** (`.github/workflows/publish-npm.yml`) — version coherence, F5 mirror drift and the doctor manifest gate ran on every PR and on no release. `.claude-plugin/*.json` ship inside the tarball, so a partial version bump reached plugin-marketplace users unchecked. `npm run verify:release` is now the one place that answers "is this shippable": lint, typecheck, version coherence, F5 mirror drift and the consumer-tree dependency audit, with the doctor manifest gate as its own step in the same workflow, plus a tag-vs-`package.json` check before anything is installed, plus `prepublishOnly` so a manual publish cannot bypass them.

  Lint and typecheck were added to it because the asymmetry reappeared in the other direction: CI hard-gates on `eslint --max-warnings 0`, `verify:release` did not, and a variable left dead by a fix earlier in this release turned CI red for several commits while every local gate stayed green. A check that only one of the two paths runs is the defect this entry describes, whichever path is missing it. Break-tested: with the dead variable restored, `npm run verify:release` exits 1; without it, 0.

- **One hook and two commands were not guaranteed executable** (`scripts/set-executable-bits.mjs`, `tests/installation.test.ts`) — the chmod list omitted `user-prompt-intent.js`, and had drifted from `package.json` `bin` in both directions: `dist/transports/cli/cli.js`, the `memesh` command itself, was committed at mode 100644. Both lists are derived from their manifests now, and the packaged smoke test checks the mode rather than only the file's presence.

- **The auth screen gave a screen-reader user nothing, and a wrong token no feedback at all** (`dashboard/src/components/AuthPrompt.tsx`, `dashboard/src/App.tsx`) — the error had no live region, the input was not focused on a screen reached involuntarily by a 401, `required` made the empty-token message unreachable, and pasting a rejected token produced no message in any locale. Fixed, with `auth.invalid` added to all 11 catalogues.

- **Published claims that no longer matched the code** — README.md and six locales still advertised LLM query expansion, removed in v4.2.0. `REPRODUCE.md`'s "verify the aggregation" recipe loaded the retired adapter result, so following it recomputed the 95.40% this release retracts. `RESULTS.md` cited the superseded v4.2.10 run as "the shipped path" and never named the two 2026-07-29 files every published number comes from. `METHODOLOGY.md` documented the vector-similarity formula this release replaced, overstated what the CI floor guards, and was still headed v4.0.4. `MANUAL-VERIFICATION.md` audits the retired adapter and is now labelled historical instead of being cited as evidence for the current figure.

- **The auth screen's translation fallbacks were dead code** (`dashboard/src/components/AuthPrompt.tsx`, `dashboard/src/lib/i18n.ts`) — five lookups were written as `t('auth.x') || 'English literal'`, which reads as a safety net and cannot be one: `t()` returns the key string itself on a miss, and a non-empty string is truthy, so the right-hand branch is unreachable. When those keys were genuinely missing from every locale, this screen rendered `auth.title` at a remote operator and the fallback did nothing. The keys and a guard test both landed earlier; the dead branches did not, leaving five unsynced copies of the English strings that no build step compares against the catalogue. They are removed — English is already the fallback inside `t()` (locale → en → key), and `tests/dashboard-i18n.test.ts` fails the build if a key used in a component is absent from the English catalogue.

  Found while auditing that file: the token input's `placeholder` was a hardcoded `"paste token here"`, the one string on this screen that never went through translation. Now `auth.tokenPlaceholder`, added to all 11 locales.

- **`verify_agent_work` no longer reports a pass when it verified nothing** (`src/core/verifier.ts`, `src/transports/cli/cli.ts`, `src/transports/mcp/handlers.ts`, `src/core/schema-export.ts`) — both `claim` and `report` are optional. With neither supplied the tool counted changed files, which is not a check against anything, and then said so with `pass: true`.

  Measured before changing anything, calling it with only a workdir:

  ```json
  {
    "pass": true,
    "reality_check": {
      "match": null,
      "expected_files": null,
      "summary": "18 files changed (no claim to check against)"
    },
    "external_report": null
  }
  ```

  It also wrote a permanent memory reading `Agent <id> verification: PASS`, tagged `verification:pass`, which a later `recall` hands to another agent as evidence the work was checked. And `memesh verify` printed `PASS` and **exited 0**, so a gate written as `memesh verify … && deploy` deployed on a check that never ran.

  The root cause was two absences multiplying into a pass: `realityCheck()` returned `pass: true` when there was no claim, and the overall verdict was `rc.pass && (input.report?.pass ?? true)` — a missing report defaulting to true. Absence of evidence was being read as evidence.

  `pass: boolean` is replaced by `verdict: 'pass' | 'fail' | 'unverified'` on both the result and its nested `reality_check`. One tri-state rather than a boolean plus a `verified` flag, because two fields describing one fact is how the `recall_hits` double-writer happened. A `pass` now requires that something was actually checked — a matched file claim, or a supplied external report; any `fail` still wins over both. `unverified` also covers the cases where the check could not run at all (no git base discoverable, `git diff` failed), which previously returned `pass: false` and read as "the agent's work failed" rather than "this tool could not look".

  Recording a snapshot without a claim — the mode a test called "informational" — still works and still reports what it saw. It just stops calling itself a pass.

  Surfaces updated so none of them can round the third state back to two: the entity tag is `verification:unverified`, the stored observation reads `UNVERIFIED`, the MCP and OpenAI-function tool descriptions tell the model that calling with neither argument checks nothing, and `memesh verify` prints `UNVERIFIED`, says what to pass to actually verify something, and **exits 2** — distinct from 0 (pass) and 1 (fail) so a shell gate cannot confuse "checked nothing" with success. A caller still reading `pass` — on the result or on the nested `reality_check` — gets a deprecated alias for `verdict === 'pass'` at both levels, so upgrading from 4.2.10 does not break it, and an unverified run now reads `false` where the old boolean read `true`. Both are removed together in a later minor.

  Pinned by seven cases in `tests/core/verifier.test.ts` covering each cell of the claim × report matrix plus the stored tags and observation text. Proven non-vacuous by restoring the old combining rule: **3 of 19 tests fail**, and pass again once reverted.

- **`recall_hits` has one owner again** (`src/storage/conflicts.ts`, `src/knowledge-graph.ts`) — the column was written by two code paths with incompatible definitions. The Stop hook writes it to mean "a memory we injected was actually used", checking the transcript and recording a hit *or* a miss; `search()` also wrote it to mean "this memory was returned", which can only ever add to the hit side. `scoring.ts::impactScore` reads the pair as `(hits+1)/(hits+misses+2)`, a ratio that is only meaningful if both sides answer the same question. Retrieval paths now track access only — "was returned" is already recorded by `access_count`, in the same statement. Measured on a real 91-entity database the two definitions had not yet collided (29 hits against 365 misses; the impact factor's median sat exactly at the neutral 0.5), but OR-joined query terms return far more rows per search than the old AND semantics did, which is when a one-sided writer starts to matter. The `incrementHits` option is gone with its last caller.

- **`include_archived` searches for what you asked, not for a literal substring of it** (`src/knowledge-graph.ts`) — archived rows are removed from FTS5 by `archiveEntity()`, so they are matched with `LIKE`, and that branch interpolated the whole raw query. A question phrased in your own words therefore found the active copy of a memory and missed the archived one, and a CJK query missed entirely because it was never segmented. The branch now matches the same terms `buildMatchExpression()` produces — same tokenising, same document-frequency guard — OR-ed together, with `LIKE` metacharacters escaped.

- **The `recall` MCP tool now tells the model how its query will be read** (`src/transports/mcp/handlers.ts`) — the description said only "uses FTS5 full-text search", while the query is OR-ed, ranked by BM25, capped at 32 terms, and has ubiquitous words removed. An agent choosing between a keyword and a sentence had nothing to go on.

- **The packaged-artifact smoke test says so when it passes, and checks every hook** (`scripts/smoke-packed-artifact.mjs`) — it printed nothing on success, which is indistinguishable from not having run. That is the exact failure mode this release has spent several changes removing from the product.

  Its required-files list also stopped at five hooks while the project ships seven, so `pre-bash-orchestration-nudge.js` and `user-prompt-intent.js` were packaged but never verified — a narrowed `files` glob would have produced a tarball this test called good. The list is not corrected to seven; the hooks are now **derived from `hooks/hooks.json`**, so a hook that the plugin manifest can invoke cannot go unchecked no matter how many there are. `_shared.js` and the two build-generated files under `scripts/hooks/_generated/` are asserted too — hooks cannot import from `dist/`, so those three are the whole of their dependency surface, and without them every hook throws on first require.

- **Published benchmark results no longer record the absolute path of the machine that produced them** (`benchmarks/longmemeval/run.mjs`) — `run_info.dataset` held the full path to the dataset file, which in a public repository means publishing a local home directory. It records the basename now; `dataset_sha256`, which is what actually identifies the dataset, is unchanged. The two result files already committed with a path had that one field edited and the edit is stated in `benchmarks/longmemeval/results/README.md`; every measurement in them is byte-identical. Note that the earlier path remains in git history, in the commit that first added those files.

- **`package-lock.json` carried the version from four releases ago** — its two self-version fields read `4.2.6` through v4.2.7, v4.2.8, v4.2.9 and v4.2.10, because the lockfile was missing from the version-anchor checklist. Only those two fields changed; all 520 dependency entries are byte-identical.

- **The vector half of "hybrid search" was doing nothing, and now does what it says** (`src/core/embedder.ts`, `src/core/operations.ts`) — two constants encoded the same wrong assumption about what `entities_vec` returns. The table is declared `vec0(embedding float[N])` with no `distance_metric`, so sqlite-vec measures **L2**; over unit vectors that is a 0…2 range, and related text lands at 1.0–1.44. Both constants assumed a 0…1 cosine-distance scale:
  - `MAX_VECTOR_DISTANCE = 1` discarded essentially every hit. Measured over 50 LongMemEval questions: **5 of 1000 vector hits survived it (0.5%)**, while the correct session sat at a median distance of 1.187 — above the cut. Embeddings were being generated, stored and searched, and the results thrown away before anything could use them.
  - `1 - distance` as the similarity mapping sent **98.8% of hits to exactly 0.0** relevance, which is the value `rankEntities` treats as "no signal".

  The cut-off is now **1.30** and the mapping `1 - distance/2`, extracted as `vectorSimilarity()` next to the constant it shares a scale with — keeping them in separate files is how they drifted apart. 1.30 is calibrated, not derived: the geometric answer (√2, exactly cosine 0) turned out to sit in the *middle* of the noise, because MiniLM's space is roughly isotropic and unrelated text lands at cosine 0 rather than below it. Measured, a nonsense query's nearest neighbour is at 1.371–1.430 while genuinely related text is at 0.872–1.157. Recall cost of choosing the tight end: none — R@5 measured identical (95.0%) at thresholds 1.20, 1.35, 1.50 and 2.00.

  **What this does not do is raise the benchmark score**, and that is worth stating plainly rather than implying otherwise: R@5 is unchanged. What changes is that the feature is no longer inert, a query matching nothing lexically can now be answered semantically, and a nonsense query still honestly returns nothing.

  Re-measured on the release tree, with the full 500 questions run in both modes: **14 of 500 result lists now differ** between embeddings-off and embeddings-on, where before the fix they were identical to sixteen decimal places. Only two questions move the correct session — one from "not found" to rank 14, one from rank 14 to 16 — so R@5 and R@10 are unchanged and MRR moves 0.8929348706848708 → 0.8930598706848707, a gain of 0.000125 for 89× the wall-clock (807.7s against 9.1s). This **refutes a prediction the benchmark docs used to make**, that the remaining failures were "dominated by vocabulary mismatch — exactly what a working vector supplement would cover". The supplement works now and covers one of the 22, at a rank no one would ever scroll to. MiniLM-L6 at 384 dimensions is not the cure for that class, and the docs say so instead of quietly dropping the claim. Recall stays LLM-free and embeddings stay opt-in.

- **Recorded, not fixed: a vector hit cannot outrank the best keyword hit, however certain it is** (`src/core/operations.ts` docstring) — the two relevance values are not on the same scale. FTS relevance is *positional* (the top row gets 1.0 no matter how weak the match); a vector hit's is *absolute*, and a genuinely good semantic match sits near 0.4. Measured over 100 LongMemEval questions: of the 5 the keyword search missed, the vector index ranked the correct session **#1 in three of them**, and none surfaced in the top 5 at any distance threshold. The fix is rank fusion (score both sides by position, e.g. RRF); it was implemented and measured and **not adopted** — on this corpus it recovered 4 of the 5 misses and cost more elsewhere, R@5 95% → 92%. LongMemEval's haystack is padded with generic public Q&A that scores high on semantic similarity while being nobody's memory (`METHODOLOGY.md` §4.1), so it is the wrong corpus to tune fusion on. Revisiting it needs a corpus of personal notes where the question's vocabulary differs from the note's.

- **Chinese, Japanese and Korean memories are searchable by part of a phrase, not only by their exact stored text** (`src/storage/fts-index.ts`, `src/knowledge-graph.ts`, `src/db.ts`) — FTS5's `unicode61` tokenizer classifies every CJK character as a letter and puts no boundary between them, so an unbroken run indexed as **one token**. A memory holding 「資料庫遷移前一定要先備份」 could be found by searching that exact string and by nothing else: 「資料庫遷移」 matched nothing, 「備份」 matched nothing. Measured on a mixed corpus, Chinese recall was **2/9** while English was 4/4 — which is why it stayed invisible. For anyone whose notes are in one of these scripts, keyword recall was effectively broken.

  Text now passes through `segmentUnspacedScripts()` on the way into the index and on the way into a query, cutting unspaced-script runs into overlapping character bigrams (「資料庫遷移」 → 「資料 料庫 庫遷 遷移」). Latin text is returned byte-for-byte unchanged, so English behaviour is untouched — the 500-question LongMemEval-S run is identical before and after (R@5 95.60%, R@10 97.80%, MRR 0.8931 at the commit where this was measured; the release figure is 0.8929 after the later vector-threshold and document-frequency changes — see `benchmarks/longmemeval/RESULTS.md`). Chinese recall on the same mixed corpus goes **2/9 → 9/9**.

  Chosen over migrating `entities_fts` to FTS5's `trigram` tokenizer, which measured **3/9** on the same corpus for **4×** the index size, against 9/9 and 1.6× here — and which would have meant recreating the virtual table rather than only its contents. Because the segmentation lives in `fts-index.ts`, the hooks' always-on capture path picks it up through the build-generated mirror (`scripts/hooks/_generated/fts-index.js`) with no hook change at all.

  **Existing databases rebuild their index once, automatically, on the next open** (`fts_segmentation_version` in `memesh_metadata`, following the `embedding_dimension` idiom). Without it the change would take CJK recall from bad to zero on upgrade, silently, since English would keep working. Measured at 19ms for 5,000 entities, so it runs inline; a failure logs and retries next start rather than blocking the database from opening.

  Known bound, pinned by a test rather than chased: a single-character query becomes a prefix match, so it reaches any bigram starting with that character but not one where it sits last (「收」 will not find 「營收」). Fixing that means indexing every character as well, for a rare query shape.

- **`memesh reindex` reported success for work it had not done** (`src/core/embedder.ts`, `src/core/operations.ts`, `src/transports/cli/cli.ts`) — pre-existing. `embedAndStore()` has six exits and exactly one of them writes a vector, but it returned `void` from all six, so the only signal a caller got was "it didn't throw". `reindex()` read that as success: `await embedAndStore(...); embedded++`. A provider whose dimension no longer matched the index therefore produced a full `Embedded:` count over an index nothing had been written to — and because `clearPendingReindexFlag()` then ran unconditionally, the one piece of state telling `memesh doctor` the index still needed refilling was erased too. The command printed `✅ Reindex complete` and exited `0`.

  `embedAndStore` now returns which of the six things happened, `reindex` counts by outcome, and the decision to clear the flag is taken from the **database** — active memories that have observation text but no vector row — rather than from what the loop believed it did. An incomplete run prints `⚠️  Reindex incomplete` with a per-reason breakdown, leaves the flag set, and exits `1`, so a script that shells out to it can tell the two apart. Memories whose observations are all blank are excluded: they can never have a vector, and requiring one would keep the flag set forever.

- **The vector index could still be destroyed on evidence the guard exists to distrust** (`src/db.ts`, `src/transports/cli/cli.ts`) — pre-existing, and the other half of the unreadable-config fix above. That guard was keyed to the config being *absent*, on the argument that an absent config is weak evidence for deleting a BYOK user's embeddings. It is — but `configDir()` follows `MEMESH_DIR`/`HOME` while `getDbPath()` follows `MEMESH_DB_PATH`, and every foreign-`HOME` case it was written for behaves identically when that `HOME` happens to *contain* a config file: a container image's default `config.json`, a second machine profile, an unrelated edit that dropped the embedder key. The guard then treated it as authoritative for a database it had never seen and took the `DROP` branch.

  The refusal now follows the consequence instead of the evidence. Any disagreement between the stored dimension and the configured one keeps the existing index, because a stale index still works and is recoverable by fixing the config, while a dropped one is gone and on an API embedder has to be bought a second time. Deliberate embedder switches go through the new **`memesh reindex --vectors`**, which drops and recreates the table at the new dimension and immediately refills it — and which refuses if no embedding provider is available, rather than dropping the index and having nothing to refill it with. The refusal message also used to name `memesh reindex`, which cannot change a `vec0` table's width, so following the instruction led straight back to the same refusal.

  Two more places where the destruction would have been wider than the repair, both found by reviewing the fix itself. `--vectors --namespace X` is now refused: `entities_vec` is one table for the whole database, so the rebuild drops *every* namespace's vectors while `--namespace` would refill only `X` — the rest would lose their embeddings permanently, silently, and outside anything the user asked for. And the count deciding the user-facing verdict is now scoped to the run, while the count deciding the database-wide `pending_reindex` flag stays unscoped; sharing one number made `memesh reindex --namespace personal` print `⚠️  Reindex incomplete` and exit `1` after a run in which everything it was asked to do worked — the same defect as the false success, pointed the other way.

### Changed

- **Every published claim that no longer matched the code has been corrected** (`README.md` + 10 locales, `docs/ARCHITECTURE.md`, `skills/memesh/SKILL.md`) — a sweep prompted by finding that the headline benchmark figure described a different implementation. Each was checked against source before being rewritten, not adjusted by eye:
  - **The R@5 figure, 11 READMEs × 4 places.** 95.40% was the benchmark's own reimplementation; the shipped path measures **95.60%**. The comparison row now names the code path (`MeMesh (Mode A, via recallEnhanced())`) so the number cannot be read as describing something else again.
  - **The scoring weights.** READMEs said `frequency (15%) + confidence (15%)`; `DEFAULT_WEIGHTS` in `src/core/scoring.ts` has been `0.18` / `0.17` since the temporal-validity factor was removed.
  - **`temporal validity` as a scoring factor.** Listed in all 11 READMEs and in `skills/memesh/SKILL.md`, in two places each. It was deleted from `scoring.ts` in 2026-05 — the `valid_from` / `valid_until` columns it read were never written by any code path, so it had been a constant 1.0 no-op even before that.
  - **`~18ms/query`.** That figure was 9.2s ÷ 500 questions, and each question includes *building a fresh 50-session database*. A recall itself measures ~4ms on that corpus (300-call mean). Restated as per-recall.
  - **`README.th.md`** additionally advertised LLM query expansion on `recall`; `query-expander.ts` was removed in v4.2.0 and recall has been strictly LLM-free since.
  - **`docs/ARCHITECTURE.md`** attributed 95.40% / 9.2s / "within 1.2pp" to this codebase; those came from the harness. Now 95.60% / 9.1s / 1.0pp, with the provenance of the old figure stated.

- **The LongMemEval benchmark now measures the shipped retrieval path** (`benchmarks/longmemeval/run.mjs`, `benchmarks/longmemeval/*.md`, `tests/recall-quality.test.ts`) — the runner used to carry its own `CREATE TABLE`, its own FTS5 query construction and its own ranking, so the published 95.40% R@5 scored that reimplementation rather than MeMesh. The two had drifted: the runner OR-joined query terms and ordered by BM25 `rank` while the shipped `search()` AND-joined and ordered by `e.id DESC`. On the same 500 questions the runner reported 95.40% and the product scored 5.20%, with 473 of 500 questions returning nothing — the defects fixed earlier in this release. A benchmark that reimplements the thing it measures cannot fail when the thing breaks.

  The runner now seeds through `KnowledgeGraph.createEntity()` (the call `remember()` makes) and retrieves through `recallEnhanced()` (the call every transport makes), and records `run_info.measures: "shipped_recall_path"` so a result file states what produced it. Modes now name real product configurations — A without embeddings, B with them — instead of adapter-internal fusion strategies; mode C applied a 60/40 weighted fusion MeMesh has never implemented and is removed. Result files from before the change are kept unmodified and labelled in `benchmarks/longmemeval/results/README.md`.

  Two published claims were corrected rather than quietly dropped. `RESULTS.md` said the figure was "measured using FTS5 full-text search — the same retrieval engine MeMesh uses in production"; it was not. `METHODOLOGY.md` §3 concluded that the benchmark was "a conservative lower bound on MeMesh's production retrieval quality — the full system would score at least as well, likely better", which the 5.20% measurement disproved in the most direct way available. §4.2 had listed OR-joining as an adapter *limitation* while the product AND-joined — the divergence was written down next to the number and read as a caveat about the harness.

### Fixed

- **Committed build output could drift from source, and only the install channel that cannot notice was affected** (`scripts/generate-skills-manifest.mjs`, `scripts/check-generated-mirror.mjs`) — `dist/` is tracked in git because plugin-marketplace installs run it directly: they install with `--ignore-scripts` and never build. Nothing verified it matched `src/`. Found during review of this branch — a source-only commit had left `dist/db.js.map` stale, and every gate reported green.

  `npm publish` was never exposed, because `prepublishOnly` rebuilds first. That is precisely why it could persist: the one channel that ships committed output is the one no gate covered.

  The reason no gate existed is worth naming. `dist/skills-manifest.json` carried a `generated_at` timestamp, so **every build produced a different file** and "is the committed output current?" had no answer a diff could give. The field was written and never read — `doctor.ts` verifies `entries[].sha256` and nothing else — so it is gone, and the build is now reproducible (verified by building twice and comparing bytes). `check-generated-mirror.mjs` then extends from the hook mirror alone to all three committed build outputs, and counts untracked files too, since a new compiled file that was never committed is exactly as stale as a modified one. Break-tested: changing `FTS_SEGMENTATION_VERSION` and rebuilding without committing exits 1.

### Tests

- **A mutation sweep over this release's fixes, and the five gaps it found** (`tests/vector-index-safety.test.ts`, `tests/gitignore-scope.test.ts`, `tests/migration-atomicity.test.ts`, `tests/recall-relevance.test.ts`, `tests/hooks/pre-edit-recall.test.ts`) — every fix above was re-broken one line at a time in a throwaway worktree to see whether any test noticed. Eleven of nineteen died as intended; the rest exposed fixes shipping unwatched, and one test of ours that was watching nothing:

  - **The vector-index guard had no test at all** — the fix that stops an unreadable config from deleting a BYOK user's embeddings is two lines in two files, and reverting *either* left the whole suite green. It was measured during development and never pinned. `tests/vector-index-safety.test.ts` now seeds a real 1536-dim vector, truncates the config, and asserts the vectors are still there.
  - **The migration backoff was written but never read** — the existing case asserted an attempt timestamp gets recorded. Nothing asserted it *suppresses* the next attempt, so deleting the check passed. Both halves are now pinned.
  - **A peer's lock was not distinguished from a broken migration** — `isTransientDbError` could be made to always return false undetected. Tested by throwing the lock error directly: while a lock is genuinely held, the catch block's own marker write is blocked too, so the two branches are indistinguishable from outside.
  - **The determinism test asserted a property SQLite already had** — it ran the same query five times against unchanged data and compared. That passes with or without a tiebreaker. It now names the expected set (`tied-29 … tied-25`), because the tiebreaker does not merely reorder the answer, it decides which memories are in it.
  - **The `.gitignore` fix had no test, and the obvious test would have lied** — `git check-ignore -v` exits 0 when a **negation** matches, so a first version of the helper reported a leaked `.env` as safely ignored. The plain form is the honest signal. Both directions are asserted: the secrets stay ignored and the 16 tracked benchmark files stay trackable.

  A second round then covered the fixes the first had never enumerated — nineteen hand-picked lines is not the same as covering the release. All four survived, and one of the tests written for them found two more live instances of the bug it was written for:

  - **`pre-compact` announcing a save that may not have happened** had no test. Forced through `captureEntity`'s null path with a CHECK constraint — `INSERT OR IGNORE` skips the violating row, so the follow-up SELECT finds nothing — without stubbing anything.
  - **Two more undefined CSS tokens were still live** (`--bg-elevated` and `--surface` in `SettingsTab.tsx`), the same class as the `--font-mono` typo this release fixed. Custom properties fail silently, so those elements simply rendered wrong and no runtime test could see it. `tests/dashboard-design-tokens.test.ts` now asserts every `var(--x)` names a token the stylesheets define, and that no dead `t(...) || literal` branch exists — the shape `tests/dashboard-i18n.test.ts` skips by design.
  - **The guard that stops the dependency gate passing on an empty tree** was itself unpinned. `tests/consumer-audit-gate.test.ts` stubs `npm` so every step reports success while installing nothing; the script has to refuse to pass.
  - **The AuthPrompt fix was only half covered**, and the covered half was the incidental one. The token typo and the dead `t(...) ||` branches are caught by the test above; what the fix was actually about — a screen reader being told nothing, and a wrong token producing no feedback at all — was not. `tests/dashboard/AuthPrompt.test.tsx` asserts the announced state: `role="alert"` on both error surfaces, `aria-invalid` plus `aria-describedby` wired to the message's id, and silence before the operator has tried anything.
  - **`release-verify.sh` no longer editing the maintainer's real config** had no test. Structural, deliberately: the regression is not "the output changed", it is "the script started writing to `~/.memesh/config.json` again", and a test that ran it for real would need a real config to damage.

  The one property first written off as untestable is now pinned too. `reindexFts()` commits its rebuild and its marker in a single transaction, and the earlier conclusion — that observing it needs the process killed mid-transaction — was a failure to design the test, not a property that cannot be seen. A `BEFORE INSERT` trigger on `memesh_metadata` fails the marker write exactly where a crash would, in-process and deterministically; splitting the transaction then leaves a rebuilt index under a stale marker, which the test catches. `.immediate()` on that same call is separately confirmed as NOT load-bearing — `rebuildFtsIndex` runs a write first there, so DEFERRED takes the lock at the same instant — and `src/db.ts` says so rather than implying the keyword is doing work it is not.

- **A retrieval-quality floor that runs on every CI leg** (`tests/recall-quality.test.ts`) — the LongMemEval dataset is a 278 MB download and committing a slice is dataset redistribution, so the gate uses a small synthetic corpus instead: ten memories, ten questions phrased as a person would ask them, and thirty function-word notes so `limit: 5` has to choose which rows reach the scorer. It asserts an aggregate R@5 floor of 80% (measured 100%) and is calibrated to catch collapse, not drift. Measured by breaking each fix in turn: AND-joined terms take it to 0% and ordering by `e.id DESC` takes it to 20%, both failing the gate; flat relevance (100%) and whitespace tokenising (90%) do not breach it, because they cost individual terms and positions rather than whole answers. That split is recorded in the test file — those two are pinned by the targeted cases in `tests/recall-relevance.test.ts`, where one mechanism can be isolated. Use the gate for "did retrieval collapse", the targeted file for "did this mechanism regress".

### Fixed

- **`recall` now finds the memory when you ask a question in your own words** (`src/knowledge-graph.ts`, `src/core/operations.ts`) — four defects in the retrieval path compounded into near-total recall failure for anything but a single keyword, and each one hid the others.

  1. **Query terms were AND-ed.** `search()` joined the quoted tokens with a bare space, which is FTS5's implicit AND, so every word of the query — including `what`, `did`, `I`, `with` — had to appear in the same memory. Recall therefore got *worse* the more precisely you asked: measured over LongMemEval-S, R@5 fell from 62.5% with one keyword to 41% with two, 29% with three and 18% with five. Terms are now OR-ed, so a memory matching more of the query ranks higher instead of being excluded outright.
  2. **Relevance was discarded before ranking.** The SQL ordered by `e.id DESC` and applied `LIMIT` — so the *newest* matches survived to the multi-factor scorer and the best match was thrown away before it could ever be scored. FTS5's `rank` (BM25) column was available and unused. With 26 or more memories mentioning a term, the most relevant one became unreachable at any database size — a failure that grows silently as a memory base fills up. Ordering is now by `rank`; recency still counts as one of the five scoring factors, it just no longer decides what gets scored.
  3. **The relevance signal was flattened.** Every FTS hit entered `rankEntities()` with a hard-coded relevance of `1.0`, tying them all on the 0.30 relevance weight and letting the scorer re-sort purely on recency/frequency/confidence — undoing the ordering the search had just computed. Relevance is now graded by BM25 position. This one is invisible in a fresh database (equal factors, ties preserve order) and decisive in an aged one, which is why it ships with the others rather than after them.
  4. **Punctuation inside a word turned it into a phrase requirement.** Tokens were split on whitespace and then quoted whole, so `kitchen's` became the FTS5 phrase `kitchen s` and `gardening-related` became `gardening related` — matching only a memory containing those words adjacent and in that order. A memory that said "kitchen", or "gardening", was missed outright. Queries are now split on the boundaries FTS5's `unicode61` tokenizer uses: `[^\p{L}\p{N}\p{M}]+` over an NFC-normalised query. `\p{L}\p{N}` keeps non-Latin scripts alive — a plain `[^a-zA-Z0-9]` strip would reduce a CJK query to the empty string, which silently falls through to the recent-list path and looks like a successful search. `\p{M}` and the NFC normalisation both address decomposed text, where splitting on a combining mark cut the word in half: NFD `naïve` became the two OR-ed terms `nai` and `ve`, neither of which is a token in the index (unicode61 folds the mark, so the indexed token is `naive`). For Latin either mechanism alone is sufficient; both are kept because they fail differently, and for scripts where unicode61 treats marks as separators rather than folding them, keeping the mark makes the query a phrase of adjacent fragments instead of a bag of OR-ed letters — same recall, better precision.

  Measured end to end on the same 500 LongMemEval-S questions the published benchmark uses, through `recallEnhanced()` — the code path a real `recall` call takes: **R@5 5.20% → 95.60%, R@10 5.20% → 97.80%, MRR 0.0520 → 0.8929, and questions returning zero results 473/500 → 0/500.**

  Limit at the time of this fix, and the reason the CJK entry above exists: `unicode61` treats an unbroken run of CJK characters as a single token, so a substring of it could not match. That was left standing here and lifted later in this same release — by bigram segmentation rather than the trigram tokenizer this note originally proposed, which measured worse on both recall and index size.

  Behaviour note: OR raises recall and lowers precision. A query now returns weaker partial matches below the strong ones instead of returning nothing, and result lists are longer. Ranking, not exclusion, is what keeps the top of the list clean. The hooks are unaffected — `pre-edit-recall` searches a single file basename and `session-start` issues no query.

### Tests

- **Regression suite for the recall-quality class the old tests structurally could not catch** (`tests/recall-relevance.test.ts`) — the pre-existing `search()` tests always queried with the *exact literal string that was stored* (`observations: ['shared query terms']` then `search('shared query terms')`), so AND semantics could never fail and relevance ordering was never exercised. The new cases pin what a memory layer actually has to hold: a question whose words are scattered through the memory still finds it, a memory matching more terms ranks first, a relevant older memory beats 40 newer passing mentions (both in `search()` and after the `recall()` scoring pass), and a query sharing no term with anything still returns nothing. Two older assertions in `tests/core/operations.test.ts` and `tests/core/integration.test.ts` were pinning result *counts* that only held under AND; they now assert the archiving contract they were actually written for.

## [4.2.10] — 2026-07-25

### Fixed
- **LLM JSON-block extraction is now nesting- and prose-safe (latent bug)** (`src/core/json-utils.ts` + auto-tagger / consolidator / digest-validator / dreamer) — five sites pulled a JSON object/array out of a chatty LLM reply with a regex, and they had drifted between a greedy `/\{[\s\S]*\}/` and a lazy `/\{[\s\S]*?\}/`. Both are fragile: greedy over-matches a `]`/`}` that appears later in prose and breaks `JSON.parse`; lazy stops at the first closer and truncates a nested block. Replaced all five with one `extractJsonBlock(text, kind)` that scans for the first balanced block, tracking depth and skipping brackets inside string literals — robust to nesting, trailing prose, and quoted brackets. Covered by a new unit test hitting each case the old regexes broke on.

### Changed
- **Hooks no longer hand-mirror `src/core` — the shared path + FTS logic is generated from core at build time** (`scripts/generate-hook-core.mjs`, `scripts/hooks/_generated/`, `scripts/hooks/_shared.js`) — hooks run the always-on capture path even when `dist/` is absent (plugin-marketplace `--ignore-scripts`) or stale, which historically forced a hand-copy of `src/core/paths.ts` + the FTS write dance inside `_shared.js`. That copy drifted and shipped the P0 where session memory was written but not indexed (unrecallable). Because those two source files are runtime-leaf modules, `npm run build` now copies their compiled output into `scripts/hooks/_generated/` and `_shared.js` imports the committed, version-locked copy. Drift is now caught three ways: a CI `git diff` on rebuild, `tests/hooks/mirror-parity.test.ts`, and the `memesh doctor` manifest (which now verifies the generated files too). No runtime behavior change — the mirror-parity test confirms the generated copy is byte-equivalent to the former hand-mirror.
- **`recall`'s conflict annotation is owned by core, not re-implemented in each transport** (`src/core/operations.ts`, `src/transports/{mcp,http,cli}`) — all three transports independently ran `recallEnhanced → new KnowledgeGraph → findConflicts → wrap`, so a change to how recall results carry conflicts meant editing three files that had already drifted (different try/catch shapes). Lifted the composition into `recallWithConflicts()` in core; the transports now call it and only format. No behavior change — same `{ entities, conflicts }` when conflicts exist, bare entities otherwise.

### Fixed
- **Dashboard Behaviour toggles no longer swallow a failed save** (`dashboard/src/components/SettingsTab.tsx`) — the auto-update `<select>` and the agentic-orchestration checkbox POSTed to `/v1/config` inside an empty `catch`, so a failed write snapped the control back to its old value with no message; the user thought the setting saved. Both now route through a shared `saveField()` that surfaces the error (and a "saved" confirmation) via the same status banner the provider save uses.
- **`memesh config list` shows every settable key, not just `llm.*`** (`src/transports/cli/cli.ts`) — `list` hard-coded three `llm.*` lines, so a user who ran `config set sessionLimit 50` (or `llmFallbacks`, `autoCapture`, `autoUpdate`, `embedder.*`) got `✅ Set` but saw no trace of it in `list` — reads as a silent write-drop. `list` now iterates `ALLOWED_KEYS` (the single source of truth for settable keys) so the two can't drift, printing each present value with `apiKey` fields — including every `llmFallbacks[].apiKey` — masked.

### Tests
- **Permanent CI gates for the fake-working write-path class** (`tests/hooks/write-hook-invariants.test.ts`) — turns the session-capture-FTS fix into invariants that can't silently regress: (1) `captureEntity()` really keeps `entities_fts` in sync (write → `MATCH` returns the row), and (2) every write hook (session-summary / post-commit / pre-compact) routes through `captureEntity()` and hand-rolls no `INSERT INTO observations` / `entities_fts` of its own — so a future hook can't drop the FTS step again. Mirrors the i18n key-coverage guard shipped for the AuthPrompt fix.

### Performance
- **Dashboard graph + browse + type-list no longer fire a query storm** (`src/knowledge-graph.ts`, `src/core/graph.ts`, `src/transports/http/server.ts`) — `computeGraph` (the `/v1/graph` endpoint), `listRecent` / `listRecentByTag` (empty-query recall + Browse tab), and the `/v1/entities?type=` branch each mapped `getEntity()` over their result rows, and `getEntity()` fires 4 queries per row. A 700-entity graph meant ~2800 queries per request. All now route their id list through the existing order-preserving `getEntitiesByIds()` batch hydrator (4 queries total). The transport's hand-rolled `SELECT ... WHERE type = ?` moved into a new `KnowledgeGraph.listByType()` so status/ordering semantics live in the storage layer, not the HTTP handler. Same fields, same active/archived filtering, same ordering — verified by the existing listRecent tests plus a new listByType test.

### Fixed
- **Recall-effectiveness stops scoring machine-named auto-capture entities against a name they can't match** (`scripts/hooks/session-summary.js`) — the Stop hook decided "was this injected memory used?" by substring-matching the entity name in the session transcript. Auto-capture entities are named with machine identifiers (`session-<pid>-…`, `commit-<hash>`, `pre-compact-<id>`) that never appear verbatim in prose, so every injection scored a `recall_miss` they didn't earn, dragging their Laplace-smoothed impact factor (10% of ranking) down over time and quietly suppressing auto-captured memories from future recall. These names carry no name-match signal, so they're now excluded from hit/miss accounting (kept at the neutral 0.5 impact) via a new `isMeasurableRecallName()` guard. The name-substring heuristic is unchanged for human/LLM-slug names.

## [4.2.9] — 2026-07-24

### Security
- **`POST /v1/config` no longer echoes fallback-provider API keys in plaintext** (`src/transports/http/server.ts`) — the POST response masked only `llm.apiKey`, so saving an `llmFallbacks: [{provider, apiKey}]` chain returned each fallback key in cleartext to the dashboard SPA (the GET handler already masked the whole chain). Consolidated both surfaces onto one `maskLlmSecrets()` helper that redacts the primary key and every fallback entry, so they can't drift again. Persistence was unaffected; only the response surface leaked.

### Fixed
- **Session-capture memories are now FTS-recallable (fake-working bug)** (`scripts/hooks/session-summary.js`, `scripts/hooks/_shared.js`) — the Stop hook's `storeMemory()` inserted the entity + observations + tags but never reindexed `entities_fts`, unlike its sibling hooks (post-commit, pre-compact). With no FTS trigger and no rebuild-on-open, every `session-insight` memory was invisible to `recall` and pre-edit-recall — the two keyword paths that inject memory when it matters. The hook reported success; the knowledge could not be keyword-recalled. Root-caused to three hand-rolled copies of the write dance drifting apart: extracted the correct dance (incl. FTS reindex) into a single `captureEntity()` in `_shared.js` now used by all three write hooks, so the FTS step can't be forgotten again. Added a regression test asserting a captured session memory is returned by an `entities_fts MATCH`.
- **Dashboard auth screen showed raw i18n keys instead of text** (`dashboard/src/lib/i18n.ts`) — the `AuthPrompt` (shown at the bearer-auth gate for remote-bound dashboards) referenced five `auth.*` keys that were absent from all 11 locale catalogues. Since `t()` returns the key string itself on a miss (truthy), the `t('auth.title') || 'English'` fallbacks were dead code and the first screen a remote operator saw rendered `auth.title` / `auth.submit` etc. Added the five keys (translated) to every locale. Also added a CI guard that scans components for static `t('...')` keys and fails if any is missing from the English catalogue — the existing i18n test only checked locale-to-locale parity, so a key missing from *all* locales slipped through.

## [4.2.8] — 2026-07-23

### Changed
- **Simplify pass over the audit's changes (quality-only; a 4-agent reuse/simplification/efficiency/altitude review)** — no behaviour change:
  - `memesh doctor --probe` no longer hangs up to 15s after printing its report. The embedding-probe timeout used a `setTimeout` that was never cleared, so on the happy path (the embedder answers first) the timer kept the event loop alive; it is now cleared in a `finally`, and the timeout arm rejects cleanly instead of `resolve(null).then(throw)`.
  - `doctor` no longer hardcodes the ONNX model id + cache layout — `embedder.ts` now owns and exports `isOnnxModelCached()`, so the two can't drift (the exact fake-working risk the code's own comment flagged).
  - Deduped `memesh pin`/`unpin` behind one registrar, the three `by_provider`/`by_model`/`by_project` telemetry accumulators behind one `bump()` helper, and corrected a stale `isRecallHit` docblock that still described a superseded "count occurrences" approach.


### Docs
- **Documented BYOK embeddings + fixed a stale CLI count** (`README.md` + 10 locales, `docs/ARCHITECTURE.md`) — the READMEs documented `config set llm.provider` but never `embedder.provider` / `embedder.model`, so BYOK embeddings (OpenAI / Ollama, independent of the chat LLM, with automatic vector-index rebuild on dimension change) were undocumented. Added a "Bring-your-own embeddings" subsection to all 11 READMEs (H3 — locale H2 parity unchanged). ARCHITECTURE.md's "17 top-level commands" corrected to the actual 24 (config/kg/dream have subcommands).
- **10 locale READMEs re-synced for `MEMESH_AUTO_DETECT_LLM` opt-out semantics** (`README.{de,es,fr,ja,ko,pt,th,vi,zh-CN,zh-TW}.md`) — the honestly-unticked box from the Phase-1 PR. Every locale still described the pre-#36 OPT-IN behaviour ("set to `1` to enable; without the flag a shell key is ignored") and incorrectly tied the flag to BYOK embeddings. Corrected to match the English README: auto-detect is ON by default, `0` disables it, a shell key is used for write-side LLM features unless disabled, and embeddings are unaffected (stay local ONNX). H2 structure unchanged, so `memesh doctor` locale parity stays PASS.

### Removed
- **Removed the write-only `payload` from skill-usage telemetry** (`src/core/skill-usage-log.ts`, `src/core/verifier.ts`, `scripts/hooks/session-start.js`) — each recorded event carried a `payload` (a hashed cwd from session-start; agent-id/pass/files-changed from verify_agent_work), but `summariseSkillUsage` counts by event name and never read it. It was write-only, privacy-adjacent local data. Lines are now `{ ts, event }` only; `logSkillEvent(event, path?)` no longer takes a payload.
- **Dead analytics compute + components, and the unread `config.theme`** (`src/core/analytics.ts`, `dashboard/src/components/`, `src/core/config.ts`, `src/transports/http/server.ts`, `src/transports/cli/cli.ts`) — `/v1/analytics` computed `valueMetrics`, `recallEffectiveness`, and `cleanup` (the latter with an O(n²) duplicate-candidate self-join) on every request, but no dashboard component ever rendered them — the dedicated `ValueMetrics` / `RecallEffectiveness` / `CleanupSuggestions` components were never imported. Removed the compute, the three components, and the response fields. Separately, `config.theme` was settable via `memesh config set theme` and `POST /v1/config` but read by nothing — the dashboard theme lives entirely in `localStorage`. Removed from the config type, CLI `ALLOWED_KEYS`, and the HTTP schema. (`tfidf`, also flagged by the audit, was checked and KEPT — it is the live sentinel for "no neural embedder".)

### Fixed
- **Dashboard analytics panels no longer vanish silently on a single-endpoint failure** (`dashboard/src/components/AnalyticsTab.tsx`) — the tab fetched `/v1/stats`, `/v1/analytics`, `/v1/patterns` with `.catch(() => null)` each, but the error box only showed when both stats and analytics were null, so a `/v1/patterns`-only outage made the patterns panel disappear with no signal. Each failure now logs to the console.
- **`POST /v1/config` test now verifies persistence** (`tests/transports/http.test.ts`) — it asserted only status 200 + `success:true`, so a silent write-drop stayed green; it now writes `sessionLimit` and reads it back via `GET /v1/config`.


### Docs
- **Corrected long-standing doc drift against the code** — `docs/ARCHITECTURE.md` listed `temporal validity` as a live scoring factor, but `scoring.ts` removed it in 2026-05 (`valid_from` / `valid_until` were never written by any code path, so it was a constant 1.0 no-op); `ARCHITECTURE.md` also contradicted itself, describing six factors in one place and "five signals" in another. Both now list the five real weights. The MCP file tree was also wrong in both docs: `launcher.ts` and `server.ts` live in `src/mcp/`, not `src/transports/mcp/` (which contains only `handlers.ts`), and `src/mcp/tools.ts` is a re-export shim. HTTP endpoint count corrected to ~32 to match `src/transports/http/server.ts`.
- **`docs/ARCHITECTURE.md` Session Start section rewritten** to document the two-channel output contract (human `systemMessage` vs model `additionalContext`), why the split is load-bearing, and the real session-file path (`~/.memesh/sessions/<pid>-<timestamp>.json`, not `~/.memesh/last-session-injected.json`).
- **All 11 README locales now have an `## Upgrading` section** (`README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`, `README.ko.md`, `README.de.md`, `README.fr.md`, `README.es.md`, `README.pt.md`, `README.vi.md`, `README.th.md`) — v4.2.5–v4.2.7 release notes added the upgrade flow + pre-v4.2.5 fallback to English + Thai only, so 9 locales were missing the section entirely. Now every locale has the three upgrade paths and the npm-global fallback note.
- **"Actively developed" callout at the top of every README** — adds a `> [!IMPORTANT]` block immediately after the hero divider linking to the GitHub Issues tracker. Sets expectations that features evolve between releases and routes bug reports / feature requests to the correct channel from the first glance.

### Added
- **`memesh kg rename-project` — heal project tags mis-homed before git-based identity** (`src/core/project-tags.ts`, `src/transports/cli/cli.ts`) — the forward-fix (git-remote-slug project identity) only affects NEW captures; existing entities keep whatever `project:<name>` tag they were written with, so a repo split across `project:tim` / `project:TIM` (or captured in a subdirectory) stays split. This is the deliberately-separate, opt-in healer: `rename-project` (no args) lists every project tag + count; `--from X --to Y` previews a dry-run; `--apply` commits after copying the whole DB to `data/backups/kg-before-rename-project-<ts>.db` and printing the restore command. Respects the `UNIQUE(entity_id, tag)` constraint (an entity already carrying the target tag has its old tag removed rather than duplicated). Backup failure aborts without mutating.
- **LLM telemetry now surfaces per-model, per-project, and recent-error detail** (`src/core/llm-telemetry.ts`, `src/transports/cli/cli.ts`, `dashboard/src/components/LlmTelemetryPanel.tsx`) — the `model`, `project`, and `error_message` columns were written on every attempt but never read back, so "which model is failing", "which project's calls fail most", and "what did the failure actually say" were all unanswerable. `summariseTelemetry` now returns `by_model`, `by_project`, and up to 5 recent `sample_errors` alongside the existing `by_provider`/`by_error_class`; the `memesh telemetry` CLI and the dashboard LLM-activity panel render them. `/v1/telemetry` returns the new fields automatically.

### Added
- **`memesh pin` / `memesh unpin` — protect a memory from the dreamer's auto-compaction** (`src/core/operations.ts`, `src/transports/cli/cli.ts`) — the dreamer already read `metadata.pin === true` and documented "never compresses pinned entities", but nothing could ever SET the flag: `remember` exposes no metadata field, and import discards it. The protection was inert — every entity was compactable regardless of the promise. `setPinned()` (behind the new `pin`/`unpin` commands) writes/removes the flag via `updateEntityMetadata`, preserving trust/provenance. End-to-end verified: an unpinned commit cluster is proposed for compaction; after `pin` the same cluster is skipped (`clustersScanned` drops to 0).

### Fixed
- **Comprehensive fake-working sweep (6-dimension scan): hook input-field bugs + a contract-gate coverage hole** (`scripts/hooks/pre-compact.js`, `scripts/hooks/session-summary.js`, `tests/hooks/hook-output-contract.test.ts`) — a full-codebase scan for "produces output nothing consumes / looks wired but does nothing" surfaced several confirmed issues, all verified against the shipped Claude Code `cli.js` bundle (not docs):
  - `pre-compact.js` read `data.reason`, but Claude Code's PreCompact payload names the field `trigger` — every compaction recorded "Compaction reason: auto" regardless of manual/auto. Now reads `data.trigger` (bundle: `hook_event_name:"PreCompact",trigger,custom_instructions`).
  - `pre-compact.js`'s transcript-read `catch` had no stderr trace — the exact twin of the `session-summary.js` outer catch fixed earlier this branch, missed the first time. A real read failure reported "Saved 0 insights" while losing the whole capture; it now traces (ENOENT stays silent).
  - `session-summary.js` guarded on `stop_reason === 'user_interrupt'`, but the Stop payload carries no `stop_reason` field (verified: Stop input is `{...base, hook_event_name:"Stop", stop_hook_active}`; the `stop_reason` in the bundle is the Anthropic API message field). The guard was always false — a filter that looked active but never skipped anything. Removed; the `toolCallCount < 3` check is the real low-signal filter.
  - The cross-hook contract gate ran every hook against an **empty DB**, but `pre-edit-recall` and `session-start` only emit their `hookSpecificOutput` — the branch the gate exists to validate — when memories exist. So that branch was contract-unvalidated and a malformed payload (the #53 class) could ship on the two most-fired hooks. The gate now seeds memories for those cases so the emitting branch actually fires under the validator; mutation-verified (an invalid `hookEventName` / extra field now reddens the gate where it previously stayed green).

- **Project identity now derives from the git repo, not the current directory's name** (`src/core/paths.ts`, `scripts/hooks/_shared.js`) — `getProjectName()` returned `basename(cwd)`, so a memory captured while working in `<repo>/backend` was tagged `project:backend` and became invisible when recalling from the repo root (`project:<repo>`), and the same repo split across `project:tim` / `project:TIM` by directory-name case. On a real 973-tag database ~10% of tags were mis-homed this way. Resolution is now layered — git remote slug → git repo root basename → `basename(cwd)` — so the identity is location-independent (same from any subdirectory or worktree) and case-canonical (the remote spells the name once). Non-git directories keep the exact prior behaviour, so every test fixture and scratch dir is unchanged; only real git working directories gain the fix. Resolved once per cwd and cached. This is forward-only: existing mis-homed tags are left as-is (a backfill that rewrites them touches real user data and will ship separately, opt-in, with a DB backup). Verified end-to-end that the core resolver and the hook-side mirror agree.
- **`pre-edit-recall` Strategy 1 (`file:<name>` tag lookup) had no producer and returned zero rows for every user** (`scripts/hooks/session-summary.js`) — the hook's most precise recall path queried `file:auth.ts` / `file:auth` tags that nothing ever wrote (0 `file:%` tags across the entire real database), so it was dead on arrival and all recall fell through to the filename-FTS proxy. Session capture now tags each session-insight entity with `file:<basename>` (both the full name and the extension-less form the read path queries) for every edited file, lighting the strategy up: a memory captured while editing a file becomes findable the next time that file is edited. Verified end-to-end (producer writes the tags → consumer injects the matching session-insight).
- **OpenAI tool export (`exportOpenAITools`) was missing `relations` + `namespace` on `remember` and `include_archived` + `namespace` + `cross_project` on `recall`** (`src/core/schema-export.ts`) — an agent driven off the exported OpenAI function schema literally had no parameter to send graph edges, so every entity it created was an orphan node with no relations, and it could neither scope by namespace nor search across projects/archives. The export now mirrors the `RememberSchema` / `RecallSchema` Zod definitions (the real validation source of truth) field-for-field. A new non-tautological parity test derives the expected fields from the Zod schemas themselves, so any future field added to the schema fails the export test until the export catches up (mutation-verified). The MCP/HTTP surface and `docs/api/API_REFERENCE.md` always had these fields — only this programmatic export had drifted.
- **Four core failure paths that silently no-op'd now trace to stderr, and `src/core` empty catches are now a lint error** (`src/core/config.ts`, `src/core/extractor.ts`, `src/core/failure-analyzer.ts`, `scripts/hooks/session-summary.js`, `eslint.config.js`) — each of these swallowed a real failure and returned an all-green empty result, so a broken install looked healthy. `readConfig()` returned `{}` on a corrupt/unreadable config (disabling every Smart-Mode feature and silently dropping a BYOK embedder back to 384-dim ONNX) — it now distinguishes a missing file (normal Core Mode, silent) from an existing-but-unreadable one, which traces once per (path, error) so it can't flood the hot path. `parseTranscript()` (both the core copy and the session-summary hook mirror) returned an empty result on any read error, emptying all session extraction downstream — it now stays silent on ENOENT (transcript not written yet) but traces a genuine I/O/permission fault. `analyzeFailure()` returned `null` both when the LLM call threw and when it succeeded-but-returned-unusable-JSON — the latter recorded `ok` telemetry while the self-improvement loop quietly died, so both now trace, distinguishing "call failed" from "call worked, reply unusable". To stop the class from regrowing, `no-empty` is now `error` with `allowEmptyCatch:false` scoped to `src/core/**`: a swallowed error there must carry a one-line reason (`catch { /* why */ }`), making every silent catch a decision someone wrote down. All traces are mutation-verified.
- **Windows: hook → dist dynamic imports silently threw, disabling LLM analysis, lessons, dream and auto-decay for 100% of Windows users** (`scripts/hooks/session-summary.js`, `scripts/hooks/session-start.js`, `scripts/hooks/_shared.js`, `scripts/release-verify.sh`) — ESM `import()` takes a URL, but seven call sites passed `import(join(pluginRoot, 'dist/...'))`, an absolute path. POSIX tolerates the leading `/`; on Windows `D:\...` is read as a `d:` URL scheme and rejected (`Only URLs with a scheme in: file, data, and node are supported`). Each caller's surrounding `catch` traced the error to stderr and moved on, so on Windows the Stop hook's failure analysis + lesson creation, the dream auto-trigger, and the session-start noise-compression/auto-decay all did nothing — while macOS/Linux and `memesh doctor` stayed green. The two init-time install-channel imports were already correct (`pathToFileURL().href`), so the discipline existed and simply stopped at these sites. Fixed at the root with a single shared `importFromPluginRoot(pluginRoot, relPath)` helper next to `resolvePluginRoot`, so the URL conversion is done correctly once and cannot drift per-site again; all seven sites now route through it. A new static gate in `tests/hooks/plugin-root-and-drift.test.ts` scans every shipped hook and fails on any `import(join(...))`, plus a behavioural test that the helper actually loads a real dist module (mutation-verified).
- **`memesh doctor` no longer downloads a ~90 MB model as a side effect** (`src/core/doctor.ts`) — v4.2.7 rewrote the embeddings row from a hardcoded `pass` into a real probe (correct), but the probe called `embedText()`, which on a cold cache downloads `Xenova/all-MiniLM-L6-v2` (~90 MB) into `~/.memesh/models`. A diagnostic command you reach for *because the network is misbehaving* must never be the thing that starts a large download, and a hosted BYOK embedder would additionally spend a billed API call. The probe now runs for real only when it is cheap and side-effect-free — a local ONNX model already on disk (`existsSync` check); a cold ONNX cache or any BYOK provider now renders an informational `NOT VERIFIED` row naming the reason, with `memesh doctor --probe` to opt into the download / live call. `--probe` behaves exactly as before. "Not verified" and "verified working" still render differently — the point of the v4.2.7 fix is preserved, only its unwanted side effect is removed.
- **Doctor tests could download the model into a temp dir mid-suite** (`tests/core/doctor.test.ts`) — none of the 30 `runDoctor()` call sites injected an `embedTextImpl`, so with the v4.2.7 real-probe the first doctor test to run did the 90 MB download into its per-test `MEMESH_DIR`; the ONNX pipeline is a module-level singleton that never releases its file handles, so `afterEach`'s `rmSync` then failed with `ENOTEMPTY` on windows-latest (green everywhere else). All calls now go through a wrapper that injects a stub embedder by default, and a new 8-test block locks in the no-download / no-bill contract (mutation-verified).
- **`llmFallbacks` is now settable, so cross-provider LLM failover actually engages** (`src/transports/cli/cli.ts`) — v4.2.0 shipped the whole consumer side of failover (`config.ts`, `consolidator`, `dream`, `session-summary`) but no setter: the key was absent from the CLI's `ALLOWED_KEYS` and the dashboard never sent it, so short of hand-editing `~/.memesh/config.json` the value stayed `[]` for everyone and all 5 Smart-Mode flows still died on the primary provider's first auth/rate error — the exact failure the feature exists to survive. `memesh config set llmFallbacks '[{"provider":"openai","model":"gpt-4o-mini","apiKey":"sk-..."}]'` now works, validated as a JSON array of objects each carrying a known provider.
- **`memesh dream list --status accepted` no longer silently returns nothing** (`src/transports/cli/cli.ts`) — accepting a proposal writes status `applied`, so `accepted` was a value no row could ever hold. Help text now lists the three real values: `pending | applied | rejected`.
- **Dashboard PM Metrics card was never rendering** (`dashboard/src/components/PmAnalyticsPanel.tsx`) — `api()` already unwraps the `{success, data}` envelope, but the component declared the envelope as its type argument and read `.data` a second time. The result was always `undefined`, `if (!data) return null` always fired, and the card silently vanished while the server recomputed velocity, staleness and KG orphan rate on every load.
- **The digest validator no longer reports `pass` when it never ran** (`src/core/digest-validator.ts`, `src/core/dreamer.ts`) — an unreachable LLM returned `status: 'pass'`, which is the same answer as "I checked every claim and they are all supported". A proposal was therefore recorded as validated when nothing had been validated. Failures now return a distinct `unavailable` status and trace to stderr. Behaviour is unchanged for callers (still never blocks a proposal); only the ability to tell "clean" from "not checked" is new.
- **A stray API key in your shell is no longer spent without a way to say no** (`src/core/config.ts`, `README.md`) — env auto-detect was originally opt-in behind `MEMESH_AUTO_DETECT_LLM=1` because an auto-detected `OPENAI_API_KEY` locked embeddings to 1536-dim. #36 fixed that properly by decoupling the embedder from the LLM provider, and F17 removed the gate — correctly. But the flag carried a second promise nobody re-homed: the README still told users "without this flag set, an `OPENAI_API_KEY` lying around in your shell is ignored". That had been false ever since, so a key present only for some other tool was silently used for every LLM write flow (consolidation, failure analysis, auto-tagging, dream) — the user's money, and their memory content sent to a provider they never chose here. Re-adding the opt-in would undo F17 and silently disable Smart Mode for everyone relying on env detection today, so the flag is now an explicit **opt-out**: auto-detect remains the default and `MEMESH_AUTO_DETECT_LLM=0` (also `false`/`no`/`off`) turns it off. An explicitly configured provider always wins over both. README corrected to describe what the code actually does.
- **Session-start recall now actually reaches the model** (`scripts/hooks/session-start.js`) — the hook emitted its entire payload as top-level `systemMessage`, which Claude Code renders to the human and **strips from the model's context** (`normalizeAttachmentForAPI` returns `[]` for the `hook_system_message` attachment). Combined with the v4.2.x switch to a count-only banner (`◉ MeMesh · 4 project + 5 recent memories`), this meant memesh ranked the top-N memories at every session start and then delivered **none of them** to the agent — the banner reported a memory count the model never received. The hook now emits two channels: the count banner stays in `systemMessage` for the human, and the ranked entities (lessons first, one observation snippet each, capped at 4000 chars) go out as `hookSpecificOutput.additionalContext` with `hookEventName: "SessionStart"`, which *is* injected into the model's context.
- **Recall-effectiveness scoring no longer penalises memories that were never shown** (`scripts/hooks/session-start.js`) — a direct consequence of the bug above. `session-summary.js` reads the session file written at start, and for every entity listed there increments `recall_hits` if its name appears in the transcript and `recall_misses` otherwise. Because the entities were never actually injected, virtually all of them took a `recall_miss` every session, driving `impactScore` (10% of ranking weight, Laplace-smoothed `hits/(hits+misses)`) toward zero for exactly the memories memesh had ranked highest — a self-reinforcing decay that buried good memories the agent was never given a chance to use. The session file now records the **real injected text** as `injectedContext` (previously the count banner), so the Stop hook can strip memesh's own injection from the transcript before deciding whether the session referenced a memory.
- **Stop hook no longer miscounts its own injection as memory usage** (`scripts/hooks/session-summary.js`) — the hit/miss check removed the injected block from the transcript with `transcriptText.replace(injectedContext, '')` and then substring-matched entity names. Transcripts are JSONL, so the injected text is JSON-encoded and a multi-line `replace()` of a ~2 KB block never matches — the injection stayed in and every injected entity scored a hit. Counting occurrences and requiring `transcript > injected` fails for the same underlying reason: Claude Code echoes ONE SessionStart injection into the transcript at least twice (`hook_success` carrying the raw stdout, plus `hook_additional_context`), so `2 > 1` holds for every entity. Both approaches depend on guessing an undocumented internal. The hook now strips the echo records structurally (`stripHookEchoes`) — matching on `attachment.type` in `hook_success` / `hook_additional_context` / `hook_system_message` — which is independent of both the copy count and the JSON escaping. Decision extracted to the exported, unit-tested `isRecallHit()`; its fixtures deliberately contain both echo records.
- **PreCompact hook no longer fails Claude Code's output validation on every compaction** (`scripts/hooks/pre-compact.js`) — closes [#53](https://github.com/PCIRCLE-AI/memesh-llm-memory/issues/53). The hook emitted `hookSpecificOutput.hookEventName: 'PreCompact'`, but Claude Code's hook-output schema defines `hookSpecificOutput` variants for exactly nine events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `SessionStart`, `Setup`, `SubagentStart`, `Notification`) — `PreCompact` is not among them, so the payload failed union discrimination at the root and every compaction surfaced `Hook JSON output validation failed — (root): Invalid input` to the user. The insight save itself always succeeded, so no data was ever lost; this was user-visible noise only. The hook now emits the same message via the top-level `systemMessage` field, which is valid for every event.
- **Test flake: `tests/transports/http.test.ts > returns array (possibly empty) for no-match query`** — assertion was `toHaveLength(0)`, but `recallEnhanced` may supplement FTS5 results with sqlite-vec near-neighbours when ONNX embeddings are loaded, so a query that misses FTS5 can still legitimately return a small set. The API contract is "always return a valid JSON array of entities, never a 500"; assertion now mirrors that contract (length bounded, all rows shaped like entities).
- **Test flake: `tests/tools.test.ts > auto-archives entity when superseded by new remember`** — same root cause; the `recall('JWT')` after archiving `auth-v2` asserted exactly `[]`, but vector supplement could surface the related `auth-v3`. The behavioural guarantee is "archived rows stay hidden from default recall", so the assertion now checks `not.toContain('auth-v2')` instead of empty-array.
- **Test isolation: `tests/hooks/pre-bash-orchestration-nudge.test.ts` no longer reads the developer's real `~/.memesh/config.json`** — `isAgenticOrchestrationEnabled()` falls back to `readHookConfig()` when the env var is unset, and `readHookConfig()` reads `<memeshDir>/config.json`. The "default off" test deleted the env var but didn't pin `MEMESH_DIR`, so a developer with `enableAgenticOrchestration: true` in their personal config saw the test fail even though hook code was correct. Both the test helper and the gate-off case now point `MEMESH_DIR` at the per-test tmpdir.

### Added
- **Shared hook-output contract + cross-hook CI gate** (`tests/helpers/hook-output-contract.ts`, `tests/hooks/hook-output-contract.test.ts`) — root-cause fix for the class of bug behind #53, not just the one instance. Every hook test previously hand-asserted the shape its own hook happened to emit, so the assertions mirrored the implementation and stayed green while the implementation violated the external schema (`tests/hooks/pre-compact.test.ts` asserted the invalid `PreCompact` variant, actively locking the bug in). The new helper encodes the real contract — 7 valid top-level fields and the 9 events that have a `hookSpecificOutput` variant — extracted from the shipped Claude Code CLI bundle (v2.1.19) rather than from the public docs, which list every hook *event* and are not the same set. The new test drives all 7 shipped hooks and validates their stdout against that contract, asserts each hook's declared `hookEventName` matches the event it is bound to in `hooks/hooks.json`, and fails if a hook is added to `hooks.json` without a contract case. Verified non-vacuous by re-introducing the #53 payload and confirming the gate fails.

## [4.2.7] — 2026-05-13

### Added
- **`memesh doctor` Shell CLI check** (`src/core/doctor.ts`) — new check `Shell CLI on PATH` resolves `memesh` via the user's shell PATH (`which` / `where`) and detects the most common plugin-marketplace gotcha: plugin is installed (MCP + hooks + `/memesh` skill work) but `memesh` is NOT on the shell PATH, so typing `memesh reindex` in a terminal yields `command not found`. WARN on plugin-marketplace installs without a separate shell-PATH `memesh`, with the exact fix command (`npm install -g @pcircle/memesh`) and the clarification that both paths coexist and share the same DB. Informational PASS on `npm-global` (running from the install itself), `source-checkout` (informational only), and any plugin-marketplace install that already has a separate shell-PATH `memesh`. Mirrors the new "Install paths at a glance" section landed in v4.2.6 docs — users who hit the gotcha now get told by doctor instead of having to re-read the README.
- **`memesh export -o <file>` flag** (`src/transports/cli/cli.ts`) — `memesh export` now accepts an `-o, --out <file>` flag that writes the JSON snapshot directly to a file. Previously the only path was stdout redirect (`memesh export > backup.json`) which wasn't documented in `--help`, so users coming from CLI conventions of every other tool tried `-o backup.json` first and saw `error: unknown option '-o'`. Stdout mode is preserved as the default (pipe-friendly). The file mode also prints a one-line confirmation to stderr so the user knows it landed.

### Changed
- **`memesh forget --confirm` is now accepted as a no-op** (`src/transports/cli/cli.ts`) — `memesh forget` is a soft archive, no confirmation gate is needed, but rejecting the flag outright as `unknown option` was hostile to users coming from `rm -i` / `git branch -D` conventions. Adding the flag as a documented no-op (marked `[deprecated, no-op]` in `--help`) closes the surprise without changing semantics.
- **`memesh install-hooks` refuses to double-wire over an active plugin install** (`src/core/install-hooks.ts`) — when Claude Code's plugin runtime is already loading memesh's hooks (via `/plugin install memesh@pcircle-memesh`), writing the same hooks into `~/.claude/settings.json` would cause every event (session-start, Stop, PreToolUse, etc.) to fire memesh's hook scripts **twice** — duplicate `session-insight` entities, duplicate recall injections, duplicate orchestration nudges. `installHooks()` now detects the plugin install via `~/.claude/plugins/installed_plugins.json` and bails with a clear message naming the install path + version, leaving the user with a `--force-over-plugin` escape hatch for the rare case where double-firing is intentional. CLI surface (`memesh install-hooks`) surfaces the new state directly so the message is visible without a JSON return inspection.
- **`memesh install-hooks --dry-run` wording is now future-tense** — was "Added 7 hook entries, skipped 0" (past-tense in dry-run mode is misleading); now "Would add 7 / would skip 0".

### Fixed
- **HTTP server: unknown routes return JSON 404** (`src/transports/http/server.ts`) — previously the server fell through to Express's default `text/html` 404 page (`<!DOCTYPE html>...Cannot GET /v1/whatever`). Every other route returns `{success, data}` JSON, so a typo'd path broke clients piping through `JSON.parse`. A catch-all JSON 404 middleware now sits at the end of the router and returns `{success: false, code: "NOT_FOUND", error: "No route for <METHOD> <path>"}`.

### Docs
- **README (English + Thai) upgrade-plugin.sh instruction now covers pre-v4.2.5 users** (`README.md`, `README.th.md`) — the v4.2.6 release notes told users to run `bash ~/.claude/plugins/cache/pcircle-memesh/memesh/<v>/scripts/upgrade-plugin.sh`, but plugin installs created before v4.2.5 don't contain this file (it was added in v4.2.5). Existing v4.2.3 / v4.2.4 users have no way to bootstrap the upgrade from inside their plugin install. Added a fallback line pointing at the npm-global copy (`$(npm prefix -g)/lib/node_modules/@pcircle/memesh/scripts/upgrade-plugin.sh`), which works the moment the user runs `npm install -g @pcircle/memesh` (which they already need for shell CLI access — see the "Install paths at a glance" section). Other 9 locale READMEs still need a full `## Upgrading` section to host this note; will follow up.

## [4.2.6] — 2026-05-13

### Fixed
- **`memesh doctor` and hook self-heal now follow npm hoisting** (`src/core/doctor.ts`, `scripts/hooks/_shared.js`) — the v4.2.5 native-binding check pre-checked `<packageRoot>/node_modules/better-sqlite3` literally, but when memesh is installed as a dependency npm hoists `better-sqlite3` to the consumer's top-level `node_modules/`. Result: every fresh `npm install @pcircle/memesh` saw a FAIL on the native-binding check even though the binding worked correctly. Both surfaces now resolve via `require.resolve('better-sqlite3', { paths: [pkgRoot] })`, which follows Node's normal resolution algorithm and finds hoisted packages. The hook's `npm rebuild` self-heal also targets the correct project root now (the package that owns the hoisted `node_modules`), not memesh's own pkgRoot.
- Doctor test `reports FAIL when node_modules/better-sqlite3 is entirely missing` updated to `reports FAIL with npm install hint when better-sqlite3 is not resolvable` — exercises the MODULE_NOT_FOUND probe response now that the existence-check branch is gone.

## [4.2.5] — 2026-05-13

### Added
- **`plugin-marketplace` install channel** (`src/core/install-channel.ts`) — `detectInstallChannel()` now recognises `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>` paths and routes them through their own `InstallChannelSupport` entry with channel-specific guidance. Previously plugin-marketplace installs were classified as `unknown`, so doctor + session-start gave generic "upgrade via your install method" hints with no actionable command. The plugin path takes priority over `.git` / npm-global checks because the plugin cache is itself a git clone.
- **`scripts/upgrade-plugin.sh`** — one-line upgrade for Claude Code plugin installs. Fast-forwards the marketplace cache, rsyncs the new version into `~/.claude/plugins/cache/`, installs runtime deps, patches `installed_plugins.json`. Idempotent (no-op when already current). Bridges Claude Code's version-pinned plugin layout to a single upgrade command — the marketplace itself does not auto-update.
- **Session-start "update available" banner** (`scripts/hooks/session-start.js`) — when the installed version is NOT deprecated but a newer release exists on npm, the session-start hook prints a single info line with the channel-tailored upgrade command (`memesh update` for npm-global, `bash <plugin-root>/scripts/upgrade-plugin.sh` for plugin installs, `git pull && npm install && npm run build` for source checkouts, `npm install @pcircle/memesh@latest` for project-local). Throttled to once per 24h per installed version so the banner doesn't nag.
- **README "Upgrading" section** — documents the three upgrade paths (Claude Code `/plugin` UI, one-line script, npm-global self-update) so users on an old version can find the path that applies to them.
- **Hook self-heal for missing `better-sqlite3` native binding** (`scripts/hooks/_shared.js`) — when `tryRequireBetterSqlite()`'s probe fails because the `.node` binding is absent (Claude Code's `/plugin install` runs `npm install --ignore-scripts` by security default, which skips both `better-sqlite3`'s install script AND memesh's `postinstall-rebuild.mjs` safety net), the hook now spawns a detached `npm rebuild better-sqlite3` in the package root. Throttled to one rebuild attempt per hour via an O_EXCL marker (`~/.memesh/last-rebuild-attempt.lock`) so a crash-loop can't drive a rebuild storm. The current hook still silent-skips, but the *next* session captures normally. Without this fix, plugin-marketplace users on Node ABI versions not covered by better-sqlite3 prebuilts (e.g. Node 24 / ABI v137) saw 100% silent dropout of the auto-capture loop — the DB stayed at 0 entities indefinitely.
- **`memesh doctor` native-binding probe** (`src/core/doctor.ts`) — new check `Native SQLite binding` that probes `better-sqlite3` by actually instantiating `new Database(':memory:')` (a bare `require()` is not sufficient — the JS wrapper succeeds even when the binding is missing). FAIL surfaces the exact `npm rebuild` command. Catches the silent-dropout failure mode that previously hid behind the existing "Hook activity (last 24h)" WARN, which used a grace period that swallowed fresh installs.

### Changed
- **Dashboard `DoctorBanner` filters non-actionable WARNs** (`dashboard/src/components/DoctorBanner.tsx`) — the banner used to fire on every `PASS_WITH_CONCERNS` doctor result, including WARN checks whose `fix` field was a generic "No action needed" placeholder. Result: alarmist title ("Heads up — memesh setup needs attention") above a self-contradicting body ("Installation method detection — No action needed"). The banner now only surfaces a check when status is FAIL, OR when status is WARN AND the doctor attached a non-placeholder `fix`. WARN-only banners get a softer title (`memesh has setup notes`) and drop the "Get help → file a GitHub issue" CTA, since the in-body fix command is the actionable path. FAIL banners keep the strong title + GitHub escalation.
- **Dashboard banner uses raw doctor summary/fix** — earlier it preferred a generic `doctor.<id>.summary` i18n override, which obliterated the actual diagnostic detail for WARN/FAIL states. A "binding missing" FAIL would render as the generic PASS-state label "Native binding detected". Now the banner shows what doctor actually said.
- **Removed the misleading `doctor.install-channel.fix: 'No action needed'` i18n overrides** across all 11 locales (`dashboard/src/lib/i18n.ts`) — these were the proximate cause of the self-contradicting banner copy. The check's real `fix` field (channel-specific upgrade instructions for FAIL/WARN) now reaches the user verbatim.

### Fixed
- **TOCTOU race in `tryRequireBetterSqlite()` self-heal block** (`scripts/hooks/_shared.js`) — the stale-marker cleanup path was `statSync → unlinkSync → openSync('wx')`, a 3-step dance where a peer hook could insert between any two steps. Worst-case outcome was duplicate `npm rebuild` spawns or one peer's fresh lock being stomped by another peer's stale-cleanup. Replaced with a single atomic `O_EXCL` claim — once the marker exists, every future hook bails. If a rebuild fails, the user clears the marker manually (the path is logged in the stderr breadcrumb alongside the manual `npm rebuild` command). Flagged by CodeQL as `js/file-system-race` (HIGH security severity).

### Changed
- **CodeQL analysis scoped to source paths** (`.github/codeql/codeql-config.yml`, `.github/workflows/codeql.yml`) — added an advanced-setup config that includes `src/`, `scripts/`, `dashboard/src/`, `tests/`, `hooks/` and excludes built artifacts (`dist/`, `dashboard/dist/`, minified bundles). Built outputs are regenerated from source on every release and would otherwise produce non-actionable findings (`js/property-access-on-non-object` on Vite runtime helpers, `js/automatic-semicolon-insertion` from minification, `js/trivial-conditional` from constant-folded bundler output). The matching source is already analyzed via the `paths` include.

## [4.2.4] — 2026-05-13

### Added
- **`memesh doctor` README locale-parity check** — compares H2 heading count across `README.md` and the 10 locale READMEs. Drift of 2+ headings (after ±1 translation tolerance) raises WARN; missing locales raise WARN; missing `README.md` skips silently. Fenced code blocks are ignored when counting so example markdown doesn't inflate the count.
- **`memesh kg backfill-relations --reset-idempotency`** — clear the persistent processed-orphan cache before running, so every orphan is reconsidered from scratch. Useful after schema changes or when you want a clean re-evaluation.

### Changed
- **LLM client now classifies malformed 2xx responses as recoverable** (`src/core/llm-client.ts`) — a body with missing or renamed fields, or a non-JSON body returned as JSON, raises a `parse` error so the cross-provider failover chain advances to the next provider instead of returning an empty string and treating it as success. An intentionally empty string from a provider is still a successful call (existing caller contract preserved).
- **`memesh kg backfill-relations` skips already-considered orphans** — the orphan-id cache lives in `memesh_metadata` under key `kg_backfill_processed_v1`. Reruns no longer pay the tokenisation and scoring cost for entities the command has previously inspected. Use `--reset-idempotency` to opt out.
- **HTTP body-limit response is now structured JSON** (`src/transports/http/server.ts`) — requests exceeding the 1MB body cap get `{ success: false, code: "PAYLOAD_TOO_LARGE", limit: "1mb", hint: ... }` instead of Express's default HTML error page. CLI export/import is unaffected (no per-request cap).
- **Lint runs at `--max-warnings 0` by default** (`package.json`, CI) — new lint warnings now block PRs. The redundant `lint:strict` script has been removed. CI runs lint before typecheck for faster fail-fast.

### Fixed
- **Plugin marketplace installs now work without npm/npx** (`.mcp.json`, `.gitignore`, `dist/`, `dashboard/dist/`) — Claude Code's plugin marketplace does not execute npm scripts on install (security model), so the previous setup left users with `-32000 "failed to reconnect to plugin:memesh"` because `dist/` was gitignored and the MCP server was re-installed via `npx` on every start. Compiled `dist/` and the dashboard build are now tracked in git so the plugin is runnable on clone. `.mcp.json` points at the plugin cache's local launcher.js, which already self-heals a missing better-sqlite3 binding via in-process rebuild (v4.2.2 work).
- **Dashboard launcher no longer invokes a shell** (`src/cli/view.ts`) — CodeQL flagged the Windows code path as `js/shell-command-injection-from-environment` / `js/indirect-command-line-injection` because `cmd.exe /c start <path>` re-parses the path through cmd's shell parser, and `MEMESH_DIR` can feed into that path. Windows now dispatches via `rundll32.exe url.dll,FileProtocolHandler` (no shell). macOS `open` and Linux `xdg-open` are unchanged.
- **F15 doctor test now inspects the actual corruption fixture** (`tests/core/doctor.test.ts`) — the "provides actionable fix commands for all failure modes" test uses the `MEMESH_DB_PATH` env override (matching every sibling F15 test) so doctor inspects the test database instead of falling through to the default path.

### Documentation
- **HTTP API request body limits** (`docs/api/API_REFERENCE.md`) — new section documents the 1MB cap, the 413 response shape, and points users at `memesh export` / `memesh import` for bulk operations that exceed the cap.

## [4.2.3] — 2026-05-12

### Fixed
- **Hook silent-skip guard misses lazy native-binding failure** (`scripts/hooks/_shared.js`) — `tryRequireBetterSqlite()` only caught `require('better-sqlite3')` failures, but the package's JS wrapper defers the `bindings()` call until the first `new Database()`. In plugin-marketplace cache installs the JS layer loads cleanly while the compiled `.node` is absent, so the helper handed back a constructor that threw "Could not locate the bindings file" on first use. The session-start hook then surfaced `MeMesh: Session start failed (Could not locate the bindings file ...)` to Claude Code on every startup. The probe now opens an in-memory database and closes it inside the same try/catch, returning `null` on either failure mode. Plugin-marketplace cache copies fall through to silent skip while dev / npm-global registrations continue to produce the summary.
- **Test coverage gap** (`tests/hooks/session-start.test.ts`) — added a second test seam (`MEMESH_TEST_FORCE_BINDING_LOAD_FAIL`) and matching test case that simulates the exact "require ok, native binding missing" failure mode. The pre-existing `MEMESH_TEST_FORCE_MISSING_NATIVE` seam short-circuited before `require()`, so the regression that v4.2.3 fixes was not exercised by the suite.

### Hardened
- **Silent-failure diagnosability** (`scripts/hooks/_shared.js`) — the probe's catch block was bare, collapsing five distinct failure causes (plugin-cache missing `.node`, ABI mismatch on Node major upgrade, disk full, fd exhaustion, tampered native module) into a single null return. The block now writes one diagnostic line to stderr (`[memesh hook] better-sqlite3 probe failed: <code> <message>`) before returning null. Stderr is **not** part of Claude Code's hook protocol channel, so this preserves the silent-on-stdout behavior the v4.2.3 fix delivers while making the underlying cause visible to `memesh doctor`, hook exit logs, and the user when they go looking. Follows the same stderr-trace-then-silent pattern used by `session-summary.js` and `post-commit.js`.
- **Test-seam production guards** (`scripts/hooks/_shared.js`) — both `MEMESH_TEST_FORCE_MISSING_NATIVE` and the new `MEMESH_TEST_FORCE_BINDING_LOAD_FAIL` seams now require `process.env.VITEST === 'true'` or `NODE_ENV === 'test'` to fire. An accidental shell export on a real user's machine no longer disables memesh's hooks. New test case verifies the seams are inert outside test environments.

## [4.2.2] — 2026-05-12

### Fixed
- **MCP server startup guard** (`src/mcp/launcher.ts`) — `db.ts` uses a static ESM import of `better-sqlite3`, which crashes the process before any try-catch can run when the native binding is absent. A new `launcher.ts` entry point uses a CJS `require` (catchable) to detect the missing binary, runs `npm rebuild better-sqlite3`, then hands off to `server.ts` whose ESM import cache is still empty and picks up the freshly compiled binary. `memesh-mcp` bin now points to `dist/mcp/launcher.js`.
- **`postinstall` script for native addon compilation** (`scripts/postinstall-rebuild.mjs`) — Claude Code's plugin marketplace installs packages with scripts that can silently skip `better-sqlite3`'s native build step, leaving the plugin non-functional. A new `postinstall` npm script detects a missing binary and rebuilds it; exits silently if the binary already exists. Non-fatal: warns to stderr and exits 0 if `npm rebuild` fails (e.g., missing build tools).
- **Entity name sanitization** (`src/transports/schemas.ts`) — `RememberSchema`, `ForgetSchema`, and `ExportResultSchema` now strip `\r\n\t` from entity names via `.transform()`. Prevents LLM-generated multi-line markdown from being stored raw as entity names, which produced garbled briefings in the session-start hook.

## [4.2.1] — 2026-05-11

KG connectivity + dashboard PM filter release. Reduces entity orphan rate from 89.2% → 11.7% on a representative knowledge base using two new non-LLM heuristics; adds milestone signal filtering to the Roadmap view; and introduces PM-framed analytics. +26 tests (984 → 1010 passing).

### Added
- **KG backfill Rule 3 — session co-occurrence** (`src/core/kg-backfill.ts`) — high-signal orphan entities sharing a `session:*` tag get a `co-created` relation. Gate: `signal_score ≥ 0.6` (reads entity `metadata`). Eligible types: lesson_learned, decision, architecture, feature, bug_fix, pattern, etc. Exposed via `memesh kg backfill-relations --session-cooccurrence`.
- **KG backfill Rule 4 — name-token similarity** (`src/core/kg-backfill.ts`) — orphans whose tokenized names share ≥ 3 content tokens OR Jaccard similarity ≥ 0.50 get a `shares-name-tokens` relation. `tokenizeName()` and `jaccardSimilarity()` exported as pure functions. Stopword list extended with generic qualifiers, process/lifecycle terms, and month abbreviations to prevent cartesian explosion (same failure mode as over-broad tag inclusion in Rule 1's co-occurrence filter). Exposed via `memesh kg backfill-relations --name-tokens [--min-jaccard N]`.
- **`memesh kg backfill-relations --all-rules`** — convenience flag enabling Rules 1–4 in a single pass.
- **PM Analytics endpoint** (`GET /v1/analytics/pm?window=N`) — pure-SQL aggregation: decision velocity (decisions/week, releases/month), staleness (stale plans ≥30d, open decisions ≥14d), connectedness (orphan rate, total relations, active entities). Zero LLM dependency.
- **Dashboard PM Analytics panel** (`dashboard/src/components/PmAnalyticsPanel.tsx`) — 4-stat grid surfacing the PM metrics in the Analytics tab. Color-coded orphan rate (green/amber/red). Fails silently if the endpoint is unavailable.
- **Dashboard milestone signal filter** (`dashboard/src/components/ProjectRoadmap.tsx`) — Roadmap milestone rail now filters out `feature`-type milestones with `signal_score < 0.65`, reducing noise from low-confidence auto-captured entries. Releases are always shown regardless of score. A "(N low-signal hidden)" badge appears when entries are filtered.
- **Integration test** (`tests/core/kg-backfill-integration.test.ts`) — seeds 46 entities across sessions, name-token clusters, and noise types; verifies orphan rate < 50% after all-rules backfill.

### Fixed
- **`doctor.test.ts` non-hermetic** — "reports PASS_WITH_CONCERNS" test was reading the real `~/.memesh/install-hooks.json`, which could have a stale `plugin_root` → `hook-wiring` returned `fail`. Test now sets `MEMESH_DIR` to an isolated temp dir like the other hermetic doctor tests.

## [4.2.0] — 2026-05-10

A combined release covering recall-path simplification, cross-provider LLM failover, end-to-end LLM telemetry, the new Insights / Analytics dashboard surfaces, KG-connectivity work, and a clean-slate quality bar (0 lint warnings, 0 executable `any` in src/). +6k LOC, +46 tests (938 → 984 passing). Highlights below grouped per Keep-a-Changelog convention.

### Added
- **Cross-provider LLM failover** (`src/core/llm-client.ts` + `config.ts`) — new optional `llmFallbacks: LLMConfig[]` config field walked in order when the primary `llm` provider fails with auth / rate-limit / upstream / network errors. A 400-class bad-request stops the chain (the prompt itself is broken). Per-attempt telemetry surfaces via `opts.onAttempt`; secret-shaped tokens (`sk-*`, `Bearer *`) are redacted before reaching telemetry. Wired into all 5 Smart-Mode flows (dreamer, pattern-detector, consolidator, auto-tagger, failure-analyzer). Accepted by the `POST /v1/config` endpoint with mirrored apiKey masking on GET responses. (Correction, 2026-07: the released v4.2.0 shipped no way to actually SET this field — it was missing from the CLI's allowed config keys and the dashboard never sent it, so `llmFallbacks` stayed `[]` on every install and the failover path never engaged. Fixed in Unreleased below.)
- **Persistent LLM telemetry** (`src/core/llm-telemetry.ts` + `llm_telemetry` SQLite table) — every callLLM attempt (primary + each fallback tried) writes one row with `{flow, provider, model, project, attempt_index, status, latency_ms, error_class, error_message, fallback_used}`. New `memesh telemetry [--window N]` CLI command renders a per-flow scorecard. Prompt and response bodies are intentionally NOT persisted — the schema stays narrow to avoid a new privacy boundary.
- **Dashboard Insights tab** (`dashboard/src/components/InsightsTab.tsx`) — surfaces the dreamer's pending / applied / rejected proposals with one-click accept/reject, replacing the CLI-only `memesh dream list`. New first-tab landing for fresh users. Backed by GET/POST `/v1/dream/proposals[/:id][/accept|reject]` endpoints.
- **Dashboard Insights banner** (`dashboard/src/components/InsightsBanner.tsx`) — slim cross-tab nudge appearing when pending proposals > 0. Click navigates to Insights tab; × dismisses for the current session (re-surfaces next session). Hidden when current tab is already Insights.
- **Dashboard Analytics LLM telemetry panel** (`dashboard/src/components/LlmTelemetryPanel.tsx`) — per-flow scorecard with success rate, fallback usage warning, median latency, provider breakdown, and error-class chips. 7d / 30d / 90d window pills. Color-coded left border by success rate (green ≥90%, yellow ≥50%, red <50%). Backed by GET `/v1/telemetry?window=N`.
- **Dashboard PatternCard** (`dashboard/src/components/PatternCard.tsx`) — distinct visual treatment for `pattern_emergent` proposals (amber accent, severity surfacing) so emerging patterns read differently from weekly recap digests. Wired through a new `kind` field on `ProposalSummary` that `listProposals` now returns.
- **Stop-hook dream auto-trigger** (`scripts/hooks/session-summary.js:maybeTriggerDream`) — after every coding session, if the project has ≥10 episodic entities and the project's last dream pass was >24h ago, spawn a detached `memesh dream run --max-llm-calls 2 --window-days 14` so the Insights tab populates without the user knowing the CLI exists. Per-project state in `~/.memesh/dream-history.json`; per-run logs under `~/.memesh/dream-runs/<project>-<ts>.log`.
- **Heuristic KG relation backfill** (`src/core/kg-backfill.ts` + new `memesh kg backfill-relations` CLI) — non-LLM connector for orphan entities. Two rules: tag co-occurrence (`related-to` for entities sharing ≥2 topical tags after a strict allow-list filter) and project clustering (`belongs-to-project` linking orphan lessons / decisions / bug-fixes to the most recent release / feature in the same project). Conservative filter excludes auto-capture noise (session_end, auto_saved, commit, completed, lesson, etc.) to prevent cartesian-edge explosion on dense lesson clusters.
- **Optional digest validator** (`src/core/digest-validator.ts` + `--validate` CLI flag on `memesh dream run`) — second LLM pass that cross-checks a proposed digest's claims against source observations. Returns `pass | soften | reject`. Soften writes the proposal with a `validation_warnings` array attached; reject skips the proposal entirely. Default off because it doubles per-proposal LLM cost. Validator's own LLM calls land in telemetry under flow=`digest_validator`.
- **`summarizes` / `evidence_for` relations on accepted dream proposals** (`src/core/dreamer.ts:applyProposal`) — accepting a digest now creates one `summarizes` edge per source entity (digest → source). Patterns get `evidence_for` (source → pattern). Without these edges, accepted digests showed as graph orphans even though they conceptually summarize their sources.
- **Dashboard roadmap tree + mindmap toggle** (`ProjectRoadmap.tsx`) — vertical timeline tree visualization (default) with a mindmap toggle for radial dendrogram view. Roadmap milestones now require a PM-anchorable entity (release / feature / decision / plan / architecture / bug_fix / lesson_learned / etc.) — date-range fallback labels for activity-only weeks have been retired.
- **`created_at` timestamp on dashboard memory rows** — every row in Browse / Manage now displays its absolute timestamp in `YYYY-MM-DD HH:mm` form alongside the relative-time badge.

### Changed
- **Recall is now strictly LLM-free.** The `query-expander` module has been retired (`src/core/query-expander.ts` and its 17 tests removed). `recallEnhanced` is single-pass FTS5 + sqlite-vec. Verified at 95.40% R@5 / 97.60% R@10 / MRR 0.8899 on LongMemEval-S Mode A — identical to the previously published baseline at every per-question-type breakdown. Mean per-query latency holds at ~18ms. Recall has been documented as FTS5-only on the hot path for several releases; the query-expander module is now removed so source matches docs exactly.
- **Dashboard graph tab card overflow fixed** — type-filter row converted from `flexWrap: 'wrap'` to `flexWrap: 'nowrap'` + `overflowX: 'auto'` (a horizontal scroll strip) so the canvas is no longer pushed below the viewport on a 1440x900 screen. `CANVAS_HEIGHT` reduced 500 → 440. Canvas width measurement switched to `getBoundingClientRect` minus card horizontal padding (24px) so sub-pixel layout never produces a horizontal scrollbar on the card itself.
- **Dashboard "dream" terminology replaced with user-friendly framing** — across 11 locales, "consolidate + dream compression" became "weekly recap + pattern detection". Same engineering work, less metaphorical naming.
- **Dashboard `Insights` is now the default landing tab** for fresh users (was Lessons). Existing users' last-tab persistence still wins.
- **CLI `memesh dream` summary preserves the full error reason.** The previous `s.reason.split(':')[0]` collapsed multi-segment provider errors (e.g. `"LLM call failed: provider error: 401"`) into the leading fragment, losing the error class. Full reason is now grouped and printed.
- **Doc-sync for the query-expander retire** — README + 4 locale parities (de / vi / th / pt) + ARCHITECTURE.md + API_REFERENCE.md + dashboard i18n's `settings.llmOptional.smartFeatures` (11 locales) all updated. Smart Mode benefits now described as auto-tagging + failure analysis + consolidate + dream, not "LLM query expansion (~97% recall)".
- **Type-safety pass across `src/`** — eliminated all 60 executable `any` instances in shipping code. Express handlers now use typed `Request<P, ResB, ReqB>` generics; `catch (err: any)` replaced with `instanceof Error` narrowing; SQLite metadata payloads typed as `Record<string, unknown>`. Pattern is uniform and PR-review enforces it going forward.
- **Lint health** — resolved every standing warning. `npm run lint` reports 0 errors and 0 warnings at v4.2.0. ESLint flat config now codifies the hook silent-failure pattern (`'no-empty': ['warn', { allowEmptyCatch: true }]`) so legitimate hook code passes while genuine empty blocks still surface.
- **Native i18n translations for v4.2.0 dashboard surfaces** — 8 locales (`ja`, `ko`, `pt-BR`, `fr`, `de`, `vi`, `es`, `th`) now have native translations for Insights / banner / telemetry / pattern keys. Previously these locales carried English placeholders to satisfy the parity test.

### Fixed
- **`/v1/config` GET response masks `llmFallbacks[].apiKey`.** Mirrors the existing `llm.apiKey` masking pattern. The `llmFallbacks` field is new in v4.2.0; the masking landed before any release tagged this code path. Verified end-to-end with a placeholder key.
- **`/v1/config` POST body schema accepts `llmFallbacks`.** Previously `ConfigBody.strip()` silently dropped the field, so the dashboard had no way to configure a fallback chain.
- **PatternCard cosmetic fixes** (`InsightsTab.tsx`):
  - busyId race on rapid accept clicks — replaced scalar `busyId` with `Set<number>` so two concurrent accepts don't stomp each other's button-disabled state.
  - `digest_observations_preview === '(empty)'` no longer renders as `(empty)…`.
  - Filter chips have `aria-pressed`, expand toggle has `aria-expanded` (accessibility).
  - Status-badge color falls back to neutral gray on unknown future status values.
  - Removed dead-code response-shape unwrap (`Array.isArray(data) ? data : ...`).

### Security
- API-key paths in fallback chains are masked on every dashboard config response (see Fixed).

### Tests
- 938 → 984 vitest tests (+46) across 63 files, +6k LOC. New test files: `tests/core/llm-client.test.ts` (failover decision tree, 23 cases), `tests/core/llm-telemetry.test.ts` (persistence + summarise, 4 cases), `tests/core/kg-backfill.test.ts` (heuristic contract, 19 cases), `tests/core/digest-validator.test.ts` (pass / soften / reject + sanitiser integration, 13 cases), `tests/hooks/dream-auto-trigger.test.ts` (gate + throttle + spawn, 5 cases). 3 independent LongMemEval-S Mode A regression runs confirm 95.40% R@5 unchanged.

### Migration
- A new `llm_telemetry` SQLite table is created on first `openDatabase()` after upgrade (idempotent `CREATE TABLE IF NOT EXISTS`). No data is migrated — telemetry starts fresh.
- Existing `dream_proposals` rows are unaffected. New proposals from `applyProposal` now also write `summarizes` / `evidence_for` edges, but historical proposals' graph connectivity is unchanged. Run `memesh kg backfill-relations` to retroactively connect the high-signal long tail.
- Dashboard build artifact (`dashboard/dist/index.html`) grows from 333 kB → 370 kB (gzip 84 kB → 90 kB) — the four new tabs / panels / cards landed inline.

### Known limitations
- **Windows `dream-auto-trigger.test.ts` "all gates pass" scenario is skipped.** Hook completes but `dream-history.json` is not updated when MEMESH_DIR is propagated through `execFileSync` to a child Node process. Functionality verified on macOS + Linux. The other four gate scenarios (LLM gate, activity gate, throttle gate, prefix-collision) all pass on Windows. v4.2.0 ships with stderr-trace instrumentation behind the `MEMESH_DREAM_TRIGGER_DEBUG=1` env flag so the failing gate can be identified from the first `[memesh dream-trigger] exit reason=…` line on a Windows runner.
## [4.1.7] — 2026-05-09

Marketplace identifier renamed from `pcircle-ai` to `pcircle-memesh` to avoid name collision with sibling PCIRCLE AI plugin repos that also self-publish marketplaces named `pcircle-ai` (e.g. `toonify-mcp`, `claude-code-buddy`). Users with any of those marketplaces already registered hit `Plugin "memesh" not found in marketplace "pcircle-ai"` on `/plugin install` because Claude Code binds one repo per marketplace name on the local machine, and earlier siblings won the binding.

### Changed
- **Install command** (Option A — Claude Code plugin):
  ```
  /plugin marketplace add PCIRCLE-AI/memesh-llm-memory      # repo URL unchanged
  /plugin install memesh@pcircle-memesh                      # was: memesh@pcircle-ai
  ```
  Only the marketplace identifier changed (`pcircle-ai` → `pcircle-memesh`). The plugin name (`memesh`) and the GitHub repo (`PCIRCLE-AI/memesh-llm-memory`) stay the same.
- **`.claude-plugin/marketplace.json`** `name` field: `"pcircle-ai"` → `"pcircle-memesh"`. The marketplace is now uniquely identifiable per plugin, which lets a user have all PCIRCLE AI plugin marketplaces registered simultaneously without collision.

### Migration for v4.1.6 plugin users
If you ran `/plugin marketplace add PCIRCLE-AI/memesh-llm-memory` on v4.1.6, the registered marketplace name was `pcircle-ai`. After this release, run these once to switch to the new name:

```
/plugin marketplace remove pcircle-ai
/plugin marketplace add PCIRCLE-AI/memesh-llm-memory
/plugin install memesh@pcircle-memesh
```

The `marketplace add` step will register the marketplace under the new `pcircle-memesh` name (read from `marketplace.json`).

### Backward compatibility
- `npm install -g @pcircle/memesh` users (Option B): unaffected. CLI binaries and behaviour unchanged.
- `memesh install-hooks` users: unaffected.
- Existing `~/.memesh/knowledge-graph.db`: untouched.
- The `.mcp.json` `npx -y -p @pcircle/memesh memesh-mcp` pattern from v4.1.6 stays — only the marketplace identifier changed.

## [4.1.6] — 2026-05-09

Marketplace manifest + plugin-context MCP wiring. The Claude Code plugin install (Option A) now delivers the full memesh experience — hooks, skills, MCP tools, CLI, and dashboard — without requiring a separate `npm install -g`. Adopts the standard `npx -y` pattern used by other stdio MCP plugins so memesh works identically whether installed as a Claude Code plugin or as an npm global.

### Added
- **`.claude-plugin/marketplace.json`** companion to the plugin manifest. With this file, the repo doubles as its own one-plugin marketplace. Users can install with:
  ```
  /plugin marketplace add PCIRCLE-AI/memesh-llm-memory
  /plugin install memesh@pcircle-ai
  ```
  alongside the existing `npm install -g @pcircle/memesh && memesh install-hooks` flow. The npm path is preserved verbatim — this is an additional install route, not a replacement.
- **`.gitignore`** further narrowed: previously `.claude-plugin/marketplace.json` was ignored alongside `.claude-plugin/plugin.json`. Now only `.claude-plugin/<other-plugin>/` subdirectories are ignored (where local-dev plugin installs land).

### Fixed
- **`.mcp.json` rewritten to use the standard `npx -y` MCP plugin pattern**: `command: "npx"`, `args: ["-y", "-p", "@pcircle/memesh", "memesh-mcp"]`. The previous form (`command: "memesh-mcp"`) required the binary to already be on PATH, which is true after `npm install -g` but not for plugin-only installs. The new form works in all three install contexts identically:
  1. **Claude Code plugin install** (Option A) — `npx` fetches `@pcircle/memesh` from the npm registry on first launch and caches it; subsequent launches are instant. No `dist/` build step or `prepare` script needed in the plugin install flow.
  2. **npm global install** (Option B) — `npx` finds the already-installed `memesh-mcp` on `PATH` immediately, no network round-trip.
  3. **Dev clone with `npm install`** — `npx` finds the locally installed `@pcircle/memesh`.

  This is the standard pattern for stdio-based MCP plugins distributed via npm (e.g. `npx -y @upstash/context7-mcp`). Plugin-only users (Option A) get a fully functional MCP server with no extra steps.
- **`marketplace.json` `source` field** changed from `"."` to `"./"` to match the [Claude Code marketplace spec](https://code.claude.com/docs/en/plugin-marketplaces#relative-paths) ("Must start with `./`"). Behaviour is unchanged in practice — both forms resolve to the marketplace root — but only `"./"` is spec-compliant.

### Documentation
- **README Get Started** rewritten so Option A delivers the full memesh experience. The plugin install gives hooks, skills, MCP tools, *and* full CLI / dashboard access — the latter via `npx @pcircle/memesh <command>` from any shell, with no `npm install -g` required. Option B (`npm install -g`) is now framed as an *optional optimisation*: it puts the `memesh` binary directly on `PATH` (skipping the per-call `npx` lookup) and exposes `memesh-mcp` as a fixed-path command for non-Claude-Code MCP clients (Cursor, Cline, etc.).
- **Step 2 / Step 3** examples updated: the bash examples assume Option B; Option A users replace `memesh` with `npx @pcircle/memesh` (same flags, no install) or use the `/memesh` skill / MCP tools inside the Claude Code conversation.

### Backward compatibility
- `npm install -g @pcircle/memesh` users: the `memesh-mcp` binary is unchanged; behaviour is identical.
- `memesh install-hooks` users: hook entries are unchanged.
- Existing `~/.memesh/knowledge-graph.db`: untouched.

## [4.1.5] — 2026-05-09

Structural repackaging for Claude Code's plugin marketplace. No behavioural changes for existing users.

### Changed
- **Plugin manifest moved** to `.claude-plugin/plugin.json` from `plugin.json` (root). This is the canonical location Claude Code's plugin spec expects, and the prerequisite for shipping memesh on the plugin marketplace. The manifest itself is now minimal — `mcpServers`, `hooks`, and `skills` references were removed because Claude Code auto-discovers them from default locations (`.mcp.json`, `hooks/hooks.json`, `skills/`). Path references updated in 3 build/test scripts and 3 docs files.
- **`.gitignore`** narrowed: previously `.claude-plugin/plugin.json` was ignored (a leftover rule from when `.claude-plugin/` only meant local-dev plugin installs). The pattern now ignores `.claude-plugin/<other-plugin>/` subdirectories while keeping memesh's own manifest tracked.

### Backward compatibility
- `npm install -g @pcircle/memesh` users: unaffected. CLI binaries unchanged.
- `memesh install-hooks` users: unaffected. Hook wiring path unchanged.

### Notes
- A `.claude-plugin/marketplace.json` companion (so users can `claude plugin marketplace add PCIRCLE-AI/memesh-llm-memory`) is a deliberate follow-up, not part of this release.

## [4.1.4] — 2026-05-08

Major release consolidating dashboard v2 + v3, the auto-update loop, the new `install-hooks` command, and an LLM-driven memory consolidation system.

### Added
- **`memesh install-hooks` / `uninstall-hooks` CLI.** `npm install -g` puts the CLI on PATH but did not previously wire MeMesh's session hooks into Claude Code. Without those hooks, the auto-capture loop (sessions → lessons → recall on next session) does not run for npm-global installs. `install-hooks` adds the hook entries directly to `~/.claude/settings.json` (or `<project>/.claude/settings.json` with `--scope project`), preserving any custom hooks the user already has. Idempotent + dry-run + backup-on-write. README Step 1.5 updated across all 11 locales.
- **7th hook — `user-prompt-intent.js`** — UserPromptSubmit hook that detects explicit "remember/save/memorize" intent in the user's prompt via conservative regex. Supported languages: English ("remember this", "save to memesh"), Spanish ("recordar esto", "guardar en memesh"), French ("rappeler ceci", "sauvegarder dans memesh"), Portuguese ("lembrar isto", "salvar em memesh"), Traditional Chinese ("記下來", "存到 memesh"). On match, emits `additionalContext` JSON reminding the agent to call `mcp__memesh__remember` for cross-project recall. Polite-reminder design (not autonomous extraction): the user's intent is clear, but *what* to remember depends on conversation context the calling agent already has. Defensive: never blocks the prompt; malformed stdin and other errors surface to stderr without affecting submission. Opt-out via `MEMESH_AUTO_CAPTURE=false`.
- **`memesh feedback` CLI** for terminal-only users. Builds the same pre-filled GitHub issue URL the dashboard widget produces, with `--bug` / `--feature` / `--question`, optional `--no-diagnostics` to opt out of the doctor JSON, and `--no-open` for headless flows.
- **`memesh dream` CLI — LLM-driven memory consolidation.** Three subcommands: `dream run` proposes digests for clusters of compactable episodic entries (commits, session-insights, weekly summaries), `dream patterns` surfaces emerging patterns / repeated mistakes / knowledge gaps across recent project activity, `dream list` / `accept <id>` / `reject <id>` review and apply proposals. Proposals always go to a staging table (`dream_proposals`) — source entities are never touched until the user accepts.
- **Rule-based `signal_score` on every entity.** `metadata.signal_score` ∈ [0, 1] stamped at creation time and backfilled on first run. Default threshold 0.4 hides empty session keypoints, trivial commits, and other low-value entries while keeping lessons / decisions / architecture / patterns visible.
- **Anonymous `install_id`.** Random UUID written to `~/.memesh/install.json` on first read, never transmitted automatically. Included in feedback issues only when the user opts in via "Include system info"; visible in `memesh doctor` output for transparency.
- **`embedder.provider` config** — separates embedding backend from LLM provider. Switching `llm.provider` no longer cascades into changing the embedder backend. Previously, that cascade could invalidate stored vectors. Defaults to ONNX (384-dim) for fresh installs; existing installs without `embedder.provider` keep their previous behaviour for back-compat.
- **`/v1/doctor` HTTP endpoint** returning structured `DoctorResult` JSON, with secret-redaction defence-in-depth before the response leaves the server. Used by the dashboard FeedbackWidget to attach diagnostics to support issues.
- **`DoctorBanner` dashboard component.** When doctor reports any WARN/FAIL check, a banner appears above the tabs with a "Get help" button that opens a pre-filled GitHub issue. Dismissable; remembers the dismissed-check signature so a *new* failure re-shows the banner without nagging on issues the user already chose to ignore.
- **Two new doctor checks:** `Hooks wired into Claude Code` (verifies hook entries are present in `~/.claude/settings.json` and the recorded plugin path still exists) and `Hook activity (last 24h)` (counts memesh-attributed entities to confirm the loop is alive).
- **Analytics tab v2:** `MemoryAgeMatrix` heat-map (type × age bucket) and `KnowledgeRadar` (six-axis SVG: lessons, decisions, patterns, bugs, processes, architecture). `/v1/analytics` augmented with `ageMatrix` and `knowledgeRadar` fields.
- **Graph tab signal-first loading.** All non-noise types always present + up to 200 recent noise entries, node radius scaled by `access_count` (log2), Drift Mode toggle re-colors nodes by `last_accessed_at` recency.
- **`/v1/entities ?type=<type>` query** parameter validated by Zod (max 100 chars; `?limit` capped at 500).
- **Settings tab Test-first API key flow.** New `POST /v1/config/test` probes the provider's `/v1/models` endpoint to verify the key authenticates and return the live model catalog. Test button gates Save (fail-closed). Suggested model picks the smallest / cheapest tier (`mini` / `nano` / `haiku` / `flash` / `lite`).
- **`scripts/release-verify.sh`** pre-publish gate. Runs typecheck, build, full vitest suite (LLM env stripped for offline runs), doctor smoke, install-hooks dry-run, feedback URL build, demo seed idempotency, and an optional live LLM probe. Exit non-zero blocks release.

### Changed
- **Auto-update spawn moved from SessionStart to Stop hook.** Avoids a TOCTOU race where `npm install -g` could overwrite `dist/` while peer hooks (pre-edit-recall, pre-bash-nudge) were still reading it mid-session. Shared flock and install-channel guards carry over: only `npm-global` installs self-update, only one concurrent session wins the lock.
- **`POST /v1/config` applies LLM changes immediately.** Every LLM call site reads config fresh on each call; the embedder's ONNX pipeline cache resets when provider or apiKey changes. Settings tab confirmation message simplified to "saved".
- **`memesh config set / unset` supports nested keys.** Previously only a hardcoded subset of `llm.*` keys was accepted. Now any key in the explicit allowlist (`llm.provider`, `llm.apiKey`, `llm.model`, `embedder.provider`, `embedder.model`, `autoUpdate`, `theme`, `sessionLimit`, etc.) works with dotted paths; unset prunes empty parent objects.
- **`/v1/graph` response includes `noiseTypes`** so the dashboard's default-hide list stays in sync with the server. Single source of truth: `src/core/analytics.ts NOISE_TYPES`.
- **Dashboard Onboarding banner is one-click GUI.** Replaced the previous "run `memesh demo` in your terminal" instruction with a primary button that POSTs `/v1/demo/seed` and refetches health automatically. CLI command kept for headless / CI flows.
- **Settings tab + OnboardingBanner explicitly explain LLM is optional.** New "Without LLM (Core mode) / With LLM (Smart mode)" copy across all 11 locales sets the expectation up-front instead of making the LLM provider card feel mandatory.
- **`src/cli/view.ts` split into `view.ts` + `view-live.ts`.** `view-live` is the HTTP-served fallback when the Preact build is absent.
- **Embedding dimension change now persists a reindex-needed flag** in `memesh_metadata`. `memesh doctor` surfaces a WARN until `memesh reindex` clears it.

### Fixed
- **Stop / PreCompact transcript parsers** updated for the current Claude Code transcript shape. Earlier parsers missed nested tool-call blocks; `toolCallCount` reported 0 and the LLM failure-analysis path did not run. Updated in `scripts/hooks/session-summary.js`, `scripts/hooks/pre-compact.js`, and `src/core/extractor.ts`.
- **Transcript parser false-positive errors.** The substring match `text.includes('Error') || text.includes('FAIL')` flagged any Read tool result containing the word "Error" (README/CHANGELOG content discussing errors) as a real session error. Now uses the explicit `is_error: true` flag Claude Code itself sets on failed tool calls.
- **Session-id duplicate-guard collision.** The Stop hook used `sessionId.slice(0, 8)` as a dedup key. Two session_ids sharing an 8-character prefix could cause the second hook to abort. Now uses the full session_id for both entity names and the dedup key.
- **30-day timeline chart blank after tab switch.** `MemoryTimeline` writes `canvas.style.width` for HiDPI; the inline value persisted across `display: none → block`, leaving a 0px canvas. Switched to `ResizeObserver` and clear inline width before measuring.
- **Lessons tab data source.** `fetchLessons()` was calling `POST /v1/recall` (recency-ranked, dominated by session noise); now uses `GET /v1/entities?type=lesson_learned`.
- **Demo `--reset` cleanup.** Now routes through `KnowledgeGraph.deleteEntity` so the FTS5 contentless virtual table and `entities_vec` rows are cleaned up (a bare `DELETE FROM entities` left orphan rows that resurfaced as phantom search hits). Wrapped in a single transaction so a mid-loop failure rolls back atomically.
- **Hard `deleteEntity` removes the vec row.** Mirrors `archiveEntity`'s cleanup. Without this, hard-delete paths left orphan rows in `entities_vec`.
- **`OnboardingBanner` runSeed clears `pending` in a finally block.** Previously the success path relied on the banner unmounting via `entity_count > 0`; if the follow-up health refetch was slow or failed, both buttons stayed disabled with no recovery path.
- **`OnboardingBanner` error toast adds `role="alert"` + `aria-live="polite"`** so screen-reader users hear seed/reset failures.
- **`failure-analyzer` LLM-failure path now logs to stderr** when the LLM call throws (401, network, rate-limit), so config issues are visible instead of producing no lesson without explanation.
- **Doctor lifecycle safety alongside the HTTP server.** `runDoctor()` now detects whether the database is already open (via new `isDatabaseOpen()` guard) and only closes the connection if it opened it itself. The dashboard can call `/v1/doctor` against a running HTTP server while other requests continue normally. CLI mode is unaffected.
- **Embedder dimension back-compat now consults explicit `cfg.llm` only**, never env-detected LLM. Keeps `embedder.provider` and `llm.provider` independent (per #36) regardless of shell environment. Regression tests assert the separation.

### Added (late additions to v4.1.4)
- **Settings dashboard "Remove provider" button** — drops the saved apiKey + model so the user can opt out of LLM-backed features without hand-editing `~/.memesh/config.json`. Falls back to env-var auto-detect or Core Mode (FTS5 + ONNX, no LLM features) if no credential is found. Only shown when an apiKey exists on disk; ollama (keyless) users switch via the radio buttons.
- **Build-time smoke test** (`scripts/smoke-test.mjs`) — runs after `npm run build` and verifies dist/ modules load, database CRUD works, HTTP server starts, and the dashboard artifact is present.
- **`isDatabaseOpen()` export** in `src/db.ts` for callers that need to detect whether the global database is already open before they touch its lifecycle.
- **Doctor warnings i18n coverage** — translated 15 doctor check IDs across all 11 dashboard locales (EN + zh-TW translated, others fallback to English).

### Removed
- **Three internal surfaces (G2/G3/G4)** — entity types and a dashboard widget that were not wired to user-visible features.
- **Dead code in `version-check.ts`** — stale `UPDATE_CHECK_PATH` constant + unused `getUpdateCheckPathForTests()` export.

### Migrations (one-time, automatic)
- `metadata.signal_score` is backfilled for all existing entities on first openDatabase call after upgrade. Marker `signal_score_backfill_v1` in `memesh_metadata` prevents re-runs.
- `dream_proposals` table is created automatically. Empty on upgrade; populated by `memesh dream` runs.
- Existing entities are preserved end-to-end. No data loss.

### Notes
- **LLM is optional**. memesh's wedge — 95.40% R@5 on LongMemEval-S using FTS5 alone — does not require an LLM. The `memesh dream` system, auto-tagger, and failure analyzer are all opt-in features that activate when `llm.provider` is configured.
- **Embedder/LLM are now decoupled.** Existing users on `llm.provider=ollama` keep their current 768-dim embeddings (back-compat); fresh installs default to ONNX 384-dim. Switch the embedder explicitly with `memesh config set embedder.provider <onnx|openai|ollama>`.
- **Run `memesh install-hooks` after upgrading** to ensure Claude Code session hooks are wired. `memesh doctor` will WARN until you do.

## [4.1.3] — 2026-05-06

Update-mechanism UX completion: deprecation-aware session banners and an opt-in auto-update policy.

### Added
- **Deprecation-aware session-start banner.** The npm registry check now reads the deprecation flag for the *currently installed* version, not just the latest available one. When maintainers flag a version (typically for a security advisory), the next session-start prepends a strong `⚠️ MeMesh <ver> is DEPRECATED by maintainers — <message>` banner above the recall summary, until the user upgrades. The flag round-trips through a per-installed-version cache file at `~/.memesh/update-check.<version>.json` (machines with multiple installs each keep their own slot, so one install's refresh can't overwrite another's deprecation flag), and a transient network failure can't dim a previously-recorded warning. `memesh update-status` and `memesh doctor` surface the same line. The dashboard's Settings tab adds a red-bordered deprecation card with channel-aware remediation (`memesh update` for npm-global, `npm install @pcircle/memesh@latest` for project-local, `git pull && npm install && npm run build` for source checkouts).
- **Opt-in `autoUpdate` policy field.** New `autoUpdate` config field (`'off' | 'patch' | 'minor' | 'major'`, default `'off'`) and matching `MEMESH_AUTO_UPDATE` env var with env > config > default precedence. The session-start hook records a "PENDING" entry in `~/.memesh/auto-update.log` when the policy permits the bump and the cache is fresh. v4.1.3 ships the policy resolution, deprecation-override decision matrix, and HTTP / dashboard surfaces; the actual `npm install -g` trigger ships in a later release. Until then, run `memesh update` manually after seeing the PENDING line.
- **Background update-cache refresh.** Every session-start fires a detached `memesh status` to keep the registry cache fresh for the next run, regardless of whether auto-update was pending. The session itself reads only the cache, so a slow npm registry never blocks startup.
- **`.github/workflows/deprecate-npm.yml`** — manually-triggered maintainer helper that runs `npm deprecate` against any published version using the existing `NPM_TOKEN` secret, so deprecations can be issued from CI without depending on local credentials.

### Notes
- 630 unit/integration tests pass, covering the `autoUpdate` policy and deprecation-override matrix, env > config > default precedence, deprecation cache round-trip and per-version scoping, concurrent-refresh safety, the Windows-safe atomic cache writer, and dashboard i18n parity across all 11 locales for the new update-status strings.
- No public API breaks. Default behaviour is unchanged for users who don't set `autoUpdate` / `MEMESH_AUTO_UPDATE`. The deprecation banner appears only when npm has actually flagged the installed version, so existing installs see no change unless a maintainer issues a deprecation.

## [4.1.2] — 2026-05-06

Patch release for findings raised by GitHub code-scanning (CodeQL) and the Windows CI lane on the v4.1.1 cut.

### Security
- **HIGH — `js/polynomial-redos` in `bearerAuth`** (`src/transports/http/server.ts`). The header parser used a regex of the shape `/^Bearer\s+(.+)$/i` against the trimmed Authorization header. Both `\s+` and `.+` match whitespace, so an attacker-controlled header that is mostly whitespace forced the regex engine to enumerate every split between the two quantifiers — quadratic in input length. Replaced with a single linear scan: find the first whitespace, verify the prefix is the literal `Bearer`, take the suffix. Regression test sends a 10 000-character whitespace-padded header and asserts both 401 and a sub-500 ms response (a return to the old quadratic shape would blow that bound).

### Fixed
- **Windows CI: `tests/hooks/plugin-root-and-drift.test.ts`** previously asserted `pathToFileURL('/abs/path/...')` round-tripped to a POSIX literal. On Windows the round-trip yields `D:\abs\path\...`, which is correct OS behaviour; the test was not platform-aware. The synthetic input is now built from `path.parse(process.cwd()).root` so the assertion holds on POSIX and Windows alike. The production hook code itself was already platform-correct (Node's `path.dirname` is OS-aware) — this was a test-only fix.

### Notes
- Five MEDIUM `js/file-access-to-http` alerts (`src/core/llm-client.ts`) flagged the LLM client for sending operator-supplied API keys (read from `~/.memesh/config.json`) to hard-coded provider endpoints — that is the intended behaviour of a BYOK client. Dismissed as `used in tests` / by-design with a rationale comment recorded on each alert.

## [4.1.1] — 2026-05-06

v4.1.1 fixes ten issues identified in the v4.1.0 refactor. Each fix ships with a regression test.

### Fixed
- **Hook dynamic-import path off-by-one** — `scripts/hooks/session-start.js` and `session-summary.js` computed the package root with `dirname(dirname(fileURLToPath(import.meta.url)))`. The hooks live at `<root>/scripts/hooks/<file>.js`, so two `dirname()` hops only reach `<root>/scripts`; subsequent `await import('<pkg>/scripts/dist/db.js')` calls got `ENOENT`, and a surrounding `catch` swallowed the error. Net result: weekly noise compression *and* LLM failure analysis were silently non-functional in v4.1.0. Both call sites now use a shared `resolvePluginRoot()` helper that performs the correct three-hop calculation. Regression test asserts the result resolves to a directory containing `package.json`.
- **Hook config drift on `MEMESH_DB_PATH`** — `scripts/hooks/_shared.js#readHookConfig` previously read `dirname(MEMESH_DB_PATH)/config.json`, while `src/core/config.ts` always reads/writes `~/.memesh/config.json`. Any custom-DB deployment silently ignored `memesh config set …` from the hooks (auto-capture, session limit, agentic-orchestration). Hooks now read the canonical homedir path unconditionally; tests pin both the new behaviour and the rejection of any DB-relative override.
- **Dashboard 401-on-load on remote bind** — When `MEMESH_REMOTE_TOKEN` was set, the server protected `/dashboard` (HTML) and `/v1/*` with bearer auth, but browsers cannot attach an `Authorization` header on a top-level navigation, and the dashboard SPA never sent a Bearer header on `fetch`. Result: every remote deployment broke the UI on first load. The HTML route is now served unauthenticated; the SPA reads the token from `localStorage` and attaches it to all `/v1/*` calls. A 401 surfaces an in-page token-entry prompt (`AuthPrompt` component) so the operator can paste the token without leaving the page.
- **Pre-auth JSON parse DoS** — `app.use(express.json({ limit: '1mb' }))` was registered globally before `bearerAuth`, so unauthenticated requests could trigger up to 1 MB of JSON parsing before the 401. The body parser is now scoped to `/v1/*` and registered after `bearerAuth` and `apiLimiter`. Regression test confirms a malformed-JSON body without auth returns 401 (not 400).
- **`remoteToken` module-global clobber** — A second `startServer()` bound to loopback used to overwrite the module-global `remoteToken` to `null`, silently de-authenticating any already-running remote listener attached to the same Express app. Auth requirement is now per-listener via a `WeakMap<http.Server, boolean>` keyed on `req.socket.server`. Remote and loopback listeners on the same app no longer cross-authenticate. Regression test stands up both listeners and asserts each keeps its own auth profile.
- **`verify_agent_work` rejected monorepo subdirectories** — `validateWorkdir` checked for a `.git` entry directly inside `workdir`, which rejected paths like `/repo/packages/app` even though every subsequent `git -C <workdir>` call would have succeeded. The function now asks git itself via `rev-parse --is-inside-work-tree`, which correctly accepts subdirectories of a working tree (and still handles `.git` files for worktrees/submodules).
- **`verify_agent_work` symlink bypass** — The same function used `path.resolve()`, which only normalises `./..` and does not follow symlinks. A symlink pointing at a different git repo passed validation while git operations actually ran against the symlink target. Now uses `realpathSync()` so the validated path is the path git operates on; the recorded report cites both the canonical path and the original input when they differ.
- **`removeFromFts()` swallowed real DB errors** — The contentless-FTS5 delete helper caught every exception, masking real failures (lock contention, disk full, schema corruption) the same way it masked the legitimate "row not found" case. The index could drift out of sync with the entities table with no operator signal. Now classifies errors: known-benign cases (`no such rowid`, value mismatch, no-such-row) silently no-op; everything else logs a single-line warning to `stderr`. Function still never throws so callers' atomic semantics are preserved.
- **WAL/SHM permission leak on sidecar recreation** — `db.ts` chmodded `<db>`, `<db>-wal`, and `<db>-shm` once at `openDatabase`, but SQLite recreates `-wal` and `-shm` later during normal operation (checkpoint truncate, fresh shm-mapping) using the process umask. On a default umask (0022) those recreated sidecars could be created world-readable, which on a multi-user host could expose observation data to other local accounts. The fix tightens `process.umask` to `0o077` before the first DB write so any later-created sidecars are born `0600`.
- **`memesh remember "..."` deterministic same-day collision** — The quick-capture path generated `quick-<date>-<slug>` from text + date. Two `memesh remember "fixed bug"` calls on the same day collapsed into one entity (because `remember()` appends observations on duplicate-name) — silent data loss for journal-style usage. Names now carry a 6-hex-char random suffix; each call is a distinct entity. Regression test runs the same text twice and asserts distinct entity names.

### Notes
- 593 unit/integration tests now pass (12 added in this release, exclusively regression tests for the items above).
- No public API breaks; tool signatures and HTTP routes are unchanged. Operators with a custom `MEMESH_DB_PATH` may need to migrate their `config.json` to `~/.memesh/config.json`, which is now the canonical location read by all components.

## [4.1.0] — 2026-05-04

### Added
- **9th MCP tool — `verify_agent_work`** — Persist agent verification reports as `verification_record` entities. Runs a deterministic git reality-check (diff `<base>..HEAD`, count files changed, optionally cross-check against a claimed file count) and stores the report tagged `verification:pass|fail`. Heavier checks (typecheck/tests/lint/build) are expected to be pre-computed externally and passed in via `report.*.pass`. New core module `src/core/verifier.ts`; HTTP endpoint `POST /v1/verify`; CLI `memesh verify <workdir>`.
- **`agentic-orchestration` skill** — Ships at `skills/agentic-orchestration/SKILL.md`. Defines the User=CTO / Claude=Orchestrator / Background-agents=Engineering team protocol, three-tier verifiability classifier, dispatch patterns (single bg, parallel bg, foreground, hybrid), and a mandatory post-agent verification gate. **Active surfaces (banner + Bash nudge + telemetry) are opt-in via `MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1`** (see *Changed* below).
- **6th hook — `pre-bash-orchestration-nudge.js`** — PreToolUse hook on Bash that injects a one-line advisory hint when Claude is about to run a high-verifiability command (test, build, lint, migrate, deploy, benchmark, npm-run-check). Throttled per category per session via per-category marker files.
- **`memesh remember` quick-capture form** — `memesh remember "OAuth 2.0 with PKCE"` now works without `--name`/`--type`. Fresh users naturally try this form first; the explicit-flag form remains the canonical contract.
- **Multi-reviewer PR workflow GitHub Action** — `.github/workflows/multi-model-review.yml` runs independent automated code reviews on every PR diff and posts results as comments to surface non-overlapping findings. No-ops cleanly if reviewer secrets are unset.
- **LongMemEval-S benchmark — public methodology + verifiable evidence** — Three-mode benchmark runner at `benchmarks/longmemeval/run.mjs`, full per-question results in `benchmarks/longmemeval/results/`, methodology in `METHODOLOGY.md`, 8-step reproduction in `REPRODUCE.md`, manual verification log in `MANUAL-VERIFICATION.md`. Mode A = R@5 95.40%, Mode B = R@5 95.40%, Mode C = R@5 82.40%. Dataset SHA256 verified against Hugging Face `xiaowu0162/longmemeval` (longmemeval_s variant). README first page now links the evidence pack so the proof point is visible without diving into `benchmarks/`.
- **`MEMESH_ENABLE_AGENTIC_ORCHESTRATION` env flag** — Opt-in switch for the experimental working-model protocol's active surfaces (session-start banner, Bash nudge, `verify_agent_work` telemetry). Default OFF.
- **`MEMESH_AUTO_DETECT_LLM` env flag** — Opt-in switch for shell-env BYOK provider detection. Default fresh-install is local ONNX (384-dim) only — an `OPENAI_API_KEY` lying around in your shell no longer accidentally locks `entities_vec` to 1536-dim.
- **README documentation** — New `## Configuration` section listing all environment variables (DB path, auto-capture, BYOK auto-detect, agentic-orchestration opt-in). New first-install notes documenting native-module prebuilds and ONNX first-time model download (~80 MB to `~/.memesh/models/`).

### Improved
- **Root build chain produces a complete artifact** — `npm run build` now also builds the dashboard sub-package via `scripts/build-dashboard.mjs`, which lazy-installs dashboard deps if missing and then runs vite build. Closes the gap where `dashboard/dist/index.html` (declared in `files`) was only produced in CI publish workflow but never by local `npm run build`. Eliminates the previous "pre-existing dashboard test failure" on feature branches by making the build chain end-to-end.
- **Three-tier verifiability classifier in agentic-orchestration skill** — Tier 1 (machine-verifiable: tsc, vitest, lint, build, migrate, benchmark) → background, parallel OK; Tier 2 (review-verifiable: API shape, schema, types, code review against checklist) → background OK + auto-trigger code-review; Tier 3 (judgment-required: UX, naming, architecture, strategy, public-facing copy) → foreground only.
- **Verification gate procedure** — Mandatory post-agent four-step gate documented in skill: reality check (git diff vs claim), hard verification (typecheck/test/lint/build), cross-check (numbers match), independent review (Tier 2). Each step is deterministic command output, not LLM judgment.
- **Telemetry field `cwd_hashed` uses real SHA-256** — In a pre-release form the field stored a 16-character path slice rather than a hash. The published form uses real SHA-256 truncated to 16 hex chars. Test `tests/hooks/session-start-telemetry.test.ts` asserts `/^[a-f0-9]{16}$/` so the contract cannot regress.
- **Benchmark runner records the version under test** — `run.mjs` reads `memesh_version` from `package.json` instead of a hard-coded string, so future re-runs record the correct version. Historical results frozen at v4.0.4 are preserved unchanged; a clarifying note in `RESULTS.md` documents that v4.1.0's retrieval path is identical (same FTS5 query, same scoring) so the 95.40% R@5 result also holds for v4.1.0.
- **CODE_OF_CONDUCT.md** — Adopted Contributor Covenant v2.1.

### Fixed
- **Same-millisecond entity-name collision in `verify_agent_work`** — Two parallel agents calling at the exact same ms previously collided on `verification:<agent>:<iso-ts>` and silently merged into one entity (since `remember()` appends observations on duplicate-name). Now appends a 6-char hex random suffix (`crypto.randomBytes`); collision probability ~16M⁻¹.
- **`-v` no longer suppresses verbose test runs** — The Bash nudge previously matched `-v\b` as a "version invocation" exclusion, swallowing legitimate verbose test commands like `pytest -v`, `go test -v`, `cargo test -v`. Removed: short-form `-v` is too ambiguous; only long-form `--version`/`--help`/`-h` are still treated as noise.
- **Throttle clobber under parallel-category load** — Two different Bash nudge categories firing in parallel (e.g. `npm test` + `npm run build` from background agents) read the shared throttle JSON, modified their bit, and wrote back — last-writer-wins lost one category's marker. Replaced with per-category marker files (`agent-nudge-flags/<category>.flag`) using O_EXCL atomic create. The flag *is* the lock; no shared state to clobber.
- **Telemetry path split when `MEMESH_DB_PATH` is set** — `session-start.js` was writing banner-injection events to `${memeshDir}/skill-usage.jsonl` while `logSkillEvent()` always used `~/.memesh/skill-usage.jsonl`. With a custom DB path the two writers diverged, so events from one path were not visible to readers of the other. Both writers now use `~/.memesh/skill-usage.jsonl` unconditionally — telemetry is per-user, not per-database.
- **Stale `4.0.4` version references** — `docs/ARCHITECTURE.md`, `docs/api/API_REFERENCE.md`, and the example response payloads now match `package.json` at 4.1.0.
- **Reviewer CI prompt-injection mitigation** — PR diff content (author-controlled) is wrapped in a `BEGIN_DIFF`/`END_DIFF` fence with explicit instructions to ignore in-diff directives.
- **Reviewer CI shell-precedence bug** — `<reviewer-cli> review ... || echo "..." > file` parsed as `(<reviewer-cli>) || (echo > file)`, leaving the output file unwritten on success. Now uses an explicit `set +e; ...; exit_code=$?; set -e` block.
- **Doc-sync 8→9 MCP tools** — README and `docs/api/API_REFERENCE.md` headers updated; section bodies were already correct.

### Changed
- Package, plugin, and dashboard metadata now target **4.1.0**.
- **agentic-orchestration is now opt-in.** Earlier prep snapshots had these surfaces enabled by default; v4.1.0 ships them as opt-in via `MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1` so the experimental working-model protocol applies only when explicitly requested. Setting the flag also serves as consent for local-only telemetry collection (`memesh patterns`). The skill itself remains discoverable; only its proactive surfaces are gated.
- **563 tests passing across 40 test files** (was 489 / 34).

## [4.0.4] — 2026-04-25

### Added
- **CLI `memesh doctor` diagnostics** — Added a release-focused local health check that verifies install method, database access, config readability, `.mcp.json`, `hooks/hooks.json`, hook script presence/executable bits, dashboard artifact availability, current capabilities, cached update status, and optional local HTTP reachability.
- **Doctor JSON contract** — `memesh doctor --json` now exposes machine-readable diagnostics and per-check status for support, automation, and onboarding verification.
- **Doctor regression coverage** — Added focused tests for healthy source-checkout installs, invalid MCP config, missing hook scripts, and first-run warning states.

### Improved
- **Actionable install troubleshooting** — README and platform troubleshooting now point users to `memesh doctor` for end-to-end local verification instead of relying only on `memesh status`.
- **CLI positioning consistency** — The `memesh` CLI banner now matches the current product wedge: local memory for Claude Code and MCP coding agents.
- **Hook script packaging hygiene** — `pre-edit-recall.js` now ships with the correct executable bit, and the build step applies executable bits consistently across all shipped hook scripts.
- **Database failure transparency** — `memesh doctor` now surfaces the actual database-open error message instead of hiding it behind a generic failure line.

### Changed
- Package, plugin, and dashboard metadata now target `4.0.4`.
- 489 tests passing across 34 test files.

## [4.0.3] — 2026-04-25

### Improved
- **Localized README and Dashboard Copy** — Refreshed all 10 non-English README variants into shorter, more natural localized guides and removed stale direct-translation wording from dashboard UI copy.
- **Truthful Version Discovery** — `memesh status` and the dashboard update card now preserve the last successful npm check, distinguish fresh/cached/stale/unavailable states, and surface the last attempted check plus last error instead of implying "already up to date" after npm failures.
- **Install-Channel-Aware Updates** — MeMesh now detects `npm-global`, `npm-local`, `source-checkout`, and `unknown` install shapes so CLI and dashboard guidance only promise self-update where it is actually supported.
- **Stale-Aware Dashboard Update UX** — Settings now loads cached update status first, refreshes in the background, offers a manual `Check now` action, and shows current/latest version, install method, last successful check, and channel-specific guidance.

### Added
- **HTTP Update Status Contract** — `GET /v1/update-status` now exposes freshness metadata, install-channel information, and manual update guidance for the packaged dashboard and other local clients.
- **Release-Path Regression Coverage** — Added targeted tests for install-channel detection, updater verification, version-check freshness/error preservation, HTTP update-status states, and dashboard i18n parity.

### Changed
- Package and plugin metadata now target `4.0.3`, including dashboard package metadata and current-version references in docs.
- 484 tests passing across 33 test files.

## [4.0.2] — 2026-04-24

### Fixed
- **sqlite-vec Vector Persistence** — Fixed vector writes by binding vec0 row IDs as `BigInt`, replacing vectors via delete+insert, and using byte-offset-safe embedding blobs. CLI `remember` now flushes queued embeddings before closing the database.
- **Vector Recall Overmatching** — Vector recall hydration now applies archive, namespace, and tag filters, and ignores non-positive similarity hits so no-match queries do not return arbitrary nearest neighbors.
- **Hook State Directory Isolation** — Pre-edit recall throttle state now lives beside `MEMESH_DB_PATH` when a custom DB path is configured, and session-start clears the same file. This fixes Windows home-directory drift in hooks and tests.
- **Clean Consumer Install Audit** — Replaced stale `@xenova/transformers` with maintained `@huggingface/transformers`, removing the vulnerable `onnxruntime-web -> onnx-proto -> protobufjs@6` dependency chain for clean npm consumers.
- **Embedding Capability Reporting** — Level 0/no-LLM mode now reports `onnx` when the local Transformers.js provider is available, matching the actual runtime embedding fallback.
- **Dashboard Browser Smoke** — Added a no-content favicon response so packaged dashboard browser smoke tests stay console-clean.
- **Packaged Dashboard E2E Smoke** — Added a Playwright-based `npm run test:e2e-dashboard` flow that packs the tarball, serves the packaged dashboard, verifies Browse/Search/Settings, checks instant locale switching without reload, and fails on page/console errors.
- **Dashboard i18n UX** — All 11 locales now have translation key parity, and language changes apply immediately without a full-page reload.
- **Imported Memory Trust Boundary** — Imported memories are now marked `trust: untrusted` with import provenance, so team/shared bundles stay searchable but are excluded from automatic Claude hook injection until reviewed.
- **Hook Context Guardrails** — Session-start and pre-edit hooks now wrap recalled memories as reference data rather than raw instructions, and they skip untrusted/imported entities during automatic injection.
- **HTTP Remote Bind Guard** — `memesh serve` now refuses non-loopback hosts unless you pass `--allow-remote` or set `MEMESH_HTTP_ALLOW_REMOTE=true`, preventing accidental unauthenticated LAN exposure.
- **Private Local Artifact Permissions** — Config, hook throttle state, and session recall-tracking files are now chmod-hardened after write (`0700` dirs, `0600` files) instead of relying on creation mode alone.

### Changed
- Added `docs/plans/README.md` to mark historical plans as archived context, not active backlog.
- 463 tests passing across 30 test files.
- Verified clean-machine packed install, clean consumer audit, packaged CLI smoke, packaged dashboard browser/i18n smoke, packaged dashboard e2e smoke, and npm registry publication status.

## [4.0.1] — 2026-04-21

### Fixed
- **Dashboard 404 Error** — Fixed NotFoundError when accessing dashboard with Node.js installed via nvm or other tools using hidden directories (`.nvm`). Added `{ dotfiles: 'allow' }` to Express `sendFile()` call.
- **Recall Effectiveness Data Pollution** — Session-start hook now saves injected context text; session-summary excludes it from hit detection, eliminating 100% false positive rate.
- **Cross-Session Data Corruption** — Switched from global `session-injected.json` to session-scoped files (`~/.memesh/sessions/${pid}-${timestamp}.json`) with auto-cleanup (>24h), preventing race conditions in concurrent sessions.
- **Vector Search Isolation Bypass** — Added optional `{includeArchived, namespace}` parameters to `getEntitiesByIds()` and vector row deletion in `archiveEntity()`, enforcing archive and namespace isolation in vector search.
- **Ollama Dimension Mismatch** — Added runtime dimension validation in `embedAndStore()` with clear error message when actual embedding length doesn't match DB schema, preventing silent write failures.
- **Cross-Project Memory Injection** — Pre-edit-recall hook now filters by project tag (`project:${projectName}`), preventing memories from unrelated repos from being injected when editing common filenames.
- **Session-Start Duplicate Entity Counting** — Entity deduplication (Set-based by ID) before recall tracking, fixing double-counting when entity appears in both project and recent lists.
- **CodeQL Security Alerts** — Added express-rate-limit (100 req/15min) for DoS protection. Removed unused variables flagged by CodeQL.

### Added
- **CLI `reindex` command** — `memesh reindex [--namespace <ns>] [--json]` regenerates vector embeddings for all active entities. Essential after changing embedding provider or dimension. Progress logging every 10 entities.

### Changed
- Enhanced dimension migration warning in `db.ts` to suggest running `memesh reindex`
- 445 tests passing across 29 test files

## [4.0.0] — 2026-04-20

MeMesh transforms from memory database to **cognitive middleware** — memory that auto-injects, auto-captures, auto-cleans, and auto-improves.

### Added
- **Recall Effectiveness Tracking** — `recall_hits`/`recall_misses` columns track whether injected memories are actually used by the AI. Session-start hook records injected entity IDs; Stop hook checks transcript for usage and updates hit/miss counts. `/v1/analytics` returns overall hit rate, top effective, and most ignored memories.
- **Continuous Recall (PreToolUse hook)** — New `pre-edit-recall.js` hook triggers on Edit/Write. Queries MeMesh for entities matching the file being edited (tag-based + FTS5 search). Throttled to max 1 recall per file per session. 5 hooks total now.
- **BYOK Embedding** — Multi-provider embedding support: OpenAI `text-embedding-3-small` (1536-dim), Ollama embedding models (768-dim), ONNX fallback (384-dim). Anthropic has no embedding API — correctly falls back to ONNX. Auto dimension migration: stores dim in metadata, drops/recreates `entities_vec` on provider change.
- **Auto-Tagging with LLM** — When `remember()` is called without tags and LLM is configured, generates 2-5 tags (project:, topic:, tech:, severity:, scope:) via LLM. Fire-and-forget: doesn't block the sync remember call.
- **Noise Filter** — `compressWeeklyNoise()` groups auto-tracked entities (session_keypoint, commit, session-insight) older than 7 days by ISO week, creates weekly summary entities, archives originals. Threshold: 20+ per week. Never touches decisions, patterns, lessons, or intentional knowledge. Throttled to once per 24h.
- **Memory Impact Score** — Laplace-smoothed `(recall_hits+1)/(recall_hits+recall_misses+2)` as 6th scoring factor (10% weight). Entities with high recall effectiveness rise in search results; ignored entities fade.
- **RecallEffectiveness dashboard component** — Stats row (effectiveness %, hits, misses, tracked) + bar charts for top/bottom entities. i18n across all 11 locales.
- Skills rewritten to CLI-first with hooks documentation and auto-detect flow (MCP → CLI → npx fallback)

### Changed
- Scoring weights rebalanced: searchRelevance 0.30 (was 0.35), frequency 0.15 (was 0.20), new impact 0.10
- `Capabilities.embeddings` correctly reports `onnx` when provider is Anthropic (was incorrectly reporting `anthropic`)
- Circular dependency between db.ts and embedder.ts resolved — `getEmbeddingDimension()` moved to config.ts
- 445 tests across 29 test files (up from 408/26)
- 5 hooks (up from 4): added PreToolUse for continuous recall
- Dashboard: 124KB (up from 107KB, new RecallEffectiveness component + i18n)

## [3.2.1] — 2026-04-19

### Added
- **Precision Engineer Design System** — Satoshi + Geist Mono fonts, cyan accent `#00D6B4`, compact 4px spacing, `DESIGN.md` as single source of truth
- **Analytics Insights Dashboard** — Memory Health Score (0-100) with 4 weighted factors, 30-day memory timeline (canvas sparkline), value metrics (recalls, lessons learned/applied), knowledge coverage with percentage bars, cleanup suggestions with one-click archive
- **Interactive Knowledge Graph** — type filter checkboxes, search with highlight and auto-center, ego graph mode, recency heatmap, orphan detection, physics cooling
- **Feedback Widget** — bug/feature/question selector with system info toggle, pre-fills GitHub issues
- New `GET /v1/analytics` backend endpoint
- i18n: ~50 new keys across all 11 locales

### Fixed
- SQLite datetime comparison fix (proper `datetime()` function instead of text comparison)

### Changed
- Zero `as any` type casts in dashboard
- 408 tests passing across 26 test files

## [3.2.0] — 2026-04-18

### Added
- **Neural Embeddings** — Xenova/all-MiniLM-L6-v2 (384-dim, ~30MB, local, no API key needed)
- **Hybrid search** — FTS5 keyword + vector similarity, merged and re-ranked
- Fire-and-forget async embedding on `remember()` — zero latency impact
- Graceful fallback to FTS5 when @xenova/transformers unavailable
- **Dashboard 2.0** — 7 tabs (up from 5): new Graph tab (canvas force-directed, no D3) and Lessons tab (structured lesson cards with severity colors)

### Fixed
- **Overwrite import** — now actually replaces old observations (was appending due to reactivation bug)
- **Namespace export** — filter applied at SQL query level (was post-filtering after LIMIT, causing truncation)

### Changed
- 402 tests across 25 test files
- 14 core modules (+ embedder.ts)
- 76KB dashboard single-file HTML
- 1 `as any` remaining (down from 20 in v3.1.0)

## [3.1.1] — 2026-04-17

### Changed
- **Module Extraction** — `operations.ts` split from 501 to 236 lines; new `consolidator.ts` and `serializer.ts`
- **N+1 query fix** — `getEntitiesByIds()` batch hydration (4 queries instead of 400+ for limit=100)
- **Type Safety** — `as any` casts: 20 to 1 (95% elimination); new typed interfaces for DB rows and LLM responses
- **Input Validation** — shared Zod schemas (`schemas.ts`) as single source of truth; max lengths enforced
- API key masked in `/v1/config` capabilities response
- `updateConfig()` deep-merges LLM config (preserves apiKey on partial updates)
- Express body limit: 1MB
- 396 tests across 24 test files

## [3.1.0] — 2026-04-17

### Added
- **Self-Improving Memory** — LLM-powered failure analysis in Stop hook automatically extracts root cause, fix, and prevention into structured `lesson_learned` entities
- **Proactive warnings** — session-start hook surfaces known lessons for the current project
- **`learn` tool** — 7th MCP tool for explicitly recording lessons across all 3 transports
- **Upsert dedup** — same error pattern across sessions updates existing lessons instead of creating duplicates
- New modules: `failure-analyzer.ts`, `lesson-engine.ts`

### Fixed
- API key in `/v1/config` capabilities response is now masked
- `updateConfig()` deep-merges LLM config to preserve API key on partial updates

### Changed
- 348 tests across 20 test files
- 7 MCP tools, 11 core modules, 3 transports, 4 hooks

## [3.0.1] — 2026-04-17

### Added
- **Built-in Skills** — `/memesh` (proactive memory management) and `/memesh-review` (cleanup recommendations)
- **Dashboard Rebuild** — Preact + Vite architecture, dark theme, 5 tabs
- Content quality improvements: filter system tags from Analytics, pagination in Browse, meaningful memory previews
- Marketing-grade README redesign with dashboard screenshots

## [3.0.0] — 2026-04-17

### Added
- **Universal AI Memory Layer** — complete rewrite
- **6 MCP Tools** — remember, recall, forget, consolidate, export, import
- **3 Transports** — CLI + HTTP REST API + MCP
- **Smart Recall** — multi-factor scoring + LLM query expansion (97% R@5)
- **Knowledge Evolution** — soft-archive, supersedes, reactivation (never deletes)
- **Session Auto-Capture** — 4 hooks capture knowledge automatically
- **Interactive Dashboard** — Preact + Vite, 5 tabs, dark theme
- 289 tests across 17 test files

## v2.x Releases

- **2.16.0** — Interactive Dashboard
- **2.15.0** — Smart Recall
- **2.14.0** — Session Auto-Capture
- **2.13.0** — Core Refactor
- **2.11.0** — Minimal core rewrite (50+ files to 5, 26 deps to 3)
- **2.10.x** — Streamlit Visual Explorer, auto-relation inference
- **2.9.x** — Proactive recall, vector search, architecture refactoring
- **2.8.x** — Device auth, semantic search, hooks system, accessibility
- **2.7.0** — Daemon socket cleanup, memory retention improvements
- **2.6.x** — PathResolver, error formatting, npm publish fixes
- **2.0.0–2.5.x** — Initial MCP server, knowledge graph, process management

---
_Note: The GitHub repository is [PCIRCLE-AI/memesh-llm-memory](https://github.com/PCIRCLE-AI/memesh-llm-memory). The npm package is [@pcircle/memesh](https://www.npmjs.com/package/@pcircle/memesh)._
