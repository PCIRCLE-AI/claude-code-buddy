import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AUTO_UPDATE_LOCK_TTL_MS,
  AUTO_UPDATE_RECOVERY_TTL_MS,
  autoUpdateRecoveryClaimPath,
  recoverObservedStaleAutoUpdateLock,
  releaseAutoUpdateLock,
  tryAcquireAutoUpdateLock,
} from '../../scripts/hooks/auto-update-runner.mjs';
import { spawnAutoUpdate } from '../../scripts/hooks/_shared.js';

const runnerPath = path.resolve('scripts/hooks/auto-update-runner.mjs');

interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let savedMemeshDir: string | undefined;

function runRunner(
  targetVersion: string,
  lockPath: string,
  env: NodeJS.ProcessEnv,
  runner = runnerPath,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, targetVersion, lockPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function makeFakeNpm(): { env: NodeJS.ProcessEnv; callsPath: string; statePath: string } {
  const binDir = path.join(tempDir, 'bin');
  const callsPath = path.join(tempDir, 'npm-calls.log');
  const statePath = path.join(tempDir, 'installed-version.txt');
  fs.mkdirSync(binDir);
  fs.writeFileSync(statePath, '4.7.9');

  const npmPath = path.join(binDir, 'npm');
  fs.writeFileSync(npmPath, `#!/usr/bin/env node
import fs from 'fs';

const args = process.argv.slice(2);
const callsPath = process.env.MEMESH_TEST_NPM_CALLS;
const statePath = process.env.MEMESH_TEST_NPM_STATE;
const mode = process.env.MEMESH_TEST_NPM_MODE || 'success';
const delayMs = Number(process.env.MEMESH_TEST_NPM_DELAY_MS || 0);
fs.appendFileSync(callsPath, args.join(' ') + '\\n');

if (args[0] === 'install') {
  if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  if (mode === 'install-fail') {
    process.stderr.write('simulated install failure\\n');
    process.exit(42);
  }
  if (mode !== 'readback-mismatch') {
    const target = args[2].slice(args[2].lastIndexOf('@') + 1);
    fs.writeFileSync(statePath, target);
  }
  process.exit(0);
}

if (args[0] === 'ls') {
  const version = fs.readFileSync(statePath, 'utf8');
  process.stdout.write(JSON.stringify({ dependencies: { '@pcircle/memesh': { version } } }));
  process.exit(0);
}

process.stderr.write('unexpected npm invocation: ' + args.join(' ') + '\\n');
process.exit(64);
`);
  fs.chmodSync(npmPath, 0o755);

  return {
    callsPath,
    statePath,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      MEMESH_TEST_NPM_CALLS: callsPath,
      MEMESH_TEST_NPM_STATE: statePath,
    },
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-auto-update-'));
  savedMemeshDir = process.env.MEMESH_DIR;
  process.env.MEMESH_DIR = tempDir;
});

afterEach(() => {
  if (savedMemeshDir === undefined) delete process.env.MEMESH_DIR;
  else process.env.MEMESH_DIR = savedMemeshDir;
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('auto-update runner lock ownership', () => {
  it('only lets the recorded owner token release the lock', () => {
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const lock = tryAcquireAutoUpdateLock(lockPath, '4.8.0');

    expect(lock.acquired).toBe(true);
    expect(releaseAutoUpdateLock(lockPath, 'not-the-owner')).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(releaseAutoUpdateLock(lockPath, lock.ownerToken)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not let a delayed stale observation remove a fresh owner (ABA)', () => {
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const observed = {
      token: 'stale-owner',
      pid: 2147483647,
      startedAt: Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000,
      version: '4.7.9',
    };
    fs.writeFileSync(
      lockPath,
      `${observed.token}\n${observed.pid}\n${observed.startedAt}\n${observed.version}\n`,
      { mode: 0o600 },
    );

    const recovery = tryAcquireAutoUpdateLock(lockPath, '4.8.0');
    expect(recovery.acquired).toBe(false);
    expect(recovery.recoveredStale).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    const fresh = tryAcquireAutoUpdateLock(lockPath, '4.8.0');
    expect(fresh.acquired).toBe(true);
    expect(recoverObservedStaleAutoUpdateLock(lockPath, observed)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8').split('\n')[0]).toBe(fresh.ownerToken);
    expect(releaseAutoUpdateLock(lockPath, fresh.ownerToken)).toBe(true);
  });

  it('advances past a bounded dead recovery claim without deleting it', () => {
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const staleToken = 'stale-owner';
    fs.writeFileSync(
      lockPath,
      `${staleToken}\n2147483647\n${Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000}\n4.7.9\n`,
      { mode: 0o600 },
    );
    const orphanPath = autoUpdateRecoveryClaimPath(lockPath, staleToken);
    fs.writeFileSync(
      orphanPath,
      `dead-recovery\n2147483647\n${Date.now() - AUTO_UPDATE_RECOVERY_TTL_MS - 1000}\nrecovery\n`,
      { mode: 0o600 },
    );

    const recovery = tryAcquireAutoUpdateLock(lockPath, '4.8.0');
    expect(recovery.acquired).toBe(false);
    expect(recovery.recoveredStale).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(orphanPath)).toBe(true);

    const later = tryAcquireAutoUpdateLock(lockPath, '4.8.0');
    expect(later.acquired).toBe(true);
    expect(releaseAutoUpdateLock(lockPath, later.ownerToken)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('auto-update runner process boundary', () => {
  it('emits SUCCESS only after exact installed-version readback and releases the lock', async () => {
    const fake = makeFakeNpm();
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const result = await runRunner('4.8.0', lockPath, fake.env);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('START target=4.8.0');
    expect(result.stdout).toContain('SUCCESS target=4.8.0 installed=4.8.0');
    expect(result.stderr).not.toContain('FAILED');
    expect(fs.readFileSync(fake.statePath, 'utf8')).toBe('4.8.0');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('emits terminal FAILED on a nonzero install and releases the lock', async () => {
    const fake = makeFakeNpm();
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const result = await runRunner('4.8.0', lockPath, {
      ...fake.env,
      MEMESH_TEST_NPM_MODE: 'install-fail',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('SUCCESS');
    expect(result.stderr).toContain('FAILED target=4.8.0 stage=install-or-readback');
    expect(fs.readFileSync(fake.statePath, 'utf8')).toBe('4.7.9');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('emits terminal FAILED when readback does not equal the target', async () => {
    const fake = makeFakeNpm();
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const result = await runRunner('4.8.0', lockPath, {
      ...fake.env,
      MEMESH_TEST_NPM_MODE: 'readback-mismatch',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('SUCCESS');
    expect(result.stderr).toContain('FAILED target=4.8.0 stage=install-or-readback');
    expect(result.stderr).toContain('expected 4.8.0, but npm reports 4.7.9');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('runs when its entry path reaches it through a symlink', async () => {
    const fake = makeFakeNpm();
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const linkedHooks = path.join(tempDir, 'linked-hooks');
    fs.symlinkSync(path.dirname(runnerPath), linkedHooks, 'dir');

    const result = await runRunner(
      '4.8.0',
      lockPath,
      fake.env,
      path.join(linkedHooks, 'auto-update-runner.mjs'),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('START target=4.8.0');
    expect(result.stdout).toContain('SUCCESS target=4.8.0 installed=4.8.0');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('allows one updater through under contention and releases for a later run', async () => {
    const fake = makeFakeNpm();
    const lockPath = path.join(tempDir, 'auto-update.lock');
    const contenders = await Promise.all(
      Array.from({ length: 6 }, () => runRunner('4.8.0', lockPath, {
        ...fake.env,
        MEMESH_TEST_NPM_DELAY_MS: '300',
      })),
    );

    const output = contenders.map((result) => `${result.stdout}${result.stderr}`).join('\n');
    const calls = fs.readFileSync(fake.callsPath, 'utf8').trim().split('\n');
    expect(calls.filter((line) => line.startsWith('install '))).toHaveLength(1);
    expect(contenders.filter((result) => result.stdout.includes('SUCCESS'))).toHaveLength(1);
    expect(output).toContain('IN_PROGRESS target=4.8.0');
    expect(fs.existsSync(lockPath)).toBe(false);

    const later = await runRunner('4.8.0', lockPath, fake.env);
    expect(later.code).toBe(0);
    expect(later.stdout).toContain('SUCCESS target=4.8.0 installed=4.8.0');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('never installs twice while recovering one stale lock under contention', async () => {
    const fake = makeFakeNpm();
    const lockPath = path.join(tempDir, 'auto-update.lock');
    fs.writeFileSync(
      lockPath,
      `stale-owner\n2147483647\n${Date.now() - AUTO_UPDATE_LOCK_TTL_MS - 1000}\n4.7.9\n`,
      { mode: 0o600 },
    );
    const contenders = await Promise.all(
      Array.from({ length: 6 }, () => runRunner('4.8.0', lockPath, {
        ...fake.env,
        MEMESH_TEST_NPM_DELAY_MS: '300',
      })),
    );

    const output = contenders.map((result) => `${result.stdout}${result.stderr}`).join('\n');
    let calls = fs.existsSync(fake.callsPath)
      ? fs.readFileSync(fake.callsPath, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    let installCalls = calls.filter((line) => line.startsWith('install '));
    expect(installCalls.length).toBeLessThanOrEqual(1);

    if (installCalls.length === 0) {
      const later = await runRunner('4.8.0', lockPath, fake.env);
      expect(later.stdout).toContain('SUCCESS target=4.8.0 installed=4.8.0');
      calls = fs.readFileSync(fake.callsPath, 'utf8').trim().split('\n').filter(Boolean);
      installCalls = calls.filter((line) => line.startsWith('install '));
    }

    expect(installCalls).toHaveLength(1);
    expect(output).toContain('IN_PROGRESS target=4.8.0');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tempDir).filter((name) => name.includes('.candidate.'))).toEqual([]);
  });
});

describe('auto-update dispatch guards', () => {
  it('does not dispatch mutation for a non-global install channel', async () => {
    const result = await spawnAutoUpdate('4.8.0', {
      getCurrentInstallChannel: () => 'npm-local',
    });

    expect(result).toEqual({ state: 'channel' });
    expect(fs.readFileSync(path.join(tempDir, 'auto-update.log'), 'utf8')).toContain(
      "SKIPPED: install channel 'npm-local'",
    );
  });

  it('does not dispatch when the durable log cannot be opened', async () => {
    const notADirectory = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(notADirectory, 'file');
    process.env.MEMESH_DIR = notADirectory;

    const result = await spawnAutoUpdate('4.8.0', {
      getCurrentInstallChannel: () => 'npm-global',
    });

    expect(result).toEqual({ state: 'failed' });
  });
});
