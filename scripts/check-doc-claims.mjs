#!/usr/bin/env node

// Every claim the public documents make about the code, checked against the
// code. Replaces `scripts/verify-docs-sync.sh`, for two reasons.
//
// FIRST, AND THE ONE THAT MATTERS: nothing ran it. Not CI, not
// `npm run verify:release`, not `scripts/release-verify.sh`, not a
// `package.json` script. Its only callers were a line in `CLAUDE.md` telling an
// assistant to run it by hand and a manual review skill. Six checks, 150 lines,
// executed when somebody remembered — which is the same "gate that cannot fail"
// this repository has now found in `verify_agent_work`, in the MCP tool count,
// in `schema-export.test.ts` and in the benchmark itself, one level up: a gate
// that never runs cannot fail either. This file is wired into `verify:release`,
// which is the one list both CI and the publish path execute.
//
// SECOND: it was a bash script, and `verify:release` runs on windows-latest.
// The same matrix already hid a Windows-only failure once — `execFileSync('npm')`
// giving ENOENT and then `npm.cmd` giving EINVAL — where the script could not
// run on Windows and nothing on Windows ran the script. Node runs everywhere the
// package claims to.
//
// Three checks did not survive the port, and it is worth saying why rather than
// quietly dropping them:
//
//   - The hook check counted files and compared to a literal 7, while separately
//     counting hook mentions in ARCHITECTURE.md and comparing that to NOTHING.
//     Both halves are now derived from `hooks/hooks.json`, the manifest that
//     actually invokes them, so adding a hook fails the docs rather than the gate.
//   - The skills check counted every four-column table row in SKILL.md and
//     required 7 or more. It reported 9 against a table whose rows are not all
//     hooks; no realistic edit could fail it. It now asserts that each hook the
//     manifest can invoke is named in the file.
//   - The lint check printed WARN and did not increment the error count, so a
//     failing lint passed the gate. `verify:release` hard-gates lint at
//     `--max-warnings 0` two steps earlier; a second, weaker copy is worse than
//     none.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { listHookFiles } from './lib/hook-files.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(repoRoot, p), 'utf8');

const failures = [];
const notes = [];
const fail = m => failures.push(m);
const ok = m => notes.push(`✓ ${m}`);

// Everything below reads only files git tracks. `TECHNICAL_DEBT.md` is excluded
// via `.git/info/exclude` — a local internal document — and an earlier version of
// this gate read it unconditionally. On a clean clone that is an ENOENT crash, on
// all eight CI legs at once. Found by cloning the branch and running the gate,
// which is the only way to see it: the file is present in every working tree that
// has ever had it.
const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
);
const trackedDirs = new Set();
for (const f of tracked) {
  const parts = f.split('/');
  for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/') + '/');
}
const isTracked = p => tracked.has(p) || trackedDirs.has(p) || trackedDirs.has(p + '/');

const pkg = JSON.parse(read('package.json'));

// --- 1. Version stamps -------------------------------------------------------
for (const doc of ['docs/ARCHITECTURE.md', 'docs/api/API_REFERENCE.md']) {
  const m = read(doc).match(/\*\*Version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/);
  if (!m) fail(`${doc} has no \`**Version**: X.Y.Z\` stamp`);
  else if (m[1] !== pkg.version) fail(`${doc} says ${m[1]}, package.json says ${pkg.version}`);
  else ok(`${doc} version stamp ${m[1]}`);
}

// --- 2. Hooks, derived from the manifest that invokes them -------------------
const hookManifest = JSON.parse(read('hooks/hooks.json'));
const manifestHooks = new Set();
for (const matchers of Object.values(hookManifest.hooks ?? {})) {
  for (const matcher of matchers) {
    for (const h of matcher.hooks ?? []) manifestHooks.add(h.command.split('/').pop());
  }
}
if (manifestHooks.size === 0) {
  fail('hooks/hooks.json yielded no hook commands — the manifest is malformed or the shape changed');
} else {
  // Files only, nothing `_`-prefixed — the rule lives in scripts/lib/
  // hook-files.mjs where a test can feed it a fixture directory.
  const onDisk = listHookFiles(path.join(repoRoot, 'scripts/hooks'));
  const missing = [...manifestHooks].filter(h => !onDisk.includes(h));
  const extra = onDisk.filter(h => !manifestHooks.has(h));
  if (missing.length) fail(`hooks/hooks.json invokes ${missing.join(', ')}, which is not in scripts/hooks/`);
  if (extra.length) fail(`scripts/hooks/ holds ${extra.join(', ')}, which hooks.json never invokes`);
  if (!missing.length && !extra.length) ok(`${onDisk.length} hooks, manifest and directory agree`);

  const archText = read('docs/ARCHITECTURE.md');
  const archCount = archText.match(/### Hook Scripts \((\d+) hooks?\)/);
  if (!archCount) fail('docs/ARCHITECTURE.md no longer states its hook count in `### Hook Scripts (N hooks)`');
  else if (Number(archCount[1]) !== manifestHooks.size)
    fail(`docs/ARCHITECTURE.md says ${archCount[1]} hooks, the manifest registers ${manifestHooks.size}`);
  else ok(`ARCHITECTURE.md hook count ${archCount[1]}`);

  // The old check counted EVERY four-column row in the file and required "7 or
  // more" — it reported 9 against a document whose rows are not all hooks, so no
  // realistic edit could fail it. This counts the rows of the one table that
  // describes hooks, and compares them to the manifest.
  //
  // SKILL.md names hooks by their Claude Code EVENT (SessionStart, PreCompact),
  // not by filename, which is right for its audience — so the row count is the
  // honest thing to compare, not the filenames.
  const skill = read('skills/memesh/SKILL.md');
  const table = skill.match(/^\| Hook \| When \| What it does \|\n\|[-| ]+\|\n((?:\|.*\n)+)/m);
  if (!table) {
    fail('skills/memesh/SKILL.md no longer has a `| Hook | When | What it does |` table');
  } else {
    const rows = table[1].trim().split('\n').length;
    if (rows !== manifestHooks.size)
      fail(`skills/memesh/SKILL.md documents ${rows} hooks, the manifest registers ${manifestHooks.size}`);
    else ok(`skills/memesh/SKILL.md documents all ${rows} hooks`);
  }
}

// --- 3. MCP tool count -------------------------------------------------------
const toolsInCode = (read('src/transports/mcp/handlers.ts').match(/^ {4}name: '/gm) ?? []).length;
const claimed = read('docs/api/API_REFERENCE.md').match(/MeMesh exposes (\d+) tools via MCP/);
if (toolsInCode < 1) fail('found no tools in handlers.ts — the pattern stopped matching');
else if (!claimed) fail('docs/api/API_REFERENCE.md no longer states how many tools MeMesh exposes');
else if (Number(claimed[1]) !== toolsInCode)
  fail(`handlers.ts registers ${toolsInCode} tools, API_REFERENCE.md says ${claimed[1]}`);
else ok(`registry and API_REFERENCE.md agree on ${toolsInCode} MCP tools`);

// --- 4. HTTP endpoint count --------------------------------------------------
//
// ARCHITECTURE.md carried "~32 endpoints" in the module list and "17 endpoints"
// in the transport section — one file, one fact, two numbers, and the wrong one
// off by fifteen. The count is stated once now, and checked here.
const routesInCode = (read('src/transports/http/server.ts').match(/^app\.(get|post|put|delete|patch)\(/gm) ?? [])
  .length;
const archRoutes = read('docs/ARCHITECTURE.md').match(/default port 3737, (\d+) endpoints/);
if (routesInCode < 1) fail('found no routes in http/server.ts — the pattern stopped matching');
else if (!archRoutes) fail('docs/ARCHITECTURE.md no longer states its endpoint count');
else if (Number(archRoutes[1]) !== routesInCode)
  fail(`server.ts registers ${routesInCode} routes, ARCHITECTURE.md says ${archRoutes[1]}`);
else ok(`server.ts and ARCHITECTURE.md agree on ${routesInCode} HTTP endpoints`);

// --- 5. No README may state a test count -------------------------------------
//
// All eleven said "630 tests" while the suite had grown past 1400. The fix is
// not a checker for eleven copies of a number — it is to stop writing the number
// down. `npm test` prints the current one.
const readmes = fs.readdirSync(repoRoot).filter(f => /^README(\.[a-zA-Z-]+)?\.md$/.test(f));
if (readmes.length === 0) fail('no README*.md found — this check stopped looking at anything');
const withCounts = readmes.filter(f => /\b\d[\d,]*\s*(tests|test cases)\b/i.test(read(f)));
if (withCounts.length) fail(`README(s) state a hardcoded test count: ${withCounts.join(', ')}`);
else ok(`${readmes.length} READMEs state no hardcoded test count`);

// --- 4b. Every registered HTTP route is documented ---------------------------
//
// Four registered routes (/v1/doctor, /v1/projects, /v1/demo/seed,
// /v1/demo/reset) went completely undocumented while the dashboard called
// three of them on every load. A count (check 4) cannot see that — it says how
// many routes exist, not which ones the reference forgot. This walks the
// registrations and requires each path to appear in API_REFERENCE.md.
const routePaths = [...read('src/transports/http/server.ts').matchAll(/^app\.(?:get|post|put|delete|patch)\((['"`])([^'"`]+)\1/gm)]
  .map(m => m[2])
  .filter(p => p.startsWith('/v1/'));
if (routePaths.length < 20) fail(`route extraction found only ${routePaths.length} /v1 paths — the pattern stopped matching`);
else {
  const apiRef = read('docs/api/API_REFERENCE.md');
  const undocumented = routePaths.filter(p => !apiRef.includes(p));
  if (undocumented.length) fail(`registered but absent from API_REFERENCE.md: ${[...new Set(undocumented)].join(', ')}`);
  else ok(`all ${new Set(routePaths).size} registered /v1 routes appear in API_REFERENCE.md`);
}

// --- 6. Deprecated terms -----------------------------------------------------
const searched = ['docs/ARCHITECTURE.md', 'docs/api/API_REFERENCE.md', 'skills/memesh/SKILL.md', ...readmes];
for (const term of ['dual-write', 'bidirectional pointer']) {
  const hits = searched.filter(f => read(f).includes(term));
  if (hits.length) fail(`deprecated term "${term}" in ${hits.join(', ')}`);
}
ok('no deprecated terms');

// --- 6b. No README may sell a surface that does not exist --------------------
//
// Four translations still offered "the Python SDK" months after the SDK was
// deleted and its PyPI name proved never published — each in different words,
// which is why this is a per-README term scan and not one exact phrase. The
// product has no Python surface at all, so in a README the bare word is
// already wrong. Scoped to READMEs on purpose: API_REFERENCE.md legitimately
// says "Python" in the note explaining the SDK's retirement.
for (const term of ['Python', 'python', 'pip install']) {
  const hits = readmes.filter(f => read(f).includes(term));
  if (hits.length) fail(`"${term}" in ${hits.join(', ')} — there is no Python surface; the SDK was removed and was never on PyPI`);
}
ok('no phantom Python surface in READMEs');

// --- 7. No living document may point at a path that does not exist -----------
//
// Deleting `packages/python-sdk/` left `docs/api/API_REFERENCE.md` saying "See
// `packages/python-sdk/` for full SDK source" — a dangling pointer in the public
// API reference, created by the commit that removed the thing. Changelogs are
// excluded on purpose: naming files that no longer exist is what a changelog is
// for.
//
// Existence is measured against `git ls-files`, NOT against the filesystem.
// Break-testing this check is what found the difference: deleting
// `packages/python-sdk/` left untracked `__pycache__` behind, so `fs.existsSync`
// answered true for a directory no clone would ever contain, and the mutation
// that should have failed passed. The question a reader asks is "will this path
// be there when I clone", and only the index answers it.
const docRoots = ['src/', 'scripts/', 'tests/', 'docs/', 'dashboard/', 'benchmarks/', 'skills/', 'hooks/', 'packages/', '.github/', '.claude-plugin/'];
const livingDocs = [
  ...readmes,
  'CONTRIBUTING.md',
  'CODEMAP.md',
  'DESIGN.md',
  'SECURITY.md',
  'CLAUDE.md',
  'docs/ARCHITECTURE.md',
  'docs/api/API_REFERENCE.md',
  'skills/memesh/SKILL.md',
].filter(isTracked);
const dangling = [];
for (const doc of livingDocs) {
  for (const m of read(doc).matchAll(/`([A-Za-z0-9_./-]+)`/g)) {
    const p = m[1];
    if (!docRoots.some(r => p.startsWith(r))) continue;
    if (/[*?{}]/.test(p)) continue;
    if (!isTracked(p)) dangling.push(`${doc} → ${p}`);
  }
}
if (dangling.length) fail(`documents point at paths that do not exist:\n      ${dangling.join('\n      ')}`);
else ok(`${livingDocs.length} living documents, no dangling repo paths`);

// --- report ------------------------------------------------------------------
console.log('Doc claims audit:');
for (const n of notes) console.log('  ' + n);

if (failures.length === 0) {
  console.log('\n✓ Every documented claim matches the code.');
  process.exit(0);
}
console.error('\n✗ Doc claims FAILED:');
for (const f of failures) console.error('  - ' + f);
process.exit(1);
