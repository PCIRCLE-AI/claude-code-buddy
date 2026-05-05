import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  resolvePluginRoot,
  readHookConfig,
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
    const fakeFile = '/abs/path/to/pkg/scripts/hooks/session-start.js';
    const url = pathToFileURL(fakeFile).toString();
    expect(resolvePluginRoot(url)).toBe('/abs/path/to/pkg');
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
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
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
