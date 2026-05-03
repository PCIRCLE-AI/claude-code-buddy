# Reproducing the MeMesh LongMemEval Benchmark

Anyone — journalist, competitor, researcher — can reproduce these results in under 10 commands. Total time: ~10 seconds (Mode A) or ~25 minutes (Modes B/C, ONNX-dependent).

## Prerequisites

- Node.js >= 20.0.0
- ~500MB disk space (dataset)
- Internet access (first run downloads ONNX model ~25MB for Modes B/C)

## Step-by-step

```bash
# 1. Clone the repository
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory.git
cd memesh-llm-memory

# 2. Check out the benchmark branch
git checkout bench/longmemeval-public-r1

# 3. Install dependencies
npm install

# 4. Download the LongMemEval-S dataset (~278MB, MIT license)
curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s" \
  -o /tmp/longmemeval_s.json

# 5. Verify dataset integrity (optional but recommended)
# Expected SHA256: 08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894
shasum -a 256 /tmp/longmemeval_s.json

# 6. Run Mode A (FTS5 only — ~10 seconds)
node benchmarks/longmemeval/run.mjs --mode A --dataset /tmp/longmemeval_s.json

# 7. Run Mode B (FTS5 + ONNX max — ~25 minutes, downloads model on first run)
node benchmarks/longmemeval/run.mjs --mode B --dataset /tmp/longmemeval_s.json

# 8. Run Mode C (FTS5 + ONNX weighted — ~25 minutes)
node benchmarks/longmemeval/run.mjs --mode C --dataset /tmp/longmemeval_s.json
```

## Expected Output

Mode A (FTS5 only):
```
R@5:  95.40%
R@10: 97.60%
MRR:  0.8899
Time: ~10s
```

Mode B (FTS5 + ONNX max fusion):
```
R@5:  95.40%
R@10: 97.60%
MRR:  0.8904
Time: ~1300s
```

Mode C (FTS5 + ONNX weighted 60/40):
```
R@5:  82.40%
R@10: 96.40%
MRR:  0.3123
Time: ~770s
```

## Verifying the Aggregation

The raw per-question results are in `benchmarks/longmemeval/results/`. You can recompute the aggregate from any result file:

```javascript
const data = require('./benchmarks/longmemeval/results/mode-A-2026-05-03T12-31-26.json');
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
- MeMesh version (4.0.4)
- Git SHA
- Dataset SHA256

Results have been reproduced on Apple M2 Pro (macOS 25.4.0, Node v22.22.0) with identical numbers across multiple runs.

## Dataset License

LongMemEval is released under the MIT license by Xiaowu0162/LongMemEval. The dataset file is not included in this repository; you must download it separately as shown above.

## Troubleshooting

**"Cannot find module 'better-sqlite3'"** — Run `npm install` first.

**"Cannot find module 'sqlite-vec'"** — Same; ensure you're on Node >= 20.

**Mode B/C slow on first run** — The Xenova/all-MiniLM-L6-v2 ONNX model downloads on first use (~25MB). Subsequent runs use the cached model.

**Different results** — If your numbers differ by more than ±0.5pp, check:
1. Dataset SHA256 matches the value above
2. Node.js version >= 20
3. You're on the `bench/longmemeval-public-r1` branch (same adapter code)
