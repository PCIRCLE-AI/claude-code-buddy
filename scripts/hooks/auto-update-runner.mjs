#!/usr/bin/env node

import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { createHash, randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { runGlobalUpdate } from '../../dist/core/updater.js';

export const AUTO_UPDATE_LOCK_TTL_MS = 10 * 60 * 1000;
export const AUTO_UPDATE_RECOVERY_TTL_MS = 30 * 1000;
const MAX_RECOVERY_GENERATIONS = 64;

function ownerToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

function readLock(lockPath) {
  try {
    const [token, pidRaw, startedAtRaw, version] = readFileSync(lockPath, 'utf8').split('\n');
    const pid = Number(pidRaw);
    const startedAt = Number(startedAtRaw);
    if (!token || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)) return null;
    return { token, pid, startedAt, version: version || null };
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function createOwnedFile(filePath, token, payload) {
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  return token;
}

function tryCreateLock(lockPath, version) {
  const token = ownerToken();
  const startedAt = Date.now();
  try {
    createOwnedFile(
      lockPath,
      token,
      `${token}\n${process.pid}\n${startedAt}\n${version}\n`,
    );
    return { acquired: true, lockPath, ownerToken: token, recoveredStale: false };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { acquired: false, lockPath, ownerToken: null, recoveredStale: false };
    }
    throw err;
  }
}

export function autoUpdateRecoveryClaimPath(lockPath, staleToken, generation = 0) {
  const tokenHash = createHash('sha256').update(staleToken).digest('hex').slice(0, 24);
  return `${lockPath}.recover.${tokenHash}.${generation}`;
}

function tryCreateRecoveryClaim(claimPath) {
  const token = ownerToken();
  const candidatePath = `${claimPath}.candidate.${token}`;
  createOwnedFile(
    candidatePath,
    token,
    `${token}\n${process.pid}\n${Date.now()}\nrecovery\n`,
  );
  try {
    // The candidate is complete before the fixed claim path appears. linkSync
    // gives the destination O_EXCL semantics, so a crash cannot leave a
    // partially written claim that blocks recovery forever.
    linkSync(candidatePath, claimPath);
    return { acquired: true, claimPath, ownerToken: token };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { acquired: false, claimPath, ownerToken: null };
    }
    throw err;
  } finally {
    try { unlinkSync(candidatePath); } catch { /* crash-only candidate orphan */ }
  }
}

function tryAcquireRecoveryClaim(lockPath, staleToken) {
  for (let generation = 0; generation < MAX_RECOVERY_GENERATIONS; generation += 1) {
    const claimPath = autoUpdateRecoveryClaimPath(lockPath, staleToken, generation);
    const created = tryCreateRecoveryClaim(claimPath);
    if (created.acquired) return created;

    const existing = readLock(claimPath);
    if (!existing) return null;
    if (Date.now() - existing.startedAt <= AUTO_UPDATE_RECOVERY_TTL_MS) return null;
    if (processIsAlive(existing.pid)) return null;
    // A complete claim whose owner crashed remains immutable. All contenders
    // derive the same successor generation, where O_EXCL elects one recovery
    // owner without deleting or replacing the orphaned claim.
  }
  return null;
}

export function releaseAutoUpdateLock(lockPath, token) {
  const current = readLock(lockPath);
  if (!current || current.token !== token) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function recoverObservedStaleAutoUpdateLock(lockPath, observed) {
  const recovery = tryAcquireRecoveryClaim(lockPath, observed.token);
  if (!recovery?.acquired) return false;

  try {
    const current = readLock(lockPath);
    if (!current || current.token !== observed.token) return false;
    if (Date.now() - current.startedAt <= AUTO_UPDATE_LOCK_TTL_MS) return false;
    if (processIsAlive(current.pid)) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  } finally {
    releaseAutoUpdateLock(recovery.claimPath, recovery.ownerToken);
  }
}

export function tryAcquireAutoUpdateLock(lockPath, version) {
  const created = tryCreateLock(lockPath, version);
  if (created.acquired) return created;

  const observed = readLock(lockPath);
  if (!observed) return created;
  if (Date.now() - observed.startedAt <= AUTO_UPDATE_LOCK_TTL_MS) return created;
  if (processIsAlive(observed.pid)) return created;

  // Recovery never installs. It removes only the exact stale token observed
  // under a separate O_EXCL claim, then defers so a later trigger must acquire
  // the normal update lock. No delayed stale contender touches a fresh lock.
  const recoveredStale = recoverObservedStaleAutoUpdateLock(lockPath, observed);
  return { ...created, recoveredStale };
}

function writeLine(fd, line) {
  try {
    writeSync(fd, `[memesh auto-update] ${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

export function runAutoUpdate(targetVersion, lockPath) {
  let lock;
  try {
    lock = tryAcquireAutoUpdateLock(lockPath, targetVersion);
  } catch (err) {
    writeLine(2, `FAILED target=${targetVersion} stage=lock error=${errorMessage(err)}`);
    return 1;
  }

  if (!lock.acquired) {
    const state = lock.recoveredStale ? 'RECOVERED_STALE' : 'IN_PROGRESS';
    writeLine(1, `${state} target=${targetVersion} lock=${lockPath}`);
    return 0;
  }

  if (!writeLine(1, `START target=${targetVersion} pid=${process.pid}`)) {
    releaseAutoUpdateLock(lockPath, lock.ownerToken);
    return 1;
  }

  let installedVersion = null;
  let updateError = null;
  try {
    installedVersion = runGlobalUpdate(targetVersion).installedVersion;
  } catch (err) {
    updateError = err;
  }

  const released = releaseAutoUpdateLock(lockPath, lock.ownerToken);
  if (updateError) {
    writeLine(
      2,
      `FAILED target=${targetVersion} stage=install-or-readback error=${errorMessage(updateError)}`,
    );
    if (!released) writeLine(2, `FAILED target=${targetVersion} stage=lock-release`);
    return 1;
  }
  if (!released) {
    writeLine(2, `FAILED target=${targetVersion} stage=lock-release installed=${installedVersion}`);
    return 1;
  }

  writeLine(1, `SUCCESS target=${targetVersion} installed=${installedVersion}`);
  return 0;
}

async function main() {
  const [targetVersion, lockPath] = process.argv.slice(2);
  if (!targetVersion || !lockPath) {
    writeLine(2, 'FAILED stage=arguments error=expected target version and lock path');
    process.exitCode = 1;
    return;
  }
  process.exitCode = runAutoUpdate(targetVersion, lockPath);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}
