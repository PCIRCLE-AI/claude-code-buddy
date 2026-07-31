/**
 * The platform-correct names for the npm and npx executables.
 *
 * On Windows npm ships as `npm.cmd`, a batch file. `execFileSync('npm', …)`
 * does NOT consult `PATHEXT` — that is a shell behaviour, and execFile does not
 * use a shell — so it fails with `spawnSync npm ENOENT` while the same command
 * works in the terminal. The failure is invisible on macOS and Linux, which is
 * why it reached both scripts on the publish path:
 *
 *   check-consumer-audit.mjs  ->  npm run audit:prod  ->  npm run verify:release
 *   run-tests-isolated.mjs    ->  npm run test:isolated
 *
 * and therefore `prepublishOnly`. A Windows contributor could not run the
 * release gate at all. It fails closed rather than passing wrongly, but "the
 * gate cannot run" and "the gate passed" are equally useless to them.
 *
 * `shell: true` would also work and is the wrong fix: it re-introduces quoting
 * and injection concerns for arguments that are currently passed as an array.
 *
 * One owner, because the two call sites had already been written twice.
 */
const isWindows = process.platform === 'win32';

export const NPM = isWindows ? 'npm.cmd' : 'npm';
export const NPX = isWindows ? 'npx.cmd' : 'npx';
