import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NPX } from './lib/npm-bin.mjs';

/**
 * Run the test suite against a throwaway HOME.
 *
 * The suite writes to `~/.memesh` — `prepublishOnly` ran it against the
 * maintainer's real home directory, re-introducing on the publish path the
 * hazard `scripts/release-verify.sh` was changed to remove in this same series.
 *
 * MEMESH_DB_PATH is deliberately NOT set: pointing it at an existing file makes
 * `tests/hooks/session-start-telemetry.test.ts` fail, because its
 * "short-circuits on missing DB" case then cannot short-circuit.
 *
 * One owner for "how the suite is run", so the publish path and the release
 * script cannot drift again.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-test-home-'));
try {
  execFileSync(NPX, ['vitest', 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
