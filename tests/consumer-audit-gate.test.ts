/**
 * The gate that stops the dependency gate from passing by doing nothing.
 *
 * `scripts/check-consumer-audit.mjs` exists because `npm audit --omit=dev` run
 * in this repo measures a tree nobody installs: npm applies `overrides` only at
 * the install ROOT, so they change what this checkout resolves and change
 * nothing for a consumer. Measured — repo tree audits clean while a consumer
 * installing the packed tarball got 5 high-severity advisories.
 *
 * So the script packs, installs and audits THERE. Which introduces its own
 * failure mode: `npm audit` in a directory with no `node_modules` reports zero
 * vulnerabilities and exits 0. If the pack or install silently produced
 * nothing, the gate would report success having audited an empty directory —
 * the exact defect it was written to correct, one level down.
 *
 * The script guards against that by asserting the installed package is really
 * on disk before auditing. Nothing pinned the guard, so it was verified once by
 * hand and then trusted — which is how the original claim got made.
 *
 * This test stubs `npm` so that every step reports success while producing no
 * tree at all. The script must refuse to pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Feature: the consumer audit cannot pass on an empty tree', () => {
  let binDir: string;

  /**
   * A fake `npm` that succeeds at everything and installs nothing:
   *   pack    -> prints a tarball name AND creates the file (so the script's
   *              own existence check on the tarball passes)
   *   init    -> no-op
   *   install -> no-op, leaves no node_modules
   *   audit   -> "found 0 vulnerabilities", exit 0
   */
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-fake-npm-'));

    // Both spellings. The script resolves `npm.cmd` on Windows and `npm`
    // elsewhere (scripts/lib/npm-bin.mjs), so the stub has to exist under
    // whichever name it will actually ask for.
    const sh = path.join(binDir, 'npm');
    fs.writeFileSync(
      sh,
      [
        '#!/bin/sh',
        'case "$1" in',
        '  pack) : > "fake-package-0.0.0.tgz"; echo "fake-package-0.0.0.tgz"; exit 0;;',
        '  audit) echo "found 0 vulnerabilities"; exit 0;;',
        '  *) exit 0;;',
        'esac',
        '',
      ].join('\n')
    );
    fs.chmodSync(sh, 0o755);

    fs.writeFileSync(
      path.join(binDir, 'npm.cmd'),
      [
        '@echo off',
        'if "%~1"=="pack" (',
        '  type nul > fake-package-0.0.0.tgz',
        '  echo fake-package-0.0.0.tgz',
        '  exit /b 0',
        ')',
        'if "%~1"=="audit" (',
        '  echo found 0 vulnerabilities',
        '  exit /b 0',
        ')',
        'exit /b 0',
        '',
      ].join('\r\n')
    );
  });

  afterEach(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(path.join(repoRoot, 'fake-package-0.0.0.tgz'), { force: true });
  });

  it('exits non-zero when the install produced no package', () => {
    const res = spawnSync('node', ['scripts/check-consumer-audit.mjs'], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 120000,
    });

    // Zero here would mean the gate reported "no advisories reach a consumer"
    // after auditing an empty directory.
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/did not install|nothing was audited/i);
  });
});
