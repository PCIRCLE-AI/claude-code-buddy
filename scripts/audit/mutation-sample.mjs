#!/usr/bin/env node
// Sampled mutation testing: how much of the suite actually fails when the
// shipped code breaks? Not "do the tests pass" — they do. Every surviving
// mutant is a line of shipped code no test protects, which is untested code
// wearing a green coverage report.
//
// Sampled, not exhaustive: the suite is fully serial (shared SQLite), so the
// full pool is hours. N and SEED are parameters and MUST be quoted with any
// reported score — without the seed the number cannot be reproduced, and
// reproducing it from a clean checkout is one of this project's done
// criteria.
//
//   SAMPLE=12 SEED=20260804 node scripts/audit/mutation-sample.mjs
//   OPERATORS=blank SAMPLE=12 SEED=20260804 node scripts/audit/mutation-sample.mjs
//
// Honesty guards, in the code below:
//   - test selection is a heuristic and can only UNDER-select; a survivor is
//     re-run against the whole suite before being reported as one
//   - a mutation whose pattern no longer applies is MISS, never killed
//   - restoration is by writing the original string back, never git checkout
//
// The `blank` operator set is the C2 detector for src/: force functions and
// guards to produce nothing, and see whether any test notices. A test still
// green under a blank-out is a test with only negative assertions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-mutation-'));
const COPY = path.join(WORK, 'tree');
const HOME = path.join(WORK, 'home');
const SAMPLE = Number(process.env.SAMPLE ?? 12);
const SEED = Number(process.env.SEED ?? 20260804);
if (!Number.isInteger(SAMPLE) || SAMPLE < 1 || !Number.isInteger(SEED)) {
  // A NaN here used to make the sampling loop's `< SAMPLE` comparison false
  // forever: zero mutants, zero survivors, exit 0 — total misconfiguration
  // reporting as a clean run.
  console.error(`SAMPLE and SEED must be positive integers (got SAMPLE=${process.env.SAMPLE}, SEED=${process.env.SEED})`);
  process.exit(2);
}
const OPERATOR_SET = process.env.OPERATORS ?? 'classic';

/** Deterministic PRNG so a run can be reproduced and compared. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const OPERATOR_SETS = {
  // Behaviour-flip operators: each changes an observable outcome if reached.
  classic: [
    { name: 'eq->neq', find: ' === ', to: ' !== ' },
    { name: 'neq->eq', find: ' !== ', to: ' === ' },
    { name: 'gt->gte', find: ' > ', to: ' >= ' },
    { name: 'lt->lte', find: ' < ', to: ' <= ' },
    { name: 'and->or', find: ' && ', to: ' || ' },
    { name: 'or->and', find: ' || ', to: ' && ' },
    { name: 'true->false', find: 'return true;', to: 'return false;' },
    { name: 'false->true', find: 'return false;', to: 'return true;' },
  ],
  // Blank-out operators (C2): make the code produce NOTHING and see if any
  // test notices. `.slice(0, 0)` is valid on any array, so these compile.
  blank: [
    { name: 'guard->reject-all', find: ' && ', to: ' && false && ' },
    { name: 'map->empty', find: '.map(', to: '.slice(0, 0).map(' },
    { name: 'filter->empty', find: '.filter(', to: '.slice(0, 0).filter(' },
    { name: 'true->false', find: 'return true;', to: 'return false;' },
  ],
};
const OPERATORS = OPERATOR_SETS[OPERATOR_SET];
if (!OPERATORS) {
  console.error(`unknown OPERATORS=${OPERATOR_SET}; valid: ${Object.keys(OPERATOR_SETS).join(', ')}`);
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function fresh() {
  fs.rmSync(COPY, { recursive: true, force: true });
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.git',
    '--exclude', 'coverage', REPO + '/', COPY + '/']);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(COPY, 'node_modules'));
}

const TEST_FILES = walk(path.join(REPO, 'tests')).filter(f => /\.(test|spec)\.tsx?$/.test(f));
const TEST_SRC = new Map(TEST_FILES.map(f => [f, fs.readFileSync(f, 'utf8')]));

/** Test files that mention this module by path fragment or basename. UNDER-selects only. */
function selectTests(relSrc) {
  const noExt = relSrc.replace(/^src\//, '').replace(/\.ts$/, '');
  const base = path.basename(noExt);
  const hits = [];
  for (const [f, src] of TEST_SRC) {
    if (src.includes(noExt) || new RegExp(`[/'"\`]${base}(\\.js)?['"\`/]`).test(src)) {
      hits.push(path.relative(REPO, f));
    }
  }
  return hits;
}

function runVitest(files) {
  try {
    execFileSync('npx', ['vitest', 'run', ...files], {
      cwd: COPY, encoding: 'utf8',
      env: { ...process.env, HOME },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000,
    });
    return 0;
  } catch (e) {
    // `status` is a NUMBER only when the child ran and exited. A timeout kill
    // leaves status null; a missing npx leaves it undefined — and `?? 1` used
    // to fold both into "the tests failed", which the callers read as KILLED.
    // A harness that never ran must crash the run, not grade the mutant.
    if (typeof e.status !== 'number') {
      throw new Error(`the test runner produced no verdict (${e.code ?? e.signal ?? 'unknown'}): ${e.message}`, { cause: e });
    }
    return e.status;
  }
}

/* ---------------- build the candidate list ---------------- */

const srcFiles = walk(path.join(REPO, 'src'));
const candidates = [];
for (const abs of srcFiles) {
  const rel = path.relative(REPO, abs);
  const fileLines = fs.readFileSync(abs, 'utf8').split('\n');
  fileLines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ')) return;
    for (const op of OPERATORS) {
      if (line.includes(op.find)) candidates.push({ rel, lineNo: i, op });
    }
  });
}

const rand = rng(SEED);
const picked = [];
const pool = candidates.slice();
while (picked.length < SAMPLE && pool.length) {
  picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
}

console.log(`# operators=${OPERATOR_SET} candidates=${candidates.length} across ${srcFiles.length} src files`);
console.log(`# sampling ${picked.length} (seed ${SEED})\n`);
if (candidates.length === 0 || picked.length === 0) {
  // Same rule the verification audit applies to itself: an empty candidate
  // set is what a broken harness looks like, not what a clean tree looks like.
  console.error('zero mutation candidates sampled — the operators matched nothing; that is a broken harness, not a perfect suite');
  process.exit(2);
}

/* ---------------- run ---------------- */

fresh();
const results = [];
for (const [n, m] of picked.entries()) {
  const p = path.join(COPY, m.rel);
  const original = fs.readFileSync(p, 'utf8');
  const fileLines = original.split('\n');
  if (!fileLines[m.lineNo] || !fileLines[m.lineNo].includes(m.op.find)) {
    results.push({ ...m, verdict: 'MISS' });
    console.log(`${String(n + 1).padStart(3)}/${picked.length}  MISS     ${m.rel}:${m.lineNo + 1} [${m.op.name}]`);
    continue;
  }
  fileLines[m.lineNo] = fileLines[m.lineNo].replace(m.op.find, m.op.to);
  fs.writeFileSync(p, fileLines.join('\n'));

  const selected = selectTests(m.rel);
  let verdict, how;
  if (selected.length === 0) {
    verdict = runVitest([]) !== 0 ? 'KILLED' : 'SURVIVED';
    how = 'full (no test mentions this module)';
  } else {
    const code = runVitest(selected);
    if (code !== 0) { verdict = 'KILLED'; how = `${selected.length} selected`; }
    else {
      // Selection is a heuristic. Never report a survivor without the full suite.
      verdict = runVitest([]) !== 0 ? 'KILLED' : 'SURVIVED';
      how = verdict === 'KILLED' ? 'full (selection under-picked)' : 'full';
    }
  }
  // String restore, never git checkout — and confirm the restore took.
  fs.writeFileSync(p, original);
  if (fs.readFileSync(p, 'utf8') !== original) throw new Error(`restore failed for ${m.rel}`);
  results.push({ ...m, verdict, how });
  console.log(`${String(n + 1).padStart(3)}/${picked.length}  ${verdict.padEnd(8)} ${m.rel}:${m.lineNo + 1} [${m.op.name}] (${how})`);
}

fs.rmSync(WORK, { recursive: true, force: true });

const killed = results.filter(r => r.verdict === 'KILLED').length;
const survived = results.filter(r => r.verdict === 'SURVIVED');
const missed = results.filter(r => r.verdict === 'MISS').length;
console.log(`\nkilled=${killed}  survived=${survived.length}  miss=${missed}  of ${results.length}`);
if (killed + survived.length > 0) {
  console.log(`mutation score = ${((killed / (killed + survived.length)) * 100).toFixed(1)}% (N=${SAMPLE}, seed=${SEED}, operators=${OPERATOR_SET})`);
}
if (survived.length) {
  console.log('\nSURVIVORS — shipped code no test protects (report these; do not re-roll):');
  for (const s of survived) console.log(`  ${s.rel}:${s.lineNo + 1} [${s.op.name}]`);
  process.exitCode = 1;
}
