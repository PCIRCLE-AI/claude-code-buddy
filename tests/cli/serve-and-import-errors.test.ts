/**
 * Three ways an ordinary mistake produced a crash dump or a lie.
 *
 *   C10  `serve --allow-remote` on the default loopback host generates no
 *        token and requires no auth — measured: `/v1/entities` answered 200
 *        unauthenticated — while `--help` stated unconditionally that a token
 *        is generated and required. Auth is keyed to the bind ADDRESS, not to
 *        the flag.
 *   C12  A bundle whose entry has no `type` surfaced `Provided value cannot be
 *        bound to SQLite parameter 2`. A bundle whose `entities` is a string
 *        was iterated CHARACTER BY CHARACTER, reporting four entities called
 *        `undefined`.
 *   C13  `serve --host 0.0.0.0` without `--allow-remote` refuses, correctly,
 *        with a sentence that tells you exactly what to do — and threw it out
 *        of an async action, so it arrived under a ten-frame Node dump with
 *        three absolute install paths.
 *
 * Every case asserts the exit code as well as the text. A refusal that prints
 * a complaint and exits 0 is not a refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'transports', 'cli', 'cli.js');

let home: string;

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
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

/** A stack dump is what all three of these produced. */
function expectNoStackTrace(output: string): void {
  expect(output, 'a Node stack frame reached the user').not.toMatch(/\n\s+at\s/);
  expect(output, 'an absolute install path reached the user').not.toMatch(/file:\/\/\//);
}

function writeBundle(name: string, body: unknown): string {
  const file = path.join(home, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-serveimport-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('import: a malformed bundle is described in its own terms (C12)', () => {
  it('names the missing field instead of a SQLite parameter number', () => {
    const file = writeBundle('no-type.json', {
      version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
      entities: [{ name: 'x', observations: [], tags: [] }],
    });
    const r = runCli(['import', file]);
    const out = r.stdout + r.stderr;

    expect(out).toContain('entities[0]');
    expect(out).toContain('"type"');
    expect(out, 'the storage layer\'s parameter numbering reached the user').not.toContain('SQLite parameter');
    expect(r.exitCode).toBe(1);
  });

  it('refuses a bundle whose entities is a string instead of iterating its characters', () => {
    const file = writeBundle('string-entities.json', {
      version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
      entities: 'oops',
    });
    const r = runCli(['import', file]);
    const out = r.stdout + r.stderr;

    expect(out).toMatch(/no "entities" array/);
    expect(out).toContain('found string');
    expect(out, 'characters were imported as entities').not.toMatch(/undefined:/);
    expect(r.exitCode).toBe(1);
    expectNoStackTrace(out);
  });

  it('still imports a well-formed bundle', () => {
    // Without this the two cases above are satisfied by an import command that
    // refuses everything.
    const file = writeBundle('good.json', {
      version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 1,
      entities: [{ name: 'alpha', type: 'note', namespace: 'personal', observations: ['hi'], tags: [], relations: [] }],
    });
    const r = runCli(['import', file]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('Imported: 1');
    expect(runCli(['recall', 'alpha', '--json']).stdout).toContain('alpha');
  });

  it('imports the good entries of a partly-broken bundle and reports the rest', () => {
    const file = writeBundle('mixed.json', {
      version: '3.0.0', exported_at: '2026-08-10T00:00:00.000Z', entity_count: 2,
      entities: [
        { name: 'beta', type: 'note', namespace: 'personal', observations: ['ok'], tags: [], relations: [] },
        { name: 'gamma' },
      ],
    });
    const r = runCli(['import', file]);
    expect(r.stdout).toContain('Imported: 1');
    expect(r.stderr).toContain('entities[1]');
    expect(r.exitCode).toBe(1);
  });
});

describe('serve: refusing a remote bind is not a crash (C13)', () => {
  it('prints the reason and exits 1, with no stack frames', () => {
    const r = runCli(['serve', '--host', '0.0.0.0']);
    const out = r.stdout + r.stderr;

    expect(out).toMatch(/Refusing to bind/);
    expect(out).toMatch(/--allow-remote/);
    expect(r.exitCode).toBe(1);
    expectNoStackTrace(out);
  });
});

describe('serve --help: the token sentence is conditional (C10)', () => {
  it('says the token applies to a non-loopback bind, not to the flag', () => {
    const help = runCli(['serve', '--help']).stdout;

    // The claim has to be tied to the bind address. The old text promised a
    // token unconditionally, and `--allow-remote` alone produces none.
    expect(help).toMatch(/non-loopback bind a bearer token is generated/);
    expect(help).toMatch(/default loopback host this flag changes nothing/i);
  });

  it('says at startup that --allow-remote on loopback did nothing', async () => {
    const { spawn } = await import('child_process');
    // A free port, so this cannot collide with anything the developer runs.
    const child = spawn('node', [CLI_PATH, 'serve', '--allow-remote', '--port', '0'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });

    // Wait for the server to announce itself, then stop it.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.stdout.on('data', done);
      setTimeout(done, 4000);
    });
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));

    expect(stderr, `stderr was:\n${stderr}`).toMatch(/--allow-remote has no effect on loopback/);
    expect(stderr).not.toMatch(/bearer token generated/);
  });
});
