#!/usr/bin/env node
// Runs after `npm install` to ensure better-sqlite3's native binding is compiled.
// The plugin marketplace sometimes runs `npm install --ignore-scripts`, which
// skips better-sqlite3's own build step. This script is a safety net that
// detects a missing binary and attempts a rebuild. Errors are non-fatal —
// the hook and MCP server will report the missing binding at runtime.
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { join } from 'path';

const require = createRequire(import.meta.url);

function isBinaryPresent() {
  try {
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

if (isBinaryPresent()) {
  process.exit(0);
}

const cwd = new URL('..', import.meta.url).pathname;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  process.stdout.write('[memesh] Compiling better-sqlite3 native addon...\n');
  execFileSync(npm, ['rebuild', 'better-sqlite3'], { cwd, stdio: 'inherit' });
  process.stdout.write('[memesh] better-sqlite3 compiled successfully.\n');
} catch (err) {
  // Non-fatal: user can still use the CLI without the native module if no DB ops.
  process.stderr.write(`[memesh] Warning: Could not compile better-sqlite3 (${err?.message}). Run "npm rebuild better-sqlite3" manually inside the install directory.\n`);
}
