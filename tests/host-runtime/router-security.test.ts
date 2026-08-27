import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function privateDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-router-security-'));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function runRouter(directory: string, tokenFile: string) {
  return spawnSync(process.execPath, [path.resolve('dist/host-runtime/router.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEMESH_DB_PATH: path.join(directory, 'knowledge-graph.db'),
      MEMESH_ROUTER_SOCKET: path.join(directory, 'router.sock'),
      MEMESH_ROUTER_TOKEN_FILE: tokenFile,
    },
    encoding: 'utf8',
    timeout: 3_000,
  });
}

describe('router token boundary', () => {
  it('rejects a symlink token instead of following its private target', () => {
    const directory = privateDirectory();
    const target = path.join(directory, 'target.token');
    const link = path.join(directory, 'router.token');
    fs.writeFileSync(target, 'a'.repeat(64), { mode: 0o600 });
    fs.symlinkSync(target, link);

    const result = runRouter(directory, link);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ELOOP|symlink|symbolic/i);
  });

  it('rejects an oversized owner-private token before starting the router', () => {
    const directory = privateDirectory();
    const token = path.join(directory, 'router.token');
    fs.writeFileSync(token, 'a'.repeat(8 * 1024 + 1), { mode: 0o600 });

    const result = runRouter(directory, token);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('8192-byte limit');
  });
});
