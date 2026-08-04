#!/usr/bin/env node
// Verification audit: one re-runnable detector per "looks verified but isn't"
// defect class, each with a DENOMINATOR (how many candidate sites exist) and
// a hit list. Runs as a gate: exit 1 on any hit that is not in the triaged
// baseline, and exit 1 when a detector's candidate set comes out empty —
// a detector that found nothing to look at is broken, not clean.
//
// The baseline (baseline.json, beside this file) is not suppression: it is
// the recorded triage. Every entry carries a classification and a one-clause
// reason, written when a human (or a reviewed agent pass) looked at the hit.
// A NEW hit fails this gate until someone triages it — either fix it, or add
// it to the baseline with a reason. Baseline entries whose hit no longer
// exists are reported so the file cannot accumulate dead weight.
//
// Classes C2 (blank-out mutations) and the mutation score live in
// mutation-sample.mjs — they run code, not scans, and take minutes; this
// file stays fast enough for verify:release.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');

function walk(dir, exts, out = []) {
  const full = path.join(REPO, dir);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === 'coverage') continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, exts, out);
    else if (exts.some(x => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

/** hit id = class + a stable location key (file[:line] + a content hash tail). */
function hitId(cls, key) {
  return `${cls} ${key}`;
}

const report = {};
const allHits = [];

function record(cls, denominator, hits, note) {
  report[cls] = { denominator, hits, note };
  for (const h of hits) allHits.push(hitId(cls, h));
}

/* ---- C1: emptiness assertions with no anti-vacuity pin -------------------- */
{
  const files = walk('tests', ['.ts', '.tsx']);
  const hits = [];
  let withEmptiness = 0;
  for (const f of files) {
    const src = read(f);
    const emptiness = (src.match(/toEqual\(\[\]\)|toHaveLength\(0\)|\.toBe\(0\)/g) ?? []).length;
    if (!emptiness) continue;
    withEmptiness++;
    const pins = (src.match(/GreaterThan|toBeGreaterThanOrEqual|\.has\(|length\)\.toBe\([1-9]/g) ?? []).length;
    if (pins === 0) hits.push(f);
  }
  record('C1', withEmptiness, hits,
    'test files asserting emptiness with zero size pins anywhere in the file (heuristic; triage each)');
}

/* ---- C3: gate-like scripts with no automated caller ----------------------- */
{
  const pkg = JSON.parse(read('package.json'));
  const gateScripts = Object.keys(pkg.scripts).filter(k =>
    /^(test|verify|check|audit|lint|typecheck)/.test(k));
  const scriptFiles = walk('scripts', ['.mjs', '.sh'])
    .filter(f => !f.includes('/lib/') && !f.includes('/hooks/') && !f.startsWith('scripts/audit/'));
  const candidates = [...gateScripts.map(k => `npm:${k}`), ...scriptFiles];
  const corpusParts = [
    ...walk('.github/workflows', ['.yml']).map(f => [f, read(f)]),
    ...scriptFiles.map(f => [f, read(f)]),
    ...walk('tests', ['.ts', '.tsx']).map(f => [f, read(f)]),
    ['package.json', read('package.json')],
  ];
  const hits = [];
  for (const c of candidates) {
    const needle = c.startsWith('npm:') ? `run ${c.slice(4)}` : path.basename(c);
    const refs = corpusParts.filter(([f]) => f !== c)
      .reduce((n, [, txt]) => n + (txt.split(needle).length - 1), 0);
    if (refs === 0) hits.push(c);
  }
  record('C3', candidates.length, hits,
    'zero references from workflows / scripts / tests / package.json');
}

/* ---- C4: verdict eaten by || true or a pipe into a filter ----------------- */
{
  const files = [...walk('.github/workflows', ['.yml']), ...walk('scripts', ['.sh'])];
  const hits = [];
  let lines = 0;
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      lines++;
      const t = line.trim();
      if (t.startsWith('#')) return;
      if (/\|\|\s*true/.test(line) || /\|\s*(grep|tail|head|wc|awk|sed)\b/.test(line)) {
        hits.push(`${f}:${i + 1}`);
      }
    });
  }
  record('C4', lines, hits,
    'each needs an answer to "does anything read the real exit code" — pipefail at file top counts');
}

/* ---- C5: optimistic defaults ---------------------------------------------- */
{
  const files = [...walk('src', ['.ts']), ...walk('dashboard/src', ['.ts', '.tsx'])];
  const hits = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (/\?\?\s*(true|\[\]|\{\})/.test(line) || /\|\|\s*(\[\]|\{\}|true)\b/.test(line)) {
        hits.push(`${f}:${i + 1}`);
      }
    });
  }
  record('C5', files.length, hits,
    'each hit answers: does this default make missing input read as success?');
}

/* ---- C6: tests reading source files and text-matching --------------------- */
{
  const files = walk('tests', ['.ts', '.tsx']);
  const hits = [];
  for (const f of files) {
    const src = read(f);
    const readsSource = [...src.matchAll(/readFileSync[^\n]*?['"`]([^'"`]+\.(?:ts|tsx|mjs|sh|yml|js))['"`]/g)]
      .map(m => m[1]).filter(p => !p.includes('fixture'));
    if (readsSource.length && /\.toMatch\(|\.toContain\(/.test(src)) hits.push(f);
  }
  record('C6', files.length, hits,
    'triage: data-extraction (ok) vs asserting-the-text-is-the-behavior (defect)');
}

/* ---- C7: numeric claims in English living prose ---------------------------- */
{
  const files = ['README.md', ...walk('docs', ['.md'])]
    .filter(f => !f.startsWith('docs/internal/') && !f.startsWith('docs/plans/'));
  const GATED = [/\d+ endpoints/, /\d+ tools via MCP/, /\d+ hooks/, /\d+ tools\)/, /\d+ languages?:/, /\d+ tabs, \d+ languages/, /\(\d+%\)/, /\b\d+% \+/];
  const EXTERNAL = /paper|Vendor|self-report|estimate/i;
  const hits = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      if (/width="|height="|src="/.test(line)) return;
      const m = line.match(/\b(\d{1,3}(?:,\d{3})*|\d+(?:\.\d+)?)\s*(%|tests|endpoints|components|hooks|tools|languages|locales|R@5)/i);
      if (!m) return;
      if (GATED.some(g => g.test(line))) return;
      if (EXTERNAL.test(line)) return;
      hits.push(`${f}:${i + 1}`);
    });
  }
  record('C7', files.length, hits,
    'a number in prose needs a measuring command, a gate in check-doc-claims, or deletion; GATED patterns are the shapes check-doc-claims covers');
}

/* ---- gate ------------------------------------------------------------------ */

const baselinePath = path.join(REPO, 'scripts/audit/baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const known = new Set(Object.keys(baseline.hits));

let failed = false;
console.log('Verification audit:');
for (const [cls, r] of Object.entries(report)) {
  if (typeof r.denominator === 'number' && r.denominator === 0) {
    console.log(`  ✗ ${cls}: denominator 0 — the detector found nothing to examine; that is a broken detector, not a clean class`);
    failed = true;
    continue;
  }
  const fresh = r.hits.map(h => hitId(cls, h)).filter(id => !known.has(id));
  console.log(`  ${fresh.length ? '✗' : '✓'} ${cls}: denominator=${r.denominator} hits=${r.hits.length} new=${fresh.length}`);
  for (const id of fresh) {
    console.log(`      NEW ${id} — triage it: fix, or add to baseline.json with a classification and reason`);
    failed = true;
  }
}

// Stale baseline entries: the hit no longer exists. Reported, not fatal —
// pruning them is cleanup, but they must be visible so the file cannot rot.
const current = new Set(allHits);
const stale = [...known].filter(id => !current.has(id));
if (stale.length) {
  console.log(`  ! ${stale.length} baseline entries no longer hit (prune them):`);
  for (const id of stale) console.log(`      ${id}`);
}

if (failed) {
  console.log('\n✗ Verification audit found untriaged hits (or a broken detector).');
  process.exit(1);
}
console.log('\n✓ Every hit is triaged; every detector saw a non-empty candidate set.');
