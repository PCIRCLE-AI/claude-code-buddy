import fs from 'fs';

/**
 * Remove a throwaway HOME that a spawned SessionStart hook was pointed at.
 *
 * Why this is not a plain `fs.rmSync`: the hook deliberately outlives itself.
 * `spawnFreshUpdateCheck` (scripts/hooks/session-start.js) starts a detached,
 * unref'd `node dist/transports/cli/cli.js status` to refresh the update-check
 * cache, so session start never blocks on a slow npm lookup. Nothing waits for
 * it, and it writes `update-check.<version>.json` into `<home>/.memesh` about a
 * second after the hook process itself has exited.
 *
 * So a test that spawns the hook and immediately deletes its HOME is racing a
 * live writer: rmSync enumerates `.memesh`, deletes what it saw, calls rmdir —
 * and the child has created a new file in between. The result is
 * `ENOTEMPTY: directory not empty, rmdir '<home>/.memesh'`.
 *
 * This was first read as a Windows handle-release lag and "fixed" by widening
 * the retry window from 5/100ms to 10/200ms. It failed again immediately, and
 * then failed on Linux too — which is the disconfirmation: no retry budget
 * outlasts a process that is still writing. Verified directly by running the
 * hook against a scratch HOME and watching the child appear in `pgrep` after
 * the parent had exited, then watching the file land.
 *
 * A leaked temp directory on a CI runner is harmless, and none of these tests
 * assert anything about cleanup, so the honest cleanup is: try, and let the
 * race lose quietly. Every other error still throws.
 */
export function removeTempHome(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw err;
    }
  }
}
