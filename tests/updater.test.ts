import { describe, expect, it } from 'vitest';
import { getInstalledGlobalVersion, runGlobalUpdate } from '../src/core/updater.js';

function makeExecFileSyncMock(handlers: {
  install?: (args: string[]) => void;
  ls?: () => string;
}) {
  return ((file: string, args: readonly string[] | undefined | null) => {
    expect(file).toBe('npm');
    expect(Array.isArray(args)).toBe(true);

    const command = args as string[];
    if (command[0] === 'install') {
      handlers.install?.(command);
      return '';
    }

    if (command[0] === 'ls') {
      return handlers.ls?.() ?? JSON.stringify({});
    }

    throw new Error(`Unexpected command: ${command.join(' ')}`);
  }) as typeof import('child_process').execFileSync;
}

describe('updater', () => {
  it('reads the installed global version from npm ls output', () => {
    const version = getInstalledGlobalVersion({
      execFileSyncImpl: makeExecFileSyncMock({
        ls: () => JSON.stringify({
          dependencies: {
            '@pcircle/memesh': { version: '4.0.2' },
          },
        }),
      }),
    });

    expect(version).toBe('4.0.2');
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
