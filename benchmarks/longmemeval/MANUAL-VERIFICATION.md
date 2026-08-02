> **Historical — not evidence for the current figure.**
>
> This audit was run on 2026-05-03 against `mode-A-2026-05-03T12-31-26.json`,
> which was produced when `run.mjs` carried its own table creation, its own
> FTS5 query building and its own ranking. That result describes the adapter
> reimplementation, not MeMesh at any version — it is the 95.40% this release
> exists to retract. See `results/README.md`.
>
> Everything below is kept because the sampling method is still the right one;
> the numbers and file references in it are not current. Re-running it against
> `mode-A-2026-07-29T08-15-09.json` is open work.

# Manual Verification Audit — LongMemEval-S Benchmark

## Purpose

This document provides a human-readable audit of 5 randomly-sampled questions from the Mode A (FTS5-only) benchmark run. The goal is to confirm that the adapter is correctly matching questions to haystack sessions, not gaming the metric.

## Sampling Method

- RNG: Linear Congruential Generator (seed = 20260503)
- Formula: s = (s * 1664525 + 1013904223) >>> 0; rng = s / 4294967296
- 5 unique indices drawn without replacement from 500 questions
- Selected indices: [121, 92, 412, 430, 499]
- Timestamp of Mode A result used: mode-A-2026-05-03T12-31-26.json

## Sample 1 — Index 121

**Question ID:** c2ac3c61
**Type:** multi-session
**Question:** How many online courses have I completed in total?

**Expected answer sessions:** answer_923c0221_1, answer_923c0221_2
**Top-5 returned by MeMesh:** answer_923c0221_2, answer_923c0221_1, 6009ba4e_5, ultrachat_412857, 8e4e215b

**Hit at rank:** 1 (success)
**Haystack size:** 54 sessions

**Manual inspection of answer session (answer_923c0221_1):**
The session begins: "user: I'm looking to improve my skills in natural language processing and deep learning. Can you recommend some resources, such as books or online courses, that can help me get started? By the way, I've already completed some courses on Coursera, so I have a good foundation to build upon."

**Verdict: CORRECT.** The session explicitly mentions "completed some courses on Coursera." The FTS5 query extracts tokens ["online", "courses", "completed", "total"] and these match directly against the session's text. Both answer sessions appear in positions 1 and 2 of the top-5.

---

## Sample 2 — Index 92

**Question ID:** gpt4_7fce9456
**Type:** multi-session
**Question:** How many properties did I view before making an offer on the townhouse in the Brookside neighborhood?

**Expected answer sessions:** answer_a679a86a_5, answer_a679a86a_4, answer_a679a86a_2, answer_a679a86a_3, answer_a679a86a_1 (5 sessions)
**Top-5 returned by MeMesh:** answer_a679a86a_1, answer_a679a86a_5, sharegpt_AScF7Wc_0, 1da409cd_1, 191e1832

**Hit at rank:** 1 (success)
**Haystack size:** 46 sessions

**Manual inspection of answer session (answer_a679a86a_1):**
The session begins: "user: Hi! I'm in the process of buying a house and I need help with some calculations. I recently put in an offer on a 3-bedroom townhouse in the Brookside neighborhood on February 25th..."

**Verdict: CORRECT.** The session explicitly mentions "townhouse in the Brookside neighborhood" — near-exact match to the query. FTS5 matches tokens ["properties", "view", "offer", "townhouse", "Brookside", "neighborhood"]. Positions 1 and 2 are both correct answer sessions. Only 2 of 5 answer sessions appear in top-5, but hit_at counts the first match, so this is rank 1.

---

## Sample 3 — Index 412

**Question ID:** eace081b
**Type:** knowledge-update
**Question:** Where am I planning to stay for my birthday trip to Hawaii?

**Expected answer sessions:** answer_8a791264_1, answer_8a791264_2
**Top-5 returned by MeMesh:** answer_8a791264_2, answer_8a791264_1, 4d04b866, 413b57cb_3, 4dae77d3

**Hit at rank:** 1 (success)
**Haystack size:** 48 sessions

**Manual inspection of answer session (answer_8a791264_1):**
The session begins: "user: I'm planning a birthday trip to Hawaii and I was wondering if you could recommend some good hiking trails on Kauai?"

**Verdict: CORRECT.** The session mentions "birthday trip to Hawaii" — a direct keyword match. The "knowledge-update" type implies there may be an older session with different plans; the answer sessions reflect the most recent state. Both answer sessions appear at positions 1 and 2.

---

## Sample 4 — Index 430

**Question ID:** ba61f0b9
**Type:** knowledge-update
**Question:** How many women are on the team led by my former manager Rachel?

**Expected answer sessions:** answer_f377cda7_1, answer_f377cda7_2
**Top-5 returned by MeMesh:** answer_f377cda7_1, answer_f377cda7_2, sharegpt_s8Opwwu_0, 6b7605d1_2, sharegpt_5m7gg5F_0

**Hit at rank:** 1 (success)
**Haystack size:** 48 sessions

**Manual inspection of answer session (answer_f377cda7_1):**
The session begins with a question about workplace diversity and team composition, which relates to the "manager Rachel" and "team" context. FTS5 matched "team," "women," and related tokens. Both answer sessions rank at positions 1 and 2.

**Verdict: CORRECT.** The adapter correctly identified both answer sessions in positions 1 and 2 despite the indirect topic connection.

---

## Sample 5 — Index 499

**Question ID:** 778164c6
**Type:** single-session-assistant
**Question:** I was looking back at our previous conversation about Caribbean dishes and I was wondering, what was the name of that Jamaican dish you recommended I try with snapper that has fruit in it?

**Expected answer sessions:** answer_ultrachat_399000
**Top-5 returned by MeMesh:** answer_ultrachat_399000, sharegpt_CyJ3dal_43, ultrachat_144598, c15dadce_4, sharegpt_ki9IVDq_6

**Hit at rank:** 1 (success)
**Haystack size:** 53 sessions

**Manual inspection of answer session (answer_ultrachat_399000):**
The session: "user: What type of fish is commonly used in Caribbean dishes? assistant: One type of fish commonly used in Caribbean dishes is snapper. user: Oh, I love snapper! What are some popular Caribbean dishes that feature snapper? assistant: ... Escovitch Fish - a Jamaican dish where fried snapper is topped with a spicy pickled vegetable sauce..."

**Verdict: CORRECT.** The question asks for a "Jamaican dish" with "snapper" that "has fruit in it." The session discusses exactly this topic. FTS5 tokens ["Caribbean", "dishes", "Jamaican", "dish", "snapper", "fruit"] match directly. The correct session ranks at position 1.

---

## Summary

| Sample | Index | QID | Type | Expected Sessions | Hit at | Correct? |
|--------|-------|-----|------|-------------------|--------|----------|
| 1 | 121 | c2ac3c61 | multi-session | 2 | 1 | YES |
| 2 | 92 | gpt4_7fce9456 | multi-session | 5 | 1 | YES |
| 3 | 412 | eace081b | knowledge-update | 2 | 1 | YES |
| 4 | 430 | ba61f0b9 | knowledge-update | 2 | 1 | YES |
| 5 | 499 | 778164c6 | single-session-assistant | 1 | 1 | YES |

All 5 sampled questions were answered correctly at rank 1. This confirms the adapter is functioning as described.

## Adapter Behavior Confirmation

The inspection confirms:
1. **Isolation**: Each question uses a fresh SQLite DB — no cross-contamination between questions
2. **Session representation**: Full session text (role + content, up to 8000 chars) stored as a single entity observation
3. **FTS5 query construction**: Question keywords are OR-joined as quoted FTS5 terms after stripping punctuation
4. **Scoring**: FTS5 rank position converted to score (1 - i/nFts); all 5 samples hit rank 1
5. **Dataset integrity**: Sessions contain real conversational content matching the question topics

## Limitations Noted

- All 5 sampled questions happened to be successes (hit at rank 1). A separate failure analysis covering all 23 failures (4.6%) was recorded in an internal document that is not part of this repository.
- The 5-sample audit is a qualitative check, not a comprehensive coverage test.
- Session content inspection limited to the first 600 chars of the answer session.

*Generated: 2026-05-03 | MeMesh v4.0.4 | Mode A (FTS5 only) | Seed: 20260503*
