#!/usr/bin/env node

// Every claim the public documents make about the code, checked against the
// code. Replaces `scripts/verify-docs-sync.sh`, for two reasons.
//
// FIRST, AND THE ONE THAT MATTERS: nothing ran it. Not CI, not
// `npm run verify:release`, not `scripts/release-verify.sh`, not a
// `package.json` script. Its only callers were a line in `CLAUDE.md` telling an
// assistant to run it by hand and a manual review skill. Six checks, 150 lines,
// executed when somebody remembered — which is the same "gate that cannot fail"
// this repository has found repeatedly (the since-removed `verify_agent_work`, the MCP tool count,
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

// The agent-facing docs, stated ONCE — livingDocs and the agent-docs gate
// both derive from this. A third doc added to only one site would silently
// skip the other's checks (the twice-copied list is this repo's recorded
// number-one defect class).
const AGENT_DOCS = ['llms-install.md', 'AGENTS.md'];

// --- 3. MCP tool count -------------------------------------------------------
// The registered tool NAMES, extracted once — the count check here and the
// agent-docs gate below both consume this set instead of re-running the
// regex with slightly different captures.
const toolNamesInCode = new Set(
  [...read('src/transports/mcp/handlers.ts').matchAll(/^ {4}name: '(\w+)'/gm)].map(m => m[1]),
);
const toolsInCode = toolNamesInCode.size;
const claimed = read('docs/api/API_REFERENCE.md').match(/MeMesh exposes (\d+) tools via MCP/);
if (toolsInCode < 1) fail('found no tools in handlers.ts — the pattern stopped matching');
else if (!claimed) fail('docs/api/API_REFERENCE.md no longer states how many tools MeMesh exposes');
else if (Number(claimed[1]) !== toolsInCode)
  fail(`handlers.ts registers ${toolsInCode} tools, API_REFERENCE.md says ${claimed[1]}`);
else ok(`registry and API_REFERENCE.md agree on ${toolsInCode} MCP tools`);

// --- 3b. Numbers in prose that restate code constants ------------------------
//
// C7 rule: a number in living prose either has a gate or gets deleted. These
// six were stated in README/docs with nothing checking them; each is now
// DERIVED from the constant it restates, with an anti-vacuity check on the
// extraction — an extractor that matched nothing is a broken gate, not a
// clean doc.
{
  // (a) ARCHITECTURE.md carries a second copy of the MCP tool count.
  const archTools = read('docs/ARCHITECTURE.md').match(/handlers\.ts[^\n]*?(\d+) tools/);
  if (!archTools) fail('docs/ARCHITECTURE.md no longer states the MCP tool count near handlers.ts');
  else if (Number(archTools[1]) !== toolsInCode)
    fail(`docs/ARCHITECTURE.md says ${archTools[1]} MCP tools, handlers.ts registers ${toolsInCode}`);
  else ok(`ARCHITECTURE.md agrees on ${toolsInCode} MCP tools`);

  // (a2) README.md's bold hook count and Memory-Tools heading. The
  // orchestration removal updated ARCHITECTURE/SKILL counts (gated above)
  // while the README's `**N hooks**` and `## All N Memory Tools` shipped
  // stale in all 11 locales — this audit checked every count EXCEPT the one
  // on the front page. English only: readme-parity covers structure, and the
  // translated counts are updated in the same commit as the English one.
  const readmeSrc = read('README.md');
  const readmeHooks = readmeSrc.match(/\*\*(\d+) hooks\*\*/);
  if (!readmeHooks) fail('README.md no longer states its `**N hooks**` count');
  else if (Number(readmeHooks[1]) !== manifestHooks.size)
    fail(`README.md says ${readmeHooks[1]} hooks, the manifest registers ${manifestHooks.size}`);
  else ok(`README.md hook count ${readmeHooks[1]}`);
  const readmeTools = readmeSrc.match(/## All (\d+) Memory Tools/);
  if (!readmeTools) fail('README.md no longer has the `## All N Memory Tools` heading');
  else if (Number(readmeTools[1]) !== toolsInCode)
    fail(`README.md says ${readmeTools[1]} memory tools, handlers.ts registers ${toolsInCode}`);
  else ok(`README.md memory-tool count ${readmeTools[1]}`);

  // (a3) ARCHITECTURE.md's top-level CLI command count. Stated for four
  // releases with nothing checking it; the orchestration removal shifted it
  // and the stale number shipped. Top-level = `program.command('name')` at
  // statement start (subcommands hang off configCmd/kgCmd/dreamCmd instead)
  // plus the three named group commands.
  const cliSrc = read('src/transports/cli/cli.ts');
  const topLevel = (cliSrc.match(/^program\s*\n\s*\.command\('/gm) ?? []).length
    + (cliSrc.match(/= program\.command\('/g) ?? []).length
    // group commands declared as `const xCmd = program\n  .command('x')`
    + (cliSrc.match(/= program\s*\n\s*\.command\('/g) ?? []).length;
  const archCli = read('docs/ARCHITECTURE.md').match(/(\d+) top-level commands/);
  if (topLevel < 10) fail(`CLI top-level command extraction matched only ${topLevel} — the pattern stopped matching`);
  else if (!archCli) fail('docs/ARCHITECTURE.md no longer states the top-level CLI command count');
  else if (Number(archCli[1]) !== topLevel)
    fail(`docs/ARCHITECTURE.md says ${archCli[1]} top-level commands, cli.ts registers ${topLevel}`);
  else ok(`ARCHITECTURE.md agrees on ${topLevel} top-level CLI commands`);

  // (a4) CODEMAP.md's backticked file references must exist. The dangling-
  // path check below only covers path-shaped references (with a `/`);
  // CODEMAP's hook table used bare backticked filenames, so a deleted hook
  // script stayed listed. Bare filenames are resolved against the two
  // directories CODEMAP catalogues this way.
  const codemap = read('CODEMAP.md');
  const bareFiles = [...codemap.matchAll(/`([\w-]+\.(?:js|ts|mjs|tsx))`/g)].map((m) => m[1]);
  if (bareFiles.length < 3) fail(`CODEMAP.md bare-filename extraction matched only ${bareFiles.length} — the pattern stopped matching`);
  else {
    const roots = ['scripts/hooks', 'src/core', 'src/transports/cli', 'src/transports/http', 'src/transports/mcp', 'src', 'scripts'];
    const missing = [...new Set(bareFiles)].filter(
      (f) => !roots.some((r) => fs.existsSync(path.join(repoRoot, r, f))),
    );
    if (missing.length) fail(`CODEMAP.md names ${missing.join(', ')}, which exist in none of the catalogued directories`);
    else ok(`${new Set(bareFiles).size} CODEMAP.md file references all exist`);
  }

  // (b) README's search-scoring weights vs DEFAULT_WEIGHTS.
  const scoring = read('src/core/scoring.ts');
  const w = {};
  for (const m of scoring.matchAll(/(searchRelevance|recency|frequency|confidence|impact):\s*0\.(\d+)/g)) {
    w[m[1]] = Number(`0.${m[2]}`);
  }
  if (Object.keys(w).length !== 5) {
    fail(`DEFAULT_WEIGHTS extraction found ${Object.keys(w).length}/5 weights — the pattern stopped matching scoring.ts`);
  } else {
    const pct = (k) => `${Math.round(w[k] * 100)}%`;
    const rankLine = read('README.md').split('\n').find(l => l.includes('Scored Ranking'));
    const want = `relevance (${pct('searchRelevance')}) + recency (${pct('recency')}) + frequency (${pct('frequency')}) + confidence (${pct('confidence')}) + recall impact (${pct('impact')})`;
    if (!rankLine) fail('README.md lost its Scored Ranking line');
    else if (!rankLine.includes(want)) fail(`README Scored Ranking weights drifted from DEFAULT_WEIGHTS: expected "${want}"`);
    else ok('README scoring weights match DEFAULT_WEIGHTS');

    // (c) ARCHITECTURE's session-start ratios are DERIVED (recency/frequency/
    // confidence renormalised); the old prose said 40/30/30 with confidence
    // first and matched no version of the code.
    const sub = w.recency + w.frequency + w.confidence;
    const r = Math.round((w.recency / sub) * 100);
    const fq = Math.round((w.frequency / sub) * 100);
    const cf = Math.round((w.confidence / sub) * 100);
    // Several lines mention the constant (module tree, transport notes);
    // the one under test is the line that states the ratios.
    const ssLines = read('docs/ARCHITECTURE.md').split('\n').filter(l => l.includes('SESSION_START_WEIGHT_RATIO'));
    const ssLine = ssLines.find(l => l.includes('Score ='));
    if (!ssLine) fail('docs/ARCHITECTURE.md no longer states the session-start score ratios next to SESSION_START_WEIGHT_RATIO');
    else if (!ssLine.includes(`recency (~${r}%)`) || !ssLine.includes(`frequency (${fq}%)`) || !ssLine.includes(`confidence (~${cf}%)`))
      fail(`ARCHITECTURE session-start ratios drifted: code derives recency ~${r}% / frequency ${fq}% / confidence ~${cf}%`);
    else ok('ARCHITECTURE session-start ratios match the derived constants');
  }

  // (d) API_REFERENCE's health-factor weights vs computeAnalytics.
  const factorWeights = [...read('src/core/analytics.ts').matchAll(/weight: (\d+)/g)].map(m => Number(m[1]));
  if (factorWeights.length !== 4) {
    fail(`health-factor weight extraction found ${factorWeights.length}/4 in analytics.ts — pattern rot`);
  } else {
    const apiRef = read('docs/api/API_REFERENCE.md');
    const labels = ['Activity', 'Quality', 'Freshness', 'Lessons'];
    const wrong = labels.filter((label, i) => !apiRef.includes(`${label} (${factorWeights[i]}%)`));
    if (wrong.length) fail(`API_REFERENCE health weights drifted for: ${wrong.join(', ')} (code says ${factorWeights.join('/')})`);
    else ok(`API_REFERENCE health-factor weights match analytics.ts (${factorWeights.join('/')})`);
  }

  // (e) README's "N tabs, M languages" vs the dashboard's actual registries.
  const tabsMatch = read('dashboard/src/App.tsx').match(/const TAB_KEYS = \[([^\]]+)\]/);
  const localeMatch = read('dashboard/src/lib/i18n.ts').match(/^type Locale = (.+);$/m);
  if (!tabsMatch || !localeMatch) {
    fail('TAB_KEYS or Locale extraction stopped matching — the tabs/languages gate is blind');
  } else {
    const tabs = tabsMatch[1].split(',').filter(t => t.trim()).length;
    const locales = localeMatch[1].split('|').length;
    const claim = `${tabs} tabs, ${locales} languages`;
    if (!read('README.md').includes(claim))
      fail(`README no longer says "${claim}" — the dashboard registries changed or the prose drifted`);
    else ok(`README dashboard claim matches: ${claim}`);
  }

  // (f) The intent hook's language count. The language markers are the
  // "// <Language>:" group comments inside INTENT_PATTERNS — the only
  // per-language anchor in the file. A pattern added without its language
  // comment would not be counted; that limitation is accepted and visible.
  const intent = read('scripts/hooks/user-prompt-intent.js');
  const block = intent.slice(intent.indexOf('INTENT_PATTERNS'), intent.indexOf('];'));
  const langs = new Set([...block.matchAll(/^\s*\/\/ ([A-Z][A-Za-z ]+?):/gm)].map(m => m[1]));
  if (langs.size === 0) {
    fail('intent-language extraction found zero language groups — pattern rot');
  } else {
    const bad = [];
    if (!read('README.md').includes(`(${langs.size} languages)`)) bad.push('README.md');
    if (!read('docs/ARCHITECTURE.md').includes(`(${langs.size} languages:`)) bad.push('docs/ARCHITECTURE.md');
    if (bad.length) fail(`intent-hook language count drifted (code has ${langs.size} groups): ${bad.join(', ')}`);
    else ok(`intent-hook language count (${langs.size}) matches README and ARCHITECTURE`);
  }
}

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
// Line-anchored on purpose and by limitation: a registration whose path sits
// on its own line (app.post followed by a newline before the path literal)
// would be invisible here. The floor below (< 20 fails) catches wholesale
// extraction rot but not one such route; if a multi-line registration ever
// appears, widen this rather than trusting it.
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
  ...AGENT_DOCS,
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

// --- disproven claims must stay dead in user-facing surfaces -----------------
// Release 4.2.11 proved the published "95.40% R@5" measured the benchmark's
// own reimplementation, not the product, and removed it from the docs — yet
// it survived in dashboard i18n copy for another two releases, in FIVE
// locales, because European locales write it "95,40" and no gate scanned
// UI strings. User-facing surfaces (dashboard catalogue + every README)
// may not state it as a current claim in any decimal convention.
// Historical explanations in docs/ARCHITECTURE.md, docs/plans/ and source
// comments are exempt: they describe the figure as disproven.
const BANNED_CLAIMS = [/95[.,]\s?40\s?%?\s?R@5/i, /95[.,]40/];
const userFacing = [
  'dashboard/src/lib/i18n.ts',
  ...[...tracked].filter(f => /^README(\.[a-zA-Z-]+)?\.md$/.test(f)),
].filter(isTracked);
const banned = [];
for (const f of userFacing) {
  const text = read(f);
  for (const re of BANNED_CLAIMS) {
    const m = text.match(re);
    if (m) { banned.push(`${f} → "${m[0]}"`); break; }
  }
}
if (banned.length) fail(`disproven benchmark claim resurfaced in user-facing copy:\n      ${banned.join('\n      ')}`);
else ok(`${userFacing.length} user-facing surfaces free of the disproven 95.40% claim`);

// --- documented response shapes match the types the code returns -------------
// This gate counted things — hooks, tools, routes, weights — and checked no
// SHAPE, so `learn`'s documented response (`stored`, `entityId`,
// `observations`, `tags`) survived years of the function returning
// `{learned, name, type}`. A caller writing against the document got
// `undefined` from every field it named.
//
// Source of truth is the `*Result` interface in src/core/types.ts. The
// comparison is on top-level keys only: types and nesting are the compiler's
// job, and a key that does not exist is the failure that was actually shipped.
const typesSrc = read('src/core/types.ts');
const apiRefSrc = read('docs/api/API_REFERENCE.md');

/** Field names of `export interface <name> { … }`, top level only. */
function interfaceKeys(name) {
  const start = typesSrc.indexOf(`export interface ${name} {`);
  if (start === -1) return null;
  let depth = 0, i = typesSrc.indexOf('{', start);
  const open = i;
  for (; i < typesSrc.length; i++) {
    if (typesSrc[i] === '{') depth++;
    else if (typesSrc[i] === '}' && --depth === 0) break;
  }
  const body = typesSrc.slice(open + 1, i);
  const keys = new Set();
  let nest = 0;
  for (const line of body.split('\n')) {
    const bare = line.replace(/\/\/.*$/, '');
    const m = nest === 0 && /^\s*([A-Za-z_][\w]*)\??\s*:/.exec(bare);
    if (m) keys.add(m[1]);
    nest += (bare.match(/{/g) ?? []).length - (bare.match(/}/g) ?? []).length;
  }
  return keys;
}

/** The first ```json block after `### <tool>`'s `**Response**:` heading. */
function documentedResponseKeys(tool) {
  const section = apiRefSrc.indexOf(`\n### ${tool}\n`);
  if (section === -1) return null;
  const respAt = apiRefSrc.indexOf('**Response**', section);
  if (respAt === -1) return null;
  const fence = apiRefSrc.indexOf('```json', respAt);
  if (fence === -1) return null;
  const end = apiRefSrc.indexOf('```', fence + 7);
  const block = apiRefSrc.slice(fence + 7, end);
  try {
    const parsed = JSON.parse(block);
    return new Set(Object.keys(parsed));
  } catch {
    return null;
  }
}

// Only tools whose handler returns the interface directly. `recall` wraps its
// payload and `export` is the bundle itself, so neither is a key-for-key match.
const RESPONSE_SHAPES = [
  ['remember', 'RememberResult'],
  ['learn', 'LearnResult'],
  ['import', 'ImportResult'],
];
const shapeProblems = [];
let shapesChecked = 0;
for (const [tool, iface] of RESPONSE_SHAPES) {
  const actual = interfaceKeys(iface);
  const documented = documentedResponseKeys(tool);
  if (!actual) { shapeProblems.push(`${iface} is gone from src/core/types.ts — this check is now blind to ${tool}`); continue; }
  if (!documented) { shapeProblems.push(`API_REFERENCE has no parseable Response block for \`${tool}\``); continue; }
  shapesChecked++;
  const invented = [...documented].filter(k => !actual.has(k));
  if (invented.length) {
    shapeProblems.push(`\`${tool}\` response documents ${invented.map(k => `"${k}"`).join(', ')}, which ${iface} does not return`);
  }
}
if (shapeProblems.length) fail(`documented response shapes do not match the code:\n      ${shapeProblems.join('\n      ')}`);
else ok(`${shapesChecked} documented MCP response shapes match their Result types`);

// --- the auth that exists is documented --------------------------------------
// API_REFERENCE said "MeMesh does not add an auth layer for you" while
// server.ts generated a bearer token before listening on a non-loopback bind
// and rejected every unauthenticated /v1 request. A reader following the
// document would have built their own layer on top of one they were told was
// absent — or, worse, believed the server was open and treated it as such.
const serverSrc = read('src/transports/http/server.ts');
const hasBearerAuth = /Authorization/.test(serverSrc) && /remote-token/.test(serverSrc);
if (!hasBearerAuth) {
  fail('server.ts no longer looks like it does bearer auth — re-check what API_REFERENCE promises about authentication');
} else {
  const missing = [
    ['the Bearer header', /Authorization: Bearer/],
    ['the token file path', /remote-token/],
    ['the env override', /MEMESH_REMOTE_TOKEN/],
  ].filter(([, re]) => !re.test(apiRefSrc)).map(([what]) => what);
  const denies = /does not add an auth layer/i.test(apiRefSrc);
  if (denies) fail('API_REFERENCE still says MeMesh adds no auth layer; server.ts requires a bearer token on remote binds');
  else if (missing.length) fail(`API_REFERENCE documents remote binds without ${missing.join(', ')}`);
  else ok('remote-bind bearer auth is documented where it is implemented');
}

// --- agent-facing docs name only commands and tools that exist ---------------
// llms-install.md is EXECUTED by an AI agent, not skimmed by a human who would
// notice a typo'd subcommand — a wrong `memesh <word>` walks the agent into
// "unknown command" mid-install. Likewise AGENTS.md's tool table: a name
// absent from TOOL_DEFINITIONS is an instruction to call a tool that does not
// exist. Both sides are derived: commands from cli.ts registrations, tools
// from handlers.ts.
{
  const agentDocs = AGENT_DOCS.filter(d => {
    if (fs.existsSync(path.join(repoRoot, d))) return true;
    fail(`${d} is gone — the agent-docs gate has nothing to check`);
    return false;
  });

  const cliSrc = read('src/transports/cli/cli.ts');
  const cliCommands = new Set([...cliSrc.matchAll(/\.command\('([\w-]+)/g)].map(m => m[1]));
  // pin/unpin register through a helper whose `.command(name)` is dynamic;
  // their literal names are in the registerPinCommand calls.
  for (const m of cliSrc.matchAll(/registerPinCommand\('([\w-]+)'/g)) cliCommands.add(m[1]);
  const toolNames = toolNamesInCode;
  if (cliCommands.size < 10) fail(`CLI command extraction matched only ${cliCommands.size} — the pattern stopped matching cli.ts`);
  if (toolNames.size < 1) fail('MCP tool-name extraction matched nothing in handlers.ts');

  // (a) every `memesh <subcommand>` mention resolves to a registered command.
  // The lookbehind keeps `@pcircle/memesh`, `memesh-mcp` and `pcircle-memesh`
  // out; a capture starting with "memesh" is a bin name passed as an argument
  // (`codex mcp add memesh -- memesh-mcp`), not a subcommand.
  let mentions = 0;
  const badCommands = [];
  for (const doc of agentDocs) {
    for (const m of read(doc).matchAll(/(?<![\w/@.-])memesh ([a-z][a-z-]*)/g)) {
      if (m[1].startsWith('memesh')) continue;
      mentions++;
      if (!cliCommands.has(m[1])) badCommands.push(`${doc} → \`memesh ${m[1]}\``);
    }
  }
  if (agentDocs.length && mentions === 0) fail('found no `memesh <subcommand>` mentions in the agent docs — the extraction stopped matching');
  else if (badCommands.length) fail(`agent docs name CLI subcommands that do not exist:\n      ${badCommands.join('\n      ')}`);
  else if (agentDocs.length) ok(`${mentions} \`memesh <subcommand>\` mentions in agent docs all resolve to registered CLI commands`);

  // (a2) every CLI flag an option table documents is a flag cli.ts registers.
  //
  // The missing direction. A sibling test already scans SOURCE files so no
  // stderr message can recommend a flag the CLI would reject — it caught two
  // real ones the day it was added. Nothing looked the other way, so an option
  // table left listing a removed flag passed this gate silently, which is
  // exactly what happened to `--vectors`: retired from the parser while three
  // documents and two runtime messages still told people to run it.
  //
  // Doc → code only. The reverse would flag every deliberately undocumented
  // flag, which is a different decision and not one a gate should make.
  const registeredFlags = new Set(
    [...cliSrc.matchAll(/\.option\(\s*'(--[a-z][a-z0-9-]*)/g)].map(m => m[1]),
  );
  if (registeredFlags.size < 10) {
    fail(`CLI option extraction matched only ${registeredFlags.size} — the pattern stopped matching cli.ts`);
  }
  // The retired `--vectors` is registered via `.addOption(new Option(...))`
  // purely so it can be refused with a real message; the `.option(` pattern
  // above therefore does not see it, and a doc re-documenting it still fails.
  // That is correct — but it was accidental. Pin it, so normalising
  // `.addOption` to `.option` later cannot silently re-admit the flag.
  if (registeredFlags.has('--vectors')) {
    fail('`--vectors` is registered as a live option again — it was retired and must stay refused');
  }
  const documentedFlags = new Map();   // flag → first doc:line that names it
  for (const doc of ['docs/api/API_REFERENCE.md']) {
    read(doc).split('\n').forEach((line, i) => {
      const m = line.match(/^\|\s*`(--[a-z][a-z0-9-]*)/);
      if (m && !documentedFlags.has(m[1])) documentedFlags.set(m[1], `${doc}:${i + 1}`);
    });
  }
  if (documentedFlags.size < 10) {
    fail(`option-table extraction matched only ${documentedFlags.size} flags — the table format changed`);
  }
  const ghostFlags = [...documentedFlags]
    .filter(([flag]) => !registeredFlags.has(flag))
    .map(([flag, where]) => `${where} → \`${flag}\``);
  if (ghostFlags.length) {
    fail(`docs document CLI flags that cli.ts does not register:\n      ${ghostFlags.join('\n      ')}`);
  } else {
    ok(`${documentedFlags.size} documented CLI flags all resolve to registered options`);
  }

  // (b) any "`x` tool" phrase names a registered MCP tool.
  const badTools = [];
  for (const doc of agentDocs) {
    for (const m of read(doc).matchAll(/`(\w+)` (?:MCP )?tool\b/g)) {
      if (!toolNames.has(m[1])) badTools.push(`${doc} → \`${m[1]}\``);
    }
  }
  if (badTools.length) fail(`agent docs call these MCP tools, which TOOL_DEFINITIONS does not register:\n      ${badTools.join('\n      ')}`);
  else if (agentDocs.length) ok('every `<name>` tool phrase in agent docs names a registered MCP tool');

  if (agentDocs.includes('AGENTS.md')) {
    const agentsSrc = read('AGENTS.md');
    // (c) the tool table lists exactly the registered tools — both directions.
    const table = agentsSrc.match(/^\| Tool \| Purpose \|\n\|[-| ]+\|\n((?:\|.*\n)+)/m);
    if (!table) {
      fail('AGENTS.md no longer has a `| Tool | Purpose |` table');
    } else {
      const listed = [...table[1].matchAll(/^\| `(\w+)`/gm)].map(m => m[1]);
      const unknown = listed.filter(t => !toolNames.has(t));
      const absent = [...toolNames].filter(t => !listed.includes(t));
      if (unknown.length) fail(`AGENTS.md tool table lists ${unknown.join(', ')}, which TOOL_DEFINITIONS does not register`);
      if (absent.length) fail(`AGENTS.md tool table is missing ${absent.join(', ')}`);
      if (!unknown.length && !absent.length) ok(`AGENTS.md tool table matches all ${toolNames.size} registered MCP tools`);
    }
    // (d) the stated tool count is derived, like every other count here.
    const counted = agentsSrc.match(/All (\d+) MCP tools/);
    if (!counted) fail('AGENTS.md no longer states `All N MCP tools`');
    else if (Number(counted[1]) !== toolNames.size) fail(`AGENTS.md says ${counted[1]} MCP tools, handlers.ts registers ${toolNames.size}`);
    else ok(`AGENTS.md tool count ${counted[1]}`);
  }

  // (e) the Node floor llms-install.md tells the agent to check against is
  // the one package.json enforces.
  if (agentDocs.includes('llms-install.md')) {
    const nodeFloor = (pkg.engines?.node ?? '').match(/(\d+\.\d+\.\d+)/)?.[1];
    if (!nodeFloor) fail('package.json engines.node no longer states a version floor');
    else if (!read('llms-install.md').includes(nodeFloor)) fail(`llms-install.md does not state the Node floor ${nodeFloor} from package.json engines`);
    else ok(`llms-install.md Node floor matches engines (${nodeFloor})`);
  }
}

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
