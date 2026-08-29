#!/usr/bin/env node
/**
 * Post-build smoke test — verifies critical functionality after build
 *
 * Runs after `npm run build` to catch build-time regressions before
 * they reach users. Tests:
 * - All dist/ modules load without errors
 * - Database can be opened and queried
 * - Core operations work (remember, recall, forget)
 * - HTTP server can start and respond
 *
 * Exit codes:
 * 0 = all tests passed
 * 1 = tests failed (blocks publish if run in CI)
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const distDir = join(projectRoot, 'dist');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    fn();
    console.log('✓');
    testsPassed++;
  } catch (err) {
    console.log('✗');
    console.error(`    Error: ${err.message}`);
    testsFailed++;
  }
}

console.log('\n🔍 MeMesh Build Smoke Test\n');

// Test 1: dist/ directory exists
test('dist/ directory exists', () => {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ directory not found. Run: npm run build');
  }
});

// Test 2: Critical files exist
test('Critical dist files exist', () => {
  const required = [
    'db.js',
    'knowledge-graph.js',
    'core/operations.js',
    'transports/http/server.js',
    'transports/cli/cli.js',
  ];
  for (const file of required) {
    const path = join(distDir, file);
    if (!fs.existsSync(path)) {
      throw new Error(`Missing: dist/${file}`);
    }
  }
});

// Test 3: Modules load without errors
test('Core modules load', () => {
  try {
    execFileSync('node', ['-e', "require('./dist/db.js')"], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('node', ['-e', "require('./dist/core/operations.js')"], { cwd: projectRoot, stdio: 'pipe' });
  } catch (err) {
    throw new Error('Module loading failed', { cause: err });
  }
});

// Test 4: Database operations work
test('Database operations', () => {
  const testDbPath = join(projectRoot, '.smoke-test.db');
  const scriptPath = join(projectRoot, '.smoke-test-script.mjs');

  try {
    // Clean up any existing test DB
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    // Write test script to temporary file
    const scriptContent = `
import { openDatabase, closeDatabase, getDatabase } from './dist/db.js';
import { remember, recall, forget } from './dist/core/operations.js';

process.env.MEMESH_DB_PATH = '${testDbPath.replace(/\\/g, '\\\\')}';

try {
  openDatabase();
  const db = getDatabase();

  // Test: can query empty database
  const count = db.prepare('SELECT COUNT(*) as c FROM entities').get();
  if (typeof count.c !== 'number') throw new Error('Query failed');

  // Test: can remember
  const rememberResult = remember({ name: 'test', type: 'note', observations: ['test observation'] });
  if (!rememberResult || !rememberResult.stored) throw new Error('Remember failed');

  // Test: can recall
  const results = recall({ query: 'test' });
  if (!results || results.length === 0) throw new Error('Recall failed');

  // Test: can forget
  forget({ name: 'test' });

  closeDatabase();
  console.log('OK');
} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
}
`;
    fs.writeFileSync(scriptPath, scriptContent);

    const output = execFileSync('node', [scriptPath], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    if (!output.includes('OK')) throw new Error('Database operations did not complete');
  } finally {
    // Clean up test DB and script
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
    if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
  }
});

// Test 5: HTTP server can start
test('HTTP server starts', () => {
  const script = `
    const { startServer } = require('./dist/transports/http/server.js');
    const server = startServer('127.0.0.1', 0);
    server.close();
    console.log('OK');
  `.replace(/\n/g, ' ');

  // `startServer` opens the database and runs every migration in it. Without
  // a path of its own this child opened the DEVELOPER'S real ~/.memesh graph —
  // so `npm run build` silently applied whatever data migration was in the
  // working tree to the maintainer's memories. Measured 2026-08-30: a one-shot
  // repair under development ran on the real graph from a build, not a test.
  const httpDbPath = join(projectRoot, '.smoke-test-http.db');
  const output = execFileSync('node', ['-e', script], {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, MEMESH_DB_PATH: httpDbPath },
  });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${httpDbPath}${suffix}`)) fs.unlinkSync(`${httpDbPath}${suffix}`);
  }

  if (!output.includes('OK')) throw new Error('Server did not start');
});

// Test 6: Dashboard artifact exists
test('Dashboard artifact exists', () => {
  const dashboardPath = join(projectRoot, 'dashboard/dist/index.html');
  if (!fs.existsSync(dashboardPath)) {
    throw new Error('dashboard/dist/index.html not found. Run: npm run build:dashboard');
  }
  const stat = fs.statSync(dashboardPath);
  if (stat.size < 100000) {
    throw new Error(`Dashboard artifact is suspiciously small (${stat.size} bytes)`);
  }
});

// Summary
console.log('\n' + '─'.repeat(50));
if (testsFailed === 0) {
  console.log(`✅ All ${testsPassed} smoke tests passed`);
  console.log('   Build is ready for use\n');
  process.exit(0);
} else {
  console.log(`❌ ${testsFailed}/${testsPassed + testsFailed} tests failed`);
  console.log('   Build has issues — do not publish\n');
  process.exit(1);
}
