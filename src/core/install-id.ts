// =============================================================================
// Anonymous install ID
// =============================================================================
//
// Stores a random UUID at `~/.memesh/install.json` on first read.
// Purpose: correlate multiple feedback issues filed by the same
// anonymous user without collecting any PII. The user (and only the
// user) sees their own install_id via `memesh config get install_id`,
// the dashboard Settings tab, and the doctor output. It is never
// transmitted automatically — only included in body text the user
// chooses to share (FeedbackWidget "Include system info" checkbox,
// future opt-in telemetry).
//
// Pattern lifted from gstack's `gstack-config` + brain-init flow:
// lazy-generate, chmod 600, single canonical location, transparent
// to the user.
//
// Schema is JSON-extensible so we can add fields later (created_at
// is helpful for support; never add anything that maps to a person).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

interface InstallRecord {
  install_id: string;
  created_at: string;
  schema_version: 1;
}

const SCHEMA_VERSION = 1 as const;

function installFilePath(): string {
  const dir = process.env.MEMESH_DIR ?? path.join(os.homedir(), '.memesh');
  return path.join(dir, 'install.json');
}

/**
 * Read or lazily create the install record. Idempotent — once
 * generated, the same UUID is returned on every subsequent call from
 * the same machine forever (or until the user deletes the file).
 *
 * Defensive: file-system errors return a synthetic record with
 * install_id = 'unknown' rather than crashing — feedback flows must
 * never block on this.
 */
export function getInstallRecord(): InstallRecord {
  const filePath = installFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<InstallRecord>;
      if (typeof parsed.install_id === 'string' && parsed.install_id.length > 0) {
        return {
          install_id: parsed.install_id,
          created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      }
    }
  } catch {
    // Fall through to generate
  }

  const record: InstallRecord = {
    install_id: randomUUID(),
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* non-POSIX */ }
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* non-POSIX */ }
  } catch {
    // Cannot persist — return the in-memory record. Next call will
    // generate a new UUID; that's fine for ephemeral / sandboxed envs.
  }

  return record;
}

/**
 * Convenience: just the UUID. Useful for the FeedbackWidget body
 * builder and the CLI `memesh config get install_id` flow.
 */
export function getInstallId(): string {
  return getInstallRecord().install_id;
}
