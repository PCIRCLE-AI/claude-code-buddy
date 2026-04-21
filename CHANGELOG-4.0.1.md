# MeMesh v4.0.1 — Security & Reliability Fixes

**Release Date:** 2026-04-21  
**Type:** Bug Fix Release (Dashboard hotfix + Codex adversarial review findings)

---

## 📋 Summary

This release addresses 8 critical issues discovered through automated review and user reports:
- 1 dashboard accessibility issue (blocks UI access)
- 7 security, data integrity, and reliability issues (Codex adversarial review findings)

All 445 tests pass. No breaking changes.

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
