/**
 * Every Node version CI runs must be one the package claims to support, and the
 * floor it claims must actually be run.
 *
 * `package.json` `engines.node` is a promise to strangers; the CI matrix is the
 * only thing that checks the promise. Nothing held the two together, so they
 * could drift in either direction, and both directions are silent:
 *
 *   - matrix BELOW the floor — CI proves the suite passes on a runtime we tell
 *     users not to use, and `npm install` warns EBADENGINE on the very runtime
 *     that produced the green tick. This was the live state before the floor
 *     moved to 22.5.0: three `node-version: '20'` jobs, one of them the publish
 *     path, which would have run `prepublishOnly` -> `verify:release` (npm pack,
 *     install into a consumer tree, audit) on an unsupported runtime.
 *   - matrix ABOVE the floor — we claim 22.5 and test only 24 and 26, so the
 *     oldest runtime any user is entitled to run is the one runtime nobody runs.
 *
 * Both cases are checked. Checking only the first would pass on a matrix that
 * dropped the floor leg entirely, which is the more likely accident: legs get
 * removed for wall-clock, floors get raised deliberately.
 *
 * The workflows are read as text, not parsed as YAML — this repository has no
 * YAML parser and one test is not a reason to add a dependency. Text matching
 * fails open by nature, so every extraction below asserts it found something
 * before it asserts anything about what it found. A regex that silently matches
 * nothing would leave "all zero legs satisfy the floor" as a green test, which
 * is the same defect as a gate that passes on an empty input.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(repoRoot, '.github', 'workflows');

/** The major version in a `>=X.Y.Z` engines range. */
function declaredFloor(): { range: string; major: number } {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const range = pkg.engines?.node;
  expect(range, 'package.json declares no engines.node').toBeTypeOf('string');
  const match = /^>=\s*(\d+)\./.exec(range as string);
  expect(
    match,
    `engines.node is "${range}"; this test only understands ">=X.Y.Z" and will not guess at a range it cannot read`
  ).not.toBeNull();
  return { range: range as string, major: Number((match as RegExpExecArray)[1]) };
}

/**
 * Every Node version any workflow pins, as `{ file, where, major }`.
 *
 * Two shapes: the build matrix's `node: ['22', '24']` plus its `include:`
 * entries, and the standalone jobs' `node-version: '22'`.
 */
function pinnedNodeVersions(): Array<{ file: string; where: string; major: number }> {
  const found: Array<{ file: string; where: string; major: number }> = [];
  const files = fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  expect(files.length, 'no workflow files found — did .github/workflows move?').toBeGreaterThan(0);

  for (const file of files) {
    const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');

    // `node: ['22', '24']` — the matrix list.
    for (const m of text.matchAll(/^\s*node:\s*\[([^\]]*)\]/gm)) {
      for (const raw of m[1].split(',')) {
        const version = raw.trim().replace(/^['"]|['"]$/g, '');
        if (version === '') continue;
        found.push({ file, where: `matrix node: [… ${version} …]`, major: Number(version.split('.')[0]) });
      }
    }

    // `node: '26'` — a matrix `include:` entry.
    for (const m of text.matchAll(/^\s*-?\s*node:\s*['"](\d+)[^'"]*['"]\s*$/gm)) {
      found.push({ file, where: `matrix include node: '${m[1]}'`, major: Number(m[1]) });
    }

    // `node-version: '22'` — a standalone job. Skips `${{ matrix.node }}`.
    for (const m of text.matchAll(/^\s*node-version:\s*['"]?(\d+)[^'"\s]*['"]?\s*$/gm)) {
      found.push({ file, where: `node-version: '${m[1]}'`, major: Number(m[1]) });
    }
  }
  return found;
}

describe('the CI matrix and engines.node cannot drift apart', () => {
  it('pins no Node version below the floor the package declares', () => {
    const floor = declaredFloor();
    const pins = pinnedNodeVersions();

    // Without this, a regex that matched nothing would make the loop below
    // vacuous and this test would pass on a workflow directory of empty files.
    expect(pins.length, 'no Node version was extracted from any workflow — the patterns stopped matching').toBeGreaterThanOrEqual(5);

    for (const pin of pins) {
      expect(
        pin.major,
        `${pin.file} runs Node ${pin.major} (${pin.where}) but engines.node is "${floor.range}" — CI is testing a runtime the package tells users not to use`
      ).toBeGreaterThanOrEqual(floor.major);
    }
  });

  it('actually runs the floor it declares', () => {
    const floor = declaredFloor();
    const pins = pinnedNodeVersions();
    const majors = [...new Set(pins.map((p) => p.major))].sort((a, b) => a - b);

    expect(
      majors,
      `engines.node is "${floor.range}" but no job runs Node ${floor.major}; CI covers ${majors.join(', ')}. The oldest runtime users may run is the one nobody tests.`
    ).toContain(floor.major);
  });
});
