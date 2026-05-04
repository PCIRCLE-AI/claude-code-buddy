# MeMesh LongMemEval Benchmark — INTERNAL DRAFT
## SUPERSEDED BY RESULTS.md
## Original draft generated: 2026-05-03T09:09:34.000Z (bench/longmemeval-r5)
## Public evidence package generated: 2026-05-03 (bench/longmemeval-public-r1)

> **Status:** This file is the original internal analysis from the bench/longmemeval-r5 run.
> For the public evidence package with reproducible results, see RESULTS.md.
> Numbers from both runs are identical (within 0.00pp on R@5).

---

## Section 1: Raw Results (Original Run — bench/longmemeval-r5)

### Dataset: longmemeval_s, 500 questions, avg 50 sessions per question

| Mode | Description | R@5 | R@10 | MRR | Elapsed | Notes |
|------|-------------|-----|------|-----|---------|-------|
| A | FTS5 only | 95.40% | 97.60% | 0.8899 | 9.5s | Completed |
| B | FTS5+ONNX (max fusion) | 95.40% | 97.60% | 0.8904 | 1326.2s | Completed |
| C | FTS5+ONNX (weighted 60/40) | 82.40% | 96.40% | 0.3123 | 773.1s | Completed |

### Results by Question Type

| Question Type | Mode A R@5 | Mode B R@5 | Mode C R@5 | n |
|---------------|-----------|-----------|-----------|---|
| single-session-user | 97.1% | 97.1% | 72.9% | 70 |
| multi-session | 94.7% | 94.7% | 83.5% | 133 |
| single-session-preference | 83.3% | 83.3% | 80.0% | 30 |
| temporal-reasoning | 94.0% | 94.0% | 82.0% | 133 |
| knowledge-update | 98.7% | 98.7% | 89.7% | 78 |
| single-session-assistant | 100.0% | 100.0% | 83.9% | 56 |

### vs Industry Baselines

| System | R@5 | Delta vs MeMesh A |
|--------|-----|------------------|
| MeMesh v4.0.4 (Mode A) | 95.40% | 0 (baseline) |
| MemPalace | 96.6% | -1.2% |
| Supermemory | ~82% | +13.4% |
| Zep | 63.8% | +31.6% |
| Mem0 | 49.0% | +46.4% |

---

## Section 2: Honest Assessment

### Mode A vs B (FTS5 vs FTS5+ONNX max fusion)

R@5 = 95.4% for both modes vs MemPalace 96.6%.

Verdict: STRONG. MeMesh FTS5-only is essentially at MemPalace-tier (within 1.2pp).
Adding ONNX embeddings (Mode B, max fusion) provides no R@5 improvement on this dataset.

Key observations:
- Mode A (FTS5) and Mode B (FTS5+ONNX max) produced IDENTICAL R@5 results (95.40%)
- MRR difference is negligible: A=0.8899 vs B=0.8904 (+0.0005)
- FTS5 was 140x faster (9.5s vs 1326.2s) with zero benefit from ONNX addition
- single-session-assistant: 100.0% R@5 -- perfect retrieval in both modes
- knowledge-update: 98.7% R@5 -- very strong
- single-session-preference: 83.3% R@5 -- weakest category

### Mode C (FTS5+ONNX weighted 60/40) — SIGNIFICANT REGRESSION

Mode C R@5 = 82.40% -- a dramatic 13pp DROP from Mode A/B (95.40%).

Root cause: The weighted fusion (0.6*fts + 0.4*vec) boosts generic public Q&A distractor
sessions (ultrachat_*, sharegpt_*) that are semantically similar to the question via ONNX
cosine similarity, but are NOT the personal memory sessions the user cares about.

Example failure pattern in Mode C:
- Question: "Where do I take yoga classes?"
- FTS5 alone would rank personal session at position 4 (success)
- ONNX assigns high cosine similarity to generic "yoga Q&A" sessions (ultrachat_217527, etc.)
- Weighted blend: personal session pushed to rank 7 (failure)

The max fusion (Mode B) avoids this because it takes max(fts, vec) -- FTS dominance is preserved.
The 0.4 weight on a misleading vector signal systematically hurts more than it helps.

**Mode C is not a viable retrieval strategy for this task.**

---

## Section 3: Root Cause Analysis of Failures (Mode A/B, n=23)

**Total failures: 23 / 500 (4.6%) -- identical for Mode A and Mode B**

### Failure Sub-categories:

| Failure Category | Count | Description |
|-----------------|-------|-------------|
| Abstention (_abs) | 2 | Questions where answer is NOT in haystack -- structurally different |
| FTS returns 20 hits but answer not in results | 4 | Semantic mismatch, distractor overload |
| Answer found at rank 6-10 (just outside @5) | 11 | Scoring/ranking issue |
| Answer not in top 10 at all | 6 | Complete vocabulary mismatch |

### Failure Types by Question Category:

| Question Type | Failures | Notes |
|---------------|---------|-------|
| temporal-reasoning | 8 | Time-relative queries ("3 trips in past 3 months", "a week ago") |
| multi-session | 7 | Counting queries ("how many doctors", "how many tanks") |
| single-session-preference | 5 | Preference questions with implicit topic references |
| single-session-user | 2 | One user question (music service), one abstention |
| knowledge-update | 1 | FTS found it at rank 7 |

---

## Section 4: Improvement Strategy

Current R@5: 95.4% (target: >=96.6% to match MemPalace)
Gap: 1.2pp over 500 questions = ~6 more questions to get right

| Priority | Improvement | Expected R@5 Lift | Effort | ROI |
|----------|-------------|------------------|--------|-----|
| P1 | Session date scoring: boost sessions matching temporal context | +0.5-1.0pp | 2h | High |
| P2 | BM25 over FTS position normalization (use fts5 bm25() function) | +0.3-0.5pp | 3h | Medium |
| P3 | Switch to all-mpnet-base-v2 (768-dim, better semantic recall) | +0.5-1.5pp | 4h | Medium |
| P4 | LLM query expansion (Level 1, requires API key) | +0.5-2.0pp | 6h | Medium |
| P5 | Reciprocal Rank Fusion for FTS+vec instead of max/weighted avg | +0.3-0.8pp | 4h | Medium |
| P6 | Store per-turn observations (not full concatenated session) | +0.5-1.5pp | 8h | Low |

**Combined expected lift (P1+P2+P3):** +1.3-3.0pp => estimated 96.7-98.4% R@5

---

*Original draft from bench/longmemeval-r5 (commit 6cc7ec14)*
*Superseded by RESULTS.md in bench/longmemeval-public-r1*
