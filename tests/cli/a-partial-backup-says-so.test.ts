/**
 * Two ways the backup round trip lied, in opposite directions.
 *
 * Both were found by running `export` and `import` against a copy of a real
 * knowledge graph — 1272 memories — rather than a fixture, which is the only
 * reason either was visible: a fixture is never bigger than the default
 * limit, and its relations never point outside it.
 *
 *   `export` truncated in silence. The default `--limit` is 1000, so the
 *   bundle carried 1000 of 1272 and the CLI printed `✅ Exported 1000
 *   entities`. A backup was missing 21% of the thing it was taken to
 *   preserve, and `entity_count` cannot be told apart from a graph that
 *   happens to be exactly that size.
 *
 *   `import` then FAILED on that bundle. Nine relations pointed at entities
 *   the limit had cut off; they went into `errors`, and `errors` sets exit 1.
 *   So `memesh export > b.json && memesh import b.json` — the round trip this
 *   project's own help text recommends — exited non-zero on a restore that
 *   did exactly what it should.
 *
 * These assertions are on stderr of SUCCESSFUL commands, which is why this
 * file spawns with `spawnSync` instead of the `execFileSync` helper the
 * neighbouring CLI tests use: that one only captures stderr when the process
 * throws, and a warning printed on the way to exit 0 is invisible to it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function seed(...names: string[]): void {
  for (const name of names) {
    expect(runCli(['remember', '--name', name, '--type', 'note', '--obs', `about ${name}`]).exitCode).toBe(0);
  }
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-partial-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('a bundle that is only part of the graph says so', () => {
  it('warns on stderr, names --limit, and keeps stdout pure JSON', () => {
    seed('alpha', 'bravo', 'charlie');

    const r = runCli(['export', '--limit', '2']);

    expect(r.exitCode, 'a warning is not a failure').toBe(0);
    expect(r.stderr, 'a short backup was taken in silence').toMatch(/NOT the whole graph/);
    expect(r.stderr, 'the warning does not say how to fix it').toContain('--limit');

    // The warning must never reach the bundle: `memesh export > b.json` is the
    // documented way to take one, and a line of prose on stdout makes the file
    // unparseable.
    const bundle = JSON.parse(r.stdout);
    expect(bundle.entity_count).toBe(2);
    expect(bundle.truncated, 'the bundle does not record that it is partial').toBe(true);
  });

  it('says nothing when the bundle IS the whole graph', () => {
    // The anti-vacuity half. Without it, a warning printed unconditionally
    // would pass the test above and be worthless.
    seed('alpha', 'bravo', 'charlie');

    const r = runCli(['export', '--limit', '10']);

    expect(r.exitCode).toBe(0);
    expect(r.stderr, 'a complete backup was called short').not.toMatch(/NOT the whole graph/);
    expect(JSON.parse(r.stdout).truncated).toBe(false);
  });
});

describe('a restore that lost a link reports it without failing', () => {
  it('names the relation on stderr and still exits 0', () => {
    const bundle = path.join(home, 'b.json');
    fs.writeFileSync(bundle, JSON.stringify({
      version: '3.1.0',
      exported_at: new Date().toISOString(),
      entity_count: 1,
      entities: [{
        name: 'inside-the-bundle',
        type: 'note',
        namespace: 'personal',
        observations: ['a fact'],
        tags: [],
        relations: [{ to: 'cut-off-by-the-limit', type: 'related-to' }],
      }],
    }));

    const r = runCli(['import', bundle, '--merge', 'skip']);

    expect(r.exitCode, 'a correct restore was reported as a failed command').toBe(0);
    expect(r.stdout).toContain('Imported: 1');
    expect(r.stderr, 'the lost link was not named').toContain('cut-off-by-the-limit');
    expect(r.stderr, 'a link leaving the bundle was presented as an error').not.toMatch(/^Errors:/m);
  });

  it('still exits 1 when an ENTRY genuinely fails', () => {
    // The other anti-vacuity half: moving dangling relations out of `errors`
    // must not empty `errors` of the failures that belong there.
    const bundle = path.join(home, 'bad.json');
    fs.writeFileSync(bundle, JSON.stringify({
      version: '3.1.0',
      exported_at: new Date().toISOString(),
      entity_count: 1,
      entities: [{ name: 'no-type-at-all', namespace: 'personal', observations: ['x'], tags: [], relations: [] }],
    }));

    const r = runCli(['import', bundle, '--merge', 'skip']);

    expect(r.exitCode, 'a bundle entry that could not be imported exited 0').toBe(1);
    expect(r.stderr).toMatch(/Errors:/);
  });
});
