import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executableTargets } from './lib/executable-targets.mjs';

// The list is derived from package.json `bin` and hooks/hooks.json rather than
// written out here — see scripts/lib/executable-targets.mjs for what the
// hand-written version had drifted into.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const relativePath of executableTargets(packageDir)) {
  const absolutePath = path.resolve(packageDir, relativePath);
  // Build order means a target can legitimately not exist yet (dist/ before
  // tsc, dashboard before its own build). Missing is not an error here; the
  // packaged-artifact smoke test is what asserts they are all present.
  if (!fs.existsSync(absolutePath)) continue;

  try {
    fs.chmodSync(absolutePath, 0o755);
  } catch (err) {
    // Windows ignores POSIX executable bits; keep the build portable there.
    // Everywhere else a chmod failure is real — a read-only mount, wrong
    // ownership, a full disk — and it produces a package whose `memesh`
    // binary is not executable. That failure surfaces to the user as
    // "permission denied" on first run, with nothing connecting it back to
    // the build that caused it.
    if (process.platform !== 'win32') {
      throw new Error(`set-executable-bits: cannot chmod ${relativePath} — ${err.message}`, { cause: err });
    }
  }
}
