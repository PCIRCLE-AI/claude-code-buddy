/**
 * Three PASSes doctor gave for things it had not checked.
 *
 * These run the built CLI against a real database in a throwaway HOME,
 * deliberately, because each defect was invisible to a stub:
 *
 *   C1  "Hooks wired into Claude Code / PASS" came from the presence of
 *       `.claude-plugin/plugin.json`, which is inside the npm tarball and
 *       therefore present on every install. The unit fixture did not create
 *       that file, so the unit test saw the WARN branch that no real user
 *       could reach.
 *   C5  "auto-capture loop is alive" counted entity TYPES, one of which
 *       (`lesson_learned`) is what `memesh learn` writes — a command the user
 *       types. Measured on a brand-new HOME with no `.claude` directory at
 *       all: one hand-typed `learn` produced the PASS.
 *   C2  `config set llm.apiKey` with no `llm.provider` left `status` printing
 *       `LLM: undefined (undefined)` and every LLM feature a silent no-op.
 *       The doctor stub for hook-activity asserts on SQL text and never
 *       executes it, so a predicate change is exactly what it cannot see.
 *
 * Each case asserts the honest verdict AND its opposite, so a doctor that
 * simply stopped emitting the row would fail here rather than pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  // Provider credentials in the developer's own shell are auto-detected by
  // design, which would mask the "no provider configured" cases below.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_HOST']) delete env[key];

  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf8', env });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

interface DoctorCheck { id: string; status: string; summary: string; fix?: string }

function doctorCheck(id: string): DoctorCheck {
  const r = runCli(['doctor', '--json']);
  const report = JSON.parse(r.stdout) as { checks: DoctorCheck[] };
  const check = report.checks.find((c) => c.id === id);
  expect(check, `doctor no longer emits a "${id}" row at all`).toBeDefined();
  return check as DoctorCheck;
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-doctorhonest-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('doctor: hooks wired (C1)', () => {
  it('does not claim hooks are wired just because the shipped plugin manifest exists', () => {
    // This test runs against the repository itself, which — like every npm
    // install — contains `.claude-plugin/plugin.json`. Assert it really is
    // there, or the test proves nothing.
    const manifest = path.join(__dirname, '..', '..', '.claude-plugin', 'plugin.json');
    expect(fs.existsSync(manifest), 'the shipped plugin manifest moved; this test is now vacuous').toBe(true);

    // Fresh HOME → no install-hooks marker → nothing is wired.
    const wiring = doctorCheck('hook-wiring');
    expect(wiring.status, 'doctor reports wired hooks on an install where nothing is wired').toBe('warn');
    expect(wiring.summary).toMatch(/not connected to Claude Code/i);
    expect(wiring.fix).toMatch(/install-hooks/);
  });
});

describe('doctor: auto-capture activity (C5)', () => {
  it('a hand-typed learn is not evidence that automation is running', () => {
    const learned = runCli(['learn', '--error', 'boom', '--fix', 'unboom']);
    expect(learned.exitCode, learned.stderr).toBe(0);

    // The entity is really there — otherwise "not alive" would be trivially
    // true and this test would guard nothing.
    expect(runCli(['recall', 'boom', '--json']).stdout).toContain('lesson');

    const activity = doctorCheck('hook-activity');
    expect(
      activity.summary,
      'a lesson the user typed by hand is reported as the auto-capture loop working'
    ).not.toMatch(/auto-capture is alive/);
  });

  it('even the auto-capture TAG is not evidence — only a recorded hook run is', () => {
    // This case used to assert the opposite, and the assertion was wrong for
    // the same reason as the one above it: `source:auto-capture` is a tag, and
    // a tag is something anyone can type. The test one line up proves the user
    // can write entities by hand; nothing stopped them writing that tag too,
    // and doctor would then have called the capture loop alive on the strength
    // of it. Liveness now comes from `hook_runs`, which only a hook writes.
    const r = runCli([
      'remember', '--name', 'session-abc', '--type', 'session-insight',
      '--obs', 'did some work', '--tags', 'source:auto-capture',
    ]);
    expect(r.exitCode, r.stderr).toBe(0);

    const activity = doctorCheck('hook-activity');
    expect(
      activity.summary,
      'a hand-typed tag convinced doctor the hooks were running'
    ).not.toMatch(/auto-capture is alive/);
  });

  it('a recorded hook run IS evidence, and doctor says which hook and when', () => {
    // The other direction, or the two cases above would be satisfied by a
    // doctor that never reports the loop alive at all.
    const seeded = runCli(['remember', 'anything at all, just to create the database']);
    expect(seeded.exitCode, seeded.stderr).toBe(0);

    const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
    expect(fs.existsSync(dbPath), 'no database to seed — this test would be vacuous').toBe(true);
    execFileSync('node', [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.prepare("INSERT INTO hook_runs (hook, last_run_at, run_count) VALUES ('session-summary', datetime('now'), 1)").run();
       db.close();`,
      dbPath,
    ], { encoding: 'utf8' });

    const activity = doctorCheck('hook-activity');
    expect(activity.status).toBe('pass');
    expect(activity.summary).toMatch(/auto-capture is alive/);
    expect(activity.summary).toMatch(/session-summary/);
  });

  it('one malformed metadata row does not take down the >72h corroboration query', () => {
    // entities.metadata has no validity constraint and the migration chain
    // deliberately preserves unparseable legacy values — while
    // json_extract THROWS on malformed JSON (verified on node:sqlite). The
    // >72h branch runs json_extract over recent rows, so without the
    // json_valid guard one bad row turned the whole hook-activity check
    // into query-failed exactly when it had something important to say.
    const seeded = runCli(['remember', 'anything at all, just to create the database']);
    expect(seeded.exitCode, seeded.stderr).toBe(0);

    const dbPath = path.join(home, '.memesh', 'knowledge-graph.db');
    execFileSync('node', [
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
       const db = new DatabaseSync(process.argv[1]);
       db.prepare("INSERT INTO hook_runs (hook, last_run_at, run_count) VALUES ('session-summary', datetime('now', '-96 hours'), 1)").run();
       db.prepare("INSERT INTO entities (name, type, metadata) VALUES ('bad-metadata-row', 'note', '{not json')").run();
       db.close();`,
      dbPath,
    ], { encoding: 'utf8' });

    const activity = doctorCheck('hook-activity');
    expect(activity.summary, 'one malformed row must not read as a database failure').not.toMatch(/Could not read hook activity/);
    expect(activity.summary).toMatch(/session-summary hook last ran/);
  });
});

describe('config: an API key with no provider (C2)', () => {
  it('says so at the moment it is set', () => {
    const r = runCli(['config', 'set', 'llm.apiKey', 'sk-test-not-a-real-key']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No llm.provider is set');
    expect(r.stdout).toMatch(/config set llm\.provider/);
  });

  it('does not report an LLM that cannot be called', () => {
    runCli(['config', 'set', 'llm.apiKey', 'sk-test-not-a-real-key']);

    // `status` printed `LLM: undefined (undefined)` — a configured-looking
    // line for a provider that does not exist.
    const status = runCli(['status']);
    expect(status.stdout).not.toContain('undefined');
    expect(status.stdout).toMatch(/LLM: not configured/);

    // …and it reports one once a provider is named, so this is not just
    // "never report an LLM". No model was set, and that is a normal setup —
    // the provider default applies — so the line must say `default`, not the
    // word `undefined`.
    runCli(['config', 'set', 'llm.provider', 'anthropic']);
    const after = runCli(['status']);
    expect(after.stdout).toMatch(/LLM: anthropic \(default\)/);
    expect(after.stdout).not.toContain('undefined');
  });
});
