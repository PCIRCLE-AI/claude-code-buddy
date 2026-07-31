import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
try {
  const packOut = execFileSync('npm', ['pack', '--silent'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const tarball = packOut.split('\n').filter(Boolean).pop();
  const tarballPath = path.join(repoRoot, tarball);

  if (!fs.existsSync(tarballPath)) {
    console.error(`✗ npm pack reported "${tarball}" but no such file exists — cannot audit what ships`);
    process.exit(1);
  }

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-consumer-audit-'));
  fs.copyFileSync(tarballPath, path.join(workDir, tarball));
  fs.unlinkSync(tarballPath);

  execFileSync('npm', ['init', '-y'], { cwd: workDir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', `./${tarball}`], {
    cwd: workDir,
    stdio: 'ignore',
  });

  // Prove the install actually produced a tree. Auditing an empty directory
  // reports zero vulnerabilities, which would make this gate pass by doing
  // nothing — the exact failure mode it exists to prevent.
  const installedPkg = path.join(workDir, 'node_modules', '@pcircle', 'memesh', 'package.json');
  if (!fs.existsSync(installedPkg)) {
    console.error('✗ the packed tarball did not install — nothing was audited');
    process.exit(1);
  }

  let auditOut = '';
  let clean = true;
  try {
    auditOut = execFileSync('npm', ['audit', '--omit=dev', `--audit-level=${AUDIT_LEVEL}`], {
      cwd: workDir,
      encoding: 'utf8',
    });
  } catch (err) {
    clean = false;
    auditOut = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  if (clean) {
    console.log(`✓ consumer install has no ${AUDIT_LEVEL}-or-worse advisories`);
    process.exit(0);
  }

  console.error(
    `✗ a consumer installing this package resolves ${AUDIT_LEVEL}-or-worse advisories.\n` +
      `  This is what users get, not what this repo's node_modules has — npm applies\n` +
      `  \`overrides\` only at the install root, so they do not reach consumers.\n`
  );
  console.error(auditOut);
  process.exit(1);
} finally {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
}
