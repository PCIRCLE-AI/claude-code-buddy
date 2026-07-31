import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmSync, assertSafeShellArg } from './lib/npm-bin.mjs';

/**
 * Audit the dependency tree a CONSUMER resolves, not the one this repo has.
 *
 * `npm audit --omit=dev` run here measures the repo's own `node_modules`, which
 * is not what anyone installing `@pcircle/memesh` gets. The difference is not
 * academic: npm applies `overrides` only at the install ROOT, so the overrides
 * in this package.json change what this repo tests and change nothing at all
 * for a consumer. Measured — repo tree resolves sharp 0.35.3 / adm-zip 0.6.0
 * and audits clean; a consumer installing the packed tarball resolves sharp
 * 0.34.5 / adm-zip 0.5.18 and gets 5 high-severity advisories.
 *
 * A gate that reports success against a tree nobody installs is the same
 * defect this release exists to correct — the published benchmark scored a
 * reimplementation instead of the shipped code. So this gate packs the
 * tarball, installs it the way a user does, and audits THERE.
 *
 * `--ignore-scripts` on the install: native modules do not need to build for
 * `npm audit` to resolve the tree, and skipping them keeps the gate fast and
 * usable on any CI runner.
 *
 * Exit 0 = no high-or-worse advisory reaches a consumer. Exit 1 = one does.
 */
const AUDIT_LEVEL = 'high';
const repoRoot = process.cwd();

let workDir;

/**
 * `process.exit()` does NOT run a pending `finally`. Every exit path below is a
 * `process.exit`, so the cleanup that lived there never executed once — each
 * run left a temp directory holding a full production `node_modules` behind,
 * on all six CI legs of every push and on every local `verify:release`.
 */
function cleanup() {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
}

/** Exit, having actually cleaned up. */
function exitWith(code) {
  cleanup();
  process.exit(code);
}

try {
  const packOut = npmSync(['pack', '--silent'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  // Split on CRLF too — npm's stdout on Windows ends lines with \r\n, and a
  // trailing \r would corrupt both the path join and the validation below.
  //
  // The one argument below that is not a literal from this file. On Windows the
  // install runs through a command interpreter, so it is validated rather than
  // trusted — npm derives the name from package name + version, but "derived
  // from a file we control" is not the same as "checked".
  const tarball = assertSafeShellArg(
    packOut.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop(),
    'the tarball name npm pack reported'
  );
  const tarballPath = path.join(repoRoot, tarball);

  if (!fs.existsSync(tarballPath)) {
    console.error(`✗ npm pack reported "${tarball}" but no such file exists — cannot audit what ships`);
    exitWith(1);
  }

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-consumer-audit-'));
  fs.copyFileSync(tarballPath, path.join(workDir, tarball));
  fs.unlinkSync(tarballPath);

  npmSync(['init', '-y'], { cwd: workDir, stdio: 'ignore' });
  npmSync(['install', '--omit=dev', '--ignore-scripts', `./${tarball}`], {
    cwd: workDir,
    stdio: 'ignore',
  });

  // Prove the install actually produced a tree. Auditing an empty directory
  // reports zero vulnerabilities, which would make this gate pass by doing
  // nothing — the exact failure mode it exists to prevent.
  const installedPkg = path.join(workDir, 'node_modules', '@pcircle', 'memesh', 'package.json');
  if (!fs.existsSync(installedPkg)) {
    console.error('✗ the packed tarball did not install — nothing was audited');
    exitWith(1);
  }

  let auditOut = '';
  let clean = true;
  try {
    auditOut = npmSync(['audit', '--omit=dev', `--audit-level=${AUDIT_LEVEL}`], {
      cwd: workDir,
      encoding: 'utf8',
    });
  } catch (err) {
    clean = false;
    auditOut = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  if (clean) {
    console.log(`✓ consumer install has no ${AUDIT_LEVEL}-or-worse advisories`);
    exitWith(0);
  }

  console.error(
    `✗ a consumer installing this package resolves ${AUDIT_LEVEL}-or-worse advisories.\n` +
      `  This is what users get, not what this repo's node_modules has — npm applies\n` +
      `  \`overrides\` only at the install root, so they do not reach consumers.\n`
  );
  console.error(auditOut);
  exitWith(1);
} finally {
  cleanup();
}
