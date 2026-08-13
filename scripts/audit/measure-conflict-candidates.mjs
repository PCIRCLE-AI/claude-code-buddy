#!/usr/bin/env node
// Read-only measurement: what would the conflict pipeline's candidate
// generator produce against a REAL knowledge graph, across thresholds?
//
// This is the tool the CONFLICT_MAX_COSINE_DISTANCE constant was chosen
// with (2026-08-13: ≤0.30 → 68 signal pairs, ≤0.35 → 160, ≤0.40 → 535 on a
// 761-entity graph), kept so the number can be re-measured before changing
// embedders or thresholds — a threshold nobody can re-derive is a magic
// number with a citation.
//
//   node scripts/audit/measure-conflict-candidates.mjs [--db <path>]
//
// Opens the database READ-ONLY via its own connection (never openDatabase —
// that runs migrations and maintenance writes). The only output is stdout.
// Uses the same signal-type list and cosine conversion as the shipped
// module, imported from dist/ so the measurement cannot drift from the code
// it calibrates.
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distModule = path.join(repoRoot, 'dist/core/conflict-candidates.js');
if (!fs.existsSync(distModule)) {
  console.error('dist/core/conflict-candidates.js not found — run `npm run build` first.');
  process.exit(2);
}
const { CONFLICT_SIGNAL_TYPES } = await import(distModule);

const dbArg = process.argv.indexOf('--db');
const dbPath = dbArg !== -1
  ? process.argv[dbArg + 1]
  : process.env.MEMESH_DB_PATH ?? path.join(os.homedir(), '.memesh', 'knowledge-graph.db');

const db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: true });
db.enableLoadExtension(true);
sqliteVec.load(db);
db.enableLoadExtension(false);

const typePlaceholders = CONFLICT_SIGNAL_TYPES.map(() => '?').join(',');
const rows = db.prepare(
  `SELECT v.rowid AS id, v.embedding AS emb, e.name, e.type
   FROM entities_vec v JOIN entities e ON e.id = v.rowid
   WHERE e.status = 'active' AND e.type IN (${typePlaceholders})`,
).all(...CONFLICT_SIGNAL_TYPES);

const related = new Set(
  db.prepare(
    `SELECT from_entity_id a, to_entity_id b FROM relations
     WHERE relation_type IN ('supersedes', 'contradicts')`,
  ).all().map((r) => `${Math.min(r.a, r.b)}:${Math.max(r.a, r.b)}`),
);
let judged = new Set();
try {
  judged = new Set(db.prepare('SELECT pair_key FROM conflict_judged_pairs').all().map((r) => r.pair_key));
} catch { /* pre-pipeline database — table not created yet */ }

const vecs = rows.map((r) => {
  const f = new Float32Array(new Uint8Array(r.emb).buffer.slice(0));
  let norm = 0;
  for (let i = 0; i < f.length; i++) norm += f[i] * f[i];
  return { id: r.id, name: r.name, type: r.type, f, norm: Math.sqrt(norm) || 1 };
});

console.log(`db: ${dbPath}`);
console.log(`signal entities with embeddings: ${vecs.length}; excluded: ${related.size} related, ${judged.size} judged`);

const thresholds = [0.25, 0.3, 0.35, 0.4, 0.45];
const counts = new Map(thresholds.map((t) => [t, 0]));
const tight = [];
for (let i = 0; i < vecs.length; i++) {
  for (let j = i + 1; j < vecs.length; j++) {
    const a = vecs[i], b = vecs[j];
    let dot = 0;
    for (let k = 0; k < a.f.length; k++) dot += a.f[k] * b.f[k];
    const dist = 1 - dot / (a.norm * b.norm);
    if (dist > thresholds[thresholds.length - 1]) continue;
    const key = `${Math.min(a.id, b.id)}:${Math.max(a.id, b.id)}`;
    if (related.has(key) || judged.has(key)) continue;
    for (const t of thresholds) if (dist <= t) counts.set(t, counts.get(t) + 1);
    tight.push({ a: a.name, b: b.name, ta: a.type, tb: b.type, dist });
  }
}

for (const t of thresholds) console.log(`cosine distance <= ${t.toFixed(2)}: ${counts.get(t)} candidate pairs`);
tight.sort((x, y) => x.dist - y.dist);
console.log('\n15 tightest pairs:');
for (const p of tight.slice(0, 15)) {
  console.log(`  ${p.dist.toFixed(3)}  [${p.ta}/${p.tb}]  ${p.a}  <->  ${p.b}`);
}
db.close();
