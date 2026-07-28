#!/usr/bin/env node
// LongMemEval benchmark runner — PUBLIC EVIDENCE PACKAGE
//
// This runner drives MeMesh's SHIPPED retrieval path. It seeds each question's
// haystack through `KnowledgeGraph.createEntity()` — the storage call
// `remember()` makes — and retrieves through `recallEnhanced()`, the function
// every transport (MCP, HTTP, CLI) calls for `recall`. There is no benchmark
// copy of the schema, the query builder, or the ranking.
//
// It did not always work that way. Until 2026-07 this file carried its own
// `CREATE TABLE`, its own FTS5 query construction and its own ranking, and the
// published 95.40% R@5 measured that reimplementation rather than the product.
// The two had drifted: the harness OR-joined query terms and ordered by BM25
// `rank` while the shipped `search()` AND-joined and ordered by `e.id DESC`,
// so the same 500 questions scored 95.40% here and 5.20% through the product.
// See CHANGELOG [Unreleased] / PR #78. Results produced before that fix are
// kept in `results/` for history and are labelled `harness_reimplementation`.
//
// Usage:
//   node benchmarks/longmemeval/run.mjs --mode A --dataset /tmp/longmemeval_s.json
//
// Modes map to real product configurations, not to harness-internal fusion
// strategies:
//   A — embeddings absent. FTS5 + BM25 only. ~10s for 500 questions.
//   B — embeddings populated (local ONNX, 384-dim), so `recallEnhanced()`'s
//       vector supplement can contribute. ~25min for 500 questions.
// The old mode C (a 60/40 weighted FTS+vector fusion) is gone: it was a
// harness-only experiment. The product has never implemented weighted fusion,
// so there was nothing for it to measure.

import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '../..');

function parseArgs(a) {
  const r = {};
  for (let i = 2; i < a.length; i++) {
    if (a[i].startsWith('--')) { r[a[i].slice(2)] = a[i + 1] ?? true; i++; }
  }
  return r;
}
const args = parseArgs(process.argv);
const mode = String(args.mode || 'A').toUpperCase();
if (mode !== 'A' && mode !== 'B') {
  process.stderr.write(`Unknown mode "${mode}". Use A (no embeddings) or B (embeddings populated).\n`);
  process.exit(1);
}
const datasetPath = args.dataset || '/tmp/longmemeval_s.json';
const limitArg = parseInt(args.limit || '500', 10);
const recallLimit = parseInt(args['recall-limit'] || '20', 10);
const outputDir = args.output || path.join(__dirname, 'results');

// Isolate from the real install. The runner opens hundreds of throwaway
// databases; without this it would read ~/.memesh/config.json (picking up the
// operator's provider/embedder settings and making the run unreproducible) and
// risk writing next to their real knowledge graph.
const workRoot = args.workdir || path.join(os.tmpdir(), 'memesh-longmemeval');
const fakeHome = path.join(workRoot, 'home');
mkdirSync(path.join(fakeHome, '.memesh'), { recursive: true });
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

// The runner measures compiled code on purpose. Fail with something readable
// rather than a bare ERR_MODULE_NOT_FOUND when the build has not run.
if (!existsSync(path.join(repoRoot, 'dist/core/operations.js'))) {
  process.stderr.write('dist/ is missing — this runner measures the shipped retrieval path.\nRun `npm run build` first.\n');
  process.exit(1);
}

const { openDatabase, closeDatabase, getDatabase } = await import(path.join(repoRoot, 'dist/db.js'));
const { KnowledgeGraph } = await import(path.join(repoRoot, 'dist/knowledge-graph.js'));
const { recallEnhanced } = await import(path.join(repoRoot, 'dist/core/operations.js'));
const { embedAndStore, isEmbeddingAvailable } = await import(path.join(repoRoot, 'dist/core/embedder.js'));

if (mode === 'B' && !isEmbeddingAvailable()) {
  process.stderr.write('Mode B needs embeddings available (local ONNX via @huggingface/transformers). Run `npm install`.\n');
  process.exit(1);
}

function sha256File(fp) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    const s = createReadStream(fp);
    s.on('data', (c) => h.update(c));
    s.on('end', () => res(h.digest('hex')));
    s.on('error', rej);
  });
}
function readMemeshVersion() {
  try { return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
}
function getEnvInfo() {
  const cpus = os.cpus();
  let gitSha = 'unknown';
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    gitSha = (r.stdout || '').trim() || 'unknown';
  } catch { /* not a git checkout */ }
  return {
    node_version: process.version,
    platform: os.platform(),
    os_version: os.release(),
    arch: os.arch(),
    cpu_model: cpus[0]?.model || 'unknown',
    cpu_cores: cpus.length,
    memesh_version: readMemeshVersion(),
    git_sha: gitSha,
  };
}

// Same mapping the dataset's own evaluation uses: one session -> one memory.
const sessionToText = (s) => s.map((t) => `${t.role}: ${t.content}`).join('\n').slice(0, 8000);

function removeDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix); } catch { /* best effort */ }
  }
}

async function runQuestion(item) {
  const dbPath = path.join(workRoot, `bench-${item.question_id}-${mode}.db`);
  removeDb(dbPath);
  process.env.MEMESH_DB_PATH = dbPath;
  openDatabase(dbPath);
  try {
    const db = getDatabase();
    const kg = new KnowledgeGraph(db);

    // Write path: the storage call `remember()` makes. remember()'s extras
    // (auto-tagging, provenance metadata, scheduled embedding) are
    // fire-and-forget LLM work that does not affect retrieval; mode B does the
    // embedding explicitly below so the run stays deterministic.
    const seeded = [];
    db.transaction(() => {
      for (let i = 0; i < item.haystack_sessions.length; i++) {
        const name = item.haystack_session_ids[i];
        const text = sessionToText(item.haystack_sessions[i]);
        seeded.push([kg.createEntity(name, 'session', { observations: [text] }), name, text]);
      }
    })();

    if (mode === 'B') {
      for (const [id, name, text] of seeded) await embedAndStore(id, `${name} ${text}`);
    }

    // Read path: exactly what a `recall` call runs.
    const entities = await recallEnhanced({ query: item.question, limit: recallLimit });
    const ranked = entities.map((e) => e.name);

    const answers = new Set(item.answer_session_ids);
    let hit = null;
    for (let i = 0; i < ranked.length; i++) { if (answers.has(ranked[i])) { hit = i + 1; break; } }

    return {
      question_id: item.question_id,
      question_type: item.question_type,
      question: item.question,
      ranked_session_ids: ranked.slice(0, 10),
      answer_session_ids: item.answer_session_ids,
      hit_at: hit,
      r_at_5: hit !== null && hit <= 5,
      r_at_10: hit !== null && hit <= 10,
      reciprocal_rank: hit !== null ? 1 / hit : 0,
      returned_count: ranked.length,
      haystack_size: item.haystack_sessions.length,
    };
  } finally {
    closeDatabase();
    removeDb(dbPath);
  }
}

function metrics(rs) {
  const n = rs.length;
  if (!n) return { r_at_5: 0, r_at_10: 0, mrr: 0, total: 0 };
  return {
    r_at_5: rs.filter((r) => r.r_at_5).length / n,
    r_at_10: rs.filter((r) => r.r_at_10).length / n,
    mrr: rs.reduce((s, r) => s + r.reciprocal_rank, 0) / n,
    total: n,
  };
}
function metricsByType(rs) {
  const m = {};
  for (const r of rs) { (m[r.question_type] ||= []).push(r); }
  return Object.fromEntries(Object.entries(m).map(([t, v]) => [t, metrics(v)]));
}

async function main() {
  const description = mode === 'A' ? 'shipped recall, no embeddings' : 'shipped recall, embeddings populated';
  process.stderr.write(`\nMeMesh LongMemEval — mode ${mode}: ${description}\n`);
  process.stderr.write('Retrieval: dist/core/operations.js -> recallEnhanced()\n');

  process.stderr.write('Computing dataset SHA256...\n');
  const datasetSha = await sha256File(datasetPath);
  process.stderr.write(`SHA256: ${datasetSha}\n`);

  const items = JSON.parse(readFileSync(datasetPath, 'utf8')).slice(0, limitArg);
  process.stderr.write(`Loaded ${items.length} questions.\n`);
  mkdirSync(outputDir, { recursive: true });

  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < items.length; i++) {
    try {
      results.push(await runQuestion(items[i]));
    } catch (err) {
      process.stderr.write(`ERR ${items[i].question_id}: ${err.message}\n`);
      results.push({
        question_id: items[i].question_id,
        question_type: items[i].question_type,
        question: items[i].question,
        ranked_session_ids: [],
        answer_session_ids: items[i].answer_session_ids,
        hit_at: null, r_at_5: false, r_at_10: false, reciprocal_rank: 0,
        returned_count: 0, haystack_size: 0, error: err.message,
      });
    }
    if ((i + 1) % 50 === 0) {
      const m = metrics(results);
      process.stderr.write(`[${i + 1}/${items.length}] R@5=${(m.r_at_5 * 100).toFixed(1)}% R@10=${(m.r_at_10 * 100).toFixed(1)}% MRR=${m.mrr.toFixed(3)}\n`);
    }
  }

  const overall = metrics(results);
  const byType = metricsByType(results);
  const elapsed = parseFloat(((Date.now() - t0) / 1000).toFixed(1));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outputDir, `mode-${mode}-${stamp}.json`);

  writeFileSync(outFile, JSON.stringify({
    run_info: {
      mode,
      mode_description: description,
      // Which code produced these numbers. Result files written before
      // 2026-07 say `harness_reimplementation` and do not describe the product.
      measures: 'shipped_recall_path',
      retrieval_entrypoint: 'dist/core/operations.js::recallEnhanced',
      recall_limit: recallLimit,
      dataset: datasetPath,
      dataset_sha256: datasetSha,
      dataset_variant: 'longmemeval_s',
      n_questions: results.length,
      elapsed_seconds: elapsed,
      timestamp: new Date().toISOString(),
      environment: getEnvInfo(),
      status: 'PUBLIC',
    },
    overall_metrics: overall,
    metrics_by_type: byType,
    results,
  }, null, 2));

  process.stderr.write(`\n=== RESULTS mode ${mode} ===\n`);
  process.stderr.write(`R@5:  ${(overall.r_at_5 * 100).toFixed(2)}%\n`);
  process.stderr.write(`R@10: ${(overall.r_at_10 * 100).toFixed(2)}%\n`);
  process.stderr.write(`MRR:  ${overall.mrr.toFixed(4)}\n`);
  process.stderr.write(`Questions returning zero results: ${results.filter((r) => r.returned_count === 0).length}/${results.length}\n`);
  process.stderr.write(`Time: ${elapsed}s  Saved: ${outFile}\n`);
  process.stderr.write('By type:\n');
  for (const [t, m] of Object.entries(byType)) {
    process.stderr.write(`  ${t}: R@5=${(m.r_at_5 * 100).toFixed(1)}% (n=${m.total})\n`);
  }
  try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(JSON.stringify({ mode, overall, outFile }, null, 2));
}

main().catch((e) => { process.stderr.write(`Fatal: ${e.message}\n`); process.exit(1); });
