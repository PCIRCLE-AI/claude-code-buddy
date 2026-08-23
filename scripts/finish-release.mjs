#!/usr/bin/env node

// Finish a release in one operation: tag, GitHub Release, npm publish.
//
//   node scripts/finish-release.mjs --dry-run    # what it would do, and why it would refuse
//   npm run release:finish
//
// WHY THIS IS ONE COMMAND
//
// Merging the release PR bumps `main` to a version nobody can install yet.
// `scripts/lib/published-version.mjs` makes that state loud — `verify:release`
// on main FAILS with "main declares X and no vX tag exists" — and that failure
// is the guard working, not a bug to investigate. But the guard only shouts;
// it cannot shorten the window. Closing it was three hand-typed commands, and
// v4.2.11 spent five days between the first and the last.
//
// So the remedy stops being prose in an error message and becomes this. It
// either refuses with every reason listed, or it finishes.
//
// ONE API CALL, NOT THREE COMMANDS
//
// `gh release create` creates the tag itself from `--target`. That matters
// beyond convenience: `git tag` + `git push origin <tag>` + `gh release create`
// has a failure mode that is WORSE than the one being fixed — a pushed tag
// with no release publishes nothing (publish-npm.yml fires on
// `release: published`; a bare tag push does not trigger it), while
// `verify:release` now sees the tag and reports ok. Main would look released
// and npm would not have it, with no gate left looking. One call cannot land
// half way: either the release and its tag both exist, or neither does.
//
// The tag it creates is LIGHTWEIGHT, where `git tag -a` produced an annotated
// one for some past releases (the repo has both: v4.5.0 and v4.6.1 annotated,
// v4.5.1 and v4.6.0 not). Nothing here reads the difference — no `git describe`
// exists in this repository, and `git tag --list`, `git ls-remote --tags` and
// `fetch-tags: true` treat both alike. The repository's tag ruleset does not
// object either: "Protect release and benchmark tags" covers `refs/tags/v*`
// with `deletion` and `non_fast_forward` rules only, so creating a new tag is
// not what it blocks.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkReleasePreconditions,
  extractChangelogSection,
} from './lib/release-preconditions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
let dryRun = false;
let notesFile = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--notes-file') {
    notesFile = args[++i];
    if (!notesFile) {
      console.error('--notes-file needs a path');
      process.exit(1);
    }
  }
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node scripts/finish-release.mjs [--dry-run] [--notes-file <path>]');
    process.exit(0);
  } else {
    console.error(`unknown flag: ${a}`);
    process.exit(1);
  }
}

/** Run a command and return trimmed stdout, or null if it failed for any reason. */
function capture(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function captureLines(cmd, cmdArgs) {
  const out = capture(cmd, cmdArgs);
  if (out === null) return null;
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const tag = `v${pkgVersion}`;

// --- gather, read-only ------------------------------------------------------
//
// Remote state comes from `git ls-remote`, not from a `git fetch`: nothing
// should mutate this checkout before the preconditions have passed.

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const statusOut = capture('git', ['status', '--porcelain']);
const isClean = statusOut === null ? null : statusOut === '';
const headSha = capture('git', ['rev-parse', 'HEAD']);

const remoteMainLine = capture('git', ['ls-remote', 'origin', 'refs/heads/main']);
const remoteHeadSha = remoteMainLine ? remoteMainLine.split(/\s+/)[0] : null;

const localTags = captureLines('git', ['tag', '--list', 'v*']);
const remoteTagLines = captureLines('git', ['ls-remote', '--tags', 'origin']);
const remoteTags =
  remoteTagLines === null
    ? null
    : remoteTagLines
        .map(l => l.split(/\s+/)[1] ?? '')
        // `refs/tags/v4.6.1^{}` is the annotated tag's dereferenced commit —
        // the same tag listed twice. Strip the suffix; the duplicate is
        // harmless to both questions asked of this list (is it empty, does it
        // contain the tag), so it is not worth deduplicating.
        .map(r => r.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''))
        .filter(r => r.startsWith('v'));

// Naming the repo proves `gh` exists, is authenticated, and can reach it —
// the three things that must be true before anything is created.
const repoSlug = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);

let notes = null;
if (notesFile) {
  try {
    notes = fs.readFileSync(path.resolve(repoRoot, notesFile), 'utf8');
  } catch (e) {
    console.error(`✗ --notes-file ${notesFile}: ${e.message}`);
    process.exit(1);
  }
} else {
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  notes = extractChangelogSection(changelog, pkgVersion);
}

// --- decide -----------------------------------------------------------------

const { ok, blockers } = checkReleasePreconditions({
  branch,
  isClean,
  headSha,
  remoteHeadSha,
  pkgVersion,
  localTags,
  remoteTags,
  repoSlug,
  notes,
});

console.log(`finish-release: ${tag}`);
console.log(`  repo:        ${repoSlug ?? '(gh could not say)'}`);
console.log(`  branch:      ${branch ?? '(undiscoverable)'}`);
console.log(`  commit:      ${headSha ? headSha.slice(0, 8) : '(unknown)'}`);
console.log(`  notes:       ${notesFile ?? `CHANGELOG.md [${pkgVersion}]`} (${notes ? notes.length : 0} chars)`);

// Print the head of the body BEFORE acting, in both paths. The default source
// is the CHANGELOG section, which for 4.6.1 was 26,355 characters — while the
// bodies actually published for 4.6.1 and 4.6.0 were 2,790 and 1,949 characters
// of curated highlights, passed with `--notes-file`. Both are legitimate; which
// one is about to become
// public should not be a surprise, and after the call it is too late to look.
if (notes) {
  const head = notes.trim().split('\n').slice(0, 6);
  for (const line of head) console.log(`    │ ${line.slice(0, 100)}`);
  if (notes.trim().split('\n').length > 6) console.log('    │ …');
}

if (!ok) {
  console.error(`\n✗ refusing to cut ${tag}:`);
  for (const b of blockers) console.error(`  - ${b}`);
  process.exit(1);
}

if (dryRun) {
  console.log(`\n✓ preconditions pass. Would run:`);
  console.log(`    gh release create ${tag} --target ${headSha} --title ${tag} --notes-file <changelog section>`);
  console.log(`  …which creates the tag, publishes the release, and triggers publish-npm.yml.`);
  process.exit(0);
}

// --- act --------------------------------------------------------------------

const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-release-'));
const notesPath = path.join(notesDir, 'notes.md');
fs.writeFileSync(notesPath, notes, 'utf8');

let releaseUrl;
try {
  releaseUrl = execFileSync(
    'gh',
    ['release', 'create', tag, '--target', headSha, '--title', tag, '--notes-file', notesPath],
    { cwd: repoRoot, encoding: 'utf8' }
  ).trim();
} catch (e) {
  // "gh failed" is not evidence that nothing happened. The release is one
  // `POST /repos/{owner}/{repo}/releases`, and gh can fail AFTER that POST
  // succeeded — a read timeout on the response, a 502 on the way back. Then
  // the tag, the release and the publish run all exist while this printed
  // "nothing was tagged", the operator retries, and the retry refuses with
  // "already exists". Two contradictory messages and no way to tell which
  // lied. Ask GitHub what is actually there instead of asserting it.
  console.error(`\n✗ gh release create failed:`);
  console.error(String(e.stderr || e.message).trim());
  const created = capture('gh', ['release', 'view', tag, '--json', 'url', '-q', '.url']);
  console.error(
    created
      ? `\n  BUT ${tag} EXISTS: ${created}\n  The call failed on the way back, not on the way in — the publish may ` +
          `already be running. Check it before doing anything else; do not re-cut.`
      : `\n  ${tag} does not exist — nothing was tagged, nothing was published. Safe to re-run.`
  );
  process.exit(1);
} finally {
  fs.rmSync(notesDir, { recursive: true, force: true });
}

console.log(`\n✓ released: ${releaseUrl}`);

// Bring the tag into this checkout so `verify:release` here stops failing —
// the check reads `git tag --list`, and until the tag is fetched, main still
// looks like it declares an untagged version.
//
// ONE tag, by explicit refspec, not `--tags`. The wide form asks for every tag
// the remote has and fails if ANY of them cannot be written, so one unrelated
// divergence anywhere in the repository's history turns this step red.
//
// This repository has 26 of them. Measured 2026-08-23 across all 73 tags: 26
// refs disagree with origin — the 25 version tags from v2.10.1 through v4.1.7,
// plus `benchmark/longmemeval-public-r1` — while everything from v4.2.0 onward
// agrees. The cause is a history rewrite that removed internal documents:
// origin's v4.1.7 tree lacks four files the local v4.1.7 tree still carries.
// (Their names are deliberately not repeated here — putting them back into a
// public file would undo part of what the rewrite was for.) Those old refs are
// not going to converge, so `--tags` fails here on every release — right after
// writing the new tag it was actually asked for. Measured on v4.6.2, same
// checkout: `--tags` exited 1 with 26 rejections, while
// `refs/tags/v4.6.2:refs/tags/v4.6.2` exited 0.
//
// Not `--tags --force` either: that would silently rewrite 26 local refs as a
// side effect of cutting a release. A warning that always fires is a warning
// nobody reads; the fix is to stop asking a wider question than we need.
const fetchSpec = `refs/tags/${tag}:refs/tags/${tag}`;
if (capture('git', ['fetch', 'origin', fetchSpec]) === null) {
  console.log(`  (could not \`git fetch origin ${fetchSpec}\` — run it to sync this checkout)`);
}
const nowTagged = (captureLines('git', ['tag', '--list', 'v*']) ?? []).includes(tag);
console.log(
  `  local checkout has ${tag}: ${nowTagged ? 'yes' : `no — run \`git fetch origin ${fetchSpec}\``}`
);

// Where to look next. The publish is a workflow run, and npm's registry lags
// that run by minutes: `npm view` answering with the OLD version right after a
// green publish is the registry catching up, not a failed publish. A following
// `npm install` failing with ETARGET is npm's LOCAL metadata cache —
// `--prefer-online` gets past it. Both looked like a silent failure once.
//
// Filtered by `headBranch`, which for a `release` event is the tag name. A bare
// `--limit 1` would print the PREVIOUS release's run for the seconds before
// this one registers — a URL that resolves, looks right, and is about a
// different release.
const runUrl = capture('gh', [
  'run', 'list', '--workflow', 'publish-npm.yml', '--limit', '10',
  '--json', 'url,headBranch',
  '-q', `[.[] | select(.headBranch == "${tag}")][0].url`,
]);
console.log(
  runUrl
    ? `\n  publish run:  ${runUrl}`
    : `\n  publish run:  not listed yet — https://github.com/${repoSlug}/actions/workflows/publish-npm.yml`
);
console.log(`  then:         npm view @pcircle/memesh version --prefer-online`);
