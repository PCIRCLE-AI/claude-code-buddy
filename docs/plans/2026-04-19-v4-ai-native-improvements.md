# MeMesh v4.0 — AI-Native Memory Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Context:**
- Repository: memesh-llm-memory
- Branch: develop
- Created: 2026-04-19

**Goal:** Transform MeMesh from a "memory database" into "cognitive middleware" — memory that auto-injects, auto-captures, auto-improves.

**Architecture:** 6 features, each independent. Can ship incrementally.

**Completeness Target:** 8/10

---

## Feature 1: Recall Effectiveness Tracking

**Why:** MeMesh can't prove it's useful. No data on whether recalled memories actually help the AI.

**What:** Track when a recalled memory is "used" (appeared in AI's response or influenced a tool call) vs "ignored".

**Implementation:**
- Add `recall_hits` and `recall_misses` columns to entities table (migration in db.ts)
- When SessionStart hook injects memories, record which entities were injected
- When Stop hook captures session summary, check if injected entities' keywords appear in the session output
- If yes → increment recall_hits. If no → increment recall_misses.
- Add hit_rate to /v1/analytics response
- Dashboard: show "Memory Effectiveness: N%" in Analytics

**Files:**
- Modify: `src/db.ts` (migration)
- Modify: `scripts/hooks/session-start.js` (record injected entities)
- Modify: `scripts/hooks/session-summary.js` (check usage, update hits/misses)
- Modify: `src/transports/http/server.ts` (/v1/analytics add hit_rate)
- Modify: `dashboard/src/components/AnalyticsTab.tsx` (show effectiveness)

**Tests:** 3 new tests for hit/miss tracking logic

---

## Feature 2: Continuous Recall via PreToolUse Hook

**Why:** Current recall is one-shot at session start. AI forgets about relevant memories mid-conversation.

**What:** Add a PreToolUse hook on Edit/Write that checks if the file being edited has relevant memories. If yes, inject them as context.

**Implementation:**
- New hook: `scripts/hooks/pre-edit-recall.js`
- Triggers on Edit and Write tool use
- Reads the file path from stdin JSON (`tool_input.file_path`)
- Queries MeMesh for entities tagged with that file path or related keywords
- Returns `hookSpecificOutput.additionalContext` with relevant memories
- Throttle: max 1 recall per file per session (cache in memory)

**Files:**
- Create: `scripts/hooks/pre-edit-recall.js`
- Modify: `hooks/hooks.json` (add PreToolUse matcher for Edit|Write)
- Modify: `scripts/smoke-packed-artifact.mjs` (add new hook to required files)

**Tests:** 2 tests for the hook logic

---

## Feature 3: BYOK Embedding

**Why:** all-MiniLM-L6-v2 is old, English-biased, 384-dim. Users with BYOK can get better embeddings.

**What:** When LLM config has an API key, use the provider's embedding API instead of local ONNX.

**Implementation:**
- Modify `src/core/embedder.ts`:
  - Add `embedWithProvider(text, config)` function
  - If config.llm.provider === 'anthropic': use Voyager-3-lite (1024-dim)
  - If config.llm.provider === 'openai': use text-embedding-3-small (1536-dim)
  - Fallback: existing @xenova/transformers (384-dim)
- Handle different vector dimensions: sqlite-vec supports variable dimensions
- Migration: if switching providers, re-embed all entities (background task)

**Files:**
- Modify: `src/core/embedder.ts`
- Modify: `src/core/config.ts` (embedding provider selection)
- Modify: `src/db.ts` (handle variable vector dimensions)

**Tests:** 4 tests (provider selection, fallback, dimension handling)

---

## Feature 4: Auto-Tagging with LLM

**Why:** Users forget to tag. Untagged memories are harder to find and analyze.

**What:** When `remember()` is called without tags, use LLM to generate relevant tags from the entity name + observations.

**Implementation:**
- Add `autoTag(name, type, observations, existingTags): Promise<string[]>` to `src/core/operations.ts`
- Uses LLM to generate 2-5 tags (project, topic, technology categories)
- Only runs if: LLM is configured AND entity has 0 user-provided tags
- Prompt: "Given this memory entity, suggest 2-5 tags. Categories: project:X, topic:X, tech:X, severity:X"
- Fire-and-forget: don't block remember() on LLM response

**Files:**
- Modify: `src/core/operations.ts` (add autoTag call in remember)
- Create: `src/core/auto-tagger.ts` (LLM prompt + parsing)

**Tests:** 3 tests (tag generation, no-LLM fallback, existing tags skip)

---

## Feature 5: Noise Filter (Auto-compress session_keypoint/commit)

**Why:** 90% of entities are auto-tracked noise. Signal-to-noise ratio is terrible.

**What:** Auto-compress old session_keypoint and commit entities into weekly summaries.

**Implementation:**
- New function: `compressWeeklyNoise(db, weekDate)` in `src/core/lifecycle.ts`
- Runs on session-start hook (throttled to once per day)
- Groups session_keypoint entities older than 7 days by ISO week
- Creates one summary entity per week: "Week of 2026-04-14: 45 sessions, 12 commits, main focus: dashboard redesign"
- Archives the individual session_keypoint entities
- Preserves: decisions, patterns, lessons, bug_fixes (never compressed)
- Threshold: only compress if > 20 session_keypoints exist for that week

**Files:**
- Modify: `src/core/lifecycle.ts` (add compressWeeklyNoise)
- Modify: `scripts/hooks/session-start.js` (call compression on startup)
- Modify: `src/core/operations.ts` (export compressWeeklyNoise)

**Tests:** 4 tests (compression logic, preservation of important types, threshold, weekly grouping)

---

## Feature 6: Memory Impact Score (Learning-to-Rank)

**Why:** Current scoring is static formula. No learning from actual usage.

**What:** Add a `impact_score` that adjusts based on recall effectiveness data from Feature 1.

**Implementation:**
- After Feature 1 ships (depends on recall tracking data)
- New scoring factor in `src/core/scoring.ts`: `impactWeight`
- Formula: `impact = recall_hits / (recall_hits + recall_misses)` (smoothed with Laplace)
- Integrate into existing multi-factor scoring: add impact as 6th factor (10% weight, reduce others proportionally)
- Entities with high hit rate rise in search results. Ignored entities fade.

**Files:**
- Modify: `src/core/scoring.ts` (add impact factor)
- Modify: `src/core/types.ts` (add impact fields to ScoringResult)

**Tests:** 3 tests (impact calculation, smoothing, integration with existing scoring)

---

## Execution Order

```
Feature 1 (recall tracking) — foundation, no dependencies
    ↓
Feature 5 (noise filter) — independent, high impact on data quality
    ↓
Feature 4 (auto-tagging) — independent, improves data quality
    ↓
Feature 2 (continuous recall) — independent, high UX impact
    ↓
Feature 3 (BYOK embedding) — independent, quality improvement
    ↓
Feature 6 (impact score) — depends on Feature 1 data
```

Features 1-5 can be done in any order. Feature 6 needs Feature 1's data first.

---

## CEO/PM Items (Status)

| Item | Status |
|------|--------|
| CHANGELOG.md | DONE |
| PyPI badge removed | DONE |
| User stories in README | DONE |
| 10 translated READMEs updated | DONE |
| Static demo page | DONE |
| Skills updated (8 tools, proactive) | DONE |
| Repo name note | DONE (in CHANGELOG footer) |
