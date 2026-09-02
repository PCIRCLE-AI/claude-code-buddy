import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npxSync } from './lib/npm-bin.mjs';
import { buildIsolatedSuiteEnv } from './lib/isolated-env.mjs';

/**
 * Run the test suite against a throwaway HOME.
 *
 * The suite writes to `~/.memesh` — `prepublishOnly` ran it against the
 * maintainer's real home directory, re-introducing on the publish path the
 * hazard `scripts/release-verify.sh` was changed to remove in this same series.
 *
 * MEMESH_DB_PATH is deliberately NOT set: several hook tests exercise the
 * "no database yet" branches, and pointing the env var at an existing file
 * makes those branches unreachable. An isolated HOME is the right isolation;
 * a fixed DB path is not.
 *
 * One owner for "how the suite is run", so the publish path and the release
 * script cannot drift again.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-test-home-'));
try {
  // HOME alone is not isolation. `src/core/paths.ts` resolves MEMESH_DIR and
  // MEMESH_DB_PATH BEFORE falling back to HOME, so either one exported in the
  // maintainer's shell — a normal state while debugging against a copy — sends
  // the whole suite at the real config and the real database, from the publish
  // path. The docblock above warned about *setting* MEMESH_DB_PATH and said
  // nothing about inheriting it. Provider settings from the invoking shell are
  // owner-controlled runtime state, not test inputs, and go for the same
  // reason; individual tests that exercise provider discovery set their own
  // fixtures after Vitest starts.
  //
  // Both deletions now live in `lib/isolated-env.mjs`, with the audit scripts
  // that need the identical guarantee. Three copies is how two of them ended
  // up pinning only HOME.
  const env = buildIsolatedSuiteEnv(process.env, { runtimeHome: home });

  npxSync(['vitest', 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
