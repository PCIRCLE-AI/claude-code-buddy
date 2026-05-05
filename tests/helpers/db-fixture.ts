// =============================================================================
// Shared test-DB fixture
// =============================================================================
//
// 28 test files repeated the same setup/teardown:
//   beforeEach(() => {
//     tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-foo-'));
//     openDatabase(path.join(tmpDir, 'test.db'));
//   });
//   afterEach(() => {
//     closeDatabase();
//     fs.rmSync(tmpDir, { recursive: true, force: true });
//   });
//
// This helper folds that into one call per file. The closure also
// exposes the current tmpDir for tests that need to write fixtures
// alongside the DB (e.g. import-from-file tests).

import { afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, closeDatabase } from '../../src/db.js';

export interface TestDbHandle {
  /** Returns the current per-test temp directory. Throws if called outside a test. */
  readonly tmpDir: string;
  /** Returns the path to the test DB file. */
  readonly dbPath: string;
}

/**
 * Register vitest beforeEach/afterEach hooks that create an isolated
 * memesh DB in a fresh tmpdir and clean up after each test.
 *
 * Usage:
 *   const db = useTestDatabase('memesh-knowledge-graph-');
 *   it('does a thing', () => {
 *     // openDatabase() already called; getDatabase() works
 *     // db.tmpDir, db.dbPath available if needed
 *   });
 *
 * @param prefix Subdir name prefix passed to mkdtempSync. Defaults to
 *   'memesh-test-'. Tests with specific naming requirements (e.g.
 *   `memesh-knowledge-graph-`) can override.
 */
export function useTestDatabase(prefix = 'memesh-test-'): TestDbHandle {
  let _tmpDir: string | null = null;

  beforeEach(() => {
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    openDatabase(path.join(_tmpDir, 'test.db'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    if (_tmpDir) {
      fs.rmSync(_tmpDir, { recursive: true, force: true });
      _tmpDir = null;
    }
  });

  return {
    get tmpDir(): string {
      if (!_tmpDir) throw new Error('useTestDatabase: accessed tmpDir outside an active test');
      return _tmpDir;
    },
    get dbPath(): string {
      if (!_tmpDir) throw new Error('useTestDatabase: accessed dbPath outside an active test');
      return path.join(_tmpDir, 'test.db');
    },
  };
}
