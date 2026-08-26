import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHostConfig, readTokenFile } from '../../src/host-runtime/config.js';

const temporaryDirectories: string[] = [];
let savedArgv: string[];
let savedHostConfig: string | undefined;

beforeEach(() => {
  savedArgv = [...process.argv];
  savedHostConfig = process.env.MEMESH_HOST_CONFIG;
  delete process.env.MEMESH_HOST_CONFIG;
});

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...savedArgv);
  if (savedHostConfig === undefined) delete process.env.MEMESH_HOST_CONFIG;
  else process.env.MEMESH_HOST_CONFIG = savedHostConfig;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-host-config-'));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function privateFile(directory: string, name: string, content: string): string {
  const file = path.join(directory, name);
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function setHostConfig(file: string): void {
  process.argv.splice(0, process.argv.length, 'node', 'host-config-test', '--config', file);
}

describe('host config and token files', () => {
  it('reads owner-private 0600 regular config and token files', () => {
    const directory = privateDirectory();
    const config = privateFile(directory, 'host.json', '{"project":"private-host"}');
    const token = privateFile(directory, 'router.token', 'router-secret\n');
    setHostConfig(config);

    expect(readHostConfig<{ project: string }>()).toEqual({ project: 'private-host' });
    expect(readTokenFile(token)).toBe('router-secret');
  });

  it('rejects symlink config and token paths before reading their targets', () => {
    const directory = privateDirectory();
    const config = privateFile(directory, 'host.json', '{"project":"private-host"}');
    const token = privateFile(directory, 'router.token', 'router-secret\n');
    const linkedConfig = path.join(directory, 'host-link.json');
    const linkedToken = path.join(directory, 'router-link.token');
    fs.symlinkSync(config, linkedConfig);
    fs.symlinkSync(token, linkedToken);

    setHostConfig(linkedConfig);
    expect(() => readHostConfig()).toThrow();
    expect(() => readTokenFile(linkedToken)).toThrow();
  });

  it('rejects config and token files with group or other permissions', () => {
    const directory = privateDirectory();
    const config = privateFile(directory, 'host.json', '{"project":"private-host"}');
    const token = privateFile(directory, 'router.token', 'router-secret\n');
    fs.chmodSync(config, 0o644);
    fs.chmodSync(token, 0o640);

    setHostConfig(config);
    expect(() => readHostConfig()).toThrow(/owner-private/);
    expect(() => readTokenFile(token)).toThrow(/owner-private/);
  });

  it('rejects directories and files that are not owned by the current user', () => {
    const directory = privateDirectory();
    setHostConfig(directory);
    expect(() => readHostConfig()).toThrow(/regular file/);
    expect(() => readTokenFile(directory)).toThrow(/regular file/);

    if (typeof process.getuid !== 'function') return;
    const config = privateFile(directory, 'host.json', '{"project":"private-host"}');
    const token = privateFile(directory, 'router.token', 'router-secret\n');
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
    setHostConfig(config);
    expect(() => readHostConfig()).toThrow(/owned by the current user/);
    expect(() => readTokenFile(token)).toThrow(/owned by the current user/);
  });

  it('bounds config and token reads through the opened descriptor', () => {
    const directory = privateDirectory();
    const config = privateFile(directory, 'large-host.json', 'x'.repeat(64 * 1024 + 1));
    const token = privateFile(directory, 'large-router.token', 'x'.repeat(8 * 1024 + 1));
    setHostConfig(config);

    expect(() => readHostConfig()).toThrow(/byte limit/);
    expect(() => readTokenFile(token)).toThrow(/byte limit/);
  });
});
