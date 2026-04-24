import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkForUpdate,
  formatUpdateCheckStatus,
  getLastUpdateCheck,
  getUpdateCheck,
} from '../src/core/version-check.js';

function succeedWith(version: string) {
  return ((file: string, args: readonly string[] | undefined | null, optionsOrCallback: unknown, callbackMaybe?: unknown) => {
    expect(file).toBe('npm');
    expect(args).toEqual(['show', '@pcircle/memesh', 'version']);

    const callback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callbackMaybe;

    expect(typeof callback).toBe('function');
    (callback as (err: Error | null, stdout: string) => void)(null, `${version}\n`);
    return {} as never;
  }) as typeof import('child_process').execFile;
}

function failLookup(message = 'npm unavailable') {
  return ((_file: string, _args: readonly string[] | undefined | null, optionsOrCallback: unknown, callbackMaybe?: unknown) => {
    const callback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callbackMaybe;

    expect(typeof callback).toBe('function');
    (callback as (err: Error) => void)(new Error(message));
    return {} as never;
  }) as typeof import('child_process').execFile;
}

describe('version check', () => {
  let testDir: string;
  let updateCheckPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-version-check-'));
    updateCheckPath = path.join(testDir, 'update-check.json');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('writes successful fresh checks to cache', async () => {
    const result = await checkForUpdate('4.0.2', {
      execFileImpl: succeedWith('4.0.3'),
      updateCheckPath,
      now: new Date('2026-04-24T10:00:00.000Z'),
    });

    expect(result).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: true,
      checkSucceeded: true,
      source: 'fresh',
    });

    const cached = getLastUpdateCheck('4.0.2', { updateCheckPath });
    expect(cached).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: true,
      checkSucceeded: true,
      source: 'cache',
    });
  });

  it('does not overwrite the last successful cache entry on npm failure', async () => {
    await checkForUpdate('4.0.2', {
      execFileImpl: succeedWith('4.0.3'),
      updateCheckPath,
      now: new Date('2026-04-24T10:00:00.000Z'),
    });

    const failed = await checkForUpdate('4.0.2', {
      execFileImpl: failLookup(),
      updateCheckPath,
      now: new Date('2026-04-24T11:00:00.000Z'),
    });

    expect(failed).toEqual({
      currentVersion: '4.0.2',
      latestVersion: null,
      checkedAt: '2026-04-24T11:00:00.000Z',
      updateAvailable: false,
      checkSucceeded: false,
      source: 'fresh',
    });

    const cached = getLastUpdateCheck('4.0.2', { updateCheckPath });
    expect(cached?.latestVersion).toBe('4.0.3');
    expect(cached?.checkedAt).toBe('2026-04-24T10:00:00.000Z');
    expect(cached?.source).toBe('cache');
  });

  it('falls back to cached data when a fresh npm lookup fails', async () => {
    await checkForUpdate('4.0.2', {
      execFileImpl: succeedWith('4.0.3'),
      updateCheckPath,
      now: new Date('2026-04-24T10:00:00.000Z'),
    });

    const update = await getUpdateCheck('4.0.2', {
      execFileImpl: failLookup(),
      updateCheckPath,
    });

    expect(update).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: true,
      checkSucceeded: true,
      source: 'cache',
    });
  });

  it('recomputes cached update availability against the current installed version', () => {
    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: '4.0.1',
      latestVersion: '4.0.2',
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: true,
      checkSucceeded: true,
    }));

    const cached = getLastUpdateCheck('4.0.2', { updateCheckPath });
    expect(cached?.updateAvailable).toBe(false);
    expect(cached?.latestVersion).toBe('4.0.2');
    expect(cached?.currentVersion).toBe('4.0.2');
  });

  it('returns null for malformed cache files', () => {
    fs.writeFileSync(updateCheckPath, '{not valid json');

    expect(getLastUpdateCheck('4.0.2', { updateCheckPath })).toBeNull();
  });

  it('formats fresh and cached status lines honestly', () => {
    expect(formatUpdateCheckStatus({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: true,
      checkSucceeded: true,
      source: 'fresh',
    })).toEqual([
      '🔄 Update available: 4.0.3 (fresh; run: memesh update)',
    ]);

    expect(formatUpdateCheckStatus({
      currentVersion: '4.0.2',
      latestVersion: '4.0.2',
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: false,
      checkSucceeded: true,
      source: 'cache',
    })).toEqual([
      'Update check: up to date (cached from 2026-04-24T10:00:00.000Z; latest 4.0.2)',
    ]);

    expect(formatUpdateCheckStatus({
      currentVersion: '4.0.2',
      latestVersion: null,
      checkedAt: '2026-04-24T10:00:00.000Z',
      updateAvailable: false,
      checkSucceeded: false,
      source: 'fresh',
    })).toEqual([
      'Update check: unavailable (npm lookup failed and no cached result exists)',
    ]);
  });
});
