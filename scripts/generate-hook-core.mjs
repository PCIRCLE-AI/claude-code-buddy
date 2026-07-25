#!/usr/bin/env node
//
// Hook-core generator (F5 mirror, step B)
// =======================================
//
// Claude Code hooks (`scripts/hooks/*.js`) must run the always-on capture path
// even when `dist/` is absent (plugin-marketplace `--ignore-scripts`) or stale
// (source pull before build). Historically that forced a 965-line hand-mirror
// of `src/core` inside `_shared.js`, which drifted and shipped the P0 FTS bug.
//
// `src/core/paths.ts` and `src/storage/fts-index.ts` are runtime-LEAF modules:
// paths.ts imports only node builtins; fts-index.ts has only a type-only import.
// So `tsc` already emits SELF-CONTAINED JS for them (no relative imports). This
// script copies those compiled leaf modules to `scripts/hooks/_generated/`,
// committed and shipped in the tarball. Hooks import the committed copy — it is
// version-locked to its own install (no cross-version staleness) and present
// even when the rest of `dist/` is not (it lives next to the hooks, not in dist/).
//
// The copy is deterministic (same TS + tsconfig → same JS + fixed banner), so a
// `git diff --exit-code` in CI fails when a maintainer edits the core source but
// forgets to regenerate. That, plus the behavioural parity test
// (`tests/hooks/mirror-parity.test.ts`), makes mirror drift structurally caught.
//
// Wired into `npm run build` AFTER `tsc` and BEFORE `generate-skills-manifest`
// (so the manifest hashes the fresh generated files). Also runnable standalone:
//
//   node scripts/generate-hook-core.mjs
//

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'scripts/hooks/_generated');

// Each entry: compiled leaf module (source of truth) → committed hook copy.
const SOURCES = [
  { from: 'dist/core/paths.js', to: 'core-paths.js', src: 'src/core/paths.ts' },
  { from: 'dist/storage/fts-index.js', to: 'fts-index.js', src: 'src/storage/fts-index.ts' },
];

function banner(srcPath) {
  return [
    '// ============================================================================',
    `// AUTO-GENERATED from ${srcPath} — DO NOT EDIT BY HAND.`,
    '// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)',
    '//',
    '// Claude Code hooks import this committed copy instead of dist/, so the',
    '// always-on capture path survives a missing or stale dist/ while staying',
    '// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.',
    '// ============================================================================',
    '',
  ].join('\n');
}

function generate() {
  mkdirSync(outDir, { recursive: true });
  for (const { from, to, src } of SOURCES) {
    const fromPath = resolve(root, from);
    let code;
    try {
      code = readFileSync(fromPath, 'utf8');
    } catch (err) {
      console.error(`generate-hook-core: cannot read ${from} — run \`tsc\` first. (${err.message})`);
      process.exit(2);
    }
    // Guard the leaf invariant: a relative import means the source stopped
    // being self-contained and this copy would break at hook runtime.
    const relImport = code.match(/^\s*import[^;]*from\s+['"]\.[^'"]+['"]/m);
    if (relImport) {
      console.error(
        `generate-hook-core: ${from} has a relative import (${relImport[0].trim()}). ` +
        `${src} is no longer a runtime-leaf module and cannot be copied verbatim. ` +
        `Bundle it or keep its dependency graph leaf.`,
      );
      process.exit(1);
    }
    // Strip the tsc sourceMappingURL footer — the .map isn't copied alongside.
    code = code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
    writeFileSync(resolve(outDir, to), banner(src) + code, 'utf8');
  }
  console.log('✓ generated scripts/hooks/_generated/{core-paths,fts-index}.js from dist/ leaf modules');
}

generate();
