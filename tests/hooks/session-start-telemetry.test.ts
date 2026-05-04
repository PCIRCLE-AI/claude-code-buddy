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
      env: { ...process.env, ...env },
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
      env: { ...process.env, HOME: tmpHome },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }, 60_000);

  afterEach(() => {
    if (fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes agentic_orchestration_banner_injected event when opted in', () => {
    const { stdout, exitCode } = runHook(
      { cwd: '/some/project/path', session_id: 'test-session' },
      { HOME: tmpHome, MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '1' },
    );

    expect(exitCode).toBe(0);
    // Banner text must appear in additionalContext (regression: tone-down
    // wording must contain "Experimental working model" so users see the
    // "validation in progress" framing).
    expect(stdout).toContain('Experimental working model');

    // Telemetry file must exist with exactly one banner-injection event.
    const logPath = path.join(tmpHome, '.memesh', 'skill-usage.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]);
    expect(event.event).toBe('agentic_orchestration_banner_injected');
    expect(typeof event.ts).toBe('string');
    expect(event.payload).toBeDefined();
    expect(typeof event.payload.cwd_hashed).toBe('string');
    // Specifically guard against the bug that previously shipped:
    // a stray `cwd` reference threw "cwd is not defined" inside the inner
    // try, and the empty catch swallowed it, leaving the file empty.
    expect(event.payload.cwd_hashed).not.toBe('undefined');
    expect(event.payload.cwd_hashed.length).toBeGreaterThan(0);
    // PRIVACY GUARD: cwd_hashed must be a real hex hash, not a raw path
    // slice. A pre-release form took String(cwd).slice(0, 16) — the field
    // name promises hashing, and this assertion makes that promise
    // enforceable so a future regression cannot silently revert it.
    expect(event.payload.cwd_hashed).toMatch(/^[a-f0-9]{16}$/);
    expect(event.payload.cwd_hashed).not.toContain('/');
    expect(event.payload.cwd_hashed).not.toContain('some');
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
    expect(stdout).not.toContain('Experimental working model');

    const logPath = path.join(tmpHome, '.memesh', 'skill-usage.jsonl');
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
