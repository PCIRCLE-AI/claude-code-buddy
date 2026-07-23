import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK_PATH = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start.js');
const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

function runHook(input: object, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env, USERPROFILE: env.HOME ?? process.env.USERPROFILE ?? '' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '', exitCode: err.status ?? 1 };
  }
}

describe('session-start hook: agentic-orchestration telemetry', () => {
  let tmpHome: string;

  // Per-hook 60s timeout: the seed CLI cold-starts the better-sqlite3
  // native module + ONNX pipeline + sqlite-vec extension on first run,
  // which can take >10s on cold caches.
  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-hook-tel-'));
    fs.mkdirSync(path.join(tmpHome, '.memesh'), { recursive: true });
    // Seed a DB with one entity so the banner branch fires (the hook
    // short-circuits to systemMessage when no DB exists).
    execFileSync('node', [CLI_PATH, 'remember', '--name=seed', '--type=test', '--obs=seed'], {
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }, 60_000);

  afterEach(() => {
    // Best-effort tmp cleanup. On Windows GitHub runners, sqlite WAL/SHM
    // file handles can linger past subprocess exit. We try briefly, then
    // bail — the OS reaps the tmp dir later. Crucially, we keep the retry
    // budget tight (3 × 50ms ≈ 150ms) so afterEach itself never trips
    // vitest's default 10s hookTimeout when the handle takes longer to
    // release than expected. Without the cap, large maxRetries values
    // could exceed hookTimeout and turn cleanup-race into test-fail.
    if (!fs.existsSync(tmpHome)) return;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Cleanup is non-load-bearing — the test's assertions already
      // passed. Letting a Windows handle race fail the test here would
      // conflate "the code under test misbehaved" with infrastructure.
    }
  }, 5_000);

  it('writes agentic_orchestration_banner_injected event when opted in', () => {
    const { stdout, exitCode } = runHook(
      { cwd: '/some/project/path', session_id: 'test-session' },
      { HOME: tmpHome, MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '1' },
    );

    expect(exitCode).toBe(0);
    // Banner text must appear in additionalContext. The new compact tree
    // summary surfaces the protocol via a single tagged line ("[AO opt-in:
    // ... skill: agentic-orchestration]") instead of the old multi-line
    // banner — both shapes pin the user-visible signal that the protocol
    // is active.
    expect(stdout).toContain('agentic-orchestration');
    expect(stdout).toContain('AO opt-in');

    // Telemetry file must exist with exactly one banner-injection event.
    const logPath = path.join(tmpHome, '.memesh', 'skill-usage.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]);
    expect(event.event).toBe('agentic_orchestration_banner_injected');
    expect(typeof event.ts).toBe('string');
    // The line is now { ts, event } only. The former `payload.cwd_hashed`
    // was write-only, privacy-adjacent data (summariseSkillUsage counts by
    // event name and never read it), so it was removed. Assert it is gone —
    // no PII leaks into the local telemetry line.
    expect(event.payload).toBeUndefined();
    expect(Object.keys(event).sort()).toEqual(['event', 'ts']);
  });

  it('does not write a banner-injection event when the hook short-circuits on missing DB', () => {
    // Remove the seeded DB so the hook takes the "no database" branch
    // and never reaches the banner block.
    const dbPath = path.join(tmpHome, '.memesh', 'knowledge-graph.db');
    if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
    for (const sfx of ['-wal', '-shm']) {
      const p = dbPath + sfx;
      if (fs.existsSync(p)) fs.rmSync(p);
    }

    const { exitCode } = runHook(
      { cwd: '/x', session_id: 'no-db' },
      { HOME: tmpHome, MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '1' },
    );
    expect(exitCode).toBe(0);

    const logPath = path.join(tmpHome, '.memesh', 'skill-usage.jsonl');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('does NOT inject banner or write telemetry when opt-in flag is absent (default)', () => {
    // The whole point of the v4.1 opt-in gate: a fresh user who never sets
    // MEMESH_ENABLE_AGENTIC_ORCHESTRATION must not see the experimental
    // banner or have any telemetry written. This is the privacy/UX promise.
    const { stdout, exitCode } = runHook(
      { cwd: '/some/project/path', session_id: 'no-optin' },
      { HOME: tmpHome }, // intentionally omitted — default off
    );

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('AO opt-in');
    expect(stdout).not.toContain('agentic-orchestration');

    const logPath = path.join(tmpHome, '.memesh', 'skill-usage.jsonl');
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
