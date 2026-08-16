import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * What `memesh recall` PRINTS, pinned at the spawn level. Two P7 findings
 * live here: a semantic-only result set used to be dressed exactly like a
 * keyword match (the core-trust defect), and a single oversized observation
 * used to flood the terminal in full on every hit.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = path.join(repoRoot, 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 120_000,
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.toString() ?? '', exitCode: err.status ?? -1 };
  }
}

describe('recall presentation: disclose what geometry cannot certify', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-recallp-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('an oversized observation is capped on display, storage untouched', () => {
    const big = `needle-alpha ${'lorem-filler '.repeat(300)}needle-omega`;
    const stored = runCli(['remember', big, '--name', 'big-note', '--type', 'note']);
    expect(stored.exitCode).toBe(0);

    const r = runCli(['recall', 'needle-alpha']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('big-note');
    expect(r.stdout, 'display must be capped').toContain('more chars)');
    expect(r.stdout, 'the tail of the full text must not print').not.toContain('needle-omega');

    // Storage untouched: JSON output carries the full observation.
    const j = runCli(['recall', 'needle-alpha', '--json']);
    expect(j.stdout).toContain('needle-omega');
  });

  it('--json is one object envelope carrying retrieval metadata, never a bare array', () => {
    // R2: the old output was a bare array normally and an object when
    // conflicts existed — bimodal, and with nowhere to say HOW the recall
    // was answered. The envelope now matches MCP/HTTP: {entities, retrieval,
    // conflicts?}, where retrieval reports mode / degraded / truncated.
    runCli(['remember', 'envelope-check unique-envelope-token', '--name', 'envelope-note', '--type', 'note']);
    const j = runCli(['recall', 'unique-envelope-token', '--json']);
    expect(j.exitCode).toBe(0);
    const parsed = JSON.parse(j.stdout);
    expect(Array.isArray(parsed)).toBe(false);
    expect(Array.isArray(parsed.entities)).toBe(true);
    expect(['fts', 'hybrid']).toContain(parsed.retrieval.mode);
    expect(typeof parsed.retrieval.degraded).toBe('boolean');
    expect(typeof parsed.retrieval.truncated).toBe('boolean');
  });

  it('a semantic-only result set announces itself instead of posing as a match', () => {
    runCli(['remember', 'lorem-ipsum-token lorem-ipsum-token dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore']);
    const r = runCli(['recall', 'xyzzyplughfrobozz quux']);
    expect(r.exitCode).toBe(0);
    if (r.stdout.includes('No results found.')) {
      // Also honest: in an environment where the embedder cannot run, the
      // vector supplement no-ops and nothing is fabricated.
      return;
    }
    expect(r.stdout).toContain('No keyword matches. Closest memories by meaning — may be unrelated:');
    expect(r.stdout).toContain('% semantic)');
  });
});
