#!/usr/bin/env node
// =============================================================================
// Generate skills-manifest.json — SHA-256 manifest of every file that
// ships to the user's machine and gets executed or loaded as a prompt.
//
// F4 (skill supply chain): the npm `--provenance` flag attests that the
// tarball was built from this repo at this commit, but it does not let
// a user verify that the *runtime* files (skill prompts + hooks) match
// what's in the repo at the published version. A compromised publish
// box could rebuild with extra payload before tarballing.
//
// This manifest closes that gap: at install/run time, `memesh doctor
// --verify-skills` recomputes hashes and compares against the manifest
// shipped inside the package. Tampering shows up as a hash mismatch.
//
// What's covered:
//   - skills/**/SKILL.md           (loaded as Claude system prompt)
//   - scripts/hooks/*.js           (run in user's Claude Code process)
//   - hooks/hooks.json             (declares which hooks are active)
//   - .mcp.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json
//     (host wiring)
//
// What's NOT covered (out of scope for this manifest):
//   - dist/**/*.js — Node code path. Tampering there is detected by
//     npm provenance + the standard package signature; covering it
//     here would just duplicate work and bloat the manifest.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { readdir } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(__filename, '..', '..');
const distDir = join(repoRoot, 'dist');
const manifestPath = join(distDir, 'skills-manifest.json');

/**
 * Every file under `dir`, recursively.
 *
 * `mustExist` is the difference between "this subdirectory happens to be
 * empty" and "the directory I was told to manifest is not there". The catch
 * used to swallow both: a rename or a bad `files` entry in package.json made
 * `walk('skills')` answer `[]`, the manifest shipped with zero skill entries,
 * and `memesh doctor` then verified what remained and reported "Skills +
 * hooks integrity PASS". This same file already hard-fails for a missing
 * single-file artefact, with a comment saying exactly why; the directories
 * were the half left out.
 */
async function walk(dir, mustExist = false) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (err) {
    if (mustExist) {
      throw new Error(`generate-skills-manifest: cannot read ${dir} — ${err.message}`, { cause: err });
    }
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sha256(absolutePath) {
  const buf = readFileSync(absolutePath);
  return createHash('sha256').update(buf).digest('hex');
}

const targets = [];

// Skills — every file under skills/
targets.push(...await walk(join(repoRoot, 'skills'), true));

// Hooks — every .js under scripts/hooks
targets.push(...(await walk(join(repoRoot, 'scripts', 'hooks'), true)).filter(p => p.endsWith('.js')));

// Single-file artefacts (declarative wiring read by Claude Code itself).
//
// A missing one is a BUILD FAILURE, not something to skip. These three are the
// files that tell Claude Code how to load the plugin; silently omitting one
// from the manifest means `memesh doctor` verifies what remains, reports
// "Skills + hooks integrity PASS", and says nothing about the package having
// shipped without its wiring — absence read as success, which is the defect
// class this release exists to remove.
for (const f of ['hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.codex-plugin/mcp.json']) {
  const full = join(repoRoot, f);
  try {
    statSync(full);
  } catch {
    process.stderr.write(
      `[skills-manifest] required file missing: ${f}\n` +
        `  It is part of the plugin's declarative wiring. Generating a manifest without it\n` +
        `  would make 'memesh doctor' report integrity PASS for a package that lacks it.\n`
    );
    process.exit(1);
  }
  targets.push(full);
}

const entries = targets
  .map(absolute => ({
    path: relative(repoRoot, absolute).replace(/\\/g, '/'),
    sha256: sha256(absolute),
    bytes: statSync(absolute).size,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

mkdirSync(distDir, { recursive: true });
// No timestamp. It was written and never read — `doctor.ts` verifies
// `entries[].sha256` and nothing else — and it made every build produce a
// different file, which is why nothing could gate "is the committed build
// output current?". `dist/` is what plugin-marketplace installs run: they
// install with --ignore-scripts and never build, so committed-vs-source drift
// there ships code the repository does not describe. Determinism is what makes
// that checkable; scripts/check-generated-mirror.mjs does the checking.
const manifest = {
  schema: 'memesh.skills-manifest/v1',
  entries,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const total = entries.length;
const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
process.stderr.write(
  `[skills-manifest] wrote ${total} entries (${totalBytes} bytes covered) → ${relative(repoRoot, manifestPath)}\n`
);
