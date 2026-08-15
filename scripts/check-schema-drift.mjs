#!/usr/bin/env node
//
// Schema single-owner guard
// =========================
//
// `src/storage/schema.ts` is THE definition of SCHEMA_SQL, FTS_SQL and the
// migration chain. Core imports it directly; the hooks execute the generated
// copy (`scripts/hooks/_generated/schema.js`, byte-locked by
// check-generated-mirror). There is nothing left to diff — this guard's old
// job — so its job now is to keep it that way: fail the build if anyone
// re-introduces a second SCHEMA_SQL / FTS_SQL definition outside the owner
// (the hand-mirror pattern this repo paid for with the P0 FTS bug), or if
// the owner itself loses the definitions.
//
// Wired into `npm run build` as a prebuild step. Also runnable standalone:
//
//   node scripts/check-schema-drift.mjs
//

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const OWNER = resolve(repoRoot, 'src/storage/schema.ts');

// Where a re-introduced hand-mirror would land: anywhere in src/ or in the
// hand-written hook scripts. dist/ and _generated/ legitimately carry the
// compiled/copied owner and are excluded.
const SCAN_ROOTS = [
  resolve(repoRoot, 'src'),
  resolve(repoRoot, 'scripts/hooks'),
];
const EXCLUDED_DIR = resolve(repoRoot, 'scripts/hooks/_generated');

const DEFINITION_RE = /(?:export\s+)?const\s+(SCHEMA_SQL|FTS_SQL)\s*=\s*`/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === EXCLUDED_DIR) continue;
      yield* walk(full);
    } else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

const failures = [];

// 1. The owner must still define both constants.
const ownerSrc = readFileSync(OWNER, 'utf8');
for (const name of ['SCHEMA_SQL', 'FTS_SQL']) {
  if (!new RegExp(String.raw`export\s+const\s+${name}\s*=\s*\x60`).test(ownerSrc)) {
    failures.push(`${OWNER}: no exported \`${name}\` template literal — the single owner lost its definition.`);
  }
}

// 2. Nobody else may define them.
for (const root of SCAN_ROOTS) {
  for (const file of walk(root)) {
    if (file === OWNER) continue;
    const src = readFileSync(file, 'utf8');
    const m = src.match(DEFINITION_RE);
    if (m) {
      failures.push(
        `${relative(repoRoot, file)} defines \`${m[1]}\` — the schema has ONE owner ` +
        `(src/storage/schema.ts). Import it (core) or use the generated copy (hooks) ` +
        `instead of re-introducing a hand-mirror.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('\n✗ schema single-owner check FAILED:\n');
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log('✓ schema single-owner check passed (SCHEMA_SQL + FTS_SQL defined only in storage/schema.ts)');
