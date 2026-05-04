import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { expectPrivateFile } from '../helpers/permissions.js';

describe('Feature: Pre-Bash Orchestration Nudge Hook', () => {
  let testDir: string;
  let memeshDir: string;
  let throttleFile: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-nudge-test-'));
    // We set MEMESH_DB_PATH to a file inside testDir; the hook derives memeshDir
    // from dirname(MEMESH_DB_PATH), matching getMemeshDir() in _shared.js
    memeshDir = testDir;
    throttleFile = path.join(memeshDir, 'agent-nudge-shown.json');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function runHook(command: string): string {
    const hookPath = path.resolve('scripts/hooks/pre-bash-orchestration-nudge.js');
    const dbPath = path.join(testDir, 'knowledge-graph.db'); // file doesn't need to exist
    const jsonInput = JSON.stringify({ tool_input: { command } });
    try {
      return execFileSync('node', [hookPath], {
        input: jsonInput,
        env: { ...process.env, MEMESH_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: 10000,
      }).trim();
    } catch {
      return '';
    }
  }

  // --- Matching cases: should emit a nudge ---

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

  it('writes throttle state file with private permissions', () => {
    runHook('npm test');
    expect(fs.existsSync(throttleFile)).toBe(true);
    expectPrivateFile(throttleFile);
  });

  it('throttle state file records correct category', () => {
    runHook('npm test');
    const state = JSON.parse(fs.readFileSync(throttleFile, 'utf8'));
    expect(state['test']).toBe(true);
    expect(state['build']).toBeUndefined();
  });

  it('survives corrupt throttle file without crashing', () => {
    // Write garbage into the throttle file
    fs.mkdirSync(memeshDir, { recursive: true });
    fs.writeFileSync(throttleFile, '{ not valid json !!!', 'utf8');

    // Hook should not throw and should still emit a nudge
    const result = runHook('npm test');
    expect(result).toContain('Orchestration hint');
  });
});
