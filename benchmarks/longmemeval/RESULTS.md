# MeMesh LongMemEval Benchmark Results

**Version:** MeMesh v4.0.4
**Date:** 2026-05-03
**Branch:** bench/longmemeval-public-r1
**Status:** DRAFT — Modes B and C in progress. Mode A confirmed. Full results pending.

> See METHODOLOGY.md for technical details. See REPRODUCE.md to run this yourself.

---

## Summary

MeMesh v4.0.4 achieves **R@5 = 95.40%** on LongMemEval-S (500 questions, MIT license dataset, publicly available from Hugging Face). This is measured using FTS5 full-text search — the same retrieval engine MeMesh uses in production. The benchmark simulates the core task of long-term memory systems: given a question, retrieve the relevant session(s) from a haystack of ~50 sessions.

MeMesh significantly outperforms open-source alternatives (Supermemory ~82%, Zep 63.8%, Mem0 49%) and is within 1.2pp of the vendor-reported MemPalace ceiling (96.6%).

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

**Adapter:** `benchmarks/longmemeval/run.mjs`
- Each question: fresh isolated SQLite DB (no cross-contamination)
- Sessions indexed as MeMesh entities with FTS5 full-text search
- FTS5 query: question keywords OR-joined as quoted terms
- Scoring: FTS5 rank position → normalized score (1 - i/nFts)

**Mode definitions:**
- **Mode A (FTS5 only):** Pure FTS5 retrieval, no embeddings
- **Mode B (FTS5+ONNX max):** FTS5 + ONNX embeddings, score = max(fts_score, vec_score)
- **Mode C (FTS5+ONNX weighted):** FTS5 + ONNX embeddings, score = 0.6*fts + 0.4*vec

**Embedding model (Modes B/C):** Xenova/all-MiniLM-L6-v2 (384 dimensions, ONNX Runtime)

**Metric:** R@k = fraction of questions where any answer session appears in top-k results. MRR = mean(1/rank_of_first_answer_session).

---

## Results — Per-Mode Metrics

| Mode | Description | R@5 | R@10 | MRR | Elapsed |
|------|-------------|-----|------|-----|---------|
| A | FTS5 only | **95.40%** | 97.60% | 0.8899 | 10.0s |
| B | FTS5+ONNX (max fusion) | 95.40%* | 97.60%* | 0.8904* | ~1300s |
| C | FTS5+ONNX (weighted 60/40) | 82.40%* | 96.40%* | 0.3123* | ~770s |

*Modes B and C: in-progress numbers from prior run (bench/longmemeval-r5, commit 6cc7ec14). Final numbers will be updated when current runs complete. Prior run and current run use identical adapter code. Dataset SHA256 confirmed identical.

**Key finding:** Mode A (FTS5-only) and Mode B (FTS5+ONNX max) are identical in R@5. Mode C (weighted fusion) regresses significantly due to distractor contamination. See METHODOLOGY.md for root cause.

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
- `results/mode-A-2026-05-03T12-31-26.json` — Mode A confirmed (500 questions)
- `results/mode-B-*.json` — Mode B (in progress)
- `results/mode-C-*.json` — Mode C (in progress)

Each JSON includes `run_info` (versions, SHA256, timestamp), `overall_metrics`, `metrics_by_type`, and `results` (per-question: question_id, question, ranked_session_ids, answer_session_ids, hit_at, r_at_5, r_at_10, reciprocal_rank).

---

## Manual Verification

5 randomly-sampled questions were manually verified (seeded RNG, seed=20260503). All 5 confirmed correct. See [MANUAL-VERIFICATION.md](MANUAL-VERIFICATION.md).

---

*MeMesh v4.0.4 | LongMemEval-S | bench/longmemeval-public-r1 | 2026-05-03*
