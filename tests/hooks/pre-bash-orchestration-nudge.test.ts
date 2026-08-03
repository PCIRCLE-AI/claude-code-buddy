import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { expectPrivateFile } from '../helpers/permissions.js';

describe('Feature: Pre-Bash Orchestration Nudge Hook', () => {
  let testDir: string;
  let memeshDir: string;
  let flagsDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nudge-test-'));
    // We set MEMESH_DB_PATH to a file inside testDir; the hook derives memeshDir
    // from dirname(MEMESH_DB_PATH), matching getMemeshDirFromDbPath() in _shared.js
    memeshDir = testDir;
    flagsDir = path.join(memeshDir, 'agent-nudge-flags');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * Run the hook with the agentic-orchestration opt-in flag set. v4.1.0
   * gates the entire hook behind MEMESH_ENABLE_AGENTIC_ORCHESTRATION=1
   * (default off so users who installed memesh purely for memory don't see
   * protocol nudges they never asked for).
   *
   * Throws on non-zero exit so negative-path tests cannot silently pass
   * when the hook crashes — `expect(result).toBe('')` would otherwise
   * accept both "exited cleanly with no output" and "crashed".
   */
  function runHook(command: string, extraEnv: Record<string, string> = {}): string {
    const hookPath = path.resolve('scripts/hooks/pre-bash-orchestration-nudge.js');
    const dbPath = path.join(testDir, 'knowledge-graph.db'); // file doesn't need to exist
    const jsonInput = JSON.stringify({ tool_input: { command } });
    return execFileSync('node', [hookPath], {
      input: jsonInput,
      env: {
        ...process.env,
        // Point MEMESH_DIR at the isolated testDir so readHookConfig() in
        // _shared.js doesn't pick up the developer's real
        // ~/.memesh/config.json (which may have enableAgenticOrchestration: true).
        MEMESH_DIR: testDir,
        MEMESH_DB_PATH: dbPath,
        MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '1',
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  }

  // --- Opt-in gate: default off ---

  it('emits nothing when MEMESH_ENABLE_AGENTIC_ORCHESTRATION is unset (default)', () => {
    const hookPath = path.resolve('scripts/hooks/pre-bash-orchestration-nudge.js');
    const dbPath = path.join(testDir, 'knowledge-graph.db');
    const jsonInput = JSON.stringify({ tool_input: { command: 'npm test' } });
    // Build a clean env that explicitly does NOT carry the opt-in flag.
    // MEMESH_DIR pins config lookup to testDir so a developer's real
    // ~/.memesh/config.json with enableAgenticOrchestration:true can't
    // smuggle the gate open via readHookConfig().
    const cleanEnv: Record<string, string> = {
      ...process.env,
      MEMESH_DIR: testDir,
      MEMESH_DB_PATH: dbPath,
    };
    delete cleanEnv.MEMESH_ENABLE_AGENTIC_ORCHESTRATION;
    let out = '';
    try {
      out = execFileSync('node', [hookPath], { input: jsonInput, env: cleanEnv, encoding: 'utf8', timeout: 10000 }).trim();
    } catch {
      out = '';
    }
    expect(out).toBe('');
    // No marker dir should be created either — the hook bailed out before any FS work.
    expect(fs.existsSync(flagsDir)).toBe(false);
  });

  // --- Matching cases: should emit a nudge (opt-in on) ---

  it('nudges on npm test', () => {
    const result = runHook('npm test');
    expect(result).toContain('Orchestration hint');
    expect(result).toContain('background agent');
    expect(result).toContain('agentic-orchestration');
  });

  it('nudges on npm run test', () => {
    const result = runHook('npm run test');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on vitest', () => {
    const result = runHook('npx vitest --run');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on jest', () => {
    const result = runHook('jest --coverage');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on npm run build', () => {
    const result = runHook('npm run build');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on tsc', () => {
    const result = runHook('tsc');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on eslint', () => {
    const result = runHook('eslint src/');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on prisma migrate deploy', () => {
    const result = runHook('npx prisma migrate deploy');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on vercel deploy', () => {
    const result = runHook('vercel deploy --prod');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on npm run e2e', () => {
    const result = runHook('npm run e2e');
    expect(result).toContain('Orchestration hint');
  });

  it('nudges on pytest', () => {
    const result = runHook('pytest tests/');
    expect(result).toContain('Orchestration hint');
  });

  // --- Verbose-flag regression: -v as test verbose, not as version ---

  it('still nudges on `pytest -v` (verbose), not treated as version flag', () => {
    const result = runHook('pytest -v tests/');
    expect(result).toContain('Orchestration hint');
  });

  it('still nudges on `go test -v ./...` (verbose), not treated as version flag', () => {
    const result = runHook('go test -v ./...');
    expect(result).toContain('Orchestration hint');
  });

  // --- Non-matching cases: should be silent ---

  it('does not nudge on ls', () => {
    const result = runHook('ls -la');
    expect(result).toBe('');
  });

  it('does not nudge on cat', () => {
    const result = runHook('cat package.json');
    expect(result).toBe('');
  });

  it('does not nudge on --version flag', () => {
    const result = runHook('node --version');
    expect(result).toBe('');
  });

  it('does not nudge on --help flag', () => {
    const result = runHook('npm test --help');
    expect(result).toBe('');
  });

  it('does not nudge on plain git commands', () => {
    const result = runHook('git status');
    expect(result).toBe('');
  });

  it('does not nudge on empty command', () => {
    const result = runHook('');
    expect(result).toBe('');
  });

  // --- Throttle: per-category, once per session ---

  it('does not nudge same category twice in one session', () => {
    const result1 = runHook('npm test');
    expect(result1).toContain('Orchestration hint');

    // Second call with same category — should be silent
    const result2 = runHook('vitest');
    expect(result2).toBe('');
  });

  it('nudges different categories independently', () => {
    const result1 = runHook('npm test');
    expect(result1).toContain('Orchestration hint');

    // Build is a different category — should still nudge
    const result2 = runHook('npm run build');
    expect(result2).toContain('Orchestration hint');
  });

  it('writes a per-category marker flag with private permissions', () => {
    runHook('npm test');
    const flag = path.join(flagsDir, 'test.flag');
    expect(fs.existsSync(flag)).toBe(true);
    expectPrivateFile(flag);
  });

  it('marker files are independent per category (no shared state to clobber)', () => {
    runHook('npm test');
    runHook('npm run build');
    expect(fs.existsSync(path.join(flagsDir, 'test.flag'))).toBe(true);
    expect(fs.existsSync(path.join(flagsDir, 'build.flag'))).toBe(true);
    expect(fs.existsSync(path.join(flagsDir, 'lint.flag'))).toBe(false);
  });

  it('nudge is suppressed when the marker for that category already exists', () => {
    fs.mkdirSync(flagsDir, { recursive: true });
    // Pre-create the marker; the hook should treat the category as already throttled.
    fs.closeSync(fs.openSync(path.join(flagsDir, 'test.flag'), 'w', 0o600));
    const result = runHook('npm test');
    expect(result).toBe('');
  });
});
