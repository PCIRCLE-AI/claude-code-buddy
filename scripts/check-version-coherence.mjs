#!/usr/bin/env node

// Version coherence check. Run from CI + local pre-release.
//
// Verifies that the version numbers and CHANGELOG section in the
// canonical sources all agree before a build / release. The motivating
// failure: a partial version bump (package.json + plugin.json updated
// but not marketplace.json or CHANGELOG header) produces a build that
// SHIPS with stale doc / manifest, which surfaces as
// `Skills + hooks integrity FAIL` for users post-install.
//
// Sources audited:
//   1. package.json `version`
//   2. .claude-plugin/plugin.json `version`
//   3. .codex-plugin/plugin.json `version`
//   4. .claude-plugin/marketplace.json plugins[].version
//   5. CHANGELOG.md — must contain a `## [X.Y.Z] — YYYY-MM-DD` section
//      matching package.json version
//   6. docs/ARCHITECTURE.md — `**Version**: X.Y.Z`
//   7. docs/api/API_REFERENCE.md — `**Version**: X.Y.Z`
//   8. herdr-plugin.toml `version` — the Herdr marketplace manifest
//
// Exits 0 if all sources agree. Exits 1 with a per-source report on
// any disagreement.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { checkMainDeclaresPublishedVersion } from './lib/published-version.mjs';

// Windows note: `new URL(import.meta.url).pathname` returns a leading-slash
// drive path on Windows (e.g. "/D:/..."), which `path.resolve` then
// concatenates with the cwd drive into a doubled "D:\D:\..." path.
// `fileURLToPath` does the OS-correct conversion. Same family of issue
// as `pathToFileURL` for the inverse direction.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const findings = [];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function read(p) {
  return fs.readFileSync(path.join(repoRoot, p), 'utf8');
}

function readJson(p) {
  return JSON.parse(read(p));
}

const pkgVersion = readJson('package.json').version;
findings.push(`package.json: ${pkgVersion}`);

const pluginVersion = readJson('.claude-plugin/plugin.json').version;
findings.push(`.claude-plugin/plugin.json: ${pluginVersion}`);
if (pluginVersion !== pkgVersion) {
  errors.push(`.claude-plugin/plugin.json (${pluginVersion}) !== package.json (${pkgVersion})`);
}

const codexPluginVersion = readJson('.codex-plugin/plugin.json').version;
findings.push(`.codex-plugin/plugin.json: ${codexPluginVersion}`);
if (codexPluginVersion !== pkgVersion) {
  errors.push(`.codex-plugin/plugin.json (${codexPluginVersion}) !== package.json (${pkgVersion})`);
}

// package-lock.json carries the version TWICE and both must agree.
//
// `CONTRIBUTING.md` names these as required anchors and records that they "silently
// drifted from 4.2.6 through 4.2.10" — five releases — which is exactly what a
// coherence gate exists to stop, and this gate did not read the file. `npm ci`
// does not compensate: measured with package.json at 2.0.0 against a lockfile
// self-describing 1.0.0, `npm ci` reported "up to date" and exited 0.
//
// The lockfile is not in `files`, so no consumer sees it. This is repo and
// provenance integrity: the tagged commit should not self-describe a version it
// is not.
const lock = readJson('package-lock.json');
const lockVersions = [
  ['package-lock.json version', lock.version],
  ['package-lock.json packages[""].version', lock.packages?.['']?.version],
];
for (const [label, value] of lockVersions) {
  findings.push(`${label}: ${value ?? '(absent)'}`);
  if (value === undefined) {
    errors.push(`${label} is missing — the lockfile is malformed`);
  } else if (value !== pkgVersion) {
    errors.push(`${label} (${value}) !== package.json (${pkgVersion})`);
  }
}

const marketplace = readJson('.claude-plugin/marketplace.json');
const marketplaceVersions = (marketplace.plugins ?? []).map(p => p.version).filter(Boolean);
findings.push(`.claude-plugin/marketplace.json plugins[].version: [${marketplaceVersions.join(', ')}]`);
// An empty list must FAIL, not pass by iterating nothing. `filter(Boolean)`
// turns both "no plugins array" and "a plugin entry lost its version" into [],
// and `for (const v of [])` never runs — so a bad merge that drops the version
// key reports "All version sources agree" while the unversioned
// marketplace.json ships inside the tarball to plugin-marketplace users.
// Same guard shape as scripts/lib/executable-targets.mjs, which throws on an
// empty derivation rather than checking nothing.
if (marketplaceVersions.length === 0) {
  errors.push(
    '.claude-plugin/marketplace.json yielded no plugins[].version at all — ' +
      'the file is malformed or an entry lost its version key'
  );
}
for (const v of marketplaceVersions) {
  if (v !== pkgVersion) {
    errors.push(`.claude-plugin/marketplace.json plugins[].version (${v}) !== package.json (${pkgVersion})`);
  }
}

// CHANGELOG must have a section header matching the current version
const changelog = read('CHANGELOG.md');
const headerRe = new RegExp(`^## \\[${escapeRegex(pkgVersion)}\\][\\s—-]`, 'm');
const changelogMatch = headerRe.test(changelog);
findings.push(`CHANGELOG.md has [${pkgVersion}] section: ${changelogMatch ? 'YES' : 'NO'}`);
if (!changelogMatch) {
  // Allow [Unreleased] for in-flight feature branches; reject on a release run.
  //
  // The comment always said "reject only on main / release branches" and the
  // code never looked at anything — no branch, no tag, no env. CHANGELOG.md
  // carries a permanent `## [Unreleased]` header, so this branch of the gate
  // could never fail: bump every version anchor, forget the `## [X.Y.Z]`
  // header, and the release publishes with no changelog entry while the gate
  // prints "All version sources agree". The one source it is least able to
  // verify by other means was the one it silently waived.
  //
  // Release-ness is INFERRED from three independent signals, not read from one
  // env var somebody has to remember to set.
  //
  // The first version of this branch tested `MEMESH_RELEASE === '1'` alone,
  // with a comment asserting "MEMESH_RELEASE=1 is set by the publish workflow".
  // Nothing set it — not the workflow, not `prepublishOnly`, not a test. So the
  // branch was unreachable and the anchor stayed silently waived on the publish
  // path, which is the exact defect it was added to close: a gate that reports
  // success because its own trigger never fires.
  //
  //   npm_command === 'publish'      — npm sets this for the whole `npm publish`
  //                                    run, so `prepublishOnly` is covered on any
  //                                    platform without shell env-var syntax.
  //   GITHUB_EVENT_NAME === 'release' — a release-triggered workflow run.
  //   MEMESH_RELEASE === '1'          — explicit override, and what the publish
  //                                    workflow now sets so the intent is legible
  //                                    at the call site too.
  const unreleasedRe = /^## \[Unreleased\]/m;
  const isReleaseRun =
    process.env.MEMESH_RELEASE === '1' ||
    process.env.npm_command === 'publish' ||
    process.env.GITHUB_EVENT_NAME === 'release';
  if (unreleasedRe.test(changelog) && !isReleaseRun) {
    findings.push(`  (CHANGELOG.md has [Unreleased] section — acceptable for feature branches; bump before release)`);
  } else if (unreleasedRe.test(changelog) && isReleaseRun) {
    errors.push(
      `CHANGELOG.md has no [${pkgVersion}] section — [Unreleased] is not acceptable on a release run`
    );
  } else {
    errors.push(`CHANGELOG.md has neither [${pkgVersion}] nor [Unreleased] section header`);
  }
}

// Living architecture/navigation documents are release anchors too. CODEMAP
// stayed at 4.2.8 through the 4.8.1 release because it was absent from this
// list while its entry points and hook map kept changing.
for (const docPath of ['CODEMAP.md', 'docs/ARCHITECTURE.md', 'docs/api/API_REFERENCE.md']) {
  const content = read(docPath);
  const m = content.match(/\*\*Version\*\*:\s*([0-9]+\.[0-9]+\.[0-9]+)/);
  if (!m) {
    findings.push(`${docPath}: no \`**Version**: X.Y.Z\` line found`);
    errors.push(`${docPath} is missing the \`**Version**: X.Y.Z\` stamp`);
  } else {
    findings.push(`${docPath} **Version**: ${m[1]}`);
    if (m[1] !== pkgVersion) {
      errors.push(`${docPath} (${m[1]}) !== package.json (${pkgVersion})`);
    }
  }
}

// Herdr plugin manifest.
//
// A version string that nothing checks is a version string that drifts —
// package-lock.json proved it by sitting four releases behind. This manifest
// declares its own `version` because the Herdr spec requires one, so it joins
// the anchors rather than becoming the ninth place to forget.
{
  const manifestPath = 'herdr-plugin.toml';
  if (fs.existsSync(path.join(repoRoot, manifestPath))) {
    const content = read(manifestPath);
    // Deliberately anchored to the start of a line: `min_herdr_version` also
    // ends in `version` and must not be mistaken for this one.
    const m = content.match(/^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/m);
    if (!m) {
      findings.push(`${manifestPath}: no top-level \`version = "X.Y.Z"\` found`);
      errors.push(`${manifestPath} is missing its \`version\` field`);
    } else {
      findings.push(`${manifestPath} version: ${m[1]}`);
      if (m[1] !== pkgVersion) {
        errors.push(`${manifestPath} (${m[1]}) !== package.json (${pkgVersion})`);
      }
    }
  }
}

// --- `main` must not declare a version nobody can install ---
//
// Every check above asks "do these seven files agree with each other?", which
// they did throughout the five days `main` claimed a 4.2.11 that npm did not
// have. Agreement among the anchors says nothing about whether the version they
// agree on was ever released. See scripts/lib/published-version.mjs.
function gitLines(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// GITHUB_REF_NAME is `main` on a push to main and `<n>/merge` on a pull
// request, so a release PR — which legitimately carries the bump before the tag
// exists — is skipped by the same rule that catches a merged one.
const branch =
  process.env.GITHUB_REF_NAME ?? (gitLines(['rev-parse', '--abbrev-ref', 'HEAD']) ?? [null])[0];
// Set only by `finish-release.mjs` around its own internal `qa:pre-release`
// spawn — the one caller genuinely seconds from creating this exact tag, not
// CI, not a PR check, not a plain manual run. See published-version.mjs.
const publishedTag = checkMainDeclaresPublishedVersion({
  branch,
  pkgVersion,
  tags: gitLines(['tag', '--list', 'v*']) ?? [],
  aboutToTagThisVersion: process.env.MEMESH_FINISH_RELEASE_TAGGING === '1',
});
findings.push(`main-declares-published-version: ${publishedTag.status} — ${publishedTag.message}`);
if (publishedTag.status === 'error') {
  errors.push(publishedTag.message);
}

console.log('Version coherence audit:');
for (const f of findings) console.log('  ' + f);

if (errors.length === 0) {
  console.log('\n✓ All version sources agree.');
  process.exit(0);
}

console.error('\n✗ Version coherence FAILED:');
for (const e of errors) console.error('  - ' + e);
console.error('\nFix: bump every source above to match `package.json`, then re-run `npm run build` to regenerate `dist/skills-manifest.json`.');
process.exit(1);
