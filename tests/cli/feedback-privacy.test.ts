/**
 * `memesh feedback` publishes to a PUBLIC issue tracker. Two things were wrong.
 *
 * 1. It carried the account name into it. The body is composed from `doctor`
 *    output, and doctor names paths — the database, the config file, where
 *    `memesh` resolves on PATH. On a normal install every one of those begins
 *    with the home directory, so a measured run put `%2FUsers%2F<name>` in the
 *    issue URL twice.
 * 2. Without `--no-open` the body was never shown in the terminal. It is
 *    rendered in the GitHub form, but below the fold of a page the user opened
 *    in order to type — the diagnostics block scrolls past and is submitted
 *    unread.
 *
 * The redaction test asserts the absence of a string, which is the weak
 * direction: a `feedback` that printed nothing at all would pass it. So each
 * case also asserts the positive — that the redacted path is still THERE, as
 * `~/...`. Absence plus presence is the pair; absence alone is not evidence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;
let binDir: string;

function runCli(args: string[], extraEnv: Record<string, string> = {}): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? '', exitCode: e.status ?? 1 };
  }
}

/** The decoded `body` query parameter of the pre-filled issue URL. */
function issueBody(stdout: string): string {
  const url = stdout.trim().split('\n').find((l) => l.startsWith('https://github.com/'));
  expect(url, `no issue URL in output:\n${stdout}`).toBeDefined();
  const body = new URL(url as string).searchParams.get('body');
  expect(body, 'the issue URL has no body parameter').toBeTruthy();
  return decodeURIComponent(body as string);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-feedback-'));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-fakebin-'));
});
afterEach(() => {
  for (const dir of [home, binDir]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('CLI: feedback does not publish the account name', () => {
  it('replaces the home directory with ~ in the issue body', () => {
    const r = runCli(['feedback', '--no-open']);
    expect(r.exitCode).toBe(0);
    const body = issueBody(r.stdout);

    // Both spellings: macOS resolves a temp HOME through /private.
    const forms = new Set([home, fs.realpathSync(home)]);
    for (const form of forms) {
      expect(body, `the issue body still contains the home path ${form}`).not.toContain(form);
    }

    // The positive half. Without this, a feedback command that emitted an
    // empty diagnostics block would satisfy every assertion above.
    expect(body, 'the database path is gone entirely, not redacted').toContain('~');
    expect(body).toMatch(/~[\\/]\.memesh[\\/]knowledge-graph\.db/);
  });

  it('still includes the install ID, and still lets the user drop it', () => {
    // Redaction is not censorship: the diagnostics are the point of the
    // command. What changes is the account name, not the report.
    const withDiagnostics = issueBody(runCli(['feedback', '--no-open']).stdout);
    expect(withDiagnostics).toContain('Anonymous install ID');
    expect(withDiagnostics).toContain('**Diagnostics**');

    const without = issueBody(runCli(['feedback', '--no-open', '--no-diagnostics']).stdout);
    expect(without).not.toContain('Anonymous install ID');
    expect(without).not.toContain('**Diagnostics**');
  });

  // A stub `open` / `xdg-open` on PATH: the command really does spawn its
  // browser opener, and this makes that harmless instead of unobservable.
  it.skipIf(process.platform === 'win32')(
    'prints the body in the terminal before opening the browser',
    () => {
      for (const name of ['open', 'xdg-open']) {
        const stub = path.join(binDir, name);
        fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(stub, 0o755);
      }
      const r = runCli(['feedback'], { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` });
      expect(r.exitCode).toBe(0);

      expect(r.stdout).toContain('PUBLIC GitHub issue');
      expect(r.stdout, 'the diagnostics block is never shown').toContain('**Diagnostics**');
      expect(r.stdout).toContain('--no-diagnostics');
      expect(r.stdout).toContain('Opened browser');

      // And the printed copy is redacted too — showing the user a clean body
      // while sending a dirty one would be worse than not showing it.
      expect(r.stdout).not.toContain(fs.realpathSync(home));
    }
  );
});
