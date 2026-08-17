// =============================================================================
// calibrate-transcript-dedup — measure the near-duplicate distance threshold
// =============================================================================
//
// B3 of Task #18 skips a transcript-mined candidate when it is a near-duplicate
// of an entity already in the graph. "Near-duplicate" is a distance in
// entities_vec, and the cut-off must be MEASURED, not guessed (the same rule
// MAX_VECTOR_DISTANCE in embedder.ts follows). This harness measures the L2
// distance distribution for:
//
//   - KNOWN-duplicate pairs   : two phrasings of the SAME memory (paraphrase)
//   - KNOWN-distinct pairs     : SAME-DOMAIN, DIFFERENT fact (hard negatives —
//                                the floor of this class is what sets the safe
//                                threshold; easy negatives would inflate it)
//
// It embeds BOTH sides with the exact text builder the runtime uses for an
// entity vector — `${name} ${observations.join(' ')}` (operations.ts remember()
// and applyTranscriptProposal use this) — so the measured quantity is the one
// findDuplicateEntity actually computes, via dist/core/embedder.js.
//
// PROVENANCE / STATUS: this script's SYNTHETIC fixture is no longer what the
// shipped threshold comes from, and the reason is worth keeping.
//
// It derived 0.55 twice — once on the old ONNX MiniLM embedder, once on ollama
// nomic — from 10 hand-written duplicate pairs and 10 hand-written distinct
// pairs, putting the false-positive cliff at 0.668. Measured against a real
// graph on 2026-08-09 (214 entities, 47 human-accepted transcript memories) the
// real floor was 0.446: the fixture overstated it by 0.22, and 0.55 sat ABOVE
// the real cliff, dropping 13% of memories a human had chosen to keep.
//
// TRANSCRIPT_DEDUP_MAX_DISTANCE is now 0.44, derived from that live measurement
// and recorded in the constant's comment in src/core/transcript-extractor.ts.
// This script is still useful for comparing EMBEDDERS on a fixed fixture, but a
// hand-written fixture cannot tell you where a real corpus puts the boundary —
// real memories are formulaic and cluster far tighter than invented ones. Derive
// the shipped number from a real graph.
//
// Run:  configure ollama (or an openai key), then:
//         npm run build && node scripts/calibrate-transcript-dedup.mjs
//
// Copy the printed distributions + chosen threshold into the
// TRANSCRIPT_DEDUP_MAX_DISTANCE comment in src/core/transcript-extractor.ts,
// noting which model they belong to.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { embedText, isEmbeddingAvailable } = await import(path.join(repoRoot, 'dist/core/embedder.js'));

if (!isEmbeddingAvailable()) {
  console.error(
    'No embedder is configured, so there is nothing to calibrate against. The local\n' +
    'ONNX embedder was removed — configure ollama (`ollama serve` + `embedder.provider\n' +
    'ollama`) or an openai embedder, then re-run. The result belongs to whichever\n' +
    'model you point this at; record that model next to the threshold.'
  );
  process.exit(1);
}

/** Same builder the runtime uses for an entity vector. */
function entityText(name, observations) {
  return `${name} ${observations.join(' ')}`;
}

function l2(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// Each memory is {name, observations}. A DUPLICATE pair is two honest rewordings
// of the SAME decision/lesson/fact (what a re-run or a manual remember of the
// same thing looks like). Drawn to look like real memesh memories.
const DUP_PAIRS = [
  [
    { name: 'parser-choice', observations: ['Chose library B for parsing transcripts because library A cannot stream large files.'] },
    { name: 'transcript-parser-decision', observations: ['We use library B, not library A, to parse transcripts — A has no streaming support for big inputs.'] },
  ],
  [
    { name: 'fts-contentless-delete', observations: ['entities_fts is a contentless FTS5 table; a delete must use the exact indexed text or stale tokens remain.'] },
    { name: 'fts5-delete-rule', observations: ['Because entities_fts stores no content, deleting a row needs the original indexed text, otherwise old tokens survive in the index.'] },
  ],
  [
    { name: 'vec-table-global', observations: ['entities_vec is one sqlite-vec table for the whole database, not per-namespace; dropping it wipes every namespace.'] },
    { name: 'vector-index-scope', observations: ['There is a single entities_vec table across all namespaces — drop it and you lose all embeddings everywhere.'] },
  ],
  [
    { name: 'no-squash-merge', observations: ['Never squash-merge; keep every commit because each carries its own verification evidence.'] },
    { name: 'merge-policy', observations: ['Squash merges are banned — we preserve individual commits since each holds its own proof it was verified.'] },
  ],
  [
    { name: 'isolated-test-runner', observations: ['Run the suite via run-tests-isolated.mjs against a throwaway HOME so it never mutates the real ~/.memesh graph.'] },
    { name: 'test-isolation', observations: ['Use the isolated runner with a disposable HOME for tests; running vitest directly writes to your real knowledge graph.'] },
  ],
  [
    { name: 'exit-code-not-grep', observations: ['Judge a command by its exit code, not by grepping its output — a pipe returns grep status and hides missed lines.'] },
    { name: 'verify-by-exit-code', observations: ['Read the real exit code rather than piping into grep; the pipe reports grep and swallows lines the pattern missed.'] },
  ],
  [
    { name: 'env-before-command', observations: ['Environment variables must go BEFORE the command; trailing VAR=x is passed as an argument, not an env var.'] },
    { name: 'env-var-placement', observations: ['Put env assignments in front of the command — writing them after passes a plain argument instead of setting the variable.'] },
  ],
  [
    { name: 'keyword-only-default', observations: ['Without a configured embedder, fresh installs run recall on FTS5 keyword search alone — no API key and no download required.'] },
    { name: 'default-recall-path', observations: ['Out of the box memesh does semantic-free recall over FTS5; a neural embedder (ollama/openai) is opt-in and needed only for meaning-based search.'] },
  ],
  [
    { name: 'dream-accept-additive', observations: ['A transcript proposal is applied additively by dream accept — it creates a new entity and archives no sources.'] },
    { name: 'apply-transcript-proposal', observations: ['Accepting a transcript-sourced proposal just creates the entity; there are no source entities to archive or link.'] },
  ],
  [
    { name: 'untrusted-transcript-trust', observations: ['Transcript-mined memories are stamped untrusted so they stay out of unprompted auto-context injection.'] },
    { name: 'transcript-trust-stamp', observations: ['Memory extracted from a transcript is marked untrusted, keeping it from being auto-injected into context without a request.'] },
  ],
];

// HARD NEGATIVES: same topic, DIFFERENT fact. The threshold must sit below the
// minimum distance in THIS set (with margin) — that floor is the false-positive
// risk. An easy negative (bread recipe vs SQL) would make the gap look huge and
// the threshold falsely permissive.
const DISTINCT_PAIRS = [
  [
    { name: 'parser-choice', observations: ['Chose library B for parsing transcripts because library A cannot stream large files.'] },
    { name: 'serializer-choice', observations: ['Chose library B for serialization because library A is slow on large objects.'] },
  ],
  [
    { name: 'fts-contentless-delete', observations: ['entities_fts is a contentless FTS5 table; a delete must use the exact indexed text or stale tokens remain.'] },
    { name: 'vec-table-global', observations: ['entities_vec is one sqlite-vec table for the whole database, not per-namespace; dropping it wipes every namespace.'] },
  ],
  [
    { name: 'chunk-char-budget', observations: ['The per-chunk character budget for transcript extraction is 48000 chars so a typical session is one chunk.'] },
    { name: 'max-chunks-per-session', observations: ['A session is capped at 4 chunks so one huge transcript cannot exhaust the whole LLM-call budget.'] },
  ],
  [
    { name: 'no-squash-merge', observations: ['Never squash-merge; keep every commit because each carries its own verification evidence.'] },
    { name: 'no-ai-attribution', observations: ['Never add AI attribution to commits or PRs; strip any Co-Authored-By Claude line from the template.'] },
  ],
  [
    { name: 'window-days-default', observations: ['The transcript scan window defaults to 3 days (72 hours) of recently modified sessions.'] },
    { name: 'max-llm-calls-default', observations: ['The transcript source defaults to a hard cap of 100 LLM calls per run.'] },
  ],
  [
    { name: 'session-summary-hook', observations: ['The session-summary hook mines mechanical signals: files edited, bash commands, and errors encountered.'] },
    { name: 'transcript-extractor', observations: ['The transcript extractor mines conversational memory: decisions, lessons, and durable facts from the prose.'] },
  ],
  [
    { name: 'secret-scrub-outbound', observations: ['scrubSecrets redacts credentials on the way out to the LLM, keeping the surrounding conversation text.'] },
    { name: 'secret-detect-drop', observations: ['containsSecret detects a credential in a returned candidate memory and drops that whole candidate before staging.'] },
  ],
  [
    { name: 'contradiction-guard', observations: ['The ordering instruction tells the model later statements override earlier ones so reversed claims are not recorded.'] },
    { name: 'per-project-scope', observations: ['Transcript scanning is scoped per project by the recorded cwd, so a slug collision cannot leak another project.'] },
  ],
  [
    { name: 'confidence-bump-policy', observations: ['Confidence bumps only on a brand-new observation from a trusted source, never from importer or auto-learned lessons.'] },
    { name: 'signal-score-at-write', observations: ['Every entity gets a rule-based signal_score at creation so the dashboard can hide mechanical noise without an LLM.'] },
  ],
  [
    { name: 'dimension-mismatch-skip', observations: ['embedAndStore skips the vector write when the provider dimension differs from the stored table dimension.'] },
    { name: 'reindex-generation-swap', observations: ['Switching embedders needs a plain reindex; it builds the new width in a staging generation and swaps once complete.'] },
  ],
];

function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { min: s[0], p25: q(0.25), p50: q(0.5), p75: q(0.75), max: s[s.length - 1], mean };
}

async function distancesFor(pairs) {
  const out = [];
  for (const [a, b] of pairs) {
    const ea = await embedText(entityText(a.name, a.observations));
    const eb = await embedText(entityText(b.name, b.observations));
    if (!ea || !eb) throw new Error('embedText returned null — is the configured embedder (ollama/openai) reachable?');
    out.push(l2(ea, eb));
  }
  return out;
}

const dup = await distancesFor(DUP_PAIRS);
const distinct = await distancesFor(DISTINCT_PAIRS);

const dupS = stats(dup);
const distinctS = stats(distinct);

const fmt = (s) =>
  `min ${s.min.toFixed(3)}  p25 ${s.p25.toFixed(3)}  p50 ${s.p50.toFixed(3)}  p75 ${s.p75.toFixed(3)}  max ${s.max.toFixed(3)}  mean ${s.mean.toFixed(3)}`;

console.log('Configured embedder, L2 over unit vectors, text = `${name} ${observations.join(" ")}` (record which model these belong to)');
console.log(`  DUPLICATE pairs   (n=${dup.length}):  ${fmt(dupS)}`);
console.log(`  DISTINCT pairs    (n=${distinct.length}):  ${fmt(distinctS)}`);
console.log('');
console.log('  duplicate distances (sorted):', dup.map((d) => d.toFixed(3)).sort().join(' '));
console.log('  distinct  distances (sorted):', distinct.map((d) => d.toFixed(3)).sort().join(' '));
console.log('');

// Conservative rule: favor false-NEGATIVES (occasionally re-propose a dup) over
// false-POSITIVES (silently drop a genuinely new memory — invisible data loss).
// So the threshold sits BELOW the hardest distinct pair, with margin — NOT
// between the two medians. Identical re-run text is distance ~0 and is caught at
// any threshold > 0; everything above ~0 only buys paraphrase-catching, which is
// exactly where a false positive would live.
const gap = distinctS.min - dupS.max;
console.log(`  gap between classes (distinctMin - dupMax): ${gap.toFixed(3)}`);
if (gap > 0) {
  // Classes separate: a quarter into the gap from the dup side is safely below
  // the distinct floor.
  const conservative = dupS.max + gap * 0.25;
  console.log(`  suggested conservative threshold (dupMax + 25% of gap): ${conservative.toFixed(3)}`);
  console.log(`  (distinct-class floor is ${distinctS.min.toFixed(3)}; threshold must stay clearly below it)`);
} else {
  // Classes OVERLAP or touch (gap <= 0): the "dupMax + 25% of gap" formula
  // would land AT OR ABOVE the distinct floor — i.e. it would recommend a
  // value that silently drops genuinely-new memories, the worst outcome this
  // whole feature guards against. Do NOT print a number labelled
  // "conservative" here; the model cannot separate the classes on this
  // corpus, so the threshold MUST be hand-picked below the distinct floor to
  // catch only exact/near-exact re-runs. That is the regime the shipped
  // TRANSCRIPT_DEDUP_MAX_DISTANCE was chosen in — by hand, not by this
  // formula — on the old MiniLM embedder; re-derive per model.
  console.log(`  ⚠ CLASSES OVERLAP (gap <= 0): this embedding model cannot separate`);
  console.log(`    "same memory reworded" from "same domain, different fact" on this corpus.`);
  console.log(`    Do NOT derive a threshold from the gap — it would sit at/above the`);
  console.log(`    distinct floor (${distinctS.min.toFixed(3)}) and start dropping NEW memories.`);
  console.log(`    Hand-pick a value clearly BELOW ${distinctS.min.toFixed(3)} that catches only`);
  console.log(`    exact/near-exact re-runs. The SHIPPED threshold is no longer chosen from this fixture — see the header.`);
}
