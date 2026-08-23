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
import { stripComments } from '../lib/reference-corpus.mjs';
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

/**
 * hit id = class + location key (file, or file:line). Deliberately NO content
 * hash: a line edit shifts ids, which resurfaces the entry as new+stale and
 * forces a re-triage — the failure mode of that choice (an id re-used by
 * different code at the same line, silently inheriting the old triage) is
 * accepted and this comment is where it is written down.
 */
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
    // `toHaveLength(N)` is a size pin and the pattern could not see it — it
    // recognised only the `length).toBe(N)` spelling, so a file that pinned
    // its sizes the other way read as having none. Same blind-spot class as
    // the C5 `\b` that hid every `|| []`: the detector was reporting on a
    // subset of the language and calling it the whole.
    const pins = (src.match(/GreaterThan|toBeGreaterThanOrEqual|\.has\(|length\)\.toBe\([1-9]|toHaveLength\([1-9]/g) ?? []).length;
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
  // scripts/audit/ is NOT excluded: this file and mutation-sample.mjs are
  // gate-like scripts and must answer for their own callers like everything
  // else. The first version excluded the directory and thereby hid
  // mutation-sample.mjs — an uncalled gate — from the detector built to
  // catch uncalled gates.
  const scriptFiles = walk('scripts', ['.mjs', '.sh'])
    .filter(f => !f.includes('/lib/') && !f.includes('/hooks/'));
  const candidates = [...gateScripts.map(k => `npm:${k}`), ...scriptFiles];
  // Comments are stripped before counting: a filename written in prose is not
  // a caller. See scripts/lib/reference-corpus.mjs for the two times a single
  // sentence hid an uncalled script from this detector.
  const corpusParts = [
    ...walk('.github/workflows', ['.yml']).map(f => [f, read(f)]),
    ...scriptFiles.map(f => [f, read(f)]),
    ...walk('tests', ['.ts', '.tsx']).map(f => [f, read(f)]),
    ['package.json', read('package.json')],
  ].map(([f, txt]) => [f, stripComments(txt, f)]);
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
      // The `||` half used to end in `\b`, which cannot match after `]` or
// `}` — a word boundary needs a word character on one side. So `|| true`
      // was detected and `|| []` / `|| {}` never were, for this detector's
      // whole existence. Measured when the hole was found: 10 occurrences in
      // src/ + dashboard/src/ that C5 had never once reported, including a
      // recall path that turned an unreadable payload into "no results".
      // The `??` half was always correct because it has no trailing `\b`.
      if (/\?\?\s*(true|\[\]|\{\})/.test(line) || /\|\|\s*(\[\]|\{\}|true\b)/.test(line)) {
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

/* ---- C8: doctor rows nothing asserts --------------------------------------- */
{
  // The class this catches: a defect is fixed, the fix gets a test, and the
  // DIAGNOSTIC that tells a user the defect is present gets none. `doctor`'s
  // `vector-generation.open` row shipped that way — `reindex
  // --discard-generation` (the action) was pinned, the row that names it was
  // not — so a user could carry a second full copy of their vectors on disk
  // and be told by nobody, with the whole suite green.
  //
  // A row is counted as pinned when its id OR one of its i18n codes appears in
  // test code (comments stripped). That is deliberately generous: it cannot
  // tell an assertion from a fixture seed, and `vector_generation` itself
  // passed that bar for months while only ever being SEEDED. So this detector
  // finds the rows nobody has even named; reading the hit is still the job.
  //
  // Keyed by ID, not by line: these ids are stable identifiers that outlive
  // any edit above them, so unlike the file:line keys elsewhere in this file,
  // a triage here survives the rest of the file moving.
  const src = read('src/core/doctor.ts');
  const rows = new Map(); // id -> Set(i18n codes)
  // A call site whose id could not be read is its own hit, not a `continue`.
  // Otherwise reformatting doctor.ts so the pattern misses half the calls
  // prints `denominator=12 hits=0` and exits 0 — coverage over rows nobody
  // examined, which is the shape this detector exists to catch, in the
  // detector itself.
  const unparsed = [];
  // `(?<!function )` skips the two definitions; the comment test skips prose
  // that names the call — including the note beside `install_id` explaining
  // why it is not one. Line numbers are taken from the ORIGINAL text, so
  // comments are recognised in place rather than stripped (stripping replaces
  // them with a space and collapses the line count with them).
  for (const m of src.matchAll(/(?<!function )create(?:Check|Info)\(/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineEnd = src.indexOf('\n', m.index);
    const lineText = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    if (lineText.startsWith('//') || lineText.startsWith('*')) continue;
    const after = src.slice(m.index, m.index + 400);
    // The id may sit on the call's own line or the next one, with a comment
    // line in between.
    const lit = after.match(/create(?:Check|Info)\(\s*(?:\/\/[^\n]*\n\s*)*['"`]([\w.-]+)['"`]/);
    if (!lit) {
      unparsed.push(`src/core/doctor.ts:${src.slice(0, m.index).split('\n').length} (id unreadable)`);
      continue;
    }
    const codes = rows.get(lit[1]) ?? new Set();
    const code = after.match(/\bcode:\s*['"`]([\w.-]+)['"`]/);
    if (code) codes.add(code[1]);
    rows.set(lit[1], codes);
  }
  const testCode = walk('tests', ['.ts', '.tsx'])
    .map(f => stripComments(read(f), f)).join('\n');
  const hits = [...unparsed];
  for (const [id, codes] of rows) {
    const named = [id, ...codes].some(n =>
      testCode.includes(`'${n}'`) || testCode.includes(`"${n}"`) || testCode.includes(`\`${n}\``));
    if (!named) hits.push(`src/core/doctor.ts:${id}`);
  }
  record('C8', rows.size, hits,
    'doctor rows whose id and i18n codes appear in no test; triage: pin it, or record why the row cannot be asserted');
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
let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
} catch (err) {
  console.error(`scripts/audit/baseline.json is unreadable or not valid JSON: ${err.message}`);
  process.exit(1);
}
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
