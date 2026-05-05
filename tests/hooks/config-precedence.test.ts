import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isAgenticOrchestrationEnabled,
  isAutoCaptureEnabled,
  resolveSessionLimit,
  // @ts-ignore — _shared.js is JS, not TS
} from '../../scripts/hooks/_shared.js';

// Item #11 regression: env-only feature flags now have config-file
// fallbacks. Pin the precedence rules: env > config > default.

let tmpDir: string;
let savedDbPath: string | undefined;

function writeConfig(obj: Record<string, unknown>) {
  const dir = path.join(tmpDir, '.memesh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj));
}

function envFor(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    MEMESH_DB_PATH: path.join(tmpDir, '.memesh', 'kg.db'),
    ...extra,
  } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-cfg-prec-'));
  savedDbPath = process.env.MEMESH_DB_PATH;
});

afterEach(() => {
  if (savedDbPath === undefined) delete process.env.MEMESH_DB_PATH;
  else process.env.MEMESH_DB_PATH = savedDbPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isAgenticOrchestrationEnabled — env > config > default(false)', () => {
  it('default off when neither env nor config sets it', () => {
    expect(isAgenticOrchestrationEnabled(envFor())).toBe(false);
  });

  it('config { enableAgenticOrchestration: true } enables it', () => {
    writeConfig({ enableAgenticOrchestration: true });
    expect(isAgenticOrchestrationEnabled(envFor())).toBe(true);
  });

  it('env=1 wins over config=false', () => {
    writeConfig({ enableAgenticOrchestration: false });
    expect(isAgenticOrchestrationEnabled(envFor({ MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '1' }))).toBe(true);
  });

  it('env=0 wins over config=true (env explicit disable)', () => {
    writeConfig({ enableAgenticOrchestration: true });
    expect(isAgenticOrchestrationEnabled(envFor({ MEMESH_ENABLE_AGENTIC_ORCHESTRATION: '0' }))).toBe(false);
  });

  it('only env=1 enables (truthy "true" or "yes" do not, by design)', () => {
    expect(isAgenticOrchestrationEnabled(envFor({ MEMESH_ENABLE_AGENTIC_ORCHESTRATION: 'true' }))).toBe(false);
    expect(isAgenticOrchestrationEnabled(envFor({ MEMESH_ENABLE_AGENTIC_ORCHESTRATION: 'yes' }))).toBe(false);
  });
});

describe('isAutoCaptureEnabled — env > config > default(true)', () => {
  it('default on when neither env nor config sets it', () => {
    expect(isAutoCaptureEnabled(envFor())).toBe(true);
  });

  it('config { autoCapture: false } disables it', () => {
    writeConfig({ autoCapture: false });
    expect(isAutoCaptureEnabled(envFor())).toBe(false);
  });

  it('env=false wins over config=true', () => {
    writeConfig({ autoCapture: true });
    expect(isAutoCaptureEnabled(envFor({ MEMESH_AUTO_CAPTURE: 'false' }))).toBe(false);
  });

  it('env=true wins over config=false', () => {
    writeConfig({ autoCapture: false });
    expect(isAutoCaptureEnabled(envFor({ MEMESH_AUTO_CAPTURE: 'true' }))).toBe(true);
  });
});

describe('resolveSessionLimit — env > config > default(10)', () => {
  it('default 10 when neither env nor config sets it', () => {
    expect(resolveSessionLimit(envFor())).toBe(10);
  });

  it('config sessionLimit=25 takes effect', () => {
    writeConfig({ sessionLimit: 25 });
    expect(resolveSessionLimit(envFor())).toBe(25);
  });

  it('env=50 wins over config=25', () => {
    writeConfig({ sessionLimit: 25 });
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: '50' }))).toBe(50);
  });

  it('invalid env value falls back to config', () => {
    writeConfig({ sessionLimit: 25 });
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: 'not-a-number' }))).toBe(25);
  });

  it('zero or negative env values fall back', () => {
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: '0' }))).toBe(10);
    expect(resolveSessionLimit(envFor({ MEMESH_SESSION_LIMIT: '-5' }))).toBe(10);
  });
});
