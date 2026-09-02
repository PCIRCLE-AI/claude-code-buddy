/**
 * The pre-release gate has to be honest about two things: what it ran, and
 * what it did not.
 *
 * The parity test is the load-bearing one. A step naming an npm script that
 * does not exist would make `npm run` print "Missing script" and exit non-zero
 * — a red gate for a reason that has nothing to do with the release — and a
 * step silently renamed away is worse: it reads as coverage that is gone.
 *
 * The two spawned runs use a throwaway package.json whose scripts are `node
 * -e`, so the exit-code plumbing is exercised for real (a spawned npm, a real
 * status, a real verdict) in about a second, instead of running the release
 * suite twice.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NOT_CHECKED, STEPS, formatVerdict, unknownSteps } from '../scripts/qa/pre-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(repoRoot, 'scripts', 'qa', 'pre-release.mjs');

/** A package.json with the gate's own step names bound to trivial commands. */
function fixtureRepo(failing: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pre-release-fixture-'));
  const scripts: Record<string, string> = {};
  for (const step of STEPS) {
    scripts[step.id] = step.id === failing ? 'node -e "process.exit(3)"' : 'node -e "0"';
  }
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', scripts }, null, 2));
  return dir;
}

function runGate(cwd: string) {
  return spawnSync(process.execPath, [gate], { cwd, encoding: 'utf8', timeout: 120_000 });
}

describe('the plan', () => {
  it('names only npm scripts this repository actually has', () => {
    // The size pin comes first on purpose: `unknownSteps(...)` returning `[]`
    // is also what an empty plan returns, and a gate with no steps passes
    // every assertion in this file while checking nothing.
    expect(STEPS).toHaveLength(3);
    expect(STEPS.map((step) => step.id)).toEqual(['build', 'verify:artifact', 'audit:memory']);
    expect(unknownSteps(repoRoot)).toEqual([]);
  });

  it('goes through verify:artifact rather than repeating its sequence', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
    expect(STEPS.map((step) => step.id)).toContain('verify:artifact');
    expect(scripts.prepublishOnly).toContain('verify:artifact');
    expect(scripts.prepublishOnly).not.toContain('test:packaged:upgrade');
  });

  it('says what it cannot check, including the two gates that live elsewhere', () => {
    const text = NOT_CHECKED.join('\n');
    expect(text).toMatch(/live-journey/);
    expect(text).toMatch(/qa:post-release/);
    expect(text).toMatch(/entry-point/);
  });

  it('detects a step whose npm script has been renamed away', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-pre-release-missing-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0', scripts: {} }));
    expect(unknownSteps(dir)).toEqual(STEPS.map((step) => step.id));
    const run = runGate(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/npm scripts that do not exist/);
  });
});

describe('running it', () => {
  it('passes and reports every step when every step passes', () => {
    const run = runGate(fixtureRepo(null));
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/PASS — pre-release gate/);
    for (const step of STEPS) expect(run.stdout).toContain(`PASS  ${step.id}`);
    expect(run.stdout).toMatch(/not checked here/);
  });

  it('fails on a real non-zero exit code and names what it never ran', () => {
    const run = runGate(fixtureRepo('verify:artifact'));
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/FAIL {2}verify:artifact \(exit=3\)/);
    expect(run.stdout).toMatch(/NOT RUN — stopped at the first failure: audit:memory/);
    expect(run.stdout).toMatch(/FAIL — pre-release gate/);
    expect(run.stdout).not.toMatch(/PASS — pre-release gate/);
  });
});

describe('verdict', () => {
  it('is a pass only when every step exited zero, and never on an empty run', () => {
    expect(formatVerdict([{ id: 'a', status: 0, signal: null }]).ok).toBe(true);
    expect(formatVerdict([{ id: 'a', status: 1, signal: null }]).ok).toBe(false);
    expect(formatVerdict([]).ok).toBe(false);
  });

  it('reports a killed step as a failure that names the signal', () => {
    const { ok, lines } = formatVerdict([{ id: 'a', status: null, signal: 'SIGKILL' }]);
    expect(ok).toBe(false);
    expect(lines[0]).toMatch(/killed by SIGKILL/);
  });
});
