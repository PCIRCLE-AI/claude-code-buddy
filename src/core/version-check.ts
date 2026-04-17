import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

const UPDATE_CHECK_PATH = path.join(os.homedir(), '.memesh', 'update-check.json');

interface UpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  checkedAt: string;
  updateAvailable: boolean;
}

/**
 * Check npm registry for latest version (async, non-blocking).
 * Stores result in ~/.memesh/update-check.json
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheck> {
  const result: UpdateCheck = {
    currentVersion,
    latestVersion: null,
    checkedAt: new Date().toISOString(),
    updateAvailable: false,
  };

  try {
    const latest = await new Promise<string>((resolve, reject) => {
      execFile('npm', ['show', '@pcircle/memesh', 'version'], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    result.latestVersion = latest;
    result.updateAvailable = latest !== currentVersion;
  } catch {
    // Network unavailable or npm not found — silently fail
  }

  // Write result for dashboard to read
  try {
    fs.mkdirSync(path.dirname(UPDATE_CHECK_PATH), { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_PATH, JSON.stringify(result, null, 2));
  } catch {}

  return result;
}

/**
 * Read last update check result (sync, for dashboard).
 */
export function getLastUpdateCheck(): UpdateCheck | null {
  try {
    if (!fs.existsSync(UPDATE_CHECK_PATH)) return null;
    return JSON.parse(fs.readFileSync(UPDATE_CHECK_PATH, 'utf8'));
  } catch {
    return null;
  }
}
