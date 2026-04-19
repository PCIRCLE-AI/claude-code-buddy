# v4.0.0 Adversarial Review Findings

> Cross-model review (Claude adversarial + Codex). Fix all before release.

## MUST FIX (HIGH, both models agree)

### 1. Noise filter cutoff missing in 2nd query
**File:** `src/core/lifecycle.ts:152-158`
**Problem:** First query filters by `created_at < cutoff` but second query fetching entity IDs does NOT include the cutoff. Recent entities in the same week bucket get archived prematurely.
**Fix:** Add `AND e.created_at < ?` to the second query with same cutoff parameter.

### 2. Pre-edit recall throttle never cleared between sessions
**File:** `scripts/hooks/pre-edit-recall.js:14`
**Problem:** `session-recalled-files.json` persists across sessions. After first session, commonly edited files are already "seen" and won't get recalled.
**Fix:** Clear the throttle file in `session-start.js`, or add session timestamp and check staleness.

### 3. API key fallback sends wrong key to wrong provider
**File:** `src/core/auto-tagger.ts:77`
**Problem:** `config.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY` — if provider is 'openai' but ANTHROPIC_API_KEY is set first, the Anthropic key gets sent to OpenAI.
**Fix:** Use provider-specific env var lookup.

### 4. NULL hitRate in analytics per-entity queries
**File:** `src/transports/http/server.ts:458-461`
**Problem:** Per-entity queries don't use COALESCE — entities from before migration have NULL values producing NULL hitRate.
**Fix:** Use `COALESCE(recall_hits, 0)` in per-entity queries.

### 5. FTS5 injection in pre-edit-recall hook
**File:** `scripts/hooks/pre-edit-recall.js:88-97`
**Problem:** File name passed directly to FTS5 MATCH without sanitization. Files named `"OR *"` cause unexpected behavior.
**Fix:** Wrap in double quotes like knowledge-graph.ts does.

## SHOULD FIX (MEDIUM)

### 6. ONNX pipeline load failure is permanent
**File:** `src/core/embedder.ts:169-189`
**Problem:** On failure, `onnxPipelineLoading` remains a rejected promise. All subsequent calls fail forever.
**Fix:** Reset `onnxPipelineLoading = null` on failure.

### 7. WAL pragma on read-only connection
**File:** `scripts/hooks/pre-edit-recall.js:53`
**Problem:** Setting WAL on readonly DB is a no-op or error on some platforms.
**Fix:** Remove the pragma call.

### 8. Summary entities not indexed in FTS5
**File:** `src/core/lifecycle.ts:173-192`
**Problem:** `compressWeeklyNoise` inserts directly, bypassing FTS5 index.
**Fix:** Insert into `entities_fts` after creating summary entity.

### 9. ISO week %W vs %V
**File:** `src/core/lifecycle.ts:137`
**Problem:** `%W` is not ISO week. Comment says ISO but implementation isn't.
**Fix:** Use correct format or update comment.

### 10. .passthrough() on config endpoint
**File:** `src/transports/http/server.ts:239`
**Problem:** Allows arbitrary keys written to config.json.
**Fix:** Remove `.passthrough()`.

### 11. Noise compression skips updating existing summary
**File:** `src/core/lifecycle.ts:170`
**Problem:** If `weekly-summary-{week}` already exists, new entities crossing cutoff get archived but summary isn't updated.
**Fix:** Append observations to existing summary.

### 12. BYOK dimension drop — add warning
**File:** `src/db.ts:134`
**Problem:** Silent DROP TABLE on dimension change.
**Fix:** Log warning to stderr before dropping.

## KNOWN LIMITATIONS (INVESTIGATE, defer to v4.1)

### 13. Recall name matching (transcript poisoning)
Session-start injects entity names into transcript, then stop hook searches transcript for those names. False positives guaranteed. Needs architectural rethink — match only against user/assistant messages, not hook output.

### 14. Race condition on last-session-injected.json
Multiple sessions overwrite each other. Fix: session-ID-based filenames. Low practical impact (rare concurrent sessions).

### 15. Ollama model vs embedding model
Shared `config.model` used for both chat and embedding. Fix: separate `embeddingModel` config field.

### 16. Fire-and-forget DB writes race against shutdown
`autoTagAndApply` and `embedAndStore` may write after `closeDatabase()`. Fundamental design choice.
