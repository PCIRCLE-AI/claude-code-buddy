import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

const UPDATE_CHECK_PATH = path.join(os.homedir(), '.memesh', 'update-check.json');
const DEFAULT_TIMEOUT_MS = 5000;

export type UpdateCheckSource = 'fresh' | 'cache';

interface StoredUpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string;
  updateAvailable: boolean;
  checkSucceeded: boolean;
}

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string;
  updateAvailable: boolean;
  checkSucceeded: boolean;
  source: UpdateCheckSource;
}

interface CheckForUpdateOptions {
  execFileImpl?: typeof execFile;
  now?: Date;
  timeoutMs?: number;
  updateCheckPath?: string;
}

interface GetUpdateCheckOptions extends CheckForUpdateOptions {
  preferFresh?: boolean;
}

function getUpdateCheckPath(updateCheckPath?: string): string {
  return updateCheckPath ?? process.env.MEMESH_UPDATE_CHECK_PATH ?? UPDATE_CHECK_PATH;
}

function buildResult(
  currentVersion: string,
  latestVersion: string | null,
  checkedAt: string,
  checkSucceeded: boolean,
  source: UpdateCheckSource,
): UpdateCheck {
  return {
    currentVersion,
    latestVersion,
    checkedAt,
    updateAvailable: latestVersion !== null && latestVersion !== currentVersion,
    checkSucceeded,
    source,
  };
}

function parseStoredUpdateCheck(raw: unknown): StoredUpdateCheck | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.currentVersion !== 'string') return null;
  if (candidate.latestVersion !== null && typeof candidate.latestVersion !== 'string') return null;
  if (typeof candidate.checkedAt !== 'string') return null;
  if (
    'checkSucceeded' in candidate
    && typeof candidate.checkSucceeded !== 'boolean'
  ) return null;

  const latestVersion = candidate.latestVersion ?? null;
  const checkSucceeded = typeof candidate.checkSucceeded === 'boolean'
    ? candidate.checkSucceeded
    : latestVersion !== null;

  return {
    currentVersion: candidate.currentVersion,
    latestVersion,
    checkedAt: candidate.checkedAt,
    updateAvailable: latestVersion !== null && latestVersion !== candidate.currentVersion,
    checkSucceeded,
  };
}

function writeSuccessfulUpdateCheck(result: UpdateCheck, updateCheckPath?: string): void {
  const stored: StoredUpdateCheck = {
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    checkedAt: result.checkedAt,
    updateAvailable: result.updateAvailable,
    checkSucceeded: result.checkSucceeded,
  };

  try {
    const targetPath = getUpdateCheckPath(updateCheckPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify(stored, null, 2));
  } catch {
    // Cache writes are best effort only.
  }
}

/**
 * Check npm registry for latest version (async, non-blocking).
 * Writes only successful checks to ~/.memesh/update-check.json so stale-but-good
 * cache entries survive temporary npm/network failures.
 */
export async function checkForUpdate(
  currentVersion: string,
  options: CheckForUpdateOptions = {},
): Promise<UpdateCheck> {
  const {
    execFileImpl = execFile,
    now = new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    updateCheckPath,
  } = options;

  const checkedAt = now.toISOString();

  try {
    const latest = await new Promise<string>((resolve, reject) => {
      execFileImpl(
        'npm',
        ['show', '@pcircle/memesh', 'version'],
        { timeout: timeoutMs },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });

    const result = buildResult(currentVersion, latest, checkedAt, true, 'fresh');
    writeSuccessfulUpdateCheck(result, updateCheckPath);
    return result;
  } catch {
    return buildResult(currentVersion, null, checkedAt, false, 'fresh');
  }
}

/**
 * Read the last successful update check result.
 * Recomputes updateAvailable against the current installed version so the cache
 * stays truthful even after a local upgrade.
 */
export function getLastUpdateCheck(
  currentVersion: string,
  options: { updateCheckPath?: string } = {},
): UpdateCheck | null {
  try {
    const targetPath = getUpdateCheckPath(options.updateCheckPath);
    if (!fs.existsSync(targetPath)) return null;

    const parsed = parseStoredUpdateCheck(JSON.parse(fs.readFileSync(targetPath, 'utf8')));
    if (!parsed || !parsed.checkSucceeded) return null;

    return buildResult(currentVersion, parsed.latestVersion, parsed.checkedAt, true, 'cache');
  } catch {
    return null;
  }
}

/**
 * Prefer a fresh npm lookup, but fall back to the last successful cache entry
 * when npm is unavailable.
 */
export async function getUpdateCheck(
  currentVersion: string,
  options: GetUpdateCheckOptions = {},
): Promise<UpdateCheck | null> {
  if (options.preferFresh === false) {
    return getLastUpdateCheck(currentVersion, { updateCheckPath: options.updateCheckPath });
  }

  const fresh = await checkForUpdate(currentVersion, options);
  if (fresh.checkSucceeded) return fresh;

  return getLastUpdateCheck(currentVersion, { updateCheckPath: options.updateCheckPath }) ?? fresh;
}

export function formatUpdateCheckStatus(update: UpdateCheck | null): string[] {
  if (!update) {
    return ['Update check: unavailable'];
  }

  if (!update.checkSucceeded) {
    return ['Update check: unavailable (npm lookup failed and no cached result exists)'];
  }

  const freshness = update.source === 'fresh'
    ? 'fresh'
    : `cached from ${update.checkedAt}`;

  if (update.updateAvailable && update.latestVersion) {
    return [`🔄 Update available: ${update.latestVersion} (${freshness}; run: memesh update)`];
  }

  if (update.latestVersion) {
    return [`Update check: up to date (${freshness}; latest ${update.latestVersion})`];
  }

  return [`Update check: no version information available (${freshness})`];
}

export function getUpdateCheckPathForTests(): string {
  return UPDATE_CHECK_PATH;
}
