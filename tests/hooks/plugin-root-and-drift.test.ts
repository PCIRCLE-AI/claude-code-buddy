import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  resolvePluginRoot,
  readHookConfig,
  importFromPluginRoot,
  // @ts-ignore — _shared.js is JS, not TS
} from '../../scripts/hooks/_shared.js';

// Codex review (2026-05-05) caught two regressions in scripts/hooks/:
//
//   1. P1: pluginRoot was `dirname(dirname(fileURLToPath(...)))` — only
//      two hops, resolves to <pkg>/scripts not <pkg>. Dynamic imports
//      then look for <pkg>/scripts/dist/db.js (does not exist), the
//      surrounding catch swallows ENOENT, and weekly noise compression
//      + LLM failure analysis go silently dead. This test pins three
//      hops as the only correct answer for files at scripts/hooks/X.js.
//
//   2. P2 (drift): readHookConfig used dirname(MEMESH_DB_PATH) so any
//      custom DB path silently broke `memesh config set …` from
//      reaching the hooks (CLI writes ~/.memesh/config.json, hooks read
//      somewhere else). Fix: hooks always read ~/.memesh/config.json,
//      matching src/core/config.ts. Tests verify MEMESH_DB_PATH no
//      longer redirects the lookup.

describe('resolvePluginRoot — three dirname hops to package root', () => {
  it('resolves <root>/scripts/hooks/X.js to <root>', () => {
    // Build the synthetic input from a real OS-shaped absolute path so
    // the test works on POSIX and Windows alike. On Windows
    // pathToFileURL normalises drive letters and back-slashes, then
    // fileURLToPath round-trips back to the OS form (D:\abs\path...);
    // a hard-coded '/abs/path/to/pkg' would fail there.
    const fakeFile = path.join(path.parse(process.cwd()).root, 'abs', 'path', 'to', 'pkg', 'scripts', 'hooks', 'session-start.js');
    const expectedRoot = path.join(path.parse(process.cwd()).root, 'abs', 'path', 'to', 'pkg');
    const url = pathToFileURL(fakeFile).toString();
    expect(resolvePluginRoot(url)).toBe(expectedRoot);
  });

  it('resolves the real session-start.js to a directory containing package.json', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const hookPath = path.join(repoRoot, 'scripts', 'hooks', 'session-start.js');
    const computed = resolvePluginRoot(pathToFileURL(hookPath).toString());
    // The proof: package.json sits at the package root. If the
    // computation drifts back to two hops, this assert fails.
    expect(fs.existsSync(path.join(computed, 'package.json'))).toBe(true);
    expect(computed).toBe(repoRoot);
  });

  it('resolves the real session-summary.js the same way', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const hookPath = path.join(repoRoot, 'scripts', 'hooks', 'session-summary.js');
    const computed = resolvePluginRoot(pathToFileURL(hookPath).toString());
    expect(computed).toBe(repoRoot);
  });
});

describe('hook → dist dynamic imports must be Windows-safe', () => {
  // Root cause of a 100%-Windows silent failure: ESM import() takes a URL,
  // and `import(join(pluginRoot, 'dist/db.js'))` passes an absolute path.
  // On POSIX it works by luck (leading '/'); on Windows 'D:\...' is read as
  // a 'd:' scheme and throws, killing LLM failure analysis, lesson creation,
  // dream auto-trigger and auto-decay — traced to stderr only, so doctor and
  // CI on macOS/Linux stayed green. This gate makes the discipline structural
  // instead of per-site: any hook that hand-rolls import(join(...)) fails here.
  const hooksDir = path.resolve(__dirname, '..', '..', 'scripts', 'hooks');

  // import(<expr>) where the argument begins with join(/path.join( — i.e. a
  // filesystem path rather than a URL. The sanctioned form is
  // importFromPluginRoot(...) or import(pathToFileURL(...).href).
  const RAW_PATH_IMPORT = /\bimport\(\s*(?:path\.)?join\(/;

  const hookFiles = fs
    .readdirSync(hooksDir)
    .filter((f) => f.endsWith('.js'));

  it('covers every shipped hook (guard is not vacuously empty)', () => {
    expect(hookFiles.length).toBeGreaterThanOrEqual(7);
  });

  for (const file of hookFiles) {
    it(`${file} uses no raw-path dynamic import()`, () => {
      const src = fs.readFileSync(path.join(hooksDir, file), 'utf8');
      const offending = src
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => RAW_PATH_IMPORT.test(line));
      expect(
        offending,
        `${file} has import(join(...)) — use importFromPluginRoot() so Windows ` +
          `('D:\\...') isn't rejected as a 'd:' URL scheme:\n` +
          offending.map((o) => `  L${o.n}: ${o.line.trim()}`).join('\n'),
      ).toEqual([]);
    });
  }

  it('importFromPluginRoot loads a real module cross-platform', async () => {
    // Prove the helper actually resolves + loads, using this repo as its own
    // plugin root and a dist module that exists after `npm run build`. If dist
    // is absent (pre-build source checkout), skip rather than false-fail.
    const repoRoot = path.resolve(__dirname, '..', '..');
    if (!fs.existsSync(path.join(repoRoot, 'dist', 'core', 'config.js'))) return;
    const mod = await importFromPluginRoot(repoRoot, 'dist/core/config.js');
    expect(typeof mod.readConfig).toBe('function');
  });
});

describe('readHookConfig — homedir is canonical, MEMESH_DB_PATH does not redirect', () => {
  let homeDir: string;
  let dbDir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-home-'));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-db-'));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function writeHomeConfig(obj: Record<string, unknown>) {
    const dir = path.join(homeDir, '.memesh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj));
  }
  function writeDbDirConfig(obj: Record<string, unknown>) {
    fs.writeFileSync(path.join(dbDir, 'config.json'), JSON.stringify(obj));
  }

  it('reads from ~/.memesh/config.json by default', () => {
    writeHomeConfig({ autoCapture: false, sessionLimit: 25 });
    const cfg = readHookConfig({} as NodeJS.ProcessEnv);
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.sessionLimit).toBe(25);
  });

  it('IGNORES dirname(MEMESH_DB_PATH)/config.json — drift fix', () => {
    // Pre-fix behavior would have read this file. Post-fix it must be
    // ignored even though MEMESH_DB_PATH is set to an entirely
    // different directory.
    writeDbDirConfig({ autoCapture: false, sessionLimit: 999 });
    const cfg = readHookConfig({
      MEMESH_DB_PATH: path.join(dbDir, 'kg.db'),
    } as NodeJS.ProcessEnv);
    expect(cfg.sessionLimit).toBeUndefined();
    expect(cfg.autoCapture).toBeUndefined();
  });

  it('homedir wins when both files exist (drift fix preserves the canonical path)', () => {
    writeHomeConfig({ sessionLimit: 11 });
    writeDbDirConfig({ sessionLimit: 22 });
    const cfg = readHookConfig({
      MEMESH_DB_PATH: path.join(dbDir, 'kg.db'),
    } as NodeJS.ProcessEnv);
    expect(cfg.sessionLimit).toBe(11);
  });

  it('returns {} when ~/.memesh/config.json is missing', () => {
    const cfg = readHookConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({});
  });

  it('returns {} on malformed JSON without throwing', () => {
    const dir = path.join(homeDir, '.memesh');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{not valid json');
    const cfg = readHookConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({});
  });
});
