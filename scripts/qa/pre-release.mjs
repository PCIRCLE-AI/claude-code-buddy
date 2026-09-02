#!/usr/bin/env node
/**
 * One door before a release.
 *
 * The gates this repository owns were reachable only as a list of commands
 * someone had to remember, and the release incidents show what that costs:
 * every one of them (v4.7.0's tag with no npm publish, v4.8.2's stale plugin
 * cache, the 4.8.2-CLI-beside-4.8.3-plugin skew) happened with green gates,
 * because the green ones were not the ones that would have gone red.
 *
 * So this runs the enumerable gates in one place, reports each step's REAL
 * exit code, and — the half that keeps it honest — prints what it did not
 * check and could not. A gate that quietly omits a check reads exactly like
 * one that ran it.
 *
 * It shares its middle step with `prepublishOnly`: both call `verify:artifact`
 * rather than repeating the sequence, because two copies of one list is how
 * every drift in this repository started.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The steps, in order. Each `id` must be an npm script in package.json. */
export const STEPS = [
  {
    id: 'build',
    why: 'dist/ is version-controlled and several gates spawn it; a stale build makes every later step measure the wrong code.',
  },
  {
    id: 'verify:artifact',
    why: 'lint, typecheck, version coherence, doc claims, the isolated test suite, the packed artifact and every derived upgrade path — the same sequence npm publish runs.',
  },
  {
    id: 'audit:memory',
    why: 'the memory-layer invariants, against this machine\'s real graph. Deliberately outside verify:release, which must reproduce on a fresh clone.',
  },
];

/**
 * What this gate does NOT cover. Printed on every run, pass or fail.
 *
 * These are not omissions to be tidied away later: each one names why it
 * cannot run here, so nobody reads a green verdict as more than it is.
 */
export const NOT_CHECKED = [
  'npm run qa:live-journey -- --host claude — needs an interactive Claude Code session a script cannot open.',
  'npm run qa:post-release — only meaningful after the release is published; run it next.',
  'The entry-point start gate — unreviewed on branch fix/entry-point-execution-gate, deliberately not wired in.',
];

/**
 * @param {{id: string, status: number|null, signal: string|null}[]} results
 * @returns {{ok: boolean, lines: string[]}}
 */
export function formatVerdict(results) {
  const lines = results.map((result) => {
    const outcome = result.status === 0 ? 'PASS' : 'FAIL';
    const detail = result.signal ? `killed by ${result.signal}` : `exit=${result.status}`;
    return `  ${outcome}  ${result.id} (${detail})`;
  });
  return { ok: results.length > 0 && results.every((result) => result.status === 0), lines };
}

/**
 * Every step must name an npm script that exists. A step naming a script that
 * does not exist would fail as "missing script" and read like a failing gate,
 * or worse, be silently dropped by a future refactor.
 *
 * @param {string} repoRoot
 * @returns {string[]} ids with no npm script behind them
 */
export function unknownSteps(repoRoot, steps = STEPS) {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {};
  return steps.map((step) => step.id).filter((id) => !(id in scripts));
}

function main() {
  const repoRoot = process.cwd();
  const missing = unknownSteps(repoRoot);
  if (missing.length > 0) {
    console.error(`pre-release plan names npm scripts that do not exist: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`pre-release gate: ${STEPS.length} steps, in order\n`);
  const results = [];
  for (const step of STEPS) {
    console.log(`--- ${step.id}\n    ${step.why}`);
    const child = spawnSync('npm', ['run', step.id], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    results.push({ id: step.id, status: child.status, signal: child.signal });
    if (child.status !== 0) break;
  }

  const verdict = formatVerdict(results);
  console.log('\npre-release verdict');
  for (const line of verdict.lines) console.log(line);
  const skipped = STEPS.slice(results.length).map((step) => step.id);
  if (skipped.length > 0) console.log(`  NOT RUN — stopped at the first failure: ${skipped.join(', ')}`);

  console.log('\nnot checked here:');
  for (const item of NOT_CHECKED) console.log(`  - ${item}`);

  console.log(`\n${verdict.ok ? 'PASS' : 'FAIL'} — pre-release gate`);
  process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
