import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

// DX regression: `memesh nonexistent-cmd` used to emit a confusing
//   "error: too many arguments. Expected 0 arguments but got 1."
// because Commander's default rejection runs before the root action's
// `program.args` inspection. The fix uses `.allowExcessArguments(true)`
// so the root action can detect stray positional args and emit a clear
// "unknown command 'foo'" message. Pin the behavior here so a future
// Commander upgrade or refactor cannot silently regress it.

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: process.env.HOME ?? process.env.USERPROFILE ?? '' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      exitCode: err.status ?? 1,
    };
  }
}

describe('CLI: unknown subcommand', () => {
  it('exits 1 with clean "unknown command" message', () => {
    const result = runCli(['nonexistent-cmd']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command 'nonexistent-cmd'");
    expect(result.stderr).toContain("memesh --help");
    // Anti-regression: the old "too many arguments" message must not return.
    expect(result.stderr).not.toContain('too many arguments');
  });

  it('--version still works (allowExcessArguments did not break flag parsing)', () => {
    const result = runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
