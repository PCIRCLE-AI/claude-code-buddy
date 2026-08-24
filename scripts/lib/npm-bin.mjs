import { execFileSync, execSync } from 'node:child_process';

/**
 * Run npm / npx from a build script, on every platform we support.
 *
 * Two separate Windows problems, and fixing only the first is what made this
 * take two attempts:
 *
 *   1. npm ships on Windows as `npm.cmd`. `execFileSync('npm', …)` does not
 *      consult `PATHEXT` — that is a shell behaviour and execFile uses no
 *      shell — so it fails with `spawnSync npm ENOENT` while the identical
 *      command typed into a terminal works.
 *
 *   2. Naming it `npm.cmd` then fails with `spawnSync npm.cmd EINVAL`. Since
 *      the fix for CVE-2024-27980, Node refuses to spawn `.cmd` and `.bat`
 *      files without `shell: true`, because the Windows command interpreter
 *      re-parses the argument list. On Windows there is no shell-free way to
 *      invoke npm.
 *
 * So `shell: true` is required there, not a shortcut — and it is scoped to
 * Windows, so macOS and Linux keep passing arguments as an array with no
 * interpreter in the path at all.
 *
 * What `shell: true` costs is argument re-parsing, which matters only for
 * arguments that are not literals. There is exactly one — the tarball name
 * `npm pack` prints — and `assertSafeShellArg()` below is how it is made safe
 * rather than assumed safe. Call it on anything that did not come from this
 * repository's own source.
 *
 * Both scripts on the publish path had written this by hand:
 *
 *   check-consumer-audit.mjs  ->  audit:prod  ->  verify:release  ->  prepublishOnly
 *   run-tests-isolated.mjs    ->  test:isolated                   ->  prepublishOnly
 *
 * One owner, so a third caller cannot get it wrong a third way.
 */
const isWindows = process.platform === 'win32';

export const NPM = isWindows ? 'npm.cmd' : 'npm';
export const NPX = isWindows ? 'npx.cmd' : 'npx';

/**
 * Reject anything that could mean something to a command interpreter.
 *
 * Deliberately an allow-list. A deny-list of shell metacharacters has to be
 * complete to be correct, and `cmd.exe` gives `%`, `^` and `&` meanings that a
 * POSIX-shaped deny-list would miss.
 */
export function assertSafeShellArg(value, what) {
  // `:` and `~` are here for one reason: Windows absolute paths
  // (`C:\Users\RUNNER~1\AppData\Local\Temp\...` — 8.3 short names carry the `~`,
  // and that is literally what `os.tmpdir()` returns on a Windows runner).
  // `smoke-packed-artifact.mjs` passes an absolute `os.tmpdir()` path to
  // `npm pack --pack-destination` and to `npm install`, so without it
  // `npm run test:packaged` throws on Windows before packing anything —
  // fail-closed, but it means the packaged smoke test cannot run there at all.
  // Neither has meaning to cmd.exe (`~` is a POSIX-shell nicety, and the POSIX
  // branch never reaches here — it uses execFileSync with no shell at all).
  // Every character that DOES mean something to cmd.exe (`%^&|<>"'` and
  // whitespace) stays excluded.
  if (typeof value !== 'string' || !/^[A-Za-z0-9._@:~\-+=/\\]+$/.test(value)) {
    throw new Error(
      `${what} is not a safe argument to pass through a shell: ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * Spawn `bin` with `args`.
 *
 * POSIX: no shell, arguments stay an array, nothing is re-parsed.
 *
 * Windows: every argument is validated, then the command line is built here and
 * handed to `execSync`. Passing an ARRAY together with `shell: true` is
 * deprecated (DEP0190) precisely because the arguments are concatenated without
 * escaping — doing the concatenation ourselves, after checking each part, is
 * the same operation with the check that makes it sound, and it does not print
 * a deprecation warning on every release gate.
 *
 * The usual advice — "use execFile with an argument array, never build a shell
 * string" — is right, and is what the POSIX branch does. It does not apply to
 * the Windows branch because there is no execFile that works: npm is a `.cmd`,
 * and Node refuses to exec one without a shell. The choice there is not
 * array-vs-string, it is checked-vs-unchecked. Every argument reaching the
 * concatenation has passed `assertSafeShellArg`, which is an allow-list, so no
 * character with meaning to `cmd.exe` can be in one. `tests/consumer-audit-
 * gate.test.ts` pins that, including the `%` and `^` forms a POSIX-shaped
 * deny-list would miss.
 */
function runSync(bin, args, opts) {
  if (!isWindows) return execFileSync(bin, args, opts);
  const safeArgs = args.map((arg, i) => assertSafeShellArg(arg, `${bin} argument ${i} (${arg})`));
  return execSync([bin, ...safeArgs].join(' '), opts);
}

/** `npm <args>`, spawned correctly for the platform. */
export function npmSync(args, opts = {}) {
  return runSync(NPM, args, opts);
}

/** `npx <args>`, spawned correctly for the platform. */
export function npxSync(args, opts = {}) {
  return runSync(NPX, args, opts);
}
