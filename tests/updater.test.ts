import { describe, expect, it } from 'vitest';
import {
  classifyBump,
  decideAutoUpdate,
  getInstalledGlobalVersion,
  parseAutoUpdatePolicy,
  runGlobalUpdate,
} from '../src/core/updater.js';

function makeExecFileSyncMock(handlers: {
  install?: (args: string[], options: Record<string, unknown>) => void;
  ls?: (args: string[], options: Record<string, unknown>) => string;
}) {
  return ((
    file: string,
    args: readonly string[] | undefined | null,
    options: Record<string, unknown> = {},
  ) => {
    expect(file).toBe('npm');
    expect(Array.isArray(args)).toBe(true);

    const command = args as string[];
    if (command[0] === 'install') {
      handlers.install?.(command, options);
      return '';
    }

    if (command[0] === 'ls') {
      // `command` is forwarded, not discarded. The mock used to call
      // `handlers.ls()` with no arguments, so nothing could see WHICH npm
      // command had been run: dropping `-g` from `npm ls` left every test
      // green while the updater read the LOCAL tree and reported the global
      // package as missing.
      return handlers.ls?.(command, options) ?? JSON.stringify({});
    }

    throw new Error(`Unexpected command: ${command.join(' ')}`);
  }) as typeof import('child_process').execFileSync;
}

describe('updater', () => {
  it('reads the installed global version from npm ls output — and asks GLOBALLY', () => {
    let lsArgs: string[] = [];
    const version = getInstalledGlobalVersion({
      execFileSyncImpl: makeExecFileSyncMock({
        ls: (args) => {
          lsArgs = args;
          return JSON.stringify({
            dependencies: {
              '@pcircle/memesh': { version: '4.0.2' },
            },
          });
        },
      }),
    });

    expect(version).toBe('4.0.2');
    // The half that was missing. `npm ls` without `-g` reads the CURRENT
    // project, so the updater would report a globally-installed memesh as
    // absent — and refuse to update it — with every assertion above still
    // green.
    expect(lsArgs, 'npm ls was asked about the local tree, not the global one').toContain('-g');
  });

  it('returns null when npm ls does not report a global install', () => {
    const version = getInstalledGlobalVersion({
      execFileSyncImpl: makeExecFileSyncMock({
        ls: () => JSON.stringify({ dependencies: {} }),
      }),
    });

    expect(version).toBeNull();
  });

  it('installs and verifies the requested latest version', () => {
    let installedSpec = '';

    const result = runGlobalUpdate('4.0.3', {
      execFileSyncImpl: makeExecFileSyncMock({
        install: (args) => {
          installedSpec = args[2];
        },
        ls: () => JSON.stringify({
          dependencies: {
            '@pcircle/memesh': { version: '4.0.3' },
          },
        }),
      }),
    });

    expect(installedSpec).toBe('@pcircle/memesh@4.0.3');
    expect(result).toEqual({ installedVersion: '4.0.3' });
  });

  it('bounds both the install and exact-version readback', () => {
    let installTimeout: unknown;
    let readbackTimeout: unknown;

    runGlobalUpdate('4.0.3', {
      installTimeoutMs: 1234,
      readbackTimeoutMs: 567,
      execFileSyncImpl: makeExecFileSyncMock({
        install: (_args, options) => { installTimeout = options.timeout; },
        ls: (_args, options) => {
          readbackTimeout = options.timeout;
          return JSON.stringify({
            dependencies: { '@pcircle/memesh': { version: '4.0.3' } },
          });
        },
      }),
    });

    expect(installTimeout).toBe(1234);
    expect(readbackTimeout).toBe(567);
  });

  it.each(['latest', '^4.0.3', '4.0.3 ', '4.0'])('rejects non-exact target %j before npm mutation', (target) => {
    let installCalled = false;
    expect(() => runGlobalUpdate(target, {
      execFileSyncImpl: makeExecFileSyncMock({
        install: () => { installCalled = true; },
      }),
    })).toThrow('refusing non-exact npm version target');
    expect(installCalled).toBe(false);
  });

  it('surfaces install timeout/nonzero failures without attempting readback', () => {
    let readbackCalled = false;
    const timedOut = Object.assign(new Error('install timed out'), { code: 'ETIMEDOUT' });
    expect(() => runGlobalUpdate('4.0.3', {
      execFileSyncImpl: makeExecFileSyncMock({
        install: () => { throw timedOut; },
        ls: () => {
          readbackCalled = true;
          return JSON.stringify({});
        },
      }),
    })).toThrow('install timed out');
    expect(readbackCalled).toBe(false);
  });

  it('fails when npm reports a different installed version after update', () => {
    expect(() => runGlobalUpdate('4.0.3', {
      execFileSyncImpl: makeExecFileSyncMock({
        ls: () => JSON.stringify({
          dependencies: {
            '@pcircle/memesh': { version: '4.0.2' },
          },
        }),
      }),
    })).toThrow('expected 4.0.3, but npm reports 4.0.2 is installed');
  });

  it('fails when npm does not report any installed global package after update', () => {
    expect(() => runGlobalUpdate('4.0.3', {
      execFileSyncImpl: makeExecFileSyncMock({
        ls: () => JSON.stringify({ dependencies: {} }),
      }),
    })).toThrow('npm did not report a global @pcircle/memesh installation after update');
  });
});

describe('parseAutoUpdatePolicy', () => {
  it('accepts the four canonical policy values', () => {
    expect(parseAutoUpdatePolicy('off')).toBe('off');
    expect(parseAutoUpdatePolicy('patch')).toBe('patch');
    expect(parseAutoUpdatePolicy('minor')).toBe('minor');
    expect(parseAutoUpdatePolicy('major')).toBe('major');
  });
  it('case-insensitive', () => {
    expect(parseAutoUpdatePolicy('PATCH')).toBe('patch');
    expect(parseAutoUpdatePolicy('Minor')).toBe('minor');
  });
  it('rejects garbage', () => {
    expect(parseAutoUpdatePolicy('yes')).toBeNull();
    expect(parseAutoUpdatePolicy('1')).toBeNull();
    expect(parseAutoUpdatePolicy('')).toBeNull();
    expect(parseAutoUpdatePolicy(undefined)).toBeNull();
    expect(parseAutoUpdatePolicy(42)).toBeNull();
  });
});

describe('classifyBump', () => {
  it('returns the largest bump kind', () => {
    expect(classifyBump('1.0.0', '1.0.1')).toBe('patch');
    expect(classifyBump('1.0.0', '1.1.0')).toBe('minor');
    expect(classifyBump('1.0.0', '2.0.0')).toBe('major');
    expect(classifyBump('1.0.0', '1.1.5')).toBe('minor');
    expect(classifyBump('1.0.0', '2.5.7')).toBe('major');
  });
  it('returns null for same-or-older targets (never auto-downgrade)', () => {
    expect(classifyBump('1.0.0', '1.0.0')).toBeNull();
    expect(classifyBump('1.0.1', '1.0.0')).toBeNull();
    expect(classifyBump('2.0.0', '1.9.9')).toBeNull();
  });
  it('returns null for unparseable input', () => {
    expect(classifyBump('not-a-version', '1.0.0')).toBeNull();
    expect(classifyBump('1.0.0', '')).toBeNull();
  });
  it('strips prerelease and build tags', () => {
    expect(classifyBump('1.0.0', '1.0.1-rc.1')).toBe('patch');
    expect(classifyBump('1.0.0-beta', '1.0.0')).toBeNull(); // same numeric triple
  });
});

describe('decideAutoUpdate', () => {
  const base = {
    currentVersion: '4.1.1',
    latestVersion: '4.1.2',
    currentVersionDeprecated: false,
  };

  it('does not run when there is no latest version available', () => {
    const d = decideAutoUpdate({ ...base, latestVersion: null, policy: 'major' });
    expect(d.shouldUpdate).toBe(false);
    expect(d.bump).toBeNull();
  });

  it('does not run when current is already at latest', () => {
    const d = decideAutoUpdate({ ...base, latestVersion: '4.1.1', policy: 'major' });
    expect(d.shouldUpdate).toBe(false);
  });

  it("policy 'off' blocks all bumps when not deprecated", () => {
    expect(decideAutoUpdate({ ...base, policy: 'off' }).shouldUpdate).toBe(false);
    expect(decideAutoUpdate({ ...base, latestVersion: '4.2.0', policy: 'off' }).shouldUpdate).toBe(false);
    expect(decideAutoUpdate({ ...base, latestVersion: '5.0.0', policy: 'off' }).shouldUpdate).toBe(false);
  });

  it("policy 'patch' permits patch only", () => {
    expect(decideAutoUpdate({ ...base, latestVersion: '4.1.2', policy: 'patch' }).shouldUpdate).toBe(true);
    expect(decideAutoUpdate({ ...base, latestVersion: '4.2.0', policy: 'patch' }).shouldUpdate).toBe(false);
    expect(decideAutoUpdate({ ...base, latestVersion: '5.0.0', policy: 'patch' }).shouldUpdate).toBe(false);
  });

  it("policy 'minor' permits patch + minor", () => {
    expect(decideAutoUpdate({ ...base, latestVersion: '4.1.2', policy: 'minor' }).shouldUpdate).toBe(true);
    expect(decideAutoUpdate({ ...base, latestVersion: '4.2.0', policy: 'minor' }).shouldUpdate).toBe(true);
    expect(decideAutoUpdate({ ...base, latestVersion: '5.0.0', policy: 'minor' }).shouldUpdate).toBe(false);
  });

  it("policy 'major' permits everything", () => {
    expect(decideAutoUpdate({ ...base, latestVersion: '5.0.0', policy: 'major' }).shouldUpdate).toBe(true);
  });

  it("deprecation override does NOT fire on policy 'off'", () => {
    // It used to. Look at what the override could ever do: it fires only for
    // a `patch` bump, and every policy above `off` already permits a patch —
    // so `off` was the ONLY setting it could override, the one whose whole
    // meaning is "never install anything without me asking". Its trigger is
    // `currentVersionDeprecated`, which comes from a string the PUBLISHER
    // writes into the npm registry, so it amounted to a remote switch on a
    // user's explicit refusal. A deprecated version is still reported: doctor
    // escalates the update-status row to FAIL for it.
    const d = decideAutoUpdate({ ...base, currentVersionDeprecated: true, policy: 'off' });
    expect(d.shouldUpdate, "policy 'off' was overridden by registry metadata").toBe(false);
    expect(d.deprecationOverride).toBe(false);
  });

  it("deprecation override still lifts a patch past a policy that is NOT off", () => {
    // The anti-vacuity half. A `minor` policy refuses a patch? No — it
    // permits one, so the override cannot be observed there either. It is
    // observable only where the policy permits nothing and is not `off`,
    // which no rank does. Kept as an explicit statement of that: the override
    // is now unreachable by construction, and if a future policy value makes
    // it reachable this test is where the intent is written down.
    const d = decideAutoUpdate({ ...base, currentVersionDeprecated: true, policy: 'patch' });
    expect(d.shouldUpdate, 'a permitted patch stopped being permitted').toBe(true);
    expect(d.bump).toBe('patch');
  });

  it('deprecation override does NOT auto-bump minor or major (could change behaviour)', () => {
    const minor = decideAutoUpdate({
      ...base,
      latestVersion: '4.2.0',
      currentVersionDeprecated: true,
      policy: 'off',
    });
    expect(minor.shouldUpdate).toBe(false);

    const major = decideAutoUpdate({
      ...base,
      latestVersion: '5.0.0',
      currentVersionDeprecated: true,
      policy: 'off',
    });
    expect(major.shouldUpdate).toBe(false);
  });

  it("deprecation override flag is false when policy already permits the bump", () => {
    const d = decideAutoUpdate({
      ...base,
      currentVersionDeprecated: true,
      policy: 'patch',
    });
    expect(d.shouldUpdate).toBe(true);
    expect(d.deprecationOverride).toBe(false);
  });
});
