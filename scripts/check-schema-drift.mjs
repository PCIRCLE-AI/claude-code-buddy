#!/usr/bin/env node
//
// Schema-drift guard
// ==================
//
// `src/db.ts` and `scripts/hooks/_shared.js` carry byte-for-byte identical
// SCHEMA_SQL + FTS_SQL strings. The duplication is structurally necessary —
// hooks cannot import from `dist/` (the F5 security boundary), so the SQL
// has to be embedded in the hook-side helper.
//
// Two engineers working on different copies have repeatedly let them
// drift in the past (the comment in _shared.js explicitly documents
// "must change in lockstep"). This script enforces the invariant at
// build time: it extracts both strings, normalises whitespace, diffs
// them, and exits non-zero on any divergence.
//
// Wired into `npm run build` as a prebuild step. Also runnable
// standalone:
//
//   node scripts/check-schema-drift.mjs
//

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const CORE_PATH = resolve(repoRoot, 'src/db.ts');
const HOOK_PATH = resolve(repoRoot, 'scripts/hooks/_shared.js');

/**
 * Pull a top-level template-literal constant by its identifier.
 * Both files declare `const SCHEMA_SQL = \`…\`;` and `const FTS_SQL = \`…\`;`
 * (with `export` prefix on the hook side). Regex captures the body between
 * the surrounding backticks.
 */
function extractConstant(source, name) {
  const re = new RegExp(
    String.raw`(?:export\s+)?const\s+` + name + String.raw`\s*=\s*\x60([\s\S]*?)\x60\s*;`,
    'm',
  );
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not locate \`${name}\` template literal`);
  }
  // Defensive: if a future migration adds an embedded backtick to the
  // SQL string, the lazy-match `[\s\S]*?` truncates the capture early,
  // producing a partial body. The regex would silently match a wrong
  // shorter capture rather than fail. Reject any body shorter than
  // 100 chars (smallest realistic SCHEMA_SQL is ~400 chars; FTS_SQL
  // is ~150). Forces a maintainer either to rename the constant or
  // escape the backtick.
  if (match[1].length < 100) {
    throw new Error(
      `Extracted body for \`${name}\` is implausibly short (${match[1].length} chars). `
      + `Likely cause: an embedded backtick in the SQL truncated the match early. `
      + `Either escape the backtick or split the constant.`,
    );
  }
  return match[1];
}

/**
 * Whitespace-only differences are not drift — collapse runs of whitespace
 * to a single space and trim. Anything else (different column, missing
 * index, wrong table name, …) survives normalisation and the diff fires.
 */
function normalise(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function readFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`schema-drift: cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
}

const coreSrc = readFile(CORE_PATH);
const hookSrc = readFile(HOOK_PATH);

const failures = [];

for (const name of ['SCHEMA_SQL', 'FTS_SQL']) {
  let coreVal;
  let hookVal;
  try {
    coreVal = extractConstant(coreSrc, name);
  } catch (err) {
    failures.push(`${CORE_PATH}: ${err.message}`);
    continue;
  }
  try {
    hookVal = extractConstant(hookSrc, name);
  } catch (err) {
    failures.push(`${HOOK_PATH}: ${err.message}`);
    continue;
  }
  if (normalise(coreVal) !== normalise(hookVal)) {
    failures.push(
      `${name} drift detected between ${CORE_PATH} and ${HOOK_PATH}.\n` +
      `  Run a side-by-side diff and bring the two definitions back in sync.\n` +
      `  Both files must declare an identical ${name} template literal.`,
    );
  }
}

if (failures.length > 0) {
  console.error('\n✗ schema-drift check FAILED:\n');
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log('✓ schema-drift check passed (SCHEMA_SQL + FTS_SQL match)');
