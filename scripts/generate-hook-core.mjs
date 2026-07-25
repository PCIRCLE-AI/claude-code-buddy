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
import { builtinModules } from 'node:module';

// A runtime-leaf module may import ONLY node builtins — those resolve next to
// the hooks even when dist/ and node_modules are absent. Anything else (a
// relative sibling or an external package) makes the verbatim copy unsafe.
const NODE_BUILTINS = new Set(builtinModules);

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
    // Guard the leaf invariant: every import in the copied module must resolve
    // to a node builtin. A relative import ('./x') or an external package
    // ('somepkg') means the source stopped being self-contained, so the copy
    // would break at hook runtime where dist/ and node_modules may be absent.
    // Matches `import ... from 'spec'` AND bare `import 'spec'` (spans newlines
    // for multi-line specifier lists via the newline-inclusive [^;] class).
    const importRe = /^\s*import\b\s*(?:[^;]*?\bfrom\s+)?['"]([^'"]+)['"]/gm;
    let imp;
    while ((imp = importRe.exec(code)) !== null) {
      const spec = imp[1];
      const isBuiltin = spec.startsWith('node:') || NODE_BUILTINS.has(spec);
      if (!isBuiltin) {
        const kind = spec.startsWith('.') ? 'a relative import' : 'an external package';
        console.error(
          `generate-hook-core: ${from} imports '${spec}' (${kind}). ` +
          `${src} must stay a runtime-leaf module (node builtins only) to be copied ` +
          `verbatim next to the hooks. Drop the dependency, or bundle it instead of copying.`,
        );
        process.exit(1);
      }
    }
    // Strip the tsc sourceMappingURL footer — the .map isn't copied alongside.
    code = code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
    writeFileSync(resolve(outDir, to), banner(src) + code, 'utf8');
  }
  console.log('✓ generated scripts/hooks/_generated/{core-paths,fts-index}.js from dist/ leaf modules');
}

generate();
