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

# Build — the runner measures compiled code, so this must run first
npm run build

# Run the benchmark (Mode A, no embeddings, ~10 seconds)
npm run bench:longmemeval

# Or with embeddings populated (~14 minutes, downloads the ONNX model once)
node benchmarks/longmemeval/run.mjs --mode B --dataset /tmp/longmemeval_s.json
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

Measured through `recallEnhanced()`:

| Mode | Description | R@5 | R@10 | MRR | Zero-result questions | Elapsed |
|------|-------------|-----|------|-----|-----------------------|---------|
| A | no embeddings | **95.60%** | 97.80% | 0.8929 | 0 / 500 | 9.1s |
| B | embeddings populated | **95.60%** | 97.80% | 0.8931 | 0 / 500 | 807.7s |

For contrast, the same 500 questions through the same function **before** the
retrieval fixes in this release: R@5 **5.20%**, R@10 5.20%, MRR 0.0520, and
**473 of 500** questions returning nothing.

### What the embeddings buy: 14 changed result lists and nothing at the cut-off

Before the vector threshold was fixed, Mode B was identical to Mode A to sixteen
decimal places — `MAX_VECTOR_DISTANCE = 1` discarded essentially every hit
sqlite-vec returned, so storing 25 000 embeddings changed not one result. The
cut-off is now 1.30 and the supplement does reach the ranker: **14 of the 500
result lists differ between the modes.**

It still does not move the metric. R@5 and R@10 are unchanged, and only **two**
questions move the position of the correct session at all:

| Question | Type | Mode A | Mode B |
|---|---|---|---|
| `gpt4_f2262a51` | multi-session | not found | rank 14 |
| `2ebe6c92` | temporal-reasoning | rank 14 | rank 16 |

One recovery and one small regression, both far outside the top 10. MRR moves
from 0.8929348706848708 to 0.8930598706848707 — a gain of 0.000125 for **89×
the wall-clock** (807.7s against 9.1s).

This refutes a prediction this file used to make. It said the 22 remaining Mode
A failures were "dominated by vocabulary mismatch — exactly what a working
vector supplement would cover". The supplement now works, and it covers one of
the 22, at a rank no one would ever see. Vocabulary mismatch may still be the
right diagnosis; MiniLM-L6 at 384 dimensions is not the cure. Recall stays
LLM-free and embeddings stay optional, which is what these numbers support.

The 95.40% Mode B figure published previously came from the adapter
reimplementation and does not carry over; do not quote it.

Dataset SHA256 `08d8dad4...` verified against the on-disk file and against
`run_info.dataset_sha256` in the result JSON.

**Key findings:**
1. **FTS5 carries the load.** BM25 over per-question isolated SQLite databases
   reaches 95.60% R@5 in under ten seconds for 500 questions on a laptop, with
   no LLM and no embeddings in the loop.
2. **The scorer is not what makes this work here.** Every database is fresh, so
   recency, frequency, confidence and recall-impact are uniform across
   candidates and only the 0.30 relevance factor distinguishes anything. Those
   four factors matter in an aged memory base; this benchmark cannot see them.
3. **What the number does not cover** is in METHODOLOGY.md §3 — and that section
   used to draw the opposite conclusion, calling this a "conservative lower
   bound" on production quality. It was not.

---

## Results — By Question Type (Mode A)

| Question Type | R@5 | R@10 | MRR | n |
|---------------|-----|------|-----|---|
| knowledge-update | 100.0% | 100.0% | 0.987 | 78 |
| single-session-assistant | 100.0% | 100.0% | 1.000 | 56 |
| single-session-user | 97.1% | 98.6% | 0.891 | 70 |
| multi-session | 94.7% | 96.2% | 0.884 | 133 |
| temporal-reasoning | 94.0% | 97.0% | 0.852 | 133 |
| single-session-preference | 83.3% | 96.7% | 0.673 | 30 |

---

## vs Industry Baselines

| System | R@5 | Source | Notes |
|--------|-----|--------|-------|
| **MeMesh (Mode A)** | **95.60%** | This benchmark, measured through `recallEnhanced()` | FTS5 + BM25, no LLM, no embeddings |
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
- The whole shipped read path, including the five-factor scorer — though see
  below for why four of those five factors have nothing to say here
- (There is no LLM query expansion to test: `query-expander.ts` was removed in
  v4.2.0 and recall has been strictly LLM-free since.)

### What it does not measure
- **An aged memory base.** Every database is fresh, so recency, frequency,
  confidence and recall-impact are uniform and only relevance separates
  candidates. Those four factors are 70% of the score in real use and this
  benchmark cannot see them — in either direction.
- **Scale.** ~50 sessions per question. A real base is thousands, where `LIMIT`
  binds harder and term frequencies differ.
- Cross-entity linking and knowledge graph retrieval.
- Auto-capture, consolidation, knowledge evolution, conflict detection.
- Whether an answer is correct. No LLM answers anything here.

Earlier versions of this section said the omitted scoring factors and LLM query
expansion "would likely increase R@5". Do not read it that way. The one time the
gap between this benchmark and the shipped path was actually measured, the
shipped path scored 5.20% against this benchmark's 95.40%.

### Known failures (Mode A, 22 of 500, 4.4%)
By question type: temporal-reasoning 8, multi-session 7, single-session-preference 5,
single-session-user 2.

Every one of the 22 is a ranking failure, not a retrieval failure: **no question
returned zero results**, and 18 of the 22 had the right session somewhere in the
returned set, below position 5. The remaining 4 fell outside the top 10.
Vocabulary mismatch is the recurring cause — the question's words do not appear
in the session that answers it, which is precisely the case a working vector
supplement would cover (see METHODOLOGY.md §4.2 on why it currently does not).

### Dataset note
We use `longmemeval_s`, the original public dataset (ICLR 2025 paper). A `longmemeval-cleaned` variant exists with some data corrections — recent competitors may use this. We have not tested the cleaned variant.

---

## Pinned Versions and Environment

| Item | Value |
|------|-------|
| MeMesh version | see `run_info.environment.memesh_version` in the result JSON |
| Retrieval entrypoint | `dist/core/operations.js::recallEnhanced` |
| Node.js / platform / CPU | recorded per run in `run_info.environment` |
| Dataset | longmemeval_s |
| Dataset SHA256 | 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894 |
| Dataset source | https://huggingface.co/datasets/xiaowu0162/longmemeval |
| Adapter SHA (run.mjs) | Included in each result JSON |

---

## Raw Data

All per-question results are in `results/`. **Read
[`results/README.md`](results/README.md) first** — the directory holds files
produced by two different things, and the difference is larger than any
version-to-version change.

- `results/mode-A-2026-07-29T08-15-09.json` and `results/mode-B-2026-07-29T08-14-48.json` — **the v4.2.11 release measurement. Quote these.** Every number in the table above comes from them.
- `results/mode-A-2026-07-28T21-36-54.json` — superseded, kept as history (v4.2.10, 9.5s).
  `run_info.measures` is `"shipped_recall_path"`.
- `results/mode-A-2026-05-03T12-31-26.json`, `mode-B-…`, `mode-C-…` — the adapter
  reimplementation, kept unmodified for history. No `measures` field. These do
  not describe MeMesh at any version.

Each JSON includes `run_info` (versions, SHA256, timestamp), `overall_metrics`, `metrics_by_type`, and `results` (per-question: question_id, question, ranked_session_ids, answer_session_ids, hit_at, r_at_5, r_at_10, reciprocal_rank).

---

## Manual Verification

5 randomly-sampled questions were manually verified (seeded RNG, seed=20260503) against the **2026-05-03 adapter run**, not against the figures in this document. All 5 were confirmed correct at the time. See [MANUAL-VERIFICATION.md](MANUAL-VERIFICATION.md), which is labelled historical for that reason — re-running the sample against the 2026-07-29 release measurement is open work.

---

*LongMemEval-S | measured through `recallEnhanced()` | see `results/README.md` for what each result file measures*
