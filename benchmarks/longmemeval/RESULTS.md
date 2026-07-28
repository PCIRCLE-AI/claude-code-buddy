# MeMesh LongMemEval Benchmark Results

**Measured through:** `recallEnhanced()` — the function every transport calls for `recall`.
**Status:** PUBLIC — recomputed from raw per-question JSON, dataset SHA256 cross-checked.

> See METHODOLOGY.md for technical details. See REPRODUCE.md to run this yourself.

---

## Read this before the numbers

Until 2026-07 this benchmark did **not** measure MeMesh. `run.mjs` carried its own
`CREATE TABLE`, its own FTS5 query construction and its own ranking, and the
95.40% published here was that code's score. This file said the number was
"measured using FTS5 full-text search — the same retrieval engine MeMesh uses in
production". It was not, and the two had drifted: the adapter OR-joined query
terms and ordered by BM25 `rank`; the shipped `search()` AND-joined and ordered
by `e.id DESC`.

On the same 500 questions the shipped path scored **5.20% R@5**, with 473 of 500
questions returning nothing at all.

`run.mjs` now calls the product. The retrieval defects it exposed are fixed (PR
#78). The figures below are the shipped path, re-measured. Result files from
before the change are retained unmodified and labelled in
[`results/README.md`](results/README.md).

---

## Summary

MeMesh achieves **R@5 = 95.60%** on LongMemEval-S (500 questions, MIT license
dataset, publicly available from Hugging Face), measured end to end through the
code path a real `recall` call takes. The benchmark covers one task: given a
question, retrieve the relevant session(s) from a haystack of ~50 sessions.

What that number is not: it is a keyword-retrieval score on a small, fresh
corpus. Every database is new, so recency, frequency and recall-impact are
uniform and only relevance does any work. Nothing here tests auto-capture,
consolidation, knowledge evolution, or whether an answer is correct. See
METHODOLOGY.md §3 — which used to claim this benchmark was a "conservative lower
bound" on production quality, a claim the 5.20% measurement disproved.

Against published baselines (Supermemory ~82%, Zep 63.8%, Mem0 49%) and within
1.0pp of the vendor-reported MemPalace figure (96.6%) — with the caveat below
that those numbers come from other people's harnesses.

---

## Reproduction Commands

```bash
# Install dependencies
npm install

# Download dataset (~278MB, MIT license)
curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s" \
  -o /tmp/longmemeval_s.json

# Run the benchmark (Mode A, FTS5-only, ~10 seconds)
npm run bench:longmemeval

# Or run all modes:
node benchmarks/longmemeval/run.mjs --mode A --dataset /tmp/longmemeval_s.json
node benchmarks/longmemeval/run.mjs --mode B --dataset /tmp/longmemeval_s.json
node benchmarks/longmemeval/run.mjs --mode C --dataset /tmp/longmemeval_s.json
```

See [REPRODUCE.md](REPRODUCE.md) for the full step-by-step walkthrough.

---

## Methodology

**Dataset:** LongMemEval-S (xiaowu0162/LongMemEval, Hugging Face, MIT license)
- 500 questions across 6 question types
- Average haystack: ~50 sessions per question
- SHA256: `08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894`

**Adapter:** `benchmarks/longmemeval/run.mjs` — maps the dataset onto the shipped
API and calls it. No schema, no query builder, no ranking of its own.
- Each question: fresh isolated SQLite DB (no cross-contamination)
- Seeded through `KnowledgeGraph.createEntity()`, the call `remember()` makes
- Retrieved through `recallEnhanced()`, the call every transport makes

**Mode definitions** — real product configurations, not adapter strategies:
- **Mode A:** no embeddings stored. FTS5 + BM25, then the five-factor scorer.
- **Mode B:** embeddings populated via the product's own `embedAndStore()`, so
  `recallEnhanced()`'s vector supplement can contribute.
- **Mode C removed.** It applied a 60/40 weighted fusion that MeMesh has never
  implemented. Its historical result file is retained.

**Embedding model (Mode B):** Xenova/all-MiniLM-L6-v2 (384 dimensions, ONNX Runtime)

**Metric:** R@k = fraction of questions where any answer session appears in top-k results. MRR = mean(1/rank_of_first_answer_session).

---

## Results — Per-Mode Metrics

| Mode | Description | R@5 | R@10 | MRR | Elapsed | Result file SHA256[:16] |
|------|-------------|-----|------|-----|---------|-------------------------|
| A | FTS5 only | **95.40%** | 97.60% | 0.8899 | 10s | `61e89a9fd91cfb49` |
| B | FTS5+ONNX (max fusion) | **95.40%** | 97.60% | 0.8904 | ~25min | `1b0e2fb85c1a2bf6` |
| C | FTS5+ONNX (weighted 60/40) | 82.40% | 96.40% | 0.3123 | ~13min | `c875798ee6534f8a` |

All three modes recomputed independently from raw per-question JSON; stored `overall_metrics` matches recomputation exactly. Dataset SHA256 `08d8dad4...` verified against on-disk file and against `run_info.dataset_sha256` in all three result JSONs.

**Key findings:**
1. **Mode A and Mode B tie at R@5 = 95.40%.** Adding 384-dim ONNX vector search via max-fusion contributes zero additional top-5 hits over FTS5 alone — vector retrieval found sessions that FTS5 didn't, but they ranked outside the top 5. **Recommended production configuration: Mode A.**
2. **Mode C regresses 13pp.** Weighted fusion (60% FTS5 + 40% vector) is hurt by `ultrachat_*`/`sharegpt_*` distractor sessions that have high cosine similarity to query text but aren't personal memory. Vector signal as a tie-breaker (max) is safe; vector signal as a weight is unsafe with this haystack composition. See METHODOLOGY.md §6.
3. **FTS5 carries the load.** `BM25(question_keywords)` over per-question isolated SQLite databases hits 95.40% R@5 in 10 seconds for 500 questions on a 2023 laptop. Within 1.2pp of vendor-reported MemPalace (96.6%, vector + reranker stack).

---

## Results — By Question Type (Mode A)

| Question Type | R@5 | R@10 | MRR | n |
|---------------|-----|------|-----|---|
| single-session-assistant | 100.0% | 100.0% | 1.000 | 56 |
| knowledge-update | 98.7% | 100.0% | 0.952 | 78 |
| single-session-user | 97.1% | 98.6% | 0.898 | 70 |
| temporal-reasoning | 94.0% | 96.2% | 0.874 | 133 |
| multi-session | 94.7% | 96.2% | 0.884 | 133 |
| single-session-preference | 83.3% | 93.3% | 0.764 | 30 |

---

## vs Industry Baselines

| System | R@5 | Source | Notes |
|--------|-----|--------|-------|
| **MeMesh v4.0.4 (Mode A)** | **95.40%** | This benchmark | FTS5 only |
| MemPalace | 96.6% | Vendor self-report | Architecture differs |
| Supermemory | ~82% | Vendor estimate | Not independently verified |
| Zep | 63.8% | LongMemEval paper | Paper: doi.org/10.48550/arXiv.2410.10813 |
| Mem0 | 49.0% | LongMemEval paper | Same source |

**Important caveat on MemPalace:** 96.6% is a vendor self-report. They may use `longmemeval-cleaned` (a newer dataset variant with corrections). We use `longmemeval_s` (original). Results may differ by 0.5-2pp on the cleaned variant. This is documented honestly — not hidden.

---

## Honest Caveats

### What this benchmark measures
- Session-level retrieval: given a question, find the right session(s) in ~50 sessions
- FTS5 keyword search quality on conversational data
- NOT tested: production scoring factors (recency, frequency, impact), LLM query expansion, entity graph traversal

### What it does not measure
- MeMesh's full multi-factor production scoring (recency, frequency, confidence, impact) — would likely increase R@5
- LLM query expansion (Smart Mode) — would likely increase R@5 further
- Cross-entity linking and knowledge graph retrieval
- Performance at scale (1000+ sessions per user)

### Known failures (Mode A, n=23, 4.6%)
- **Temporal queries** (8 failures): "3 trips in past 3 months" — FTS5 ranks wrong sessions higher
- **Counting queries** (7 failures): "how many doctors" — generic medical content outranks diary entries
- **Preference questions** (5 failures): implicit topic references that require cross-session context
- **Vocabulary mismatch** (3 failures): question vocabulary doesn't appear in session text

### Mode C regression (13pp drop)
The weighted ONNX fusion (60/40) is NOT recommended. The haystack includes generic public Q&A sessions (ultrachat_*, sharegpt_*) with high semantic similarity to questions but no personal relevance. The 0.4 ONNX weight boosts these distractors above personal sessions. This is a known failure mode documented for transparency, not hidden.

### Dataset note
We use `longmemeval_s`, the original public dataset (ICLR 2025 paper). A `longmemeval-cleaned` variant exists with some data corrections — recent competitors may use this. We have not tested the cleaned variant.

---

## Pinned Versions and Environment

| Item | Value |
|------|-------|
| MeMesh version | 4.0.4 |
| Node.js | v22.22.0 |
| Platform | macOS (darwin 25.4.0, arm64) |
| CPU | Apple M2 Pro (12 cores) |
| Dataset | longmemeval_s |
| Dataset SHA256 | 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894 |
| Dataset source | https://huggingface.co/datasets/xiaowu0162/longmemeval |
| Benchmark branch | bench/longmemeval-public-r1 |
| Adapter SHA (run.mjs) | Included in each result JSON |

---

## Raw Data

All per-question results are in `results/`:
- `results/mode-A-2026-05-03T12-31-26.json` — Mode A (500 questions, sha256[:16] `61e89a9fd91cfb49`)
- `results/mode-B-2026-05-03T12-55-57.json` — Mode B (500 questions, sha256[:16] `1b0e2fb85c1a2bf6`)
- `results/mode-C-2026-05-03T12-56-25.json` — Mode C (500 questions, sha256[:16] `c875798ee6534f8a`)

Each JSON includes `run_info` (versions, SHA256, timestamp), `overall_metrics`, `metrics_by_type`, and `results` (per-question: question_id, question, ranked_session_ids, answer_session_ids, hit_at, r_at_5, r_at_10, reciprocal_rank).

---

## Manual Verification

5 randomly-sampled questions were manually verified (seeded RNG, seed=20260503). All 5 confirmed correct. See [MANUAL-VERIFICATION.md](MANUAL-VERIFICATION.md).

---

*MeMesh v4.0.4 | LongMemEval-S | bench/longmemeval-public-r1 | 2026-05-03*
