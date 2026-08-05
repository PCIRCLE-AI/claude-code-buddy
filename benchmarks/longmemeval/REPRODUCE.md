# Reproducing the MeMesh LongMemEval Benchmark

Anyone — journalist, competitor, researcher — can reproduce these results in under 10 commands. Total time: ~10 seconds (Mode A).

> **Mode B is historical.** It was measured on the local ONNX MiniLM-L6 embedder
> that has since been removed. To reproduce a Mode B run today you must configure
> an embedder (`ollama serve` + `memesh config set embedder.provider ollama`, or
> openai); the numbers you get belong to that model, not to the original MiniLM run.

The runner calls MeMesh's shipped retrieval path (`recallEnhanced()`), so what
you measure here is what a `recall` call does. That was not true before 2026-07;
see RESULTS.md if you are comparing against an older figure.

## Prerequisites

- Node.js >= 20.0.0
- ~500MB disk space (dataset)
- For Mode B only: a configured embedder (ollama or openai) reachable from the runner

## Step-by-step

```bash
# 1. Clone the repository
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory.git
cd memesh-llm-memory

# 2. Install dependencies and build
#    The runner imports from dist/, so the build must run first.
npm install
npm run build

# 3. Download the LongMemEval-S dataset (~278MB, MIT license)
curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s" \
  -o /tmp/longmemeval_s.json

# 4. Verify dataset integrity (optional but recommended)
# Expected SHA256: 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
shasum -a 256 /tmp/longmemeval_s.json

# 5. Run Mode A (no embeddings — ~10 seconds)
node benchmarks/longmemeval/run.mjs --mode A --dataset /tmp/longmemeval_s.json

# 6. Run Mode B (embeddings populated — ~14 minutes, downloads model on first run)
node benchmarks/longmemeval/run.mjs --mode B --dataset /tmp/longmemeval_s.json
```

The runner sets `HOME` to a throwaway directory for the duration of the run, so
it cannot read your `~/.memesh/config.json` or write near your real knowledge
graph. Nothing you have stored is touched.

## Expected Output

Mode A (no embeddings):
```
R@5:  95.60%
R@10: 97.80%
MRR:  0.8929
Questions returning zero results: 0/500
Time: ~10s
```

## Verifying the Aggregation

The raw per-question results are in `benchmarks/longmemeval/results/`. You can recompute the aggregate from any result file:

```javascript
const data = require('./benchmarks/longmemeval/results/mode-A-2026-07-29T08-15-09.json');
const n = data.results.length;
const r5 = data.results.filter(r => r.r_at_5).length / n;
const r10 = data.results.filter(r => r.r_at_10).length / n;
const mrr = data.results.reduce((s, r) => s + r.reciprocal_rank, 0) / n;
console.log(`R@5: ${(r5*100).toFixed(2)}% R@10: ${(r10*100).toFixed(2)}% MRR: ${mrr.toFixed(4)}`);
```

## Environment Pinning

Each result JSON includes `run_info.environment` with:
- Node.js version
- OS platform and version
- CPU model and core count
- MeMesh version (recorded in the result JSON's `run_info`)
- Git SHA
- Dataset SHA256

Results have been reproduced on Apple M2 Pro (macOS 25.4.0, Node v22.22.0) with identical numbers across multiple runs.

## Dataset License

LongMemEval is released under the MIT license by Xiaowu0162/LongMemEval. The dataset file is not included in this repository; you must download it separately as shown above.

## Troubleshooting

**"Cannot find module 'better-sqlite3'"** — Run `npm install` first.

**"Cannot find module 'sqlite-vec'"** — Same; ensure you're on Node >= 20.

**Mode B needs an embedder** — the local ONNX model is gone; Mode B calls the configured provider (ollama/openai). Ensure it is running/reachable before the run, or Mode B exits with a message telling you so.

**Different results** — If your numbers differ by more than ±0.5pp, check:
1. Dataset SHA256 matches the value above
2. Node.js version >= 20
3. `npm run build` has run since your last checkout — the runner imports the
   compiled retrieval path from `dist/`, so a stale build measures stale code
4. Which commit you are on. The runner now measures the shipped path, so the
   figure moves when retrieval changes — that is the point of it. Numbers from
   before 2026-07 came from a separate implementation inside the runner and are
   not comparable; see `results/README.md`.
