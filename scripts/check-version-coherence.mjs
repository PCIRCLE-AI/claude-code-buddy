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
//   3. .claude-plugin/marketplace.json plugins[].version
//   4. CHANGELOG.md — must contain a `## [X.Y.Z] — YYYY-MM-DD` section
//      matching package.json version
//   5. docs/ARCHITECTURE.md — `**Version**: X.Y.Z`
//   6. docs/api/API_REFERENCE.md — `**Version**: X.Y.Z`
//
// Exits 0 if all sources agree. Exits 1 with a per-source report on
// any disagreement.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Windows note: `new URL(import.meta.url).pathname` returns a leading-slash
// drive path on Windows (e.g. "/D:/..."), which `path.resolve` then
// concatenates with the cwd drive into a doubled "D:\D:\..." path.
// `fileURLToPath` does the OS-correct conversion. Same family of issue
// as `pathToFileURL` for the inverse direction.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const findings = [];

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

const marketplace = readJson('.claude-plugin/marketplace.json');
const marketplaceVersions = (marketplace.plugins ?? []).map(p => p.version).filter(Boolean);
findings.push(`.claude-plugin/marketplace.json plugins[].version: [${marketplaceVersions.join(', ')}]`);
for (const v of marketplaceVersions) {
  if (v !== pkgVersion) {
    errors.push(`.claude-plugin/marketplace.json plugins[].version (${v}) !== package.json (${pkgVersion})`);
  }
}

// CHANGELOG must have a section header matching the current version
const changelog = read('CHANGELOG.md');
const headerRe = new RegExp(`^## \\[${pkgVersion.replace(/\./g, '\\.')}\\][\\s—-]`, 'm');
const changelogMatch = headerRe.test(changelog);
findings.push(`CHANGELOG.md has [${pkgVersion}] section: ${changelogMatch ? 'YES' : 'NO'}`);
if (!changelogMatch) {
  // Allow [Unreleased] for in-flight feature branches; reject only on main / release branches
  const unreleasedRe = /^## \[Unreleased\]/m;
  if (unreleasedRe.test(changelog)) {
    findings.push(`  (CHANGELOG.md has [Unreleased] section — acceptable for feature branches; bump before release)`);
  } else {
    errors.push(`CHANGELOG.md has neither [${pkgVersion}] nor [Unreleased] section header`);
  }
}

// ARCHITECTURE / API_REFERENCE version stamps
for (const docPath of ['docs/ARCHITECTURE.md', 'docs/api/API_REFERENCE.md']) {
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
