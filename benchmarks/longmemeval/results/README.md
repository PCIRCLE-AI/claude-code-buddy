# What each result file measures

Raw per-question output from `run.mjs`. **Two different things produced the files
in this directory**, and the difference is larger than any version-to-version
change.

## Files from 2026-07 onward — the shipped retrieval path

`run_info.measures` is `"shipped_recall_path"` and
`run_info.retrieval_entrypoint` names the function that produced them
(`dist/core/operations.js::recallEnhanced`). These are measurements of MeMesh.

### 2026-07-31 — post-review confirmation. Different hardware, same numbers.

`mode-A-2026-07-31T04-52-22.json` and `mode-B-2026-07-31T05-09-44.json` — re-run
after the retrieval changes in
`fix/root-causes-pre-4.2.11`, on aarch64 (ARM, Node v20.19.6) rather than the
x64 Mac the release runs were measured on.

Both are bit-identical to the 07-29 release measurement in all three metrics,
with 0/500 questions returning nothing:

| | R@5 | R@10 | MRR |
|---|---|---|---|
| Mode A | 95.60% | 97.80% | 0.8929348706848708 |
| Mode B | 95.60% | 97.80% | 0.8930598706848707 |

Mode B matters separately because it is the path the vector-hydration change
touches; Mode A alone could not have told us about it. The term-cap reorder (dropping ubiquitous terms *before* capping at
32, rather than after) therefore does not move English retrieval, and the
quality metrics are hardware-independent.

`elapsed_seconds` is 22.4 (A) and 1013 (B) against the release runs' 9.1 and 807.7. That is the machine,
not a regression — this box is ARM. **Do not quote elapsed time from this
file**; the published timing comes from the 07-29 run.

### 2026-07-29 — the v4.2.11 release measurement

Quote these. They were produced on the released tree, after the vector
threshold, document-frequency guard and `recall_hits` ownership changes.

- `mode-A-2026-07-29T08-15-09.json` — no embeddings. R@5 95.60%, R@10 97.80%,
  MRR 0.8929348706848708, 9.1s.
- `mode-B-2026-07-29T08-14-48.json` — embeddings populated. R@5 95.60%,
  R@10 97.80%, MRR 0.8930598706848707, 807.7s. 14 of 500 result lists differ
  from Mode A; two questions move the correct session, both outside the top 10.

### 2026-07-28 — superseded, kept as history

- `mode-A-2026-07-28T21-36-54.json`, `mode-B-2026-07-28T21-54-01.json`.

Same R@5 and R@10 as the pair above, different MRR (0.8931166888666888), because
they predate the vector-threshold change, the document-frequency guard and the
`recall_hits` ownership fix. At the time they were taken `MAX_VECTOR_DISTANCE`
was 1, which discarded hits sqlite-vec returns at L2 distances of 1.2–1.4 —
which is why Mode B came out byte-for-byte identical to Mode A. That is a
correct record of the code as it stood, not a claim about the release.

One field in these two was edited after publication: `run_info.dataset` held the
absolute path of the machine that ran them, which leaked a local home directory
into a public repository. It now holds the basename. `dataset_sha256` is what
identifies the dataset and is unchanged, as is every measurement — the rest of
both files is byte-identical. `run.mjs` records the basename from now on, so
this cannot recur.

## Files from 2026-05 — an adapter reimplementation

`mode-A-2026-05-*.json`, `mode-B-2026-05-*.json`, `mode-C-2026-05-*.json`.

These have no `measures` field. They were produced when `run.mjs` carried its own
`CREATE TABLE`, its own FTS5 query construction and its own ranking, and they
measure that code — not the product. The two had drifted: the adapter OR-joined
query terms and ordered by BM25 `rank`, while the shipped `search()` AND-joined
and ordered by `e.id DESC`. On the same 500 questions the adapter scored 95.40%
R@5 and the shipped path scored 5.20%, with 473 of 500 questions returning
nothing.

They are kept unmodified because they are published evidence and deleting or
editing them would be worse than labelling them. Read them as a record of what
the adapter did, not as a statement about any version of MeMesh.

`mode-C-*` additionally measures a 60/40 weighted FTS+vector fusion that MeMesh
has never implemented.

See `../METHODOLOGY.md` §2 and CHANGELOG `[Unreleased]` / PR #78.
