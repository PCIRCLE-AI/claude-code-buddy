# MeMesh v4.0.1 — Security & Reliability Fixes

**Release Date:** 2026-04-21
**Type:** Bug Fix Release (Dashboard hotfix + Codex adversarial review findings)

> **Release note:** npm v4.0.1 was already published before the 2026-04-23 release-readiness follow-up. Those post-publication fixes later shipped in v4.0.2 and are captured in `CHANGELOG-4.0.2.md`.

---

## 📋 Summary

This release addresses dashboard access, security, data integrity, release-readiness, and reliability issues discovered through automated review, user reports, and clean-install verification:
- Dashboard access is restored for global installs under hidden Node.js paths
- Vector persistence, vector isolation, hook state isolation, and session tracking are corrected
- Clean npm consumer installs no longer inherit the stale Xenova ONNX dependency chain

Published v4.0.1 had 445 tests. The later v4.0.2 release shipped with 463 tests plus post-publication security hardening around import trust, hook injection boundaries, remote HTTP bind safety, and local file permissions. No breaking changes.

---

## 🐛 Critical Fixes

### 1. Dashboard 404 Error on Global Installation (Hotfix)

### Dashboard 404 Error on Global Installation

**Problem:**
When `memesh` command opens the dashboard at `http://127.0.0.1:<port>/dashboard`, users encounter:
```
NotFoundError: Not Found
    at SendStream.error (send/index.js:168:31)
```

**Root Cause:**
Express's `sendFile()` uses the `send` package, which by default rejects file paths containing hidden directories (starting with `.`). When Node.js is installed via nvm (`.nvm` directory) or similar tools, the dashboard HTML file path contains hidden directories, triggering a 404 error.

**Fix:**
Added `{ dotfiles: 'allow' }` option to `sendFile()` call in `src/transports/http/server.ts:78`:

```typescript
res.type('html').sendFile(dashboardPath, { dotfiles: 'allow' });
```

**Impact:**
- ✅ All users with nvm, .nvm, or other hidden directories in Node.js path can now access dashboard
- ✅ Browser smoke tests no longer report a favicon 404 console error
- ✅ No breaking changes to API or CLI

---

### 2. Recall Effectiveness Data Pollution (Codex Finding #1)

**Problem:**
Session-start hook injected entity names into conversation context, then session-summary hook detected those same names in the transcript and counted them as "recall hits" — 100% false positive rate.

**Root Cause:**
No mechanism to exclude injected context from hit detection.

**Fix:**
- Save injected context text in session file (`scripts/hooks/session-start.js`)
- Remove injected context from transcript before hit detection (`scripts/hooks/session-summary.js`)

**Impact:**
- ✅ Recall effectiveness metrics now accurately measure actual usage
- ✅ No more false positives from self-injection

---

### 3. Cross-Session Data Corruption (Codex Finding #2)

**Problem:**
Single global `~/.memesh/session-injected.json` file caused concurrent sessions to overwrite each other's data, corrupting recall effectiveness tracking.

**Root Cause:**
Race condition when multiple Claude Code sessions run in parallel.

**Fix:**
- Use session-scoped files: `~/.memesh/sessions/${pid}-${timestamp}.json`
- Auto-cleanup files >24h old
- Match by project name and recency (within 1 hour)

**Impact:**
- ✅ Parallel sessions no longer corrupt each other's data
- ✅ Recall tracking isolated per session

---

### 4. Vector Search Isolation Bypass (Codex Finding #3)

**Problem:**
Vector search returned archived entities and crossed namespace boundaries, bypassing archive and namespace isolation.

**Root Cause:**
- `vectorSearch()` returned raw entity IDs from `entities_vec` table
- `getEntitiesByIds()` hydrated IDs without status/namespace filtering
- `archiveEntity()` removed FTS rows but not vector rows

**Fix:**
- Add optional `{includeArchived, namespace}` params to `getEntitiesByIds()` (`src/knowledge-graph.ts`)
- Add vector row deletion to `archiveEntity()`
- Update all call sites to pass correct filter options (`src/core/operations.ts`)

**Impact:**
- ✅ Archived entities no longer retrievable via vector search
- ✅ Namespace isolation enforced in vector search

---

### 4b. sqlite-vec Vector Persistence Regression

**Problem:**
Vector writes could fail even while the normal test suite stayed green:
```
MeMesh: Vector write failed for entity 1: Only integers are allows for primary key values on entities_vec
```

**Root Cause:**
`sqlite-vec` vec0 primary keys require integer row IDs to be bound as `BigInt` through `better-sqlite3`. The previous write path bound JavaScript numbers and used `INSERT OR REPLACE`, which is not reliable for vec0 replacement semantics.

**Fix:**
- Bind vector row IDs as `BigInt`
- Replace vectors with delete+insert inside a transaction
- Use byte-offset-safe `Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)`
- Flush pending CLI embedding writes before closing the short-lived CLI database
- Add regression coverage for vec0 insert/search, replacement, and archive deletion

**Impact:**
- ✅ Newly remembered CLI entities persist vector rows
- ✅ Re-remembering the same entity replaces one vector row instead of raising a unique-key error
- ✅ Vector recall supplements FTS only with filtered, positive-similarity hits

---

### 5. Ollama Environment Variable Dimension Mismatch (Codex Finding #4)

**Problem:**
`detectCapabilities()` checked only `OLLAMA_HOST` env var (no connectivity test), migrated DB to 768-dim, then runtime Ollama connection failed → fallback to ONNX (384-dim) → dimension mismatch → silent write failures.

**Root Cause:**
No dimension validation before vector write.

**Fix:**
- Add dimension validation in `embedAndStore()` (`src/core/embedder.ts`)
- Compare actual embedding length vs DB schema dimension
- Log clear error + suggest `memesh reindex` when mismatch detected

**Impact:**
- ✅ Dimension mismatches now detected and reported
- ✅ No more silent write failures

---

### 5b. Clean Consumer Install Audit Failure

**Problem:**
A fresh consumer install from the packed npm artifact passed functional smoke checks but `npm audit --omit=dev` reported 5 critical vulnerabilities through the local ONNX embedding dependency chain.

**Root Cause:**
`@xenova/transformers@2.17.2` pins `onnxruntime-web@1.14.0`, which pulls `onnx-proto -> protobufjs@6`. The repo-level `overrides` entry made local development audit green, but package consumers do not inherit dependency-package overrides, so clean installs still saw the vulnerable chain.

**Fix:**
- Replace `@xenova/transformers` with maintained `@huggingface/transformers@4.2.0`
- Update ONNX availability checks and dynamic imports to resolve `@huggingface/transformers`
- Remove the obsolete repo-level `protobufjs` override
- Verify clean consumer install audit with an isolated npm cache

**Impact:**
- ✅ Clean npm consumers install without the vulnerable protobufjs 6 chain
- ✅ Local ONNX embeddings remain available through the maintained Transformers.js package
- ✅ Level 0 capability reporting now matches the actual local ONNX fallback when no LLM is configured
- ✅ Release verification reflects the real consumer dependency graph, not only the repo workspace

---

### 6. Missing Reindex Command (Codex Finding #5)

**Problem:**
Provider/dimension change deleted all embeddings but no reindex path. Users lost semantic search for historical data.

**Root Cause:**
No CLI command to regenerate embeddings after config changes.

**Fix:**
- Add `memesh reindex` CLI command (`src/transports/cli/cli.ts`)
- Add `reindex()` function in `src/core/operations.ts`
- Enhance dimension migration warning to suggest reindex (`src/db.ts`)

**Features:**
- `--namespace` filter option
- `--json` output format
- Progress logging every 10 entities

**Impact:**
- ✅ Users can restore semantic search after provider changes
- ✅ Clear guidance when dimension migration occurs

---

### 7. Cross-Project Memory Injection (Codex Finding #6)

**Problem:**
Pre-edit-recall hook queried by filename with no project filter. Editing common files (e.g., `index.ts`) injected memories from unrelated repos.

**Root Cause:**
No project-scoped filtering in recall queries.

**Fix:**
- Derive project name from cwd basename (`scripts/hooks/pre-edit-recall.js`)
- Add `project:${projectName}` tag filter to both search strategies
- Update tests to include project tags

**Impact:**
- ✅ Cross-project memory injection prevented
- ✅ Only current project's memories recalled

---

### 7b. Hook State Directory Isolation

**Problem:**
Pre-edit recall throttle state could drift away from the configured database path on platforms where `os.homedir()` does not follow the test or runtime `HOME` override, especially Windows.

**Root Cause:**
`pre-edit-recall.js` wrote throttle state under `homedir()/.memesh`, while the database path could be overridden through `MEMESH_DB_PATH`. `session-start.js` also cleared the home-based throttle path instead of the path paired with the active database.

**Fix:**
- Resolve hook state directory from `dirname(MEMESH_DB_PATH)` when `MEMESH_DB_PATH` is set
- Fall back to `~/.memesh` only when no custom database path is configured
- Make `session-start.js` clear the same throttle file that `pre-edit-recall.js` writes
- Add tests for both throttle write location and session-start clearing behavior

**Impact:**
- ✅ Hook state stays isolated with custom/temporary database paths
- ✅ Windows CI no longer leaks throttle state through the real user profile
- ✅ Session-start reliably resets pre-edit recall throttling for the active memory store

---

### 8. Session-Start Duplicate Entity Counting (Codex Finding #7)

**Problem:**
Session-start concatenated `projectEntities` + `recentEntities` without deduplication. Same entity counted twice if it appeared in both lists.

**Root Cause:**
No deduplication before recall tracking.

**Fix:**
- Deduplicate by entity ID before concatenation (`scripts/hooks/session-start.js`)
- Use Set to track seen IDs during filtering

**Impact:**
- ✅ Recall metrics accurately reflect unique entities
- ✅ No more double-counting

---

## 📦 Files Changed

### Core & Transports
- `src/transports/http/server.ts` — Dashboard dotfiles fix
- `src/knowledge-graph.ts` — Vector search isolation (getEntitiesByIds filters, archiveEntity vector deletion)
- `src/core/operations.ts` — Vector search filtering, reindex() function
- `src/core/embedder.ts` — Dimension validation in embedAndStore()
- `src/transports/cli/cli.ts` — Added reindex command
- `src/db.ts` — Enhanced dimension migration warning

### Hooks
- `scripts/hooks/session-start.js` — Injected context tracking, entity deduplication
- `scripts/hooks/session-summary.js` — Context exclusion from hit detection
- `scripts/hooks/pre-edit-recall.js` — Project-scoped filtering

### Tests
- `tests/hooks/pre-edit-recall.test.ts` — Updated tests with project tags
- `tests/hooks/session-start.test.ts` — Added hook throttle state cleanup coverage
- `tests/core/embedder.test.ts` / `tests/db.test.ts` / `tests/knowledge-graph.test.ts` — Added sqlite-vec vector persistence and archive cleanup regressions

### Version
- `package.json` — Version 4.0.1
- `plugin.json` — Version 4.0.1

---

## 🔍 Testing

```bash
# Install and test
npm install -g @pcircle/memesh@4.0.1
memesh
# Dashboard opens at http://127.0.0.1:<random-port>/dashboard
# ✅ Should show MeMesh Dashboard UI (no 404 error)
```

---

## 📚 References

- **Issue:** Dashboard 404 on first install (2026-04-21)
- **Affected users:** Anyone using nvm, .nvm, or hidden directories in Node.js installation path
- **Severity:** Critical (blocks primary UI access)
- **Resolution time:** 2 hours (identified root cause via `send` package source code analysis)

---

**Upgrade:** `npm install -g @pcircle/memesh@latest`
