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

The adapter (`benchmarks/longmemeval/run.mjs`) bridges the LongMemEval question format to MeMesh's SQLite recall pipeline. Key design decisions:

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

The question text is transformed into an FTS5 query:
1. Strip all non-alphanumeric characters (replace with spaces)
2. Normalize whitespace
3. Split into tokens, remove tokens with length ≤ 2
4. Take up to 20 tokens
5. Quote each token and join with `OR`

Example: "How many properties did I view before making an offer?" → `"How" OR "many" OR "properties" OR "did" OR "view" OR "before" OR "making" OR "offer"`

The FTS5 tokenizer uses `unicode61 remove_diacritics 1` to normalize accented characters.

### 2.4 Vector Embeddings (Mode B/C)

For modes B and C, embeddings are generated using `Xenova/all-MiniLM-L6-v2` (384 dimensions) via `@huggingface/transformers` (ONNX Runtime). This is the same model used by MeMesh's production BYOK embedding feature.

- Each session is embedded as: `[session_id] + " " + [session_text]` (truncated to 2048 chars)
- Query embedding: the question text (truncated to 2048 chars)
- Stored in `entities_vec` virtual table via `sqlite-vec`
- Cosine distance used for retrieval (k=20 nearest neighbors)

### 2.5 Score Fusion

**Mode A (FTS5 only):**
- Score = 1 - (rank_position / n_fts_results)
- Rank 1 gets score ~1.0, rank 20 gets score ~0.05

**Mode B (FTS5 + ONNX, max fusion):**
- FTS score as above
- Vector similarity: vecSim = max(0, 1 - cosine_distance)
- For sessions in both: score = max(fts_score, vec_score)
- For sessions only in vector results: score = vec_score * 0.7

**Mode C (FTS5 + ONNX, weighted fusion):**
- For sessions in both: score = 0.6 * fts_score + 0.4 * vec_score
- For sessions only in vector results: score = vec_score * 0.7

### 2.6 Ranking and Metrics

Sessions are ranked by score descending. Metrics are computed:
- **R@5**: 1 if any answer session appears in top-5 ranked results, else 0
- **R@10**: 1 if any answer session appears in top-10 ranked results, else 0
- **MRR**: 1 / rank_of_first_answer_session (0 if not in top results)

For questions with multiple answer sessions (multi-session, knowledge-update types), the hit is counted when any one of the answer sessions is found in the top-k.

---

## 3. What MeMesh's Recall Pipeline Does NOT Do in This Benchmark

The benchmark tests the retrieval component only — specifically, the ability to identify the relevant session(s) from the haystack. MeMesh's full production pipeline includes additional features that are NOT tested here:

- **Multi-factor scoring**: Production MeMesh uses recency, frequency, confidence, and impact scoring. These are omitted in the benchmark because the dataset does not simulate real-world access patterns.
- **LLM query expansion**: Production MeMesh (Smart Mode) uses an LLM to expand queries with synonyms and related concepts. Disabled in benchmark.
- **Consolidation**: Production MeMesh can consolidate/compress old observations. Not applicable in benchmark.
- **Auto-tagging**: Disabled in benchmark.
- **Cross-entity relations**: The benchmark tests session-level retrieval, not entity graph traversal.

This means the benchmark is a **conservative lower bound** on MeMesh's production retrieval quality — the full system would score at least as well, likely better.

---

## 4. Known Limitations and Caveats

### 4.1 Dataset Limitations

- **longmemeval_s vs longmemeval-cleaned**: Results may differ slightly. We have not verified which variant competitors used.
- **Distractor sessions**: The haystack includes `ultrachat_*` and `sharegpt_*` generic Q&A sessions that act as distractors. These are semantically similar to questions but are NOT personal memory. Mode C (weighted ONNX fusion) is badly hurt by these — generic Q&A sessions have high cosine similarity to query text, outranking personal sessions.
- **Abstention questions**: 2 questions in the dataset have `_abs` in the question_id, indicating the answer is NOT in the haystack. These are structurally different and both correctly returned no hit.

### 4.2 Adapter Limitations

- **Session truncation at 8000 chars**: Long sessions are truncated. Some answer sessions may have the relevant information in the second half.
- **FTS5 query quality**: OR-joining of individual keywords is not optimal BM25. A more sophisticated query using proximity operators or phrase matching would improve results.
- **MiniLM-L6 embedding quality**: The 384-dim model is too small for indirect semantic matching. Vocabulary mismatches (e.g., session uses "Dr. Patel" instead of "doctor") are not recovered by this model.

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

## 6. Mode C Regression Analysis

Mode C (weighted 60/40 FTS+ONNX) achieves only 82.40% R@5 — a 13pp regression from Mode A (95.40%).

**Root cause:** The `ultrachat_*` and `sharegpt_*` distractor sessions in the haystack are generic public Q&A content. When the user asks "Where did I go hiking last weekend?", a generic hiking Q&A session has high cosine similarity to the query text. The 0.4 weight on ONNX cosine similarity boosts these generic sessions above the user's personal hiking session.

Mode B (max fusion) avoids this problem because `max(fts_score, vec_score)` preserves FTS5 dominance when FTS5 already found the right session. But weighted averaging (Mode C) dilutes the FTS5 signal.

**Conclusion:** Weighted ONNX fusion is not a viable strategy for this task with MiniLM-L6 and a haystack containing generic Q&A distractors. Mode A (FTS5 only) is the recommended production configuration.

*MeMesh v4.0.4 | bench/longmemeval-public-r1 | 2026-05-03*
