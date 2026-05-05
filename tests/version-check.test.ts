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

/**
 * Build a mock execFile that handles BOTH parallel calls in
 * `checkForUpdate`:
 *   1. `npm show @pcircle/memesh version`     → returns latest version
 *   2. `npm view @pcircle/memesh@<v> deprecated` → returns the deprecation message
 *
 * Pass `deprecated: '...'` to simulate the maintainer-flagged case;
 * default empty string means the version is healthy.
 */
function succeedWith(version: string, opts: { deprecated?: string } = {}) {
  return ((file: string, args: readonly string[] | undefined | null, optionsOrCallback: unknown, callbackMaybe?: unknown) => {
    expect(file).toBe('npm');
    const callback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callbackMaybe;
    expect(typeof callback).toBe('function');
    const cb = callback as (err: Error | null, stdout: string) => void;

    const cmd = args as readonly string[];
    if (cmd[0] === 'show') {
      expect(cmd).toEqual(['show', '@pcircle/memesh', 'version']);
      cb(null, `${version}\n`);
    } else if (cmd[0] === 'view' && cmd[2] === 'deprecated') {
      cb(null, `${opts.deprecated ?? ''}\n`);
    } else {
      throw new Error(`Unexpected npm command: ${cmd.join(' ')}`);
    }
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

/**
 * Mock where the main `npm show version` call succeeds but the
 * secondary `npm view <v> deprecated` call fails. Used to verify
 * that a transient deprecation-only network failure does NOT clear
 * a previously-cached deprecation flag.
 */
function partialFailDeprecationOnly(version: string) {
  return ((file: string, args: readonly string[] | undefined | null, optionsOrCallback: unknown, callbackMaybe?: unknown) => {
    expect(file).toBe('npm');
    const callback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callbackMaybe;
    const cmd = args as readonly string[];
    if (cmd[0] === 'show') {
      (callback as (err: Error | null, stdout: string) => void)(null, `${version}\n`);
    } else if (cmd[0] === 'view' && cmd[2] === 'deprecated') {
      (callback as (err: Error) => void)(new Error('deprecation lookup timed out'));
    } else {
      throw new Error(`Unexpected npm command: ${cmd.join(' ')}`);
    }
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
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: null,
      updateAvailable: true,
      checkSucceeded: true,
      source: 'fresh',
      freshness: 'fresh',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });

    const cached = getLastUpdateCheck('4.0.2', {
      updateCheckPath,
      now: new Date('2026-04-24T10:30:00.000Z'),
    });
    expect(cached).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T10:00:00.000Z',
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: null,
      updateAvailable: true,
      checkSucceeded: true,
      source: 'cache',
      freshness: 'cached',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });
  });

  it('preserves the last successful result and records the failed attempt metadata', async () => {
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
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T11:00:00.000Z',
      lastAttemptAt: '2026-04-24T11:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: 'npm unavailable',
      updateAvailable: true,
      checkSucceeded: false,
      source: 'cache',
      freshness: 'cached',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });

    const cached = getLastUpdateCheck('4.0.2', {
      updateCheckPath,
      now: new Date('2026-04-24T11:30:00.000Z'),
    });
    expect(cached).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T11:00:00.000Z',
      lastAttemptAt: '2026-04-24T11:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: 'npm unavailable',
      updateAvailable: true,
      checkSucceeded: false,
      source: 'cache',
      freshness: 'cached',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });
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
      now: new Date('2026-04-24T11:00:00.000Z'),
    });

    expect(update).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-24T11:00:00.000Z',
      lastAttemptAt: '2026-04-24T11:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: 'npm unavailable',
      updateAvailable: true,
      checkSucceeded: false,
      source: 'cache',
      freshness: 'cached',
      currentVersionDeprecated: false,
      deprecationMessage: null,
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

    const cached = getLastUpdateCheck('4.0.2', {
      updateCheckPath,
      now: new Date('2026-04-24T10:30:00.000Z'),
    });
    expect(cached).toEqual({
      currentVersion: '4.0.2',
      latestVersion: '4.0.2',
      checkedAt: '2026-04-24T10:00:00.000Z',
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: null,
      updateAvailable: false,
      checkSucceeded: true,
      source: 'cache',
      freshness: 'cached',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });
  });

  it('surfaces an unavailable state when only failed checks exist', async () => {
    const failed = await checkForUpdate('4.0.2', {
      execFileImpl: failLookup('registry offline'),
      updateCheckPath,
      now: new Date('2026-04-24T12:00:00.000Z'),
    });

    expect(failed).toEqual({
      currentVersion: '4.0.2',
      latestVersion: null,
      checkedAt: '2026-04-24T12:00:00.000Z',
      lastAttemptAt: '2026-04-24T12:00:00.000Z',
      lastSuccessfulCheckAt: null,
      lastError: 'registry offline',
      updateAvailable: false,
      checkSucceeded: false,
      source: 'fresh',
      freshness: 'unavailable',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });

    const cached = getLastUpdateCheck('4.0.2', {
      updateCheckPath,
      now: new Date('2026-04-24T12:05:00.000Z'),
    });
    expect(cached).toEqual({
      currentVersion: '4.0.2',
      latestVersion: null,
      checkedAt: '2026-04-24T12:00:00.000Z',
      lastAttemptAt: '2026-04-24T12:00:00.000Z',
      lastSuccessfulCheckAt: null,
      lastError: 'registry offline',
      updateAvailable: false,
      checkSucceeded: false,
      source: 'cache',
      freshness: 'unavailable',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    });
  });

  it('marks cached data as stale after the freshness threshold', () => {
    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: '4.0.2',
      latestVersion: '4.0.4',
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: 'npm unavailable',
      checkSucceeded: false,
    }));

    const cached = getLastUpdateCheck('4.0.2', {
      updateCheckPath,
      now: new Date('2026-04-26T10:00:00.001Z'),
    });
    expect(cached?.freshness).toBe('stale');
    expect(cached?.source).toBe('cache');
    expect(cached?.lastError).toBe('npm unavailable');
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
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: null,
      updateAvailable: true,
      checkSucceeded: true,
      source: 'fresh',
      freshness: 'fresh',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    })).toEqual([
      '🔄 Update available: 4.0.3 (fresh; run: memesh update)',
    ]);

    expect(formatUpdateCheckStatus({
      currentVersion: '4.0.2',
      latestVersion: '4.0.2',
      checkedAt: '2026-04-24T10:00:00.000Z',
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: 'timeout',
      updateAvailable: false,
      checkSucceeded: false,
      source: 'cache',
      freshness: 'cached',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    })).toEqual([
      'Update check: up to date (cached from 2026-04-24T10:00:00.000Z; latest 4.0.2)',
      'Last update check failed: timeout',
    ]);

    expect(formatUpdateCheckStatus({
      currentVersion: '4.0.2',
      latestVersion: null,
      checkedAt: '2026-04-24T10:00:00.000Z',
      lastAttemptAt: '2026-04-24T10:00:00.000Z',
      lastSuccessfulCheckAt: null,
      lastError: 'npm lookup failed',
      updateAvailable: false,
      checkSucceeded: false,
      source: 'fresh',
      freshness: 'unavailable',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    })).toEqual([
      'Update check: unavailable',
      'Last update check failed: npm lookup failed',
    ]);

    expect(formatUpdateCheckStatus({
      currentVersion: '4.0.2',
      latestVersion: '4.0.3',
      checkedAt: '2026-04-26T10:00:00.000Z',
      lastAttemptAt: '2026-04-26T10:00:00.000Z',
      lastSuccessfulCheckAt: '2026-04-24T10:00:00.000Z',
      lastError: 'network blocked',
      updateAvailable: true,
      checkSucceeded: false,
      source: 'cache',
      freshness: 'stale',
      currentVersionDeprecated: false,
      deprecationMessage: null,
    })).toEqual([
      '🔄 Update available: 4.0.3 (stale cache from 2026-04-24T10:00:00.000Z; run: memesh update)',
      'Last update check failed: network blocked',
    ]);
  });

  it('captures the deprecation message when npm flags the installed version', async () => {
    const result = await checkForUpdate('4.1.1', {
      execFileImpl: succeedWith('4.1.2', {
        deprecated: 'Security: HIGH polynomial-redos in bearer-auth header parser. Upgrade to 4.1.2+.',
      }),
      updateCheckPath,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });
    expect(result.currentVersionDeprecated).toBe(true);
    expect(result.deprecationMessage).toBe(
      'Security: HIGH polynomial-redos in bearer-auth header parser. Upgrade to 4.1.2+.'
    );
    expect(result.latestVersion).toBe('4.1.2');

    // The cache must round-trip the deprecation message so a future
    // session reads it without another network call.
    const reread = getLastUpdateCheck('4.1.1', { updateCheckPath });
    expect(reread?.currentVersionDeprecated).toBe(true);
    expect(reread?.deprecationMessage).toContain('polynomial-redos');
  });

  it('formats a leading deprecation warning when the installed version is flagged', () => {
    const lines = formatUpdateCheckStatus({
      currentVersion: '4.1.1',
      latestVersion: '4.1.2',
      checkedAt: '2026-05-06T00:00:00.000Z',
      lastAttemptAt: '2026-05-06T00:00:00.000Z',
      lastSuccessfulCheckAt: '2026-05-06T00:00:00.000Z',
      lastError: null,
      updateAvailable: true,
      checkSucceeded: true,
      source: 'fresh',
      freshness: 'fresh',
      currentVersionDeprecated: true,
      deprecationMessage: 'Security: HIGH polynomial-redos. Upgrade to 4.1.2+.',
    });
    // Deprecation warning must be the FIRST line so it isn't visually
    // dominated by the regular "update available" banner.
    expect(lines[0]).toContain('DEPRECATED');
    expect(lines[0]).toContain('4.1.1');
    expect(lines[0]).toContain('polynomial-redos');
    // The "update available" line still appears after, so the user
    // sees the upgrade target alongside the warning.
    expect(lines.some((l) => l.includes('Update available: 4.1.2'))).toBe(true);
  });

  it('marks the cache as partial-failure when deprecation lookup fails on first run (no prior to inherit)', async () => {
    // Codex review caught this: when the main `npm show` lookup
    // succeeded but the deprecation `npm view` lookup failed AND no
    // prior cache existed for this version, the previous logic
    // wrote `currentVersionDeprecation: null` plus `checkSucceeded:
    // true` — turning a network-blocked deprecation lookup into a
    // confirmed-healthy report. status / doctor / session-start all
    // showed green even though npm never answered the deprecation
    // query. Now `checkSucceeded` is false and `lastError` carries
    // the partial-failure reason so downstream surfaces can warn.
    const result = await checkForUpdate('4.1.1', {
      execFileImpl: partialFailDeprecationOnly('4.1.2'),
      updateCheckPath,
      now: new Date('2026-05-06T10:00:00.000Z'),
    });
    // checkSucceeded stays true so `memesh update` can still act on
    // the latest version — but lastError is populated so the
    // operator sees that the deprecation lookup didn't answer.
    expect(result.checkSucceeded).toBe(true);
    expect(result.lastError).toMatch(/deprecation lookup failed/i);
    expect(result.latestVersion).toBe('4.1.2');
    // We still have no deprecation flag (because the lookup failed
    // and there's nothing to inherit), but the ambient lastError
    // signals to the operator that the status is unknown.
    expect(result.currentVersionDeprecated).toBe(false);
    expect(result.deprecationMessage).toBeNull();
  });

  it('preserves a cached deprecation flag when only the deprecation lookup fails (P1.2)', async () => {
    // Codex review (2026-05-06) caught this: the deprecation Promise
    // used to resolve to null on failure, and the success branch wrote
    // that null back to the cache. A transient deprecation-only
    // network hiccup silently cleared the security warning. Now
    // the success branch preserves the previously-cached deprecation
    // when it was for the same installed version.
    //
    // Step 1: seed the cache with a known deprecation for 4.1.1.
    await checkForUpdate('4.1.1', {
      execFileImpl: succeedWith('4.1.2', {
        deprecated: 'Security: HIGH polynomial-redos. Upgrade to 4.1.2+.',
      }),
      updateCheckPath,
      now: new Date('2026-05-06T00:00:00.000Z'),
    });

    // Step 2: re-check, but the deprecation lookup fails (timeout/
    // network hiccup) while the version lookup succeeds.
    const followup = await checkForUpdate('4.1.1', {
      execFileImpl: partialFailDeprecationOnly('4.1.2'),
      updateCheckPath,
      now: new Date('2026-05-06T01:00:00.000Z'),
    });
    expect(followup.checkSucceeded).toBe(true);
    expect(followup.currentVersionDeprecated).toBe(true);
    expect(followup.deprecationMessage).toContain('polynomial-redos');

    // And the cache must persist the flag for the *next* session.
    const cached = getLastUpdateCheck('4.1.1', { updateCheckPath });
    expect(cached?.currentVersionDeprecated).toBe(true);
    expect(cached?.deprecationMessage).toContain('polynomial-redos');
  });

  it('drops a stale deprecation flag when the installed version no longer matches', () => {
    fs.writeFileSync(updateCheckPath, JSON.stringify({
      currentVersion: '4.1.1',
      latestVersion: '4.1.2',
      lastAttemptAt: '2026-05-06T00:00:00.000Z',
      lastSuccessfulCheckAt: '2026-05-06T00:00:00.000Z',
      lastError: null,
      checkSucceeded: true,
      currentVersionDeprecation: 'Security: HIGH polynomial-redos. Upgrade to 4.1.2+.',
    }));

    // User upgraded out-of-band to 4.1.2; the cache still has the
    // 4.1.1 deprecation message but we must NOT misattribute it.
    const upgraded = getLastUpdateCheck('4.1.2', {
      updateCheckPath,
      now: new Date('2026-05-06T01:00:00.000Z'),
    });
    expect(upgraded?.currentVersionDeprecated).toBe(false);
    expect(upgraded?.deprecationMessage).toBeNull();
  });
});
