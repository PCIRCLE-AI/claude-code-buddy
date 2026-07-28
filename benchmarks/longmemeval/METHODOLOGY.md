# LongMemEval Benchmark Methodology — MeMesh v4.0.4

## Overview

This document describes the complete technical methodology used in the MeMesh LongMemEval benchmark. It is intended for reviewers who want to understand, critique, or reproduce the results.

---

## 1. Dataset

**Name:** LongMemEval-S (xiaowu0162/longmemeval on Hugging Face)
**License:** MIT
**SHA256:** 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
**Size:** 278,025,796 bytes (~278MB)
**Questions:** 500
**Average haystack size:** ~50 sessions per question
**Question types:**
- single-session-user (n=70)
- multi-session (n=133)
- single-session-preference (n=30)
- temporal-reasoning (n=133)
- knowledge-update (n=78)
- single-session-assistant (n=56)

**Note on dataset variant:** We use `longmemeval_s`, the original benchmark dataset from the ICLR 2025 paper. A newer `longmemeval-cleaned` variant exists with some corrections; results may differ slightly on that variant. MemPalace and other recent competitors may have used the cleaned variant — this is an honest caveat on direct comparisons.

---

## 2. Adapter Architecture

The adapter (`benchmarks/longmemeval/run.mjs`) maps the LongMemEval question format onto MeMesh's shipped API and calls it. It seeds each haystack through `KnowledgeGraph.createEntity()` — the storage call `remember()` makes — and retrieves through `recallEnhanced()` in `src/core/operations.ts`, the function every transport (MCP, HTTP, CLI) calls for `recall`. The adapter contains no schema, no query builder and no ranking of its own.

> **This changed in 2026-07, and the change matters for how you read older results.**
> Until then the adapter carried its own `CREATE TABLE`, its own FTS5 query
> construction and its own ranking. It measured that reimplementation, not the
> product — and the two had drifted. §2.3 below used to document an OR-joined
> query builder that only the adapter had; the shipped `search()` AND-joined its
> terms and ordered by `e.id DESC` instead of by BM25 `rank`. On the same 500
> questions the adapter scored 95.40% R@5 and the shipped path scored **5.20%**,
> with 473 of 500 questions returning nothing at all. Result files in `results/`
> written before this change are kept byte-identical — they are published
> evidence, and editing them would be worse than labelling them — so they carry
> no marker of their own. Which file measured what is recorded in
> [`results/README.md`](results/README.md); files produced by the current runner
> are the ones whose `run_info.measures` reads `"shipped_recall_path"`. The older
> files do not describe the product at any version. See CHANGELOG `[Unreleased]`
> and PR #78.

Key design decisions:

### 2.1 Database Isolation

Each question uses a **fresh, isolated SQLite database** created at the start and deleted after scoring. This prevents any knowledge leakage between questions and simulates MeMesh's real-world behavior where each user has a separate knowledge graph.

### 2.2 Session Indexing

For each question, all haystack sessions are indexed as MeMesh entities:
- Each session becomes one **entity** (type: `session`) in SQLite
- Session text is stored as a single **observation** (role + content, concatenated, truncated at 8000 chars)
- Session ID is the entity name
- Session date (if present in dataset) is stored in entity metadata as `session_date`
- FTS5 virtual table is populated for full-text search

### 2.3 FTS5 Query Construction

The adapter does not build the query. It passes the question text to
`recallEnhanced()` unchanged, and `KnowledgeGraph.search()` turns it into an
FTS5 expression via `buildQueryTerms()`:

1. Normalize to NFC
2. Split on `[^\p{L}\p{N}\p{M}]+` — the boundaries FTS5's own `unicode61`
   tokenizer uses, so the query is cut the same way the index was
3. Take up to `MAX_QUERY_TERMS` (32) terms
4. Quote each term and join with `OR`
5. Order the matches by FTS5 `rank` (BM25) before `LIMIT`, then rank the
   survivors with the five-factor scorer

Example: "How many properties did I view before making an offer?" →
`"How" OR "many" OR "properties" OR "did" OR "I" OR "view" OR "before" OR "making" OR "an" OR "offer"`

The FTS5 tokenizer uses `unicode61 remove_diacritics 1` to normalize accented characters.

The previous version of this section described a different builder — one that
stripped non-alphanumerics with an ASCII-only class and dropped terms of two
characters or fewer. That builder lived only in this file and in the adapter.
Reproducing it is not possible from the current adapter, which is the point.

### 2.4 Modes

Modes now name real product configurations, not adapter-internal strategies:

- **Mode A** — no embeddings stored. `recallEnhanced()` runs FTS5 + BM25 and its
  vector supplement finds nothing to add.
- **Mode B** — embeddings populated with `Xenova/all-MiniLM-L6-v2` (384-dim, the
  model MeMesh's local embedder uses) through the product's own
  `embedAndStore()`, so `recallEnhanced()`'s vector supplement can contribute.

**Mode C has been removed.** It applied a 60/40 weighted FTS+vector fusion that
exists nowhere in MeMesh — it was an adapter experiment. There was no product
behaviour for it to measure. Its historical result file is retained.

### 2.5 Score Fusion

Fusion is whatever `recallEnhanced()` does; the adapter does not compute scores.
As shipped, that is: FTS5 hits ordered by BM25 and graded by position, vector
hits appended with `max(0, 1 - distance)`, then the whole set ranked by the
five-factor scorer (relevance 0.30, recency 0.25, frequency 0.18, confidence
0.17, recall-impact 0.10).

### 2.6 Ranking and Metrics

Sessions are ranked by score descending. Metrics are computed:
- **R@5**: 1 if any answer session appears in top-5 ranked results, else 0
- **R@10**: 1 if any answer session appears in top-10 ranked results, else 0
- **MRR**: 1 / rank_of_first_answer_session (0 if not in top results)

For questions with multiple answer sessions (multi-session, knowledge-update types), the hit is counted when any one of the answer sessions is found in the top-k.

---

## 3. What This Benchmark Does and Does Not Cover

The benchmark exercises the shipped retrieval path end to end: seeding through
`createEntity()`, retrieving through `recallEnhanced()`, including the
five-factor scorer. What it does not cover is everything a memory layer does
*around* retrieval:

- **Realistic access patterns.** Every database is fresh, so recency, frequency
  and recall-impact are uniform across candidates. Relevance does the work; the
  other four factors have nothing to distinguish. A real memory base is aged and
  unevenly accessed, and those factors then decide real orderings.
- **Corpus scale.** Each haystack is ~50 sessions. Real bases are thousands of
  entities, where `LIMIT` binds much harder and term frequency behaves differently.
- **Everything that is not retrieval**: auto-capture, consolidation, knowledge
  evolution and conflict detection, auto-tagging, relation traversal.
- **Answer correctness.** No LLM answers anything. The score is whether the
  session containing the answer came back, not whether the answer is right.

**These are not reasons to treat the number as a floor.** The previous version of
this section concluded that the benchmark was a "conservative lower bound" and
that "the full system would score at least as well, likely better." That was
false in the most direct way available: the full system scored **5.20%** where
this benchmark reported 95.40%. The omissions listed above were real, but the
inference drawn from them was backwards, and it is what made the gap invisible —
it told the reader the product was at least this good.

Read the number for what it is: a measurement of one code path, on a small
fresh corpus, under a keyword-retrieval task.

---

## 4. Known Limitations and Caveats

### 4.1 Dataset Limitations

- **longmemeval_s vs longmemeval-cleaned**: Results may differ slightly. We have not verified which variant competitors used.
- **Distractor sessions**: The haystack includes `ultrachat_*` and `sharegpt_*` generic Q&A sessions that act as distractors. These are semantically similar to questions but are NOT personal memory. Mode C (weighted ONNX fusion) is badly hurt by these — generic Q&A sessions have high cosine similarity to query text, outranking personal sessions.
- **Abstention questions**: 2 questions in the dataset have `_abs` in the question_id, indicating the answer is NOT in the haystack. These are structurally different and both correctly returned no hit.

### 4.2 Adapter Limitations

- **Session truncation at 8000 chars**: Long sessions are truncated. Some answer sessions may have the relevant information in the second half.
- **FTS5 query quality**: OR-joining individual keywords is not optimal BM25. Proximity operators or phrase matching would likely do better. This item used to sit here as an *adapter* limitation — while the shipped `search()` was AND-joining and would have been listed as a far worse limitation had anyone measured it. A limitation described next to a number it does not apply to is how a divergence stays invisible; the adapter and the product now share one implementation, so anything listed here applies to both.
- **MiniLM-L6 embedding quality**: The 384-dim model is too small for indirect semantic matching. Vocabulary mismatches (e.g., session uses "Dr. Patel" instead of "doctor") are not recovered by this model.
- **Mode B measures a vector path that currently contributes almost nothing**: `vectorSearch()` filters hits at `MAX_VECTOR_DISTANCE = 1` while sqlite-vec returns L2 distances that sit around 1.2–1.4 for related text, so nearly every vector hit is discarded before it can supplement FTS5. Mode B therefore lands close to Mode A. Tracked separately; the number is reported as measured rather than adjusted.

### 4.3 Comparison Limitations

- **MemPalace (96.6%)**: Vendor self-report. Architecture differs from MeMesh. May use longmemeval-cleaned. Not independently verified.
- **Supermemory (~82%), Zep (63.8%), Mem0 (49%)**: Zep and Mem0 numbers come from the original LongMemEval paper. Supermemory is a vendor estimate. Direct comparisons assume identical experimental setup.

---

## 5. Reproducibility

All raw per-question results are committed in `benchmarks/longmemeval/results/`. The aggregation logic is in `benchmarks/longmemeval/run.mjs`. To verify the aggregate numbers, recompute from the raw JSON:

```javascript
const data = require('./results/mode-A-2026-05-03T12-31-26.json');
const r5 = data.results.filter(r => r.r_at_5).length / data.results.length;
console.log('R@5:', (r5 * 100).toFixed(2) + '%');
```

See `REPRODUCE.md` for step-by-step reproduction instructions.

---

## 6. Historical: the removed Mode C

Mode C applied a 60/40 weighted FTS+vector fusion and scored 82.40% R@5 against
Mode A's 95.40% (2026-05-03, adapter reimplementation). The recorded root cause
still reads correctly: the `ultrachat_*` and `sharegpt_*` distractor sessions are
generic public Q&A, and weighting cosine similarity at 0.4 lifted them above the
user's own sessions.

It is kept here as a note rather than a mode because MeMesh never implemented
weighted fusion. The conclusion drawn at the time — "Mode A is the recommended
production configuration" — described a choice between two adapter strategies,
not a product setting anyone could select.

---

## 7. Guarding the gap

The divergence this file used to hide is now covered two ways:

1. **The adapter calls the product.** There is no second implementation left to
   drift.
2. **`tests/recall-quality.test.ts`** runs a synthetic multi-question corpus
   through `recallEnhanced()` on every CI leg and fails below a fixed R@5 floor.
   It is deliberately not the LongMemEval dataset: a 278 MB download per CI run
   is unworkable and committing a slice is dataset redistribution. Its job is to
   catch collapse — each of the four defects fixed in PR #78 breaches the floor —
   not to reproduce the published figure.
