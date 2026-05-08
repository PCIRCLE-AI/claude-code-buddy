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
//   - .mcp.json, .claude-plugin/plugin.json  (Claude Code wiring)
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

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
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
targets.push(...await walk(join(repoRoot, 'skills')));

// Hooks — every .js under scripts/hooks
targets.push(...(await walk(join(repoRoot, 'scripts', 'hooks'))).filter(p => p.endsWith('.js')));

// Single-file artefacts (declarative wiring read by Claude Code itself)
for (const f of ['hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json']) {
  const full = join(repoRoot, f);
  try { statSync(full); targets.push(full); } catch { /* missing — skip */ }
}

const entries = targets
  .map(absolute => ({
    path: relative(repoRoot, absolute).replace(/\\/g, '/'),
    sha256: sha256(absolute),
    bytes: statSync(absolute).size,
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

mkdirSync(distDir, { recursive: true });
const manifest = {
  schema: 'memesh.skills-manifest/v1',
  generated_at: new Date().toISOString(),
  entries,
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const total = entries.length;
const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
process.stderr.write(
  `[skills-manifest] wrote ${total} entries (${totalBytes} bytes covered) → ${relative(repoRoot, manifestPath)}\n`
);
