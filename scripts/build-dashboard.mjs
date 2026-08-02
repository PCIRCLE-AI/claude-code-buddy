#!/usr/bin/env node
// Build the dashboard sub-package as part of the root `npm run build`.
//
// The dashboard is a separate npm workspace with its own deps (Preact + Vite).
// Root `npm install` does not recurse into sub-workspaces, so the first time a
// developer runs `npm run build` they typically don't have dashboard deps yet.
// This script:
//   1. Installs dashboard deps if missing (idempotent — uses `npm install`, not
//      `npm ci`, so it works on lockfile drift during dev too).
//   2. Builds the dashboard via vite, producing `dashboard/dist/index.html`.
//
// The `tests/installation.test.ts > Dashboard > should have dashboard build
// output` test asserts the produced file exists. Wiring this build into the
// root `build` script makes the contract complete: `npm install && npm run
// build` is sufficient to produce a publishable artifact.

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, '..', 'dashboard');

if (!existsSync(DASHBOARD_DIR)) {
  console.error(`[build:dashboard] no dashboard/ directory at ${DASHBOARD_DIR}; skipping.`);
  process.exit(0);
}

function run(label, cmd, args, opts = {}) {
  console.log(`[build:dashboard] ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: DASHBOARD_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`[build:dashboard] step "${label}" failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const nodeModules = join(DASHBOARD_DIR, 'node_modules');
if (!existsSync(nodeModules)) {
  // `npm ci` when there is a lockfile, `npm install` only when there is not.
  //
  // This unconditionally ran `npm install`, justified as tolerating lockfile
  // drift during development. But `dashboard/dist/index.html` is a COMMITTED,
  // SHIPPED artifact, and the one situation where node_modules is absent is a
  // clean CI checkout — exactly where the dependency set must be pinned. So the
  // convenience applied where it was never needed and the pinning was missing
  // where it always is.
  const hasLockfile = existsSync(join(DASHBOARD_DIR, 'package-lock.json'));
  run(
    hasLockfile ? 'install dashboard deps (locked)' : 'install dashboard deps',
    'npm',
    hasLockfile
      ? ['ci', '--silent', '--no-audit', '--no-fund']
      : ['install', '--silent', '--no-audit', '--no-fund']
  );
} else {
  console.log('[build:dashboard] dashboard/node_modules present; skipping install.');
}

run('build dashboard', 'npx', ['vite', 'build']);

const outFile = join(DASHBOARD_DIR, 'dist', 'index.html');
if (!existsSync(outFile)) {
  console.error(`[build:dashboard] expected output ${outFile} was not produced.`);
  process.exit(1);
}
console.log(`[build:dashboard] ok — ${outFile}`);
